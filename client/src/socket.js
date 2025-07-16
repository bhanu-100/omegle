import { io } from 'socket.io-client';

const socket = io('http://localhost:3001', {
  autoConnect: false, // don’t connect automatically
});

export default socket;

