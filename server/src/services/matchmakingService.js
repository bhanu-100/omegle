const redisService = require('./redisService');
const kafkaService = require('./kafkaService');
const logger = require('../utils/logger');
const metrics = require('../monitoring/metrics');

class MatchmakingService {
  constructor() {
    this.queues = {
      PRIORITY: 'match_queue:priority',
      NORMAL: 'match_queue:normal',
      RETRY: 'match_queue:retry',
      REGIONAL: 'match_queue:regional'
    };
    
    this.matchTimeout = 30000;
    this.maxRetries = 3;
    this.recentMatches = new Map();
    this.pendingMatches = new Map();
    this.matchPreferences = new Map();
    
    this.redisKeys = {
      activeMatches: 'active_matches',
      userSessions: 'user_sessions',
      matchHistory: 'match_history',
      userPreferences: 'user_preferences',
      connectionQuality: 'connection_quality',
      regionalQueues: 'regional_queues'
    };

    this.regions = ['NA', 'EU', 'AS', 'SA', 'OC', 'AF'];
    
    // Track cleanup timer to prevent multiple instances
    this.cleanupTimer = null;
    this.startCleanupTimer();
  }

  async findMatch(socket, io, preferences = {}) {
    const socketId = socket.id;
    const lockKey = `match_lock:${socketId}`;
    
    try {
      // Prevent duplicate match requests
      if (this.pendingMatches.has(socketId)) {
        socket.emit('error', {
          type: 'duplicate_request',
          message: 'Match request already in progress'
        });
        return;
      }

      this.pendingMatches.set(socketId, Date.now());

      // Acquire distributed lock to prevent race conditions
      const lockAcquired = await redisService.acquireLock(lockKey, 10000);
      if (!lockAcquired) {
        socket.emit('error', {
          type: 'system_busy',
          message: 'System is busy, please try again'
        });
        return;
      }

      logger.debug('Finding match for user', { socketId, preferences, worker: process.pid });

      // Store user preferences and connection info
      await this.storeUserPreferences(socketId, preferences, socket);

      // Remove user from all queues first (cleanup)
      await this.removeFromAllQueues(socketId);

      // Check if user was recently matched to prevent immediate re-matching
      if (await this.wasRecentlyMatched(socketId)) {
        await this.addToQueue(socketId, preferences);
        const queuePosition = await this.getQueuePosition(socketId, preferences.region);
        socket.emit('waiting', {
          message: 'Looking for a new match...',
          timestamp: Date.now(),
          queuePosition,
          estimatedWait: this.calculateEstimatedWait(queuePosition)
        });
        this.setMatchTimeout(socket, socketId);
        return;
      }

      // Try atomic match finding
      const matchResult = await this.findAvailablePeerAtomic(socketId, preferences);

      if (matchResult.success && matchResult.peerId) {
        // Create match atomically
        const roomId = this.generateRoomId();
        const matchCreated = await this.createMatchAtomic(socket, socketId, matchResult.peerId, roomId, io);
        
        if (matchCreated) {
          kafkaService.logMatchmakingEvent('match_found', socketId, matchResult.peerId, roomId, {
            waitTime: 0,
            matchQuality: matchResult.quality,
            region: preferences.region || 'any',
          });
        } else {
          // Match creation failed, add to queue
          await this.addToQueue(socketId, preferences);
          this.setMatchTimeout(socket, socketId);
        }
      } else {
        // Add to appropriate queue based on preferences
        await this.addToQueue(socketId, preferences);
        
        const queuePosition = await this.getQueuePosition(socketId, preferences.region);
        socket.emit('waiting', {
          message: 'Looking for a match...',
          timestamp: Date.now(),
          queuePosition,
          estimatedWait: this.calculateEstimatedWait(queuePosition)
        });

        // Set match timeout
        this.setMatchTimeout(socket, socketId);

        kafkaService.logMatchmakingEvent('added_to_queue', socketId, null, null, {
          queuePosition,
          preferences
        });
        
        logger.debug('User added to matchmaking queue', { 
          socketId, 
          queuePosition, 
          region: preferences.region || 'any',
          worker: process.pid 
        });
      }

    } catch (error) {
      logger.error('Matchmaking error', {
        error: error.message,
        stack: error.stack,
        socketId,
        worker: process.pid
      });
      
      socket.emit('error', {
        type: 'matchmaking_error',
        message: 'Failed to find match, please try again'
      });

      kafkaService.logErrorEvent('matchmaking', socketId, error);
    } finally {
      // Release lock and cleanup
      await redisService.releaseLock(lockKey);
      this.pendingMatches.delete(socketId);
    }
  }

