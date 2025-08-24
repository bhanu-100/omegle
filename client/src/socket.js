// =========================
// src/socket.js
// =========================
import { io } from 'socket.io-client';

// Read backend URL from environment variables
const BACKEND_URL = import.meta.env.VITE_API_URL || 
                   import.meta.env.VITE_SERVER_URL || 
                   (typeof window !== 'undefined' 
                     ? `${window.location.protocol}//${window.location.hostname}:3000`
                     : 'http://localhost:3000');

console.info('[Socket] Backend URL:', BACKEND_URL);

// Create socket instance with production-optimized settings
const rawSocket = io(BACKEND_URL, {
  // Connection settings
  autoConnect: false,
  forceNew: false,
  
  // Transport configuration - WebSocket first, polling fallback
  transports: ['websocket', 'polling'],
  upgrade: true,
  rememberUpgrade: true,
  
  // Timeout settings
  timeout: 20000,           // Connection timeout (20s)
  
  // Reconnection settings - exponential backoff
  reconnection: true,
  reconnectionAttempts: 10, // More attempts for production
  reconnectionDelay: 1000,  // Start with 1s
  reconnectionDelayMax: 10000, // Max 10s between attempts
  randomizationFactor: 0.3, // Add randomness to prevent thundering herd
  
  // Performance settings
  maxHttpBufferSize: 1e6,   // 1MB buffer
  
  // Query parameters (useful for authentication/routing)
  query: {
    // Add any query params you need
    timestamp: Date.now(),
    // userAgent: navigator.userAgent
  }
});

// Connection state management
let connected = false;
let connecting = false;
let reconnectAttempt = 0;

// Smart message queue for offline scenarios
const emitQueue = [];
const MAX_QUEUE_SIZE = 100; // Prevent memory leaks

// Performance monitoring
const stats = {
  connectTime: null,
  reconnects: 0,
  messagesQueued: 0,
  messagesSent: 0
};

// Enhanced connection handler
rawSocket.on('connect', () => {
  connected = true;
  connecting = false;
  stats.connectTime = Date.now();
  
  if (reconnectAttempt > 0) {
    stats.reconnects++;
    console.info(`[Socket] Reconnected after ${reconnectAttempt} attempts`);
  } else {
    console.info('[Socket] Connected:', rawSocket.id);
  }
  
  reconnectAttempt = 0;
  
  // Flush message queue efficiently
  const queueLength = emitQueue.length;
  while (emitQueue.length > 0) {
    const { event, payload, timestamp } = emitQueue.shift();
    
    // Skip very old messages (older than 30 seconds)
    if (Date.now() - timestamp > 30000) {
      console.warn(`[Socket] Skipping old queued message: ${event}`);
      continue;
    }
    
    rawSocket.emit(event, payload);
    stats.messagesSent++;
  }
  
  if (queueLength > 0) {
    console.info(`[Socket] Flushed ${queueLength} queued messages`);
  }
});

// Disconnection handler
rawSocket.on('disconnect', (reason) => {
  connected = false;
  connecting = false;
  
  console.info('[Socket] Disconnected:', reason);
  
  // Log different disconnect reasons for debugging
  switch (reason) {
    case 'io server disconnect':
      console.warn('[Socket] Server forcefully disconnected client');
      break;
    case 'io client disconnect':
      console.info('[Socket] Client initiated disconnect');
      break;
    case 'ping timeout':
      console.warn('[Socket] Connection lost - ping timeout');
      break;
    case 'transport close':
      console.warn('[Socket] Transport closed');
      break;
    case 'transport error':
      console.error('[Socket] Transport error occurred');
      break;
  }
});

// Connection error handler
rawSocket.on('connect_error', (err) => {
  connected = false;
  connecting = false;
  reconnectAttempt++;
  
  console.warn(`[Socket] Connection error (attempt ${reconnectAttempt}):`, err.message);
  
  // Detailed error logging for debugging
  if (err.description) {
    console.warn('[Socket] Error details:', err.description);
  }
  
  if (err.type === 'TransportError') {
    console.warn('[Socket] Transport error - network may be unreliable');
  }
});

