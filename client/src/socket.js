
// =========================
// src/socket.js
// =========================
import { io } from 'socket.io-client';

// Read backend URL from Vite env var
const BACKEND_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

// Create a socket instance with sensible reconnection settings
const rawSocket = io(BACKEND_URL, {
  autoConnect: false,
  transports: ['websocket', 'polling'],
  reconnectionAttempts: 5,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
});

// Small helper queue for emits while socket is connecting
const emitQueue = [];
let connected = false;

rawSocket.on('connect', () => {
  connected = true;
  // flush queue
  while (emitQueue.length) {
    const { event, payload } = emitQueue.shift();
    rawSocket.emit(event, payload);
  }
  console.info('[Socket] Connected:', rawSocket.id);
});

rawSocket.on('disconnect', (reason) => {
  connected = false;
  console.info('[Socket] Disconnected:', reason);
});

rawSocket.on('connect_error', (err) => {
  console.warn('[Socket] connect_error', err.message);
});

function safeEmit(event, payload) {
  if (connected) return rawSocket.emit(event, payload);
  console.info('[Socket] Not connected yet — queueing emit:', event);
  emitQueue.push({ event, payload });
}

export default {
  // expose a minimal subset to keep the app code simple
  connect: () => rawSocket.connect(),
  disconnect: () => rawSocket.disconnect(),
  on: (ev, cb) => rawSocket.on(ev, cb),
  off: (ev, cb) => rawSocket.off(ev, cb),
  emit: (ev, payload) => safeEmit(ev, payload),
  id: () => rawSocket.id,
  raw: rawSocket,
};