  async findAvailablePeerAtomic(socketId, preferences) {
    const script = `
      local socketId = ARGV[1]
      local region = ARGV[2] or ""
      local minQuality = tonumber(ARGV[3]) or 0
      
      -- Try regional queue first if region specified
      if region ~= "" and region ~= "any" then
        local regionalQueue = "match_queue:regional:" .. region
        local peer = redis.call('LPOP', regionalQueue)
        if peer and peer ~= socketId then
          -- Check if the peer data is valid JSON
          local success, peerData = pcall(cjson.decode, peer)
          if success and peerData.socketId and peerData.socketId ~= socketId then
            return {peer, "regional"}
          end
        end
      end
      
      -- Try priority queue
      local priorityPeer = redis.call('LPOP', 'match_queue:priority')
      if priorityPeer and priorityPeer ~= socketId then
        local success, peerData = pcall(cjson.decode, priorityPeer)
        if success and peerData.socketId and peerData.socketId ~= socketId then
          return {priorityPeer, "priority"}
        end
      end
      
      -- Try normal queue
      local normalPeer = redis.call('LPOP', 'match_queue:normal')
      if normalPeer and normalPeer ~= socketId then
        local success, peerData = pcall(cjson.decode, normalPeer)
        if success and peerData.socketId and peerData.socketId ~= socketId then
          return {normalPeer, "normal"}
        end
      end
      
      return nil
    `;

    try {
      const result = await redisService.evalScript(script, 0, 
        socketId, 
        preferences.region || '', 
        preferences.minConnectionQuality || 0
      );

      if (result && Array.isArray(result) && result.length >= 2) {
        const [peerJson, queueType] = result;
        
        // Parse peer data safely
        let peerData;
        try {
          peerData = JSON.parse(peerJson);
        } catch (parseError) {
          logger.warn('Failed to parse peer data', { socketId, peerJson });
          return { success: false };
        }
        
        const peerId = peerData.socketId;
        if (!peerId || peerId === socketId) {
          return { success: false };
        }
        
        // Verify peer is still valid and get their preferences
        const peerSessionExists = await redisService.exists(`user_session:${peerId}`);
        if (!peerSessionExists) {
          logger.warn('Peer session not found, trying again', { socketId, peerId });
          return { success: false };
        }

        // Check compatibility
        const compatibility = await this.checkCompatibility(socketId, peerId);
        if (!compatibility.compatible) {
          // Re-queue the peer and try again
          await this.addToQueue(peerId, peerData);
          return { success: false };
        }

        return { 
          success: true, 
          peerId, 
          queueType,
          quality: compatibility.score 
        };
      }

      return { success: false };

    } catch (error) {
      logger.error('Error in atomic peer finding', {
        error: error.message,
        socketId,
        worker: process.pid
      });
      return { success: false };
    }
  }

  async checkCompatibility(socketId1, socketId2) {
    try {
      // Validate input
      if (!socketId1 || !socketId2 || socketId1 === socketId2) {
        return { compatible: false, reason: 'invalid_users' };
      }

      // Get user preferences and connection quality with better error handling
      const [prefs1, prefs2, quality1, quality2] = await Promise.allSettled([
        redisService.getHash(`user_preferences:${socketId1}`),
        redisService.getHash(`user_preferences:${socketId2}`),
        redisService.getHash(`connection_quality:${socketId1}`),
        redisService.getHash(`connection_quality:${socketId2}`)
      ]);

      // Handle failed promises gracefully
      const userPrefs1 = prefs1.status === 'fulfilled' ? (prefs1.value || {}) : {};
      const userPrefs2 = prefs2.status === 'fulfilled' ? (prefs2.value || {}) : {};
      const userQuality1 = quality1.status === 'fulfilled' ? (quality1.value || {}) : {};
      const userQuality2 = quality2.status === 'fulfilled' ? (quality2.value || {}) : {};

      let score = 100; // Start with perfect score

      // Check recent match history to prevent immediate re-matching
      try {
        const recentMatches1 = await redisService.getSet(`recent_matches:${socketId1}`);
        if (recentMatches1 && recentMatches1.includes(socketId2)) {
          return { compatible: false, reason: 'recent_match' };
        }
      } catch (error) {
        logger.warn('Failed to check recent matches', { error: error.message });
      }

      // Regional matching bonus
      if (userPrefs1.region && userPrefs2.region && userPrefs1.region === userPrefs2.region) {
        score += 20;
      }

      // Connection quality matching
      const quality1Score = parseInt(userQuality1.overall) || 50;
      const quality2Score = parseInt(userQuality2.overall) || 50;
      const qualityDiff = Math.abs(quality1Score - quality2Score);
      score -= qualityDiff * 0.5;

      // Language preference matching
      if (userPrefs1.language && userPrefs2.language) {
        if (userPrefs1.language === userPrefs2.language) {
          score += 10;
        } else if (userPrefs1.acceptedLanguages && 
                   Array.isArray(userPrefs1.acceptedLanguages) && 
                   userPrefs1.acceptedLanguages.includes(userPrefs2.language)) {
          score += 5;
        }
      }

      // Minimum quality threshold
      const minScore = 60;
      const compatible = score >= minScore;

      return { 
        compatible, 
        score: Math.max(0, Math.min(100, Math.round(score))),
        reason: compatible ? 'good_match' : 'poor_compatibility'
      };

    } catch (error) {
      logger.error('Error checking compatibility', {
        error: error.message,
        socketId1,
        socketId2,
        worker: process.pid
      });
      // Default to compatible on error to maintain service
      return { compatible: true, score: 50, reason: 'error_default' };
    }
  }

