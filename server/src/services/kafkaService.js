const fs = require('fs');
const { Kafka } = require('kafkajs');
const logger = require('../utils/logger');
const metrics = require('../monitoring/metrics');

class KafkaService {
  constructor() {
    this.kafka = null;
    this.producer = null;
    this.isConnected = false;
    this.eventBatch = [];
    this.batchSize = parseInt(process.env.KAFKA_BATCH_SIZE) || 100;
    this.batchTimeout = parseInt(process.env.KAFKA_BATCH_TIMEOUT) || 1000;
    this.reconnectTimer = null;
    this.batchTimer = null;
    this.isEnabled = !!process.env.KAFKA_BROKERS;
    this.maxRetries = 3;
    this.currentRetry = 0;
  }

  async init() {
    if (!this.isEnabled) {
      logger.info('Kafka disabled - no brokers configured');
      return;
    }

    try {
      const kafkaConfig = this.getKafkaConfig();
      this.kafka = new Kafka(kafkaConfig);
      this.producer = this.kafka.producer({
        maxInFlightRequests: 1,
        idempotent: true,
        transactionTimeout: 30000,
        allowAutoTopicCreation: false,
        // OPTIMIZATION: Better retry configuration
        retry: {
          retries: 5,
          factor: 2,
          multiplier: 2,
          maxRetryTime: 30000
        }
      });

      await this.connectProducer();
      this.startBatchTimer();
      this.currentRetry = 0; // Reset retry counter on successful connection

      logger.info('Kafka service initialized', {
        brokers: process.env.KAFKA_BROKERS,
        worker: process.pid
      });

    } catch (error) {
      logger.error('Failed to initialize Kafka service', {
        error: error.message,
        worker: process.pid
      });
      this.scheduleReconnect();
    }
  }

  getKafkaConfig() {
    const config = {
      clientId: `webrtc-chat-service-${process.pid}`,
      brokers: process.env.KAFKA_BROKERS.split(',').map(s => s.trim()),
      retry: {
        retries: 5,
        factor: 2,
        multiplier: 2,
        maxRetryTime: 30000
      },
      connectionTimeout: 10000,
      requestTimeout: 30000,
      logLevel: 2 // WARN level
    };

    // IMPROVED: SSL configuration with better error handling
    if (process.env.KAFKA_SSL_CA && process.env.KAFKA_SSL_KEY && process.env.KAFKA_SSL_CERT) {
      try {
        config.ssl = {
          rejectUnauthorized: process.env.KAFKA_SSL_REJECT_UNAUTHORIZED !== 'false',
          ca: [fs.readFileSync(process.env.KAFKA_SSL_CA, 'utf8')],
          key: fs.readFileSync(process.env.KAFKA_SSL_KEY, 'utf8'),
          cert: fs.readFileSync(process.env.KAFKA_SSL_CERT, 'utf8')
        };
        logger.debug('SSL configuration loaded for Kafka');
      } catch (error) {
        logger.warn('Failed to load SSL certificates for Kafka', {
          error: error.message
        });
      }
    }

    // SASL configuration
    if (process.env.KAFKA_SASL_USERNAME && process.env.KAFKA_SASL_PASSWORD) {
      config.sasl = {
        mechanism: process.env.KAFKA_SASL_MECHANISM || 'plain',
        username: process.env.KAFKA_SASL_USERNAME,
        password: process.env.KAFKA_SASL_PASSWORD
      };
      logger.debug('SASL authentication configured for Kafka');
    }

    return config;
  }

  async connectProducer() {
    try {
      await this.producer.connect();
      this.isConnected = true;
      
      logger.info('Connected to Kafka brokers', {
        worker: process.pid
      });

      if (this.reconnectTimer) {
        clearInterval(this.reconnectTimer);
        this.reconnectTimer = null;
      }

    } catch (error) {
      this.isConnected = false;
      logger.error('Kafka connection error', {
        error: error.message,
        worker: process.pid
      });
      
      try {
        // metrics.errorRate.inc({ type: 'kafka_connection', worker: process.pid });
      } catch (metricsError) {
        // Ignore metrics errors
      }
      this.scheduleReconnect();
      throw error;
    }
  }

  // OPTIMIZATION: Improved reconnection with exponential backoff
  scheduleReconnect() {
    if (this.reconnectTimer || this.currentRetry >= this.maxRetries) {
      return;
    }

    const backoffDelay = Math.min(30000, 1000 * Math.pow(2, this.currentRetry));
    this.currentRetry++;

    this.reconnectTimer = setTimeout(async () => {
      try {
        logger.info(`Attempting to reconnect to Kafka (attempt ${this.currentRetry}/${this.maxRetries})...`);
        await this.connectProducer();
      } catch (error) {
        logger.debug('Kafka reconnection failed, will retry');
        this.reconnectTimer = null;
        
        if (this.currentRetry < this.maxRetries) {
          this.scheduleReconnect();
        } else {
          logger.error('Max Kafka reconnection attempts reached, giving up');
          this.currentRetry = 0; // Reset for future attempts
        }
      }
    }, backoffDelay);
  }

  startBatchTimer() {
    this.batchTimer = setInterval(() => {
      this.flushBatch();
    }, this.batchTimeout);
  }

