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
        allowAutoTopicCreation: false
      });

      await this.connectProducer();
      this.startBatchTimer();

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

    // SSL configuration
    if (process.env.KAFKA_SSL_CA && process.env.KAFKA_SSL_KEY && process.env.KAFKA_SSL_CERT) {
      try {
        config.ssl = {
          rejectUnauthorized: false,
          ca: [fs.readFileSync(process.env.KAFKA_SSL_CA, 'utf8')],
          key: fs.readFileSync(process.env.KAFKA_SSL_KEY, 'utf8'),
          cert: fs.readFileSync(process.env.KAFKA_SSL_CERT, 'utf8')
        };
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
      
      metrics.errorRate.inc({ type: 'kafka_connection', worker: process.pid });
      this.scheduleReconnect();
      throw error;
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setInterval(async () => {
      try {
        logger.info('Attempting to reconnect to Kafka...');
        await this.connectProducer();
      } catch (error) {
        logger.debug('Kafka reconnection failed, will retry');
      }
    }, 30000);
  }

  startBatchTimer() {
    this.batchTimer = setInterval(() => {
      this.flushBatch();
    }, this.batchTimeout);
  }

  logEvent(eventType, eventData) {
    if (!this.isEnabled) {
      return;
    }

    const event = {
      type: eventType,
      timestamp: Date.now(),
      worker: process.pid,
      ...eventData
    };

    this.eventBatch.push({
      topic: process.env.KAFKA_TOPIC_EVENTS || 'webrtc-events',
      messages: [{
        key: eventData.userKey || null,
        value: JSON.stringify(event),
        timestamp: event.timestamp
      }]
    });

    if (this.eventBatch.length >= this.batchSize) {
      this.flushBatch();
    }
  }

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
      
      metrics.errorRate.inc({ type: 'kafka_batch', worker: process.pid });

      // Re-add failed batch to the beginning (with limit to prevent memory leaks)
      if (this.eventBatch.length < this.batchSize * 2) {
        this.eventBatch.unshift(...batch);
      }
    }
  }

  // Specialized event logging methods
  logConnectionEvent(eventType, userKey, socketId, additionalData = {}) {
    this.logEvent(eventType, {
      userKey,
      socketId,
      ...additionalData
    });
  }

  logMatchmakingEvent(eventType, userKey, peerKey = null, roomId = null, additionalData = {}) {
    this.logEvent(eventType, {
      userKey,
      peerKey,
      roomId,
      ...additionalData
    });
  }

  logSignalingEvent(eventType, userKey, peerKey, signalType, additionalData = {}) {
    this.logEvent(eventType, {
      userKey,
      peerKey,
      signalType,
      ...additionalData
    });
  }

  logErrorEvent(errorType, userKey = null, error, additionalData = {}) {
    this.logEvent('error', {
      errorType,
      userKey,
      error: {
        message: error.message || error,
        stack: error.stack,
        code: error.code
      },
      ...additionalData
    });
  }

  logPerformanceEvent(metricType, value, userKey = null, additionalData = {}) {
    this.logEvent('performance', {
      metricType,
      value,
      userKey,
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
      isReconnecting: !!this.reconnectTimer
    };
  }

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
        clearInterval(this.reconnectTimer);
        this.reconnectTimer = null;
      }

      // Flush remaining events
      if (this.eventBatch.length > 0) {
        logger.info('Flushing remaining Kafka events', {
          count: this.eventBatch.length,
          worker: process.pid
        });
        await this.flushBatch();
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
}

module.exports = new KafkaService();