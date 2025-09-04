const redisService = require('./redisService');
const kafkaService = require('./kafkaService');
const logger = require('../utils/logger');
const metrics = require('../monitoring/metrics');

class SignalingService {
  constructor() {
    this.messageQueue = new Map(); // Retained for local queueing but Redis is the primary source of truth
    this.maxQueueSize = 100;
    this.messageTimeout = 30000; // 30 seconds
    this.signalingStats = {
      messagesForwarded: 0,
      messagesFailed: 0,
      averageLatency: 0
    };
    this.cleanupTimer = null;
  }

  async forwardSignal(socket, fromSocketId, signalType, data) {
    const startTime = Date.now();
    const fromUserKey = fromSocketId;
    
    try {
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

      const signalMessage = {
        type: signalType,
        from: fromUserKey,
        to: toUserKey,
        data: data,
        timestamp: Date.now(),
        messageId: this.generateMessageId()
      };

      const delivered = await this.deliverSignal(signalMessage);
      
      if (delivered) {
        const latency = Date.now() - startTime;
        this.updateSignalingStats(signalType, latency, true);
        
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
      
      if (targetWorker && parseInt(targetWorker) === process.pid) {
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

  async forwardMessage(socket, fromSocketId, messageData) {
    const startTime = Date.now();
    const fromUserKey = fromSocketId;
    
    try {
      const matchData = await redisService.getMatch(fromUserKey);
      if (!matchData || !matchData.peerId) {
        socket.emit('message_error', {
          error: 'no_active_match',
          message: 'No active match found'
        });
        return false;
      }

      const toUserKey = matchData.peerId;
      
      if (!this.validateMessage(messageData)) {
        socket.emit('message_error', {
          error: 'invalid_message',
          message: 'Invalid message format'
        });
        return false;
      }
      
      const message = {
        type: 'message',
        from: fromUserKey,
        to: toUserKey,
        data: messageData,
        timestamp: Date.now(),
        messageId: this.generateMessageId()
      };

      const delivered = await this.deliverMessage(message);
      
      if (delivered) {
        kafkaService.logMessagingEvent('message_sent', fromUserKey, toUserKey, {
          messageId: message.messageId,
          messageLength: messageData.length,
          roomId: matchData.roomId,
          latency: Date.now() - startTime
        });
        return true;
      } else {
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
      
      const sessionData = await redisService.getHash(`user_session:${toUserKey}`);
      if (!sessionData || !sessionData.socketId) {
        return false;
      }

      const targetSocketId = sessionData.socketId;
      const targetWorker = sessionData.worker;

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
  
  // --- CORRECTED FUNCTIONS BELOW ---

  async handleSkip(socket, socketId) {
    try {
      // Get current match
      const matchData = await redisService.getMatch(socketId);
      if (!matchData || !matchData.peerId) {
        logger.debug('No active match to skip', { socketId, worker: process.pid });
        return;
      }

      const peerId = matchData.peerId;
      
      // Notify peer about the skip
      const skipMessage = {
        type: 'peer_skipped',
        from: socketId,
        to: peerId,
        data: { reason: 'user_skip', timestamp: Date.now() },
        messageId: this.generateMessageId()
      };
      
      await this.deliverSignal(skipMessage);
      
      // Clean up match data
      await Promise.all([
        redisService.deleteMatch(socketId),
        redisService.deleteMatch(peerId)
      ]);

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
      const key = `offline_signals:${socketId}`;
      
      const existingQueue = await redisService.get(key);
      let userQueue = existingQueue ? JSON.parse(existingQueue) : [];
      
      if (userQueue.length >= this.maxQueueSize) {
        userQueue.shift();
      }
      
      signalMessage.expiresAt = Date.now() + this.messageTimeout;
      userQueue.push(signalMessage);
      
      await redisService.set(key, JSON.stringify(userQueue), 300);
      
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
      
      const existingQueue = await redisService.get(key);
      let messageQueue = existingQueue ? JSON.parse(existingQueue) : [];
      
      if (messageQueue.length >= this.maxQueueSize) {
        messageQueue.shift();
      }
      
      message.expiresAt = Date.now() + this.messageTimeout;
      messageQueue.push(message);
      
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
      const currentTime = Date.now();
      
      const queuedSignals = await redisService.get(`offline_signals:${socketId}`);
      if (queuedSignals) {
        const signals = JSON.parse(queuedSignals);
        const validSignals = signals.filter(signal => signal.expiresAt > currentTime);
        
        for (const signal of validSignals) {
          await this.deliverSignal(signal);
        }
        
        if (validSignals.length === 0) {
          await redisService.deleteKey(`offline_signals:${socketId}`);
        } else {
          await redisService.set(`offline_signals:${socketId}`, JSON.stringify(validSignals), 300);
        }
        
        logger.debug('Delivered queued signals', {
          socketId,
          count: validSignals.length,
          worker: process.pid
        });
      }
      
      const queuedMessages = await redisService.get(`offline_messages:${socketId}`);
      if (queuedMessages) {
        const messages = JSON.parse(queuedMessages);
        const validMessages = messages.filter(message => message.expiresAt > currentTime);
        
        for (const message of validMessages) {
          await this.deliverMessage(message);
        }
        
        if (validMessages.length === 0) {
          await redisService.deleteKey(`offline_messages:${socketId}`);
        } else {
          await redisService.set(`offline_messages:${socketId}`, JSON.stringify(validMessages), 300);
        }
        
        logger.debug('Delivered queued messages', {
          socketId,
          count: validMessages.length,
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

  async cleanupExpiredMessages() {
    try {
      const currentTime = Date.now();
      
      const [signalKeys, messageKeys] = await Promise.all([
        redisService.getKeysPattern('offline_signals:*'),
        redisService.getKeysPattern('offline_messages:*')
      ]);
      
      const allKeys = [...signalKeys, ...messageKeys];
      
      for (const key of allKeys) {
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

  async setupCrossServerListening() {
    try {
      const { subClient } = redisService.getClients();
      
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
      
      logger.info('Cross-server signaling listener setup complete', { worker: process.pid });
      
    } catch (error) {
      logger.error('Failed to setup cross-server listening', {
        error: error.message,
        worker: process.pid
      });
    }
  }

  async handleCrossServerSignal(signalData) {
    try {
      const { to: userId, type: signalType, data, sourceWorker } = signalData;
      
      if (sourceWorker === process.pid) {
        return;
      }
      
      const sessionData = await redisService.getHash(`user_session:${userId}`);
      if (!sessionData || parseInt(sessionData.worker) !== process.pid) {
        logger.debug('Cross-server signal received for non-local user, ignoring.', {
          userId,
          sourceWorker,
          targetWorker: process.pid
        });
        return;
      }
      
      const io = require('../socket/socketHandler').getIO();
      const socket = io.sockets.sockets.get(sessionData.socketId);
      
      if (socket && socket.connected) {
        socket.emit(signalType, data);
        
        logger.debug('Cross-server signal delivered to local socket', {
          socketId: sessionData.socketId,
          signalType,
          sourceWorker,
          targetWorker: process.pid
        });
      } else {
          logger.warn('Received cross-server signal for a disconnected user', {
              userId,
              sourceWorker,
              targetWorker: process.pid
          });
      }
      
    } catch (error) {
      logger.error('Error handling cross-server signal', {
        error: error.message,
        signalData,
        worker: process.pid
      });
    }
  }

  async handleCrossServerMessage(messageData) {
    try {
      const { to: userId, data, sourceWorker } = messageData;
      
      if (sourceWorker === process.pid) {
        return;
      }
      
      const sessionData = await redisService.getHash(`user_session:${userId}`);
      if (!sessionData || parseInt(sessionData.worker) !== process.pid) {
        logger.debug('Cross-server message received for non-local user, ignoring.', {
          userId,
          sourceWorker,
          targetWorker: process.pid
        });
        return;
      }
      
      const io = require('../socket/socketHandler').getIO();
      const socket = io.sockets.sockets.get(sessionData.socketId);
      
      if (socket && socket.connected) {
        socket.emit('message', data);
        
        logger.debug('Cross-server message delivered to local socket', {
          socketId: sessionData.socketId,
          sourceWorker,
          targetWorker: process.pid
        });
      } else {
        logger.warn('Received cross-server message for a disconnected user', {
            userId,
            sourceWorker,
            targetWorker: process.pid
        });
      }
      
    } catch (error) {
      logger.error('Error handling cross-server message', {
        error: error.message,
        messageData,
        worker: process.pid
      });
    }
  }
  
  // --- END OF CORRECTED FUNCTIONS ---

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
      this.signalingStats.averageLatency = 
        (this.signalingStats.averageLatency * (this.signalingStats.messagesForwarded - 1) + latency) 
        / this.signalingStats.messagesForwarded;
    } else {
      this.signalingStats.messagesFailed++;
    }
    
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

  startCleanupTimer() {
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredMessages();
    }, 60000);
  }

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

  async init() {
    this.startCleanupTimer();
    await this.setupCrossServerListening();
    logger.info('Signaling service initialized', { worker: process.pid });
  }

  async shutdown() {
    logger.info('Shutting down signaling service', { worker: process.pid });
    
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    
    this.messageQueue.clear();
    
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