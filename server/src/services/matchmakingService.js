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
      REGIONAL: 'match_queue:regional' // New regional queue
    };
    
    this.matchTimeout = 30000; // 30 seconds
    this.maxRetries = 3;
    this.recentMatches = new Map(); // Track recent matches to prevent immediate re-matching
    this.pendingMatches = new Map(); // Track pending match operations
    this.matchPreferences = new Map(); // User preferences cache
    
    // Redis keys for distributed state
    this.redisKeys = {
      activeMatches: 'active_matches',
      userSessions: 'user_sessions',
      matchHistory: 'match_history',
      userPreferences: 'user_preferences',
      connectionQuality: 'connection_quality',
      regionalQueues: 'regional_queues'
    };

    // Start cleanup timer
    this.startCleanupTimer();
    
    // Geographic regions for better matching
    this.regions = ['NA', 'EU', 'AS', 'SA', 'OC', 'AF'];
  }

  async findMatch(socket, io, preferences = {}) {
    // const matchTimer = metrics.matchmakingDuration.startTimer();
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
        socket.emit('waiting', {
          message: 'Looking for a new match...',
          timestamp: Date.now(),
          queuePosition: await this.getQueuePosition(socketId, preferences.region)
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
            region: preferences.region||'any',
          });
        } else {
          // Match creation failed, add to queue
          await this.addToQueue(socketId, preferences);
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
          region: preferences.region||'any',
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
      
      // metrics.errorRate.inc({ type: 'matchmaking', worker: process.pid });
      socket.emit('error', {
        type: 'matchmaking_error',
        message: 'Failed to find match, please try again'
      });

      kafkaService.logErrorEvent('matchmaking', socketId, error);
    } finally {
      // Release lock and cleanup
      await redisService.releaseLock(lockKey);
      this.pendingMatches.delete(socketId);
      matchTimer();
    }
  }

  async findAvailablePeerAtomic(socketId, preferences) {
    const script = `
      local socketId = ARGV[1]
      local region = ARGV[2]
      local minQuality = tonumber(ARGV[3]) or 0
      
      -- Try regional queue first if region specified
      if region and region ~= "" then
        local regionalQueue = "match_queue:regional:" .. region
        local peer = redis.call('LPOP', regionalQueue)
        if peer and peer ~= socketId then
          return {peer, "regional"}
        end
      end
      
      -- Try priority queue
      local priorityPeer = redis.call('LPOP', 'match_queue:priority')
      if priorityPeer and priorityPeer ~= socketId then
        return {priorityPeer, "priority"}
      end
      
      -- Try normal queue
      local normalPeer = redis.call('LPOP', 'match_queue:normal')
      if normalPeer and normalPeer ~= socketId then
        return {normalPeer, "normal"}
      end
      
      return nil
    `;

    try {
      const result = await redisService.evalScript(script, 0, 
        socketId, 
        preferences.region || 'any', 
        preferences.minConnectionQuality || 0
      );

      if (result && result.length >= 2) {
        const [peerId, queueType] = result;
        
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
          await this.addToQueue(peerId);
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
      // Get user preferences and connection quality
      const [prefs1, prefs2, quality1, quality2] = await Promise.all([
        redisService.getHash(`user_preferences:${socketId1}`),
        redisService.getHash(`user_preferences:${socketId2}`),
        redisService.getHash(`connection_quality:${socketId1}`),
        redisService.getHash(`connection_quality:${socketId2}`)
      ]);

      let score = 100; // Start with perfect score

      // Check recent match history to prevent immediate re-matching
      const recentMatches1 = await redisService.getSet(`recent_matches:${socketId1}`);
      if (recentMatches1.includes(socketId2)) {
        return { compatible: false, reason: 'recent_match' };
      }

      // Regional matching bonus
      if (prefs1.region && prefs2.region && prefs1.region === prefs2.region) {
        score += 20;
      }

      // Connection quality matching
      const quality1Score = parseInt(quality1.overall) || 50;
      const quality2Score = parseInt(quality2.overall) || 50;
      const qualityDiff = Math.abs(quality1Score - quality2Score);
      score -= qualityDiff * 0.5; // Penalize large quality differences

      // Language preference matching
      if (prefs1.language && prefs2.language) {
        if (prefs1.language === prefs2.language) {
          score += 10;
        } else if (prefs1.acceptedLanguages && prefs1.acceptedLanguages.includes(prefs2.language)) {
          score += 5;
        }
      }

      // Minimum quality threshold
      const minScore = 60;
      const compatible = score >= minScore;

      return { 
        compatible, 
        score: Math.max(0, Math.min(100, score)),
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
      region: preferences.region||'any',
      connectionQuality: preferences.connectionQuality || 50,
      retryCount: preferences.retryCount || 0
    };

    let queueName = this.queues.NORMAL;

    // Priority queue for users with good connection or premium features
    if (preferences.connectionQuality > 80 || preferences.priority) {
      queueName = this.queues.PRIORITY;
    }
    // Regional queue if region specified
    else if (preferences.region && this.regions.includes(preferences.region)) {
      queueName = `${this.queues.REGIONAL}:${preferences.region}`;
    }
    // Retry queue for users who had failed matches
    else if (preferences.retryCount > 0) {
      queueName = this.queues.RETRY;
    }

    await redisService.addToQueue(queueName, JSON.stringify(queueData));
    
    // Update queue metrics
    // metrics.queueSize.set(
    //   { queue: queueName.split(':').pop(), worker: process.pid },
    //   await redisService.getQueueLength(queueName)
    // );

    // Store queue position for user
    await redisService.setWithExpiry(`queue_position:${socketId}`, queueName, 300);
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
          local data = cjson.decode(item)
          if data.socketId == socketId then
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
        redisService.removeFromQueue(queueName, socketId)
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
        redisService.exists(`user_session:${socketId}`)
      ]);

      if (!userSession || !peerSession) {
        logger.warn('User session not found during match creation', {
          socketId, peerId, userSession, peerSession, worker: process.pid
        });
        
        // Re-queue available user
        if (userSession) await this.addToQueue(socketId);
        if (peerSession) await this.addToQueue(peerId);
        
        return false;
      }

      // Create match in Redis atomically
      const matchData = {
        roomId,
        users: [socketId, peerId],
        createdAt: Date.now(),
        status: 'active',
        matchQuality: await this.calculateMatchQuality(socketId, peerId)
      };

      const success = await redisService.createMatchAtomic(socketId, peerId, matchData);
      if (!success) {
        logger.warn('Failed to create atomic match in Redis', {
          socketId, peerId, worker: process.pid
        });
        return false;
      }

      // Get socket IDs from multiple possible servers
      const [userSocketId, peerSocketId] = await Promise.all([
        redisService.getSocketId(socketId),
        redisService.getSocketId(peerId)
      ]);

      if (!userSocketId || !peerSocketId) {
        logger.warn('Socket IDs not found during match creation', {
          socketId, peerId, userSocketId, peerSocketId, worker: process.pid
        });
        
        // Clean up the match
        await redisService.deleteMatch(socketId);
        await redisService.deleteMatch(peerId);
        return false;
      }

      // Join both sockets to the room (works across server instances)
      await Promise.all([
        io.socketsJoin(roomId),
        this.joinSocketToRoom(io, userSocketId, roomId),
        this.joinSocketToRoom(io, peerSocketId, roomId)
      ]);

      // Notify both users
      const baseMatchData = {
        roomId,
        timestamp: Date.now(),
        matchType: 'webrtc_chat',
        matchQuality: matchData.matchQuality
      };

      const userMatchData = { ...baseMatchData, peerId };
      const peerMatchData = { ...baseMatchData, peerId: socketId };

      // Emit to specific sockets
      io.to(userSocketId).emit('match_found', userMatchData);
      io.to(peerSocketId).emit('match_found', peerMatchData);

      // Update recent matches to prevent immediate re-matching
      await Promise.all([
        redisService.addToSet(`recent_matches:${socketId}`, peerId, 300), // 5 minutes
        redisService.addToSet(`recent_matches:${peerId}`, socketId, 300)
      ]);

      // Update metrics
      // metrics.activeMatches.inc({ worker: process.pid });
      // metrics.matchmakingSuccess.inc({ worker: process.pid });

      // Update user stats
      await Promise.all([
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
        socketId, peerId, roomId, matchQuality: matchData.matchQuality, worker: process.pid
      });

      return true;

    } catch (error) {
      logger.error('Error in atomic match creation', {
        error: error.message,
        stack: error.stack,
        socketId, peerId, roomId,
        worker: process.pid
      });
      
      // metrics.errorRate.inc({ type: 'match_creation', worker: process.pid });
      return false;
    } finally {
      await redisService.releaseLock(matchLock);
    }
  }

  async joinSocketToRoom(io, socketId, roomId) {
    try {
      const sockets = await io.fetchSockets();
      const targetSocket = sockets.find(s => s.id === socketId);
      if (targetSocket) {
        await targetSocket.join(roomId);
        return true;
      }
      return false;
    } catch (error) {
      logger.warn('Failed to join socket to room', {
        error: error.message,
        socketId, roomId
      });
      return false;
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
    const userPrefs = {
      ...preferences,
      userAgent: socket.handshake.headers['user-agent'],
      ip: socket.handshake.address,
      connectedAt: Date.now()
    };

    // Detect region from IP if not provided
    if (!userPrefs.region) {
      userPrefs.region = await this.detectRegion(userPrefs.ip);
    }

    await redisService.setHash(`user_preferences:${socketId}`, userPrefs, 3600);
    this.matchPreferences.set(socketId, userPrefs);
  }

  async detectRegion(ip) {
    // Simple region detection - in production, use GeoIP service
    // This is a placeholder implementation
    return 'NA'; // Default to North America
  }

  async wasRecentlyMatched(socketId) {
    const recentMatches = await redisService.getSet(`recent_matches:${socketId}`);
    return recentMatches.length > 0;
  }

  calculateEstimatedWait(queuePosition) {
    // Estimate based on average match time and position
    const avgMatchTime = 15; // seconds
    return Math.max(5, queuePosition * avgMatchTime);
  }

  setMatchTimeout(socket, socketId) {
    setTimeout(async () => {
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
  }

  async cancelMatch(socketId) {
    const cancelLock = `cancel_match:${socketId}`;
    
    try {
      const lockAcquired = await redisService.acquireLock(cancelLock, 5000);
      if (!lockAcquired) return;

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
      // Remove from all queues
      await this.removeFromAllQueues(socketId);

      // Handle active match
      const matchData = await redisService.getMatch(socketId);
      if (matchData) {
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
          await Promise.all([
            redisService.deleteMatch(socketId),
            redisService.deleteMatch(peerId)
          ]);

          // Update metrics
          const matchDuration = Date.now() - matchData.createdAt;
          // metrics.activeMatches.dec({ worker: process.pid });
          // metrics.matchDuration.observe(matchDuration / 1000);
          
          kafkaService.logMatchmakingEvent('match_ended', socketId, peerId, matchData.roomId, {
            duration: matchDuration,
            reason: 'disconnect'
          });
        }
      }

      // Cleanup user data
      await Promise.all([
        redisService.deleteKey(`user_preferences:${socketId}`),
        redisService.deleteKey(`connection_quality:${socketId}`),
        redisService.deleteKey(`recent_matches:${socketId}`),
        redisService.deleteKey(`queue_position:${socketId}`)
      ]);

      this.matchPreferences.delete(socketId);
      kafkaService.logMatchmakingEvent('user_left', socketId);

    } catch (error) {
      logger.error('Error handling matchmaking disconnect', {
        error: error.message,
        stack: error.stack,
        socketId,
        worker: process.pid
      });
      
      // metrics.errorRate.inc({ type: 'disconnect_handling', worker: process.pid });
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
        stats.queues[name.toLowerCase()] = 0;
      }
    }

    stats.totals.queuedUsers = Object.values(stats.queues).reduce((sum, count) => sum + count, 0);
    stats.totals.activeMatches = await redisService.getSetSize(this.redisKeys.activeMatches);
    stats.totals.pendingMatches = this.pendingMatches.size;
    
    return stats;
  }

  getActiveMatch(socketId) {
    return redisService.getMatch(socketId);
  }

  // Enhanced cleanup of stale data
  startCleanupTimer() {
    setInterval(async () => {
      await Promise.all([
        this.cleanupStaleMatches(),
        this.cleanupStaleQueues(),
        this.cleanupStaleUserData()
      ]);
    }, 60000); // Every minute
  }

  async cleanupStaleMatches() {
    try {
      const staleThreshold = 10 * 60 * 1000; // 10 minutes
      const activeMatches = await redisService.getAllMatches();

      for (const [socketId, matchData] of Object.entries(activeMatches)) {
        if (Date.now() - matchData.createdAt > staleThreshold) {
          logger.debug('Cleaning up stale match', { socketId, worker: process.pid });
          
          await redisService.deleteMatch(socketId);
          if (matchData.users) {
            for (const user of matchData.users) {
              await redisService.deleteMatch(user);
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
        const items = await redisService.getQueueItems(queueName);
        
        for (const item of items) {
          try {
            const data = JSON.parse(item);
            if (Date.now() - data.timestamp > staleThreshold) {
              await redisService.removeFromQueue(queueName, item);
              logger.debug('Removed stale queue item', {
                socketId: data.socketId,
                queue: queueName,
                age: Date.now() - data.timestamp
              });
            }
          } catch (parseError) {
            // Remove malformed items
            await redisService.removeFromQueue(queueName, item);
          }
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

      for (const key of socketIds) {
        const sessionData = await redisService.getHash(key);
        if (sessionData.connectedAt && Date.now() - parseInt(sessionData.connectedAt) > staleThreshold) {
          const socketId = key.replace('user_session:', '');
          
          await Promise.all([
            redisService.deleteKey(key),
            redisService.deleteKey(`user_preferences:${socketId}`),
            redisService.deleteKey(`connection_quality:${socketId}`),
            redisService.deleteKey(`recent_matches:${socketId}`)
          ]);

          logger.debug('Cleaned up stale user data', { socketId, worker: process.pid });
        }
      }
    } catch (error) {
      logger.error('Error in stale user data cleanup', {
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
        timestamp: Date.now()
      };
    } catch (error) {
      return {
        healthy: false,
        error: error.message,
        timestamp: Date.now()
      };
    }
  }
}

module.exports = new MatchmakingService();