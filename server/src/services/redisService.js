const Redis = require('ioredis');
const logger = require('../utils/logger');
const metrics = require('../monitoring/metrics');

class RedisService {
  constructor() {
    this.client = null;
    this.pubClient = null;
    this.subClient = null;
    this.isConnected = false;
    this.retryDelayOnFailover = 100;
    this.maxRetriesPerRequest = 3;
    this.scripts = new Map(); // Cache for Lua scripts
    this.lockValues = new Map(); // Track lock values for proper cleanup
  }

  async init() {
    try {
      // IMPROVED: Better Redis URL parsing
      const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
      let redisConfig;

      try {
        const parsed = new URL(redisUrl);
        redisConfig = {
          host: parsed.hostname || 'localhost',
          port: parsed.port ? parseInt(parsed.port) : 6379,
          password: process.env.REDIS_PASSWORD || parsed.password || undefined,
          db: parseInt(process.env.REDIS_DB) || (parsed.pathname ? parseInt(parsed.pathname.slice(1)) : 0)
        };
      } catch (urlError) {
        // Fallback for non-URL format
        logger.warn('Failed to parse Redis URL, using defaults', { error: urlError.message });
        redisConfig = {
          host: process.env.REDIS_HOST || 'localhost',
          port: parseInt(process.env.REDIS_PORT) || 6379,
          password: process.env.REDIS_PASSWORD || undefined,
          db: parseInt(process.env.REDIS_DB) || 0
        };
      }

      // Enhanced connection settings
      const enhancedConfig = {
        ...redisConfig,
        connectTimeout: 10000,
        lazyConnect: true,
        maxRetriesPerRequest: this.maxRetriesPerRequest,
        retryDelayOnFailover: this.retryDelayOnFailover,
        enableReadyCheck: true,
        maxLoadingTimeout: 5000,
        keepAlive: 30000,
        family: 4,

        // Retry strategy
        retryStrategy: (times) => {
          const delay = Math.min(times * 50, 2000);
          logger.debug(`Redis retry attempt ${times}, delay: ${delay}ms`);
          return delay;
        },

        // Sentinel support
        sentinels: process.env.REDIS_SENTINELS
          ? process.env.REDIS_SENTINELS.split(',').map(s => {
              const [host, port] = s.trim().split(':');
              return { host, port: parseInt(port) || 26379 };
            })
          : undefined,
        name: process.env.REDIS_SENTINEL_NAME || 'mymaster'
      };

      // Initialize clients
      this.client = new Redis(enhancedConfig);
      this.pubClient = new Redis({
        ...enhancedConfig,
        db: parseInt(process.env.REDIS_PUBSUB_DB) || enhancedConfig.db
      });
      this.subClient = new Redis({
        ...enhancedConfig,
        db: parseInt(process.env.REDIS_PUBSUB_DB) || enhancedConfig.db
      });

      // Event handlers
      this.setupEventHandlers();

      // Connect all clients
      await Promise.all([
        this.client.connect(),
        this.pubClient.connect(),
        this.subClient.connect()
      ]);

      // Load Lua scripts
      await this.loadScripts();

      this.isConnected = true;
      logger.info('Redis service initialized successfully', {
        host: enhancedConfig.host,
        port: enhancedConfig.port,
        db: enhancedConfig.db,
        worker: process.pid
      });

    } catch (error) {
      logger.error('Failed to initialize Redis service', {
        error: error.message,
        stack: error.stack,
        worker: process.pid
      });
      throw error;
    }
  }

  setupEventHandlers() {
    // Main client events
    this.client.on('connect', () => {
      logger.info('Redis main client connected');
      this.isConnected = true;
    });

    this.client.on('error', (error) => {
      logger.error('Redis main client error', { error: error.message });
      this.isConnected = false;
    });

    this.client.on('reconnecting', () => {
      logger.warn('Redis main client reconnecting');
    });

    this.client.on('ready', () => {
      logger.info('Redis main client ready');
      this.isConnected = true;
    });

    // Pub client events
    this.pubClient.on('connect', () => {
      logger.info('Redis pub client connected');
    });

    this.pubClient.on('error', (error) => {
      logger.error('Redis pub client error', { error: error.message });
    });

    // Sub client events
    this.subClient.on('connect', () => {
      logger.info('Redis sub client connected');
    });

    this.subClient.on('error', (error) => {
      logger.error('Redis sub client error', { error: error.message });
    });

    this.subClient.on('ready', () => {
      logger.info('Redis sub client ready');
    });
  }

