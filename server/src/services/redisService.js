const { createClient } = require('redis');
const logger = require('../utils/logger');
const metrics = require('../monitoring/metrics');

class RedisService {
  constructor() {
    this.pubClient = null;
    this.subClient = null;
    this.pool = [];
    this.poolSize = parseInt(process.env.REDIS_POOL_SIZE) || 8;
    this.currentIndex = 0;
    this.isInitialized = false;
    this.circuitBreaker = new CircuitBreaker('redis', 5, 30000);
  }

  async init() {
    if (this.isInitialized) {
      return;
    }

    try {
      const config = this.getRedisConfig();
      
      // Create pub/sub clients
      this.pubClient = createClient(config);
      this.subClient = this.pubClient.duplicate();

      // Setup error handlers
      this.setupErrorHandlers();

      // Connect pub/sub clients
      await this.pubClient.connect();
      await this.subClient.connect();

      // Initialize connection pool
      await this.initializePool(config);

      this.isInitialized = true;
      logger.info('Redis service initialized', {
        poolSize: this.poolSize,
        worker: process.pid
      });

    } catch (error) {
      logger.error('Failed to initialize Redis service', {
        error: error.message,
        worker: process.pid
      });
      throw error;
    }
  }

  getRedisConfig() {
    const config = {
      url: process.env.REDIS_URL,
      socket: {
        keepAlive: true,
        reconnectDelay: 1000,
        connectTimeout: 10000,
        commandTimeout: 5000
      },
      retry: {
        retries: 3,
        delay: (attempt) => Math.min(attempt * 100, 3000)
      }
    };

    if (process.env.REDIS_PASSWORD) {
      config.password = process.env.REDIS_PASSWORD;
    }

    return config;
  }

  setupErrorHandlers() {
    this.pubClient.on('error', (err) => {
      logger.error('Redis pubClient error', {
        error: err.message,
        code: err.code,
        worker: process.pid
      });
      metrics.errorRate.inc({ type: 'redis_pub', worker: process.pid });
    });

    this.subClient.on('error', (err) => {
      logger.error('Redis subClient error', {
        error: err.message,
        code: err.code,
        worker: process.pid
      });
      metrics.errorRate.inc({ type: 'redis_sub', worker: process.pid });
    });

    this.pubClient.on('connect', () => {
      logger.info('Redis pubClient connected', { worker: process.pid });
    });

    this.subClient.on('connect', () => {
      logger.info('Redis subClient connected', { worker: process.pid });
    });
  }

