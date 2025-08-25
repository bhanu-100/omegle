// server.js - Optimized for 100k concurrent users
require('dotenv').config();
const fs = require('fs');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { createClient } = require('redis');
const { createAdapter } = require('@socket.io/redis-adapter');
const { Kafka } = require('kafkajs');
const winston = require('winston');
const client = require('prom-client');
const cluster = require('cluster');
const os = require('os');

// ---------- Environment validation ----------
const {
  REDIS_URL,
  REDIS_CLUSTER_NODES, // comma-separated for Redis cluster
  CLIENT_URL,
  KAFKA_BROKERS,
  KAFKA_TOPIC_EVENTS,
  KAFKA_SSL_CA,
  KAFKA_SSL_KEY,
  KAFKA_SSL_CERT,
  PORT = 3000,
  LOG_LEVEL = 'info',
  NODE_ENV = 'production',
  CLUSTER_WORKERS = os.cpus().length,
  MAX_CONNECTIONS_PER_WORKER = 10000,
  RATE_LIMIT_WINDOW_MS = 60000,
  RATE_LIMIT_MAX_REQUESTS = 100,
  REDIS_POOL_SIZE = 10,
  SOCKET_IO_TRANSPORTS = 'websocket,polling'
} = process.env;

if (!REDIS_URL && !REDIS_CLUSTER_NODES) {
  console.error('REDIS_URL or REDIS_CLUSTER_NODES is required');
  process.exit(1);
}

// ---------- Cluster setup for horizontal scaling ----------
if (cluster.isMaster && NODE_ENV === 'production') {
  console.log(`Master ${process.pid} is running`);
  
  // Fork workers
  for (let i = 0; i < CLUSTER_WORKERS; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.log(`Worker ${worker.process.pid} died. Restarting...`);
    cluster.fork();
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('Master received SIGTERM, shutting down workers...');
    for (const id in cluster.workers) {
      cluster.workers[id].kill('SIGTERM');
    }
  });

  return; // Exit master process, only workers continue
}

// ---------- Worker process ----------
console.log(`Worker ${process.pid} started`);

// ---------- High-performance logger ----------
const logger = winston.createLogger({
  level: LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      handleExceptions: true,
      handleRejections: true,
      silent: NODE_ENV === 'test'
    })
  ],
  exitOnError: false
});

// ---------- Enhanced Prometheus metrics ----------
client.collectDefaultMetrics({ gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5] });

const metrics = {
  activeConnections: new client.Gauge({
    name: 'active_connections',
    help: 'Number of active Socket.IO connections',
    labelNames: ['worker']
  }),
  matchmakingDuration: new client.Histogram({
    name: 'matchmaking_duration_seconds',
    help: 'Time taken for matchmaking',
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5]
  }),
  signalingMessages: new client.Counter({
    name: 'signaling_messages_total',
    help: 'Total signaling messages processed',
    labelNames: ['type', 'worker']
  }),
  redisOperations: new client.Histogram({
    name: 'redis_operation_duration_seconds',
    help: 'Redis operation duration',
    labelNames: ['operation'],
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1]
  }),
  errorRate: new client.Counter({
    name: 'errors_total',
    help: 'Total errors',
    labelNames: ['type', 'worker']
  })
};

// ---------- Updated RedisPool class with better error handling ----------
class RedisPool {
  constructor(config, poolSize = parseInt(REDIS_POOL_SIZE) || 10) {
    this.config = config;
    this.poolSize = poolSize;
    this.pool = [];
    this.currentIndex = 0;
  }

