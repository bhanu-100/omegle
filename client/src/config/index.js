// =========================
// Configuration Management
// =========================

// Environment variable validation
const requiredEnvVars = {
  VITE_API_URL: 'Backend API URL is required'
};

// Validate required environment variables
Object.entries(requiredEnvVars).forEach(([key, message]) => {
  if (!import.meta.env[key]) {
    console.error(`❌ ${message}: ${key}`);
    throw new Error(`Missing required environment variable: ${key}`);
  }
});

// Backend URL resolution with intelligent fallback
const getBackendUrl = () => {
  // Primary environment variable
  if (import.meta.env.VITE_API_URL) {
    return import.meta.env.VITE_API_URL;
  }
  
  // Fallback environment variable
  if (import.meta.env.VITE_SERVER_URL) {
    return import.meta.env.VITE_SERVER_URL;
  }
  
  // Auto-detection for development
  if (typeof window !== 'undefined') {
    const { protocol, hostname } = window.location;
    
    // Production environment detection
    if (hostname.includes('.vercel.app') || 
        hostname.includes('.netlify.app') ||
        hostname.includes('.herokuapp.com')) {
      return `${protocol}//${hostname}`;
    }
    
    // Development fallback
    const port = import.meta.env.VITE_DEV_SERVER_PORT || '3000';
    return `${protocol}//${hostname}:${port}`;
  }
  
  // Server-side rendering fallback
  return 'http://localhost:3000';
};

// WebRTC Configuration with production-grade STUN/TURN servers
const getICEServers = () => {
  const servers = [
    { urls: import.meta.env.VITE_STUN_SERVER_1 || 'stun:stun.l.google.com:19302' },
    { urls: import.meta.env.VITE_STUN_SERVER_2 || 'stun:stun1.l.google.com:19302' },
    { urls: import.meta.env.VITE_STUN_SERVER_3 || 'stun:stun2.l.google.com:19302' },
    { urls: import.meta.env.VITE_STUN_SERVER_4 || 'stun:stun.cloudflare.com:3478' }
  ];

  // Add TURN servers if configured (recommended for production)
  if (import.meta.env.VITE_TURN_SERVER_URL) {
    servers.push({
      urls: import.meta.env.VITE_TURN_SERVER_URL,
      username: import.meta.env.VITE_TURN_USERNAME,
      credential: import.meta.env.VITE_TURN_CREDENTIAL
    });
  }

  return servers;
};

// Application Configuration
export const CONFIG = {
  // Server Configuration
  BACKEND_URL: getBackendUrl(),
  
  // WebRTC Configuration
  ICE_SERVERS: {
    iceServers: getICEServers(),
    iceCandidatePoolSize: 10,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
  },
  
  // Media Constraints for optimal performance and compatibility
  MEDIA_CONSTRAINTS: {
    video: {
      width: { min: 320, ideal: 640, max: 1280 },
      height: { min: 240, ideal: 480, max: 720 },
      frameRate: { min: 15, ideal: 24, max: 30 },
      facingMode: 'user'
    },
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      sampleRate: 44100,
      channelCount: 1
    }
  },
  
  // Socket Configuration
  SOCKET: {
    timeout: 20000,
    reconnectionAttempts: parseInt(import.meta.env.VITE_MAX_RECONNECT_ATTEMPTS) || 10,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
    randomizationFactor: 0.3,
    transports: ['websocket', 'polling'],
    upgrade: true,
    rememberUpgrade: true,
    forceNew: false,
    maxHttpBufferSize: 1e6
  },
  
  // Performance Configuration
  PERFORMANCE: {
    maxMessages: 100,
    maxQueueSize: 50,
    statsInterval: 2000,
    pingInterval: parseInt(import.meta.env.VITE_PING_INTERVAL) || 25000,
    pingTimeout: parseInt(import.meta.env.VITE_PING_TIMEOUT) || 5000,
    connectionTimeout: 30000,
    iceGatheringTimeout: 10000
  },
  
  // Feature Flags
  FEATURES: {
    debugMode: import.meta.env.VITE_DEBUG_MODE === 'true',
    enableStats: import.meta.env.VITE_ENABLE_STATS === 'true',
    enablePWA: true,
    enableNotifications: true,
    enableScreenShare: false, // Future feature
    enableFileTransfer: false // Future feature
  },
  
  // UI Configuration
  UI: {
    appName: import.meta.env.VITE_APP_NAME || 'WebRTC Video Chat',
    theme: 'dark', // Only dark theme for now
    animations: {
      enabled: true,
      duration: 300,
      easing: 'ease-out'
    }
  },
  
  // Connection States
  CONNECTION_STATES: {
    DISCONNECTED: 'disconnected',
    CONNECTING: 'connecting',
    WAITING: 'waiting',
    CONNECTED: 'connected',
    ERROR: 'error',
    RATE_LIMITED: 'rate_limited',
    RECONNECTING: 'reconnecting'
  },
  
  // Message Types
  MESSAGE_TYPES: {
    USER: 'me',
    STRANGER: 'stranger',
    SYSTEM: 'system'
  },
  
  // Error Types
  ERROR_TYPES: {
    MEDIA_ACCESS: 'media_access',
    NETWORK: 'network',
    WEBRTC: 'webrtc',
    SOCKET: 'socket',
    PERMISSION: 'permission',
    BROWSER_SUPPORT: 'browser_support'
  }
};

