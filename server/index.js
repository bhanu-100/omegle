// server.js (updated)
require('dotenv').config();
const fs = require('fs');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { createClient } = require('redis');
const { createAdapter } = require('@socket.io/redis-adapter');
const { Kafka } = require('kafkajs');
const winston = require('winston');
const client = require('prom-client');

// ---------- Basic validation of env ----------
const {
  REDIS_URL,
  CLIENT_URL,
  KAFKA_BROKERS,
  KAFKA_TOPIC_EVENTS,
  KAFKA_SSL_CA,
  KAFKA_SSL_KEY,
  KAFKA_SSL_CERT,
  PORT = 3000,
  LOG_LEVEL = 'info'
} = process.env;

if (!REDIS_URL) {
  console.error('REDIS_URL is required in .env');
  process.exit(1);
}
if (!KAFKA_BROKERS) {
  console.warn('KAFKA_BROKERS not set — Kafka logging disabled until set');
}

// ---------- Logger ----------
const logger = winston.createLogger({
  level: LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()]
});

// ---------- Prometheus ----------
client.collectDefaultMetrics();
const activeUsersGauge = new client.Gauge({
  name: 'active_connections',
  help: 'Number of active Socket.IO connections'
});

// ---------- Redis setup ----------
const pubClient = createClient({ url: REDIS_URL });
const subClient = pubClient.duplicate();

pubClient.on('error', (err) => logger.error('Redis pubClient error', { err: err?.message || err }));
subClient.on('error', (err) => logger.error('Redis subClient error', { err: err?.message || err }));

// ---------- Kafka setup (optional) ----------
let kafkaConnected = false;
let producer = null;
if (KAFKA_BROKERS) {
  const kafkaConfig = {
    clientId: 'webrtc-chat-service',
    brokers: KAFKA_BROKERS.split(',').map(s => s.trim())
  };

  // Add SSL options if provided
  if (KAFKA_SSL_CA && KAFKA_SSL_KEY && KAFKA_SSL_CERT) {
    kafkaConfig.ssl = {
      rejectUnauthorized: true,
      ca: [fs.readFileSync(KAFKA_SSL_CA, 'utf8')],
      key: fs.readFileSync(KAFKA_SSL_KEY, 'utf8'),
      cert: fs.readFileSync(KAFKA_SSL_CERT, 'utf8')
    };
  }

  const kafka = new Kafka(kafkaConfig);
  producer = kafka.producer();

  producer.connect()
    .then(() => {
      kafkaConnected = true;
      logger.info('Connected to Kafka brokers');
    })
    .catch((err) => {
      kafkaConnected = false;
      logger.error('Kafka connection error', { err: err?.message || err });
    });
}

// Helper: safe kafka logger
async function logEventToKafka(topic, event) {
  if (!producer || !kafkaConnected) {
    // degrade gracefully — do not throw
    logger.debug('Kafka not connected, skipping event', { topic, eventType: event?.type });
    return;
  }
  try {
    await producer.send({
      topic,
      messages: [{ key: event.userIP || null, value: JSON.stringify({ ...event, timestamp: Date.now() }) }]
    });
  } catch (err) {
    logger.error('Failed to send Kafka message', { err: err?.message || err });
  }
}

// ---------- Express + Socket.IO ----------
// We create server now but wait to start listening until Redis adapter ready
const app = express();
const server = http.createServer(app);

// metrics endpoint
app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', client.register.contentType);
    res.end(await client.register.metrics());
  } catch (err) {
    res.status(500).send('metrics error');
  }
});

app.get('/health', async (req, res) => {
  try {
    // Redis ping (may throw)
    await pubClient.ping();
    res.json({
      status: 'UP',
      redis: 'ok',
      kafka: kafkaConnected ? 'ok' : 'disconnected'
    });
  } catch (err) {
    res.status(500).json({ status: 'DOWN', error: err?.message || err });
  }
});

// ---------- Match making constants ----------
const MATCH_QUEUE = 'wait_queue';
const SOCKET_MAP = 'socket_map'; // hash: ip -> socketId
const MATCH_MAP = 'match_map'; // hash: ip -> peerIp

