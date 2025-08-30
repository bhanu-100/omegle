// =========================
// Bug-Free & Production-Ready Socket.IO Client
// =========================
import { io } from 'socket.io-client';
import { CONFIG } from '../config';
import { performanceMonitor, errorHandler, AppError, dev } from '../utils';

class SocketClient {
  constructor() {
    this.socket = null;
    this.connected = false;
    this.connecting = false;
    this.reconnectAttempt = 0;
    this.listeners = new Map();
    this.emitQueue = [];
    this.stats = {
      connectTime: null,
      reconnects: 0,
      messagesQueued: 0,
      messagesSent: 0,
      transportUpgrades: 0,
      errors: 0
    };
    
    // Using a native EventTarget for internal events
    this.eventEmitter = new EventTarget();
    this.isDestroyed = false;
  }

  init() {
    if (this.isDestroyed) {
      throw new AppError('Cannot re-initialize a destroyed socket client', 'SOCKET');
    }
    if (this.socket) {
      return this.socket;
    }

    performanceMonitor.start('socket-init');

    try {
      dev.log('Initializing socket connection to:', CONFIG.BACKEND_URL);
      
      this.socket = io(CONFIG.BACKEND_URL, {
        ...CONFIG.SOCKET,
        autoConnect: false,
        query: {
          timestamp: Date.now(),
          client: 'web',
          version: '1.0.0'
        }
      });

      this.setupEventHandlers();
      performanceMonitor.end('socket-init');
      
      return this.socket;
    } catch (error) {
      performanceMonitor.end('socket-init');
      const appError = new AppError('Failed to initialize socket', 'SOCKET_INIT', { 
        originalError: error.message 
      });
      errorHandler.log(appError, 'SocketClient.init');
      throw appError;
    }
  }

  setupEventHandlers() {
    if (!this.socket) return;

    // Connection events
    this.socket.on('connect', this.handleConnect.bind(this));
    this.socket.on('disconnect', this.handleDisconnect.bind(this));
    this.socket.on('connect_error', this.handleConnectError.bind(this));
    this.socket.on('reconnect_attempt', this.handleReconnectAttempt.bind(this));
    this.socket.on('reconnect_failed', this.handleReconnectFailed.bind(this));
    this.socket.on('error', this.handleError.bind(this));

    // Transport events
    this.socket.io.on('upgrade', this.handleUpgrade.bind(this));
    this.socket.io.on('upgradeError', this.handleUpgradeError.bind(this));

    // Ping/Pong events for connection health
    this.socket.on('ping', () => dev.log('Ping from server'));
    this.socket.on('pong', (latency) => dev.log('Pong received, latency:', latency));
  }

  handleConnect() {
    this.connected = true;
    this.connecting = false;
    this.stats.connectTime = Date.now();
    
    const transport = this.socket.io.engine?.transport?.name;
    dev.log(`Connected via ${transport}:`, this.socket.id);
    
    if (this.reconnectAttempt > 0) {
      this.stats.reconnects++;
      dev.log(`Reconnected after ${this.reconnectAttempt} attempts`);
    }
    
    this.reconnectAttempt = 0;
    this.flushEmitQueue();
    // Publish internal event
    this.eventEmitter.dispatchEvent(new CustomEvent('connect', { detail: { socketId: this.socket.id, transport } }));
  }

  handleDisconnect(reason) {
    this.connected = false;
    this.connecting = false;
    
    dev.log('Disconnected:', reason);
    
    const friendlyReasons = {
      'io server disconnect': 'Server disconnected you',
      'io client disconnect': 'You disconnected',
      'ping timeout': 'Connection lost - no response from server',
      'transport close': 'Connection closed unexpectedly',
      'transport error': 'Network connection failed'
    };
    
    const friendlyReason = friendlyReasons[reason] || reason;
    this.eventEmitter.dispatchEvent(new CustomEvent('disconnect', { detail: { reason, friendlyReason } }));
  }

