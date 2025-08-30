const socketIo = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const logger = require('../utils/logger');
const redisService = require('../services/redisService');
const kafkaService = require('../services/kafkaService');
const matchmakingService = require('../services/matchmakingService');
const connectionService = require('../services/connectionService');
const signalingService = require('../services/signalingService');
const metrics = require('../monitoring/metrics');

class SocketHandler {
  constructor() {
    this.io = null;
    this.isInitialized = false;
    this.activeConnections = new Map();
    this.rateLimiters = new Map();
    this.heartbeatInterval = null;
    
    // Rate limiting configuration
    this.rateLimits = {
      connection: { maxAttempts: 5, windowMs: 60000 }, // 5 connections per minute
      messaging: { maxMessages: 30, windowMs: 60000 }, // 30 messages per minute
      signaling: { maxSignals: 100, windowMs: 60000 }, // 100 signaling messages per minute
      matchmaking: { maxRequests: 10, windowMs: 60000 } // 10 match requests per minute
    };
  }

  async init(server) {
    if (this.isInitialized) {
      return this.io;
    }

    try {
      await this.initializeServices();
      
      // Create Socket.IO instance first
      this.io = socketIo(server, {
        cors: {
          origin: this.getAllowedOrigins(),
          methods: ['GET', 'POST'],
          credentials: false,
          optionsSuccessStatus: 200
        },
        transports: (process.env.SOCKET_IO_TRANSPORTS || 'websocket,polling').split(','),
        maxHttpBufferSize: 1e6,
        pingTimeout: parseInt(process.env.SOCKET_IO_PING_TIMEOUT) || 60000,
        pingInterval: parseInt(process.env.SOCKET_IO_PING_INTERVAL) || 25000,
        upgradeTimeout: 10000,
        allowEIO3: true,
        cookie: false,
        serveClient: false,
        allowUpgrades: true,
        perMessageDeflate: true,
        httpCompression: true,
        connectTimeout: 45000,
        destroyUpgrade: false,
        destroyUpgradeTimeout: 1000,
        path: process.env.SOCKET_IO_PATH || '/socket.io/'
      });

      // Set up Redis adapter AFTER creating the Socket.IO instance
      await this.setupRedisAdapter();
      
      this.setupGlobalHandlers();
      this.io.on('connection', (socket) => this.handleConnection(socket));
      this.startHealthMonitoring();
      this.isInitialized = true;
      
      logger.info('Socket.IO initialized successfully', { 
        worker: process.pid,
        transports: this.io.engine.transports,
        adapter: this.io.adapter.constructor.name
      });
      
      return this.io;
    } catch (error) {
      logger.error('Failed to initialize Socket.IO', {
        error: error.message,
        stack: error.stack,
        worker: process.pid
      });
      throw error;
    }
  }

  async setupRedisAdapter() {
    try {
      const { pubClient, subClient } = redisService.getClients();
      
      // Test Redis connections
      await Promise.all([
        pubClient.ping(),
        subClient.ping()
      ]);
      
      // Create the adapter constructor function
      const adapterConstructor = createAdapter(pubClient, subClient, {
        key: process.env.REDIS_ADAPTER_KEY || 'socket.io',
        requestsTimeout: 5000,
        publishOnSpecificResponseChannel: true,
        parser: {
          encode: JSON.stringify,
          decode: JSON.parse
        }
      });

      // Set the adapter on the Socket.IO instance
      this.io.adapter(adapterConstructor);

      // Set up error handling on the adapter instance
      // The adapter instance is created when we call this.io.adapter()
      this.io.of('/').adapter.on('error', (error) => {
        logger.error('Redis adapter error', {
          error: error.message,
          worker: process.pid
        });
        metrics.errorRate.inc({ type: 'redis_adapter', worker: process.pid });
      });

      logger.info('Redis adapter configured successfully');
      
    } catch (error) {
      logger.error('Redis adapter setup failed', {
        error: error.message,
        worker: process.pid
      });
      throw error;
    }
  }

