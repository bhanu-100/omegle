const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
require('dotenv').config();

const CLIENT_URL = process.env.CLIENT_URL
const app = express();
app.use(cors({
  origin: CLIENT_URL,  // ✅ Your deployed frontend URL
  methods: ['GET', 'POST'],
  credentials: true
}));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: CLIENT_URL,
    methods: ['GET', 'POST'],
  },
});

let waitingQueue = [];

// ✅ Function to match two users from the queue
function matchUsers() {
  while (waitingQueue.length >= 2) {
    const user1 = waitingQueue.shift();
    const user2 = waitingQueue.shift();

    if (!user1.connected || !user2.connected) continue;

    user1.partner = user2;
    user2.partner = user1;

    user1.emit('partner-found');
    user2.emit('partner-found');
  }
}

io.on('connection', (socket) => {
  console.log(`🔌 User connected: ${socket.id}`);

  // ✅ User wants to join matchmaking
  socket.on('join', () => {
    if (waitingQueue.find((s) => s.id === socket.id)) return; // avoid duplicates

    waitingQueue.push(socket);
    socket.emit('waiting');
    matchUsers();
  });

  // ✅ User sends a text message
  socket.on('message', (msg) => {
    if (socket.partner) {
      socket.partner.emit('message', msg);
    }
  });

  // ✅ Skip current partner and rematch
  socket.on('skip', () => {
    console.log(`⏩ User skipped: ${socket.id}`);

    if (socket.partner) {
      const partner = socket.partner;
      partner.emit('partner-disconnected');
      partner.partner = null;

      if (partner.connected) {
        waitingQueue.push(partner);
      }
    }

    socket.partner = null;
    waitingQueue.push(socket);
    socket.emit('waiting');
    matchUsers();
  });

  // ✅ Clean disconnection
  socket.on('disconnect', () => {
    console.log(`❌ User disconnected: ${socket.id}`);

    if (socket.partner) {
      socket.partner.emit('partner-disconnected');
      socket.partner.partner = null;

      if (socket.partner.connected) {
        waitingQueue.push(socket.partner);
        matchUsers();
      }
    }

    waitingQueue = waitingQueue.filter((s) => s.id !== socket.id);
  });

  // ✅ WebRTC signaling handlers
  socket.on('offer', (data) => {
    if (socket.partner) socket.partner.emit('offer', data);
  });

  socket.on('answer', (data) => {
    if (socket.partner) socket.partner.emit('answer', data);
  });

  socket.on('ice-candidate', (candidate) => {
    if (socket.partner) socket.partner.emit('ice-candidate', candidate);
  });
});

server.listen(3001, () => {
  console.log('✅ Server running at http://localhost:3001');
});
