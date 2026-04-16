const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Game rooms storage
const rooms = new Map();
const playerToRoom = new Map(); // Track which room each player is in

// Helper function to generate random room code
function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Seeded random number generator (mulberry32)
function mulberry32(a) {
  return function() {
    a |= 0;
    a = a + 0x6d2b79f5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Create room endpoint
app.post('/create-room', (req, res) => {
  let roomCode;
  do {
    roomCode = generateRoomCode();
  } while (rooms.has(roomCode));

  const room = {
    code: roomCode,
    players: new Map(),
    gameActive: false,
    timer: 0,
    platformSeed: Math.floor(Math.random() * 1000000),
    timerInterval: null,
    host: null
  };

  rooms.set(roomCode, room);
  res.json({ roomCode });
  console.log(`Room created: ${roomCode}`);
});

// WebSocket connection handler
wss.on('connection', (ws) => {
  let playerId = null;
  let roomCode = null;

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);

      if (message.type === 'join') {
        roomCode = message.room.toUpperCase();
        const playerName = message.name || `Player${Math.floor(Math.random() * 1000)}`;

        if (!rooms.has(roomCode)) {
          ws.send(JSON.stringify({ type: 'error', error: 'Room not found' }));
          ws.close();
          return;
        }

        const room = rooms.get(roomCode);

        if (room.players.size >= 9) {
          ws.send(JSON.stringify({ type: 'error', error: 'Room is full' }));
          ws.close();
          return;
        }

        // Generate player ID
        playerId = `player_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        playerToRoom.set(playerId, roomCode);

        // Add player to room
        const player = {
          id: playerId,
          name: playerName,
          ws: ws,
          x: Math.random() * 800,
          y: 500,
          energy: 10,
          heightReached: 0
        };

        // First player becomes host
        if (room.players.size === 0) {
          room.host = playerId;
        }

        room.players.set(playerId, player);

        // Send confirmation
        ws.send(JSON.stringify({
          type: 'joined',
          playerId: playerId,
          roomCode: roomCode,
          isHost: room.host === playerId,
          platformSeed: room.platformSeed,
          players: Array.from(room.players.values()).map(p => ({
            id: p.id,
            name: p.name,
            x: p.x,
            y: p.y,
            energy: p.energy,
            heightReached: p.heightReached
          }))
        }));

        // Notify other players
        broadcastToRoom(roomCode, {
          type: 'playerJoined',
          player: {
            id: player.id,
            name: player.name,
            x: player.x,
            y: player.y,
            energy: player.energy,
            heightReached: player.heightReached
          }
        }, playerId);

        console.log(`Player ${playerName} (${playerId}) joined room ${roomCode}`);
      }

      if (message.type === 'start' && roomCode) {
        const room = rooms.get(roomCode);
        if (!room || room.host !== playerId) return;

        room.gameActive = true;
        room.timer = message.timerDuration || 300; // Default 5 minutes

        broadcastToRoom(roomCode, {
          type: 'gameStart',
          timerDuration: room.timer,
          platformSeed: room.platformSeed
        });

        // Start countdown timer
        if (room.timerInterval) clearInterval(room.timerInterval);

        room.timerInterval = setInterval(() => {
          room.timer--;

          if (room.timer <= 0) {
            clearInterval(room.timerInterval);
            room.gameActive = false;

            // Calculate final standings
            const standings = Array.from(room.players.values())
              .map(p => ({
                id: p.id,
                name: p.name,
                heightReached: p.heightReached,
                energy: p.energy
              }))
              .sort((a, b) => b.heightReached - a.heightReached);

            broadcastToRoom(roomCode, {
              type: 'gameOver',
              standings: standings
            });

            console.log(`Game ended in room ${roomCode}`);
          }
        }, 1000);

        console.log(`Game started in room ${roomCode}, timer: ${room.timer}s`);
      }

      if (message.type === 'playerUpdate' && roomCode) {
        const room = rooms.get(roomCode);
        if (!room || !room.players.has(playerId)) return;

        const player = room.players.get(playerId);
        player.x = message.x;
        player.y = message.y;
        player.energy = message.energy;
        player.heightReached = Math.max(player.heightReached, message.heightReached);

        // Broadcast to all players in room
        broadcastToRoom(roomCode, {
          type: 'playerUpdate',
          playerId: playerId,
          x: player.x,
          y: player.y,
          energy: player.energy,
          heightReached: player.heightReached
        }, playerId);
      }

      if (message.type === 'answerResult' && roomCode) {
        const room = rooms.get(roomCode);
        if (!room || !room.players.has(playerId)) return;

        const player = room.players.get(playerId);
        if (message.correct) {
          player.energy = Math.min(player.energy + 10, 30);
        }

        broadcastToRoom(roomCode, {
          type: 'answerResult',
          playerId: playerId,
          correct: message.correct,
          newEnergy: player.energy
        });
      }
    } catch (e) {
      console.error('Error processing message:', e);
    }
  });

  ws.on('close', () => {
    if (playerId && roomCode && rooms.has(roomCode)) {
      const room = rooms.get(roomCode);
      room.players.delete(playerId);
      playerToRoom.delete(playerId);

      // Notify remaining players
      broadcastToRoom(roomCode, {
        type: 'playerLeft',
        playerId: playerId
      });

      // Clean up empty rooms
      if (room.players.size === 0) {
        if (room.timerInterval) clearInterval(room.timerInterval);
        rooms.delete(roomCode);
        console.log(`Room ${roomCode} deleted (empty)`);
      } else if (room.host === playerId) {
        // Assign new host if current host left
        const newHost = Array.from(room.players.values())[0];
        room.host = newHost.id;
        broadcastToRoom(roomCode, {
          type: 'newHost',
          playerId: newHost.id,
          playerName: newHost.name
        });
      }

      console.log(`Player ${playerId} disconnected from room ${roomCode}`);
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// Helper function to broadcast to all players in a room
function broadcastToRoom(roomCode, message, excludePlayerId = null) {
  const room = rooms.get(roomCode);
  if (!room) return;

  const payload = JSON.stringify(message);
  room.players.forEach((player) => {
    if (excludePlayerId && player.id === excludePlayerId) return;
    if (player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(payload);
    }
  });
}

// Get local IP address
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Skip internal and non-IPv4 addresses
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// Start server
const PORT = 3000;
server.listen(PORT, () => {
  const localIP = getLocalIP();
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║  Sailing 101: Don\'t Look Down - Multiplayer Server    ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log(`\nServer running on http://localhost:${PORT}`);
  console.log(`\nShare this address with students:\n`);
  console.log(`  http://${localIP}:${PORT}`);
  console.log(`\nOr if on same device:\n`);
  console.log(`  http://localhost:${PORT}\n`);
});