  async init() {
    logger.info('Initializing Redis pool', { poolSize: this.poolSize, worker: process.pid });
    
    for (let i = 0; i < this.poolSize; i++) {
      try {
        const client = createClient(this.config);
        
        client.on('error', (err) => {
          logger.error('Redis pool client error', { 
            err: err?.message || err,
            code: err?.code,
            clientIndex: i,
            worker: process.pid 
          });
          metrics.errorRate.inc({ type: 'redis_pool', worker: process.pid });
        });

        client.on('connect', () => {
          logger.debug('Redis pool client connected', { clientIndex: i, worker: process.pid });
        });

        await client.connect();
        this.pool.push(client);
        logger.debug('Redis pool client initialized', { clientIndex: i, worker: process.pid });
      } catch (err) {
        logger.error('Failed to initialize Redis pool client', { 
          err: err?.message || err,
          clientIndex: i,
          worker: process.pid 
        });
        throw err;
      }
    }
    
    logger.info('Redis pool initialization complete', { 
      poolSize: this.pool.length, 
      worker: process.pid 
    });
  }

  getClient() {
    if (this.pool.length === 0) {
      throw new Error('Redis pool is empty');
    }
    
    const client = this.pool[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.poolSize;
    return client;
  }

  async quit() {
    logger.info('Closing Redis pool connections', { worker: process.pid });
    await Promise.all(this.pool.map(async (client, index) => {
      try {
        await client.quit();
        logger.debug('Redis pool client closed', { clientIndex: index, worker: process.pid });
      } catch (err) {
        logger.error('Error closing Redis pool client', { 
          err: err?.message || err,
          clientIndex: index,
          worker: process.pid 
        });
      }
    }));
  }
}

// ---------- Enhanced Redis setup with clustering support ----------
let redisConfig;
if (REDIS_CLUSTER_NODES && REDIS_CLUSTER_NODES.trim() !== '') {
  // Redis Cluster configuration
  const nodes = REDIS_CLUSTER_NODES.split(',').map(node => {
    const [host, port] = node.trim().split(':');
    return { host, port: parseInt(port) };
  });
  
  redisConfig = {
    cluster: {
      enableReadyCheck: false,
      redisOptions: {
        password: process.env.REDIS_PASSWORD,
      }
    },
    socket: {
      keepAlive: true,
      reconnectDelay: 1000,
      connectTimeout: 10000,
      commandTimeout: 5000
    }
  };
  
  logger.info('Using Redis Cluster configuration', { nodes, worker: process.pid });
} else if (REDIS_URL) {
  // Single Redis instance
  redisConfig = {
    url: REDIS_URL,
    socket: {
      keepAlive: true,
      reconnectDelay: 1000,
      connectTimeout: 10000,
      commandTimeout: 5000
    }
  };
  
  logger.info('Using Single Redis instance', { url: REDIS_URL.replace(/:([^:@]+)@/, ':****@'), worker: process.pid });
} else {
  logger.error('No Redis configuration found. Please set REDIS_URL or REDIS_CLUSTER_NODES');
  process.exit(1);
}

// Create Redis clients
const pubClient = createClient(redisConfig);
const subClient = pubClient.duplicate();
const redisPool = new RedisPool(redisConfig);

// Enhanced Redis error handlers with more context
pubClient.on('error', (err) => {
  logger.error('Redis pubClient error', { 
    err: err?.message || err, 
    code: err?.code,
    worker: process.pid 
  });
  metrics.errorRate.inc({ type: 'redis_pub', worker: process.pid });
});

subClient.on('error', (err) => {
  logger.error('Redis subClient error', { 
    err: err?.message || err,
    code: err?.code, 
    worker: process.pid 
  });
  metrics.errorRate.inc({ type: 'redis_sub', worker: process.pid });
});

// Add connection event handlers for better debugging
pubClient.on('connect', () => {
  logger.info('Redis pubClient connected', { worker: process.pid });
});

subClient.on('connect', () => {
  logger.info('Redis subClient connected', { worker: process.pid });
});

pubClient.on('ready', () => {
  logger.info('Redis pubClient ready', { worker: process.pid });
});

subClient.on('ready', () => {
  logger.info('Redis subClient ready', { worker: process.pid });
});

// ---------- Optimized Kafka setup ----------
let kafkaConnected = false;
let producer = null;
let kafkaReconnectTimer = null;

if (KAFKA_BROKERS) {
  const kafkaConfig = {
    clientId: `webrtc-chat-service-${process.pid}`,
    brokers: KAFKA_BROKERS.split(',').map(s => s.trim()),
    retry: {
      retries: 10,
      factor: 2,
      multiplier: 2,
      maxRetryTime: 30000
    },
    connectionTimeout: 10000,
    requestTimeout: 30000
  };

  if (KAFKA_SSL_CA && KAFKA_SSL_KEY && KAFKA_SSL_CERT) {
    kafkaConfig.ssl = {
      rejectUnauthorized: false, // Adjust based on your SSL setup
      ca: [fs.readFileSync(KAFKA_SSL_CA, 'utf8')],
      key: fs.readFileSync(KAFKA_SSL_KEY, 'utf8'),
      cert: fs.readFileSync(KAFKA_SSL_CERT, 'utf8')
    };
  }

  const kafka = new Kafka(kafkaConfig);
  producer = kafka.producer({
    maxInFlightRequests: 1,
    idempotent: true,
    transactionTimeout: 30000,
    allowAutoTopicCreation: false
  });

  const connectKafka = async () => {
    try {
      await producer.connect();
      kafkaConnected = true;
      logger.info('Connected to Kafka brokers', { worker: process.pid });
      
      if (kafkaReconnectTimer) {
        clearInterval(kafkaReconnectTimer);
        kafkaReconnectTimer = null;
      }
    } catch (err) {
      kafkaConnected = false;
      logger.error('Kafka connection error', { 
        err: err?.message || err, 
        worker: process.pid 
      });
      metrics.errorRate.inc({ type: 'kafka', worker: process.pid });
      
      // Retry connection every 30 seconds
      if (!kafkaReconnectTimer) {
        kafkaReconnectTimer = setInterval(connectKafka, 30000);
      }
    }
  };

  connectKafka();
}

// ---------- Batched Kafka logging for performance ----------
const kafkaBatch = [];
const KAFKA_BATCH_SIZE = 100;
const KAFKA_BATCH_TIMEOUT = 1000;

async function logEventToKafka(topic, event) {
  if (!producer || !kafkaConnected) return;
  
  kafkaBatch.push({
    topic: topic || KAFKA_TOPIC_EVENTS || 'user-events',
    messages: [{
      key: event.userIP || null,
      value: JSON.stringify({ 
        ...event, 
        timestamp: Date.now(),
        worker: process.pid 
      })
    }]
  });

  if (kafkaBatch.length >= KAFKA_BATCH_SIZE) {
    await flushKafkaBatch();
  }
}

async function flushKafkaBatch() {
  if (kafkaBatch.length === 0 || !kafkaConnected) return;
  
  const batch = kafkaBatch.splice(0);
  try {
    await producer.sendBatch({ topicMessages: batch });
  } catch (err) {
    logger.error('Failed to send Kafka batch', { 
      err: err?.message || err,
      batchSize: batch.length,
      worker: process.pid 
    });
    metrics.errorRate.inc({ type: 'kafka_batch', worker: process.pid });
  }
}

// Periodic flush
setInterval(flushKafkaBatch, KAFKA_BATCH_TIMEOUT);

// ---------- Rate limiting ----------
const rateLimitMap = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const key = ip;
  const windowStart = now - parseInt(RATE_LIMIT_WINDOW_MS);
  