  // OPTIMIZATION: Better event validation and batching
  logEvent(eventType, eventData) {
    if (!this.isEnabled) {
      return;
    }

    // ADDED: Input validation
    if (!eventType || typeof eventType !== 'string') {
      logger.warn('Invalid event type provided to Kafka service', { eventType });
      return;
    }

    const event = {
      type: eventType,
      timestamp: Date.now(),
      worker: process.pid,
      ...eventData
    };

    // OPTIMIZATION: Prevent batch overflow
    if (this.eventBatch.length >= this.batchSize * 2) {
      logger.warn('Kafka event batch overflow, dropping oldest events', {
        currentSize: this.eventBatch.length,
        worker: process.pid
      });
      this.eventBatch.splice(0, this.batchSize); // Remove oldest events
    }

    this.eventBatch.push({
      topic: process.env.KAFKA_TOPIC_EVENTS || 'webrtc-events',
      messages: [{
        key: eventData.socketId || `worker-${process.pid}`,
        value: JSON.stringify(event),
        timestamp: event.timestamp.toString()
      }]
    });

    if (this.eventBatch.length >= this.batchSize) {
      this.flushBatch();
    }
  }

  // IMPROVED: Better error handling and retry logic for batch sending
  async flushBatch() {
    if (this.eventBatch.length === 0 || !this.isConnected) {
      return;
    }

    const batch = this.eventBatch.splice(0);
    
    try {
      await this.producer.sendBatch({ topicMessages: batch });
      
      logger.debug('Kafka batch sent successfully', {
        batchSize: batch.length,
        worker: process.pid
      });

    } catch (error) {
      logger.error('Failed to send Kafka batch', {
        error: error.message,
        batchSize: batch.length,
        worker: process.pid
      });
      
      try {
        // metrics.errorRate.inc({ type: 'kafka_batch', worker: process.pid });
      } catch (metricsError) {
        // Ignore metrics errors
      }

      // OPTIMIZATION: Smart retry logic - only re-add if not too many failures
      if (this.eventBatch.length < this.batchSize && batch.length < this.batchSize) {
        this.eventBatch.unshift(...batch.slice(0, this.batchSize)); // Limit re-queued events
      }

      // Mark as disconnected if send fails
      if (error.type === 'NETWORK_ERROR' || error.type === 'CONNECTION_ERROR') {
        this.isConnected = false;
        this.scheduleReconnect();
      }
    }
  }

  // Specialized event logging methods
  logConnectionEvent(eventType, socketId, additionalData = {}) {
    this.logEvent(eventType, {
      category: 'connection',
      socketId,
      ...additionalData
    });
  }

  logMatchmakingEvent(eventType, socketId, peerId = null, roomId = null, additionalData = {}) {
    this.logEvent(eventType, {
      category: 'matchmaking',
      socketId,
      peerId,
      roomId,
      ...additionalData
    });
  }

  logSignalingEvent(eventType, socketId, peerId, signalType, additionalData = {}) {
    this.logEvent(eventType, {
      category: 'signaling',
      socketId,
      peerId,
      signalType,
      ...additionalData
    });
  }

  logErrorEvent(errorType, socketId = null, error, additionalData = {}) {
    this.logEvent('error', {
      category: 'error',
      errorType,
      socketId,
      error: {
        message: error.message || error,
        stack: error.stack,
        code: error.code,
        name: error.name
      },
      ...additionalData
    });
  }

  logPerformanceEvent(metricType, value, socketId = null, additionalData = {}) {
    this.logEvent('performance', {
      category: 'performance',
      metricType,
      value,
      socketId,
      ...additionalData
    });
  }

  // ADDED: Method for logging messaging events
  logMessagingEvent(eventType, fromSocketId, toSocketId, additionalData = {}) {
    this.logEvent(eventType, {
      category: 'messaging',
      fromSocketId,
      toSocketId,
      ...additionalData
    });
  }

  // Health check
  async checkHealth() {
    if (!this.isEnabled) {
      return { status: 'disabled' };
    }

    return {
      status: this.isConnected ? 'connected' : 'disconnected',
      batchSize: this.eventBatch.length,
      isReconnecting: !!this.reconnectTimer,
      retryCount: this.currentRetry,
      maxRetries: this.maxRetries,
      worker: process.pid
    };
  }

  // OPTIMIZATION: Graceful shutdown with proper cleanup
  async shutdown() {
    if (!this.isEnabled) {
      return;
    }

    logger.info('Shutting down Kafka service', { worker: process.pid });

    try {
      // Clear timers
      if (this.batchTimer) {
        clearInterval(this.batchTimer);
        this.batchTimer = null;
      }

      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }

      // Flush remaining events with timeout
      if (this.eventBatch.length > 0) {
        logger.info('Flushing remaining Kafka events', {
          count: this.eventBatch.length,
          worker: process.pid
        });
        
        const flushPromise = this.flushBatch();
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Flush timeout')), 5000)
        );
        
        try {
          await Promise.race([flushPromise, timeoutPromise]);
        } catch (timeoutError) {
          logger.warn('Kafka flush timed out during shutdown', {
            remainingEvents: this.eventBatch.length,
            worker: process.pid
          });
        }
      }

      // Disconnect producer
      if (this.producer && this.isConnected) {
        await this.producer.disconnect();
        this.isConnected = false;
      }

      logger.info('Kafka service shut down', { worker: process.pid });

    } catch (error) {
      logger.error('Error shutting down Kafka service', {
        error: error.message,
        worker: process.pid
      });
    }
  }

  // Getters for monitoring
  get connected() {
    return this.isConnected;
  }

  get batchLength() {
    return this.eventBatch.length;
  }

  get enabled() {
    return this.isEnabled;
  }

  // ADDED: Get service statistics
  getStats() {
    return {
      isConnected: this.isConnected,
      isEnabled: this.isEnabled,
      batchSize: this.eventBatch.length,
      maxBatchSize: this.batchSize,
      batchTimeout: this.batchTimeout,
      isReconnecting: !!this.reconnectTimer,
      retryCount: this.currentRetry,
      worker: process.pid
    };
  }
}

module.exports = new KafkaService();