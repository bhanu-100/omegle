// =========================
// Utility Functions
// =========================

import { v4 as uuidv4 } from 'uuid';
import { CONFIG } from '../config';

// =======================
// Time Utilities
// =======================

export const formatTime = (date = new Date()) => {
  return date.toLocaleTimeString([], { 
    hour: '2-digit', 
    minute: '2-digit',
    hour12: true 
  });
};

export const formatTimestamp = (timestamp) => {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;
  
  // Less than 1 minute
  if (diff < 60000) {
    return 'Just now';
  }
  
  // Less than 1 hour
  if (diff < 3600000) {
    const minutes = Math.floor(diff / 60000);
    return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
  }
  
  // Less than 24 hours
  if (diff < 86400000) {
    const hours = Math.floor(diff / 3600000);
    return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
  }
  
  // More than 24 hours
  return formatTime(date);
};

export const debounce = (func, wait) => {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
};

export const throttle = (func, limit) => {
  let inThrottle;
  return function executedFunction(...args) {
    if (!inThrottle) {
      func.apply(this, args);
      inThrottle = true;
      setTimeout(() => inThrottle = false, limit);
    }
  };
};

// =======================
// Performance Utilities
// =======================

export const performanceMonitor = {
  marks: new Map(),
  
  start(name) {
    this.marks.set(name, performance.now());
  },
  
  end(name) {
    const start = this.marks.get(name);
    if (start) {
      const duration = performance.now() - start;
      this.marks.delete(name);
      if (CONFIG.FEATURES.debugMode) {
        console.info(`[Performance] ${name}: ${duration.toFixed(2)}ms`);
      }
      return duration;
    }
    return null;
  },
  
  measure(name, fn) {
    this.start(name);
    const result = fn();
    this.end(name);
    return result;
  },
  
  async measureAsync(name, fn) {
    this.start(name);
    const result = await fn();
    this.end(name);
    return result;
  }
};

// =======================
// Error Handling Utilities
// =======================

export class AppError extends Error {
  constructor(message, type, details = {}) {
    super(message);
    this.name = 'AppError';
    this.type = type;
    this.details = details;
    this.timestamp = new Date().toISOString();
  }
}

export const errorHandler = {
  log(error, context = '') {
    const errorInfo = {
      message: error.message,
      type: error.type || 'unknown',
      context,
      timestamp: new Date().toISOString(),
      stack: error.stack
    };
    
    console.error('[Error]', errorInfo);
    
    // In production, you would send this to an error reporting service
    if (!CONFIG.FEATURES.debugMode) {
      // Example: sendToErrorService(errorInfo);
    }
    
    return errorInfo;
  },
  
  handle(error, fallbackMessage = 'An unexpected error occurred') {
    if (error instanceof AppError) {
      return error.message;
    }
    
    this.log(error);
    return fallbackMessage;
  }
};

// =======================
// Media Utilities
// =======================

export const mediaUtils = {
  async checkPermissions() {
    try {
      const permissions = await Promise.all([
        navigator.permissions.query({ name: 'camera' }),
        navigator.permissions.query({ name: 'microphone' })
      ]);
      
      return {
        camera: permissions[0].state,
        microphone: permissions[1].state
      };
    } catch (error) {
      console.warn('Permissions API not supported');
      return { camera: 'prompt', microphone: 'prompt' };
    }
  },
  
  async getDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return {
        cameras: devices.filter(d => d.kind === 'videoinput'),
        microphones: devices.filter(d => d.kind === 'audioinput'),
        speakers: devices.filter(d => d.kind === 'audiooutput')
      };
    } catch (error) {
      console.error('Failed to enumerate devices:', error);
      return { cameras: [], microphones: [], speakers: [] };
    }
  },
  
  getOptimalConstraints(preferredDevices = {}) {
    const constraints = { ...CONFIG.MEDIA_CONSTRAINTS };
    
    // Apply preferred devices if specified
    if (preferredDevices.cameraId) {
      constraints.video.deviceId = { exact: preferredDevices.cameraId };
    }
    
    if (preferredDevices.microphoneId) {
      constraints.audio.deviceId = { exact: preferredDevices.microphoneId };
    }
    
    // Adjust constraints for mobile devices
    if (window.innerWidth <= 768) {
      constraints.video.width = { min: 240, ideal: 480, max: 640 };
      constraints.video.height = { min: 180, ideal: 360, max: 480 };
      constraints.video.frameRate = { min: 15, ideal: 20, max: 25 };
    }
    
    return constraints;
  }
};

// =======================
// WebRTC Utilities
// =======================

export const webrtcUtils = {
  async testICEServers() {
    const servers = CONFIG.ICE_SERVERS.iceServers;
    const results = [];
    
    for (const server of servers) {
      try {
        const pc = new RTCPeerConnection({ iceServers: [server] });
        
        const testPromise = new Promise((resolve) => {
          const timeout = setTimeout(() => resolve(false), 5000);
          
          pc.onicecandidate = (event) => {
            if (event.candidate) {
              clearTimeout(timeout);
              resolve(true);
            }
          };
          
          // Create a data channel to trigger ICE gathering
          pc.createDataChannel('test');
          pc.createOffer().then(offer => pc.setLocalDescription(offer));
        });
        
        const works = await testPromise;
        results.push({ server: server.urls, working: works });
        pc.close();
      } catch (error) {
        results.push({ server: server.urls, working: false, error: error.message });
      }
    }
    
    return results;
  },
  
  getConnectionQuality(stats) {
    if (!stats) return 'unknown';
    
    const packetsLost = stats.packetsLost || 0;
    const packetsReceived = stats.packetsReceived || 1;
    const lossRate = packetsLost / (packetsLost + packetsReceived);
    
    if (lossRate < 0.02) return 'excellent';
    if (lossRate < 0.05) return 'good';
    if (lossRate < 0.10) return 'fair';
    return 'poor';
  },
  
  formatBandwidth(bytes) {
    if (bytes < 1024) return `${bytes} B/s`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB/s`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB/s`;
  }
};

