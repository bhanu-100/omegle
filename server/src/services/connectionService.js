const redisService = require('./redisService');
const kafkaService = require('./kafkaService');
const logger = require('../utils/logger');
const metrics = require('../monitoring/metrics');

class ConnectionService {
  constructor() {
    this.connections = new Map();
    this.rateLimitMap = new Map();
    this.cleanupInterval = null;

    // Rate limiting configuration
    this.rateLimitWindow = parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000;
    this.maxRequestsPerWindow = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 200;

    this.startCleanupTimer();
  }

  // FIXED: Corrected parameter naming (was duplicate socketId parameters)
  async registerConnection(socketId) {
    try {
      // Store connection info
      this.connections.set(socketId, {
        socketId,
        connectedAt: Date.now(),
        lastActivity: Date.now(),
        requestCount: 0
      });
      // i handle direct this things but use in future
      // IMPROVED: Store in Redis with proper session data
      // await redisService.setHash(`user_session:${socketId}`, {
      //   socketId,
      //   worker: process.pid.toString(),
      //   connectedAt: Date.now(),
      //   lastActivity: Date.now(),
      //   status: 'connected'
      // }, 3600); // 1 hour TTL

      // OPTIMIZATION: Update metrics if available
      try {
        // metrics.totalConnections.inc({ worker: process.pid });
      } catch (metricsError) {
        // Ignore metrics errors to prevent service disruption
      }

      kafkaService.logConnectionEvent('connection_registered', socketId, {
        timestamp: Date.now(),
        worker: process.pid
      });

      logger.debug('Connection registered', { socketId, worker: process.pid });

    } catch (error) {
      logger.error('Failed to register connection', {
        error: error.message,
        socketId,
        worker: process.pid
      });

      try {
        // metrics.errorRate.inc({ type: 'connection_registration', worker: process.pid });
      } catch (metricsError) {
        // Ignore metrics errors
      }
      throw error;
    }
  }

  async handleDisconnect(socketId) {
    try {
      const connection = this.connections.get(socketId);
      if (connection) {
        const sessionDuration = Date.now() - connection.connectedAt;

        // OPTIMIZATION: Update metrics if available
        try {
          // metrics.sessionDuration.observe(sessionDuration / 1000);
        } catch (metricsError) {
          // Ignore metrics errors
        }

        kafkaService.logConnectionEvent('connection_ended', socketId, {
          sessionDuration,
          requestCount: connection.requestCount,
          worker: process.pid
        });

        // Remove from local storage
        this.connections.delete(socketId);
      }

      // IMPROVED: Remove from Redis with proper cleanup
      await Promise.allSettled([
        redisService.deleteKey(`user_session:${socketId}`),
        redisService.deleteKey(`connection_quality:${socketId}`),
        redisService.deleteKey(`user_preferences:${socketId}`)
      ]);

      logger.debug('Connection cleanup completed', { socketId, worker: process.pid });

    } catch (error) {
      logger.error('Failed to handle disconnect', {
        error: error.message,
        socketId,
        worker: process.pid
      });

      try {
        // metrics.errorRate.inc({ type: 'disconnect_handling', worker: process.pid });
      } catch (metricsError) {
        // Ignore metrics errors
      }
    }
  }

  // OPTIMIZATION: Improved rate limiting with efficient array operations
  isRateLimited(socketId) {
    const now = Date.now();
    const windowStart = now - this.rateLimitWindow;

    if (!this.rateLimitMap.has(socketId)) {
      this.rateLimitMap.set(socketId, []);
    }

    const requests = this.rateLimitMap.get(socketId);

    // OPTIMIZATION: More efficient removal of old requests
    let i = 0;
    while (i < requests.length && requests[i] < windowStart) {
      i++;
    }
    if (i > 0) {
      requests.splice(0, i);
    }

    // Check if limit exceeded
    if (requests.length >= this.maxRequestsPerWindow) {
      try {
        // metrics.rateLimitHits.inc({ worker: process.pid });
      } catch (metricsError) {
        // Ignore metrics errors
      }

      kafkaService.logEvent('rate_limit_exceeded', {
        socketId,
        requestCount: requests.length,
        windowMs: this.rateLimitWindow,
        worker: process.pid
      });

      return true;
    }

    // Add current request
    requests.push(now);

    // Update connection activity
    const connection = this.connections.get(socketId);
    if (connection) {
      connection.lastActivity = now;
      connection.requestCount++;
    }

    return false;
  }