// ---------- Main async init ----------
(async function init() {
  try {
    // Connect Redis clients
    await pubClient.connect();
    await subClient.connect();
    logger.info('Connected to Redis');

    // Now create socket.io and set adapter (must be after Redis connect)
    const io = socketIo(server, {
      cors: { origin: CLIENT_URL || '*', methods: ['GET', 'POST'] },
      maxHttpBufferSize: 1e6 // 1MB - tune as needed
    });

    io.adapter(createAdapter(pubClient, subClient));
    logger.info('Socket.IO with Redis adapter set up');

    // Handle socket connections
    io.on('connection', (socket) => {
      const userIP = (socket.handshake.headers['x-forwarded-for'] || socket.handshake.address || '').toString();
      logger.info('User connected', { userIP, socketId: socket.id });
      activeUsersGauge.inc();

      // store mapping ip -> socketId
      pubClient.hSet(SOCKET_MAP, userIP, socket.id).catch(err => {
        logger.error('Redis hSet error', { err: err?.message || err });
      });

      // small wrapper to log asynchronously
      logEventToKafka(KAFKA_TOPIC_EVENTS || 'user-events', { type: 'connect', userIP }).catch(() => {});

      // find_match
      socket.on('find_match', async () => {
        try {
          // remove duplicates of same IP
          await pubClient.lRem(MATCH_QUEUE, 0, userIP);
          // pop a queued peer
          const peerIP = await pubClient.lPop(MATCH_QUEUE);
          if (peerIP && peerIP !== userIP) {
            const roomId = `room-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
            await pubClient.hSet(MATCH_MAP, userIP, peerIP);
            await pubClient.hSet(MATCH_MAP, peerIP, userIP);

            socket.join(roomId);
            const peerSocketId = await pubClient.hGet(SOCKET_MAP, peerIP);
            if (peerSocketId) {
              // join peer to room (works across nodes)
              io.to(peerSocketId).socketsJoin(roomId);
              // notify both
              socket.emit('match_found', { roomId, peerIP });
              io.to(peerSocketId).emit('match_found', { roomId, peerIP: userIP });
            } else {
              // If peer not online, push current user back
              await pubClient.rPush(MATCH_QUEUE, userIP);
            }

            logEventToKafka(KAFKA_TOPIC_EVENTS || 'user-events', { type: 'match', userIP, peerIP, roomId }).catch(() => {});
          } else {
            // push ourselves to queue if nothing found
            await pubClient.rPush(MATCH_QUEUE, userIP);
            socket.emit('waiting');
            logger.info('Added to matchmaking queue', { userIP });
          }
        } catch (err) {
          logger.error('find_match error', { err: err?.message || err, userIP });
        }
      });

      // Generic signaling forwarder helper
      const forwardToPeer = async (eventName, incomingData) => {
        try {
          const peerIP = await pubClient.hGet(MATCH_MAP, userIP);
          if (!peerIP) {
            logger.debug('No peer found to forward', { eventName, userIP });
            return;
          }
          const peerSocketId = await pubClient.hGet(SOCKET_MAP, peerIP);
          if (!peerSocketId) {
            logger.debug('Peer socketId not found', { peerIP });
            return;
          }

          // Normalize payload: if incomingData has sdp/candidate inside or is raw
          const payload = {};
          if (incomingData && typeof incomingData === 'object') {
            if (incomingData.sdp) payload.sdp = incomingData.sdp;
            if (incomingData.candidate) payload.candidate = incomingData.candidate;
            if (incomingData.type && incomingData.sdp) payload.sdp = incomingData; // if a full RTCSessionDescription
            // else pass entire object
            if (!payload.sdp && !payload.candidate) Object.assign(payload, incomingData);
          } else {
            payload.data = incomingData;
          }
          payload.from = userIP;

          io.to(peerSocketId).emit(eventName, payload);
          logEventToKafka(KAFKA_TOPIC_EVENTS || 'user-events', { type: eventName, userIP, peerIP }).catch(() => {});
        } catch (err) {
          logger.error('forwardToPeer error', { err: err?.message || err, eventName, userIP });
        }
      };

      // signaling events
      socket.on('webrtc_offer', (data) => forwardToPeer('webrtc_offer', data));
      socket.on('webrtc_answer', (data) => forwardToPeer('webrtc_answer', data));
      socket.on('webrtc_ice_candidate', (data) => forwardToPeer('webrtc_ice_candidate', data));

      socket.on('webrtc_error', (err) => {
        logger.error('webrtc_error from client', { userIP, err });
        logEventToKafka(KAFKA_TOPIC_EVENTS || 'user-events', { type: 'webrtc_error', userIP, err }).catch(() => {});
      });

      socket.on('disconnect', async (reason) => {
        try {
          logger.info('User disconnected', { userIP, reason });
          // notify peer if matched
          const peerIP = await pubClient.hGet(MATCH_MAP, userIP);
          await pubClient.hDel(MATCH_MAP, userIP);
          await pubClient.hDel(SOCKET_MAP, userIP);
          await pubClient.lRem(MATCH_QUEUE, 0, userIP);

          if (peerIP) {
            await pubClient.hDel(MATCH_MAP, peerIP);
            const peerSocketId = await pubClient.hGet(SOCKET_MAP, peerIP);
            if (peerSocketId) io.to(peerSocketId).emit('peer_disconnected', { peerIP: userIP });
          }

          activeUsersGauge.dec();
          logEventToKafka(KAFKA_TOPIC_EVENTS || 'user-events', { type: 'disconnect', userIP, reason }).catch(() => {});
        } catch (err) {
          logger.error('disconnect handler error', { err: err?.message || err });
        }
      });

      socket.on('error', (err) => {
        logger.error('Socket error', { userIP, err: err?.message || err });
        logEventToKafka(KAFKA_TOPIC_EVENTS || 'user-events', { type: 'socket_error', userIP, error: err?.message || err }).catch(() => {});
      });
    });

    // Start server only after Redis and adapter are ready
    server.listen(PORT, () => {
      logger.info(`WebRTC signaling server running on port ${PORT}`);
    });

    // Graceful shutdown
    const graceful = async () => {
      logger.info('Shutting down gracefully...');
      try {
        if (producer && kafkaConnected) {
          await producer.disconnect().catch(e => logger.warn('Kafka disconnect warning', { e: e?.message || e }));
        }
      } catch (err) {
        logger.error('Error disconnecting Kafka', { err: err?.message || err });
      }
      try {
        if (pubClient) await pubClient.quit().catch(e => logger.warn('Redis pubClient quit warning', { e: e?.message || e }));
        if (subClient) await subClient.quit().catch(e => logger.warn('Redis subClient quit warning', { e: e?.message || e }));
      } catch (err) {
        logger.error('Error quitting Redis', { err: err?.message || err });
      }
      server.close(() => {
        logger.info('HTTP server closed');
        process.exit(0);
      });
      // if not closed in 5s, force exit
      setTimeout(() => {
        logger.warn('Forcing shutdown');
        process.exit(1);
      }, 5000).unref();
    };

    process.on('SIGINT', graceful);
    process.on('SIGTERM', graceful);

  } catch (err) {
    logger.error('Fatal init error', { err: err?.message || err });
    process.exit(1);
  }
})();
