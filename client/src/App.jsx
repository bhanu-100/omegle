import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import './App.css'; // Import the custom CSS

// Native WebSocket implementation with Socket.IO protocol compatibility
class SocketIOClient {
  constructor(url, options = {}) {
    this.baseUrl = url;
    // FIXED: Proper protocol handling for HTTPS/WSS
    this.url = this.constructWebSocketUrl(url);
    this.options = options;
    this.socket = null;
    this.connected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = options.reconnectionAttempts || 5;
    this.reconnectDelay = options.reconnectionDelay || 1000;
    this.reconnectDelayMax = options.reconnectionDelayMax || 5000;
    this.listeners = new Map();
    this.emitQueue = [];
    this.pingInterval = null;
    this.pongTimeout = null;
    this.socketId = null;
    this.autoConnect = options.autoConnect !== false;
  }

  // FIXED: Smart WebSocket URL construction
  constructWebSocketUrl(baseUrl) {
    // Handle protocol conversion properly
    let wsUrl;
    if (baseUrl.startsWith('https://')) {
      wsUrl = baseUrl.replace('https://', 'wss://');
    } else if (baseUrl.startsWith('http://')) {
      wsUrl = baseUrl.replace('http://', 'ws://');
    } else {
      // If no protocol specified, detect from current page
      const protocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss://' : 'ws://';
      wsUrl = protocol + baseUrl;
    }
    
    return wsUrl + '/socket.io/?EIO=4&transport=websocket';
  }

  connect() {
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) return;
    
