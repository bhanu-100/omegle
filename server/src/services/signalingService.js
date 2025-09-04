const redisService = require('./redisService');
const kafkaService = require('./kafkaService');
const logger = require('../utils/logger');
const metrics = require('../monitoring/metrics');

class SignalingService {
  constructor() {
    this.messageQueue = new Map(); // For offline message delivery
    this.maxQueueSize = 100;
    this.messageTimeout = 30000; // 30 seconds
    this.signalingStats = {
      messagesForwarded: 0,
      messagesFailed: 0,
      averageLatency: 0
    };
    this.cleanupTimer = null;
  }

  // FIXED: Declared fromUserKey at the beginning of the method
  async forwardSignal(socket, fromSocketId, signalType, data) {
    const startTime = Date.now();
    const fromUserKey = fromSocketId; // FIXED: Properly declare the variable
    
    try {
      // Get the peer user from active match
      const matchData = await redisService.getMatch(fromSocketId);
      if (!matchData || !matchData.peerId) {
        logger.debug('No active match found for signal forwarding', {
          socketId: fromSocketId,
          signalType,
          worker: process.pid
        });
        
        socket.emit('signaling_error', {
          type: signalType,
          error: 'no_active_match',
          message: 'No active match found'
        });
        return false;
      }

      const toUserKey = matchData.peerId;
      
      // Validate signal data
      if (!this.validateSignalData(signalType, data)) {
        logger.warn('Invalid signal data', {
          fromUser: fromUserKey,
          toUser: toUserKey,
          signalType,
          worker: process.pid
        });
        
        socket.emit('signaling_error', {
          type: signalType,
          error: 'invalid_data',
          message: 'Invalid signal data'
        });
        return false;
      }

      // Prepare signal message
      const signalMessage = {
        type: signalType,
        from: fromUserKey,
        to: toUserKey,
        data: data,
        timestamp: Date.now(),
        messageId: this.generateMessageId()
      };

      // Try to deliver the signal
      const delivered = await this.deliverSignal(signalMessage);
      
      if (delivered) {
        // Update metrics
        const latency = Date.now() - startTime;
        this.updateSignalingStats(signalType, latency, true);
        
        // Log successful forwarding
        kafkaService.logSignalingEvent('signal_forwarded', fromUserKey, toUserKey, signalType, {
          messageId: signalMessage.messageId,
          latency,
          roomId: matchData.roomId
        });
        
        logger.debug('Signal forwarded successfully', {
          from: fromUserKey,
          to: toUserKey,
          signalType,
          messageId: signalMessage.messageId,
          latency,
          worker: process.pid
        });
        
        return true;
      } else {
        // Queue message for offline delivery
        await this.queueSignalForOfflineDelivery(signalMessage);
        
        this.updateSignalingStats(signalType, Date.now() - startTime, false);
        
        logger.info('Signal queued for offline delivery', {
          from: fromUserKey,
          to: toUserKey,
          signalType,
          messageId: signalMessage.messageId,
          worker: process.pid
        });
        
        return false;
      }
      
    } catch (error) {
      logger.error('Error forwarding signal', {
        error: error.message,
        stack: error.stack,
        fromUser: fromUserKey,
        signalType,
        worker: process.pid
      });
      
      this.updateSignalingStats(signalType, Date.now() - startTime, false);
      
      socket.emit('signaling_error', {
        type: signalType,
        error: 'forwarding_failed',
        message: 'Failed to forward signal'
      });
      
      return false;
    }
  }

  async deliverSignal(signalMessage) {
    try {
      const { to: toUserKey, type: signalType } = signalMessage;
      
      // Get target user's session info
      const sessionData = await redisService.getHash(`user_session:${toUserKey}`);
      if (!sessionData || !sessionData.socketId) {
        logger.debug('Target user session not found', {
          toUser: toUserKey,
          signalType,
          worker: process.pid
        });
        return false;
      }

      const targetSocketId = sessionData.socketId;
      const targetWorker = sessionData.worker;
      
      // Check if target is on the same server instance
      if (targetWorker && parseInt(targetWorker) === process.pid) {
        // Local delivery
        const success = await this.deliverSignalLocally(targetSocketId, signalMessage);
        if (success) {
          try {
            // metrics.signalingMessages.inc({ 
            //   type: 'local_delivery', 
            //   signal_type: signalType,
            //   worker: process.pid 
            // });
          } catch (metricsError) {
            // Ignore metrics errors
          }
          return true;
        }
      }
      
      // Cross-server delivery via Redis pub/sub
      const success = await this.deliverSignalCrossServer(signalMessage);
      if (success) {
        try {
          // metrics.signalingMessages.inc({ 
          //   type: 'cross_server_delivery', 
          //   signal_type: signalType,
          //   worker: process.pid 
          // });
        } catch (metricsError) {
          // Ignore metrics errors
        }
        return true;
      }
      
      return false;
      
    } catch (error) {
      logger.error('Error in signal delivery', {
        error: error.message,
        messageId: signalMessage.messageId,
        worker: process.pid
      });
      return false;
    }
  }