  if (!rateLimitMap.has(key)) {
    rateLimitMap.set(key, []);
  }
  
  const requests = rateLimitMap.get(key);
  // Clean old requests
  while (requests.length > 0 && requests[0] < windowStart) {
    requests.shift();
  }
  
  if (requests.length >= parseInt(RATE_LIMIT_MAX_REQUESTS)) {
    return true;
  }
  
  requests.push(now);
  return false;
}

// Clean up rate limit map periodically
setInterval(() => {
  const now = Date.now();
  const windowStart = now - parseInt(RATE_LIMIT_WINDOW_MS);
  
  for (const [key, requests] of rateLimitMap.entries()) {
    while (requests.length > 0 && requests[0] < windowStart) {
      requests.shift();
    }
    if (requests.length === 0) {
      rateLimitMap.delete(key);
    }
  }
}, parseInt(RATE_LIMIT_WINDOW_MS));

// ---------- Express setup with optimizations ----------
const app = express();

// Trust proxy for proper IP detection
app.set('trust proxy', true);

// Security and performance middleware
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

const server = http.createServer(app);

// Tune server for high concurrency
server.maxConnections = parseInt(MAX_CONNECTIONS_PER_WORKER);

// Health check endpoint
app.get('/health', async (req, res) => {
  const startTime = process.hrtime.bigint();
  
  try {
    // Quick Redis ping
    const redisClient = redisPool.getClient();
    await redisClient.ping();
    
    const endTime = process.hrtime.bigint();
    const duration = Number(endTime - startTime) / 1000000; // Convert to milliseconds
    
    res.json({
      status: 'UP',
      worker: process.pid,
      redis: 'ok',
      kafka: kafkaConnected ? 'ok' : 'disconnected',
      responseTime: `${duration.toFixed(2)}ms`,
      connections: metrics.activeConnections._hashMap.get('worker:' + process.pid)?.value || 0,
      uptime: process.uptime(),
      memory: process.memoryUsage()
    });
  } catch (err) {
    logger.error('Health check failed', { err: err?.message || err, worker: process.pid });
    res.status(500).json({
      status: 'DOWN',
      worker: process.pid,
      error: err?.message || err
    });
  }
});