  async initializeServices() {
    try {
      await Promise.all([
        redisService.init(),
        kafkaService.init()
      ]);
      
      // Test service connectivity
      await Promise.all([
        redisService.ping(),
        kafkaService.checkHealth()
      ]);
      
      logger.info('All services initialized successfully');
    } catch (error) {
      logger.error('Service initialization failed', {
        error: error.message,
        worker: process.pid
      });
      throw error;
    }
  }

  getAllowedOrigins() {
    const origins = process.env.ALLOWED_ORIGINS || '*';
    
    if (origins === '*') {
      return '*';
    }
    
    return origins.split(',').map(origin => origin.trim());
  }

  setupGlobalHandlers() {
    // Handle peer disconnection notifications across servers
    this.io.on('peer_disconnected_global', (data) => {
      const { targetSocketId, disconnectedSocketId, reason, timestamp, roomId } = data;
      
      // Emit to the target socket ID directly
      this.io.to(targetSocketId).emit('peer_disconnected', {
        peerId: disconnectedSocketId,
        reason,
        timestamp,
        roomId
      });
    });

    // Handle server-wide events
    this.io.engine.on('connection_error', (err) => {
      logger.error('Engine connection error', {
        error: err.message,
        code: err.code,
        worker: process.pid
      });
      metrics.errorRate.inc({ type: 'engine_connection', worker: process.pid });
    });

    // Monitor transport upgrades
    this.io.engine.on('initial_headers', (headers, request) => {
      // Add security headers
      headers['X-Frame-Options'] = 'DENY';
      headers['X-Content-Type-Options'] = 'nosniff';
    });
  }

  async handleConnection(socket) {
    const startTime = Date.now();
    const clientIP = this.getClientIP(socket);
    const userAgent = socket.handshake.headers['user-agent'];
    
    try {
      // Use socket.id as the primary identifier
      const socketId = socket.id;
      
      // Rate limiting check with IP-based tracking
      if (await this.isConnectionRateLimited(clientIP)) {
        logger.warn('Connection rate limit exceeded', { 
          clientIP, 
          socketId,
          userAgent: userAgent?.substring(0, 100),
          worker: process.pid 
        });
        
        socket.emit('rate_limited', { 
          type: 'connection',
          message: 'Too many connection attempts. Please wait before trying again.',
          retryAfter: 60000
        });
        
        socket.disconnect(true);
        return;
      }

      // Store connection info
      this.activeConnections.set(socketId, {
        socketId,
        clientIP,
        userAgent,
        connectedAt: Date.now(),
        lastActivity: Date.now()
      });

      // Connection metrics
      metrics.activeConnections.inc({ worker: process.pid });
      metrics.signalingMessages.inc({ type: 'connect', worker: process.pid });

      logger.info('User connected', {
        socketId,
        clientIP,
        userAgent: userAgent?.substring(0, 100),
        connectionTime: Date.now() - startTime,
        worker: process.pid
      });

      // Register connection in services
      await this.registerConnection(socketId, {
        clientIP,
        userAgent,
        connectedAt: Date.now()
      });
      
      // Log connection event
      kafkaService.logEvent('connect', {
        socketId,
        clientIP,
        userAgent,
        connectionTime: Date.now() - startTime,
        worker: process.pid
      });

      // Setup event handlers with enhanced error handling
      this.setupEventHandlers(socket);
      
      // Send connection confirmation
      socket.emit('connected', {
        socketId,
        timestamp: Date.now(),
        serverInfo: {
          worker: process.pid,
          version: process.env.SERVER_VERSION || '1.0.0'
        }
      });

    } catch (error) {
      logger.error('Error handling connection', {
        error: error.message,
        stack: error.stack,
        socketId: socket.id,
        clientIP,
        worker: process.pid
      });
      
      metrics.errorRate.inc({ type: 'connection_handling', worker: process.pid });
      socket.emit('error', {
        type: 'connection_error',
        message: 'Failed to establish connection'
      });
      socket.disconnect(true);
    }
  }

