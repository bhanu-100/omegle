import React, { useEffect, useState, useRef, useCallback } from 'react';
import { CONFIG } from './config';
import { messageUtils, performanceMonitor, errorHandler, dev, notifications } from './utils';
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
  const [micEnabled, setMicEnabled] = useState(false);
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [messages, setMessages] = useState([]);
  const [inputMessage, setInputMessage] = useState('');
  const [statusMessage, setStatusMessage] = useState('Initializing...');
  const [error, setError] = useState(null);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [performanceStats, setPerformanceStats] = useState({
    packetsLost: 0,
    packetsReceived: 0,
    bandwidth: { inbound: 0, outbound: 0 },
    latency: 0,
    quality: 'good'
  });
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

    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 100);
  }, []);

  const handleError = useCallback((err, context = '') => {
    const errorMessage = errorHandler.handle(err, 'Something went wrong. Please try again.');
    setError(errorMessage);
    setTimeout(() => setError(null), 5000);
    dev.error('App error:', err, context);
  }, []);

  const startSession = useCallback(async () => {
    try {
      webrtcService.cleanup();
      setMessages([]);
      setConnectionState(CONNECTION_STATES.WAITING);
      
      setStatusMessage('Requesting camera and microphone access...');
      const stream = await webrtcService.initializeMedia();
      setMicEnabled(stream.getAudioTracks()[0]?.enabled || false);
      setCameraEnabled(stream.getVideoTracks()[0]?.enabled || false);
      
      setStatusMessage('Media access granted. Looking for a partner...');
      socketService.emit('find_match');
      
    } catch (err) {
      handleError(err, 'startSession');
      webrtcService.cleanup();
      setConnectionState(CONNECTION_STATES.ERROR);
    }
  }, [handleError]);

  const handleSkip = useCallback(() => {
    addMessage(MESSAGE_TYPES.SYSTEM, 'Skipping to the next partner...');
    startSession();
  }, [addMessage, startSession]);

  const handleMatchFound = useCallback(async (data) => {
    try {
      performanceMonitor.start('match-setup');
      const { peerId } = data;
      setConnectionState(CONNECTION_STATES.CONNECTING);
      setStatusMessage('Partner found! Setting up video...');
      setMessages([]);
      setError(null);
      
      await webrtcService.createPeerConnection();
      
      const offer = await webrtcService.createOffer();
      dev.log('Emitting WebRTC offer...');
      await socketService.emit('webrtc_offer', { sdp: offer });
      
      performanceMonitor.end('match-setup');
      dev.log('Matched with peer:', peerId);
      
      if (document.hidden) {
        notifications.show('WebRTC Chat', {
          body: 'Found a chat partner!',
          tag: 'match-found'
        });
      }
    } catch (err) {
      performanceMonitor.end('match-setup');
      handleError(err, 'handleMatchFound');
    }
  }, [addMessage, handleError]);

  const handleWebRTCOffer = useCallback(async ({ sdp }) => {
    try {
      dev.log('Received WebRTC offer. Creating peer connection...');
      if (!webrtcService.service.peerConnection) {
        await webrtcService.createPeerConnection();
      }
      
      dev.log('Setting remote offer description...');
      await webrtcService.setRemoteDescription(sdp);

      dev.log('Creating and setting local answer...');
      const answer = await webrtcService.createAnswer();
      dev.log('Emitting WebRTC answer...');
      await socketService.emit('webrtc_answer', { sdp: answer });

    } catch (err) {
      handleError(err, 'handleWebRTCOffer');
    }
  }, [handleError]);

  const handleWebRTCAnswer = useCallback(async ({ sdp }) => {
    try {
      dev.log('Received WebRTC answer.');
      // FIX: Check signaling state to prevent "Called in wrong state: stable" error
      if (webrtcService.service.peerConnection?.signalingState !== 'have-local-offer') {
        dev.warn('Received an answer in the wrong signaling state. Ignoring.');
        // Don't throw an error here, simply ignore the late answer
        return; 
      }
      
      dev.log('Setting remote answer description...');
      await webrtcService.setRemoteDescription(sdp);
      
    } catch (err) {
      handleError(err, 'handleWebRTCAnswer');
    }
  }, [handleError]);

  const handleICECandidate = useCallback(async ({ candidate }) => {
    try {
      dev.log('Received ICE candidate from signaling server...');
      if (candidate?.candidate) {
        await webrtcService.addICECandidate(candidate);
      }
    } catch (err) {
      dev.warn('ICE candidate error:', err);
    }
  }, []);

  const handlePeerDisconnected = useCallback(() => {
    setConnectionState(CONNECTION_STATES.WAITING);
    setStatusMessage('Partner left. Finding new partner...');
    addMessage(MESSAGE_TYPES.SYSTEM, 'Partner disconnected');
    setTimeout(() => {
      if (socketService.connected) {
        startSession();
      }
    }, 2000);
  }, [addMessage, startSession]);

  const handleRateLimited = useCallback(() => {
    setConnectionState(CONNECTION_STATES.RATE_LIMITED);
    setStatusMessage('Rate limited. Please wait before trying again...');
    setError('You are sending requests too quickly. Please wait a moment.');
    
    setTimeout(() => {
      if (socketService.connected) {
        setConnectionState(CONNECTION_STATES.WAITING);
        setError(null);
        startSession();
      }
    }, 30000);
  }, [startSession]);

  const toggleMicrophone = useCallback(async () => {
    try {
      const newState = !micEnabled;
      const success = await webrtcService.toggleAudio(newState);
      if (success) {
        setMicEnabled(newState);
        addMessage(MESSAGE_TYPES.SYSTEM, `Microphone ${newState ? 'enabled' : 'disabled'}`);
      } else {
        throw new Error('Could not toggle audio track.');
      }
    } catch (err) {
      handleError(err, 'toggleMicrophone');
    }
  }, [micEnabled, addMessage, handleError]);

  const toggleCamera = useCallback(async () => {
    try {
      const newState = !cameraEnabled;
      const success = await webrtcService.toggleVideo(newState);
      if (success) {
        setCameraEnabled(newState);
        addMessage(MESSAGE_TYPES.SYSTEM, `Camera ${newState ? 'enabled' : 'disabled'}`);
      } else {
        throw new Error('Could not toggle video track.');
      }
    } catch (err) {
      handleError(err, 'toggleCamera');
    }
  }, [cameraEnabled, addMessage, handleError]);

  const sendMessage = useCallback(async () => {
    if (!inputMessage.trim() || connectionState !== CONNECTION_STATES.CONNECTED) return;
    const sanitized = messageUtils.sanitizeMessage(inputMessage);
    if (!messageUtils.isValidMessage(sanitized)) {
      setError('Invalid message. Please check your input.');
      return;
    }
    
    try {
      const ack = await socketService.emit('message', sanitized);
      if (!ack || ack.error) {
        throw new Error(ack?.error || 'user may be offline,try again');
      }
      addMessage(MESSAGE_TYPES.USER, sanitized);
      setInputMessage('');
    } catch (err) {
      handleError(err, 'sendMessage');
    }
  }, [inputMessage, connectionState, addMessage, handleError]);

  // Set up all event handlers in separate useEffects for clarity
  useEffect(() => {
    webrtcService.setVideoRefs(localVideoRef.current, remoteVideoRef.current);
    
    const onMediaInitialized = ({ stream }) => {
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
    };

    const onRemoteStream = ({ stream }) => {
      dev.log('Remote stream received');
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = stream;
      }
      setStatusMessage('Video connected!');
      setConnectionState(CONNECTION_STATES.CONNECTED);
    };

    const onConnectionStateChange = ({ newState }) => {
      dev.log('WebRTC connection state:', newState);
      if (newState === 'connected') {
        setStatusMessage('WebRTC Connected!');
      } else if (newState === 'failed' || newState === 'disconnected') {
        setStatusMessage('Connection lost. Trying to reconnect...');
      }
    };
    const onStatsUpdated = (stats) => setPerformanceStats(prev => ({ ...prev, ...stats }));
    const onMediaError = (err) => handleError(err, 'webrtc_media_error');
    const onIceCandidate = ({ candidate }) => socketService.emit('webrtc_ice_candidate', { candidate });
    
    webrtcService.on('media_initialized', onMediaInitialized);
    webrtcService.on('remote_stream', onRemoteStream);
    webrtcService.on('connection_state_change', onConnectionStateChange);
    webrtcService.on('stats_updated', onStatsUpdated);
    webrtcService.on('media_error', onMediaError);
    webrtcService.on('ice_candidate', onIceCandidate);
    
    return () => {
      webrtcService.off('media_initialized', onMediaInitialized);
      webrtcService.off('remote_stream', onRemoteStream);
      webrtcService.off('connection_state_change', onConnectionStateChange);
      webrtcService.off('stats_updated', onStatsUpdated);
      webrtcService.off('media_error', onMediaError);
      webrtcService.off('ice_candidate', onIceCandidate);
    };
  }, [handleError]);

  useEffect(() => {
    const onMatchFound = (data) => {
      dev.log('Match found:', data);
      handleMatchFound(data);
    };
    const onMessage = (data) => {
      if (data) addMessage(MESSAGE_TYPES.STRANGER, data);
    };
    const onConnect = () => {
      dev.log('Socket connected');
      setIsReconnecting(false);
      setConnectionState(CONNECTION_STATES.WAITING);
      setStatusMessage('Looking for a chat partner...');
      setError(null);
      startSession();
    };
    const onDisconnect = ({ reason }) => {
      dev.log('Socket disconnected:', reason);
      setConnectionState(CONNECTION_STATES.DISCONNECTED);
      setStatusMessage('Connection lost. Reconnecting...');
      setIsReconnecting(true);
    };

    const cleanups = [
      socketService.on('match_found', onMatchFound),
      socketService.on('webrtc_offer', handleWebRTCOffer),
      socketService.on('webrtc_answer', handleWebRTCAnswer),
      socketService.on('webrtc_ice_candidate', handleICECandidate),
      socketService.on('peer_disconnected', handlePeerDisconnected),
      socketService.on('match_cancelled', handlePeerDisconnected),
      socketService.on('rate_limited', handleRateLimited),
      socketService.on('message', onMessage),
      socketService.on('waiting', () => {
        setConnectionState(CONNECTION_STATES.WAITING);
        setStatusMessage('Waiting for partner...');
      }),
      socketService.on('connect', onConnect),
      socketService.on('disconnect', onDisconnect),
      socketService.on('error', (err) => {
        dev.error('Socket connection error:', err);
        setConnectionState(CONNECTION_STATES.ERROR);
        handleError(err, 'socket_connect_error');
      }),
      socketService.on('signaling_error', (err) => {
        dev.error('Signaling error:', err.error);
        setConnectionState(CONNECTION_STATES.ERROR);
        handleError(err, err.message);
      }),
    ];
    
    return () => cleanups.forEach(off => off());
  }, [handleError, addMessage, handlePeerDisconnected, handleMatchFound, handleWebRTCOffer, handleWebRTCAnswer, handleICECandidate, handleRateLimited, startSession]);

  useEffect(() => {
    const initializeApp = async () => {
      try {
        performanceMonitor.start('app-init');
        setStatusMessage('Initializing application...');
        await notifications.requestPermission();
        await socketService.connect();
        performanceMonitor.end('app-init');
        setIsInitializing(false);
      } catch (err) {
        performanceMonitor.end('app-init');
        handleError(err, 'initializeApp');
        setIsInitializing(false);
      }
    };
    initializeApp();
    return () => {
      webrtcService.destroy();
      socketService.disconnect();
    };
  }, [handleError]);

  useEffect(() => {
    const handleKeyPress = (e) => {
      if (e.key === 'Enter' && e.target.tagName !== 'INPUT') {
        e.preventDefault();
        const input = document.querySelector('input[type="text"]');
        if (input) input.focus();
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
  }, [handleSkip, toggleMicrophone, toggleCamera]);

  // Main rendering logic
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
        <header className="text-center mb-6">
          <h1 className="text-4xl font-bold gradient-text mb-2">{CONFIG.UI.appName}</h1>
          <p className="text-xl text-gray-300 mb-2">{statusMessage}</p>
          {error && (
            <div className="mt-4 p-3 glass-card border-red-500/50 rounded-lg text-red-200 error-shake">
              ⚠️ {error}
            </div>
          )}
        </header>
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
        <div className="flex justify-center gap-4 mb-6 flex-wrap">
          <button
            onClick={toggleMicrophone}
            className={micEnabled ? 'btn-success' : 'btn-danger'}
            disabled={connectionState !== CONNECTION_STATES.CONNECTED}
            title="Toggle Microphone (Ctrl+M)"
          >
            {micEnabled ? '🎤 Mic On' : '🔇 Mic Off'}
          </button>
          <button
            onClick={toggleCamera}
            className={cameraEnabled ? 'btn-success' : 'btn-danger'}
            disabled={connectionState !== CONNECTION_STATES.CONNECTED}
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
        <div className="grid lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2">
            <div className="glass-card rounded-xl p-4">
              <h3 className="text-lg font-semibold mb-4 text-purple-400">Chat Messages</h3>
              <div className="message-container bg-gray-900/50 rounded-lg p-4 mb-4">
                <div className="space-y-2">
                  {messages.map((msg) => (
                    <div 
                      key={msg.id} 
                      className={`message ${msg.sender === MESSAGE_TYPES.USER ? 'user' : msg.sender === MESSAGE_TYPES.SYSTEM ? 'system' : 'stranger'}`}
                    >
                      <div className={`message-bubble ${msg.sender}`}>
                        <div className="text-xs opacity-70 mb-1">
                          {msg.sender === MESSAGE_TYPES.USER ? 'You' : msg.sender === MESSAGE_TYPES.SYSTEM ? 'System' : 'Partner'}
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
              {showStats && (
                <div className="text-xs text-gray-500 mt-4 pt-4 border-t border-gray-700">
                  <div>Socket: {socketService.connected ? 'Connected' : 'Disconnected'}</div>
                  <div>Transport: {socketService.getHealth().transport || 'Unknown'}</div>
                  <div>Queue: {socketService.getHealth().queueSize}</div>
                </div>
              )}
            </div>
          </div>
        </div>
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