  async loadScripts() {
    // Atomic match creation script
    const createMatchScript = `
      local user1 = ARGV[1]
      local user2 = ARGV[2]
      local matchData = ARGV[3]
      
      -- Check if both users are still available
      local user1Session = redis.call('EXISTS', 'user_session:' .. user1)
      local user2Session = redis.call('EXISTS', 'user_session:' .. user2)
      
      if user1Session == 0 or user2Session == 0 then
        return 0  -- One or both users not available
      end
      
      -- Check if either user is already in a match
      local user1Match = redis.call('GET', 'user_match:' .. user1)
      local user2Match = redis.call('GET', 'user_match:' .. user2)
      
      if user1Match or user2Match then
        return 0  -- One or both users already matched
      end
      
      -- Create the match atomically
      redis.call('SET', 'user_match:' .. user1, matchData, 'EX', 3600)
      redis.call('SET', 'user_match:' .. user2, matchData, 'EX', 3600)
      redis.call('SADD', 'active_matches', user1 .. ':' .. user2)
      
      return 1  -- Success
    `;

    // Queue operations script
    const queueOperationsScript = `
      local operation = ARGV[1]
      local queueName = ARGV[2]
      local data = ARGV[3]
      
      if operation == 'ADD' then
        return redis.call('RPUSH', queueName, data)
      elseif operation == 'GET' then
        return redis.call('LPOP', queueName)
      elseif operation == 'LENGTH' then
        return redis.call('LLEN', queueName)
      elseif operation == 'REMOVE' then
        return redis.call('LREM', queueName, 0, data)
      else
        return 0
      end
    `;

    // Distributed lock script
    const lockScript = `
      local key = KEYS[1]
      local value = ARGV[1]
      local ttl = tonumber(ARGV[2])
      
      local current = redis.call('GET', key)
      if current == false then
        redis.call('SET', key, value, 'PX', ttl)
        return 1
      elseif current == value then
        redis.call('PEXPIRE', key, ttl)
        return 1
      else
        return 0
      end
    `;

    // Release lock script
    const releaseLockScript = `
      local key = KEYS[1]
      local value = ARGV[1]
      
      local current = redis.call('GET', key)
      if current == value then
        return redis.call('DEL', key)
      else
        return 0
      end
    `;

    try {
      this.scripts.set('createMatch', await this.client.script('LOAD', createMatchScript));
      this.scripts.set('queueOps', await this.client.script('LOAD', queueOperationsScript));
      this.scripts.set('lock', await this.client.script('LOAD', lockScript));
      this.scripts.set('releaseLock', await this.client.script('LOAD', releaseLockScript));
      
      logger.info('Lua scripts loaded successfully');
    } catch (error) {
      logger.error('Failed to load Lua scripts', { error: error.message });
      throw error;
    }
  }

  // Basic Redis operations with improved error handling
  async get(key) {
    try {
      const result = await this.client.get(key);
      return result;
    } catch (error) {
      this.handleError('get', error);
      throw error;
    }
  }

  async set(key, value, ttl = null) {
    try {
      const args = [key, value];
      if (ttl) args.push('EX', ttl);
      
      const result = await this.client.set(...args);
      return result;
    } catch (error) {
      this.handleError('set', error);
      throw error;
    }
  }

  // OPTIMIZATION: Added setWithExpiry for convenience
  async setWithExpiry(key, value, ttl) {
    return this.set(key, value, ttl);
  }

  async deleteKey(key) {
    try {
      const result = await this.client.del(key);
      return result;
    } catch (error) {
      this.handleError('del', error);
      throw error;
    }
  }

  async exists(key) {
    try {
      const result = await this.client.exists(key);
      return result === 1;
    } catch (error) {
      this.handleError('exists', error);
      throw error;
    }
  }

  async incr(key) {
    try {
      const result = await this.client.incr(key);
      return result;
    } catch (error) {
      this.handleError('incr', error);
      throw error;
    }
  }