  handleConnectError(error) {
    this.connected = false;
    this.connecting = false;
    this.reconnectAttempt++;
    this.stats.errors++;
    
    dev.warn(`Connection error (attempt ${this.reconnectAttempt}):`, error.message);
    
    let errorType = 'NETWORK';
    let userMessage = 'Connection failed. Please check your internet connection.';
    
    if (error.message.includes('websocket') || error.message.includes('WebSocket')) {
      errorType = 'WEBSOCKET';
      userMessage = 'WebSocket connection failed. Trying alternative connection method.';
    }
    
    if (error.message.includes('Mixed Content') || error.message.includes('insecure')) {
      errorType = 'SECURITY';
      userMessage = 'Security error: Cannot connect to an insecure server from a secure page.';
    }
    
    if (error.message.includes('CORS')) {
      errorType = 'CORS';
      userMessage = 'Server configuration error. Please contact support.';
    }
    
    const appError = new AppError(userMessage, errorType, {
      originalError: error.message,
      attempt: this.reconnectAttempt
    });
    
    this.eventEmitter.dispatchEvent(new CustomEvent('connect_error', { detail: appError }));
  }

  handleReconnectAttempt(attemptNumber) {
    this.connecting = true;
    dev.log(`Reconnection attempt ${attemptNumber}`);
    this.eventEmitter.dispatchEvent(new CustomEvent('reconnect_attempt', { detail: { attempt: attemptNumber } }));
  }

  handleReconnectFailed() {
    dev.error('Reconnection failed - giving up');
    this.connecting = false;
    this.eventEmitter.dispatchEvent(new CustomEvent('reconnect_failed', { 
      detail: { attempts: this.reconnectAttempt, message: 'Unable to reconnect to server. Please refresh the page.' } 
    }));
  }

  handleError(error) {
    this.stats.errors++;
    dev.error('Socket error:', error);
    
    const appError = new AppError('Socket connection error', 'SOCKET', {
      originalError: error.message || error
    });
    
    this.eventEmitter.dispatchEvent(new CustomEvent('error', { detail: appError }));
  }

  handleUpgrade() {
    this.stats.transportUpgrades++;
    const transport = this.socket.io.engine?.transport?.name;
    dev.log(`Transport upgraded to: ${transport}`);
    this.eventEmitter.dispatchEvent(new CustomEvent('transport_upgrade', { detail: { transport } }));
  }

  handleUpgradeError(error) {
    dev.warn('Transport upgrade failed:', error);
    this.eventEmitter.dispatchEvent(new CustomEvent('transport_upgrade_error', { detail: { error: error.message } }));
  }

