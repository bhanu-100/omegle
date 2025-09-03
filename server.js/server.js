// server.js
// A simple, self-contained backend for an Omegle clone using Node.js and Socket.IO.
// This server is optimized for simplicity and handles the core logic for up to 100 concurrent users.

// Import necessary libraries.
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

// Constants.
const PORT = process.env.PORT || 3000;

// Initialize Express and HTTP server.
const app = express();
const server = http.createServer(app);

// Initialize Socket.IO with CORS enabled for frontend communication.
const io = new Server(server, {
    cors: {
        origin: "*", // Allows all origins for development.
        methods: ["GET", "POST"]
    }
});

// Serve a basic HTML file for testing purposes if needed.
app.get('/', (req, res) => {
    res.send('<h1>Omegle Clone Backend is running!</h1>');
});

// In-memory data structures for managing users and matches.
// This is much simpler than a Redis/Kafka-based system and is perfect for 100 users.
const waitingQueue = [];
const activeMatches = new Map(); // Maps socket.id to its partner's socket.id.

// Socket.IO event handling.
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // Check if there is a partner waiting in the queue.
    if (waitingQueue.length > 0) {
        // A partner is available! Get the first user from the queue.
        const partnerSocket = waitingQueue.shift();

        // Check if the partner is still connected.
        if (partnerSocket.connected) {
            console.log(`Matching ${socket.id} with ${partnerSocket.id}`);

            // Store the partnership in both directions for easy lookup.
            activeMatches.set(socket.id, partnerSocket.id);
            activeMatches.set(partnerSocket.id, socket.id);

            // Notify both clients that a match has been found.
            // We send the partner's socket ID so the frontend can initiate a connection.
            socket.emit('match_found', { peerId: partnerSocket.id });
            partnerSocket.emit('match_found', { peerId: socket.id });
        } else {
            // The partner was no longer connected, so we add the current user to the queue.
            console.log(`Found stale partner, adding ${socket.id} to queue.`);
            waitingQueue.push(socket);
            socket.emit('waiting');
        }
    } else {
        // No one is waiting, so we add the current user to the queue.
        console.log(`${socket.id} added to waiting queue.`);
        waitingQueue.push(socket);
        socket.emit('waiting');
    }

    // Handle WebRTC signaling data.
    // This is a simple relay for all signaling messages (offer, answer, candidate).
    socket.on('signal', (data) => {
        const partnerId = activeMatches.get(socket.id);
        if (partnerId) {
            // Forward the signaling data to the connected partner.
            io.to(partnerId).emit('signal', data);
        }
    });

    // Handle user disconnection.
    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);

        const partnerId = activeMatches.get(socket.id);

        if (partnerId) {
            // If the user had a partner, notify them of the disconnection.
            io.to(partnerId).emit('partnerDisconnected');

            // Clean up the partnership from the activeMatches map.
            activeMatches.delete(socket.id);
            activeMatches.delete(partnerId);

            console.log(`Disconnected pairing: ${socket.id} and ${partnerId}`);
        } else {
            // If the user was in the waiting queue, remove them from it.
            const index = waitingQueue.findIndex(s => s.id === socket.id);
            if (index > -1) {
                waitingQueue.splice(index, 1);
                console.log(`Removed ${socket.id} from waiting queue`);
            }
        }
    });
});

// Start the server.
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});

// To run this file, you'll need Node.js and the 'express' and 'socket.io' packages.
// You can install them by running:
// npm init -y
// npm install express socket.io
// Then, run the server with:
// node server.js
