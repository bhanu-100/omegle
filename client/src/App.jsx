import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { CONFIG } from './config';
import { messageUtils, performanceMonitor, errorHandler, AppError, dev, notifications } from './utils';
import socketService from './services/socketClient';
import webrtcService from './services/webrtcService';

// Connection states
const CONNECTION_STATES = CONFIG.CONNECTION_STATES;
const MESSAGE_TYPES = CONFIG.MESSAGE_TYPES;

// Main Application Component
export default function App() {
  // Refs for video elements and DOM
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const messagesEndRef = useRef(null);
  
  // State management
  const [connectionState, setConnectionState] = useState(CONNECTION_STATES.DISCONNECTED);
  const [micEnabled, setMicEnabled] = useState(true);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [messages, setMessages] = useState([]);
  const [inputMessage, setInputMessage] = useState('');
  const [statusMessage, setStatusMessage] = useState('Initializing...');
  const [error, setError] = useState(null);
  const [isReconnecting, setIsReconnecting] = useState(false);
  
  // Performance and connection stats
  const [connectionStats, setConnectionStats] = useState(null);
  const [performanceStats, setPerformanceStats] = useState({
    packetsLost: 0,
    packetsReceived: 0,
    bandwidth: { inbound: 0, outbound: 0 },
    latency: 0,
    quality: 'good'
  });
  
  // UI state
  const [showStats, setShowStats] = useState(CONFIG.FEATURES.enableStats);
  const [isInitializing, setIsInitializing] = useState(true);

  // Memoized handlers to prevent unnecessary re-renders
  const addMessage = useCallback((sender, text, type = 'text') => {
    const message = messageUtils.createMessage(sender, text, type);
    
    setMessages(prev => {
      const newMessages = [...prev, message];
      return newMessages.length > CONFIG.PERFORMANCE.maxMessages 
        ? newMessages.slice(-CONFIG.PERFORMANCE.maxMessages) 
        : newMessages;
    });

    // Auto-scroll to bottom
    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 100);
  }, []);

  // Error handling with user-friendly messages
  const handleError = useCallback((error, context = '') => {
    const errorMessage = errorHandler.handle(error, 'Something went wrong. Please try again.');
    setError(errorMessage);
    
    // Auto-clear error after delay
    setTimeout(() => setError(null), 5000);
    
    dev.error('App error:', error, context);
  }, []);

  // Initialize media and setup video refs
  const initializeMedia = useCallback(async () => {
    try {
      setStatusMessage('Requesting camera and microphone access...');
      
      const stream = await webrtcService.initializeMedia();
      webrtcService.setVideoRefs(localVideoRef.current, remoteVideoRef.current);
      
      // Set initial track states
      const audioTrack = stream.getAudioTracks()[0];
      const videoTrack = stream.getVideoTracks()[0];
      
      if (audioTrack) audioTrack.enabled = micEnabled;
      if (videoTrack) videoTrack.enabled = cameraEnabled;
      
      setStatusMessage('Media access granted');
      return stream;
      
    } catch (error) {
      handleError(error, 'initializeMedia');
      throw error;
    }
  }, [micEnabled, cameraEnabled, handleError]);

  // WebRTC event handlers
  const setupWebRTCHandlers = useCallback(() => {
    webrtcService.on('remote_stream', ({ stream }) => {
      dev.log('Remote stream received');
      setStatusMessage('Video connected!');
    });

    webrtcService.on('connection_state_change', ({ newState }) => {
      dev.log('WebRTC connection state:', newState);
      
      if (newState === 'connected') {
        setStatusMessage('WebRTC Connected!');
      } else if (newState === 'failed' || newState === 'disconnected') {
        setStatusMessage('Connection lost. Trying to reconnect...');
      }
    });

    webrtcService.on('stats_updated', (stats) => {
      setPerformanceStats(prev => ({
        ...prev,
        packetsLost: stats.packetsLost,
        packetsReceived: stats.packetsReceived,
        bandwidth: stats.bandwidth,
        quality: stats.quality
      }));
    });

    webrtcService.on('media_error', (error) => {
      handleError(error, 'webrtc_media_error');
    });

    webrtcService.on('ice_candidate', ({ candidate }) => {
      socketService.emit('webrtc_ice_candidate', { candidate });
    });

  }, [handleError]);
