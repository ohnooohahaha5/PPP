import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { GameRoom } from './GameRoom.js';

const app = express();
app.use(cors());

// Keep-alive endpoint for Render
app.get('/ping', (req, res) => {
  res.send('pong');
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;

// Store active game rooms
const rooms = new Map(); // Map<roomCode, GameRoom>

// Matchmaking State
let matchmakingQueues = { 2: [], 4: [] };
let matchWaitTimeouts = { 2: null, 4: null };

const broadcastQueueUpdate = (numPlayers) => {
  const queue = matchmakingQueues[numPlayers];
  const waitingFor = Math.max(0, numPlayers - queue.length);
  queue.forEach(p => {
    p.socket.emit('matchmakingUpdate', { waitingFor });
  });
};

const createMatchFromQueue = (numPlayers) => {
  const queue = matchmakingQueues[numPlayers];
  if (queue.length < 2) return;
  
  // Pick up to numPlayers from the queue
  const matchedPlayers = queue.splice(0, numPlayers);
  
  if (matchWaitTimeouts[numPlayers]) {
    clearTimeout(matchWaitTimeouts[numPlayers]);
    matchWaitTimeouts[numPlayers] = null;
  }
  
  const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
  const newRoom = new GameRoom(roomCode, 'online', numPlayers, io);
  rooms.set(roomCode, newRoom);

  matchedPlayers.forEach((player) => {
    player.socket.join(roomCode);
    player.socket.data.roomCode = roomCode;
    const playerId = newRoom.addPlayer(player.socketId, player.name, true);
    player.socket.emit('matchFound', { 
      success: true, 
      roomCode, 
      playerId, 
      state: newRoom.getState() 
    });
  });

  newRoom.initializeGame();
  io.to(roomCode).emit('gameStateUpdate', newRoom.getState());
  
  if (queue.length >= 2) {
    matchWaitTimeouts[numPlayers] = setTimeout(() => createMatchFromQueue(numPlayers), 5000);
  }
  
  broadcastQueueUpdate(numPlayers);
};

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Leave any existing rooms when joining a new one
  const leaveRoom = (roomCode) => {
    socket.leave(roomCode);
    if (rooms.has(roomCode)) {
      const room = rooms.get(roomCode);
      
      if (room.status === 'playing') {
        room.handlePlayerQuit(socket.id);
      } else {
        room.removePlayer(socket.id);
      }
      
      if (room.getPlayers().length === 0 && !room.isOfflineMode) {
        rooms.delete(roomCode); // Clean up empty online room
      } else {
        io.to(roomCode).emit('gameStateUpdate', room.getState());
      }
    }
  };

  socket.on('createRoom', ({ name, mode, numPlayers }, callback) => {
    // Generate 4 letter code
    const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
    
    // Pass 'io' down so the room can emit broadcasts internally (for CPU delays)
    const newRoom = new GameRoom(roomCode, mode, numPlayers, io);
    rooms.set(roomCode, newRoom);

    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    
    // Add the host player
    const playerId = newRoom.addPlayer(socket.id, name, true);
    
    callback({ success: true, roomCode, playerId, state: newRoom.getState() });
    io.to(roomCode).emit('gameStateUpdate', newRoom.getState());
  });

  socket.on('joinRoom', ({ name, roomCode }, callback) => {
    if (!rooms.has(roomCode)) {
      return callback({ success: false, error: 'Room not found' });
    }

    const room = rooms.get(roomCode);
    if (room.status !== 'menu' && room.status !== 'lobby') {
      return callback({ success: false, error: 'Game already started' });
    }
    
    if (room.getPlayers().length >= room.maxPlayers) {
      // Goal: Allow users to join if an AI exists
      const aiIndex = room.players.findIndex(p => !p.isHuman);
      
      if (aiIndex !== -1) {
        // Transform the AI player slot
        const aiPlayerId = room.players[aiIndex].id;
        room.players[aiIndex] = {
           id: aiPlayerId,
           socketId: socket.id,
           name: name || `Player ${aiPlayerId + 1}`,
           isHuman: true,
           cards: [],
           capturedCards: []
        };
        socket.join(roomCode);
        socket.data.roomCode = roomCode;
        callback({ success: true, roomCode, playerId: aiPlayerId, state: room.getState() });
        io.to(roomCode).emit('gameStateUpdate', room.getState());
        return;
      } else {
        return callback({ success: false, error: 'Room is full' });
      }
    }

    socket.join(roomCode);
    socket.data.roomCode = roomCode;

    const playerId = room.addPlayer(socket.id, name, true);

    callback({ success: true, roomCode, playerId, state: room.getState() });
    
    io.to(roomCode).emit('gameStateUpdate', room.getState());
  });

  socket.on('removePlayer', ({ roomCode, targetId }) => {
    if (!rooms.has(roomCode)) return;
    const room = rooms.get(roomCode);
    if (room.status !== 'menu' && room.status !== 'lobby') return;
    
    // Identify host
    const hostPlayer = room.players.find(p => p.socketId === socket.id);
    if (!hostPlayer || hostPlayer.id !== 0) return; // Only host ID 0 can remove
    if (targetId === 0) return; // Cannot remove self
    
    const targetIndex = room.players.findIndex(p => p.id === targetId);
    if (targetIndex !== -1) {
      const targetSocketId = room.players[targetIndex].socketId;
      if (targetSocketId) {
         const targetSocket = io.sockets.sockets.get(targetSocketId);
         if (targetSocket) {
             targetSocket.leave(roomCode);
             targetSocket.data.roomCode = null;
             targetSocket.emit('kicked');
         }
      }

      // Convert to AI
      room.players[targetIndex] = {
        id: targetId,
        socketId: null,
        name: `CPU ${targetId}`,
        isHuman: false,
        cards: [],
        capturedCards: []
      };

      io.to(roomCode).emit('gameStateUpdate', room.getState());
    }
  });

  socket.on('patchNames', ({ roomCode, localNames }) => {
    if (!rooms.has(roomCode)) return;
    const room = rooms.get(roomCode);
    room.patchPlayerNames(localNames);
  });

  socket.on('startGame', ({ roomCode }) => {
    if (!rooms.has(roomCode)) return;
    const room = rooms.get(roomCode);
    
    room.initializeGame();
    io.to(roomCode).emit('gameStateUpdate', room.getState());
  });

  // Gameplay Events
  socket.on('playCard', ({ roomCode, playerId }) => {
    if (!rooms.has(roomCode)) return;
    const room = rooms.get(roomCode);
    room.attemptPlayCard(playerId);
  });

  socket.on('grabAttempt', ({ roomCode, playerId }, callback) => {
    if (!rooms.has(roomCode)) return callback({ success: false });
    const room = rooms.get(roomCode);
    
    const result = room.attemptGrab(playerId);
    callback(result); // true/false for client UI decoy/shake tracking
  });

  // Matchmaking Events
  socket.on('joinMatchmaking', ({ name, numPlayers }) => {
    const pref = numPlayers === 4 ? 4 : 2; // enforce 2 or 4
    const queue = matchmakingQueues[pref];
    
    // Ignore if already in any queue
    if (matchmakingQueues[2].some(p => p.socketId === socket.id) || matchmakingQueues[4].some(p => p.socketId === socket.id)) return;
    
    queue.push({ socket, socketId: socket.id, name });
    socket.data.matchmakingPref = pref;
    broadcastQueueUpdate(pref);
    
    if (queue.length >= pref) {
      createMatchFromQueue(pref);
    } else if (queue.length >= 2 && !matchWaitTimeouts[pref]) {
      matchWaitTimeouts[pref] = setTimeout(() => createMatchFromQueue(pref), 5000);
    }
  });

  socket.on('leaveMatchmaking', () => {
    [2, 4].forEach(pref => {
      const queue = matchmakingQueues[pref];
      const initialLength = queue.length;
      matchmakingQueues[pref] = queue.filter(p => p.socketId !== socket.id);
      if (initialLength !== matchmakingQueues[pref].length) {
        broadcastQueueUpdate(pref);
      }
      if (matchmakingQueues[pref].length < 2 && matchWaitTimeouts[pref]) {
        clearTimeout(matchWaitTimeouts[pref]);
        matchWaitTimeouts[pref] = null;
      }
    });
  });

  // Quit Game Event
  socket.on('quitGame', () => {
    if (socket.data.roomCode) {
      leaveRoom(socket.data.roomCode);
      socket.data.roomCode = null;
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    
    // Remove from matchmaking just in case
    [2, 4].forEach(pref => {
      const queue = matchmakingQueues[pref];
      if (!queue) return;
      const initialLength = queue.length;
      matchmakingQueues[pref] = queue.filter(p => p.socketId !== socket.id);
      if (initialLength !== matchmakingQueues[pref].length) {
        broadcastQueueUpdate(pref);
      }
      if (matchmakingQueues[pref].length < 2 && matchWaitTimeouts[pref]) {
        clearTimeout(matchWaitTimeouts[pref]);
        matchWaitTimeouts[pref] = null;
      }
    });

    if (socket.data.roomCode) {
      leaveRoom(socket.data.roomCode);
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
