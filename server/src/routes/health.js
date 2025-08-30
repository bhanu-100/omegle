const express = require('express');
const redisService = require('../services/redisService');
const kafkaService = require('../services/kafkaService');
const connectionService = require('../services/connectionService');
const matchmakingService = require('../services/matchmakingService');
const logger = require('../utils/logger');
const metrics = require('../monitoring/metrics');

const router = express.Router();

// Basic health check
router.get('/', async (req, res) => {
  const startTime = process.hrtime.bigint();
  
  try {
    const health = {
      status: 'UP',
      timestamp: new Date().toISOString(),
      worker: process.pid,
      uptime: Math.floor(process.uptime()),
      version: process.env.npm_package_version || '1.0.0',
      environment: process.env.NODE_ENV || 'development'
    };

    // Quick Redis ping
    try {
      await redisService.ping();
      health.redis = 'UP';
    } catch (error) {
      health.redis = 'DOWN';
      health.status = 'DEGRADED';
      health.redisError = error.message;
    }

    // Kafka status
    const kafkaHealth = await kafkaService.checkHealth();
    health.kafka = kafkaHealth.status === 'connected' ? 'UP' : 
                   kafkaHealth.status === 'disabled' ? 'DISABLED' : 'DOWN';
    
    if (health.kafka === 'DOWN') {
      health.status = health.status === 'UP' ? 'DEGRADED' : 'DOWN';
    }

    // Response time
    const endTime = process.hrtime.bigint();
    const responseTime = Number(endTime - startTime) / 1000000; // Convert to milliseconds
    health.responseTime = `${responseTime.toFixed(2)}ms`;

    // Basic metrics
    // health.metrics = {
    //   activeConnections: metrics.activeConnections._hashMap.get(`worker:${process.pid}`)?.value || 0,
    //   totalConnections: metrics.totalConnections._hashMap.get(`worker:${process.pid}`)?.value || 0,
    //   activeMatches: metrics.activeMatches._hashMap.get(`worker:${process.pid}`)?.value || 0,
    //   errorCount: Array.from(metrics.errorRate._hashMap.values())
    //     .reduce((sum, entry) => sum + (entry.value || 0), 0)
    // };

    const statusCode = health.status === 'UP' ? 200 : 
                      health.status === 'DEGRADED' ? 200 : 503;

    res.status(statusCode).json(health);

  } catch (error) {
    logger.error('Health check failed', {
      error: error.message,
      stack: error.stack,
      worker: process.pid
    });

    res.status(503).json({
      status: 'DOWN',
      timestamp: new Date().toISOString(),
      worker: process.pid,
      error: error.message
    });
  }
});