  async expire(key, seconds) {
    try {
      const result = await this.client.expire(key, seconds);
      return result === 1;
    } catch (error) {
      this.handleError('expire', error);
      throw error;
    }
  }

  // Hash operations
  async setHash(key, data, ttl = null) {
    try {
      await this.client.hset(key, data);
      if (ttl) {
        await this.client.expire(key, ttl);
      }
      return true;
    } catch (error) {
      this.handleError('hset', error);
      throw error;
    }
  }

  async getHash(key) {
    try {
      const result = await this.client.hgetall(key);
      return result || {};
    } catch (error) {
      this.handleError('hgetall', error);
      throw error;
    }
  }

  async updateHashField(key, field, value) {
    try {
      const result = await this.client.hset(key, field, value);
      return result;
    } catch (error) {
      this.handleError('hset_field', error);
      throw error;
    }
  }

  // Set operations
  async addToSet(key, member, ttl = null) {
    try {
      await this.client.sadd(key, member);
      if (ttl) {
        await this.client.expire(key, ttl);
      }
      return true;
    } catch (error) {
      this.handleError('sadd', error);
      throw error;
    }
  }

  async getSet(key) {
    try {
      const result = await this.client.smembers(key);
      return result || [];
    } catch (error) {
      this.handleError('smembers', error);
      throw error;
    }
  }

  async getSetSize(key) {
    try {
      const result = await this.client.scard(key);
      return result;
    } catch (error) {
      this.handleError('scard', error);
      throw error;
    }
  }

  async removeFromSet(key, member) {
    try {
      const result = await this.client.srem(key, member);
      return result;
    } catch (error) {
      this.handleError('srem', error);
      throw error;
    }
  }

  // Queue operations using scripts for better performance
  async addToQueue(queueName, data) {
    try {
      const result = await this.client.evalsha(
        this.scripts.get('queueOps'),
        0,
        'ADD',
        queueName,
        data
      );
      return result;
    } catch (error) {
      // Fallback if script not loaded
      if (error.message.includes('NOSCRIPT')) {
        await this.loadScripts();
        return this.addToQueue(queueName, data);
      }
      this.handleError('queue_add', error);
      throw error;
    }
  }

  async getFromQueue(queueName) {
    try {
      const result = await this.client.evalsha(
        this.scripts.get('queueOps'),
        0,
        'GET',
        queueName
      );
      return result;
    } catch (error) {
      if (error.message.includes('NOSCRIPT')) {
        await this.loadScripts();
        return this.getFromQueue(queueName);
      }
      this.handleError('queue_get', error);
      throw error;
    }
  }

  async getQueueLength(queueName) {
    try {
      const result = await this.client.evalsha(
        this.scripts.get('queueOps'),
        0,
        'LENGTH',
        queueName
      );
      return result;
    } catch (error) {
      if (error.message.includes('NOSCRIPT')) {
        await this.loadScripts();
        return this.getQueueLength(queueName);
      }
      this.handleError('queue_length', error);
      throw error;
    }
  }

  async removeFromQueue(queueName, data) {
    try {
      const result = await this.client.evalsha(
        this.scripts.get('queueOps'),
        0,
        'REMOVE',
        queueName,
        data
      );
      return result;
    } catch (error) {
      if (error.message.includes('NOSCRIPT')) {
        await this.loadScripts();
        return this.removeFromQueue(queueName, data);
      }
      this.handleError('queue_remove', error);
      throw error;
    }
  }

  async getQueueItems(queueName) {
    try {
      const result = await this.client.lrange(queueName, 0, -1);
      return result || [];
    } catch (error) {
      this.handleError('queue_items', error);
      throw error;
    }
  }

  // Match operations
  async createMatchAtomic(user1, user2, matchData) {
    try {
      const result = await this.client.evalsha(
        this.scripts.get('createMatch'),
        0,
        user1,
        user2,
        JSON.stringify(matchData)
      );
      return result === 1;
    } catch (error) {
      if (error.message.includes('NOSCRIPT')) {
        await this.loadScripts();
        return this.createMatchAtomic(user1, user2, matchData);
      }
      this.handleError('create_match', error);
      throw error;
    }
  }