// =======================
// Network Utilities
// =======================

export const networkUtils = {
  async checkConnectivity() {
    try {
      const response = await fetch('/favicon.ico', { 
        method: 'HEAD',
        cache: 'no-cache'
      });
      return response.ok;
    } catch {
      return false;
    }
  },
  
  getConnectionType() {
    if ('connection' in navigator) {
      return navigator.connection.effectiveType || 'unknown';
    }
    return 'unknown';
  },
  
  isOnline() {
    return navigator.onLine;
  },
  
  async measureLatency(url = CONFIG.BACKEND_URL) {
    try {
      const start = performance.now();
      await fetch(url, { method: 'HEAD', cache: 'no-cache' });
      return performance.now() - start;
    } catch {
      return null;
    }
  }
};

// =======================
// Local Storage Utilities
// =======================

export const storage = {
  get(key, defaultValue = null) {
    try {
      const item = localStorage.getItem(key);
      return item ? JSON.parse(item) : defaultValue;
    } catch {
      return defaultValue;
    }
  },
  
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
  
  remove(key) {
    try {
      localStorage.removeItem(key);
      return true;
    } catch {
      return false;
    }
  },
  
  clear() {
    try {
      localStorage.clear();
      return true;
    } catch {
      return false;
    }
  }
};

// =======================
// Message Utilities
// =======================

export const messageUtils = {
  createMessage(sender, text, type = 'text') {
    return {
      id: uuidv4(),
      sender,
      text: text.trim(),
      type,
      timestamp: Date.now(),
      formattedTime: formatTime()
    };
  },
  
  sanitizeMessage(text) {
    return text
      .trim()
      .replace(/[<>]/g, '') // Remove potential HTML tags
      .substring(0, 500); // Limit message length
  },
  
  isValidMessage(text) {
    return text && text.trim().length > 0 && text.trim().length <= 500;
  }
};

// =======================
// URL Utilities
// =======================

export const urlUtils = {
  isValidUrl(string) {
    try {
      new URL(string);
      return true;
    } catch {
      return false;
    }
  },
  
  getBaseUrl(url) {
    try {
      const parsedUrl = new URL(url);
      return `${parsedUrl.protocol}//${parsedUrl.host}`;
    } catch {
      return null;
    }
  },
  
  constructSocketUrl(baseUrl) {
    if (baseUrl.startsWith('https://')) {
      return baseUrl.replace('https://', 'wss://') + '/socket.io/?EIO=4&transport=websocket';
    } else if (baseUrl.startsWith('http://')) {
      return baseUrl.replace('http://', 'ws://') + '/socket.io/?EIO=4&transport=websocket';
    } else {
      const protocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
      return protocol + baseUrl + '/socket.io/?EIO=4&transport=websocket';
    }
  }
};

// =======================
// Browser Detection
// =======================

export const browser = {
  isSafari: /^((?!chrome|android).)*safari/i.test(navigator.userAgent),
  isFirefox: navigator.userAgent.toLowerCase().indexOf('firefox') > -1,
  isChrome: /Chrome/.test(navigator.userAgent) && /Google Inc/.test(navigator.vendor),
  isEdge: navigator.userAgent.indexOf('Edg') > -1,
  isMobile: /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent),
  isIOS: /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream,
  isAndroid: /Android/.test(navigator.userAgent),
  
  getVersion() {
    const userAgent = navigator.userAgent;
    let version = 'unknown';
    
    if (this.isChrome) {
      version = userAgent.match(/Chrome\/(\d+)/)?.[1] || 'unknown';
    } else if (this.isFirefox) {
      version = userAgent.match(/Firefox\/(\d+)/)?.[1] || 'unknown';
    } else if (this.isSafari) {
      version = userAgent.match(/Version\/(\d+)/)?.[1] || 'unknown';
    } else if (this.isEdge) {
      version = userAgent.match(/Edg\/(\d+)/)?.[1] || 'unknown';
    }
    
    return version;
  }
};

// =======================
// Notification Utilities
// =======================

export const notifications = {
  async requestPermission() {
    if (!('Notification' in window)) {
      return 'not-supported';
    }
    
    if (Notification.permission === 'granted') {
      return 'granted';
    }
    
    if (Notification.permission === 'denied') {
      return 'denied';
    }
    
    const permission = await Notification.requestPermission();
    return permission;
  },
  
  show(title, options = {}) {
    if (Notification.permission === 'granted') {
      return new Notification(title, {
        icon: '/favicon.ico',
        badge: '/favicon.ico',
        ...options
      });
    }
    return null;
  }
};

// =======================
// Development Helpers
// =======================

export const dev = {
  log: (...args) => {
    if (CONFIG.FEATURES.debugMode) {
      console.log('[Dev]', ...args);
    }
  },
  
  warn: (...args) => {
    if (CONFIG.FEATURES.debugMode) {
      console.warn('[Dev]', ...args);
    }
  },
  
  error: (...args) => {
    if (CONFIG.FEATURES.debugMode) {
      console.error('[Dev]', ...args);
    }
  },
  
  table: (data) => {
    if (CONFIG.FEATURES.debugMode) {
      console.table(data);
    }
  }
};

// Make utilities available globally in development
if (CONFIG.FEATURES.debugMode) {
  window.utils = {
    performance: performanceMonitor,
    media: mediaUtils,
    webrtc: webrtcUtils,
    network: networkUtils,
    storage,
    messageUtils,
    urlUtils,
    browser,
    notifications
  };
}