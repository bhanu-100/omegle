const redisService = require('./redisService');
const kafkaService = require('./kafkaService');
const connectionService = require('./connectionService');
const logger = require('../utils/logger');
const metrics = require('../monitoring/metrics');

class SignalingService {
  constructor() {
    this.signalTypes = {
      OFFER: 'webrtc_offer',
      ANSWER: 'webrtc_answer',
      ICE_CANDIDATE: 'webrtc_ice_candidate',
      ERROR: 'webrtc_error'
    };
    
    this.maxSignalSize = 64 * 1024; // 64KB max signal size
  }

  async forwardSignal(socket, userKey, signalType, data, io) {
    const startTime = Date.now();
    
    try {
      // Validate signal data
      if (!this.validateSignalData(signalType, data)) {
        socket.emit('error', {
          type: 'invalid_signal',
          message: 'Invalid signal data'
        });
        return;
      }

      // Update user activity
      connectionService.updateActivity(userKey);

      // Get peer for this user
      const peerKey = await redisService.getMatch(userKey);
      if (!peerKey) {
        logger.debug('No peer found for signaling', {
          signalType,
          userKey,
          worker: process.pid
        });
        
        socket.emit('error', {
          type: 'no_peer',
          message: 'No active peer connection'
        });
        return;
      }

      // Get peer socket ID
      const peerSocketId = await redisService.getSocketId(peerKey);
      if (!peerSocketId) {
        logger.warn('Peer socket not found', {
          signalType,
          userKey,
          peerKey,
          worker: process.pid
        });
        
        socket.emit('peer_disconnected', {
          peerKey,
          reason: 'socket_not_found'
        });
        
        // Clean up the match
        await redisService.deleteMatch(userKey);
        await redisService.deleteMatch(peerKey);
        return;
      }

      // Prepare signal payload
      const payload = {
        ...data,
        from: userKey,
        to: peerKey,
        timestamp: Date.now(),
        signalId: this.generateSignalId()
      };

      // Forward signal to peer
      if (io) {
        io.to(peerSocketId).emit(signalType, payload);
      } else {
        // Fallback: use socket.to() if io not available
        socket.to(peerSocketId).emit(signalType, payload);
      }

      // Update metrics
      const duration = Date.now() - startTime;
      metrics.signalingMessages.inc({ 
        type: signalType, 
        worker: process.pid 
      });
      
      metrics.signalingLatency.observe({ 
        type: signalType 
      }, duration / 1000);

      // Log signaling event
      kafkaService.logSignalingEvent(
        'signal_forwarded',
        userKey,
        peerKey,
        signalType,
        {
          signalId: payload.signalId,
          dataSize: JSON.stringify(data).length,
          duration
        }
      );

      logger.debug('Signal forwarded successfully', {
        signalType,
        userKey,
        peerKey,
        signalId: payload.signalId,
        duration,
        worker: process.pid
      });

    } catch (error) {
      logger.error('Signal forwarding failed', {
        error: error.message,
        signalType,
        userKey,
        worker: process.pid
      });

      metrics.errorRate.inc({ 
        type: 'signaling', 
        worker: process.pid 
      });

      socket.emit('error', {
        type: 'signaling_error',
        message: 'Failed to forward signal'
      });

      kafkaService.logErrorEvent('signaling', userKey, error, {
        signalType
      });
    }
  }

  validateSignalData(signalType, data) {
    if (!data || typeof data !== 'object') {
      return false;
    }

    // Check payload size
    const dataSize = JSON.stringify(data).length;
    if (dataSize > this.maxSignalSize) {
      logger.warn('Signal data too large', {
        signalType,
        dataSize,
        maxSize: this.maxSignalSize
      });
      return false;
    }

    // Validate specific signal types
    switch (signalType) {
      case this.signalTypes.OFFER:
        return this.validateOffer(data);
      
      case this.signalTypes.ANSWER:
        return this.validateAnswer(data);
      
      case this.signalTypes.ICE_CANDIDATE:
        return this.validateIceCandidate(data);
      
      case this.signalTypes.ERROR:
        return this.validateError(data);
      
      default:
        return false;
    }
  }

  validateOffer(data) {
    return !!(
      data.sdp && 
      typeof data.sdp === 'string' &&
      data.type === 'offer' &&
      data.sdp.includes('v=0') // Basic SDP validation
    );
  }

  validateAnswer(data) {
    return !!(
      data.sdp && 
      typeof data.sdp === 'string' &&
      data.type === 'answer' &&
      data.sdp.includes('v=0') // Basic SDP validation
    );
  }

