const redisService = require('./redisService');
const kafkaService = require('./kafkaService');
const logger = require('../utils/logger');
const metrics = require('../monitoring/metrics');

class MatchmakingService {
  constructor() {
    this.queues = {
      PRIORITY: 'match_queue:priority',
      NORMAL: 'match_queue:normal',
      RETRY: 'match_queue:retry'
    };
    this.matchTimeout = 30000; // 30 seconds
    this.activeMatches = new Map(); // In-memory match tracking
  }

  async findMatch(socket, userKey, io) {
    const matchTimer = metrics.matchmakingDuration.startTimer();
    
    try {
      logger.debug('Finding match for user', { userKey, worker: process.pid });

      // Remove user from all queues first (cleanup)
      await this.removeFromAllQueues(userKey);

      // Try to find a match from existing queues
      const peerKey = await this.findAvailablePeer(userKey);

      if (peerKey) {
        // Create match
        const roomId = this.generateRoomId();
        await this.createMatch(socket, userKey, peerKey, roomId, io);
        
        kafkaService.logMatchmakingEvent('match_found', userKey, peerKey, roomId, {
          waitTime: 0 // Immediate match
        });
      } else {
        // Add to queue
        await this.addToQueue(userKey);
        socket.emit('waiting', {
          message: 'Looking for a match...',
          timestamp: Date.now(),
          queuePosition: await this.getQueuePosition(userKey)
        });

        // Set match timeout
        this.setMatchTimeout(socket, userKey);

        kafkaService.logMatchmakingEvent('added_to_queue', userKey);
        logger.debug('User added to matchmaking queue', { userKey, worker: process.pid });
      }

    } catch (error) {
      logger.error('Matchmaking error', {
        error: error.message,
        userKey,
        worker: process.pid
      });
      
      metrics.errorRate.inc({ type: 'matchmaking', worker: process.pid });
      socket.emit('error', {
        type: 'matchmaking_error',
        message: 'Failed to find match'
      });

      kafkaService.logErrorEvent('matchmaking', userKey, error);
    } finally {
      matchTimer();
    }
  }

  async findAvailablePeer(userKey) {
    // Try priority queue first, then normal queue
    for (const queueName of [this.queues.PRIORITY, this.queues.NORMAL]) {
      const peerKey = await redisService.getFromQueue(queueName);
      
      if (peerKey && peerKey !== userKey) {
        return peerKey;
      }
    }
    return null;
  }

  async addToQueue(userKey, priority = 'normal') {
    const queueName = priority === 'priority' ? this.queues.PRIORITY : this.queues.NORMAL;
    await redisService.addToQueue(queueName, userKey);
    
    metrics.queueSize.set(
      { queue: priority, worker: process.pid },
      await redisService.getQueueLength(queueName)
    );
  }

  async removeFromAllQueues(userKey) {
    const removeOps = Object.values(this.queues).map(queueName => ({
      method: 'lRem',
      args: [queueName, 0, userKey]
    }));

    await redisService.batchOperation(removeOps);
  }

  async getQueuePosition(userKey) {
    // This is an approximation - Redis lists don't have efficient position lookup
    const queueLength = await redisService.getQueueLength(this.queues.NORMAL);
    return Math.max(1, queueLength);
  }

  async createMatch(socket, userKey, peerKey, roomId, io) {
    try {
      // Store match in Redis
      await redisService.setMatch(userKey, peerKey, roomId);

      // Get peer socket
      const peerSocketId = await redisService.getSocketId(peerKey);
      
      if (!peerSocketId) {
        logger.warn('Peer socket not found, re-queueing user', {
          userKey,
          peerKey,
          worker: process.pid
        });
        
        await this.addToQueue(userKey);
        socket.emit('waiting', {
          message: 'Match failed, looking for another...',
          timestamp: Date.now()
        });
        return;
      }

      // Join both sockets to the room
      socket.join(roomId);
      io.to(peerSocketId).socketsJoin(roomId);

      // Notify both users
      const matchData = {
        roomId,
        peerKey,
        timestamp: Date.now(),
        matchType: 'webrtc_chat'
      };

      const peerMatchData = {
        roomId,
        peerKey: userKey,
        timestamp: Date.now(),
        matchType: 'webrtc_chat'
      };

      socket.emit('match_found', matchData);
      io.to(peerSocketId).emit('match_found', peerMatchData);

      // Track active match
      this.activeMatches.set(userKey, {
        peerKey,
        roomId,
        createdAt: Date.now(),
        status: 'active'
      });

      this.activeMatches.set(peerKey, {
        peerKey: userKey,
        roomId,
        createdAt: Date.now(),
        status: 'active'
      });

      // Update metrics
      metrics.activeMatches.inc({ worker: process.pid });
      metrics.matchmakingSuccess.inc({ worker: process.pid });

      // Update user stats
      await redisService.updateUserStats(userKey, {
        matches: Date.now(),
        lastMatch: peerKey
      });

      await redisService.updateUserStats(peerKey, {
        matches: Date.now(),
        lastMatch: userKey
      });

      logger.info('Match created successfully', {
        userKey,
        peerKey,
        roomId,
        worker: process.pid
      });

    } catch (error) {
      logger.error('Error creating match', {
        error: error.message,
        userKey,
        peerKey,
        roomId,
        worker: process.pid
      });
      
      metrics.errorRate.inc({ type: 'match_creation', worker: process.pid });
      throw error;
    }
  }