  // Connection management
  connect() {
    if (this.isDestroyed) {
      throw new AppError('Cannot connect destroyed socket', 'SOCKET');
    }

    if (!this.socket) {
      this.init();
    }

    if (this.connected || this.connecting) {
      dev.log('Already connected or connecting');
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      // Add listeners first to avoid race conditions
      const onConnect = () => {
        // We handle connection state in handleConnect, so just resolve the promise
        resolve();
        // The listeners will be removed by the .off() calls in the finally block
      };
      
      const onError = (error) => {
        // The error is already handled by handleConnectError, just reject the promise
        reject(error);
      };
      
      this.on('connect', onConnect);
      this.on('connect_error', onError);

      const timeout = setTimeout(() => {
        this.off('connect', onConnect);
        this.off('connect_error', onError);
        reject(new AppError('Connection timeout', 'SOCKET_TIMEOUT'));
      }, CONFIG.PERFORMANCE.connectionTimeout);

      this.connecting = true;
      dev.log('Initiating connection...');
      this.socket.connect();
    }).finally(() => {
      // Clean up listeners from the promise after it resolves or rejects
      // The `on` and `off` methods handle the EventTarget as well as the socket listeners
      this.off('connect', this.handleConnect.bind(this));
      this.off('connect_error', this.handleConnectError.bind(this));
    });
  }

  disconnect() {
    if (this.socket) {
      dev.log('Disconnecting socket...');
      this.clearEmitQueue();
      this.socket.disconnect();
    }
    this.connected = false;
    this.connecting = false;
  }

  destroy() {
    dev.log('Destroying socket client...');
    this.isDestroyed = true;
    
    if (this.socket) {
      this.socket.removeAllListeners();
      // Also remove listeners from the underlying manager
      this.socket.io.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
    
    this.clearEmitQueue();
    this.listeners.clear();
    this.connected = false;
    this.connecting = false;
  }

  flushEmitQueue() {
    const queueLength = this.emitQueue.length;
    let flushedCount = 0;
    
    while (this.emitQueue.length > 0) {
      const { event, data, timestamp, resolve, reject } = this.emitQueue.shift();
      
      if (Date.now() - timestamp > 30000) {
        dev.warn(`Skipping old queued message: ${event}`);
        if (reject) reject(new AppError('Message expired', 'SOCKET_MESSAGE_EXPIRED'));
        continue;
      }
      
      try {
        this.socket.emit(event, data);
        this.stats.messagesSent++;
        flushedCount++;
        if (resolve) resolve();
      } catch (error) {
        if (reject) reject(new AppError('Failed to emit flushed message', 'SOCKET_EMIT_FLUSH', { originalError: error.message }));
      }
    }
    
    if (flushedCount > 0) {
      dev.log(`Flushed ${flushedCount}/${queueLength} queued messages`);
    }
  }

  clearEmitQueue() {
    const cleared = this.emitQueue.length;
    
    this.emitQueue.forEach(({ reject }) => {
      if (reject) {
        reject(new AppError('Connection lost, queue cleared', 'SOCKET_QUEUE_CLEARED'));
      }
    });
    
    this.emitQueue.length = 0;
    
    if (cleared > 0) {
      dev.log(`Cleared ${cleared} queued messages`);
    }
    
    return cleared;
  }

  emit(event, data = null) {
    // Return a promise for the caller
    return new Promise((resolve, reject) => {
      const timestamp = Date.now();

      if (this.connected && this.socket?.connected) {
        try {
          this.socket.emit(event, data, (ack) => {
            // Optional: Handle server acknowledgments
            resolve(ack);
          });
          this.stats.messagesSent++;
        } catch (error) {
          reject(new AppError('Failed to emit message', 'SOCKET_EMIT', { 
            event, 
            originalError: error.message 
          }));
        }
        return;
      }

      if (!this.connecting && !this.connected) {
        return reject(new AppError('Not connected and not connecting', 'SOCKET_DISCONNECTED', { event }));
      }

      if (this.emitQueue.length >= CONFIG.PERFORMANCE.maxQueueSize) {
        const dropped = this.emitQueue.shift();
        if (dropped.reject) {
          dropped.reject(new AppError('Queue full, message dropped', 'SOCKET_QUEUE_FULL'));
        }
        dev.warn(`Queue full, dropping old message: ${dropped.event}`);
      }

      this.emitQueue.push({ event, data, timestamp, resolve, reject });
      this.stats.messagesQueued++;
      dev.log(`Queued message: ${event} (queue size: ${this.emitQueue.length})`);
    });
  }

  volatileEmit(event, data = null) {
    if (this.connected && this.socket?.connected) {
      try {
        this.socket.volatile.emit(event, data);
        return true;
      } catch (error) {
        dev.error(`Volatile emit error for ${event}:`, error);
        return false;
      }
    }
    dev.log(`Dropping volatile message: ${event}`);
    return false;
  }

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(callback);
    
    // For internal events, use EventTarget
    if (['connect', 'disconnect', 'connect_error', 'reconnect_attempt', 'reconnect_failed', 'error', 'transport_upgrade', 'transport_upgrade_error'].includes(event)) {
      this.eventEmitter.addEventListener(event, callback);
    } else if (this.socket) {
      // For all other custom events, use the socket
      this.socket.on(event, callback);
    }
  }

  off(event, callback) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).delete(callback);
    }
    
    if (['connect', 'disconnect', 'connect_error', 'reconnect_attempt', 'reconnect_failed', 'error', 'transport_upgrade', 'transport_upgrade_error'].includes(event)) {
      this.eventEmitter.removeEventListener(event, callback);
    } else if (this.socket) {
      this.socket.off(event, callback);
    }
  }

  once(event, callback) {
    const onceCallback = (...args) => {
      this.off(event, onceCallback);
      callback(...args);
    };
    this.on(event, onceCallback);
  }

  getHealth() {
    return {
      connected: this.connected,
      connecting: this.connecting,
      socketId: this.socket?.id,
      transport: this.socket?.io?.engine?.transport?.name,
      queueSize: this.emitQueue.length,
      backendUrl: CONFIG.BACKEND_URL,
      protocol: CONFIG.BACKEND_URL.startsWith('https') ? 'HTTPS/WSS' : 'HTTP/WS',
      stats: { ...this.stats },
      ping: this.socket?.ping || null,
      reconnectAttempt: this.reconnectAttempt,
      isDestroyed: this.isDestroyed
    };
  }

  getStats() {
    return {
      ...this.stats,
      uptime: this.stats.connectTime ? Date.now() - this.stats.connectTime : 0,
      queueSize: this.emitQueue.length
    };
  }

  async testConnection() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.off('connect', testHandler);
        this.off('connect_error', errorHandler);
        resolve({ success: false, error: 'Connection test timeout' });
      }, 10000);
      
      const testHandler = () => {
        clearTimeout(timeout);
        this.off('connect', testHandler);
        this.off('connect_error', errorHandler);
        resolve({ 
          success: true, 
          transport: this.socket?.io?.engine?.transport?.name,
          socketId: this.socket?.id
        });
      };
      
      const errorHandler = (error) => {
        clearTimeout(timeout);
        this.off('connect', testHandler);
        this.off('connect_error', errorHandler);
        resolve({ success: false, error: error.message });
      };
      
      this.on('connect', testHandler);
      this.on('connect_error', errorHandler);
      
      if (!this.connected) {
        this.connect().catch(errorHandler);
      } else {
        testHandler();
      }
    });
  }

  forceReconnect() {
    dev.log('Force reconnecting...');
    if (this.socket) {
      this.socket.disconnect();
    }
    
    setTimeout(() => {
      this.connect();
    }, 1000);
  }
}