// Socket event handlers
const setupSocketHandlers = useCallback(() => {
  socketService.on('match_cancelled', handlePeerDisconnected);

  // Correct usage: provide callback function
  socketService.on('pong', (data) => {
    dev.log('Pong received:', data);
    // You can optionally respond with pong
    socketService.emit('ping', { timestamp: Date.now() });
  });

  socketService.on('match_timeout', (data) => {
    dev.log('Match timeout:', data);
    setStatusMessage(data?.message || 'No match found, please try again');
    handlePeerDisconnected();
  });

  socketService.on('match_found',(data) => {
    dev.log('Match found:', data);
    handleMatchFound(data);
  });
  socketService.on('webrtc_offer', handleWebRTCOffer);
  socketService.on('webrtc_answer', handleWebRTCAnswer);
  socketService.on('webrtc_ice_candidate', handleICECandidate);
  socketService.on('peer_disconnected', handlePeerDisconnected);
  socketService.on('rate_limited', handleRateLimited);

  socketService.on('message', (data) => addMessage(MESSAGE_TYPES.STRANGER, data));

  socketService.on('waiting', () => {
    setConnectionState(CONNECTION_STATES.WAITING);
    setStatusMessage('Waiting for partner...');
  });

  socketService.on('connect', () => {
    dev.log('Socket connected');
    setIsReconnecting(false);
    setConnectionState(CONNECTION_STATES.WAITING);
    setStatusMessage('Looking for a chat partner...');
    setError(null);
    socketService.emit('find_match');
  });

  socketService.on('disconnect', ({ reason }) => {
    dev.log('Socket disconnected:', reason);
    setConnectionState(CONNECTION_STATES.DISCONNECTED);
    setStatusMessage('Connection lost. Reconnecting...');
    setIsReconnecting(true);
  });

  socketService.on('error', (error) => {
    dev.error('Socket connection error:', error);
    setConnectionState(CONNECTION_STATES.ERROR);
    handleError(error, 'socket_connect_error');
  });
}, [handleError, addMessage]);

