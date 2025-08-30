// =========================
// src/socket.js - Production Fixed Version
// =========================
import { io } from 'socket.io-client';

// Smart backend URL resolution with protocol detection
const getBackendUrl = () => {
  // Environment variables take precedence
  if (import.meta.env.VITE_API_URL) {
    return import.meta.env.VITE_API_URL;
  }
  
  if (import.meta.env.VITE_SERVER_URL) {
    return import.meta.env.VITE_SERVER_URL;
  }
  
  // Auto-detect protocol and construct URL
  if (typeof window !== 'undefined') {
    const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
    const hostname = window.location.hostname;
    
    // For Vercel/Netlify production, use same origin with correct protocol
    if (hostname.includes('.vercel.app') || hostname.includes('.netlify.app')) {
      return `${protocol}//${hostname}`;
    }
    
    // For development with custom port
    return `${protocol}//${hostname}:3000`;
  }
  
  // Fallback for server-side rendering
  return 'http://localhost:3000';
};

const BACKEND_URL = getBackendUrl();

console.info('[Socket] Backend URL:', BACKEND_URL);
console.info('[Socket] Protocol detected:', BACKEND_URL.startsWith('https') ? 'HTTPS (will use WSS)' : 'HTTP (will use WS)');

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
  
  // CORS and security settings for production
  withCredentials: false,   // Set to true if you need cookies/auth
  
  // Query parameters (useful for authentication/routing)
  query: {
    timestamp: Date.now(),
    // Add client info for debugging
    client: 'web',
    // userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown'
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
  messagesSent: 0,
  transportUpgrades: 0
};

// Enhanced connection handler
rawSocket.on('connection', () => {
  connected = true;
  connecting = false;
  stats.connectTime = Date.now();
  
  // Log transport info for debugging
  const transport = rawSocket.io?.engine?.transport?.name;
  console.info(`[Socket] Connected via ${transport}:`, rawSocket.id);
  
  if (reconnectAttempt > 0) {
    stats.reconnects++;
    console.info(`[Socket] Reconnected after ${reconnectAttempt} attempts`);
  }
  
  reconnectAttempt = 0;
  
  // Flush message queue efficiently
  const queueLength = emitQueue.length;
  let flushedCount = 0;
  
  while (emitQueue.length > 0) {
    const { event, payload, timestamp } = emitQueue.shift();
    
    // Skip very old messages (older than 30 seconds)
    if (Date.now() - timestamp > 30000) {
      console.warn(`[Socket] Skipping old queued message: ${event}`);
      continue;
    }
    
    rawSocket.emit(event, payload);
    stats.messagesSent++;
    flushedCount++;
  }
  
  if (flushedCount > 0) {
    console.info(`[Socket] Flushed ${flushedCount}/${queueLength} queued messages`);
  }
});

// Transport upgrade handler
rawSocket.on('upgrade', () => {
  stats.transportUpgrades++;
  const newTransport = rawSocket.io?.engine?.transport?.name;
  console.info(`[Socket] Transport upgraded to: ${newTransport}`);
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
    default:
      console.warn(`[Socket] Disconnected with reason: ${reason}`);
  }
});

// Connection error handler with enhanced debugging
rawSocket.on('connect_error', (err) => {
  connected = false;
  connecting = false;
  reconnectAttempt++;
  
  console.warn(`[Socket] Connection error (attempt ${reconnectAttempt}):`, err.message);
  
  // Enhanced error diagnosis
  if (err.description) {
    console.warn('[Socket] Error details:', err.description);
  }
  
  if (err.type === 'TransportError') {
    console.warn('[Socket] Transport error - network may be unreliable');
    
    // Specific HTTPS/WSS guidance
    if (err.message.includes('websocket') || err.message.includes('WebSocket')) {
      console.error('[Socket] WebSocket connection failed. If on HTTPS, ensure server supports WSS');
    }
  }
  
  // Mixed content error detection
  if (err.message.includes('Mixed Content') || err.message.includes('insecure')) {
    console.error('[Socket] SECURITY ERROR: Attempting HTTP connection from HTTPS page');
    console.error('[Socket] Fix: Update server URL to use HTTPS/WSS');
  }
});

// Reconnection attempt logging
rawSocket.on('reconnect_attempt', (attemptNumber) => {
  connecting = true;
  console.info(`[Socket] Reconnection attempt ${attemptNumber}`);
});

