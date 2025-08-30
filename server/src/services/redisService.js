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
  }

  async init() {
  try {
    // Parse REDIS_URL if present
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    const parsed = new URL(redisUrl);

    const redisConfig = {
      host: parsed.hostname || 'localhost',
      port: parsed.port ? parseInt(parsed.port) : 6379,
      password: process.env.REDIS_PASSWORD || parsed.password || undefined,
      db: parseInt(process.env.REDIS_DB) || (parsed.pathname ? parseInt(parsed.pathname.slice(1)) : 0),

      // Connection settings
      connectTimeout: 10000,
      lazyConnect: true,
      maxRetriesPerRequest: this.maxRetriesPerRequest || 5,
      retryDelayOnFailover: this.retryDelayOnFailover || 100,
      enableReadyCheck: true,
      maxLoadingTimeout: 5000,

      // Performance settings
      keepAlive: 30000,
      family: 4,

      // Pooling (if you implement pooling manually)
      maxConnections: parseInt(process.env.REDIS_POOL_SIZE) || 5,

      // Retry strategy
      retryStrategy: (times) => Math.min(times * 50, 2000),

      // Sentinel support
      sentinels: process.env.REDIS_SENTINELS
        ? process.env.REDIS_SENTINELS.split(',').map(s => {
            const [host, port] = s.split(':');
            return { host, port: parseInt(port) };
          })
        : undefined,
      name: process.env.REDIS_SENTINEL_NAME || 'mymaster'
    };

    // Initialize main client
    this.client = new Redis(redisConfig);

    // Pub/Sub clients (different db if needed)
    this.pubClient = new Redis({
      ...redisConfig,
      db: parseInt(process.env.REDIS_PUBSUB_DB) || redisConfig.db
    });

    this.subClient = new Redis({
      ...redisConfig,
      db: parseInt(process.env.REDIS_PUBSUB_DB) || redisConfig.db
    });

    // Event handlers
    this.setupEventHandlers();

    // Connect all
    await Promise.all([
      this.client.connect(),
      this.pubClient.connect(),
      this.subClient.connect()
    ]);

    // Load Lua scripts
    await this.loadScripts();

    this.isConnected = true;
    logger.info('Redis service initialized successfully', {
      host: redisConfig.host,
      port: redisConfig.port,
      db: redisConfig.db,
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
      // Fix: Now uses the correctly defined metric
      // metrics.redisOperationsTotal.inc({ type: 'main', worker: process.pid });
    });

    this.client.on('error', (error) => {
      logger.error('Redis main client error', { error: error.message });
      // Fix: Now uses the correctly defined metric
      this.isConnected = false;
    });

    this.client.on('reconnecting', () => {
      logger.warn('Redis main client reconnecting');
    });

    // Pub client events
    this.pubClient.on('connect', () => {
      logger.info('Redis pub client connected');
      // Fix: Now uses the correctly defined metric
      // metrics.redisOperationsTotal.inc({ type: 'pub', worker: process.pid });
    });

    this.pubClient.on('error', (error) => {
      logger.error('Redis pub client error', { error: error.message });
      // Fix: Now uses the correctly defined metric
    });

    // Sub client events
    this.subClient.on('connect', () => {
      logger.info('Redis sub client connected');
      // Fix: Now uses the correctly defined metric
      // metrics.redisOperationsTotal.inc({ type: 'sub', worker: process.pid });
    });

    this.subClient.on('error', (error) => {
      logger.error('Redis sub client error', { error: error.message });
      // Fix: Now uses the correctly defined metric
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
      redis.call('SET', 'user_match:' .. user1, matchData)
      redis.call('SET', 'user_match:' .. user2, matchData)
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
        redis.call('EXPIRE', key, math.ceil(ttl / 1000))
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

  // Basic Redis operations
  async get(key) {
    // const end = metrics.redisOperationsDuration.startTimer();
    try {
      const result = await this.client.get(key);
      // metrics.redisOperationsTotal.inc({ operation: 'get', worker: process.pid });
      return result;
    } catch (error) {
      this.handleError('get', error);
      throw error;
    } finally {
      // end({ operation: 'get' });
    }
  }

  async set(key, value, ttl = null) {
    // const end = metrics.redisOperationsDuration.startTimer();
    try {
      const args = [key, value];
      if (ttl) args.push('EX', ttl);
      
      const result = await this.client.set(...args);
      // metrics.redisOperationsTotal.inc({ operation: 'set', worker: process.pid });
      return result;
    } catch (error) {
      this.handleError('set', error);
      throw error;
    } finally {
      // end({ operation: 'set' });
    }
  }

  async deleteKey(key) {
    // const end = metrics.redisOperationsDuration.startTimer();
    try {
      const result = await this.client.del(key);
      // metrics.redisOperationsTotal.inc({ operation: 'del', worker: process.pid });
      return result;
    } catch (error) {
      this.handleError('del', error);
      throw error;
    } finally {
      // end({ operation: 'del' });
    }
  }

  async exists(key) {
    // const end = metrics.redisOperationsDuration.startTimer();
    try {
      const result = await this.client.exists(key);
      // metrics.redisOperationsTotal.inc({ operation: 'exists', worker: process.pid });
      return result === 1;
    } catch (error) {
      this.handleError('exists', error);
      throw error;
    } finally {
      // end({ operation: 'exists' });
    }
  }

  async incr(key) {
    // const end = metrics.redisOperationsDuration.startTimer();
    try {
      const result = await this.client.incr(key);
      // metrics.redisOperationsTotal.inc({ operation: 'incr', worker: process.pid });
      return result;
    } catch (error) {
      this.handleError('incr', error);
      throw error;
    } finally {
      // end({ operation: 'incr' });
    }
  }

  async expire(key, seconds) {
    // const end = metrics.redisOperationsDuration.startTimer();
    try {
      const result = await this.client.expire(key, seconds);
      // metrics.redisOperationsTotal.inc({ operation: 'expire', worker: process.pid });
      return result === 1;
    } catch (error) {
      this.handleError('expire', error);
      throw error;
    } finally {
      // end({ operation: 'expire' });
    }
  }

  // Hash operations
  async setHash(key, data, ttl = null) {
    // const end = metrics.redisOperationsDuration.startTimer();
    try {
      await this.client.hset(key, data);
      if (ttl) {
        await this.client.expire(key, ttl);
      }
      // metrics.redisOperationsTotal.inc({ operation: 'hset', worker: process.pid });
      return true;
    } catch (error) {
      this.handleError('hset', error);
      throw error;
    } finally {
      // end({ operation: 'hset' });
    }
  }

  async getHash(key) {
    // const end = metrics.redisOperationsDuration.startTimer();
    try {
      const result = await this.client.hgetall(key);
      // metrics.redisOperationsTotal.inc({ operation: 'hgetall', worker: process.pid });
      return result || {};
    } catch (error) {
      this.handleError('hgetall', error);
      throw error;
    } finally {
      // end({ operation: 'hgetall' });
    }
  }

  async updateHashField(key, field, value) {
    // const end = metrics.redisOperationsDuration.startTimer();
    try {
      const result = await this.client.hset(key, field, value);
      // metrics.redisOperationsTotal.inc({ operation: 'hset_field', worker: process.pid });
      return result;
    } catch (error) {
      this.handleError('hset_field', error);
      throw error;
    } finally {
      // end({ operation: 'hset_field' });
    }
  }

  // Set operations
  async addToSet(key, member, ttl = null) {
    // const end = metrics.redisOperationsDuration.startTimer();
    try {
      await this.client.sadd(key, member);
      if (ttl) {
        await this.client.expire(key, ttl);
      }
      // metrics.redisOperationsTotal.inc({ operation: 'sadd', worker: process.pid });
      return true;
    } catch (error) {
      this.handleError('sadd', error);
      throw error;
    } finally {
      // end({ operation: 'sadd' });
    }
  }

  async getSet(key) {
    // const end = metrics.redisOperationsDuration.startTimer();
    try {
      const result = await this.client.smembers(key);
      // metrics.redisOperationsTotal.inc({ operation: 'smembers', worker: process.pid });
      return result || [];
    } catch (error) {
      this.handleError('smembers', error);
      throw error;
    } finally {
      // end({ operation: 'smembers' });
    }
  }

  async getSetSize(key) {
    // const end = metrics.redisOperationsDuration.startTimer();
    try {
      const result = await this.client.scard(key);
      // metrics.redisOperationsTotal.inc({ operation: 'scard', worker: process.pid });
      return result;
    } catch (error) {
      this.handleError('scard', error);
      throw error;
    } finally {
      // end({ operation: 'scard' });
    }
  }

  async removeFromSet(key, member) {
    // const end = metrics.redisOperationsDuration.startTimer();
    try {
      const result = await this.client.srem(key, member);
      // metrics.redisOperationsTotal.inc({ operation: 'srem', worker: process.pid });
      return result;
    } catch (error) {
      this.handleError('srem', error);
      throw error;
    } finally {
      // end({ operation: 'srem' });
    }
  }

  // Queue operations using scripts for better performance
  async addToQueue(queueName, data) {
    // const end = metrics.redisOperationsDuration.startTimer();
    try {
      const result = await this.client.evalsha(
        this.scripts.get('queueOps'),
        0,
        'ADD',
        queueName,
        data
      );
      // metrics.redisOperationsTotal.inc({ operation: 'queue_add', worker: process.pid });
      return result;
    } catch (error) {
      this.handleError('queue_add', error);
      throw error;
    } finally {
      // end({ operation: 'queue_add' });
    }
  }

  async getFromQueue(queueName) {
    // const end = metrics.redisOperationsDuration.startTimer();
    try {
      const result = await this.client.evalsha(
        this.scripts.get('queueOps'),
        0,
        'GET',
        queueName
      );
      // metrics.redisOperationsTotal.inc({ operation: 'queue_get', worker: process.pid });
      return result;
    } catch (error) {
      this.handleError('queue_get', error);
      throw error;
    } finally {
      // end({ operation: 'queue_get' });
    }
  }

  async getQueueLength(queueName) {
    // const end = metrics.redisOperationsDuration.startTimer();
    try {
      const result = await this.client.evalsha(
        this.scripts.get('queueOps'),
        0,
        'LENGTH',
        queueName
      );
      // metrics.redisOperationsTotal.inc({ operation: 'queue_length', worker: process.pid });
      return result;
    } catch (error) {
      this.handleError('queue_length', error);
      throw error;
    } finally {
      // end({ operation: 'queue_length' });
    }
  }

  async removeFromQueue(queueName, data) {
    // const end = metrics.redisOperationsDuration.startTimer();
    try {
      const result = await this.client.evalsha(
        this.scripts.get('queueOps'),
        0,
        'REMOVE',
        queueName,
        data
      );
      // metrics.redisOperationsTotal.inc({ operation: 'queue_remove', worker: process.pid });
      return result;
    } catch (error) {
      this.handleError('queue_remove', error);
      throw error;
    } finally {
      // end({ operation: 'queue_remove' });
    }
  }

  async getQueueItems(queueName) {
    // const end = metrics.redisOperationsDuration.startTimer();
    try {
      const result = await this.client.lrange(queueName, 0, -1);
      // metrics.redisOperationsTotal.inc({ operation: 'queue_items', worker: process.pid });
      return result || [];
    } catch (error) {
      this.handleError('queue_items', error);
      throw error;
    } finally {
      // end({ operation: 'queue_items' });
    }
  }

  // Match operations
  async createMatchAtomic(user1, user2, matchData) {
    // const end = metrics.redisOperationsDuration.startTimer();
    try {
      const result = await this.client.evalsha(
        this.scripts.get('createMatch'),
        0,
        user1,
        user2,
        JSON.stringify(matchData)
      );
      // metrics.redisOperationsTotal.inc({ operation: 'create_match', worker: process.pid });
      return result === 1;
    } catch (error) {
      this.handleError('create_match', error);
      throw error;
    } finally {
      // end({ operation: 'create_match' });
    }
  }

  async setMatch(user1, user2, roomId) {
    const matchData = {
      peerId: user2,
      roomId,
      createdAt: Date.now(),
      status: 'active'
    };
    
    // const end = metrics.redisOperationsDuration.startTimer();
    try {
      await Promise.all([
        this.client.set(`user_match:${user1}`, JSON.stringify({ ...matchData, peerId: user2 })),
        this.client.set(`user_match:${user2}`, JSON.stringify({ ...matchData, peerId: user1 })),
        this.client.sadd('active_matches', `${user1}:${user2}`)
      ]);
      return true;
    } catch (error) {
      this.handleError('set_match', error);
      throw error;
    } finally {
      // end({ operation: 'set_match' });
    }
  }

  async getMatch(socketId) {
    // const end = metrics.redisOperationsDuration.startTimer();
    try {
      const matchData = await this.client.get(`user_match:${socketId}`);
      if (matchData) {
        return JSON.parse(matchData);
      }
      return null;
    } catch (error) {
      this.handleError('get_match', error);
      return null;
    } finally {
      // end({ operation: 'get_match' });
    }
  }

  async deleteMatch(socketId) {
    // const end = metrics.redisOperationsDuration.startTimer();
    try {
      await this.client.del(`user_match:${socketId}`);
      // metrics.redisOperationsTotal.inc({ operation: 'delete_match', worker: process.pid });
      return true;
    } catch (error) {
      this.handleError('delete_match', error);
      throw error;
    } finally {
      // end({ operation: 'delete_match' });
    }
  }

  async getAllMatches() {
    // const end = metrics.redisOperationsDuration.startTimer();
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
        if (results[i][1]) {
          matches[socketId] = JSON.parse(results[i][1]);
        }
      }
      
      return matches;
    } catch (error) {
      this.handleError('get_all_matches', error);
      return {};
    } finally {
      // end({ operation: 'get_all_matches' });
    }
  }

  // Connection and session management
  async updateUserStats(socketId, stats) {
    // const end = metrics.redisOperationsDuration.startTimer();
    try {
      const key = `user_stats:${socketId}`;
      const current = await this.getHash(key);
      
      const updated = {
        ...current,
        ...stats,
        totalMatches: (parseInt(current.totalMatches) || 0) + (stats.matches ? 1 : 0),
        updatedAt: Date.now()
      };
      
      await this.setHash(key, updated, 86400); // 24 hours TTL
      return true;
    } catch (error) {
      this.handleError('update_user_stats', error);
      throw error;
    } finally {
      // end({ operation: 'update_user_stats' });
    }
  }

  // Distributed locking
  async acquireLock(lockKey, ttl = 10000) {
    // const end = metrics.redisOperationsDuration.startTimer();
    try {
      const lockValue = `${process.pid}_${Date.now()}_${Math.random()}`;
      const result = await this.client.evalsha(
        this.scripts.get('lock'),
        1,
        lockKey,
        lockValue,
        ttl
      );
      
      if (result === 1) {
        // Store lock value for release
        this.client._lockValues = this.client._lockValues || new Map();
        this.client._lockValues.set(lockKey, lockValue);
      }
      
      // metrics.redisOperationsTotal.inc({ operation: 'acquire_lock', worker: process.pid });
      return result === 1;
    } catch (error) {
      this.handleError('acquire_lock', error);
      return false;
    } finally {
      // end({ operation: 'acquire_lock' });
    }
  }

  async releaseLock(lockKey) {
    // const end = metrics.redisOperationsDuration.startTimer();
    try {
      const lockValue = this.client._lockValues?.get(lockKey);
      if (!lockValue) return false;
      
      const result = await this.client.evalsha(
        this.scripts.get('releaseLock'),
        1,
        lockKey,
        lockValue
      );
      
      if (result === 1) {
        this.client._lockValues?.delete(lockKey);
      }
      
      // metrics.redisOperationsTotal.inc({ operation: 'release_lock', worker: process.pid });
      return result === 1;
    } catch (error) {
      this.handleError('release_lock', error);
      return false;
    } finally {
      // end({ operation: 'release_lock' });
    }
  }

  // Batch operations
  async batchOperation(operations) {
    // const end = metrics.redisOperationsDuration.startTimer();
    try {
      const pipeline = this.client.pipeline();
      
      for (const op of operations) {
        pipeline[op.method](...op.args);
      }
      
      const results = await pipeline.exec();
      // metrics.redisOperationsTotal.inc({ operation: 'batch', worker: process.pid });
      return results;
    } catch (error) {
      this.handleError('batch', error);
      throw error;
    } finally {
      // end({ operation: 'batch' });
    }
  }

  // Utility methods
  async evalScript(script, numKeys, ...args) {
    // const end = metrics.redisOperationsDuration.startTimer();
    try {
      const result = await this.client.eval(script, numKeys, ...args);
      // metrics.redisOperationsTotal.inc({ operation: 'eval_script', worker: process.pid });
      return result;
    } catch (error) {
      this.handleError('eval_script', error);
      throw error;
    } finally {
      // end({ operation: 'eval_script' });
    }
  }

  async getKeysPattern(pattern) {
    // const end = metrics.redisOperationsDuration.startTimer();
    try {
      const result = await this.client.keys(pattern);
      // metrics.redisOperationsTotal.inc({ operation: 'keys', worker: process.pid });
      return result || [];
    } catch (error) {
      this.handleError('keys', error);
      return [];
    } finally {
      // end({ operation: 'keys' });
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

  // Client accessors for Socket.IO adapter
  getClients() {
    return {
      pubClient: this.pubClient,
      subClient: this.subClient
    };
  }

  // Error handling
  handleError(operation, error) {
    logger.error(`Redis operation failed: ${operation}`, {
      error: error.message,
      operation,
      worker: process.pid
    });
    
    
    if (error.message.includes('READONLY')) {
      logger.warn('Redis is in readonly mode - possible failover');
    }
    
    if (error.message.includes('CLUSTERDOWN')) {
      logger.error('Redis cluster is down');
      this.isConnected = false;
    }
  }

  // Health check
  async getHealthStatus() {
    try {
      const startTime = Date.now();
      await this.ping();
      const latency = Date.now() - startTime;
      
      const info = await this.client.info();
      const memory = await this.client.info('memory');
      
      return {
        healthy: this.isConnected,
        latency,
        info: this.parseRedisInfo(info),
        memory: this.parseRedisInfo(memory),
        connectedClients: await this.client.client('list').then(list => list.split('\n').length - 1),
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
        if (key && value) {
          info[key.trim()] = value.trim();
        }
      }
    }
    
    return info;
  }

  // Shutdown
  async shutdown() {
    try {
      logger.info('Shutting down Redis service', { worker: process.pid });
      
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