  async addToQueue(socketId, preferences = {}) {
    const queueData = {
      socketId,
      timestamp: Date.now(),
      region: preferences.region || 'any',
      connectionQuality: preferences.connectionQuality || 50,
      retryCount: preferences.retryCount || 0
    };

    let queueName = this.queues.NORMAL;

    // Priority queue for users with good connection or premium features
    if (preferences.connectionQuality > 80 || preferences.priority) {
      queueName = this.queues.PRIORITY;
    }
    // Regional queue if region specified
    else if (preferences.region && 
             preferences.region !== 'any' && 
             this.regions.includes(preferences.region)) {
      queueName = `${this.queues.REGIONAL}:${preferences.region}`;
    }
    // Retry queue for users who had failed matches
    else if (preferences.retryCount > 0) {
      queueName = this.queues.RETRY;
    }

    try {
      await redisService.addToQueue(queueName, JSON.stringify(queueData));
      
      // Store queue position for user
      await redisService.set(`queue_position:${socketId}`, queueName, 300);
      
      logger.debug('User added to queue', { socketId, queueName, worker: process.pid });
    } catch (error) {
      logger.error('Failed to add user to queue', {
        error: error.message,
        socketId,
        queueName
      });
      throw error;
    }
  }

  async removeFromAllQueues(socketId) {
    const allQueues = [
      ...Object.values(this.queues),
      ...this.regions.map(region => `${this.queues.REGIONAL}:${region}`)
    ];

    // Use Lua script for atomic removal from all queues
    const script = `
      local socketId = ARGV[1]
      local removed = 0
      
      for i = 2, #ARGV do
        local queueName = ARGV[i]
        local queueItems = redis.call('LRANGE', queueName, 0, -1)
        
        for j, item in ipairs(queueItems) do
          local success, data = pcall(cjson.decode, item)
          if success and data.socketId == socketId then
            redis.call('LREM', queueName, 1, item)
            removed = removed + 1
          end
        end
      end
      
      return removed
    `;

    try {
      const removed = await redisService.evalScript(script, 0, socketId, ...allQueues);
      logger.debug('Removed user from queues', { socketId, removed, worker: process.pid });
    } catch (error) {
      // Fallback to individual removals if script fails
      logger.warn('Queue removal script failed, using fallback', {
        error: error.message,
        socketId
      });
      
      const removeOps = allQueues.map(queueName => 
        redisService.removeFromQueue(queueName, socketId).catch(err => {
          logger.warn('Failed to remove from queue', { queueName, socketId, error: err.message });
        })
      );
      await Promise.allSettled(removeOps);
    }
  }

  async getQueuePosition(socketId, region = null) {
    try {
      const queueName = await redisService.get(`queue_position:${socketId}`);
      if (!queueName) return 1;

      const queueItems = await redisService.getQueueItems(queueName);
      
      for (let i = 0; i < queueItems.length; i++) {
        try {
          const data = JSON.parse(queueItems[i]);
          if (data.socketId === socketId) {
            return i + 1;
          }
        } catch (e) {
          // Skip malformed entries
          continue;
        }
      }

      return 1;
    } catch (error) {
      logger.error('Error getting queue position', {
        error: error.message,
        socketId,
        worker: process.pid
      });
      return 1;
    }
  }