  updateActivity(socketId) {
    const connection = this.connections.get(socketId);
    if (connection) {
      connection.lastActivity = Date.now();
      connection.requestCount++;
    }
  }

  getConnection(socketId) {
    return this.connections.get(socketId);
  }

  getConnectionCount() {
    return this.connections.size;
  }

  getConnectionStats() {
    const now = Date.now();
    const stats = {
      total: this.connections.size,
      active: 0,
      idle: 0,
      avgSessionDuration: 0,
      totalRequests: 0
    };

    let totalSessionTime = 0;

    for (const connection of this.connections.values()) {
      const sessionDuration = now - connection.connectedAt;
      const idleTime = now - connection.lastActivity;

      totalSessionTime += sessionDuration;
      stats.totalRequests += connection.requestCount;

      if (idleTime < 300000) { // Active if <5 min idle
        stats.active++;
      } else {
        stats.idle++;
      }
    }

    if (stats.total > 0) {
      stats.avgSessionDuration = totalSessionTime / stats.total;
    }

    return stats;
  }

  startCleanupTimer() {
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
  }

  // OPTIMIZATION: Batch cleanup for better performance
  cleanup() {
    const now = Date.now();
    const windowStart = now - this.rateLimitWindow;
    const staleThreshold = 15 * 60 * 1000; // 15 minutes

    // Clean rate limit map efficiently
    const rateLimitEntriesToDelete = [];
    for (const [socketId, requests] of this.rateLimitMap.entries()) {
      // Remove old requests
      let i = 0;
      while (i < requests.length && requests[i] < windowStart) {
        i++;
      }
      if (i > 0) {
        requests.splice(0, i);
      }
      
      if (requests.length === 0) {
        rateLimitEntriesToDelete.push(socketId);
      }
    }

    // Delete empty entries
    rateLimitEntriesToDelete.forEach(socketId => {
      this.rateLimitMap.delete(socketId);
    });

    // Clean stale connections
    let staleConnections = 0;
    const connectionsToDelete = [];
    
    for (const [socketId, connection] of this.connections.entries()) {
      const idleTime = now - connection.lastActivity;
      if (idleTime > staleThreshold) {
        connectionsToDelete.push(socketId);
        staleConnections++;

        kafkaService.logConnectionEvent('connection_cleanup', socketId, {
          reason: 'stale',
          idleTime,
          sessionDuration: now - connection.connectedAt,
          worker: process.pid
        });
      }
    }

    // Delete stale connections
    connectionsToDelete.forEach(socketId => {
      this.connections.delete(socketId);
    });

    if (staleConnections > 0) {
      logger.debug('Cleaned up stale connections', {
        count: staleConnections,
        worker: process.pid
      });
    }

    logger.debug('Connection cleanup completed', {
      activeConnections: this.connections.size,
      rateLimitEntries: this.rateLimitMap.size,
      staleConnectionsRemoved: staleConnections,
      worker: process.pid
    });
  }

  async healthCheck() {
    const stats = this.getConnectionStats();
    const queueStats = this.getRateLimitQueueStats();

    return {
      connections: {
        total: stats.total,
        active: stats.active,
        idle: stats.idle,
        avgSessionDuration: Math.round(stats.avgSessionDuration / 1000),
        totalRequests: stats.totalRequests
      },
      rateLimit: queueStats,
      worker: process.pid
    };
  }