    try {
      console.log('[Socket] Attempting to connect to', this.url);
      this.socket = new WebSocket(this.url);
      
      this.socket.onopen = () => {
        console.info('[Socket] Connected via WebSocket');
        this.connected = true;
        this.reconnectAttempts = 0;
        
        // Send Socket.IO handshake
        this.socket.send('40'); // Connect packet
        
        // Start ping/pong
        this.startPingPong();
        
        // Process queued messages
        while (this.emitQueue.length > 0) {
          const { event, payload } = this.emitQueue.shift();
          this.rawEmit(event, payload);
        }
        
        this.emit('connect');
      };
      
      this.socket.onmessage = (event) => {
        this.handleMessage(event.data);
      };
      
      this.socket.onclose = (event) => {
        console.info('[Socket] Disconnected:', event.reason);
        this.connected = false;
        this.stopPingPong();
        
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          const delay = Math.min(
            this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
            this.reconnectDelayMax
          );
          console.info(`[Socket] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
          setTimeout(() => this.connect(), delay);
        }
        
        this.emit('disconnect', event.reason);
      };
      
      this.socket.onerror = (error) => {
        console.warn('[Socket] WebSocket error:', error);
        this.emit('connect_error', error);
      };
      
    } catch (error) {
      console.error('[Socket] Failed to create WebSocket:', error);
      this.emit('connect_error', error);
    }
  }

  handleMessage(data) {
    // Socket.IO protocol parsing
    if (data === '3') {
      // Pong response
      if (this.pongTimeout) {
        clearTimeout(this.pongTimeout);
        this.pongTimeout = null;
      }
      return;
    }
    
    if (data.startsWith('40')) {
      // Connection acknowledgment with socket ID
      const payload = data.slice(2);
      if (payload) {
        try {
          const connData = JSON.parse(payload);
          this.socketId = connData.sid || Math.random().toString(36).slice(2);
        } catch (e) {
          this.socketId = Math.random().toString(36).slice(2);
        }
      }
      return;
    }
    
    if (data.startsWith('42')) {
      // Event message
      try {
        const payload = JSON.parse(data.slice(2));
        const [eventName, eventData] = payload;
        this.emit(eventName, eventData);
      } catch (err) {
        console.error('[Socket] Failed to parse message:', data, err);
      }
    }
  }

  startPingPong() {
    this.pingInterval = setInterval(() => {
      if (this.connected && this.socket.readyState === WebSocket.OPEN) {
        this.socket.send('2'); // Ping
        
        // Set pong timeout
        this.pongTimeout = setTimeout(() => {
          console.warn('[Socket] Pong timeout, reconnecting...');
          this.socket.close();
        }, 5000);
      }
    }, 25000);
  }

  stopPingPong() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout);
      this.pongTimeout = null;
    }
  }

  rawEmit(eventName, data = null) {
    // Regular Socket.IO events
    const message = data 
      ? `42${JSON.stringify([eventName, data])}`
      : `42${JSON.stringify([eventName])}`;
    
    if (this.connected && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(message);
    } else {
      this.emitQueue.push({ event: eventName, payload: data });
    }
  }

  emit(eventName, data = null) {
    if (eventName === 'connect' || eventName === 'disconnect' || eventName === 'connect_error') {
      // Internal events
      const handlers = this.listeners.get(eventName) || [];
      handlers.forEach(handler => {
        try {
          handler(data);
        } catch (err) {
          console.error('[Socket] Event handler error:', err);
        }
      });
      return;
    }

    this.rawEmit(eventName, data);
  }

  on(eventName, handler) {
    if (!this.listeners.has(eventName)) {
      this.listeners.set(eventName, []);
    }
    this.listeners.get(eventName).push(handler);
  }

  off(eventName, handler) {
    if (!this.listeners.has(eventName)) return;
    
    const handlers = this.listeners.get(eventName);
    const index = handlers.indexOf(handler);
    if (index > -1) {
      handlers.splice(index, 1);
    }
  }

  disconnect() {
    if (this.socket) {
      this.socket.close();
    }
    this.stopPingPong();
    this.connected = false;
  }

  get id() {
    return this.socketId;
  }
}

// FIXED: Socket factory with proper URL detection
const createSocket = () => {
  // Smart backend URL detection with protocol awareness
  const getBackendUrl = () => {
    if (typeof window !== 'undefined' && window.location) {
      const { protocol, hostname } = window.location;
      
      // For production deployments (Vercel, Netlify, etc.)
      if (hostname.includes('.vercel.app') || hostname.includes('.netlify.app') || hostname.includes('.herokuapp.com')) {
        // Use same origin with correct protocol (no port needed)
        return `${protocol}//${hostname}`;
      }
      
      // For development with custom port
      const backendProtocol = protocol === 'https:' ? 'https:' : 'http:';
      return `${backendProtocol}//${hostname}:3000`;
    }
    
    // Fallback for SSR
    return 'http://localhost:3000';
  };

  const BACKEND_URL = getBackendUrl();
  console.info('[Socket] Backend URL detected:', BACKEND_URL);

  const rawSocket = new SocketIOClient(BACKEND_URL, {
    autoConnect: false,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });

  // Match your socket.js interface exactly
  return {
    connect: () => rawSocket.connect(),
    disconnect: () => rawSocket.disconnect(),
    on: (ev, cb) => rawSocket.on(ev, cb),
    off: (ev, cb) => rawSocket.off(ev, cb),
    emit: (ev, payload) => {
      if (rawSocket.connected) {
        return rawSocket.rawEmit(ev, payload);
      }
      console.info('[Socket] Not connected yet — queueing emit:', ev);
      rawSocket.emitQueue.push({ event: ev, payload });
    },
    id: () => rawSocket.id,
    get connected() { return rawSocket.connected; },
    raw: rawSocket,
  };
};

// WebRTC configuration with multiple STUN/TURN servers
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
    // Add TURN servers for production:
    // { urls: 'turn:your-turn-server.com:3478', username: 'user', credential: 'pass' }
  ],
  iceCandidatePoolSize: 10,
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require'
};

// Media constraints for optimal performance
const MEDIA_CONSTRAINTS = {
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
};

// Connection states
const CONNECTION_STATES = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  WAITING: 'waiting',
  CONNECTED: 'connected',
  ERROR: 'error',
  RATE_LIMITED: 'rate_limited'
};