  async deliverSignalLocally(socketId, signalMessage) {
    try {
      // Get socket instance from the current server
      const io = require('../socket/socketHandler').getIO();
      const socket = io.sockets.sockets.get(socketId);
      
      if (!socket || !socket.connected) {
        logger.debug('Local socket not found or not connected', {
          socketId,
          messageId: signalMessage.messageId,
          worker: process.pid
        });
        return false;
      }
      
      // Emit the signal to the target socket
      socket.emit(signalMessage.type, signalMessage.data);
      
      logger.debug('Signal delivered locally', {
        socketId,
        signalType: signalMessage.type,
        messageId: signalMessage.messageId,
        worker: process.pid
      });
      
      return true;
      
    } catch (error) {
      logger.error('Local signal delivery failed', {
        error: error.message,
        socketId,
        messageId: signalMessage.messageId,
        worker: process.pid
      });
      return false;
    }
  }

  async deliverSignalCrossServer(signalMessage) {
    try {
      // Publish signal to Redis for cross-server delivery
      const { pubClient } = redisService.getClients();
      
      const channelName = `signaling:${signalMessage.to}`;
      const payload = JSON.stringify({
        ...signalMessage,
        deliveryAttempt: Date.now(),
        sourceWorker: process.pid
      });
      
      const subscribers = await pubClient.publish(channelName, payload);
      
      logger.debug('Signal published for cross-server delivery', {
        channel: channelName,
        subscribers,
        messageId: signalMessage.messageId,
        worker: process.pid
      });
      
      return subscribers > 0;
      
    } catch (error) {
      logger.error('Cross-server signal delivery failed', {
        error: error.message,
        messageId: signalMessage.messageId,
        worker: process.pid
      });
      return false;
    }
  }

  // FIXED: Declared fromUserKey at the beginning
  async forwardMessage(socket, fromSocketId, messageData) {
    const startTime = Date.now();
    const fromUserKey = fromSocketId; // FIXED: Properly declare the variable
    
    try {
      // Get the peer user from active match
      const matchData = await redisService.getMatch(fromUserKey);
      if (!matchData || !matchData.peerId) {
        socket.emit('message_error', {
          error: 'no_active_match',
          message: 'No active match found'
        });
        return false;
      }

      const toUserKey = matchData.peerId;
      
      // Validate message
      if (!this.validateMessage(messageData)) {
        socket.emit('message_error', {
          error: 'invalid_message',
          message: 'Invalid message format'
        });
        return false;
      }
      // Prepare message
      const message = {
        type: 'message',
        from: fromUserKey,
        to: toUserKey,
        data: messageData,
        timestamp: Date.now(),
        messageId: this.generateMessageId()
      };

      // Deliver message
      const delivered = await this.deliverMessage(message);
      
      if (delivered) {
        // Log message activity
        kafkaService.logMessagingEvent('message_sent', fromUserKey, toUserKey, {
          messageId: message.messageId,
          messageLength: messageData.length,
          roomId: matchData.roomId,
          latency: Date.now() - startTime
        });
        return true;
      } else {
        // Queue for offline delivery
        await this.queueMessageForOfflineDelivery(message);
        return false;
      }
      
    } catch (error) {
      logger.error('Error forwarding message', {
        error: error.message,
        fromUser: fromUserKey,
        worker: process.pid
      });
      
      socket.emit('message_error', {
        error: 'forwarding_failed',
        message: 'Failed to send message'
      });
      return false;
    }
  }