  async setMatch(user1, user2, roomId) {
    const matchData = {
      peerId: user2,
      roomId,
      createdAt: Date.now(),
      status: 'active'
    };
    
    try {
      await Promise.all([
        this.client.set(`user_match:${user1}`, JSON.stringify({ ...matchData, peerId: user2 }), 'EX', 3600),
        this.client.set(`user_match:${user2}`, JSON.stringify({ ...matchData, peerId: user1 }), 'EX', 3600),
        this.client.sadd('active_matches', `${user1}:${user2}`)
      ]);
      return true;
    } catch (error) {
      this.handleError('set_match', error);
      throw error;
    }
  }

  async getMatch(socketId) {
    try {
      const matchData = await this.client.get(`user_match:${socketId}`);
      if (matchData) {
        return JSON.parse(matchData);
      }
      return null;
    } catch (error) {
      this.handleError('get_match', error);
      return null;
    }
  }

  async deleteMatch(socketId) {
    try {
      await this.client.del(`user_match:${socketId}`);
      return true;
    } catch (error) {
      this.handleError('delete_match', error);
      throw error;
    }
  }

  async getAllMatches() {
    try {
      const keys = await this.client.keys('user_match:*');
      if (keys.length === 0) return {};
      
      const matches = {};
      const pipeline = this.client.pipeline();
      
      for (const key of keys) {
        pipeline.get(key);
      }
      
      const results = await pipeline.exec();
      
      for (let i = 0; i < keys.length; i++) {
        const socketId = keys[i].replace('user_match:', '');
        if (results[i][0] === null && results[i][1]) { // No error and has value
          try {
            matches[socketId] = JSON.parse(results[i][1]);
          } catch (parseError) {
            logger.warn('Failed to parse match data', { socketId, error: parseError.message });
          }
        }
      }
      
      return matches;
    } catch (error) {
      this.handleError('get_all_matches', error);
      return {};
    }
  }

  // IMPROVED: Connection and session management
  async updateUserStats(socketId, stats) {
    try {
      const key = `user_stats:${socketId}`;
      const current = await this.getHash(key);
      
      const updated = {
        ...current,
        ...stats,
        totalMatches: (parseInt(current.totalMatches) || 0) + (stats.totalMatches || 0),
        updatedAt: Date.now()
      };
      
      await this.setHash(key, updated, 86400); // 24 hours TTL
      return true;
    } catch (error) {
      this.handleError('update_user_stats', error);
      throw error;
    }
  }

  // IMPROVED: Distributed locking with proper value tracking
  async acquireLock(lockKey, ttl = 10000) {
    try {
      const lockValue = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const result = await this.client.evalsha(
        this.scripts.get('lock'),
        1,
        lockKey,
        lockValue,
        ttl
      );
      
      if (result === 1) {
        // Store lock value for release
        this.lockValues.set(lockKey, lockValue);
      }
      
      return result === 1;
    } catch (error) {
      if (error.message.includes('NOSCRIPT')) {
        await this.loadScripts();
        return this.acquireLock(lockKey, ttl);
      }
      this.handleError('acquire_lock', error);
      return false;
    }
  }

  async releaseLock(lockKey) {
    try {
      const lockValue = this.lockValues.get(lockKey);
      if (!lockValue) return false;
      
      const result = await this.client.evalsha(
        this.scripts.get('releaseLock'),
        1,
        lockKey,
        lockValue
      );
      
      if (result === 1) {
        this.lockValues.delete(lockKey);
      }
      
      return result === 1;
    } catch (error) {
      if (error.message.includes('NOSCRIPT')) {
        await this.loadScripts();
        return this.releaseLock(lockKey);
      }
      this.handleError('release_lock', error);
      return false;
    }
  }

  // Batch operations
  async batchOperation(operations) {
    try {
      const pipeline = this.client.pipeline();
      
      for (const op of operations) {
        if (op.method && typeof this.client[op.method] === 'function') {
          pipeline[op.method](...(op.args || []));
        }
      }
      
      const results = await pipeline.exec();
      return results;
    } catch (error) {
      this.handleError('batch', error);
      throw error;
    }
  }