  setMatchTimeout(socket, userKey) {
    setTimeout(async () => {
      try {
        // Check if user is still waiting
        const match = await redisService.getMatch(userKey);
        if (!match) {
          socket.emit('match_timeout', {
            message: 'No match found, please try again',
            timestamp: Date.now()
          });

          await this.removeFromAllQueues(userKey);
          
          kafkaService.logMatchmakingEvent('match_timeout', userKey);
          logger.debug('Match timeout for user', { userKey, worker: process.pid });
        }
      } catch (error) {
        logger.error('Error in match timeout handler', {
          error: error.message,
          userKey,
          worker: process.pid
        });
      }
    }, this.matchTimeout);
  }

  async cancelMatch(userKey) {
    try {
      await this.removeFromAllQueues(userKey);
      
      // Remove from active matches if exists
      this.activeMatches.delete(userKey);

      kafkaService.logMatchmakingEvent('match_cancelled', userKey);
      logger.debug('Match cancelled for user', { userKey, worker: process.pid });

    } catch (error) {
      logger.error('Error cancelling match', {
        error: error.message,
        userKey,
        worker: process.pid
      });
      throw error;
    }
  }

  async handleDisconnect(userKey, io) {
    try {
      // Remove from queues
      await this.removeFromAllQueues(userKey);

      // Handle active match
      const peerKey = await redisService.getMatch(userKey);
      if (peerKey) {
        // Notify peer of disconnection
        const peerSocketId = await redisService.getSocketId(peerKey);
        if (peerSocketId) {
          io.to(peerSocketId).emit('peer_disconnected', {
            peerKey: userKey,
            reason: 'disconnect',
            timestamp: Date.now()
          });
        }

        // Clean up match data
        await redisService.deleteMatch(userKey);
        await redisService.deleteMatch(peerKey);

        // Update metrics
        if (this.activeMatches.has(userKey)) {
          metrics.activeMatches.dec({ worker: process.pid });
          const matchData = this.activeMatches.get(userKey);
          const matchDuration = Date.now() - matchData.createdAt;
          
          metrics.matchDuration.observe(matchDuration / 1000);
          
          kafkaService.logMatchmakingEvent('match_ended', userKey, peerKey, matchData.roomId, {
            duration: matchDuration,
            reason: 'disconnect'
          });
        }

        // Remove from active matches
        this.activeMatches.delete(userKey);
        this.activeMatches.delete(peerKey);
      }

      kafkaService.logMatchmakingEvent('user_left', userKey);

    } catch (error) {
      logger.error('Error handling matchmaking disconnect', {
        error: error.message,
        userKey,
        worker: process.pid
      });
      
      metrics.errorRate.inc({ type: 'disconnect_handling', worker: process.pid });
    }
  }

  generateRoomId() {
    return `room-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  // Statistics and monitoring
  async getQueueStats() {
    const stats = {};
    
    for (const [name, queueKey] of Object.entries(this.queues)) {
      stats[name.toLowerCase()] = await redisService.getQueueLength(queueKey);
    }

    stats.activeMatches = this.activeMatches.size / 2; // Divide by 2 since each match has 2 entries
    
    return stats;
  }

  getActiveMatch(userKey) {
    return this.activeMatches.get(userKey);
  }

  // Periodic cleanup of stale matches
  startCleanupTimer() {
    setInterval(() => {
      this.cleanupStaleMatches();
    }, 60000); // Every minute
  }

  cleanupStaleMatches() {
    const now = Date.now();
    const staleThreshold = 10 * 60 * 1000; // 10 minutes

    for (const [userKey, matchData] of this.activeMatches.entries()) {
      if (now - matchData.createdAt > staleThreshold) {
        logger.debug('Cleaning up stale match', { userKey, worker: process.pid });
        this.activeMatches.delete(userKey);
        
        kafkaService.logMatchmakingEvent('match_cleanup', userKey, matchData.peerKey, matchData.roomId, {
          reason: 'stale',
          age: now - matchData.createdAt
        });
      }
    }
  }
}

module.exports = new MatchmakingService();