  async deliverMessage(message) {
    try {
      const { to: toUserKey } = message;
      
      // Get target user's session
      const sessionData = await redisService.getHash(`user_session:${toUserKey}`);
      if (!sessionData || !sessionData.socketId) {
        return false;
      }

      const targetSocketId = sessionData.socketId;
      const targetWorker = sessionData.worker;

      // Local delivery
      if (targetWorker && parseInt(targetWorker) === process.pid) {
        const io = require('../socket/socketHandler').getIO();
        const socket = io.sockets.sockets.get(targetSocketId);
        if (socket && socket.connected) {
          socket.emit('message', message.data);
          logger.debug('Message delivered locally', {
            socketId: targetSocketId,
            messageId: message.messageId,
            worker: process.pid
          });
          return true;
        }
      }
      // Cross-server delivery
      const { pubClient } = redisService.getClients();
      const channelName = `messaging:${toUserKey}`;
      const payload = JSON.stringify({
        ...message,
        sourceWorker: process.pid
      });
      
      const subscribers = await pubClient.publish(channelName, payload);
      return subscribers > 0;
      
    } catch (error) {
      logger.error('Message delivery failed', {
        error: error.message,
        messageId: message.messageId,
        worker: process.pid
      });
      return false;
    }
  }

  async handleSkip(socket, socketId) {
    try {
      // Get current match
      const matchData = await redisService.getMatch(socketId);
      if (!matchData || !matchData.peerId) {
        return;
      }

      const peerId = matchData.peerId;
      
      // Notify peer about skip
      const skipMessage = {
        type: 'peer_skipped',
        from: socketId,
        to: peerId,
        data: {
          reason: 'user_skip',
          timestamp: Date.now()
        },
        messageId: this.generateMessageId()
      };

      await this.deliverSignal(skipMessage);
      
      // Clean up match data
      await Promise.all([
        redisService.deleteMatch(socketId),
        redisService.deleteMatch(peerId)
      ]);

      // Log skip event
      kafkaService.logMatchmakingEvent('user_skipped', socketId, peerId, matchData.roomId, {
        reason: 'manual_skip'
      });

      logger.info('Skip handled successfully', {
        socketId,
        peerId,
        roomId: matchData.roomId,
        worker: process.pid
      });
      
    } catch (error) {
      logger.error('Error handling skip', {
        error: error.message,
        socketId,
        worker: process.pid
      });
    }
  }

  async queueSignalForOfflineDelivery(signalMessage) {
    try {
      const { to: socketId } = signalMessage;
      
      if (!this.messageQueue.has(socketId)) {
        this.messageQueue.set(socketId, []);
      }
      
      const userQueue = this.messageQueue.get(socketId);
      
      // Implement queue size limit
      if (userQueue.length >= this.maxQueueSize) {
        userQueue.shift(); // Remove oldest message
        logger.debug('Message queue full, removing oldest message', {
          socketId,
          queueSize: userQueue.length,
          worker: process.pid
        });
      }
      
      // Add expiry time
      signalMessage.expiresAt = Date.now() + this.messageTimeout;
      userQueue.push(signalMessage);
      
      // Store in Redis for persistence across server restarts
      await redisService.set(
        `offline_signals:${socketId}`,
        JSON.stringify(userQueue),
        300 // 5 minutes TTL
      );
      
      logger.debug('Signal queued for offline delivery', {
        socketId,
        signalType: signalMessage.type,
        queueSize: userQueue.length,
        worker: process.pid
      });
      
    } catch (error) {
      logger.error('Failed to queue signal for offline delivery', {
        error: error.message,
        messageId: signalMessage.messageId,
        worker: process.pid
      });
    }
  }

  async queueMessageForOfflineDelivery(message) {
    try {
      const { to: socketId } = message;
      const key = `offline_messages:${socketId}`;
      
      // Get existing queue
      const existingQueue = await redisService.get(key);
      let messageQueue = existingQueue ? JSON.parse(existingQueue) : [];
      
      // Implement size limit
      if (messageQueue.length >= this.maxQueueSize) {
        messageQueue.shift();
      }
      
      message.expiresAt = Date.now() + this.messageTimeout;
      messageQueue.push(message);
      
      // Store back in Redis
      await redisService.set(key, JSON.stringify(messageQueue), 300);
      
      logger.debug('Message queued for offline delivery', {
        socketId,
        messageId: message.messageId,
        queueSize: messageQueue.length,
        worker: process.pid
      });
      
    } catch (error) {
      logger.error('Failed to queue message for offline delivery', {
        error: error.message,
        messageId: message.messageId,
        worker: process.pid
      });
    }
  }