  getRateLimitQueueStats() {
    let activeEntries = 0;
    let totalRequests = 0;

    for (const requests of this.rateLimitMap.values()) {
      if (requests.length > 0) {
        activeEntries++;
        totalRequests += requests.length;
      }
    }

    return {
      activeEntries,
      totalRequests,
      avgRequestsPerEntry: activeEntries > 0 ? Math.round(totalRequests / activeEntries) : 0
    };
  }

  async getUserInfo(socketId) {
    try {
      const localConnection = this.connections.get(socketId);
      const redisSession = await redisService.getHash(`user_session:${socketId}`);

      return {
        local: localConnection || null,
        redis: redisSession || null,
        inSync: localConnection?.socketId === redisSession?.socketId
      };
    } catch (error) {
      logger.error('Error getting user info', {
        error: error.message,
        socketId,
        worker: process.pid
      });
      return {
        local: null,
        redis: null,
        inSync: false,
        error: error.message
      };
    }
  }

  async forceDisconnect(socketId, reason = 'admin') {
    try {
      const connection = this.connections.get(socketId);
      if (connection) {
        kafkaService.logConnectionEvent('force_disconnect', socketId, {
          reason,
          sessionDuration: Date.now() - connection.connectedAt,
          worker: process.pid
        });
      }

      await this.handleDisconnect(socketId);

      logger.info('User force disconnected', { socketId, reason, worker: process.pid });
      return true;
    } catch (error) {
      logger.error('Failed to force disconnect user', {
        error: error.message,
        socketId,
        reason,
        worker: process.pid
      });
      return false;
    }
  }

  async getAllConnections() {
    const now = Date.now();
    const connections = [];

    for (const [socketId, conn] of this.connections.entries()) {
      connections.push({
        socketId,
        connectedAt: conn.connectedAt,
        lastActivity: conn.lastActivity,
        sessionDuration: now - conn.connectedAt,
        idleTime: now - conn.lastActivity,
        requestCount: conn.requestCount
      });
    }

    return connections.sort((a, b) => b.connectedAt - a.connectedAt);
  }

  async getActiveUsers(limit = 50) {
    const connections = await this.getAllConnections();
    return connections
      .filter(conn => conn.idleTime < 300000) // Active within 5 minutes
      .slice(0, limit);
  }

  // OPTIMIZATION: Improved Redis sync with error handling
  async syncWithRedis() {
    const results = { localOnly: [], redisOnly: [], synced: 0, errors: [] };

    for (const [socketId, conn] of this.connections.entries()) {
      try {
        const redisSession = await redisService.getHash(`user_session:${socketId}`);
        if (redisSession && redisSession.socketId === conn.socketId) {
          results.synced++;
        } else if (!redisSession || !redisSession.socketId) {
          results.localOnly.push(socketId);
          // Re-register in Redis
          await this.registerConnection(socketId);
        }
      } catch (error) {
        results.errors.push({ socketId, error: error.message });
      }
    }

    // Check for Redis-only entries
    try {
      const redisKeys = await redisService.getKeysPattern('user_session:*');
      for (const key of redisKeys) {
        const socketId = key.replace('user_session:', '');
        if (!this.connections.has(socketId)) {
          results.redisOnly.push(socketId);
          // Clean up stale Redis entries
          await redisService.deleteKey(key);
        }
      }
    } catch (error) {
      results.errors.push({ operation: 'redis_cleanup', error: error.message });
    }

    logger.info('Redis sync completed', { ...results, worker: process.pid });
    return results;
  }

  async shutdown() {
    logger.info('Shutting down connection service', { worker: process.pid });

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    const finalStats = this.getConnectionStats();
    kafkaService.logEvent('service_shutdown', { 
      service: 'connection', 
      finalStats, 
      worker: process.pid 
    });

    this.connections.clear();
    this.rateLimitMap.clear();

    logger.info('Connection service shut down', { worker: process.pid });
  }
}

module.exports = new ConnectionService();