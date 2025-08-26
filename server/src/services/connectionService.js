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

  async registerConnection(userKey, socketId) {
    try {
      // Store connection info
      this.connections.set(userKey, {
        socketId,
        connectedAt: Date.now(),
        lastActivity: Date.now(),
        requestCount: 0
      });

      // Store in Redis
      await redisService.setSocketMapping(userKey, socketId);

      // Update connection metrics
      metrics.totalConnections.inc({ worker: process.pid });
      
      kafkaService.logConnectionEvent('connection_registered', userKey, socketId, {
        timestamp: Date.now()
      });

      logger.debug('Connection registered', { userKey, socketId, worker: process.pid });

    } catch (error) {
      logger.error('Failed to register connection', {
        error: error.message,
        userKey,
        socketId,
        worker: process.pid
      });
      
      metrics.errorRate.inc({ type: 'connection_registration', worker: process.pid });
      throw error;
    }
  }

  async handleDisconnect(userKey) {
    try {
      const connection = this.connections.get(userKey);
      if (connection) {
        const sessionDuration = Date.now() - connection.connectedAt;
        
        // Update metrics
        metrics.sessionDuration.observe(sessionDuration / 1000);
        
        kafkaService.logConnectionEvent('connection_ended', userKey, connection.socketId, {
          sessionDuration,
          requestCount: connection.requestCount
        });

        // Remove from local storage
        this.connections.delete(userKey);
      }

      // Remove from Redis
      await redisService.deleteSocketMapping(userKey);
      
      logger.debug('Connection cleanup completed', { userKey, worker: process.pid });

    } catch (error) {
      logger.error('Failed to handle disconnect', {
        error: error.message,
        userKey,
        worker: process.pid
      });
      
      metrics.errorRate.inc({ type: 'disconnect_handling', worker: process.pid });
    }
  }

  isRateLimited(userKey) {
    const now = Date.now();
    const windowStart = now - this.rateLimitWindow;

    if (!this.rateLimitMap.has(userKey)) {
      this.rateLimitMap.set(userKey, []);
    }

    const requests = this.rateLimitMap.get(userKey);
    
    // Remove old requests
    while (requests.length > 0 && requests[0] < windowStart) {
      requests.shift();
    }

    // Check if limit exceeded
    if (requests.length >= this.maxRequestsPerWindow) {
      metrics.rateLimitHits.inc({ worker: process.pid });
      
      kafkaService.logEvent('rate_limit_exceeded', {
        userKey,
        requestCount: requests.length,
        windowMs: this.rateLimitWindow
      });
      
      return true;
    }

    // Add current request
    requests.push(now);
    
    // Update connection activity
    const connection = this.connections.get(userKey);
    if (connection) {
      connection.lastActivity = now;
      connection.requestCount++;
    }

    return false;
  }

  updateActivity(userKey) {
    const connection = this.connections.get(userKey);
    if (connection) {
      connection.lastActivity = Date.now();
      connection.requestCount++;
    }
  }

  getConnection(userKey) {
    return this.connections.get(userKey);
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

      if (idleTime < 300000) { // 5 minutes
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
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60000); // Every minute
  }

  cleanup() {
    const now = Date.now();
    const windowStart = now - this.rateLimitWindow;
    const staleConnectionThreshold = 15 * 60 * 1000; // 15 minutes

    // Clean up rate limit map
    for (const [userKey, requests] of this.rateLimitMap.entries()) {
      // Remove old requests
      while (requests.length > 0 && requests[0] < windowStart) {
        requests.shift();
      }

      // Remove empty entries
      if (requests.length === 0) {
        this.rateLimitMap.delete(userKey);
      }
    }

    // Clean up stale connections
    let staleConnections = 0;
    for (const [userKey, connection] of this.connections.entries()) {
      const idleTime = now - connection.lastActivity;
      
      if (idleTime > staleConnectionThreshold) {
        this.connections.delete(userKey);
        staleConnections++;
        
        kafkaService.logConnectionEvent('connection_cleanup', userKey, connection.socketId, {
          reason: 'stale',
          idleTime,
          sessionDuration: now - connection.connectedAt
        });
      }
    }

    if (staleConnections > 0) {
      logger.debug('Cleaned up stale connections', {
        count: staleConnections,
        worker: process.pid
      });
    }

    // Log cleanup stats
    logger.debug('Connection cleanup completed', {
      activeConnections: this.connections.size,
      rateLimitEntries: this.rateLimitMap.size,
      staleConnectionsRemoved: staleConnections,
      worker: process.pid
    });
  }

  // Health monitoring
  async healthCheck() {
    const stats = this.getConnectionStats();
    const queueStats = await this.getRateLimitQueueStats();

    return {
      connections: {
        total: stats.total,
        active: stats.active,
        idle: stats.idle,
        avgSessionDuration: Math.round(stats.avgSessionDuration / 1000), // in seconds
        totalRequests: stats.totalRequests
      },
      rateLimit: {
        activeEntries: queueStats.activeEntries,
        totalRequests: queueStats.totalRequests,
        avgRequestsPerEntry: queueStats.avgRequestsPerEntry
      }
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

  // Get user connection info
  async getUserInfo(userKey) {
    const localConnection = this.connections.get(userKey);
    const redisSocketId = await redisService.getSocketId(userKey);

    return {
      local: localConnection || null,
      redis: redisSocketId || null,
      inSync: localConnection?.socketId === redisSocketId
    };
  }

  // Force disconnect a user (admin function)
  async forceDisconnect(userKey, reason = 'admin') {
    try {
      const connection = this.connections.get(userKey);
      if (connection) {
        kafkaService.logConnectionEvent('force_disconnect', userKey, connection.socketId, {
          reason,
          sessionDuration: Date.now() - connection.connectedAt
        });
      }

      await this.handleDisconnect(userKey);
      
      logger.info('User force disconnected', { userKey, reason, worker: process.pid });
      return true;
    } catch (error) {
      logger.error('Failed to force disconnect user', {
        error: error.message,
        userKey,
        reason,
        worker: process.pid
      });
      return false;
    }
  }

  // Bulk operations for monitoring
  async getAllConnections() {
    const connections = [];
    const now = Date.now();

    for (const [userKey, connection] of this.connections.entries()) {
      connections.push({
        userKey,
        socketId: connection.socketId,
        connectedAt: connection.connectedAt,
        lastActivity: connection.lastActivity,
        sessionDuration: now - connection.connectedAt,
        idleTime: now - connection.lastActivity,
        requestCount: connection.requestCount
      });
    }

    return connections.sort((a, b) => b.connectedAt - a.connectedAt);
  }

  async getActiveUsers(limit = 50) {
    const connections = await this.getAllConnections();
    return connections
      .filter(conn => conn.idleTime < 300000) // Active in last 5 minutes
      .slice(0, limit);
  }

  // Sync with Redis (useful for debugging)
  async syncWithRedis() {
    const syncResults = {
      localOnly: [],
      redisOnly: [],
      synced: 0,
      errors: []
    };

    try {
      // Check local connections against Redis
      for (const [userKey, connection] of this.connections.entries()) {
        try {
          const redisSocketId = await redisService.getSocketId(userKey);
          
          if (redisSocketId === connection.socketId) {
            syncResults.synced++;
          } else if (!redisSocketId) {
            syncResults.localOnly.push(userKey);
          }
        } catch (error) {
          syncResults.errors.push({ userKey, error: error.message });
        }
      }

      logger.info('Redis sync completed', {
        ...syncResults,
        worker: process.pid
      });

    } catch (error) {
      logger.error('Failed to sync with Redis', {
        error: error.message,
        worker: process.pid
      });
    }

    return syncResults;
  }

  async shutdown() {
    logger.info('Shutting down connection service', { worker: process.pid });

    // Clear cleanup timer
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Log final statistics
    const finalStats = this.getConnectionStats();
    kafkaService.logEvent('service_shutdown', {
      service: 'connection',
      finalStats,
      worker: process.pid
    });

    // Clear local storage
    this.connections.clear();
    this.rateLimitMap.clear();

    logger.info('Connection service shut down', { worker: process.pid });
  }
}

module.exports = new ConnectionService();