// Other callbacks remain the same


  // WebRTC signaling handlers
  const handleMatchFound = useCallback(async ({peerId}) => {
    try {
      performanceMonitor.start('match-setup');
      
      setConnectionState(CONNECTION_STATES.CONNECTED);
      setStatusMessage('Partner found! Setting up video...');
      setMessages([]);
      setError(null);

      await initializeMedia();
      await webrtcService.createPeerConnection();
      
      const offer = await webrtcService.createOffer();
      await socketService.emit('webrtc_offer', { sdp: offer });
      
      performanceMonitor.end('match-setup');
      addMessage(MESSAGE_TYPES.SYSTEM, 'Connected to partner! Say hello!');
      console.log('Matched with peer:', peerId, baseMatchData);
      // Show notification if permitted
      if (document.hidden) {
        notifications.show('WebRTC Chat', {
          body: 'Found a chat partner!',
          tag: 'match-found'
        });
      }
      
    } catch (error) {
      performanceMonitor.end('match-setup');
      handleError(error, 'handleMatchFound');
      handleSkip();
    }
  }, [initializeMedia, addMessage, handleError]);

  const handleWebRTCOffer = useCallback(async ({ sdp }) => {
    try {
      if (!webrtcService.service.localStream) {
        await initializeMedia();
      }
      
      if (!webrtcService.service.peerConnection) {
        await webrtcService.createPeerConnection();
      }
      
      await webrtcService.setRemoteDescription(sdp);
      const answer = await webrtcService.createAnswer();
      await socketService.emit('webrtc_answer', { sdp: answer });
      
    } catch (error) {
      handleError(error, 'handleWebRTCOffer');
    }
  }, [initializeMedia, handleError]);

  const handleWebRTCAnswer = useCallback(async ({ sdp }) => {
    try {
      await webrtcService.setRemoteDescription(sdp);
    } catch (error) {
      handleError(error, 'handleWebRTCAnswer');
    }
  }, [handleError]);

  const handleICECandidate = useCallback(async ({ candidate }) => {
    try {
      if (candidate?.candidate) {
        await webrtcService.addICECandidate(candidate);
      }
    } catch (error) {
      dev.warn('ICE candidate error:', error);
    }
  }, []);

  const handlePeerDisconnected = useCallback(() => {
    setConnectionState(CONNECTION_STATES.WAITING);
    setStatusMessage('Partner left. Finding new partner...');
    addMessage(MESSAGE_TYPES.SYSTEM, 'Partner disconnected');
    
    webrtcService.cleanup();
    
    // Auto-find new match after brief delay
    setTimeout(() => {
      if (socketService.connected) {
        socketService.emit('find_match');
      }
    }, 2000);
  }, [addMessage]);

  const handleRateLimited = useCallback(() => {
    setConnectionState(CONNECTION_STATES.RATE_LIMITED);
    setStatusMessage('Rate limited. Please wait before trying again...');
    setError('You are sending requests too quickly. Please wait a moment.');
    
    // Auto-retry after delay
    setTimeout(() => {
      if (socketService.connected) {
        setConnectionState(CONNECTION_STATES.WAITING);
        setError(null);
        socketService.emit('find_match');
      }
    }, 30000);
  }, []);

  // Media controls
  const toggleMicrophone = useCallback(async () => {
    try {
      const newState = !micEnabled;
      await webrtcService.toggleAudio(newState);
      setMicEnabled(newState);
      addMessage(MESSAGE_TYPES.SYSTEM, `Microphone ${newState ? 'enabled' : 'disabled'}`);
    } catch (error) {
      handleError(error, 'toggleMicrophone');
    }
  }, [micEnabled, addMessage, handleError]);

  const toggleCamera = useCallback(async () => {
    try {
      const newState = !cameraEnabled;
      await webrtcService.toggleVideo(newState);
      setCameraEnabled(newState);
      addMessage(MESSAGE_TYPES.SYSTEM, `Camera ${newState ? 'enabled' : 'disabled'}`);
    } catch (error) {
      handleError(error, 'toggleCamera');
    }
  }, [cameraEnabled, addMessage, handleError]);

  // Message sending
  const sendMessage = useCallback(async () => {
    if (!inputMessage.trim() || connectionState !== CONNECTION_STATES.CONNECTED) return;
    
    const sanitized = messageUtils.sanitizeMessage(inputMessage);
    if (!messageUtils.isValidMessage(sanitized)) {
      setError('Invalid message. Please check your input.');
      return;
    }
    
    try {
      await socketService.emit('message', sanitized);
      addMessage(MESSAGE_TYPES.USER, sanitized);
      setInputMessage('');
    } catch (error) {
      handleError(error, 'sendMessage');
    }
  }, [inputMessage, connectionState, addMessage, handleError]);

  // Skip current partner
  const handleSkip = useCallback(() => {
    webrtcService.cleanup();
    setMessages([]);
    setConnectionState(CONNECTION_STATES.WAITING);
    setStatusMessage('Skipped! Finding new partner...');
    
    socketService.emit('skip');
    socketService.emit('find_match');
  }, []);

  // Initialize application
  useEffect(() => {
    const initializeApp = async () => {
      try {
        performanceMonitor.start('app-init');
        
        setStatusMessage('Initializing application...');
        
        // Setup event handlers
        setupSocketHandlers();
        setupWebRTCHandlers();
        
        // Request notification permission
        await notifications.requestPermission();
        
        // Connect socket
        await socketService.connect();
        
        performanceMonitor.end('app-init');
        setIsInitializing(false);
        
      } catch (error) {
        performanceMonitor.end('app-init');
        handleError(error, 'initializeApp');
        setIsInitializing(false);
      }
    };

    initializeApp();
    
    // Cleanup on unmount
    return () => {
      webrtcService.destroy();
      socketService.disconnect();
    };
  }, [setupSocketHandlers, setupWebRTCHandlers, handleError]);

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
      } else if (e.key === 'm' && e.ctrlKey) {
        e.preventDefault();
        toggleMicrophone();
      } else if (e.key === 'v' && e.ctrlKey) {
        e.preventDefault();
        toggleCamera();
      }
    };

    document.addEventListener('keydown', handleKeyPress);
    return () => document.removeEventListener('keydown', handleKeyPress);
  }, [connectionState, handleSkip, toggleMicrophone, toggleCamera]);

  // Connection health monitoring
  useEffect(() => {
    if (!CONFIG.FEATURES.enableStats) return;
    
    const interval = setInterval(() => {
      const socketHealth = socketService.getHealth();
      const webrtcStats = webrtcService.getStats();
      
      setConnectionStats({
        socket: socketHealth,
        webrtc: webrtcStats,
        timestamp: Date.now()
      });
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  // Loading screen
  if (isInitializing) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-900 via-blue-900 to-indigo-900 text-white flex items-center justify-center">
        <div className="text-center">
          <div className="loading-spinner mb-4"></div>
          <h1 className="text-2xl font-bold mb-2">Initializing...</h1>
          <p className="text-gray-300">{statusMessage}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-900 via-blue-900 to-indigo-900 text-white">
      <div className="container mx-auto px-4 py-6 safe-top safe-bottom">
        {/* Header */}
        <header className="text-center mb-6">
          <h1 className="text-4xl font-bold gradient-text mb-2">
            {CONFIG.UI.appName}
          </h1>
          <p className="text-xl text-gray-300 mb-2">{statusMessage}</p>
          
          {error && (
            <div className="mt-4 p-3 glass-card border-red-500/50 rounded-lg text-red-200 error-shake">
              ⚠️ {error}
            </div>
          )}
        </header>

        {/* Video Container */}
        <div className="grid md:grid-cols-2 gap-6 mb-6">
          <div className="glass-card rounded-xl p-4">
            <h3 className="text-lg font-semibold mb-2 text-center text-green-400">You</h3>
            <div className="video-container">
              <video 
                ref={localVideoRef} 
                autoPlay 
                playsInline 
                muted
                className="w-full h-full object-cover"
              />
              <div className="video-overlay"></div>
              <div className="status-indicator">
                <div className={`status-dot ${micEnabled ? 'active bg-green-400' : 'bg-red-400'}`} title="Microphone"></div>
                <div className={`status-dot ${cameraEnabled ? 'active bg-green-400' : 'bg-red-400'}`} title="Camera"></div>
              </div>
            </div>
          </div>
          
          <div className="glass-card rounded-xl p-4">
            <h3 className="text-lg font-semibold mb-2 text-center text-blue-400">Partner</h3>
            <div className="video-container">
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
        <div className="flex justify-center gap-4 mb-6 flex-wrap">
          <button
            onClick={toggleMicrophone}
            className={micEnabled ? 'btn-success' : 'btn-danger'}
            title="Toggle Microphone (Ctrl+M)"
          >
            {micEnabled ? '🎤 Mic On' : '🔇 Mic Off'}
          </button>
          
          <button
            onClick={toggleCamera}
            className={cameraEnabled ? 'btn-success' : 'btn-danger'}
            title="Toggle Camera (Ctrl+V)"
          >
            {cameraEnabled ? '📷 Cam On' : '📷 Cam Off'}
          </button>
          
          {connectionState === CONNECTION_STATES.CONNECTED && (
            <button
              onClick={handleSkip}
              className="btn-warning"
              title="Skip to Next Partner (Esc)"
            >
              ⏭️ Next
            </button>
          )}
        </div>

        {/* Chat and Stats Container */}
        <div className="grid lg:grid-cols-3 gap-6">
          {/* Chat Interface */}
          <div className="lg:col-span-2">
            <div className="glass-card rounded-xl p-4">
              <h3 className="text-lg font-semibold mb-4 text-purple-400">Chat Messages</h3>
              <div className="message-container bg-gray-900/50 rounded-lg p-4 mb-4">
                <div className="space-y-2">
                  {messages.map((msg) => (
                    <div 
                      key={msg.id} 
                      className={`message ${msg.sender === MESSAGE_TYPES.USER ? 'user' : 
                        msg.sender === MESSAGE_TYPES.SYSTEM ? 'system' : 'stranger'}`}
                    >
                      <div className={`message-bubble ${msg.sender}`}>
                        <div className="text-xs opacity-70 mb-1">
                          {msg.sender === MESSAGE_TYPES.USER ? 'You' : 
                           msg.sender === MESSAGE_TYPES.SYSTEM ? 'System' : 'Partner'}
                          <span className="ml-2">{msg.formattedTime}</span>
                        </div>
                        <div>{msg.text}</div>
                      </div>
                    </div>
                  ))}
                  <div ref={messagesEndRef} />
                </div>
              </div>
              
              <div className="flex gap-2">
                <input
                  type="text"
                  value={inputMessage}
                  onChange={(e) => setInputMessage(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
                  disabled={connectionState !== CONNECTION_STATES.CONNECTED}
                  placeholder={connectionState === CONNECTION_STATES.CONNECTED ? "Type a message..." : "Connect to start chatting"}
                  className="flex-1 px-4 py-2 bg-gray-700/50 border border-gray-600/50 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:border-purple-500 focus:bg-gray-700 transition-all"
                  maxLength="500"
                />
                <button
                  onClick={sendMessage}
                  disabled={connectionState !== CONNECTION_STATES.CONNECTED || !inputMessage.trim()}
                  className={connectionState === CONNECTION_STATES.CONNECTED && inputMessage.trim() ? 'btn-primary' : 'btn-disabled'}
                >
                  Send
                </button>
              </div>
            </div>
          </div>
          
          {/* Connection Info Panel */}
          <div className="glass-card rounded-xl p-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-green-400">Connection Info</h3>
              {CONFIG.FEATURES.enableStats && (
                <button
                  onClick={() => setShowStats(!showStats)}
                  className="text-xs bg-gray-700 px-2 py-1 rounded"
                >
                  {showStats ? 'Hide' : 'Show'} Stats
                </button>
              )}
            </div>
            
            <div className="space-y-3 text-sm">
              <div>
                <span className="text-gray-400">Status:</span>
                <span className={`ml-2 font-semibold ${
                  connectionState === CONNECTION_STATES.CONNECTED ? 'text-green-400' : 
                  connectionState === CONNECTION_STATES.WAITING ? 'text-yellow-400' : 
                  connectionState === CONNECTION_STATES.CONNECTING ? 'text-blue-400' :
                  'text-red-400'
                }`}>
                  {connectionState.charAt(0).toUpperCase() + connectionState.slice(1)}
                </span>
              </div>
              
              {connectionState === CONNECTION_STATES.CONNECTED && (
                <>
                  <div>
                    <span className="text-gray-400">Quality:</span>
                    <div className="flex items-center ml-2">
                      <span className={`font-semibold ${
                        performanceStats.quality === 'excellent' ? 'text-green-400' : 
                        performanceStats.quality === 'good' ? 'text-yellow-400' : 
                        'text-red-400'
                      }`}>
                        {performanceStats.quality.charAt(0).toUpperCase() + performanceStats.quality.slice(1)}
                      </span>
                      <div className="quality-bars ml-2">
                        {[1, 2, 3, 4].map(i => (
                          <div 
                            key={i}
                            className={`quality-bar ${
                              performanceStats.quality === 'excellent' && i <= 4 ? 'excellent' :
                              performanceStats.quality === 'good' && i <= 3 ? 'good' :
                              performanceStats.quality === 'fair' && i <= 2 ? 'good' :
                              performanceStats.quality === 'poor' && i <= 1 ? 'poor' : ''
                            }`}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                  
                  {showStats && (
                    <>
                      <div>
                        <span className="text-gray-400">Packets Lost:</span>
                        <span className="ml-2 text-white">{performanceStats.packetsLost}</span>
                      </div>
                      
                      <div>
                        <span className="text-gray-400">Bandwidth:</span>
                        <div className="ml-2 text-white text-xs">
                          <div>↓ {performanceStats.bandwidth.inbound ? Math.round(performanceStats.bandwidth.inbound / 1024) + ' KB/s' : '0 KB/s'}</div>
                          <div>↑ {performanceStats.bandwidth.outbound ? Math.round(performanceStats.bandwidth.outbound / 1024) + ' KB/s' : '0 KB/s'}</div>
                        </div>
                      </div>
                    </>
                  )}
                </>
              )}
              
              {isReconnecting && (
                <div className="text-yellow-400 flex items-center">
                  <div className="loading-spinner mr-2"></div>
                  Reconnecting...
                </div>
              )}
              
              {showStats && connectionStats && (
                <div className="text-xs text-gray-500 mt-4 pt-4 border-t border-gray-700">
                  <div>Socket: {connectionStats.socket.connected ? 'Connected' : 'Disconnected'}</div>
                  <div>Transport: {connectionStats.socket.transport || 'Unknown'}</div>
                  <div>Queue: {connectionStats.socket.queueSize}</div>
                </div>
              )}
            </div>
          </div>
        </div>
        
        {/* Footer */}
        <footer className="text-center mt-8 text-gray-400 text-sm">
          <p>Press Enter to focus chat • Press Escape to skip • Ctrl+M for mic • Ctrl+V for camera</p>
          {CONFIG.FEATURES.debugMode && (
            <p className="mt-1 text-xs">Debug mode enabled • Check console for detailed logs</p>
          )}
        </footer>
      </div>
    </div>
  );
}