// Browser capability detection
export const BROWSER_SUPPORT = {
  hasWebRTC: !!(window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection),
  hasGetUserMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
  hasWebSocket: !!window.WebSocket,
  hasNotifications: 'Notification' in window,
  hasServiceWorker: 'serviceWorker' in navigator,
  
  // Detect specific browser issues
  isSafari: /^((?!chrome|android).)*safari/i.test(navigator.userAgent),
  isFirefox: navigator.userAgent.toLowerCase().indexOf('firefox') > -1,
  isChrome: /Chrome/.test(navigator.userAgent) && /Google Inc/.test(navigator.vendor),
  isMobile: /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent),
  
  // Check for required features
  isSupported() {
    return this.hasWebRTC && this.hasGetUserMedia && this.hasWebSocket;
  },
  
  // Get unsupported features
  getUnsupportedFeatures() {
    const unsupported = [];
    if (!this.hasWebRTC) unsupported.push('WebRTC');
    if (!this.hasGetUserMedia) unsupported.push('Media Access');
    if (!this.hasWebSocket) unsupported.push('WebSocket');
    return unsupported;
  }
};

// Validation functions
export const validateConfig = () => {
  const issues = [];
  
  // Check browser support
  if (!BROWSER_SUPPORT.isSupported()) {
    issues.push(`Browser missing features: ${BROWSER_SUPPORT.getUnsupportedFeatures().join(', ')}`);
  }
  
  // Check backend URL
  try {
    new URL(CONFIG.BACKEND_URL);
  } catch {
    issues.push('Invalid backend URL');
  }
  
  // Check ICE servers
  if (!CONFIG.ICE_SERVERS.iceServers.length) {
    issues.push('No ICE servers configured');
  }
  
  // Log issues
  if (issues.length > 0) {
    console.error('Configuration issues:', issues);
    if (CONFIG.FEATURES.debugMode) {
      console.table(CONFIG);
    }
  }
  
  return issues;
};

// Development helpers
if (CONFIG.FEATURES.debugMode) {
  console.info('[Config] Backend URL:', CONFIG.BACKEND_URL);
  console.info('[Config] ICE Servers:', CONFIG.ICE_SERVERS.iceServers.length);
  console.info('[Config] Browser Support:', BROWSER_SUPPORT.isSupported());
  
  // Make config available globally for debugging
  window.APP_CONFIG = CONFIG;
  window.BROWSER_SUPPORT = BROWSER_SUPPORT;
}

export default CONFIG;