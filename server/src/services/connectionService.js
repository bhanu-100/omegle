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

  // Corrected duplicate parameter names
  async registerConnection(socketId) {
    try {
      // Store connection info
      this.connections.set(socketId, {
        socketId,
        connectedAt: Date.now(),
        lastActivity: Date.now(),
        requestCount: 0
      });

      // Store in Redis
      await redisService.setSocketMapping(socketId, socketId);

      // Update connection metrics
      // metrics.totalConnections.inc({ worker: process.pid });

      kafkaService.logConnectionEvent('connection_registered', socketId, socketId, {
        timestamp: Date.now()
      });

      logger.debug('Connection registered', { socketId, worker: process.pid });

    } catch (error) {
      logger.error('Failed to register connection', {
        error: error.message,
        socketId,
        worker: process.pid
      });

      // metrics.errorRate.inc({ type: 'connection_registration', worker: process.pid });
      throw error;
    }
  }

  async handleDisconnect(socketId) {
    try {
      const connection = this.connections.get(socketId);
      if (connection) {
        const sessionDuration = Date.now() - connection.connectedAt;

        // Update metrics
        // metrics.sessionDuration.observe(sessionDuration / 1000);

        kafkaService.logConnectionEvent('connection_ended', socketId, connection.socketId, {
          sessionDuration,
          requestCount: connection.requestCount
        });

        // Remove from local storage
        this.connections.delete(socketId);
      }

      // Remove from Redis
      await redisService.deleteSocketMapping(socketId);

      logger.debug('Connection cleanup completed', { socketId, worker: process.pid });

    } catch (error) {
      logger.error('Failed to handle disconnect', {
        error: error.message,
        socketId,
        worker: process.pid
      });

      // metrics.errorRate.inc({ type: 'disconnect_handling', worker: process.pid });
    }
  }

  isRateLimited(socketId) {
    const now = Date.now();
    const windowStart = now - this.rateLimitWindow;

    if (!this.rateLimitMap.has(socketId)) {
      this.rateLimitMap.set(socketId, []);
    }

    const requests = this.rateLimitMap.get(socketId);

    // Remove old requests
    while (requests.length > 0 && requests[0] < windowStart) {
      requests.shift();
    }

    // Check if limit exceeded
    if (requests.length >= this.maxRequestsPerWindow) {
      // metrics.rateLimitHits.inc({ worker: process.pid });

      kafkaService.logEvent('rate_limit_exceeded', {
        socketId,
        requestCount: requests.length,
        windowMs: this.rateLimitWindow
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

      if (idleTime < 300000) { // Active <5 min
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

  cleanup() {
    const now = Date.now();
    const windowStart = now - this.rateLimitWindow;
    const staleThreshold = 15 * 60 * 1000; // 15 minutes

    // Clean rate limit map
    for (const [socketId, requests] of this.rateLimitMap.entries()) {
      while (requests.length > 0 && requests[0] < windowStart) {
        requests.shift();
      }
      if (requests.length === 0) this.rateLimitMap.delete(socketId);
    }

    // Clean stale connections
    let staleConnections = 0;
    for (const [socketId, connection] of this.connections.entries()) {
      const idleTime = now - connection.lastActivity;
      if (idleTime > staleThreshold) {
        this.connections.delete(socketId);
        staleConnections++;

        kafkaService.logConnectionEvent('connection_cleanup', socketId, connection.socketId, {
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
      rateLimit: queueStats
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
    const localConnection = this.connections.get(socketId);
    const redisSocketId = await redisService.getSocketId(socketId);

    return {
      local: localConnection || null,
      redis: redisSocketId || null,
      inSync: localConnection?.socketId === redisSocketId
    };
  }

  async forceDisconnect(socketId, reason = 'admin') {
    try {
      const connection = this.connections.get(socketId);
      if (connection) {
        kafkaService.logConnectionEvent('force_disconnect', socketId, connection.socketId, {
          reason,
          sessionDuration: Date.now() - connection.connectedAt
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
      .filter(conn => conn.idleTime < 300000)
      .slice(0, limit);
  }

  async syncWithRedis() {
    const results = { localOnly: [], redisOnly: [], synced: 0, errors: [] };

    for (const [socketId, conn] of this.connections.entries()) {
      try {
        const redisSocketId = await redisService.getSocketId(socketId);
        if (redisSocketId === conn.socketId) {
          results.synced++;
        } else if (!redisSocketId) {
          results.localOnly.push(socketId);
        }
      } catch (error) {
        results.errors.push({ socketId, error: error.message });
      }
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
    kafkaService.logEvent('service_shutdown', { service: 'connection', finalStats, worker: process.pid });

    this.connections.clear();
    this.rateLimitMap.clear();

    logger.info('Connection service shut down', { worker: process.pid });
  }
}

module.exports = new ConnectionService();
