import { io } from 'socket.io-client';

const socket = io('https://omegle-v3gr.onrender.com', {
  autoConnect: false, // don’t connect automatically
});

export default socket;