// Message types
const MESSAGE_TYPES = {
  USER: 'me',
  STRANGER: 'stranger',
  SYSTEM: 'system'
};

export default function App() {
  // Refs for media and connections
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const localStreamRef = useRef(null);
  const iceCandidatesQueueRef = useRef([]);
  const audioSenderRef = useRef(null);
  const videoSenderRef = useRef(null);
  const socketRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const connectionStatsIntervalRef = useRef(null);

  // State management
  const [connectionState, setConnectionState] = useState(CONNECTION_STATES.DISCONNECTED);
  const [micEnabled, setMicEnabled] = useState(true);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [messages, setMessages] = useState([]);
  const [inputMessage, setInputMessage] = useState('');
  const [statusMessage, setStatusMessage] = useState('Initializing...');
  const [connectionStats, setConnectionStats] = useState(null);
  const [error, setError] = useState(null);
  const [isReconnecting, setIsReconnecting] = useState(false);

  // Performance monitoring
  const [performanceStats, setPerformanceStats] = useState({
    packetsLost: 0,
    bandwidth: { inbound: 0, outbound: 0 },
    latency: 0,
    quality: 'good'
  });

  // Memoized socket instance
  const socket = useMemo(() => {
    if (!socketRef.current) {
      socketRef.current = createSocket();
    }
    return socketRef.current;
  }, []);

  // Optimized message handler with batch updates
  const addMessage = useCallback((sender, text, type = 'text') => {
    const message = {
      id: Date.now() + Math.random(),
      sender,
      text,
      type,
      timestamp: new Date().toLocaleTimeString()
    };
    
    setMessages(prev => {
      // Limit messages to prevent memory issues
      const newMessages = [...prev, message];
      return newMessages.length > 100 ? newMessages.slice(-100) : newMessages;
    });
  }, []);

  // Optimized peer connection creation
  const createPeerConnection = useCallback(async () => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
    }

    const pc = new RTCPeerConnection(ICE_SERVERS);
    peerConnectionRef.current = pc;

    // Connection state monitoring
    pc.onconnectionstatechange = () => {
      console.log('PC Connection State:', pc.connectionState);
      
      if (pc.connectionState === 'connected') {
        setStatusMessage('🔗 WebRTC Connected!');
        startConnectionMonitoring();
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        setStatusMessage('❌ Connection lost. Trying to reconnect...');
        stopConnectionMonitoring();
      }
    };

    // ICE connection state
    pc.oniceconnectionstatechange = () => {
      console.log('ICE Connection State:', pc.iceConnectionState);
    };

    // Handle remote stream with error handling
    pc.ontrack = (event) => {
      try {
        if (event.streams && event.streams[0]) {
          remoteVideoRef.current.srcObject = event.streams[0];
          setStatusMessage('🎥 Video connected!');
        }
      } catch (err) {
        console.error('Error handling remote stream:', err);
        setError('Failed to display remote video');
      }
    };

    // ICE candidate handling with queuing
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('webrtc_ice_candidate', { candidate: event.candidate });
      }
    };

    // Add local stream tracks
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        const sender = pc.addTrack(track, localStreamRef.current);
        if (track.kind === 'audio') audioSenderRef.current = sender;
        if (track.kind === 'video') videoSenderRef.current = sender;
      });
    }

    return pc;
  }, [socket]);

  // Enhanced media acquisition with error handling
  const acquireMedia = useCallback(async () => {
    try {
      // Check for media device support
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Media devices not supported');
      }

      setStatusMessage('📹 Requesting camera and microphone access...');
      
      const stream = await navigator.mediaDevices.getUserMedia(MEDIA_CONSTRAINTS);
      
      localStreamRef.current = stream;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }

      // Set initial track states
      const audioTrack = stream.getAudioTracks()[0];
      const videoTrack = stream.getVideoTracks()[0];
      
      if (audioTrack) {
        audioTrack.enabled = micEnabled;
        // Monitor audio levels for better UX
        audioTrack.addEventListener('ended', () => {
          console.log('Audio track ended');
          setError('Microphone disconnected');
        });
      }
      
      if (videoTrack) {
        videoTrack.enabled = cameraEnabled;
        videoTrack.addEventListener('ended', () => {
          console.log('Video track ended');
          setError('Camera disconnected');
        });
      }

      setStatusMessage('✅ Media access granted');
      return stream;
    } catch (err) {
      console.error('Media acquisition error:', err);
      
      let errorMessage = 'Failed to access camera/microphone';
      if (err.name === 'NotAllowedError') {
        errorMessage = 'Please allow camera and microphone access';
      } else if (err.name === 'NotFoundError') {
        errorMessage = 'No camera or microphone found';
      } else if (err.name === 'NotReadableError') {
        errorMessage = 'Camera/microphone is being used by another application';
      }
      
      setError(errorMessage);
      setStatusMessage('❌ ' + errorMessage);
      throw err;
    }
  }, [micEnabled, cameraEnabled]);

  // Connection quality monitoring
  const startConnectionMonitoring = useCallback(() => {
    if (connectionStatsIntervalRef.current) return;
    
    connectionStatsIntervalRef.current = setInterval(async () => {
      if (!peerConnectionRef.current) return;
      
      try {
        const stats = await peerConnectionRef.current.getStats();
        let inboundRtp = null;
        let outboundRtp = null;
        
        stats.forEach(report => {
          if (report.type === 'inbound-rtp' && report.mediaType === 'video') {
            inboundRtp = report;
          }
          if (report.type === 'outbound-rtp' && report.mediaType === 'video') {
            outboundRtp = report;
          }
        });
        
        if (inboundRtp || outboundRtp) {
          const newStats = {
            packetsLost: inboundRtp?.packetsLost || 0,
            bandwidth: {
              inbound: inboundRtp?.bytesReceived || 0,
              outbound: outboundRtp?.bytesSent || 0
            },
            latency: inboundRtp?.jitter || 0,
            quality: inboundRtp?.packetsLost > 10 ? 'poor' : 'good'
          };
          
          setPerformanceStats(newStats);
        }
      } catch (err) {
        console.warn('Stats collection error:', err);
      }
    }, 2000);
  }, []);

  const stopConnectionMonitoring = useCallback(() => {
    if (connectionStatsIntervalRef.current) {
      clearInterval(connectionStatsIntervalRef.current);
      connectionStatsIntervalRef.current = null;
    }
  }, []);

  // Apply queued ICE candidates
  const applyQueuedCandidates = useCallback(async () => {
    if (!peerConnectionRef.current || !peerConnectionRef.current.remoteDescription) return;
    
    while (iceCandidatesQueueRef.current.length > 0) {
      const candidate = iceCandidatesQueueRef.current.shift();
      try {
        await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.warn('Failed to add ICE candidate:', err);
      }
    }
  }, []);

  // Optimized media controls
  const toggleMicrophone = useCallback(async () => {
    try {
      if (!localStreamRef.current) return;
      
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (!audioTrack) return;
      
      const newState = !micEnabled;
      audioTrack.enabled = newState;
      setMicEnabled(newState);
      
      if (audioSenderRef.current) {
        await audioSenderRef.current.replaceTrack(newState ? audioTrack : null);
      }
      
      addMessage(MESSAGE_TYPES.SYSTEM, `Microphone ${newState ? 'enabled' : 'disabled'}`);
    } catch (err) {
      console.error('Microphone toggle error:', err);
      setError('Failed to toggle microphone');
    }
  }, [micEnabled, addMessage]);

  const toggleCamera = useCallback(async () => {
    try {
      if (!localStreamRef.current) return;
      
      const videoTrack = localStreamRef.current.getVideoTracks()[0];
      if (!videoTrack) return;
      
      const newState = !cameraEnabled;
      videoTrack.enabled = newState;
      setCameraEnabled(newState);
      
      if (videoSenderRef.current) {
        await videoSenderRef.current.replaceTrack(newState ? videoTrack : null);
      }
      
      addMessage(MESSAGE_TYPES.SYSTEM, `Camera ${newState ? 'enabled' : 'disabled'}`);
    } catch (err) {
      console.error('Camera toggle error:', err);
      setError('Failed to toggle camera');
    }
  }, [cameraEnabled, addMessage]);

  // Socket event handlers
  const handleSocketConnect = useCallback(() => {
    console.log('Socket connected');
    setIsReconnecting(false);
    setConnectionState(CONNECTION_STATES.WAITING);
    setStatusMessage('🔍 Looking for a chat partner...');
    setError(null);
    
    // Clear reconnection timeout
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    
    socket.emit('find_match');
  }, [socket]);

  const handleSocketDisconnect = useCallback((reason) => {
    console.log('Socket disconnected:', reason);
    setConnectionState(CONNECTION_STATES.DISCONNECTED);
    setStatusMessage('🔌 Connection lost. Reconnecting...');
    setIsReconnecting(true);
    stopConnectionMonitoring();
  }, [stopConnectionMonitoring]);

  const handleMatchFound = useCallback(async ({ roomId, peerIP }) => {
    try {
      setConnectionState(CONNECTION_STATES.CONNECTED);
      setStatusMessage('👋 Partner found! Setting up video...');
      setMessages([]);
      setError(null);
      
      await acquireMedia();
      const pc = await createPeerConnection();
      
      // Create and send offer
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true
      });
      
      await pc.setLocalDescription(offer);
      socket.emit('webrtc_offer', { sdp: offer });
      
      addMessage(MESSAGE_TYPES.SYSTEM, 'Connected to partner! Say hello! 👋');
    } catch (err) {
      console.error('Match setup error:', err);
      setError('Failed to connect to partner');
      handleSkip();
    }
  }, [socket, acquireMedia, createPeerConnection, addMessage]);

  const handleWebRTCOffer = useCallback(async ({ sdp }) => {
    try {
      if (!localStreamRef.current) {
        await acquireMedia();
      }
      
      if (!peerConnectionRef.current) {
        await createPeerConnection();
      }
      
      await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(sdp));
      
      const answer = await peerConnectionRef.current.createAnswer();
      await peerConnectionRef.current.setLocalDescription(answer);
      
      socket.emit('webrtc_answer', { sdp: answer });
      await applyQueuedCandidates();
      
    } catch (err) {
      console.error('WebRTC offer handling error:', err);
      setError('Failed to handle connection offer');
    }
  }, [socket, acquireMedia, createPeerConnection, applyQueuedCandidates]);

  const handleWebRTCAnswer = useCallback(async ({ sdp }) => {
    try {
      if (peerConnectionRef.current && peerConnectionRef.current.signalingState === 'have-local-offer') {
        await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(sdp));
        await applyQueuedCandidates();
      }
    } catch (err) {
      console.error('WebRTC answer handling error:', err);
      setError('Failed to handle connection answer');
    }
  }, [applyQueuedCandidates]);

  const handleICECandidate = useCallback(async ({ candidate }) => {
    try {
      if (!candidate?.candidate) return;
      
      if (peerConnectionRef.current?.remoteDescription) {
        await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
      } else {
        iceCandidatesQueueRef.current.push(candidate);
      }
    } catch (err) {
      console.warn('ICE candidate error:', err);
    }
  }, []);

  const handlePeerDisconnected = useCallback(() => {
    setConnectionState(CONNECTION_STATES.WAITING);
    setStatusMessage('👋 Partner left. Finding new partner...');
    addMessage(MESSAGE_TYPES.SYSTEM, 'Partner disconnected');
    
    cleanup();
    
    // Auto-find new match after brief delay
    setTimeout(() => {
      if (socket.connected) {
        socket.emit('find_match');
      }
    }, 1000);
  }, [socket, addMessage]);

  const handleRateLimited = useCallback(() => {
    setConnectionState(CONNECTION_STATES.RATE_LIMITED);
    setStatusMessage('⏳ Rate limited. Please wait before trying again...');
    setError('You are sending requests too quickly. Please wait a moment.');
    
    // Auto-retry after delay
    setTimeout(() => {
      if (socket.connected) {
        setConnectionState(CONNECTION_STATES.WAITING);
        setError(null);
        socket.emit('find_match');
      }
    }, 30000); // 30 second delay
  }, [socket]);

  // Cleanup function
  const cleanup = useCallback(() => {
    // Close peer connection
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    
    // Stop local media
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
    }
    
    // Clear video elements
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    
    // Clear ICE candidates queue
    iceCandidatesQueueRef.current = [];
    
    // Clear references
    audioSenderRef.current = null;
    videoSenderRef.current = null;
    
    // Stop monitoring
    stopConnectionMonitoring();
  }, [stopConnectionMonitoring]);

  // Send message with optimization
  const sendMessage = useCallback(() => {
    if (!inputMessage.trim() || connectionState !== CONNECTION_STATES.CONNECTED) return;
    
    socket.emit('message', inputMessage);
    addMessage(MESSAGE_TYPES.USER, inputMessage);
    setInputMessage('');
  }, [inputMessage, connectionState, socket, addMessage]);

  // Skip current partner
  const handleSkip = useCallback(() => {
    cleanup();
    setMessages([]);
    setConnectionState(CONNECTION_STATES.WAITING);
    setStatusMessage('⏭️ Skipped! Finding new partner...');
    
    socket.emit('skip');
    socket.emit('find_match');
  }, [socket, cleanup]);

  // Main effect for socket setup
  useEffect(() => {
    // Socket event listeners
    socket.on('connect', handleSocketConnect);
    socket.on('disconnect', handleSocketDisconnect);
    socket.on('match_found', handleMatchFound);
    socket.on('webrtc_offer', handleWebRTCOffer);
    socket.on('webrtc_answer', handleWebRTCAnswer);
    socket.on('webrtc_ice_candidate', handleICECandidate);
    socket.on('peer_disconnected', handlePeerDisconnected);
    socket.on('waiting', () => {
      setConnectionState(CONNECTION_STATES.WAITING);
      setStatusMessage('🕐 Waiting for partner...');
    });
    socket.on('rate_limited', handleRateLimited);
    socket.on('message', (data) => addMessage(MESSAGE_TYPES.STRANGER, data));
    socket.on('error', (error) => {
      console.error('Socket error:', error);
      setError('Connection error: ' + error.message);
    });

    // Connect socket
    socket.connect();

    // Cleanup on unmount
    return () => {
      socket.off('connect', handleSocketConnect);
      socket.off('disconnect', handleSocketDisconnect);
      socket.off('match_found', handleMatchFound);
      socket.off('webrtc_offer', handleWebRTCOffer);
      socket.off('webrtc_answer', handleWebRTCAnswer);
      socket.off('webrtc_ice_candidate', handleICECandidate);
      socket.off('peer_disconnected', handlePeerDisconnected);
      socket.off('rate_limited', handleRateLimited);
      
      cleanup();
      
      if (socket.connected) {
        socket.disconnect();
      }
      
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyPress = (e) => {
      if (e.key === 'Enter' && e.target.tagName !== 'INPUT') {
        e.preventDefault();
        if (connectionState === CONNECTION_STATES.CONNECTED) {
          const input = document.querySelector('input[type="text"]');
          if (input) input.focus();
        }
      } else if (e.key === 'Escape') {
        handleSkip();
      }
    };

    document.addEventListener('keydown', handleKeyPress);
    return () => document.removeEventListener('keydown', handleKeyPress);
  }, [connectionState, handleSkip]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-900 via-blue-900 to-indigo-900 text-white">
      <div className="container mx-auto px-4 py-6">
        {/* Header */}
        <header className="text-center mb-6">
          <h1 className="text-4xl font-bold bg-gradient-to-r from-pink-400 to-purple-400 bg-clip-text text-transparent gradient-shift">
            🎥 WebRTC Video Chat
          </h1>
          <p className="text-xl mt-2 text-gray-300">{statusMessage}</p>
          
          {error && (
            <div className="mt-4 p-3 bg-red-500/20 border border-red-500/50 rounded-lg text-red-200 error-shake">
              ⚠️ {error}
            </div>
          )}
        </header>

        {/* Video Container */}
        <div className="video-grid grid md:grid-cols-2 gap-6 mb-6">
          <div className="glass-card rounded-xl p-4">
            <h3 className="text-lg font-semibold mb-2 text-center text-green-400">You</h3>
            <div className="video-container aspect-video bg-gray-900 rounded-lg overflow-hidden">
              <video 
                ref={localVideoRef} 
                autoPlay 
                playsInline 
                muted
                className="w-full h-full object-cover"
              />
              <div className="video-overlay"></div>
              <div className="status-indicator">
                <div className={`status-dot ${micEnabled ? 'active bg-green-400' : 'bg-red-400'}`}></div>
                <div className={`status-dot ${cameraEnabled ? 'active bg-green-400' : 'bg-red-400'}`}></div>
              </div>
            </div>
          </div>
          
          <div className="glass-card rounded-xl p-4">
            <h3 className="text-lg font-semibold mb-2 text-center text-blue-400">Partner</h3>
            <div className="video-container aspect-video bg-gray-900 rounded-lg overflow-hidden">
              <video 
                ref={remoteVideoRef} 
                autoPlay 
                playsInline
                className="w-full h-full object-cover"
              />
              <div className="video-overlay"></div>
              {connectionState !== CONNECTION_STATES.CONNECTED && (
                <div className="absolute inset-0 flex items-center justify-center text-gray-400">
                  <div className="text-center">
                    <div className="text-6xl mb-4 pulse-ring">👤</div>
                    <p>Waiting for partner...</p>
                    {isReconnecting && <div className="loading-spinner mt-2"></div>}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Controls */}
        <div className="flex justify-center gap-4 mb-6">
          <button
            onClick={toggleMicrophone}
            className={`control-button px-6 py-3 rounded-lg font-semibold transition-all ${
              micEnabled 
                ? 'bg-green-600 hover:bg-green-700 text-white' 
                : 'bg-red-600 hover:bg-red-700 text-white'
            }`}
          >
            {micEnabled ? '🎤 Mic On' : '🔇 Mic Off'}
          </button>
          
          <button
            onClick={toggleCamera}
            className={`control-button px-6 py-3 rounded-lg font-semibold transition-all ${
              cameraEnabled 
                ? 'bg-green-600 hover:bg-green-700 text-white' 
                : 'bg-red-600 hover:bg-red-700 text-white'
            }`}
          >
            {cameraEnabled ? '📷 Cam On' : '📷 Cam Off'}
          </button>
          
          {connectionState === CONNECTION_STATES.CONNECTED && (
            <button
              onClick={handleSkip}
              className="control-button px-6 py-3 bg-orange-600 hover:bg-orange-700 text-white rounded-lg font-semibold transition-all"
            >
              ⏭️ Next
            </button>
          )}
        </div>

        {/* Chat Interface */}
        <div className="grid md:grid-cols-3 gap-6">
          <div className="md:col-span-2">
            <div className="glass-card rounded-xl p-4">
              <h3 className="text-lg font-semibold mb-4 text-purple-400">Chat Messages</h3>
              <div className="chat-messages h-64 overflow-y-auto space-y-2 mb-4 p-4 bg-gray-900/50 rounded-lg">
                {messages.map((msg) => (
                  <div 
                    key={msg.id} 
                    className={`message-enter message-enter-active flex ${
                      msg.sender === MESSAGE_TYPES.USER ? 'justify-end' : 'justify-start'
                    }`}
                  >
                    <div className={`max-w-xs px-3 py-2 rounded-lg ${
                      msg.sender === MESSAGE_TYPES.USER 
                        ? 'bg-purple-600 text-white' 
                        : msg.sender === MESSAGE_TYPES.SYSTEM 
                          ? 'bg-gray-600 text-gray-200' 
                          : 'bg-blue-600 text-white'
                    }`}>
                      <div className="text-xs opacity-70 mb-1">
                        {msg.sender === MESSAGE_TYPES.USER ? 'You' : msg.sender === MESSAGE_TYPES.SYSTEM ? 'System' : 'Partner'}
                        <span className="ml-2">{msg.timestamp}</span>
                      </div>
                      <div>{msg.text}</div>
                    </div>
                  </div>
                ))}
              </div>
              
              <div className="flex gap-2">
                <input
                  type="text"
                  value={inputMessage}
                  onChange={(e) => setInputMessage(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
                  disabled={connectionState !== CONNECTION_STATES.CONNECTED}
                  placeholder={connectionState === CONNECTION_STATES.CONNECTED ? "Type a message..." : "Connect to start chatting"}
                  className="flex-1 px-4 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:border-purple-500 transition-colors"
                />
                <button
                  onClick={sendMessage}
                  disabled={connectionState !== CONNECTION_STATES.CONNECTED || !inputMessage.trim()}
                  className="control-button px-6 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-gray-600 text-white rounded-lg font-semibold transition-all"
                >
                  Send
                </button>
              </div>
            </div>
          </div>
          
          {/* Connection Stats */}
          <div className="glass-card rounded-xl p-4">
            <h3 className="text-lg font-semibold mb-4 text-green-400">Connection Info</h3>
            <div className="space-y-3 text-sm">
              <div>
                <span className="text-gray-400">Status:</span>
                <span className={`ml-2 font-semibold ${
                  connectionState === CONNECTION_STATES.CONNECTED ? 'text-green-400' : 
                  connectionState === CONNECTION_STATES.WAITING ? 'text-yellow-400' : 
                  'text-red-400'
                }`}>
                  {connectionState.charAt(0).toUpperCase() + connectionState.slice(1)}
                </span>
              </div>
              
              {connectionState === CONNECTION_STATES.CONNECTED && (
                <>
                  <div>
                    <span className="text-gray-400">Quality:</span>
                    <div className="quality-indicator ml-2">
                      <span className={`font-semibold ${
                        performanceStats.quality === 'good' ? 'text-green-400' : 'text-red-400'
                      }`}>
                        {performanceStats.quality.charAt(0).toUpperCase() + performanceStats.quality.slice(1)}
                      </span>
                      <div className="flex gap-1 ml-2">
                        {[1, 2, 3, 4].map(i => (
                          <div 
                            key={i}
                            className={`quality-bar ${
                              performanceStats.quality === 'good' && i <= 4 ? 'active text-green-400' :
                              performanceStats.quality === 'poor' && i <= 2 ? 'active text-red-400' : ''
                            }`}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                  
                  <div>
                    <span className="text-gray-400">Packets Lost:</span>
                    <span className="ml-2 text-white">{performanceStats.packetsLost}</span>
                  </div>
                </>
              )}
              
              {isReconnecting && (
                <div className="text-yellow-400">
                  🔄 Reconnecting...
                  <div className="loading-spinner ml-2"></div>
                </div>
              )}
            </div>
          </div>
        </div>
        
        {/* Footer */}
        <footer className="text-center mt-6 text-gray-400 text-sm">
          <p>Press Enter to focus chat • Press Escape to skip partner</p>
        </footer>
      </div>
    </div>
  );
}