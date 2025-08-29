const client = require('prom-client');
const express = require('express');
const logger = require('../utils/logger');

// Collect default metrics
client.collectDefaultMetrics({
  gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5],
  eventLoopMonitoringPrecision: 10
});

// Custom metrics for WebRTC chat service
const metrics = {
  // Connection metrics
  activeConnections: new client.Gauge({
    name: 'webrtc_active_connections',
    help: 'Number of active Socket.IO connections',
    labelNames: ['worker']
  }),

  totalConnections: new client.Counter({
    name: 'webrtc_total_connections',
    help: 'Total number of connections established',
    labelNames: ['worker']
  }),

  sessionDuration: new client.Histogram({
    name: 'webrtc_session_duration_seconds',
    help: 'Duration of user sessions',
    buckets: [1, 5, 10, 30, 60, 300, 600, 1800, 3600],
    labelNames: ['worker']
  }),

  // Matchmaking metrics
  matchmakingDuration: new client.Histogram({
    name: 'webrtc_matchmaking_duration_seconds',
    help: 'Time taken for matchmaking',
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
    labelNames: ['worker']
  }),

  activeMatches: new client.Gauge({
    name: 'webrtc_active_matches',
    help: 'Number of active matches',
    labelNames: ['worker']
  }),

  matchmakingSuccess: new client.Counter({
    name: 'webrtc_matchmaking_success_total',
    help: 'Total successful matches created',
    labelNames: ['worker']
  }),

  matchDuration: new client.Histogram({
    name: 'webrtc_match_duration_seconds',
    help: 'Duration of matches',
    buckets: [1, 5, 10, 30, 60, 300, 600, 1800, 3600],
    labelNames: ['worker']
  }),

  queueSize: new client.Gauge({
    name: 'webrtc_queue_size',
    help: 'Size of matchmaking queues',
    labelNames: ['queue', 'worker']
  }),

  // Signaling metrics
  signalingMessages: new client.Counter({
    name: 'webrtc_signaling_messages_total',
    help: 'Total signaling messages processed',
    labelNames: ['type', 'worker']
  }),

  signalingLatency: new client.Histogram({
    name: 'webrtc_signaling_latency_seconds',
    help: 'Latency of signaling message processing',
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
    labelNames: ['type']
  }),

  webrtcConnections: new client.Gauge({
    name: 'webrtc_peer_connections',
    help: 'Number of active WebRTC peer connections',
    labelNames: ['worker']
  }),

  dataChannelMessages: new client.Counter({
    name: 'webrtc_data_channel_messages_total',
    help: 'Total data channel messages processed',
    labelNames: ['worker']
  }),

  // Infrastructure metrics
  redisConnections: new client.Counter({
    name: 'redis_connections_total',
    help: 'Total number of Redis client connections',
    labelNames: ['type', 'worker']
  }),

  redisOperationsDuration: new client.Histogram({
  name: 'redis_operation_duration_seconds',
  help: 'Redis operation duration',
  labelNames: ['operation'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1]
}),

  redisOperationsTotal: new client.Counter({
    name: 'redis_operations_total',
    help: 'Total Redis operations by type',
    labelNames: ['operation', 'worker']
  }),

  kafkaBatchSize: new client.Histogram({
    name: 'kafka_batch_size',
    help: 'Size of Kafka batches sent',
    buckets: [1, 5, 10, 25, 50, 100, 200, 500]
  }),

  // Error metrics
  errorRate: new client.Counter({
    name: 'webrtc_errors_total',
    help: 'Total errors by type',
    labelNames: ['type', 'worker']
  }),

  // Rate limiting metrics
  rateLimitHits: new client.Counter({
    name: 'webrtc_rate_limit_hits_total',
    help: 'Total rate limit hits',
    labelNames: ['worker']
  }),

  // Connection quality metrics
  connectionQuality: new client.Histogram({
    name: 'webrtc_connection_quality_rtt_ms',
    help: 'Connection quality measured by RTT',
    buckets: [10, 25, 50, 100, 200, 500, 1000, 2000],
    labelNames: ['worker']
  }),

  // Memory usage metrics
  memoryUsage: new client.Gauge({
    name: 'webrtc_memory_usage_bytes',
    help: 'Memory usage by type',
    labelNames: ['type', 'worker']
  })
};

// Update memory metrics periodically
setInterval(() => {
  const memUsage = process.memoryUsage();
  const worker = process.pid;
  
  metrics.memoryUsage.set({ type: 'rss', worker }, memUsage.rss);
  metrics.memoryUsage.set({ type: 'heapUsed', worker }, memUsage.heapUsed);
  metrics.memoryUsage.set({ type: 'heapTotal', worker }, memUsage.heapTotal);
  metrics.memoryUsage.set({ type: 'external', worker }, memUsage.external);
}, 10000); // Every 10 seconds

