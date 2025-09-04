// =========================
// Production WebRTC Service
// =========================

import { CONFIG } from '../config';
import { performanceMonitor, errorHandler, AppError, mediaUtils, webrtcUtils, dev } from '../utils';

class WebRTCService {
  constructor() {
    this.peerConnection = null;
    this.localStream = null;
    this.remoteStream = null;
    this.localVideoRef = null;
    this.remoteVideoRef = null;
    
    this.audioSender = null;
    this.videoSender = null;
    
    this.iceCandidatesQueue = [];
    this.connectionState = 'new';
    this.iceConnectionState = 'new';
    
    this.stats = {
      packetsLost: 0,
      packetsReceived: 0,
      bytesReceived: 0,
      bytesSent: 0,
      timestamp: Date.now(),
      connectionTime: null,
      iceGatheringTime: null
    };
    
    this.statsInterval = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 3;
    
    this.eventHandlers = new Map();
    this.isDestroyed = false;
    
    // Bind methods to preserve context
    this.handleIceCandidate = this.handleIceCandidate.bind(this);
    this.handleTrack = this.handleTrack.bind(this);
    this.handleConnectionStateChange = this.handleConnectionStateChange.bind(this);
    this.handleICEConnectionStateChange = this.handleICEConnectionStateChange.bind(this);
    this.handleICEGatheringStateChange = this.handleICEGatheringStateChange.bind(this);
    this.handleSignalingStateChange = this.handleSignalingStateChange.bind(this);
  }