  async createMatchAtomic(socket, socketId, peerId, roomId, io) {
    // Validate inputs
    if (!socket || !socketId || !peerId || !roomId || !io) {
      logger.error('Invalid parameters for match creation', { socketId, peerId, roomId });
      return false;
    }

    if (socketId === peerId) {
      logger.error('Cannot match user with themselves', { socketId });
      return false;
    }

    const matchLock = `match_creation:${[socketId, peerId].sort().join(':')}`;
    
    try {
      // Acquire lock for match creation
      const lockAcquired = await redisService.acquireLock(matchLock, 15000);
      if (!lockAcquired) {
        logger.warn('Could not acquire match creation lock', {
          socketId, peerId, worker: process.pid
        });
        return false;
      }

      // Verify both users are still available
      const [userSession, peerSession] = await Promise.all([
        redisService.exists(`user_session:${socketId}`),
        redisService.exists(`user_session:${peerId}`)
      ]);

      if (!userSession || !peerSession) {
        logger.warn('User session not found during match creation', {
          socketId, peerId, userSession, peerSession, worker: process.pid
        });
        
        // Re-queue available users
        if (userSession) await this.addToQueue(socketId);
        if (peerSession) await this.addToQueue(peerId);
        
        return false;
      }

      // Calculate match quality
      const matchQuality = await this.calculateMatchQuality(socketId, peerId);

      // Create match in Redis atomically
      const matchData = {
        roomId,
        users: [socketId, peerId],
        createdAt: Date.now(),
        status: 'active',
        matchQuality
      };

      const success = await redisService.createMatchAtomic(socketId, peerId, matchData);
      if (!success) {
        logger.warn('Failed to create atomic match in Redis', {
          socketId, peerId, worker: process.pid
        });
        return false;
      }

      // Handle socket room joining and notifications
      try {
        // Join both sockets to the room
        await socket.join(roomId);
        
        // Find and join peer socket
        const peerSocket = await this.joinPeerToRoom(io, peerId, roomId);

        // Prepare match data for notification
        const baseMatchData = {
          roomId,
          timestamp: Date.now(),
          matchType: 'webrtc_chat',
          matchQuality
        };

        // Notify both users
        socket.emit('match_found', { ...baseMatchData, peerId });
        
        if (peerSocket) {
          peerSocket.emit('match_found', { ...baseMatchData, peerId: socketId });
        } else {
          // Handle cross-server notification via Redis pub/sub
          await this.notifyPeerCrossServer(peerId, { ...baseMatchData, peerId: socketId });
        }

        // Update recent matches to prevent immediate re-matching
        await Promise.allSettled([
          redisService.addToSet(`recent_matches:${socketId}`, peerId, 300),
          redisService.addToSet(`recent_matches:${peerId}`, socketId, 300)
        ]);

        // Update user stats
        await Promise.allSettled([
          redisService.updateUserStats(socketId, {
            totalMatches: 1,
            lastMatch: Date.now(),
            lastPeer: peerId
          }),
          redisService.updateUserStats(peerId, {
            totalMatches: 1,
            lastMatch: Date.now(),
            lastPeer: socketId
          })
        ]);

        logger.info('Match created successfully', {
          socketId, peerId, roomId, matchQuality, worker: process.pid
        });

        return true;

      } catch (notificationError) {
        logger.error('Error in match notification', {
          error: notificationError.message,
          socketId, peerId, roomId
        });
        
        // Clean up the match if notification failed
        await Promise.allSettled([
          redisService.deleteMatch(socketId),
          redisService.deleteMatch(peerId)
        ]);
        return false;
      }

    } catch (error) {
      logger.error('Error in atomic match creation', {
        error: error.message,
        stack: error.stack,
        socketId, peerId, roomId,
        worker: process.pid
      });
      return false;
    } finally {
      await redisService.releaseLock(matchLock);
    }
  }