  // Utility methods
  async evalScript(script, numKeys, ...args) {
    try {
      const result = await this.client.eval(script, numKeys, ...args);
      return result;
    } catch (error) {
      this.handleError('eval_script', error);
      throw error;
    }
  }

  async getKeysPattern(pattern) {
    try {
      // OPTIMIZATION: Use SCAN instead of KEYS for better performance
      const keys = [];
      const stream = this.client.scanStream({
        match: pattern,
        count: 100
      });
      
      for await (const resultKeys of stream) {
        keys.push(...resultKeys);
      }
      
      return keys;
    } catch (error) {
      this.handleError('keys_pattern', error);
      return [];
    }
  }

  async ping() {
    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch (error) {
      this.handleError('ping', error);
      return false;
    }
  }

  // ADDED: Missing methods referenced in other services
  async getSocketId(socketId) {
    try {
      const sessionData = await this.getHash(`user_session:${socketId}`);
      return sessionData.socketId || null;
    } catch (error) {
      this.handleError('get_socket_id', error);
      return null;
    }
  }

  // Client accessors for Socket.IO adapter
  getClients() {
    return {
      pubClient: this.pubClient,
      subClient: this.subClient
    };
  }

  // IMPROVED: Enhanced error handling
  handleError(operation, error) {
    logger.error(`Redis operation failed: ${operation}`, {
      error: error.message,
      operation,
      worker: process.pid
    });
    
    // Update metrics if available
    try {
      // metrics.redisErrors.inc({ operation, worker: process.pid });
    } catch (metricsError) {
      // Ignore metrics errors
    }
    
    if (error.message.includes('READONLY')) {
      logger.warn('Redis is in readonly mode - possible failover');
    }
    
    if (error.message.includes('CLUSTERDOWN')) {
      logger.error('Redis cluster is down');
      this.isConnected = false;
    }

    if (error.message.includes('ECONNREFUSED') || error.message.includes('ENOTFOUND')) {
      logger.error('Redis connection lost');
      this.isConnected = false;
    }
  }

  // Health check
  async getHealthStatus() {
    try {
      const startTime = Date.now();
      await this.ping();
      const latency = Date.now() - startTime;
      
      const [info, memory] = await Promise.all([
        this.client.info(),
        this.client.info('memory')
      ]);
      
      const connectedClients = await this.client.client('list')
        .then(list => list.split('\n').filter(line => line.trim()).length)
        .catch(() => 0);
      
      return {
        healthy: this.isConnected,
        latency,
        info: this.parseRedisInfo(info),
        memory: this.parseRedisInfo(memory),
        connectedClients,
        scriptsLoaded: this.scripts.size,
        activeLocks: this.lockValues.size,
        worker: process.pid
      };
    } catch (error) {
      return {
        healthy: false,
        error: error.message,
        worker: process.pid
      };
    }
  }

  parseRedisInfo(infoString) {
    const info = {};
    const lines = infoString.split('\n');
    
    for (const line of lines) {
      if (line.includes(':')) {
        const [key, value] = line.split(':');
        if (key && value !== undefined) {
          info[key.trim()] = value.trim();
        }
      }
    }
    
    return info;
  }

  // OPTIMIZATION: Graceful shutdown with proper cleanup
  async shutdown() {
    try {
      logger.info('Shutting down Redis service', { worker: process.pid });
      
      // Release all active locks
      for (const [lockKey, lockValue] of this.lockValues.entries()) {
        try {
          await this.releaseLock(lockKey);
        } catch (error) {
          logger.warn('Failed to release lock during shutdown', {
            lockKey,
            error: error.message
          });
        }
      }
      
      // Close connections gracefully
      if (this.client) {
        await this.client.quit();
      }
      
      if (this.pubClient) {
        await this.pubClient.quit();
      }
      
      if (this.subClient) {
        await this.subClient.quit();
      }
      
      this.isConnected = false;
      this.lockValues.clear();
      this.scripts.clear();
      
      logger.info('Redis service shutdown complete', { worker: process.pid });
      
    } catch (error) {
      logger.error('Error during Redis shutdown', {
        error: error.message,
        worker: process.pid
      });
    }
  }
}

module.exports = new RedisService();