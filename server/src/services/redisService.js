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
      const redisConfig = {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT) || 6379,
        password: process.env.REDIS_PASSWORD,
        db: parseInt(process.env.REDIS_DB) || 0,
        
        // Connection settings
        connectTimeout: 10000,
        lazyConnect: true,
        maxRetriesPerRequest: this.maxRetriesPerRequest,
        retryDelayOnFailover: this.retryDelayOnFailover,
        enableReadyCheck: true,
        maxLoadingTimeout: 5000,
        
        // Performance settings
        keepAlive: 30000,
        family: 4,
        
        // Cluster settings (if using Redis Cluster)
        enableOfflineQueue: false,
        
        // Retry settings
        retryConnect: (times) => Math.min(times * 50, 2000),
        
        // Sentinel settings (if using Redis Sentinel)
        sentinels: process.env.REDIS_SENTINELS ? 
          process.env.REDIS_SENTINELS.split(',').map(s => {
            const [host, port] = s.split(':');
            return { host, port: parseInt(port) };
          }) : undefined,
        name: process.env.REDIS_SENTINEL_NAME || 'mymaster',
        
        // Cluster settings (if using Redis Cluster)
        enableOfflineQueue: false
      };

      // Initialize main client
      this.client = new Redis(redisConfig);
      
      // Initialize pub/sub clients for Socket.IO adapter
      this.pubClient = new Redis({
        ...redisConfig,
        db: parseInt(process.env.REDIS_PUBSUB_DB) || 0
      });
      
      this.subClient = new Redis({
        ...redisConfig,
        db: parseInt(process.env.REDIS_PUBSUB_DB) || 0
      });

      // Setup event handlers
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
      metrics.redisConnections.inc({ type: 'main', worker: process.pid });
    });

    this.client.on('error', (error) => {
      logger.error('Redis main client error', { error: error.message });
      metrics.redisErrors.inc({ type: 'main', worker: process.pid });
      this.isConnected = false;
    });

    this.client.on('reconnecting', () => {
      logger.warn('Redis main client reconnecting');
    });

    // Pub client events
    this.pubClient.on('connect', () => {
      logger.info('Redis pub client connected');
      metrics.redisConnections.inc({ type: 'pub', worker: process.pid });
    });

    this.pubClient.on('error', (error) => {
      logger.error('Redis pub client error', { error: error.message });
      metrics.redisErrors.inc({ type: 'pub', worker: process.pid });
    });

    // Sub client events
    this.subClient.on('connect', () => {
      logger.info('Redis sub client connected');
      metrics.redisConnections.inc({ type: 'sub', worker: process.pid });
    });

    this.subClient.on('error', (error) => {
      logger.error('Redis sub client error', { error: error.message });
      metrics.redisErrors.inc({ type: 'sub', worker: process.pid });
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
    try {
      const result = await this.client.get(key);
      metrics.redisOperations.inc({ operation: 'get', worker: process.pid });
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
      metrics.redisOperations.inc({ operation: 'set', worker: process.pid });
      return result;
    } catch (error) {
      this.handleError('set', error);
      throw error;
    }
  }

  async setWithExpiry(key, value, seconds) {
    return this.set(key, value, seconds);
  }

  async del(key) {
    try {
      const result = await this.client.del(key);
      metrics.redisOperations.inc({ operation: 'del', worker: process.pid });
      return result;
    } catch (error) {
      this.handleError('del', error);
      throw error;
    }
  }

  async deleteKey(key) {
    return this.del(key);
  }

  async exists(key) {
    try {
      const result = await this.client.exists(key);
      metrics.redisOperations.inc({ operation: 'exists', worker: process.pid });
      return result === 1;
    } catch (error) {
      this.handleError('exists', error);
      throw error;
    }
  }

  async incr(key) {
    try {
      const result = await this.client.incr(key);
      metrics.redisOperations.inc({ operation: 'incr', worker: process.pid });
      return result;
    } catch (error) {
      this.handleError('incr', error);
      throw error;
    }
  }

  async expire(key, seconds) {
    try {
      const result = await this.client.expire(key, seconds);
      metrics.redisOperations.inc({ operation: 'expire', worker: process.pid });
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
      metrics.redisOperations.inc({ operation: 'hset', worker: process.pid });
      return true;
    } catch (error) {
      this.handleError('hset', error);
      throw error;
    }
  }

  async getHash(key) {
    return key;
  }

  async updateHashField(key, field, value) {
    try {
      const result = await this.client.hset(key, field, value);
      metrics.redisOperations.inc({ operation: 'hset_field', worker: process.pid });
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
      metrics.redisOperations.inc({ operation: 'sadd', worker: process.pid });
      return true;
    } catch (error) {
      this.handleError('sadd', error);
      throw error;
    }
  }

  async getSet(key) {
    try {
      const result = await this.client.smembers(key);
      metrics.redisOperations.inc({ operation: 'smembers', worker: process.pid });
      return result || [];
    } catch (error) {
      this.handleError('smembers', error);
      throw error;
    }
  }

  async getSetSize(key) {
    try {
      const result = await this.client.scard(key);
      metrics.redisOperations.inc({ operation: 'scard', worker: process.pid });
      return result;
    } catch (error) {
      this.handleError('scard', error);
      throw error;
    }
  }

  async removeFromSet(key, member) {
    try {
      const result = await this.client.srem(key, member);
      metrics.redisOperations.inc({ operation: 'srem', worker: process.pid });
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
      metrics.redisOperations.inc({ operation: 'queue_add', worker: process.pid });
      return result;
    } catch (error) {
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
      metrics.redisOperations.inc({ operation: 'queue_get', worker: process.pid });
      return result;
    } catch (error) {
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
      metrics.redisOperations.inc({ operation: 'queue_length', worker: process.pid });
      return result;
    } catch (error) {
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
      metrics.redisOperations.inc({ operation: 'queue_remove', worker: process.pid });
      return result;
    } catch (error) {
      this.handleError('queue_remove', error);
      throw error;
    }
  }

  async getQueueItems(queueName) {
    try {
      const result = await this.client.lrange(queueName, 0, -1);
      metrics.redisOperations.inc({ operation: 'queue_items', worker: process.pid });
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
      metrics.redisOperations.inc({ operation: 'create_match', worker: process.pid });
      return result === 1;
    } catch (error) {
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
        this.client.set(`user_match:${user1}`, JSON.stringify({ ...matchData, peerId: user2 })),
        this.client.set(`user_match:${user2}`, JSON.stringify({ ...matchData, peerId: user1 })),
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
      metrics.redisOperations.inc({ operation: 'delete_match', worker: process.pid });
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
        if (results[i][1]) {
          matches[socketId] = JSON.parse(results[i][1]);
        }
      }
      
      return matches;
    } catch (error) {
      this.handleError('get_all_matches', error);
      return {};
    }
  }

  // Connection and session management
  async getSocketId(socketId) {
    return socketId;
  }

  async updateUserStats(socketId, stats) {
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
    }
  }

  // Distributed locking
  async acquireLock(lockKey, ttl = 10000) {
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
      
      metrics.redisOperations.inc({ operation: 'acquire_lock', worker: process.pid });
      return result === 1;
    } catch (error) {
      this.handleError('acquire_lock', error);
      return false;
    }
  }

  async releaseLock(lockKey) {
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
      
      metrics.redisOperations.inc({ operation: 'release_lock', worker: process.pid });
      return result === 1;
    } catch (error) {
      this.handleError('release_lock', error);
      return false;
    }
  }

  // Batch operations
  async batchOperation(operations) {
    try {
      const pipeline = this.client.pipeline();
      
      for (const op of operations) {
        pipeline[op.method](...op.args);
      }
      
      const results = await pipeline.exec();
      metrics.redisOperations.inc({ operation: 'batch', worker: process.pid });
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
      metrics.redisOperations.inc({ operation: 'eval_script', worker: process.pid });
      return result;
    } catch (error) {
      this.handleError('eval_script', error);
      throw error;
    }
  }

  async getKeysPattern(pattern) {
    try {
      const result = await this.client.keys(pattern);
      metrics.redisOperations.inc({ operation: 'keys', worker: process.pid });
      return result || [];
    } catch (error) {
      this.handleError('keys', error);
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
    
    metrics.redisErrors.inc({ operation, worker: process.pid });
    
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