  // Find peer socket and join to room with retries
  async joinPeerToRoom(io, peerId, roomId, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        const peerSocket = await this.findSocketById(io, peerId);
        if (peerSocket) {
          await peerSocket.join(roomId);
          return peerSocket;
        }
        
        // Small delay before retry
        if (i < retries - 1) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      } catch (error) {
        logger.warn('Error joining peer to room', { 
          error: error.message, 
          peerId, 
          roomId, 
          attempt: i + 1 
        });
      }
    }
    
    logger.warn('Peer socket not found after retries', { peerId, roomId });
    return null;
  }

  // Optimized socket finding
  async findSocketById(io, socketId) {
    try {
      if (!io || !io.sockets || !io.sockets.sockets) {
        logger.warn('Invalid io object', { socketId });
        return null;
      }

      const socket = io.sockets.sockets.get(socketId);
      return socket && socket.connected ? socket : null;
    } catch (error) {
      logger.warn('Error finding socket by ID', { error: error.message, socketId });
      return null;
    }
  }

  // Cross-server peer notification
  async notifyPeerCrossServer(peerId, matchData) {
    try {
      const { pubClient } = redisService.getClients();
      if (!pubClient) {
        logger.error('Redis pub client not available');
        return;
      }

      const channel = `match_notification:${peerId}`;
      await pubClient.publish(channel, JSON.stringify(matchData));
    } catch (error) {
      logger.error('Failed to send cross-server match notification', {
        error: error.message,
        peerId
      });
    }
  }

  async calculateMatchQuality(socketId1, socketId2) {
    try {
      const compatibility = await this.checkCompatibility(socketId1, socketId2);
      return compatibility.score;
    } catch (error) {
      logger.error('Error calculating match quality', {
        error: error.message,
        socketId1, socketId2
      });
      return 50; // Default medium quality
    }
  }

  async storeUserPreferences(socketId, preferences, socket) {
    try {
      const userPrefs = {
        ...preferences,
        userAgent: socket?.handshake?.headers?.['user-agent'] || 'unknown',
        ip: socket?.handshake?.address || 'unknown',
        connectedAt: Date.now()
      };

      // Detect region from IP if not provided
      if (!userPrefs.region) {
        userPrefs.region = await this.detectRegion(userPrefs.ip);
      }

      await redisService.setHash(`user_preferences:${socketId}`, userPrefs, 3600);
      this.matchPreferences.set(socketId, userPrefs);
    } catch (error) {
      logger.error('Error storing user preferences', {
        error: error.message,
        socketId
      });
      // Don't throw, continue with default preferences
    }
  }

  async detectRegion(ip) {
    try {
      // Simple region detection - in production, use GeoIP service
      // This is a placeholder implementation
      if (!ip || ip === 'unknown') return 'NA';
      
      // Add basic IP-based region detection logic here
      // For now, default to North America
      return 'NA';
    } catch (error) {
      logger.warn('Error detecting region', { error: error.message, ip });
      return 'NA';
    }
  }

  async wasRecentlyMatched(socketId) {
    try {
      const recentMatches = await redisService.getSet(`recent_matches:${socketId}`);
      return Array.isArray(recentMatches) && recentMatches.length > 0;
    } catch (error) {
      logger.warn('Error checking recent matches', { error: error.message, socketId });
      return false;
    }
  }

  calculateEstimatedWait(queuePosition) {
    // Estimate based on average match time and position
    const avgMatchTime = 15; // seconds
    const baseWait = 5; // minimum wait time
    return Math.max(baseWait, Math.round(queuePosition * avgMatchTime));
  }

  setMatchTimeout(socket, socketId) {
    const timeoutId = setTimeout(async () => {
      try {
        // Check if user is still waiting
        const match = await redisService.getMatch(socketId);
        if (!match) {
          socket.emit('match_timeout', {
            message: 'No match found, please try again',
            timestamp: Date.now(),
            canRetry: true
          });

          await this.removeFromAllQueues(socketId);
          
          kafkaService.logMatchmakingEvent('match_timeout', socketId);
          logger.debug('Match timeout for user', { socketId, worker: process.pid });
        }
      } catch (error) {
        logger.error('Error in match timeout handler', {
          error: error.message,
          socketId,
          worker: process.pid
        });
      }
    }, this.matchTimeout);

    // Store timeout ID for potential cleanup
    this.pendingMatches.set(`${socketId}_timeout`, timeoutId);
    
    return timeoutId;
  }

  async cancelMatch(socketId) {
    const cancelLock = `cancel_match:${socketId}`;
    
    try {
      const lockAcquired = await redisService.acquireLock(cancelLock, 5000);
      if (!lockAcquired) {
        logger.warn('Could not acquire cancel lock', { socketId });
        return;
      }

      // Clear any pending timeouts
      const timeoutId = this.pendingMatches.get(`${socketId}_timeout`);
      if (timeoutId) {
        clearTimeout(timeoutId);
        this.pendingMatches.delete(`${socketId}_timeout`);
      }

      await this.removeFromAllQueues(socketId);
      
      // Remove from recent matches to allow immediate re-matching
      await redisService.deleteKey(`recent_matches:${socketId}`);

      kafkaService.logMatchmakingEvent('match_cancelled', socketId);
      logger.debug('Match cancelled for user', { socketId, worker: process.pid });

    } catch (error) {
      logger.error('Error cancelling match', {
        error: error.message,
        socketId,
        worker: process.pid
      });
      throw error;
    } finally {
      await redisService.releaseLock(cancelLock);
    }
  }

  async handleDisconnect(socketId, io) {
    try {
      // Clear any pending timeouts
      const timeoutId = this.pendingMatches.get(`${socketId}_timeout`);
      if (timeoutId) {
        clearTimeout(timeoutId);
        this.pendingMatches.delete(`${socketId}_timeout`);
      }

      // Remove from all queues
      await this.removeFromAllQueues(socketId);

      // Handle active match
      const matchData = await redisService.getMatch(socketId);
      if (matchData && matchData.users) {
        const peerId = matchData.users.find(u => u !== socketId);
        
        if (peerId) {
          // Notify peer of disconnection across all servers
          io.emit('peer_disconnected_global', {
            targetUser: peerId,
            disconnectedUser: socketId,
            reason: 'disconnect',
            timestamp: Date.now(),
            roomId: matchData.roomId
          });

          // Clean up match data
          await Promise.allSettled([
            redisService.deleteMatch(socketId),
            redisService.deleteMatch(peerId)
          ]);

          // Update metrics
          const matchDuration = Date.now() - matchData.createdAt;
          
          kafkaService.logMatchmakingEvent('match_ended', socketId, peerId, matchData.roomId, {
            duration: matchDuration,
            reason: 'disconnect'
          });
        }
      }

      // Cleanup user data
      await Promise.allSettled([
        redisService.deleteKey(`user_preferences:${socketId}`),
        redisService.deleteKey(`connection_quality:${socketId}`),
        redisService.deleteKey(`recent_matches:${socketId}`),
        redisService.deleteKey(`queue_position:${socketId}`)
      ]);

      this.matchPreferences.delete(socketId);
      this.pendingMatches.delete(socketId);
      
      kafkaService.logMatchmakingEvent('user_left', socketId);

    } catch (error) {
      logger.error('Error handling matchmaking disconnect', {
        error: error.message,
        stack: error.stack,
        socketId,
        worker: process.pid
      });
    }
  }

  generateRoomId() {
    return `room-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }

  // Enhanced statistics and monitoring
  async getQueueStats() {
    const stats = { queues: {}, totals: {} };
    
    const allQueues = [
      ...Object.entries(this.queues),
      ...this.regions.map(region => [`REGIONAL_${region}`, `${this.queues.REGIONAL}:${region}`])
    ];

    for (const [name, queueKey] of allQueues) {
      try {
        stats.queues[name.toLowerCase()] = await redisService.getQueueLength(queueKey);
      } catch (error) {
        logger.warn('Error getting queue length', { error: error.message, queue: queueKey });
        stats.queues[name.toLowerCase()] = 0;
      }
    }

    stats.totals.queuedUsers = Object.values(stats.queues).reduce((sum, count) => sum + count, 0);
    
    try {
      stats.totals.activeMatches = await redisService.getSetSize(this.redisKeys.activeMatches);
    } catch (error) {
      stats.totals.activeMatches = 0;
    }
    
    stats.totals.pendingMatches = this.pendingMatches.size;
    
    return stats;
  }

  async getActiveMatch(socketId) {
    try {
      return await redisService.getMatch(socketId);
    } catch (error) {
      logger.error('Error getting active match', {
        error: error.message,
        socketId
      });
      return null;
    }
  }

  // Enhanced cleanup of stale data
  startCleanupTimer() {
    // Prevent multiple cleanup timers
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    this.cleanupTimer = setInterval(async () => {
      try {
        await Promise.allSettled([
          this.cleanupStaleMatches(),
          this.cleanupStaleQueues(),
          this.cleanupStaleUserData(),
          this.cleanupPendingMatches()
        ]);
      } catch (error) {
        logger.error('Error in cleanup timer', {
          error: error.message,
          worker: process.pid
        });
      }
    }, 60000); // Every minute
  }

  async cleanupStaleMatches() {
    try {
      const staleThreshold = 10 * 60 * 1000; // 10 minutes
      const activeMatches = await redisService.getAllMatches();

      if (!activeMatches || typeof activeMatches !== 'object') {
        return;
      }

      for (const [socketId, matchData] of Object.entries(activeMatches)) {
        if (!matchData || !matchData.createdAt) {
          // Clean up invalid match data
          await redisService.deleteMatch(socketId);
          continue;
        }

        if (Date.now() - matchData.createdAt > staleThreshold) {
          logger.debug('Cleaning up stale match', { socketId, worker: process.pid });
          
          await redisService.deleteMatch(socketId);
          
          if (matchData.users && Array.isArray(matchData.users)) {
            for (const user of matchData.users) {
              if (user !== socketId) {
                await redisService.deleteMatch(user);
              }
            }
          }
          
          kafkaService.logMatchmakingEvent('match_cleanup', socketId, null, matchData.roomId, {
            reason: 'stale',
            age: Date.now() - matchData.createdAt
          });
        }
      }
    } catch (error) {
      logger.error('Error in stale match cleanup', {
        error: error.message,
        worker: process.pid
      });
    }
  }

  async cleanupStaleQueues() {
    try {
      const staleThreshold = 5 * 60 * 1000; // 5 minutes
      const allQueues = [
        ...Object.values(this.queues),
        ...this.regions.map(region => `${this.queues.REGIONAL}:${region}`)
      ];

      for (const queueName of allQueues) {
        try {
          const items = await redisService.getQueueItems(queueName);
          
          for (const item of items) {
            try {
              const data = JSON.parse(item);
              if (!data.timestamp || Date.now() - data.timestamp > staleThreshold) {
                await redisService.removeFromQueue(queueName, item);
                logger.debug('Removed stale queue item', {
                  socketId: data.socketId,
                  queue: queueName,
                  age: data.timestamp ? Date.now() - data.timestamp : 'unknown'
                });
              }
            } catch (parseError) {
              // Remove malformed items
              await redisService.removeFromQueue(queueName, item);
              logger.debug('Removed malformed queue item', { queue: queueName });
            }
          }
        } catch (queueError) {
          logger.warn('Error cleaning queue', {
            error: queueError.message,
            queue: queueName
          });
        }
      }
    } catch (error) {
      logger.error('Error in stale queue cleanup', {
        error: error.message,
        worker: process.pid
      });
    }
  }

  async cleanupStaleUserData() {
    try {
      const staleThreshold = 30 * 60 * 1000; // 30 minutes
      const socketIds = await redisService.getKeysPattern('user_session:*');

      if (!Array.isArray(socketIds)) {
        return;
      }

      for (const key of socketIds) {
        try {
          const sessionData = await redisService.getHash(key);
          if (!sessionData) {
            await redisService.deleteKey(key);
            continue;
          }

          const connectedAt = parseInt(sessionData.connectedAt);
          if (!connectedAt || Date.now() - connectedAt > staleThreshold) {
            const socketId = key.replace('user_session:', '');
            
            await Promise.allSettled([
              redisService.deleteKey(key),
              redisService.deleteKey(`user_preferences:${socketId}`),
              redisService.deleteKey(`connection_quality:${socketId}`),
              redisService.deleteKey(`recent_matches:${socketId}`),
              redisService.deleteKey(`queue_position:${socketId}`)
            ]);

            // Clean up local data
            this.matchPreferences.delete(socketId);
            this.pendingMatches.delete(socketId);

            logger.debug('Cleaned up stale user data', { socketId, worker: process.pid });
          }
        } catch (userError) {
          logger.warn('Error cleaning user data', {
            error: userError.message,
            key
          });
        }
      }
    } catch (error) {
      logger.error('Error in stale user data cleanup', {
        error: error.message,
        worker: process.pid
      });
    }
  }

  async cleanupPendingMatches() {
    try {
      const staleThreshold = 2 * 60 * 1000; // 2 minutes
      const currentTime = Date.now();

      for (const [socketId, timestamp] of this.pendingMatches.entries()) {
        // Skip timeout entries
        if (socketId.endsWith('_timeout')) continue;

        if (currentTime - timestamp > staleThreshold) {
          this.pendingMatches.delete(socketId);
          
          // Also clean up any associated timeout
          const timeoutId = this.pendingMatches.get(`${socketId}_timeout`);
          if (timeoutId) {
            clearTimeout(timeoutId);
            this.pendingMatches.delete(`${socketId}_timeout`);
          }

          logger.debug('Cleaned up stale pending match', { socketId, worker: process.pid });
        }
      }
    } catch (error) {
      logger.error('Error in pending matches cleanup', {
        error: error.message,
        worker: process.pid
      });
    }
  }

  // Health check method
  async getHealthStatus() {
    try {
      const stats = await this.getQueueStats();
      const redisHealth = await redisService.ping();
      
      return {
        healthy: redisHealth,
        queues: stats.queues,
        activeMatches: stats.totals.activeMatches,
        pendingOperations: this.pendingMatches.size,
        timestamp: Date.now(),
        worker: process.pid,
        uptime: process.uptime()
      };
    } catch (error) {
      logger.error('Error getting health status', {
        error: error.message,
        worker: process.pid
      });
      return {
        healthy: false,
        error: error.message,
        timestamp: Date.now(),
        worker: process.pid
      };
    }
  }

  // Graceful shutdown method
  async shutdown() {
    try {
      logger.info('Shutting down MatchmakingService', { worker: process.pid });

      // Clear cleanup timer
      if (this.cleanupTimer) {
        clearInterval(this.cleanupTimer);
        this.cleanupTimer = null;
      }

      // Clear all pending timeouts
      for (const [key, value] of this.pendingMatches.entries()) {
        if (key.endsWith('_timeout') && typeof value === 'number') {
          clearTimeout(value);
        }
      }

      // Clear local data
      this.pendingMatches.clear();
      this.matchPreferences.clear();
      this.recentMatches.clear();

      logger.info('MatchmakingService shutdown complete', { worker: process.pid });
    } catch (error) {
      logger.error('Error during shutdown', {
        error: error.message,
        worker: process.pid
      });
    }
  }

  // Method to get detailed queue information
  async getDetailedQueueInfo() {
    try {
      const queueInfo = {};
      const allQueues = [
        ...Object.entries(this.queues),
        ...this.regions.map(region => [`REGIONAL_${region}`, `${this.queues.REGIONAL}:${region}`])
      ];

      for (const [name, queueKey] of allQueues) {
        const items = await redisService.getQueueItems(queueKey);
        const validItems = [];

        for (const item of items) {
          try {
            const data = JSON.parse(item);
            validItems.push({
              socketId: data.socketId,
              timestamp: data.timestamp,
              waitTime: Date.now() - data.timestamp,
              region: data.region,
              connectionQuality: data.connectionQuality
            });
          } catch (parseError) {
            // Skip invalid items
          }
        }

        queueInfo[name.toLowerCase()] = {
          length: validItems.length,
          items: validItems,
          averageWaitTime: validItems.length > 0 
            ? Math.round(validItems.reduce((sum, item) => sum + item.waitTime, 0) / validItems.length)
            : 0
        };
      }

      return queueInfo;
    } catch (error) {
      logger.error('Error getting detailed queue info', {
        error: error.message,
        worker: process.pid
      });
      return {};
    }
  }

  // Method to force match two specific users (admin feature)
  async forceMatch(socketId1, socketId2, io) {
    if (!socketId1 || !socketId2 || socketId1 === socketId2) {
      throw new Error('Invalid socket IDs for force match');
    }

    try {
      // Remove both users from all queues
      await Promise.all([
        this.removeFromAllQueues(socketId1),
        this.removeFromAllQueues(socketId2)
      ]);

      // Find both sockets
      const socket1 = await this.findSocketById(io, socketId1);
      const socket2 = await this.findSocketById(io, socketId2);

      if (!socket1 || !socket2) {
        throw new Error('One or both sockets not found');
      }

      // Create forced match
      const roomId = this.generateRoomId();
      const matchCreated = await this.createMatchAtomic(socket1, socketId1, socketId2, roomId, io);

      if (matchCreated) {
        logger.info('Force match created successfully', {
          socketId1, socketId2, roomId, worker: process.pid
        });
        
        kafkaService.logMatchmakingEvent('force_match', socketId1, socketId2, roomId, {
          matchQuality: 100,
          type: 'admin_forced'
        });

        return { success: true, roomId };
      } else {
        throw new Error('Failed to create forced match');
      }
    } catch (error) {
      logger.error('Error in force match', {
        error: error.message,
        socketId1, socketId2,
        worker: process.pid
      });
      throw error;
    }
  }
}

module.exports = new MatchmakingService();