// Detailed health check
router.get('/detailed', async (req, res) => {
  try {
    const detailedHealth = {
      status: 'UP',
      timestamp: new Date().toISOString(),
      worker: process.pid,
      uptime: Math.floor(process.uptime()),
      memory: process.memoryUsage(),
      cpu: process.cpuUsage(),
      environment: {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        nodeEnv: process.env.NODE_ENV
      },
      services: {},
      metrics: {}
    };

    // Redis detailed health
    try {
      const redisStartTime = Date.now();
      await redisService.ping();
      const redisLatency = Date.now() - redisStartTime;
      
      detailedHealth.services.redis = {
        status: 'UP',
        latency: `${redisLatency}ms`,
        poolSize: redisService.poolSize || 'N/A'
      };
    } catch (error) {
      detailedHealth.services.redis = {
        status: 'DOWN',
        error: error.message
      };
      detailedHealth.status = 'DEGRADED';
    }

    // Kafka detailed health
    const kafkaHealth = await kafkaService.checkHealth();
    detailedHealth.services.kafka = {
      status: kafkaHealth.status,
      enabled: kafkaService.enabled,
      connected: kafkaService.connected,
      batchSize: kafkaHealth.batchSize || 0,
      isReconnecting: kafkaHealth.isReconnecting || false
    };

    if (kafkaService.enabled && !kafkaService.connected) {
      detailedHealth.status = detailedHealth.status === 'UP' ? 'DEGRADED' : 'DOWN';
    }

    // Connection service health
    try {
      const connectionHealth = await connectionService.healthCheck();
      detailedHealth.services.connections = {
        status: 'UP',
        ...connectionHealth
      };
    } catch (error) {
      detailedHealth.services.connections = {
        status: 'DOWN',
        error: error.message
      };
    }

    // Matchmaking service health
    try {
      const queueStats = await matchmakingService.getQueueStats();
      detailedHealth.services.matchmaking = {
        status: 'UP',
        queues: queueStats
      };
    } catch (error) {
      detailedHealth.services.matchmaking = {
        status: 'DOWN',
        error: error.message
      };
    }

    // Detailed metrics
    // detailedHealth.metrics = {
    //   connections: {
    //     active: metrics.activeConnections._hashMap.get(`worker:${process.pid}`)?.value || 0,
    //     total: metrics.totalConnections._hashMap.get(`worker:${process.pid}`)?.value || 0
    //   },
    //   matches: {
    //     active: metrics.activeMatches._hashMap.get(`worker:${process.pid}`)?.value || 0,
    //     successful: metrics.matchmakingSuccess._hashMap.get(`worker:${process.pid}`)?.value || 0
    //   },
    //   signaling: {
    //     messages: Array.from(metrics.signalingMessages._hashMap.values())
    //       .reduce((sum, entry) => sum + (entry.value || 0), 0)
    //   },
    //   errors: {
    //     total: Array.from(metrics.errorRate._hashMap.values())
    //       .reduce((sum, entry) => sum + (entry.value || 0), 0),
    //     rateLimitHits: metrics.rateLimitHits._hashMap.get(`worker:${process.pid}`)?.value || 0
    //   }
    // };

    const statusCode = detailedHealth.status === 'UP' ? 200 : 
                      detailedHealth.status === 'DEGRADED' ? 200 : 503;

    res.status(statusCode).json(detailedHealth);

  } catch (error) {
    logger.error('Detailed health check failed', {
      error: error.message,
      stack: error.stack,
      worker: process.pid
    });

    res.status(503).json({
      status: 'DOWN',
      timestamp: new Date().toISOString(),
      worker: process.pid,
      error: error.message
    });
  }
});

// Readiness probe (K8s compatible)
router.get('/ready', async (req, res) => {
  try {
    // Check if all critical services are ready
    let ready = true;
    const checks = {};

    // Redis readiness
    try {
      await redisService.ping();
      checks.redis = 'READY';
    } catch (error) {
      checks.redis = 'NOT_READY';
      ready = false;
    }

    // Kafka readiness (if enabled)
    if (kafkaService.enabled) {
      checks.kafka = kafkaService.connected ? 'READY' : 'NOT_READY';
      if (!kafkaService.connected) {
        ready = false;
      }
    } else {
      checks.kafka = 'DISABLED';
    }

    const response = {
      ready,
      timestamp: new Date().toISOString(),
      worker: process.pid,
      checks
    };

    res.status(ready ? 200 : 503).json(response);

  } catch (error) {
    logger.error('Readiness check failed', {
      error: error.message,
      worker: process.pid
    });

    res.status(503).json({
      ready: false,
      timestamp: new Date().toISOString(),
      worker: process.pid,
      error: error.message
    });
  }
});

// Liveness probe (K8s compatible)
router.get('/live', (req, res) => {
  // Simple liveness check - if we can respond, we're alive
  res.status(200).json({
    alive: true,
    timestamp: new Date().toISOString(),
    worker: process.pid,
    uptime: Math.floor(process.uptime())
  });
});