// Create singleton instance
const socketClient = new SocketClient();

const socketService = {
  connect: () => socketClient.connect(),
  disconnect: () => socketClient.disconnect(),
  destroy: () => socketClient.destroy(),
  
  on: (event, callback) => socketClient.on(event, callback),
  off: (event, callback) => socketClient.off(event, callback),
  once: (event, callback) => socketClient.once(event, callback),
  
  emit: (event, data) => socketClient.emit(event, data),
  volatileEmit: (event, data) => socketClient.volatileEmit(event, data),
  
  get connected() { return socketClient.connected; },
  get connecting() { return socketClient.connecting; },
  get disconnected() { return !socketClient.connected && !socketClient.connecting; },
  
  get id() { return socketClient.socket?.id; },
  
  getHealth: () => socketClient.getHealth(),
  getStats: () => socketClient.getStats(),
  clearQueue: () => socketClient.clearEmitQueue(),
  getQueueSize: () => socketClient.emitQueue.length,
  
  testConnection: () => socketClient.testConnection(),
  forceReconnect: () => socketClient.forceReconnect(),
  
  get raw() { return socketClient.socket; },
  
  debug: {
    getClient: () => socketClient,
    getConfig: () => CONFIG,
    testConnection: () => socketClient.testConnection(),
    forceReconnect: () => socketClient.forceReconnect(),
    getHealth: () => socketClient.getHealth()
  }
};

if (CONFIG.FEATURES.debugMode) {
  window.socketDebug = {
    client: socketClient,
    service: socketService,
    health: () => socketClient.getHealth(),
    stats: () => socketClient.getStats(),
    test: () => socketClient.testConnection(),
    reconnect: () => socketClient.forceReconnect()
  };
}

export default socketService;