// Metrics endpoint
app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', client.register.contentType);
    res.end(await client.register.metrics());
  } catch (err) {
    logger.error('Metrics error', { err: err?.message || err });
    res.status(500).send('Metrics error');
  }
});

// ---------- Constants ----------
const MATCH_QUEUE = 'wait_queue';
const SOCKET_MAP = 'socket_map';
const MATCH_MAP = 'match_map';
const USER_STATS = 'user_stats';

// ---------- Optimized Redis operations ----------
async function redisOperation(operation, ...args) {
  const timer = metrics.redisOperations.startTimer({ operation: operation.name });
  try {
    const client = redisPool.getClient();
    const result = await client[operation](...args);
    timer();
    return result;
  } catch (err) {
    timer();
    metrics.errorRate.inc({ type: 'redis_operation', worker: process.pid });
    throw err;
  }
}

// ---------- Main initialization ----------
(async function init() {
  try {
    // Initialize Redis connections
    await pubClient.connect();
    await subClient.connect();
    await redisPool.init();
    
    logger.info('Connected to Redis', { worker: process.pid });

    // Create Socket.IO with optimizations
    const io = socketIo(server, {
      cors: { 
        origin: CLIENT_URL || '*', 
        methods: ['GET', 'POST'],
        credentials: false
      },
      transports: SOCKET_IO_TRANSPORTS.split(','),
      maxHttpBufferSize: 1e6,
      pingTimeout: 60000,
      pingInterval: 25000,
      upgradeTimeout: 10000,
      allowEIO3: true,
      cookie: false,
      serveClient: false
    });

    // Set Redis adapter
    io.adapter(createAdapter(pubClient, subClient, {
      key: 'socket.io',
      requestsTimeout: 5000
    }));

    logger.info('Socket.IO initialized', { worker: process.pid });

    // Connection handler with optimizations
    io.on('connection', (socket) => {
      const userIP = (
        socket.handshake.headers['x-forwarded-for'] ||
        socket.handshake.headers['x-real-ip'] ||
        socket.conn.remoteAddress ||
        socket.handshake.address
      )?.toString().split(',')[0]?.trim() || 'unknown';

      // Rate limiting
      if (isRateLimited(userIP)) {
        logger.warn('Rate limit exceeded', { userIP, worker: process.pid });
        socket.emit('rate_limited');
        socket.disconnect(true);
        return;
      }

      logger.info('User connected', { userIP, socketId: socket.id, worker: process.pid });
      
      metrics.activeConnections.inc({ worker: process.pid });
      metrics.signalingMessages.inc({ type: 'connect', worker: process.pid });

      // Store socket mapping with TTL
      redisOperation('hSet', SOCKET_MAP, userIP, socket.id)
        .then(() => redisOperation('expire', SOCKET_MAP, 3600)) // 1 hour TTL
        .catch(err => logger.error('Socket mapping error', { err: err?.message || err }));

      // Log connection
      logEventToKafka(KAFKA_TOPIC_EVENTS, { 
        type: 'connect', 
        userIP, 
        socketId: socket.id 
      });

      // Optimized matchmaking
      socket.on('find_match', async () => {
        const matchTimer = metrics.matchmakingDuration.startTimer();
        
        try {
          // Remove duplicates and pop a peer atomically
          const pipeline = redisPool.getClient().multi();
          pipeline.lRem(MATCH_QUEUE, 0, userIP);
          pipeline.lPop(MATCH_QUEUE);
          const [, peerIP] = await pipeline.exec();

          if (peerIP && peerIP !== userIP) {
            const roomId = `room-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
            
            // Set matches atomically
            const matchPipeline = redisPool.getClient().multi();
            matchPipeline.hSet(MATCH_MAP, userIP, peerIP);
            matchPipeline.hSet(MATCH_MAP, peerIP, userIP);
            matchPipeline.hSet(USER_STATS, `${userIP}:matches`, Date.now());
            matchPipeline.hSet(USER_STATS, `${peerIP}:matches`, Date.now());
            await matchPipeline.exec();

            socket.join(roomId);
            
            const peerSocketId = await redisOperation('hGet', SOCKET_MAP, peerIP);
            if (peerSocketId) {
              io.to(peerSocketId).socketsJoin(roomId);
              
              // Notify both users
              const matchData = { roomId, peerIP };
              socket.emit('match_found', matchData);
              io.to(peerSocketId).emit('match_found', { roomId, peerIP: userIP });
              
              logger.info('Match created', { userIP, peerIP, roomId, worker: process.pid });
            } else {
              // Peer offline, re-queue current user
              await redisOperation('rPush', MATCH_QUEUE, userIP);
              socket.emit('waiting');
            }

            logEventToKafka(KAFKA_TOPIC_EVENTS, { 
              type: 'match', 
              userIP, 
              peerIP, 
              roomId 
            });
          } else {
            // Add to queue
            await redisOperation('rPush', MATCH_QUEUE, userIP);
            socket.emit('waiting');
            logger.debug('Added to queue', { userIP, worker: process.pid });
          }
        } catch (err) {
          logger.error('Matchmaking error', { 
            err: err?.message || err, 
            userIP, 
            worker: process.pid 
          });
          metrics.errorRate.inc({ type: 'matchmaking', worker: process.pid });
          socket.emit('error', { message: 'Matchmaking failed' });
        } finally {
          matchTimer();
        }
      });

      // Optimized signaling forwarder
      const forwardToPeer = async (eventName, incomingData) => {
        try {
          const peerIP = await redisOperation('hGet', MATCH_MAP, userIP);
          if (!peerIP) {
            logger.debug('No peer found', { eventName, userIP });
            return;
          }

          const peerSocketId = await redisOperation('hGet', SOCKET_MAP, peerIP);
          if (!peerSocketId) {
            logger.debug('Peer socket not found', { peerIP });
            return;
          }

          // Efficient payload handling
          const payload = { 
            ...incomingData, 
            from: userIP,
            timestamp: Date.now()
          };

          io.to(peerSocketId).emit(eventName, payload);
          
          metrics.signalingMessages.inc({ type: eventName, worker: process.pid });
          
          // Async logging
          logEventToKafka(KAFKA_TOPIC_EVENTS, { 
            type: eventName, 
            userIP, 
            peerIP 
          });
        } catch (err) {
          logger.error('Signal forwarding error', { 
            err: err?.message || err, 
            eventName, 
            userIP,
            worker: process.pid 
          });
          metrics.errorRate.inc({ type: 'signaling', worker: process.pid });
        }
      };

      // WebRTC signaling events
      socket.on('webrtc_offer', (data) => forwardToPeer('webrtc_offer', data));
      socket.on('webrtc_answer', (data) => forwardToPeer('webrtc_answer', data));
      socket.on('webrtc_ice_candidate', (data) => forwardToPeer('webrtc_ice_candidate', data));

      socket.on('webrtc_error', (err) => {
        logger.error('WebRTC error from client', { userIP, err, worker: process.pid });
        metrics.errorRate.inc({ type: 'webrtc_client', worker: process.pid });
        logEventToKafka(KAFKA_TOPIC_EVENTS, { type: 'webrtc_error', userIP, err });
      });

      // Optimized disconnect handler
      socket.on('disconnect', async (reason) => {
        try {
          logger.info('User disconnected', { userIP, reason, worker: process.pid });
          
          // Atomic cleanup
          const pipeline = redisPool.getClient().multi();
          pipeline.hGet(MATCH_MAP, userIP);
          pipeline.hDel(MATCH_MAP, userIP);
          pipeline.hDel(SOCKET_MAP, userIP);
          pipeline.lRem(MATCH_QUEUE, 0, userIP);
          const [peerIPResult] = await pipeline.exec();
          const peerIP = peerIPResult?.[1];

          if (peerIP) {
            await redisOperation('hDel', MATCH_MAP, peerIP);
            const peerSocketId = await redisOperation('hGet', SOCKET_MAP, peerIP);
            if (peerSocketId) {
              io.to(peerSocketId).emit('peer_disconnected', { peerIP: userIP });
            }
          }

          metrics.activeConnections.dec({ worker: process.pid });
          metrics.signalingMessages.inc({ type: 'disconnect', worker: process.pid });
          
          logEventToKafka(KAFKA_TOPIC_EVENTS, { 
            type: 'disconnect', 
            userIP, 
            reason 
          });
        } catch (err) {
          logger.error('Disconnect handler error', { 
            err: err?.message || err,
            userIP,
            worker: process.pid 
          });
          metrics.errorRate.inc({ type: 'disconnect', worker: process.pid });
        }
      });

      socket.on('error', (err) => {
        logger.error('Socket error', { 
          userIP, 
          err: err?.message || err,
          worker: process.pid 
        });
        metrics.errorRate.inc({ type: 'socket', worker: process.pid });
      });
    });

    // Start server
    server.listen(PORT, () => {
      logger.info(`Worker ${process.pid} listening on port ${PORT}`);
    });

    // Graceful shutdown
    const gracefulShutdown = async (signal) => {
      logger.info(`Worker ${process.pid} received ${signal}, shutting down gracefully...`);
      
      // Stop accepting new connections
      server.close(async () => {
        try {
          // Flush remaining Kafka messages
          await flushKafkaBatch();
          
          // Disconnect Kafka
          if (producer && kafkaConnected) {
            await producer.disconnect();
          }
          
          // Close Redis connections
          await redisPool.quit();
          await pubClient.quit();
          await subClient.quit();
          
          logger.info(`Worker ${process.pid} shut down complete`);
          process.exit(0);
        } catch (err) {
          logger.error('Shutdown error', { 
            err: err?.message || err,
            worker: process.pid 
          });
          process.exit(1);
        }
      });

      // Force shutdown after timeout
      setTimeout(() => {
        logger.warn(`Worker ${process.pid} forcing shutdown`);
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  } catch (err) {
    logger.error('Fatal initialization error', { 
      err: err?.message || err,
      worker: process.pid 
    });
    process.exit(1);
  }
})();