  async initializePool(config) {
    logger.info('Initializing Redis connection pool', {
      poolSize: this.poolSize,
      worker: process.pid
    });

    for (let i = 0; i < this.poolSize; i++) {
      try {
        const client = createClient(config);
        
        client.on('error', (err) => {
          logger.error('Redis pool client error', {
            error: err.message,
            clientIndex: i,
            worker: process.pid
          });
          metrics.errorRate.inc({ type: 'redis_pool', worker: process.pid });
        });

        await client.connect();
        this.pool.push(client);
        
        logger.debug('Redis pool client initialized', {
          clientIndex: i,
          worker: process.pid
        });
      } catch (error) {
        logger.error('Failed to initialize Redis pool client', {
          error: error.message,
          clientIndex: i,
          worker: process.pid
        });
        throw error;
      }
    }

    logger.info('Redis connection pool initialized', {
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

  getClients() {
    return {
      pubClient: this.pubClient,
      subClient: this.subClient
    };
  }

  async safeOperation(operationName, ...args) {
    return this.circuitBreaker.execute(async () => {
      const timer = metrics.redisOperations.startTimer({ operation: operationName });
      
      try {
        const client = this.getClient();
        const result = await client[operationName](...args);
        timer();
        return result;
      } catch (error) {
        timer();
        metrics.errorRate.inc({ type: 'redis_operation', worker: process.pid });
        throw error;
      }
    });
  }

  async batchOperation(operations) {
    return this.circuitBreaker.execute(async () => {
      const timer = metrics.redisOperations.startTimer({ operation: 'batch' });
      
      try {
        const client = this.getClient();
        const pipeline = client.multi();
        
        operations.forEach(({ method, args }) => {
          pipeline[method](...args);
        });
        
        const result = await pipeline.exec();
        timer();
        return result;
      } catch (error) {
        timer();
        metrics.errorRate.inc({ type: 'redis_batch', worker: process.pid });
        throw error;
      }
    });
  }

  // High-level operations
  async setSocketMapping(userKey, socketId) {
    const ttl = parseInt(process.env.REDIS_TTL_SOCKET_MAP) || 7200;
    return this.batchOperation([
      { method: 'hSet', args: ['socket_map', userKey, socketId] },
      { method: 'expire', args: ['socket_map', ttl] }
    ]);
  }

  async getSocketId(userKey) {
    return this.safeOperation('hGet', 'socket_map', userKey);
  }

  async deleteSocketMapping(userKey) {
    return this.safeOperation('hDel', 'socket_map', userKey);
  }

  async setMatch(userKey1, userKey2, roomId) {
    const ttl = parseInt(process.env.REDIS_TTL_MATCH_MAP) || 3600;
    return this.batchOperation([
      { method: 'hSet', args: ['match_map', userKey1, userKey2] },
      { method: 'hSet', args: ['match_map', userKey2, userKey1] },
      { method: 'hSet', args: ['room_map', userKey1, roomId] },
      { method: 'hSet', args: ['room_map', userKey2, roomId] },
      { method: 'expire', args: ['match_map', ttl] },
      { method: 'expire', args: ['room_map', ttl] }
    ]);
  }

  async getMatch(userKey) {
    return this.safeOperation('hGet', 'match_map', userKey);
  }

  async deleteMatch(userKey) {
    return this.batchOperation([
      { method: 'hDel', args: ['match_map', userKey] },
      { method: 'hDel', args: ['room_map', userKey] }
    ]);
  }

  async addToQueue(queueName, userKey) {
    return this.safeOperation('rPush', queueName, userKey);
  }

  async getFromQueue(queueName) {
    return this.safeOperation('lPop', queueName);
  }

  async removeFromQueue(queueName, userKey) {
    return this.safeOperation('lRem', queueName, 0, userKey);
  }

  async getQueueLength(queueName) {
    return this.safeOperation('lLen', queueName);
  }

  async updateUserStats(userKey, stats) {
    const ttl = parseInt(process.env.REDIS_TTL_USER_STATS) || 172800;
    const operations = Object.entries(stats).map(([key, value]) => ({
      method: 'hSet',
      args: ['user_stats', `${userKey}:${key}`, value]
    }));
    
    operations.push({ method: 'expire', args: ['user_stats', ttl] });
    return this.batchOperation(operations);
  }

  async ping() {
    return this.safeOperation('ping');
  }

  async shutdown() {
    if (!this.isInitialized) {
      return;
    }

    logger.info('Shutting down Redis service', { worker: process.pid });

    try {
      // Close pool connections
      await Promise.all(this.pool.map(async (client, index) => {
        try {
          await client.quit();
          logger.debug('Redis pool client closed', {
            clientIndex: index,
            worker: process.pid
          });
        } catch (error) {
          logger.error('Error closing Redis pool client', {
            error: error.message,
            clientIndex: index,
            worker: process.pid
          });
        }
      }));

      // Close pub/sub clients
      if (this.pubClient) {
        await this.pubClient.quit();
      }
      if (this.subClient) {
        await this.subClient.quit();
      }

      this.isInitialized = false;
      logger.info('Redis service shut down', { worker: process.pid });

    } catch (error) {
      logger.error('Error shutting down Redis service', {
        error: error.message,
        worker: process.pid
      });
      throw error;
    }
  }
}

// Circuit Breaker implementation
class CircuitBreaker {
  constructor(name, threshold = 5, timeout = 60000) {
    this.name = name;
    this.threshold = threshold;
    this.timeout = timeout;
    this.failureCount = 0;
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.nextAttempt = Date.now();
  }

  async execute(fn) {
    if (this.state === 'OPEN') {
      if (Date.now() < this.nextAttempt) {
        throw new Error(`Circuit breaker ${this.name} is OPEN`);
      }
      this.state = 'HALF_OPEN';
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  onSuccess() {
    this.failureCount = 0;
    this.state = 'CLOSED';
  }

  onFailure() {
    this.failureCount++;
    if (this.failureCount >= this.threshold) {
      this.state = 'OPEN';
      this.nextAttempt = Date.now() + this.timeout;
    }
  }
}

module.exports = new RedisService();