  getClientIP(socket) {
    return socket.handshake.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
           socket.handshake.headers['x-real-ip'] ||
           socket.handshake.address ||
           socket.conn.remoteAddress ||
           'unknown';
  }

  async isConnectionRateLimited(clientIP) {
    const key = `rate_limit:connection:${clientIP}`;
    const current = await redisService.incr(key);
    
    if (current === 1) {
      await redisService.expire(key, Math.ceil(this.rateLimits.connection.windowMs / 1000));
    }
    
    return current > this.rateLimits.connection.maxAttempts;
  }

  async registerConnection(socketId, metadata) {
    try {
      await Promise.all([
        connectionService.registerConnection(socketId, metadata),
        redisService.setHash(`user_session:${socketId}`, {
          socketId,
          ...metadata,
          worker: process.pid
        }, 3600) // 1 hour TTL
      ]);
    } catch (error) {
      logger.error('Failed to register connection', {
        error: error.message,
        socketId,
        worker: process.pid
      });
      throw error;
    }
  }

  setupEventHandlers(socket) {
    const socketId = socket.id;
    
    // Enhanced matchmaking with preferences
    socket.on('find_match', async () => {
      try {
        if (await this.isRateLimited(socketId, 'matchmaking')) {
          socket.emit('rate_limited', { 
            type: 'matchmaking',
            message: 'Too many match requests. Please wait.',
            retryAfter: 30000
          });
          return;
        }

        this.updateActivity(socketId);
        
        // Extract user preferences
        const preferences = {
          region: 'any',
          language: 'any',
          connectionQuality: 50,
          acceptedLanguages: [],
          minConnectionQuality: 0
        };
        await matchmakingService.findMatch(socket, this.io, preferences);
        
      } catch (error) {
        logger.error('Find match error', {
          error: error.message,
          socketId,
          worker: process.pid
        });
        
        socket.emit('error', {
          type: 'matchmaking_error',
          message: 'Failed to find match. Please try again.'
        });
      }
    });

    socket.on('cancel_match', async () => {
      try {
        this.updateActivity(socketId);
        await matchmakingService.cancelMatch(socketId);
        socket.emit('match_cancelled', { timestamp: Date.now() });
      } catch (error) {
        logger.error('Cancel match error', {
          error: error.message,
          socketId,
          worker: process.pid
        });
      }
    });

    // Enhanced WebRTC signaling with validation
    socket.on('webrtc_offer', async (data) => {
      try {
        if (await this.isRateLimited(socketId, 'signaling')) {
          socket.emit('rate_limited', { 
            type: 'signaling',
            message: 'Too many signaling messages'
          });
          return;
        }

        this.updateActivity(socketId);
        
        if (!this.validateWebRTCData(data)) {
          socket.emit('error', {
            type: 'invalid_data',
            message: 'Invalid WebRTC offer data'
          });
          return;
        }

        await signalingService.forwardSignal(socket, socketId, 'webrtc_offer', data);
        
      } catch (error) {
        this.handleSignalingError(error, socket, socketId, 'webrtc_offer');
      }
    });

    socket.on('webrtc_answer', async (data) => {
      try {
        if (await this.isRateLimited(socketId, 'signaling')) {
          socket.emit('rate_limited', { 
            type: 'signaling',
            message: 'Too many signaling messages'
          });
          return;
        }

        this.updateActivity(socketId);
        
        if (!this.validateWebRTCData(data)) {
          socket.emit('error', {
            type: 'invalid_data',
            message: 'Invalid WebRTC answer data'
          });
          return;
        }

        await signalingService.forwardSignal(socket, socketId, 'webrtc_answer', data);
        
      } catch (error) {
        this.handleSignalingError(error, socket, socketId, 'webrtc_answer');
      }
    });

    socket.on('webrtc_ice_candidate', async (data) => {
      try {
        if (await this.isRateLimited(socketId, 'signaling')) return;

        this.updateActivity(socketId);
        
        if (!this.validateICECandidate(data)) {
          return; // Silently ignore invalid ICE candidates
        }

        await signalingService.forwardSignal(socket, socketId, 'webrtc_ice_candidate', data);
        
      } catch (error) {
        // Don't emit errors for ICE candidates as they're frequent and failures are normal
        logger.debug('ICE candidate forwarding failed', {
          error: error.message,
          socketId,
          worker: process.pid
        });
      }
    });

    // Enhanced messaging with content filtering
    socket.on('message', async (data) => {
      try {
        if (await this.isRateLimited(socketId, 'messaging')) {
          socket.emit('rate_limited', { 
            type: 'messaging',
            message: 'Too many messages. Please slow down.'
          });
          return;
        }

        this.updateActivity(socketId);
        
        if (!this.validateMessage(data)) {
          socket.emit('error', {
            type: 'invalid_message',
            message: 'Invalid message format'
          });
          return;
        }

        // Content filtering (implement your content filter here)
        const sanitizedMessage = this.sanitizeMessage(data);
        
        await signalingService.forwardMessage(socket, socketId, sanitizedMessage);
        
      } catch (error) {
        logger.error('Message forwarding error', {
          error: error.message,
          socketId,
          worker: process.pid
        });
        
        socket.emit('error', {
          type: 'message_error',
          message: 'Failed to send message'
        });
      }
    });

    // Connection quality monitoring
    socket.on('connection_quality', async (data) => {
      try {
        this.updateActivity(socketId);
        
        if (this.validateQualityData(data)) {
          await redisService.setHash(`connection_quality:${socketId}`, {
            overall: data.overall || 50,
            rtt: data.rtt || 0,
            packetsLost: data.packetsLost || 0,
            bandwidth: data.bandwidth || 0,
            timestamp: Date.now()
          }, 300); // 5 minutes TTL

          // metrics.connectionQuality.observe(data.rtt || 0);
          
          kafkaService.logEvent('connection_quality', {
            socketId,
            ...data,
            worker: process.pid
          });
        }
      } catch (error) {
        logger.debug('Connection quality update failed', {
          error: error.message,
          socketId,
          worker: process.pid
        });
      }
    });

    // Skip/next functionality
    socket.on('skip', async () => {
      try {
        this.updateActivity(socketId);
        await signalingService.handleSkip(socket, socketId);
      } catch (error) {
        logger.error('Skip handling error', {
          error: error.message,
          socketId,
          worker: process.pid
        });
      }
    });

    // Error handling
    socket.on('webrtc_error', (error) => {
      logger.error('WebRTC error from client', {
        socketId,
        error: error.message || error,
        worker: process.pid
      });
      
      metrics.errorRate.inc({ type: 'webrtc_client', worker: process.pid });
      kafkaService.logEvent('webrtc_error', { socketId, error, worker: process.pid });
    });

    socket.on('error', (error) => {
      logger.error('Socket error', {
        socketId,
        error: error.message || error,
        worker: process.pid
      });
      
      metrics.errorRate.inc({ type: 'socket', worker: process.pid });
    });

    // Enhanced heartbeat with connection health
    socket.on('ping', () => {
      this.updateActivity(socketId);
      socket.emit('pong', { 
        timestamp: Date.now(),
        serverTime: Date.now(),
        worker: process.pid
      });
    });

    // Disconnect handling with enhanced cleanup
    socket.on('disconnect', async (reason) => {
      await this.handleDisconnect(socket, socketId, reason);
    });

    // Connection validation
    socket.on('validate_connection', () => {
      this.updateActivity(socketId);
      socket.emit('connection_valid', {
        socketId,
        timestamp: Date.now(),
        worker: process.pid
      });
    });
  }