// Business metrics helper functions
const businessMetrics = {
  recordConnection: (userKey) => {
    metrics.totalConnections.inc({ worker: process.pid });
    metrics.activeConnections.inc({ worker: process.pid });
  },

  recordDisconnection: (sessionDurationSeconds) => {
    metrics.activeConnections.dec({ worker: process.pid });
    metrics.sessionDuration.observe({ worker: process.pid }, sessionDurationSeconds);
  },

  recordMatchmaking: (durationSeconds, success = true) => {
    metrics.matchmakingDuration.observe({ worker: process.pid }, durationSeconds);
    if (success) {
      metrics.matchmakingSuccess.inc({ worker: process.pid });
      metrics.activeMatches.inc({ worker: process.pid });
    }
  },

  recordMatchEnd: (durationSeconds) => {
    metrics.activeMatches.dec({ worker: process.pid });
    metrics.matchDuration.observe({ worker: process.pid }, durationSeconds);
  },

  recordSignaling: (signalType, latencySeconds = null) => {
    metrics.signalingMessages.inc({ type: signalType, worker: process.pid });
    if (latencySeconds !== null) {
      metrics.signalingLatency.observe({ type: signalType }, latencySeconds);
    }
  },

  recordError: (errorType) => {
    metrics.errorRate.inc({ type: errorType, worker: process.pid });
  },

  recordRedisOperation: (operation, durationSeconds) => {
    metrics.redisOperationsDuration.observe({ operation }, durationSeconds);
    metrics.redisOperationsTotal.inc({ operation, worker: process.pid });
  },

  recordKafkaBatch: (batchSize) => {
    metrics.kafkaBatchSize.observe(batchSize);
  },

  updateQueueSize: (queueType, size) => {
    metrics.queueSize.set({ queue: queueType, worker: process.pid }, size);
  },

  recordRateLimitHit: () => {
    metrics.rateLimitHits.inc({ worker: process.pid });
  },

  recordConnectionQuality: (rttMs) => {
    metrics.connectionQuality.observe({ worker: process.pid }, rttMs);
  }
};

// Express router for metrics endpoint
const router = express.Router();

router.get('/', async (req, res) => {
  try {
    res.set('Content-Type', client.register.contentType);
    const metricsData = await client.register.metrics();
    res.send(metricsData);
  } catch (error) {
    logger.error('Failed to generate metrics', {
      error: error.message,
      worker: process.pid
    });
    res.status(500).send('Failed to generate metrics');
  }
});

// Health metrics endpoint
router.get('/health', (req, res) => {
  try {
    const healthMetrics = {
      timestamp: Date.now(),
      worker: process.pid,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      connections: {
        active: getMetricValue(metrics.activeConnections, { worker: process.pid }) || 0,
        total: getMetricValue(metrics.totalConnections, { worker: process.pid }) || 0
      },
      matches: {
        active: getMetricValue(metrics.activeMatches, { worker: process.pid }) || 0,
        total: getMetricValue(metrics.matchmakingSuccess, { worker: process.pid }) || 0
      },
      errors: {
        total: getMetricValue(metrics.errorRate, { worker: process.pid }) || 0
      }
    };

    res.json(healthMetrics);
  } catch (error) {
    logger.error('Failed to generate health metrics', {
      error: error.message,
      worker: process.pid
    });
    res.status(500).json({ error: 'Failed to generate health metrics' });
  }
});

// Custom metrics endpoint for business intelligence
router.get('/business', (req, res) => {
  try {
    const businessData = {
      timestamp: Date.now(),
      worker: process.pid,
      connections: {
        active: getMetricValue(metrics.activeConnections, { worker: process.pid }) || 0,
        total: getMetricValue(metrics.totalConnections, { worker: process.pid }) || 0
      },
      matchmaking: {
        activeMatches: getMetricValue(metrics.activeMatches, { worker: process.pid }) || 0,
        successfulMatches: getMetricValue(metrics.matchmakingSuccess, { worker: process.pid }) || 0,
        avgMatchmakingTime: getHistogramAverage(metrics.matchmakingDuration) || 0
      },
      signaling: {
        totalMessages: getCounterValue(metrics.signalingMessages) || 0,
        avgLatency: getHistogramAverage(metrics.signalingLatency) || 0
      },
      quality: {
        avgSessionDuration: getHistogramAverage(metrics.sessionDuration) || 0,
        avgConnectionQuality: getHistogramAverage(metrics.connectionQuality) || 0
      },
      infrastructure: {
        errorRate: getCounterValue(metrics.errorRate) || 0,
        rateLimitHits: getMetricValue(metrics.rateLimitHits, { worker: process.pid }) || 0,
        // The original code was using 'metrics.redisOperations' which doesn't exist.
        // It's likely intended to use the redisOperationsDuration histogram.
        avgRedisLatency: getHistogramAverage(metrics.redisOperationsDuration) || 0
      }
    };

    res.json(businessData);
  } catch (error) {
    logger.error('Failed to generate business metrics', {
      error: error.message,
      worker: process.pid
    });
    res.status(500).json({ error: 'Failed to generate business metrics' });
  }
});

// Helper functions to extract metric values
function getMetricValue(metric, labels = {}) {
  try {
    if (metric._hashMap) {
      const key = Object.entries(labels)
        .map(([k, v]) => `${k}:${v}`)
        .join(',');
      return metric._hashMap.get(key)?.value || 0;
    }
    return metric.get?.() || 0;
  } catch (error) {
    return 0;
  }
}

function getCounterValue(counter) {
  try {
    let total = 0;
    if (counter._hashMap) {
      for (const entry of counter._hashMap.values()) {
        total += entry.value || 0;
      }
    }
    return total;
  } catch (error) {
    return 0;
  }
}

function getHistogramAverage(histogram) {
  try {
    // A simplified average calculation.
    // In a real production system, you would want to retrieve sum and count from the histogram data
    // to calculate the true average. The `prom-client` library makes this easy.
    const { sum, count } = histogram.get();
    return count > 0 ? sum / count : 0;
  } catch (error) {
    return 0;
  }
}

module.exports = {
  ...metrics,
  businessMetrics,
  router,
  register: client.register
};