  // Event handling
  on(event, handler) {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event).add(handler);
  }

  off(event, handler) {
    if (this.eventHandlers.has(event)) {
      this.eventHandlers.get(event).delete(handler);
      if (this.eventHandlers.get(event).size === 0) {
        this.eventHandlers.delete(event);
      }
    }
  }

  emit(event, data) {
    if (this.eventHandlers.has(event)) {
      this.eventHandlers.get(event).forEach(handler => {
        try {
          handler(data);
        } catch (error) {
          dev.error(`Event handler for '${event}' error:`, error);
        }
      });
    }
  }

  // Initialize media devices
  async initializeMedia(constraints = null) {
    if (this.isDestroyed) {
      throw new AppError('WebRTC service is destroyed', 'WEBRTC');
    }

    performanceMonitor.start('media-init');
    
    try {
      // Check permissions first
      const permissions = await mediaUtils.checkPermissions();
      dev.log('Media permissions:', permissions);
      
      // Use provided constraints or get optimal ones
      const mediaConstraints = constraints || mediaUtils.getOptimalConstraints();
      dev.log('Using media constraints:', mediaConstraints);
      
      const stream = await navigator.mediaDevices.getUserMedia(mediaConstraints);
      this.localStream = stream;
      
      if (this.localVideoRef) {
        this.localVideoRef.srcObject = stream;
      }
      
      const audioTrack = stream.getAudioTracks()[0];
      const videoTrack = stream.getVideoTracks()[0];
      
      if (audioTrack) {
        audioTrack.addEventListener('ended', () => {
          dev.warn('Audio track ended');
          this.emit('audio_track_ended');
        });
      }
      
      if (videoTrack) {
        videoTrack.addEventListener('ended', () => {
          dev.warn('Video track ended');
          this.emit('video_track_ended');
        });
      }
      
      performanceMonitor.end('media-init');
      this.emit('media_initialized', { stream, audioTrack, videoTrack });
      
      return stream;
      
    } catch (error) {
      performanceMonitor.end('media-init');
      
      let errorMessage = 'Failed to access camera/microphone';
      let errorType = 'MEDIA_ACCESS';
      
      switch (error.name) {
        case 'NotAllowedError':
          errorMessage = 'Permission denied. Please allow camera and microphone access.';
          errorType = 'PERMISSION';
          break;
        case 'NotFoundError':
          errorMessage = 'No camera or microphone found.';
          break;
        case 'NotReadableError':
          errorMessage = 'Camera/microphone is being used by another application.';
          break;
        case 'OverconstrainedError':
          errorMessage = 'Camera/microphone constraints cannot be satisfied.';
          break;
        case 'SecurityError':
          errorMessage = 'Media access blocked due to security restrictions.';
          break;
        case 'TypeError':
          errorMessage = 'Invalid media constraints.';
          break;
      }
      
      const appError = new AppError(errorMessage, errorType, {
        originalError: error.message,
        name: error.name,
        constraint: error.constraint
      });
      
      this.emit('media_error', appError);
      throw appError;
    }
  }

  // Create and configure peer connection
  async createPeerConnection() {
    if (this.isDestroyed) {
      throw new AppError('WebRTC service is destroyed', 'WEBRTC');
    }

    performanceMonitor.start('peer-connection-init');
    
    try {
      if (this.peerConnection) {
        this.closePeerConnection();
      }

      dev.log('Creating peer connection with config:', CONFIG.ICE_SERVERS);
      
      this.peerConnection = new RTCPeerConnection(CONFIG.ICE_SERVERS);
      
      // Attach all native WebRTC events
      this.peerConnection.addEventListener('icecandidate', this.handleIceCandidate);
      this.peerConnection.addEventListener('track', this.handleTrack);
      this.peerConnection.addEventListener('connectionstatechange', this.handleConnectionStateChange);
      this.peerConnection.addEventListener('iceconnectionstatechange', this.handleICEConnectionStateChange);
      this.peerConnection.addEventListener('icegatheringstatechange', this.handleICEGatheringStateChange);
      this.peerConnection.addEventListener('signalingstatechange', this.handleSignalingStateChange);
      
      // Add local stream tracks if available
      if (this.localStream) {
        for (const track of this.localStream.getTracks()) {
          const sender = this.peerConnection.addTrack(track, this.localStream);
          
          if (track.kind === 'audio') {
            this.audioSender = sender;
          } else if (track.kind === 'video') {
            this.videoSender = sender;
          }
        }
        dev.log('Added local tracks to peer connection');
      }
      
      performanceMonitor.end('peer-connection-init');
      this.emit('peer_connection_created');
      
      return this.peerConnection;
      
    } catch (error) {
      performanceMonitor.end('peer-connection-init');
      const appError = new AppError('Failed to create peer connection', 'WEBRTC', {
        originalError: error.message
      });
      this.emit('peer_connection_error', appError);
      throw appError;
    }
  }

  // Event handlers
  handleIceCandidate(event) {
    if (event.candidate) {
      dev.log('ICE candidate generated:', event.candidate.type);
      this.emit('ice_candidate', { candidate: event.candidate });
    } else {
      dev.log('ICE gathering completed');
      this.stats.iceGatheringTime = Date.now() - this.stats.timestamp;
      this.emit('ice_gathering_complete');
    }
  }

  handleTrack(event) {
    dev.log('Remote track received:', event.track.kind);
    
    if (event.streams && event.streams[0]) {
      this.remoteStream = event.streams[0];
      
      if (this.remoteVideoRef && this.remoteVideoRef.srcObject !== this.remoteStream) {
        this.remoteVideoRef.srcObject = this.remoteStream;
        dev.log('Remote stream attached to video element');
      }
      
      this.emit('remote_stream', { 
        stream: event.streams[0], 
        track: event.track,
        kind: event.track.kind 
      });
    }
  }

  handleConnectionStateChange() {
    const newState = this.peerConnection?.connectionState;
    const oldState = this.connectionState;

    if (newState !== oldState) {
      this.connectionState = newState;
      dev.log('Connection state changed:', oldState, '->', newState);
      
      switch (newState) {
        case 'connected':
          this.stats.connectionTime = Date.now() - this.stats.timestamp;
          this.startStatsCollection();
          this.reconnectAttempts = 0;
          this.emit('connected');
          break;
        case 'disconnected':
        case 'failed':
          this.stopStatsCollection();
          this.handleConnectionFailure();
          break;
        case 'closed':
          this.stopStatsCollection();
          this.emit('closed');
          break;
      }
      
      this.emit('connection_state_change', { 
        oldState, 
        newState, 
        connectionTime: this.stats.connectionTime 
      });
    }
  }

  handleICEConnectionStateChange() {
    const newState = this.peerConnection?.iceConnectionState;
    const oldState = this.iceConnectionState;
    
    if (newState !== oldState) {
      this.iceConnectionState = newState;
      dev.log('ICE connection state changed:', oldState, '->', newState);
      
      this.emit('ice_connection_state_change', { oldState, newState });
    }
  }

  handleICEGatheringStateChange() {
    const state = this.peerConnection?.iceGatheringState;
    dev.log('ICE gathering state changed:', state);
    
    if (state === 'complete') {
      this.stats.iceGatheringTime = Date.now() - this.stats.timestamp;
    }
    
    this.emit('ice_gathering_state_change', { state });
  }

  handleSignalingStateChange() {
    dev.log('Signaling state changed:', this.peerConnection?.signalingState);
    this.emit('signaling_state_change', { state: this.peerConnection?.signalingState });
  }

  // Handle connection failures with intelligent recovery
  async handleConnectionFailure() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      dev.error('Max reconnection attempts reached');
      this.emit('connection_failed', { 
        attempts: this.reconnectAttempts,
        message: 'Unable to establish stable connection'
      });
      return;
    }

    this.reconnectAttempts++;
    dev.log(`Attempting connection recovery (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
    
    try {
      const waitTime = Math.pow(2, this.reconnectAttempts) * 1000;
      await new Promise(resolve => setTimeout(resolve, waitTime));
      
      if (this.peerConnection && this.peerConnection.connectionState !== 'closed') {
        await this.restartIce();
        dev.log('ICE restart initiated for recovery.');
      }
      
      this.emit('connection_recovery_attempt', { attempt: this.reconnectAttempts });
      
    } catch (error) {
      dev.error('Connection recovery failed:', error);
      this.emit('connection_recovery_failed', { 
        attempt: this.reconnectAttempts, 
        error: error.message 
      });
    }
  }

  // Create and handle offers/answers
  async createOffer(options = {}) {
    if (this.isDestroyed || !this.peerConnection) {
      throw new AppError('No peer connection available', 'WEBRTC');
    }

    performanceMonitor.start('create-offer');
    
    try {
      const defaultOptions = {
        offerToReceiveAudio: true,
        offerToReceiveVideo: true,
        ...options
      };
      
      const offer = await this.peerConnection.createOffer(defaultOptions);
      await this.peerConnection.setLocalDescription(offer);
      
      dev.log('Offer created and set as local description');
      performanceMonitor.end('create-offer');
      
      this.emit('offer_created', { offer });
      return offer;
      
    } catch (error) {
      performanceMonitor.end('create-offer');
      const appError = new AppError('Failed to create offer', 'WEBRTC', {
        originalError: error.message
      });
      this.emit('offer_error', appError);
      throw appError;
    }
  }

  async createAnswer(options = {}) {
    if (this.isDestroyed || !this.peerConnection) {
      throw new AppError('No peer connection available', 'WEBRTC');
    }

    performanceMonitor.start('create-answer');
    
    try {
      const answer = await this.peerConnection.createAnswer(options);
      await this.peerConnection.setLocalDescription(answer);
      
      dev.log('Answer created and set as local description');
      performanceMonitor.end('create-answer');
      
      this.emit('answer_created', { answer });
      return answer;
      
    } catch (error) {
      performanceMonitor.end('create-answer');
      const appError = new AppError('Failed to create answer', 'WEBRTC', {
        originalError: error.message
      });
      this.emit('answer_error', appError);
      throw appError;
    }
  }

  async setRemoteDescription(description) {
    if (this.isDestroyed || !this.peerConnection) {
      throw new AppError('No peer connection available', 'WEBRTC');
    }

    try {
      // Use RTCSessionDescription to ensure the object is correct
      const sdp = new RTCSessionDescription(description);
      
      dev.log(`Setting remote ${sdp.type} description...`);
      
      // Crucial state check to handle race conditions
      if (sdp.type === 'answer' && this.peerConnection.signalingState !== 'have-local-offer') {
          dev.warn('Cannot set remote answer, wrong state:', this.peerConnection.signalingState);
          // If a race condition occurs, we close the connection and try to restart
          this.closePeerConnection();
          this.emit('signaling_error', new AppError(`Signaling race condition: Received answer in state ${this.peerConnection.signalingState}`, 'WEBRTC_RACE_CONDITION'));
          throw new Error('Signaling state error');
      }

      await this.peerConnection.setRemoteDescription(sdp);
      
      await this.processQueuedICECandidates();
      
      this.emit('remote_description_set', {description});
      
    } catch (error) {
      const appError = new AppError('Failed to set remote description', 'WEBRTC', {
        originalError: error.message,
        description: description.type
      });
      this.emit('remote_description_error', appError);
      throw appError;
    }
  }

  // ICE candidate handling
  async addICECandidate(candidate) {
    if (this.isDestroyed || !this.peerConnection) {
      dev.warn('No peer connection available, queueing ICE candidate');
      this.iceCandidatesQueue.push(candidate);
      return;
    }

    if (!this.peerConnection.remoteDescription) {
      dev.log('No remote description yet, queueing ICE candidate');
      this.iceCandidatesQueue.push(candidate);
      return;
    }

    try {
      await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      dev.log('ICE candidate added successfully');
      
    } catch (error) {
      dev.warn('Failed to add ICE candidate:', error.message);
    }
  }

  async processQueuedICECandidates() {
    if (this.iceCandidatesQueue.length === 0) return;
    
    dev.log(`Processing ${this.iceCandidatesQueue.length} queued ICE candidates`);
    
    const candidates = [...this.iceCandidatesQueue];
    this.iceCandidatesQueue.length = 0;
    
    for (const candidate of candidates) {
      try {
        await this.addICECandidate(candidate);
      } catch (error) {
        dev.error('Error adding queued ICE candidate:', error);
      }
    }
  }

  // Media controls
  async toggleAudio(enabled) {
    if (this.isDestroyed || !this.localStream) {
      throw new AppError('No local stream available', 'WEBRTC');
    }

    const audioTrack = this.localStream.getAudioTracks()[0];
    if (!audioTrack) {
      dev.warn('No audio track available');
      return false;
    }
    
    audioTrack.enabled = enabled;

    if (this.audioSender) {
      try {
        await this.audioSender.replaceTrack(enabled ? audioTrack : null);
        dev.log('Audio toggled via sender:', enabled);
      } catch (error) {
        dev.warn('Failed to update audio sender:', error);
        return false;
      }
    }
    
    this.emit('audio_toggled', { enabled, track: audioTrack });
    return true;
  }

  async toggleVideo(enabled) {
    if (this.isDestroyed || !this.localStream) {
      throw new AppError('No local stream available', 'WEBRTC');
    }

    const videoTrack = this.localStream.getVideoTracks()[0];
    if (!videoTrack) {
      dev.warn('No video track available');
      return false;
    }
    
    videoTrack.enabled = enabled;

    if (this.videoSender) {
      try {
        await this.videoSender.replaceTrack(enabled ? videoTrack : null);
        dev.log('Video toggled via sender:', enabled);
      } catch (error) {
        dev.warn('Failed to update video sender:', error);
        return false;
      }
    }
    
    this.emit('video_toggled', { enabled, track: videoTrack });
    return true;
  }

  // Advanced features
  async restartIce() {
    if (this.isDestroyed || !this.peerConnection) {
      throw new AppError('No peer connection available', 'WEBRTC');
    }

    try {
      dev.log('Restarting ICE...');
      
      const offer = await this.peerConnection.createOffer({ iceRestart: true });
      await this.peerConnection.setLocalDescription(offer);
      
      this.emit('ice_restart', { offer });
      return offer;
      
    } catch (error) {
      const appError = new AppError('Failed to restart ICE', 'WEBRTC', {
        originalError: error.message
      });
      this.emit('ice_restart_error', appError);
      throw appError;
    }
  }

  // Statistics collection
  startStatsCollection() {
    if (this.statsInterval || !this.peerConnection) return;
    
    this.statsInterval = setInterval(async () => {
      try {
        await this.collectStats();
      } catch (error) {
        dev.warn('Stats collection failed:', error);
      }
    }, CONFIG.PERFORMANCE.statsInterval);
    
    dev.log('Started stats collection');
  }

  stopStatsCollection() {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
      dev.log('Stopped stats collection');
    }
  }

  async collectStats() {
    if (!this.peerConnection) return;
    
    try {
      const stats = await this.peerConnection.getStats();
      let inboundRtp = null;
      let outboundRtp = null;
      let candidatePair = null;
      
      stats.forEach(report => {
        if (report.type === 'inbound-rtp' && report.mediaType === 'video') {
          inboundRtp = report;
        } else if (report.type === 'outbound-rtp' && report.mediaType === 'video') {
          outboundRtp = report;
        } else if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          candidatePair = report;
        }
      });
      
      if (inboundRtp || outboundRtp) {
        const newStats = {
          packetsLost: inboundRtp?.packetsLost || 0,
          packetsReceived: inboundRtp?.packetsReceived || 0,
          bytesReceived: inboundRtp?.bytesReceived || 0,
          bytesSent: outboundRtp?.bytesSent || 0,
          timestamp: Date.now(),
          jitter: inboundRtp?.jitter || 0,
          roundTripTime: candidatePair?.currentRoundTripTime || 0,
          availableOutgoingBitrate: candidatePair?.availableOutgoingBitrate || 0
        };
        
        const lossRate = newStats.packetsReceived > 0 
          ? newStats.packetsLost / (newStats.packetsLost + newStats.packetsReceived) 
          : 0;
        
        newStats.quality = webrtcUtils.getConnectionQuality({ 
          packetsLost: newStats.packetsLost,
          packetsReceived: newStats.packetsReceived 
        });
        
        newStats.bandwidth = {
          inbound: this.calculateBandwidth(newStats.bytesReceived, this.stats.bytesReceived, newStats.timestamp, this.stats.timestamp),
          outbound: this.calculateBandwidth(newStats.bytesSent, this.stats.bytesSent, newStats.timestamp, this.stats.timestamp)
        };
        
        this.stats = { ...this.stats, ...newStats };
        this.emit('stats_updated', this.stats);
      }
    } catch (error) {
      dev.warn('Failed to collect WebRTC stats:', error);
    }
  }

  calculateBandwidth(currentBytes, previousBytes, currentTime, previousTime) {
    const byteDiff = currentBytes - previousBytes;
    const timeDiff = (currentTime - previousTime) / 1000; // Convert to seconds
    
    if (timeDiff <= 0) return 0;
    
    return Math.round(byteDiff / timeDiff); // Bytes per second
  }

  // Video references management
  setVideoRefs(localVideoRef, remoteVideoRef) {
    this.localVideoRef = localVideoRef;
    this.remoteVideoRef = remoteVideoRef;
    
    if (this.localStream && localVideoRef && !localVideoRef.srcObject) {
      localVideoRef.srcObject = this.localStream;
    }
    
    if (this.remoteStream && remoteVideoRef && !remoteVideoRef.srcObject) {
      remoteVideoRef.srcObject = this.remoteStream;
    }
  }

  // Cleanup methods
  stopLocalStream() {
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        track.stop();
        dev.log('Stopped track:', track.kind);
      });
      this.localStream = null;
      
      if (this.localVideoRef) {
        this.localVideoRef.srcObject = null;
      }
    }
  }

  closePeerConnection() {
    this.stopStatsCollection();
    
    if (this.peerConnection) {
      // Remove all event listeners to prevent memory leaks
      this.peerConnection.removeEventListener('icecandidate', this.handleIceCandidate);
      this.peerConnection.removeEventListener('track', this.handleTrack);
      this.peerConnection.removeEventListener('connectionstatechange', this.handleConnectionStateChange);
      this.peerConnection.removeEventListener('iceconnectionstatechange', this.handleICEConnectionStateChange);
      this.peerConnection.removeEventListener('icegatheringstatechange', this.handleICEGatheringStateChange);
      this.peerConnection.removeEventListener('signalingstatechange', this.handleSignalingStateChange);
      
      this.peerConnection.close();
      this.peerConnection = null;
      
      dev.log('Peer connection closed');
    }
    
    if (this.remoteVideoRef) {
      this.remoteVideoRef.srcObject = null;
    }
    
    this.remoteStream = null;
    this.audioSender = null;
    this.videoSender = null;
    this.iceCandidatesQueue.length = 0;
    this.connectionState = 'new';
    this.iceConnectionState = 'new';
    this.reconnectAttempts = 0;
  }

  cleanup() {
    dev.log('Cleaning up WebRTC service...');
    
    this.stopLocalStream();
    this.closePeerConnection();
    
    this.stats = {
      packetsLost: 0,
      packetsReceived: 0,
      bytesReceived: 0,
      bytesSent: 0,
      timestamp: Date.now(),
      connectionTime: null,
      iceGatheringTime: null
    };
  }

  destroy() {
    dev.log('Destroying WebRTC service...');
    this.isDestroyed = true;
    
    this.cleanup();
    this.eventHandlers.clear();
    
    this.localVideoRef = null;
    this.remoteVideoRef = null;
  }

  // Getters for state information
  getConnectionState() {
    return {
      connection: this.connectionState,
      ice: this.iceConnectionState,
      gathering: this.peerConnection?.iceGatheringState || 'new',
      signaling: this.peerConnection?.signalingState || 'stable'
    };
  }

  getMediaState() {
    const audioTrack = this.localStream?.getAudioTracks()[0];
    const videoTrack = this.localStream?.getVideoTracks()[0];
    
    return {
      hasLocalStream: !!this.localStream,
      hasRemoteStream: !!this.remoteStream,
      audioEnabled: audioTrack?.enabled || false,
      videoEnabled: videoTrack?.enabled || false,
      audioTrackState: audioTrack?.readyState || 'none',
      videoTrackState: videoTrack?.readyState || 'none'
    };
  }

  getStats() {
    return {
      ...this.stats,
      connection: this.getConnectionState(),
      media: this.getMediaState(),
      queuedCandidates: this.iceCandidatesQueue.length,
      reconnectAttempts: this.reconnectAttempts,
      isDestroyed: this.isDestroyed
    };
  }

  // Health check
  isHealthy() {
    return (
      !this.isDestroyed &&
      this.connectionState === 'connected' &&
      this.iceConnectionState === 'connected' &&
      !!this.localStream &&
      !!this.remoteStream
    );
  }
}

// Create singleton instance
const webrtcService = new WebRTCService();

// Enhanced interface for ease of use
const webrtcInterface = {
  // Core methods
  initializeMedia: (constraints) => webrtcService.initializeMedia(constraints),
  createPeerConnection: () => webrtcService.createPeerConnection(),
  createOffer: (options) => webrtcService.createOffer(options),
  createAnswer: (options) => webrtcService.createAnswer(options),
  setRemoteDescription: (description) => webrtcService.setRemoteDescription(description),
  addICECandidate: (candidate) => webrtcService.addICECandidate(candidate),
  
  // Media controls
  toggleAudio: (enabled) => webrtcService.toggleAudio(enabled),
  toggleVideo: (enabled) => webrtcService.toggleVideo(enabled),
  
  // Advanced features
  restartIce: () => webrtcService.restartIce(),
  
  // Video references
  setVideoRefs: (local, remote) => webrtcService.setVideoRefs(local, remote),
  
  // Event handling
  on: (event, handler) => webrtcService.on(event, handler),
  off: (event, handler) => webrtcService.off(event, handler),
  
  // State and statistics
  getConnectionState: () => webrtcService.getConnectionState(),
  getMediaState: () => webrtcService.getMediaState(),
  getStats: () => webrtcService.getStats(),
  isHealthy: () => webrtcService.isHealthy(),
  
  // Cleanup
  cleanup: () => webrtcService.cleanup(),
  destroy: () => webrtcService.destroy(),
  
  // Direct access to service (use carefully)
  get service() { return webrtcService; }
};

// Development debugging
if (CONFIG.FEATURES.debugMode) {
  window.webrtcDebug = {
    service: webrtcService,
    interface: webrtcInterface,
    getState: () => ({
      connection: webrtcService.getConnectionState(),
      media: webrtcService.getMediaState(),
      stats: webrtcService.getStats()
    }),
    testICE: () => webrtcUtils.testICEServers()
  };
}

export default webrtcInterface;