// System info endpoint
router.get('/system', (req, res) => {
  try {
    const systemInfo = {
      timestamp: new Date().toISOString(),
      worker: process.pid,
      system: {
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        cpuUsage: process.cpuUsage(),
        memoryUsage: process.memoryUsage(),
        uptime: Math.floor(process.uptime()),
        loadAverage: require('os').loadavg(),
        cpuCount: require('os').cpus().length,
        freeMemory: require('os').freemem(),
        totalMemory: require('os').totalmem(),
        hostname: require('os').hostname()
      },
      process: {
        pid: process.pid,
        ppid: process.ppid,
        uid: process.getuid?.() || 'N/A',
        gid: process.getgid?.() || 'N/A',
        cwd: process.cwd(),
        execPath: process.execPath,
        argv: process.argv
      },
      environment: {
        NODE_ENV: process.env.NODE_ENV,
        LOG_LEVEL: process.env.LOG_LEVEL,
        CLUSTER_WORKERS: process.env.CLUSTER_WORKERS,
        REDIS_URL: process.env.REDIS_URL ? '[CONFIGURED]' : '[NOT_SET]',
        KAFKA_BROKERS: process.env.KAFKA_BROKERS ? '[CONFIGURED]' : '[NOT_SET]'
      }
    };

    res.json(systemInfo);

  } catch (error) {
    logger.error('System info request failed', {
      error: error.message,
      worker: process.pid
    });

    res.status(500).json({
      error: 'Failed to get system info',
      timestamp: new Date().toISOString(),
      worker: process.pid
    });
  }
});

// Connection statistics
router.get('/connections', async (req, res) => {
  try {
    const connectionStats = await connectionService.healthCheck();
    const matchmakingStats = await matchmakingService.getQueueStats();

    const stats = {
      timestamp: new Date().toISOString(),
      worker: process.pid,
      connections: connectionStats.connections,
      rateLimit: connectionStats.rateLimit,
      matchmaking: {
        queues: matchmakingStats,
        activeMatches: matchmakingStats.activeMatches
      },
      // metrics: {
      //   totalConnectionsAllTime: metrics.totalConnections._hashMap.get(`worker:${process.pid}`)?.value || 0,
      //   currentActive: metrics.activeConnections._hashMap.get(`worker:${process.pid}`)?.value || 0,
      //   totalMatches: metrics.matchmakingSuccess._hashMap.get(`worker:${process.pid}`)?.value || 0,
      //   totalSignalingMessages: Array.from(metrics.signalingMessages._hashMap.values())
      //     .reduce((sum, entry) => sum + (entry.value || 0), 0)
      // }
    };

    res.json(stats);

  } catch (error) {
    logger.error('Connection stats request failed', {
      error: error.message,
      worker: process.pid
    });

    res.status(500).json({
      error: 'Failed to get connection stats',
      timestamp: new Date().toISOString(),
      worker: process.pid
    });
  }
});

// Performance metrics endpoint
router.get('/performance', (req, res) => {
  try {
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();

    const performance = {
      timestamp: new Date().toISOString(),
      worker: process.pid,
      memory: {
        rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
        heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
        heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
        external: `${Math.round(memUsage.external / 1024 / 1024)}MB`,
        heapUtilization: `${Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100)}%`
      },
      cpu: {
        user: cpuUsage.user,
        system: cpuUsage.system,
        total: cpuUsage.user + cpuUsage.system
      },
      uptime: {
        process: Math.floor(process.uptime()),
        system: Math.floor(require('os').uptime())
      },
      loadAverage: require('os').loadavg(),
      eventLoop: {
        // Event loop lag would need additional monitoring
        active: process._getActiveHandles().length,
        timers: process._getActiveRequests().length
      }
    };

    res.json(performance);

  } catch (error) {
    logger.error('Performance metrics request failed', {
      error: error.message,
      worker: process.pid
    });

    res.status(500).json({
      error: 'Failed to get performance metrics',
      timestamp: new Date().toISOString(),
      worker: process.pid
    });
  }
});

module.exports = router;