  async deliverQueuedMessages(socketId) {
    try {
      // Deliver queued signals
      const queuedSignals = await redisService.get(`offline_signals:${socketId}`);
      if (queuedSignals) {
        const signals = JSON.parse(queuedSignals);
        const currentTime = Date.now();
        
        for (const signal of signals) {
          if (signal.expiresAt > currentTime) {
            await this.deliverSignal(signal);
          }
        }
        
        await redisService.deleteKey(`offline_signals:${socketId}`);
        this.messageQueue.delete(socketId);
        
        logger.debug('Delivered queued signals', {
          socketId,
          count: signals.length,
          worker: process.pid
        });
      }
      
      // Deliver queued messages
      const queuedMessages = await redisService.get(`offline_messages:${socketId}`);
      if (queuedMessages) {
        const messages = JSON.parse(queuedMessages);
        const currentTime = Date.now();
        
        for (const message of messages) {
          if (message.expiresAt > currentTime) {
            await this.deliverMessage(message);
          }
        }
        
        await redisService.deleteKey(`offline_messages:${socketId}`);
        
        logger.debug('Delivered queued messages', {
          socketId,
          count: messages.length,
          worker: process.pid
        });
      }
      
    } catch (error) {
      logger.error('Failed to deliver queued messages', {
        error: error.message,
        socketId,
        worker: process.pid
      });
    }
  }

  validateSignalData(signalType, data) {
    try {
      switch (signalType) {
        case 'webrtc_offer':
        case 'webrtc_answer':
          return data && 
                 data.sdp && 
                 typeof data.sdp === 'object' &&
                 data.sdp.type && 
                 data.sdp.sdp &&
                 ['offer', 'answer'].includes(data.sdp.type);
                 
        case 'webrtc_ice_candidate':
          return data && 
                 data.candidate !== undefined;
                 
        default:
          return data && typeof data === 'object';
      }
    } catch (error) {
      logger.warn('Error validating signal data', {
        error: error.message,
        signalType
      });
      return false;
    }
  }

  validateMessage(messageData) {
    return typeof messageData === 'string' && 
           messageData.length > 0 && 
           messageData.length <= 1000 &&
           messageData.trim().length > 0;
  }