// Reconnection attempt logging
rawSocket.on('reconnect_attempt', (attemptNumber) => {
  connecting = true;
  console.info(`[Socket] Reconnection attempt ${attemptNumber}`);
});

rawSocket.on('reconnect_failed', () => {
  console.error('[Socket] Reconnection failed - giving up');
  connecting = false;
});

// Rate limiting detection
rawSocket.on('rate_limited', () => {
  console.warn('[Socket] Rate limited by server');
});

// Enhanced emit function with intelligent queuing
function safeEmit(event, payload) {
  const timestamp = Date.now();
  
  if (connected && rawSocket.connected) {
    rawSocket.emit(event, payload);
    stats.messagesSent++;
    return true;
  }
  
  // Don't queue if we're not even trying to connect
  if (!connecting && !rawSocket.disconnected) {
    console.warn(`[Socket] Not connected and not connecting - dropping message: ${event}`);
    return false;
  }
  
  // Implement queue size limit to prevent memory leaks
  if (emitQueue.length >= MAX_QUEUE_SIZE) {
    // Remove oldest message to make room
    const dropped = emitQueue.shift();
    console.warn(`[Socket] Queue full, dropping old message: ${dropped.event}`);
  }
  
  emitQueue.push({ event, payload, timestamp });
  stats.messagesQueued++;
  
  console.info(`[Socket] Queued message: ${event} (queue size: ${emitQueue.length})`);
  return false;
}

// Connection health monitoring
function getConnectionHealth() {
  return {
    connected: connected && rawSocket.connected,
    connecting: connecting,
    socketId: rawSocket.id,
    transport: rawSocket.io?.engine?.transport?.name,
    queueSize: emitQueue.length,
    stats: { ...stats },
    ping: rawSocket.ping || null
  };
}

// Utility function to clear the queue (useful for logout scenarios)
function clearQueue() {
  const cleared = emitQueue.length;
  emitQueue.length = 0;
  console.info(`[Socket] Cleared ${cleared} queued messages`);
  return cleared;
}

// Enhanced socket interface with additional utilities
export default {
  // Core Socket.IO methods
  connect: () => {
    if (!connected && !connecting) {
      connecting = true;
      console.info('[Socket] Initiating connection...');
      rawSocket.connect();
    }
  },
  
  disconnect: () => {
    console.info('[Socket] Disconnecting...');
    clearQueue(); // Clear queue on manual disconnect
    rawSocket.disconnect();
  },
  
  // Event handling
  on: (event, callback) => rawSocket.on(event, callback),
  off: (event, callback) => rawSocket.off(event, callback),
  once: (event, callback) => rawSocket.once(event, callback),
  
  // Enhanced emit with return value
  emit: (event, payload) => safeEmit(event, payload),
  
  // Connection state
  get connected() { return connected && rawSocket.connected; },
  get connecting() { return connecting; },
  get disconnected() { return !connected && !connecting; },
  
  // Socket information
  id: () => rawSocket.id,
  
  // Utility methods
  getHealth: getConnectionHealth,
  clearQueue,
  getQueueSize: () => emitQueue.length,
  getStats: () => ({ ...stats }),
  
  // Advanced methods
  volatile: {
    emit: (event, payload) => {
      // Volatile messages are not queued - they're dropped if not connected
      if (connected && rawSocket.connected) {
        rawSocket.volatile.emit(event, payload);
        return true;
      }
      console.debug(`[Socket] Dropping volatile message: ${event}`);
      return false;
    }
  },
  
  // Raw socket access (use carefully)
  raw: rawSocket,
  
  // Namespace support (if you need it later)
  namespace: (nsp) => {
    const namespacedSocket = rawSocket.io.socket(nsp);
    return {
      on: namespacedSocket.on.bind(namespacedSocket),
      emit: namespacedSocket.emit.bind(namespacedSocket),
      disconnect: namespacedSocket.disconnect.bind(namespacedSocket)
    };
  }
};

// Global error handling for debugging
if (typeof window !== 'undefined') {
  window.socketDebug = {
    getHealth: getConnectionHealth,
    getStats: () => stats,
    clearQueue,
    forceReconnect: () => {
      rawSocket.disconnect();
      setTimeout(() => rawSocket.connect(), 1000);
    }
  };
}