  validateWebRTCData(data) {
    return data && 
           typeof data === 'object' && 
           data.sdp && 
           typeof data.sdp === 'object' &&
           data.sdp.type &&
           data.sdp.sdp &&
           ['offer', 'answer'].includes(data.sdp.type);
  }

  validateICECandidate(data) {
    return data && 
           typeof data === 'object' && 
           data.candidate &&
           (data.candidate.candidate !== undefined);
  }

  validateMessage(data) {
    return typeof data === 'string' && 
           data.length > 0 && 
           data.length <= 1000; // Max 1000 characters
  }

  validateQualityData(data) {
    return data && 
           typeof data === 'object' &&
           typeof data.rtt === 'number' &&
           data.rtt >= 0 &&
           data.rtt < 10000; // Reasonable RTT limit
  }

  sanitizeMessage(message) {
    // Basic message sanitization
    return message
      .trim()
      .substring(0, 1000) // Truncate to max length
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '') // Remove scripts
      .replace(/<[^>]*>/g, ''); // Remove HTML tags
  }

  updateActivity(socketId) {
    const connection = this.activeConnections.get(socketId);
    if (connection) {
      connection.lastActivity = Date.now();
    }
  }

  async isRateLimited(socketId, type) {
    const limit = this.rateLimits[type];
    if (!limit) return false;

    const key = `rate_limit:${type}:${socketId}`;
    const current = await redisService.incr(key);
    
    if (current === 1) {
      await redisService.expire(key, Math.ceil(limit.windowMs / 1000));
    }
    
    if (current > limit.maxMessages || current > limit.maxRequests || current > limit.maxSignals) {
      metrics.rateLimitHit.inc({ type, worker: process.pid });
      return true;
    }
    
    return false;
  }

  handleSignalingError(error, socket, socketId, signalType) {
    logger.error('Signaling error', {
      error: error.message,
      socketId,
      signalType,
      worker: process.pid
    });
    
    metrics.errorRate.inc({ type: 'signaling', worker: process.pid });
    
    socket.emit('signaling_error', {
      type: signalType,
      message: 'Signaling failed, please try reconnecting'
    });
  }

  async handleDisconnect(socket, socketId, reason) {
    const disconnectStart = Date.now();
    
    try {
      const connectionInfo = this.activeConnections.get(socketId);
      
      logger.info('User disconnected', {
        socketId,
        reason,
        sessionDuration: connectionInfo ? Date.now() - connectionInfo.connectedAt : 0,
        worker: process.pid
      });

      // Parallel cleanup operations
      await Promise.allSettled([
        matchmakingService.handleDisconnect(socketId, this.io),
        connectionService.handleDisconnect(socketId),
        this.cleanupUserData(socketId)
      ]);

      // Update metrics
      // metrics.activeConnections.dec({ worker: process.pid });
      // metrics.signalingMessages.inc({ type: 'disconnect', worker: process.pid });
      // metrics.disconnectDuration.observe((Date.now() - disconnectStart) / 1000);

      // Remove from active connections
      this.activeConnections.delete(socketId);

      // Log disconnect event
      kafkaService.logEvent('disconnect', {
        socketId,
        reason,
        sessionDuration: connectionInfo ? Date.now() - connectionInfo.connectedAt : 0,
        disconnectDuration: Date.now() - disconnectStart,
        worker: process.pid
      });

    } catch (error) {
      logger.error('Error handling disconnect', {
        error: error.message,
        stack: error.stack,
        socketId,
        worker: process.pid
      });
      
      metrics.errorRate.inc({ type: 'disconnect', worker: process.pid });
    }
  }

  async cleanupUserData(socketId) {
    try {
      const keys = [
        `user_session:${socketId}`,
        `user_preferences:${socketId}`,
        `connection_quality:${socketId}`,
        `queue_position:${socketId}`
      ];

      await Promise.all(keys.map(key => redisService.deleteKey(key)));
    } catch (error) {
      logger.error('Failed to cleanup user data', {
        error: error.message,
        socketId,
        worker: process.pid
      });
    }
  }

  startHealthMonitoring() {
    // Heartbeat for inactive connections
    this.heartbeatInterval = setInterval(() => {
      this.checkInactiveConnections();
    }, 60000); // Every minute

    // Server health metrics
    setInterval(() => {
      this.updateServerMetrics();
    }, 30000); // Every 30 seconds
  }

  checkInactiveConnections() {
    const now = Date.now();
    const inactivityTimeout = 5 * 60 * 1000; // 5 minutes

    for (const [socketId, connection] of this.activeConnections.entries()) {
      if (now - connection.lastActivity > inactivityTimeout) {
        logger.info('Disconnecting inactive connection', {
          socketId,
          inactiveFor: now - connection.lastActivity,
          worker: process.pid
        });

        const socket = this.io.sockets.sockets.get(socketId);
        if (socket) {
          socket.emit('inactive_timeout', {
            message: 'Connection terminated due to inactivity'
          });
          socket.disconnect(true);
        }

        this.activeConnections.delete(socketId);
      }
    }
  }

  updateServerMetrics() {
    // metrics.activeConnections.set({ worker: process.pid }, this.activeConnections.size);
    
    // Memory usage
    const memUsage = process.memoryUsage();
    // metrics.memoryUsage.set({ type: 'rss', worker: process.pid }, memUsage.rss);
    // metrics.memoryUsage.set({ type: 'heapUsed', worker: process.pid }, memUsage.heapUsed);
    // metrics.memoryUsage.set({ type: 'heapTotal', worker: process.pid }, memUsage.heapTotal);
    
    // Event loop lag
    const start = process.hrtime.bigint();
    setImmediate(() => {
      const lag = Number(process.hrtime.bigint() - start) / 1e6; // Convert to milliseconds
      // metrics.eventLoopLag.set({ worker: process.pid }, lag);
    });
  }

  async shutdown() {
    if (!this.isInitialized) return;

    logger.info('Shutting down Socket.IO server', { worker: process.pid });
    
    try {
      // Clear intervals
      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
      }

      // Notify all clients of shutdown
      this.io.emit('server_shutdown', { 
        message: 'Server is shutting down for maintenance',
        timestamp: Date.now(),
        gracePeriod: 30000 // 30 seconds
      });

      // Wait a bit for clients to receive the message
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Disconnect all clients gracefully
      for (const [socketId, connection] of this.activeConnections.entries()) {
        const socket = this.io.sockets.sockets.get(socketId);
        if (socket) {
          await this.handleDisconnect(socket, socketId, 'server_shutdown');
          socket.disconnect(true);
        }
      }

      // Close server
      this.io.close();
      this.isInitialized = false;
      this.activeConnections.clear();

      // Shutdown services
      await Promise.all([
        connectionService.shutdown(),
        kafkaService.shutdown(),
        redisService.shutdown()
      ]);

      logger.info('Socket.IO server shutdown complete', { worker: process.pid });

    } catch (error) {
      logger.error('Error during shutdown', {
        error: error.message,
        stack: error.stack,
        worker: process.pid
      });
    }
  }

  // Health check endpoint
  async getHealthStatus() {
    try {
      const [redisHealth, kafkaHealth, matchmakingHealth] = await Promise.all([
        redisService.ping(),
        kafkaService.checkHealth(),
        matchmakingService.getHealthStatus()
      ]);

      return {
        healthy: redisHealth && kafkaHealth && matchmakingHealth.healthy,
        services: {
          redis: redisHealth,
          kafka: kafkaHealth,
          matchmaking: matchmakingHealth
        },
        connections: {
          active: this.activeConnections.size,
          total: this.io.engine.clientsCount
        },
        worker: process.pid,
        uptime: process.uptime(),
        timestamp: Date.now()
      };
    } catch (error) {
      return {
        healthy: false,
        error: error.message,
        worker: process.pid,
        timestamp: Date.now()
      };
    }
  }

  getIO() {
    return this.io;
  }

  getActiveConnections() {
    return Array.from(this.activeConnections.values());
  }
}

module.exports = new SocketHandler();