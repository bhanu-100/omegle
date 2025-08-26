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
  }

  async init(server) {
    if (this.isInitialized) {
      return this.io;
    }

    try {
      // Initialize services
      await redisService.init();
      await kafkaService.init();
      
      // Initialize Socket.IO
      this.io = socketIo(server, {
        cors: {
          origin:'*',
          // origin: process.env.CLIENT_URL || '*',
          methods: ['GET', 'POST'],
          credentials: false
        },
        transports: (process.env.SOCKET_IO_TRANSPORTS || 'websocket,polling').split(','),
        maxHttpBufferSize: 1e6, // 1MB
        pingTimeout: parseInt(process.env.SOCKET_IO_PING_TIMEOUT) || 60000,
        pingInterval: parseInt(process.env.SOCKET_IO_PING_INTERVAL) || 25000,
        upgradeTimeout: 10000,
        allowEIO3: true,
        cookie: false,
        serveClient: false,
        allowUpgrades: true,
        perMessageDeflate: false
      });

      // Setup Redis adapter
      const { pubClient, subClient } = redisService.getClients();
      this.io.adapter(createAdapter(pubClient, subClient, {
        key: 'socket.io',
        requestsTimeout: 5000
      }));

      // Connection handling
      this.io.on('connection', (socket) => this.handleConnection(socket));

      this.isInitialized = true;
      logger.info('Socket.IO initialized successfully', { worker: process.pid });
      
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

  async handleConnection(socket) {
    const startTime = Date.now();
    
    // Extract user info
    const userIP = this.extractUserIP(socket);
    const userKey = `${userIP}-${socket.id}`;
    
    // Rate limiting check
    if (connectionService.isRateLimited(userKey)) {
      logger.warn('Rate limit exceeded', { userKey, worker: process.pid });
      socket.emit('rate_limited', { message: 'Too many connections' });
      socket.disconnect(true);
      return;
    }

    // Connection metrics
    metrics.activeConnections.inc({ worker: process.pid });
    metrics.signalingMessages.inc({ type: 'connect', worker: process.pid });

    logger.info('User connected', {
      userKey,
      socketId: socket.id,
      userAgent: socket.handshake.headers['user-agent'],
      worker: process.pid
    });

    // Register connection
    await connectionService.registerConnection(userKey, socket.id);
    
    // Log connection event
    kafkaService.logEvent('connect', {
      userKey,
      socketId: socket.id,
      userAgent: socket.handshake.headers['user-agent'],
      connectionTime: Date.now() - startTime
    });

    // Setup event handlers
    this.setupEventHandlers(socket, userKey);
  }

  setupEventHandlers(socket, userKey) {
    // Matchmaking
    socket.on('find_match', async () => {
      await matchmakingService.findMatch(socket, userKey, this.io);
    });

    socket.on('cancel_match', async () => {
      await matchmakingService.cancelMatch(userKey);
      socket.emit('match_cancelled');
    });

    // WebRTC Signaling
    socket.on('webrtc_offer', async (data) => {
      await signalingService.forwardSignal(socket, userKey, 'webrtc_offer', data);
    });

    socket.on('webrtc_answer', async (data) => {
      await signalingService.forwardSignal(socket, userKey, 'webrtc_answer', data);
    });

    socket.on('webrtc_ice_candidate', async (data) => {
      await signalingService.forwardSignal(socket, userKey, 'webrtc_ice_candidate', data);
    });

    // Connection quality monitoring
    socket.on('connection_quality', (data) => {
      metrics.connectionQuality.observe(data.rtt || 0);
      kafkaService.logEvent('connection_quality', {
        userKey,
        ...data
      });
    });

    // Error handling
    socket.on('webrtc_error', (error) => {
      logger.error('WebRTC error from client', {
        userKey,
        error: error.message || error,
        worker: process.pid
      });
      
      metrics.errorRate.inc({ type: 'webrtc_client', worker: process.pid });
      kafkaService.logEvent('webrtc_error', { userKey, error });
    });

    socket.on('error', (error) => {
      logger.error('Socket error', {
        userKey,
        error: error.message || error,
        worker: process.pid
      });
      
      metrics.errorRate.inc({ type: 'socket', worker: process.pid });
    });

    // Disconnect handling
    socket.on('disconnect', async (reason) => {
      await this.handleDisconnect(socket, userKey, reason);
    });

    // Heartbeat for connection health
    socket.on('ping', () => {
      socket.emit('pong', { timestamp: Date.now() });
    });
  }

  async handleDisconnect(socket, userKey, reason) {
    try {
      logger.info('User disconnected', {
        userKey,
        reason,
        worker: process.pid
      });

      // Clean up matchmaking
      await matchmakingService.handleDisconnect(userKey, this.io);
      
      // Clean up connection
      await connectionService.handleDisconnect(userKey);

      // Update metrics
      metrics.activeConnections.dec({ worker: process.pid });
      metrics.signalingMessages.inc({ type: 'disconnect', worker: process.pid });

      // Log disconnect event
      kafkaService.logEvent('disconnect', {
        userKey,
        reason,
        sessionDuration: Date.now() - socket.handshake.time
      });

    } catch (error) {
      logger.error('Error handling disconnect', {
        error: error.message,
        userKey,
        worker: process.pid
      });
      
      metrics.errorRate.inc({ type: 'disconnect', worker: process.pid });
    }
  }

  extractUserIP(socket) {
    return (
      socket.handshake.headers['x-forwarded-for'] ||
      socket.handshake.headers['x-real-ip'] ||
      socket.conn.remoteAddress ||
      socket.handshake.address
    )?.toString().split(',')[0]?.trim() || 'unknown';
  }

  async shutdown() {
    if (this.io) {
      logger.info('Shutting down Socket.IO server', { worker: process.pid });
      
      // Disconnect all clients
      this.io.emit('server_shutdown', { 
        message: 'Server is shutting down',
        timestamp: Date.now()
      });

      // Close server
      this.io.close();
      this.isInitialized = false;
    }

    // Shutdown services
    await connectionService.shutdown();
    await kafkaService.shutdown();
    await redisService.shutdown();
  }

  getIO() {
    return this.io;
  }
}

module.exports = new SocketHandler();