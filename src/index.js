// Express server & HTTP wrapper for VeloGrid
require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const { initSocketManager } = require('./socketManager');
const roomStore = require('./roomStore');

const app = express();
const server = http.createServer(app);

// Enable CORS for cross-origin mobile app connections
app.use(cors({ origin: '*' }));
app.use(express.json());

// Setup Socket.IO with permissive CORS & optimized transport options
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  pingInterval: 10000,
  pingTimeout: 5000,
  transports: ['websocket', 'polling'],
});

// Initialize socket manager events
initSocketManager(io);

// Health check & diagnostic routes
app.get('/', (req, res) => {
  res.json({
    app: 'VeloGrid Real-time Intercom & Radar Server',
    version: '1.0.0',
    status: 'online',
    timestamp: new Date().toISOString(),
    stats: roomStore.getStats(),
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), stats: roomStore.getStats() });
});

app.get('/api/rooms/:roomCode', (req, res) => {
  const roomState = roomStore.getRoomState(req.params.roomCode);
  if (!roomState) {
    return res.status(404).json({ error: 'Room not found or expired' });
  }
  res.json(roomState);
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n==========================================`);
  console.log(`🏍️  VeloGrid Real-time Server Running`);
  console.log(`📡 Port: ${PORT}`);
  console.log(`🌐 Local: http://localhost:${PORT}`);
  console.log(`⚡ Socket.IO Ready for Convoy Telemetry`);
  console.log(`==========================================\n`);
});