rawSocket.on('reconnect_failed', () => {
  console.error('[Socket] Reconnection failed - giving up');
  console.error('[Socket] Check network connection and server availability');
  connecting = false;
});

// Production error monitoring
rawSocket.on('error', (error) => {
  console.error('[Socket] Socket.IO error:', error);
});

// Rate limiting detection
rawSocket.on('rate_limited', () => {
  console.warn('[Socket] Rate limited by server');
});

// Enhanced emit function with intelligent queuing
function safeEmit(event, payload) {
  const timestamp = Date.now();
  
  if (connected && rawSocket.connected) {
    try {
      rawSocket.emit(event, payload);
      stats.messagesSent++;
      return true;
    } catch (err) {
      console.error(`[Socket] Emit error for event ${event}:`, err);
      return false;
    }
  }
  
  // Don't queue if we're not even trying to connect
  if (!connecting && rawSocket.disconnected) {
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
  
  console.debug(`[Socket] Queued message: ${event} (queue size: ${emitQueue.length})`);
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
    backendUrl: BACKEND_URL,
    protocol: BACKEND_URL.startsWith('https') ? 'HTTPS/WSS' : 'HTTP/WS',
    stats: { ...stats },
    ping: rawSocket.ping || null,
    readyState: rawSocket.connected ? 'OPEN' : 'CLOSED'
  };
}

// Utility function to clear the queue (useful for logout scenarios)
function clearQueue() {
  const cleared = emitQueue.length;
  emitQueue.length = 0;
  console.info(`[Socket] Cleared ${cleared} queued messages`);
  return cleared;
}

// Enhanced connection method with retry logic
function connectWithRetry() {
  if (connected || connecting) {
    console.debug('[Socket] Already connected or connecting');
    return;
  }
  
  connecting = true;
  console.info('[Socket] Initiating connection to:', BACKEND_URL);
  
  try {
    rawSocket.connect();
  } catch (err) {
    console.error('[Socket] Connection initiation failed:', err);
    connecting = false;
  }
}

// Enhanced socket interface with additional utilities
export default {
  // Core Socket.IO methods
  connect: connectWithRetry,
  
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
        try {
          rawSocket.volatile.emit(event, payload);
          return true;
        } catch (err) {
          console.error(`[Socket] Volatile emit error for ${event}:`, err);
          return false;
        }
      }
      console.debug(`[Socket] Dropping volatile message: ${event}`);
      return false;
    }
  },
  
  // Production debugging helpers
  debug: {
    getUrl: () => BACKEND_URL,
    getProtocol: () => BACKEND_URL.startsWith('https') ? 'HTTPS/WSS' : 'HTTP/WS',
    forceReconnect: () => {
      console.info('[Socket] Force reconnecting...');
      rawSocket.disconnect();
      setTimeout(() => connectWithRetry(), 1000);
    },
    testConnection: async () => {
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          resolve({ success: false, error: 'Connection test timeout' });
        }, 10000);
        
        const testHandler = () => {
          clearTimeout(timeout);
          rawSocket.off('connect', testHandler);
          rawSocket.off('connect_error', errorHandler);
          resolve({ success: true, transport: rawSocket.io?.engine?.transport?.name });
        };
        
        const errorHandler = (err) => {
          clearTimeout(timeout);
          rawSocket.off('connect', testHandler);
          rawSocket.off('connect_error', errorHandler);
          resolve({ success: false, error: err.message });
        };
        
        rawSocket.on('connect', testHandler);
        rawSocket.on('connect_error', errorHandler);
        
        if (!connected) {
          connectWithRetry();
        } else {
          testHandler();
        }
      });
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

// Enhanced global debugging for production
if (typeof window !== 'undefined') {
  window.socketDebug = {
    getHealth: getConnectionHealth,
    getStats: () => stats,
    clearQueue,
    testConnection: () => {
      console.log('Backend URL:', BACKEND_URL);
      console.log('Protocol:', BACKEND_URL.startsWith('https') ? 'HTTPS/WSS' : 'HTTP/WS');
      console.log('Current State:', getConnectionHealth());
      return getConnectionHealth();
    },
    forceReconnect: () => {
      rawSocket.disconnect();
      setTimeout(() => connectWithRetry(), 1000);
    }
  };
}