  validateIceCandidate(data) {
    return !!(
      data.candidate !== undefined && // Can be null for end-of-candidates
      (data.candidate === null || typeof data.candidate === 'string') &&
      typeof data.sdpMLineIndex === 'number' &&
      typeof data.sdpMid === 'string'
    );
  }

  validateError(data) {
    return !!(
      data.error &&
      typeof data.error === 'string'
    );
  }

  generateSignalId() {
    return `sig-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  // Handle WebRTC connection state changes
  async handleConnectionStateChange(socket, userKey, state, data = {}) {
    try {
      const peerKey = await redisService.getMatch(userKey);
      if (!peerKey) {
        return;
      }

      const peerSocketId = await redisService.getSocketId(peerKey);
      if (!peerSocketId) {
        return;
      }

      // Notify peer of connection state change
      socket.to(peerSocketId).emit('peer_connection_state', {
        peerKey: userKey,
        state,
        timestamp: Date.now(),
        ...data
      });

      // Log state change
      kafkaService.logEvent('webrtc_connection_state', {
        userKey,
        peerKey,
        state,
        ...data
      });

      // Update metrics based on state
      switch (state) {
        case 'connected':
          metrics.webrtcConnections.inc({ worker: process.pid });
          break;
        
        case 'disconnected':
        case 'failed':
          metrics.webrtcConnections.dec({ worker: process.pid });
          break;
      }

      logger.debug('WebRTC connection state changed', {
        userKey,
        peerKey,
        state,
        worker: process.pid
      });

    } catch (error) {
      logger.error('Failed to handle connection state change', {
        error: error.message,
        userKey,
        state,
        worker: process.pid
      });
    }
  }

  // Handle data channel messages
  async handleDataChannelMessage(socket, userKey, message, io) {
    try {
      const peerKey = await redisService.getMatch(userKey);
      if (!peerKey) {
        return;
      }

      const peerSocketId = await redisService.getSocketId(peerKey);
      if (!peerSocketId) {
        return;
      }

      // Validate message size
      const messageSize = JSON.stringify(message).length;
      if (messageSize > this.maxSignalSize) {
        socket.emit('error', {
          type: 'message_too_large',
          message: 'Data channel message too large'
        });
        return;
      }

      // Forward message to peer
      const payload = {
        ...message,
        from: userKey,
        timestamp: Date.now()
      };

      if (io) {
        io.to(peerSocketId).emit('data_channel_message', payload);
      }

      // Update metrics
      metrics.dataChannelMessages.inc({ worker: process.pid });

      // Log message (without content for privacy)
      kafkaService.logEvent('data_channel_message', {
        userKey,
        peerKey,
        messageSize
      });

    } catch (error) {
      logger.error('Failed to handle data channel message', {
        error: error.message,
        userKey,
        worker: process.pid
      });

      socket.emit('error', {
        type: 'message_error',
        message: 'Failed to send message'
      });
    }
  }

  // Statistics and monitoring
  getSignalingStats() {
    return {
      signalTypes: Object.values(this.signalTypes),
      maxSignalSize: this.maxSignalSize,
      totalSignalsForwarded: metrics.signalingMessages._hashMap.size || 0
    };
  }

  // Cleanup stale signaling sessions
  async cleanupStaleSignalingSessions() {
    // This would typically involve checking for WebRTC connections
    // that have been in a connecting state for too long
    logger.debug('Cleaning up stale signaling sessions', {
      worker: process.pid
    });

    // Implementation would depend on how you track WebRTC connection states
    // For now, we'll just log the cleanup attempt
    kafkaService.logEvent('signaling_cleanup', {
      worker: process.pid,
      timestamp: Date.now()
    });
  }

  // Handle signaling errors
  async handleSignalingError(socket, userKey, error, signalType) {
    try {
      logger.error('Signaling error occurred', {
        error: error.message || error,
        userKey,
        signalType,
        worker: process.pid
      });

      // Update error metrics
      metrics.errorRate.inc({ 
        type: 'webrtc_signaling', 
        worker: process.pid 
      });

      // Notify peer of error if possible
      const peerKey = await redisService.getMatch(userKey);
      if (peerKey) {
        const peerSocketId = await redisService.getSocketId(peerKey);
        if (peerSocketId) {
          socket.to(peerSocketId).emit('peer_error', {
            peerKey: userKey,
            error: 'signaling_error',
            timestamp: Date.now()
          });
        }
      }

      // Log error event
      kafkaService.logErrorEvent('webrtc_signaling', userKey, error, {
        signalType,
        peerKey
      });

    } catch (err) {
      logger.error('Failed to handle signaling error', {
        originalError: error.message || error,
        handlingError: err.message,
        userKey,
        worker: process.pid
      });
    }
  }
}

module.exports = new SignalingService();