  generateMessageId() {
    return `msg_${process.pid}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  updateSignalingStats(signalType, latency, success) {
    if (success) {
      this.signalingStats.messagesForwarded++;
      // Update rolling average latency
      this.signalingStats.averageLatency = 
        (this.signalingStats.averageLatency * (this.signalingStats.messagesForwarded - 1) + latency) 
        / this.signalingStats.messagesForwarded;
    } else {
      this.signalingStats.messagesFailed++;
    }
    
    // Update Prometheus metrics if available
    try {
      // metrics.signalingLatency.observe({ type: signalType }, latency);
      // metrics.signalingSuccess.inc({ 
      //   type: signalType, 
      //   success: success.toString(),
      //   worker: process.pid 
      // });
    } catch (metricsError) {
      // Ignore metrics errors
    }
  }

  // Periodic cleanup of expired queued messages
  startCleanupTimer() {
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredMessages();
    }, 60000); // Every minute
  }

  async cleanupExpiredMessages() {
    try {
      const currentTime = Date.now();
      
      // Clean up in-memory queues
      for (const [socketId, queue] of this.messageQueue.entries()) {
        const validMessages = queue.filter(msg => msg.expiresAt > currentTime);
        
        if (validMessages.length !== queue.length) {
          this.messageQueue.set(socketId, validMessages);
          
          logger.debug('Cleaned up expired messages from memory queue', {
            socketId,
            removed: queue.length - validMessages.length,
            remaining: validMessages.length,
            worker: process.pid
          });
        }
        
        // Remove empty queues
        if (validMessages.length === 0) {
          this.messageQueue.delete(socketId);
        }
      }
      
      // Clean up Redis-stored queues
      const [signalKeys, messageKeys] = await Promise.all([
        redisService.getKeysPattern('offline_signals:*'),
        redisService.getKeysPattern('offline_messages:*')
      ]);
      
      for (const key of [...signalKeys, ...messageKeys]) {
        try {
          const queueData = await redisService.get(key);
          if (queueData) {
            const queue = JSON.parse(queueData);
            const validItems = queue.filter(item => item.expiresAt > currentTime);
            
            if (validItems.length !== queue.length) {
              if (validItems.length > 0) {
                await redisService.set(key, JSON.stringify(validItems), 300);
              } else {
                await redisService.deleteKey(key);
              }
            }
          }
        } catch (error) {
          logger.warn('Failed to process queue during cleanup', {
            key,
            error: error.message
          });
        }
      }
      
    } catch (error) {
      logger.error('Error during message cleanup', {
        error: error.message,
        worker: process.pid
      });
    }
  }

  // Subscribe to cross-server signaling channels
  async setupCrossServerListening() {
    try {
      const { subClient } = redisService.getClients();
      
      // Subscribe to signaling channels for all users on this server
      await subClient.psubscribe('signaling:*');
      await subClient.psubscribe('messaging:*');
      
      subClient.on('pmessage', async (pattern, channel, message) => {
        try {
          const data = JSON.parse(message);
          
          if (channel.startsWith('signaling:')) {
            await this.handleCrossServerSignal(data);
          } else if (channel.startsWith('messaging:')) {
            await this.handleCrossServerMessage(data);
          }
        } catch (error) {
          logger.error('Error handling cross-server message', {
            error: error.message,
            channel,
            worker: process.pid
          });
        }
      });
      
      logger.info('Cross-server signaling listener setup complete', {
        worker: process.pid
      });
      
    } catch (error) {
      logger.error('Failed to setup cross-server listening', {
        error: error.message,
        worker: process.pid
      });
    }
  }

  async handleCrossServerSignal(signalData) {
    try {
      const { to: socketId, type: signalType, data, sourceWorker } = signalData;
      
      // Don't handle signals from same worker
      if (sourceWorker === process.pid) {
        return;
      }
      
      // Check if target user is on this server
      const sessionData = await redisService.getHash(`user_session:${socketId}`);
      if (!sessionData || parseInt(sessionData.worker) !== process.pid) {
        return;
      }
      
      // Deliver signal locally
      const io = require('../socket/socketHandler').getIO();
      const socket = io.sockets.sockets.get(sessionData.socketId);
      
      if (socket && socket.connected) {
        socket.emit(signalType, data);
        
        logger.debug('Cross-server signal delivered', {
          socketId,
          signalType,
          sourceWorker,
          targetWorker: process.pid
        });
        
        try {
          // metrics.signalingMessages.inc({
          //   type: 'cross_server_received',
          //   signal_type: signalType,
          //   worker: process.pid
          // });
        } catch (metricsError) {
          // Ignore metrics errors
        }
      }
      
    } catch (error) {
      logger.error('Error handling cross-server signal', {
        error: error.message,
        signalData: signalData.messageId,
        worker: process.pid
      });
    }
  }

  async handleCrossServerMessage(messageData) {
    try {
      const { to: socketId, data, sourceWorker } = messageData;
      
      // Don't handle messages from same worker
      if (sourceWorker === process.pid) {
        return;
      }
      
      // Check if target user is on this server
      const sessionData = await redisService.getHash(`user_session:${socketId}`);
      if (!sessionData || parseInt(sessionData.worker) !== process.pid) {
        return;
      }
      
      // Deliver message locally
      const io = require('../socket/socketHandler').getIO();
      const socket = io.sockets.sockets.get(sessionData.socketId);
      
      if (socket && socket.connected) {
        socket.emit('message', data);
        
        logger.debug('Cross-server message delivered', {
          socketId,
          sourceWorker,
          targetWorker: process.pid
        });
        
        try {
          // metrics.signalingMessages.inc({
          //   type: 'cross_server_message_received',
          //   worker: process.pid
          // });
        } catch (metricsError) {
          // Ignore metrics errors
        }
      }
      
    } catch (error) {
      logger.error('Error handling cross-server message', {
        error: error.message,
        messageData: messageData.messageId,
        worker: process.pid
      });
    }
  }

  // Statistics and monitoring
  getSignalingStats() {
    return {
      ...this.signalingStats,
      queuedMessages: this.messageQueue.size,
      worker: process.pid
    };
  }

  async getHealthStatus() {
    try {
      const queueSizes = Array.from(this.messageQueue.values()).reduce((total, queue) => total + queue.length, 0);
      
      return {
        healthy: true,
        stats: this.getSignalingStats(),
        totalQueuedMessages: queueSizes,
        activeQueues: this.messageQueue.size,
        worker: process.pid
      };
    } catch (error) {
      return {
        healthy: false,
        error: error.message,
        worker: process.pid
      };
    }
  }

  // Initialize the service
  async init() {
    this.startCleanupTimer();
    await this.setupCrossServerListening();
    logger.info('Signaling service initialized', { worker: process.pid });
  }

  // Shutdown cleanup
  async shutdown() {
    logger.info('Shutting down signaling service', { worker: process.pid });
    
    // Clear cleanup timer
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    
    // Clear in-memory queues
    this.messageQueue.clear();
    
    // Unsubscribe from Redis channels
    try {
      const { subClient } = redisService.getClients();
      await subClient.punsubscribe('signaling:*');
      await subClient.punsubscribe('messaging:*');
    } catch (error) {
      logger.error('Error unsubscribing from Redis channels', {
        error: error.message,
        worker: process.pid
      });
    }
    
    logger.info('Signaling service shutdown complete', { worker: process.pid });
  }
}

module.exports = new SignalingService();