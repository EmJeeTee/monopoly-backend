const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const httpServer = createServer(app);

// CORS ayarları
app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json());

// Socket.io kurulumu
const io = new Server(httpServer, {
  cors: {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST']
  }
});

// In-memory storage
const rooms = {};
const pendingActions = {};
const operationQueues = {}; // Her oda için operation queue

// Test endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'Monopoly Backend Running!', 
    rooms: Object.keys(rooms).length,
    activeConnections: io.engine.clientsCount 
  });
});

// ============================================
// ADMIN PANEL CONFIGURATION
// ============================================

// Admin password from environment (default: "admin123" for development)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
console.log('🔐 Admin panel enabled. Default password:', ADMIN_PASSWORD === 'admin123' ? 'admin123 (CHANGE IN PRODUCTION!)' : '***');

// Simple token generation (in production, use JWT)
function generateAdminToken(password) {
  return crypto.createHash('sha256').update(password + 'monopoly-secret').digest('hex');
}

// Admin authentication middleware
function authenticateAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized - Token required' });
  }
  
  const token = authHeader.substring(7);
  const validToken = generateAdminToken(ADMIN_PASSWORD);
  
  if (token !== validToken) {
    return res.status(401).json({ error: 'Unauthorized - Invalid token' });
  }
  
  next();
}

// ============================================
// ADMIN PANEL ENDPOINTS
// ============================================

// Serve admin panel HTML
app.get('/admin', (req, res) => {
  const adminPath = path.join(__dirname, 'admin-panel.html');
  if (fs.existsSync(adminPath)) {
    res.sendFile(adminPath);
  } else {
    res.status(404).send('Admin panel not found. Please ensure admin-panel.html exists in the same directory as server.js');
  }
});

// Admin login
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  
  if (!password) {
    return res.status(400).json({ error: 'Password required' });
  }
  
  if (password === ADMIN_PASSWORD) {
    const token = generateAdminToken(password);
    console.log('✅ Admin logged in');
    res.json({ success: true, token });
  } else {
    console.log('❌ Failed admin login attempt');
    res.status(401).json({ error: 'Invalid password' });
  }
});

// List all rooms (admin only)
app.get('/api/admin/rooms', authenticateAdmin, (req, res) => {
  const roomsData = Object.keys(rooms).map(roomId => {
    const room = rooms[roomId];
    const onlineCount = room.players.filter(p => p.online !== false).length;
    
    return {
      id: roomId,
      playerCount: room.players.length,
      onlineCount: onlineCount,
      gamePlayerCount: Object.keys(room.gameState.players || {}).length,
      actionLogCount: room.actionLog.length,
      createdAt: room.createdAt,
      players: room.players.map(p => ({
        name: p.name,
        online: p.online !== false
      }))
    };
  });
  
  const totalPlayers = roomsData.reduce((sum, room) => sum + room.playerCount, 0);
  const onlinePlayers = roomsData.reduce((sum, room) => sum + room.onlineCount, 0);
  
  res.json({
    totalRooms: roomsData.length,
    totalPlayers,
    onlinePlayers,
    rooms: roomsData
  });
});

// Delete specific room (admin only)
app.delete('/api/admin/rooms/:roomId', authenticateAdmin, (req, res) => {
  const { roomId } = req.params;
  
  if (!rooms[roomId]) {
    return res.status(404).json({ error: 'Room not found' });
  }
  
  // Notify all players in the room
  io.to(roomId).emit('roomDeleted', { 
    message: 'Bu oda yönetici tarafından silindi' 
  });
  
  delete rooms[roomId];
  delete operationQueues[roomId];
  
  console.log(`🗑️ Admin deleted room: ${roomId}`);
  res.json({ success: true, message: `Room ${roomId} deleted` });
});

// Clear all rooms (admin only)
app.post('/api/admin/rooms/clear-all', authenticateAdmin, (req, res) => {
  const roomCount = Object.keys(rooms).length;
  
  // Notify all rooms
  Object.keys(rooms).forEach(roomId => {
    io.to(roomId).emit('roomDeleted', { 
      message: 'Tüm odalar yönetici tarafından temizlendi' 
    });
  });
  
  // Clear all rooms and queues
  Object.keys(rooms).forEach(roomId => {
    delete rooms[roomId];
    delete operationQueues[roomId];
  });
  
  console.log(`🧹 Admin cleared all rooms (${roomCount} rooms deleted)`);
  res.json({ success: true, deletedCount: roomCount });
});

// ============================================
// GAME ENDPOINTS (existing)
// ============================================

// Masa oluşturma
app.post('/api/room/create', (req, res) => {
  const roomId = generateRoomId();
  rooms[roomId] = {
    id: roomId,
    players: [],
    gameState: {
      players: {},
      nextId: 1,
      parkingMoney: 0,
      passRights: []
    },
    actionLog: [],
    redoLog: [], // Redo için log
    createdAt: Date.now()
  };
  console.log(`✅ Yeni masa oluşturuldu: ${roomId}`);
  res.json({ roomId, joinLink: `/room/${roomId}` });
});

// Masa bilgisi
app.get('/api/room/:roomId', (req, res) => {
  const { roomId } = req.params;
  const room = rooms[roomId];
  
  if (!room) {
    return res.status(404).json({ error: 'Masa bulunamadı' });
  }
  
  res.json({
    id: room.id,
    playerCount: room.players.length,
    players: room.players.map(p => ({ name: p.name, id: p.id })),
    createdAt: room.createdAt
  });
});

// Oyun durumu ve log'ları getir
app.get('/api/room/:roomId/state', (req, res) => {
  const { roomId } = req.params;
  const room = rooms[roomId];
  
  if (!room) {
    return res.status(404).json({ error: 'Masa bulunamadı' });
  }
  
  res.json({
    gameState: room.gameState,
    actionLog: room.actionLog
  });
});

// Masayı sıfırla
app.post('/api/room/:roomId/reset', (req, res) => {
  const { roomId } = req.params;
  const room = rooms[roomId];
  
  if (!room) {
    return res.status(404).json({ error: 'Masa bulunamadı' });
  }
  
  // Oyun durumunu sıfırla
  room.gameState = {
    players: {},
    nextId: 1,
    parkingMoney: 0,
    passRights: []
  };
  room.actionLog = [];
  room.redoLog = [];
  
  // Tüm oyunculara sıfırlama bilgisini gönder
  io.to(roomId).emit('gameReset', { gameState: room.gameState });
  
  console.log(`🔄 Masa sıfırlandı: ${roomId}`);
  res.json({ success: true, gameState: room.gameState });
});

// Socket bağlantıları
io.on('connection', (socket) => {
  console.log('🔌 Yeni bağlantı:', socket.id);

  // Join room with reconnection support
  socket.on('joinRoom', ({ roomId, playerName }) => {
    if (!rooms[roomId]) {
      socket.emit('error', { message: 'Masa bulunamadı' });
      return;
    }

    // Check if player exists (reconnection scenario)
    const existingPlayer = rooms[roomId].players.find(p => p.name === playerName);
    
    if (existingPlayer) {
      // RECONNECTION: Update socket ID and mark as online
      console.log('Reconnecting:', playerName, '(old:', existingPlayer.oldSocketId || existingPlayer.id, ', new:', socket.id, ')');
      existingPlayer.id = socket.id;
      existingPlayer.online = true;
      existingPlayer.lastSeen = Date.now();
      existingPlayer.reconnectedAt = Date.now();
      delete existingPlayer.disconnectedAt;

      // Broadcast online status
      io.to(roomId).emit('statusUpdate', {
        playerName: playerName,
        online: true
      });

      console.log('Player reconnected:', playerName, '- game state preserved');
    } else {
      // NEW PLAYER: Add to room
      const player = {
        id: socket.id,
        name: playerName,
        joinedAt: Date.now(),
        online: true,
        lastSeen: Date.now()
      };
      rooms[roomId].players.push(player);

      io.to(roomId).emit('playerJoined', {
        player,
        players: rooms[roomId].players
      });

      console.log('New player joined:', playerName, '(', roomId, '),', rooms[roomId].players.length, 'players');

      // Add to game state if doesnt exist
      const gameState = rooms[roomId].gameState;
      const gamePlayerExists = Object.values(gameState.players || {}).some(p => p.name === playerName);
      
      if (!gamePlayerExists) {
        // Find unique player ID
        let newPlayerId = gameState.nextId || 1;
        while (gameState.players && gameState.players[newPlayerId]) {
          newPlayerId++;
        }

        // Create new game player with starting money
        const newGamePlayer = {
          id: newPlayerId,
          name: playerName,
          position: 'top',
          money: {
            5000000: 2,
            1000000: 4,
            500000: 1,
            200000: 1,
            100000: 2,
            50000: 1,
            10000: 5
          },
          properties: []
        };

        gameState.players = { ...gameState.players, [newPlayerId]: newGamePlayer };
        gameState.nextId = newPlayerId + 1;
        console.log('Added to game:', playerName, '(ID:', newPlayerId, ')');
      }
    }

    // Join socket.io room
    socket.join(roomId);
    socket.roomId = roomId;
    socket.playerName = playerName;

    // Send current game state and logs
    io.to(roomId).emit('gameStateUpdated', rooms[roomId].gameState);
    io.to(roomId).emit('actionLogUpdated', rooms[roomId].actionLog);
    io.to(roomId).emit('redoLogUpdated', rooms[roomId].redoLog);
  });

  // Oyun durumu güncelleme - Queue sistemi ile
  socket.on('updateGameState', async ({ roomId, gameState, action }) => {
    if (!rooms[roomId]) return;

    try {
      await enqueueOperation(roomId, async () => {
        // Gelen state ile mevcut state'i merge et
        const currentState = rooms[roomId].gameState;
        // Mevcut oyuncuları koru, yeni gelenleri ekle
        const mergedPlayers = { ...currentState.players };
        Object.entries(gameState.players || {}).forEach(([id, player]) => {
          mergedPlayers[id] = player;
        });
        rooms[roomId].gameState = {
          ...currentState,
          ...gameState,
          players: mergedPlayers
        };

        // Action varsa log'a ekle
        if (action) {
          const logEntry = {
            id: Date.now(),
            timestamp: Date.now(),
            action: action.type,
            type: action.type,
            description: action.description,
            playerName: socket.playerName,
            data: {
              ...action.data,
              newState: gameState
            },
            previousState: action.previousState
          };
          rooms[roomId].actionLog.push(logEntry);
          rooms[roomId].redoLog = [];

          io.to(roomId).emit('actionLogUpdated', rooms[roomId].actionLog);
          io.to(roomId).emit('redoLogUpdated', rooms[roomId].redoLog);
        }

        // ✅ FIX: Backend'deki authoritative state'i gönder (gelen değil!)
        io.to(roomId).emit('gameStateUpdated', rooms[roomId].gameState);
        console.log(`🎮 Oyun durumu güncellendi: ${roomId}`, Object.keys(rooms[roomId].gameState.players || {}).length, 'oyuncu');
      });
    } catch (error) {
      console.error('❌ updateGameState hatası:', error);
      socket.emit('error', { message: 'İşlem sırasında hata oluştu' });
    }
  });

  // Yeni: Sadece action ile state güncelle
  socket.on('gameAction', ({ roomId, action }) => {
    if (!rooms[roomId]) return;
    const room = rooms[roomId];
    const prevState = JSON.parse(JSON.stringify(room.gameState));

    // Action türüne göre state güncelle
    // Burada action.type'a göre işlemler eklenmeli
    switch (action.type) {
      case 'ADD_MONEY': {
        const { playerId, amount } = action.data;
        if (room.gameState.players[playerId]) {
          Object.keys(amount).forEach(moneyKey => {
            room.gameState.players[playerId].money[moneyKey] =
              (room.gameState.players[playerId].money[moneyKey] || 0) + (amount[moneyKey] || 0);
          });
        }
        break;
      }
      case 'REMOVE_MONEY': {
        const { playerId, amount } = action.data;
        if (room.gameState.players[playerId]) {
          Object.keys(amount).forEach(moneyKey => {
            room.gameState.players[playerId].money[moneyKey] =
              (room.gameState.players[playerId].money[moneyKey] || 0) - (amount[moneyKey] || 0);
          });
        }
        break;
      }
      case 'TRANSFER_PROPERTY': {
        const { fromPlayerId, toPlayerId, propertyId } = action.data;
        if (room.gameState.players[fromPlayerId] && room.gameState.players[toPlayerId]) {
          // Remove from old owner
          room.gameState.players[fromPlayerId].properties =
            (room.gameState.players[fromPlayerId].properties || []).filter(pid => pid !== propertyId);
          // Add to new owner
          room.gameState.players[toPlayerId].properties =
            [...(room.gameState.players[toPlayerId].properties || []), propertyId];
        }
        break;
      }
      // Diğer action türleri buraya eklenebilir
      default:
        console.log('Bilinmeyen action:', action.type);
    }

    // Action log'a ekle
    const logEntry = {
      id: Date.now(),
      timestamp: Date.now(),
      action: action.type,
      type: action.type,
      description: action.description,
      playerName: socket.playerName,
      data: action.data,
      previousState: prevState
    };
    room.actionLog.push(logEntry);
    room.redoLog = [];

    // Herkese yeni state ve actionLog'u gönder
    io.to(roomId).emit('gameStateUpdated', room.gameState);
    io.to(roomId).emit('actionLogUpdated', room.actionLog);
    io.to(roomId).emit('redoLogUpdated', room.redoLog);
    console.log(`🎮 [gameAction] Oyun durumu güncellendi: ${roomId} (${action.type})`);
  });

  // Geri alma (Undo)
  socket.on('undoAction', ({ roomId }) => {
    if (rooms[roomId] && rooms[roomId].actionLog.length > 0) {
      const lastAction = rooms[roomId].actionLog.pop();
      
      // Action'ı redo log'a ekle
      rooms[roomId].redoLog.push(lastAction);
      
      // Önceki durumu geri yükle
      if (lastAction.previousState) {
        rooms[roomId].gameState = lastAction.previousState;
        
        io.to(roomId).emit('gameStateUpdated', rooms[roomId].gameState);
        io.to(roomId).emit('actionLogUpdated', rooms[roomId].actionLog);
        io.to(roomId).emit('redoLogUpdated', rooms[roomId].redoLog);
        
        console.log(`↩️ İşlem geri alındı: ${lastAction.description}`);
      }
    }
  });

  // İleri alma (Redo)
  socket.on('redoAction', ({ roomId }) => {
    if (rooms[roomId] && rooms[roomId].redoLog.length > 0) {
      const lastRedo = rooms[roomId].redoLog.pop();
      
      // Redo'yu tekrar action log'a ekle
      rooms[roomId].actionLog.push(lastRedo);
      
      // Redo state'ini uygula
      if (lastRedo.data && lastRedo.data.newState) {
        rooms[roomId].gameState = lastRedo.data.newState;
      }
      
      io.to(roomId).emit('gameStateUpdated', rooms[roomId].gameState);
      io.to(roomId).emit('actionLogUpdated', rooms[roomId].actionLog);
      io.to(roomId).emit('redoLogUpdated', rooms[roomId].redoLog);
      
      console.log(`↪️ İşlem ileri alındı: ${lastRedo.description}`);
    }
  });

  // İşlem onayı isteme
socket.on('requestApproval', ({ roomId, action, approvalId }) => {
  // Frontend'den gelen approvalId'yi kullan (callback eşleştirmesi için)
  
    pendingActions[approvalId] = {
      ...action,
      approvals: [],
      rejections: [],
      requester: socket.id,
      requesterName: socket.playerName,
      roomId: roomId,
      createdAt: Date.now()
    };

    io.to(roomId).emit('approvalRequest', {
      approvalId,
      action: pendingActions[approvalId]
    });

    console.log(`📋 Onay isteği: ${action.type} - ${action.description} (${approvalId})`);
  });

  // Onay/Red
  socket.on('approveAction', ({ approvalId, approve, voterName }) => {
    const action = pendingActions[approvalId];
    if (!action) {
      socket.emit('error', { message: 'İşlem bulunamadı' });
      return;
    }

    const alreadyVoted = action.approvals.includes(socket.id) || action.rejections.includes(socket.id);
    if (alreadyVoted) {
      return;
    }

    if (approve) {
      action.approvals.push(socket.id);
      console.log(`✅ ${voterName} onayladı: ${approvalId}`);
    } else {
      action.rejections.push(socket.id);
      console.log(`❌ ${voterName} reddetti: ${approvalId}`);
    }

    if (action.approvals.length >= 1) {
      io.to(action.roomId).emit('actionApproved', {
        approvalId,
        action
      });
      console.log(`🎉 İşlem onaylandı: ${action.type}`);
      delete pendingActions[approvalId];
    } 
    else if (action.rejections.length >= 2) {
      io.to(action.roomId).emit('actionRejected', {
        approvalId,
        action
      });
      console.log(`🚫 İşlem reddedildi: ${action.type}`);
      delete pendingActions[approvalId];
    }
    else {
      io.to(action.roomId).emit('approvalUpdated', {
        approvalId,
        approvals: action.approvals.length,
        rejections: action.rejections.length
      });
    }
  });

  // Takas teklifi gönder
  socket.on('sendTradeOffer', ({ roomId, tradeOffer, toPlayerName }) => {
    if (!rooms[roomId]) {
      socket.emit('error', { message: 'Masa bulunamadı' });
      return;
    }

    // Karşı oyuncunun socket ID'sini player name ile bul
    const toPlayer = rooms[roomId].players.find(p => p.name === toPlayerName);
    if (!toPlayer) {
      console.log('Oyuncu bulunamadı:', toPlayerName, 'Mevcut oyuncular:', rooms[roomId].players.map(p => p.name));
      socket.emit('error', { message: 'Oyuncu bulunamadı' });
      return;
    }

    // Takas teklifini karşı tarafa gönder - socket.id kullan
    io.to(toPlayer.id).emit('tradeOfferReceived', { tradeOffer });
    
    console.log(`🔄 Takas teklifi: ${tradeOffer.fromPlayerName} → ${tradeOffer.toPlayerName}`);
  });

  // Takas kabul et
  socket.on('acceptTrade', ({ roomId, tradeOffer }) => {
    if (!rooms[roomId]) {
      socket.emit('error', { message: 'Masa bulunamadı' });
      return;
    }

    // Her iki oyuncuya da takas kabul edildi bildirimi gönder
    const tradeData = {
      player1Id: tradeOffer.fromPlayerId,
      player2Id: tradeOffer.toPlayerId,
      player1Gives: tradeOffer.player1Gives,
      player2Gives: tradeOffer.player2Gives
    };
    
    io.to(roomId).emit('tradeAccepted', { tradeData });
    
    console.log(`✅ Takas kabul edildi: ${tradeOffer.fromPlayerName} ↔ ${tradeOffer.toPlayerName}`);
  });

  // Takas reddet
  socket.on('rejectTrade', ({ roomId, tradeOffer }) => {
    if (!rooms[roomId]) {
      socket.emit('error', { message: 'Masa bulunamadı' });
      return;
    }

    // Takas teklifini yapan kişiye red bildirimi gönder
    const fromPlayer = rooms[roomId].players.find(p => p.id === tradeOffer.fromPlayerId);
    if (fromPlayer) {
      io.to(fromPlayer.id).emit('tradeRejected', { 
        fromPlayerName: tradeOffer.toPlayerName 
      });
    }
    
    console.log(`❌ Takas reddedildi: ${tradeOffer.fromPlayerName} → ${tradeOffer.toPlayerName}`);
  });


  // Ping - Online status heartbeat
  socket.on('ping', ({ roomId }) => {
    if (rooms[roomId]) {
      // Update lastSeen for this player
      const player = rooms[roomId].players.find(p => p.name === socket.playerName)
      if (player) {
        player.lastSeen = Date.now()
      }
      
      // Calculate online statuses (last seen < 10 seconds = online)
      const now = Date.now()
      const playerStatuses = {}
      rooms[roomId].players.forEach(p => {
        playerStatuses[p.name] = (now - (p.lastSeen || p.joinedAt)) < 10000
      })
      
      // Broadcast status to all players in room
      // Emit status for each player separately
      Object.entries(playerStatuses).forEach(([name, online]) => {
        io.to(roomId).emit('statusUpdate', { playerName: name, online })
      })
    }
  });

  // Disconnect handler - Room persistence with reconnection support
  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      const playerName = socket.playerName;

      // Find player and mark as offline instead of removing
      const player = rooms[roomId].players.find(p => p.id === socket.id);
      if (player) {
        player.online = false;
        player.disconnectedAt = Date.now();
        player.oldSocketId = socket.id;
        console.log(`Disconnected: ${playerName} (${roomId}) - marked offline`);
      }

      // Broadcast offline status
      io.to(roomId).emit('statusUpdate', {
        playerName: playerName,
        online: false
      });

      // Log room status
      const onlineCount = rooms[roomId].players.filter(p => p.online !== false).length;
      console.log(`Room status: ${roomId} (${rooms[roomId].players.length} total, ${onlineCount} online)`);

      // Rooms are now persistent - never delete on disconnect
      // Players can reconnect later and resume their game
    }
  });
});

function generateRoomId() {
  let id;
  do {
    id = Math.random().toString(36).substring(2, 8).toUpperCase();
  } while (rooms[id]);
  return id;
}

// Operation Queue System - İşlemleri sırayla çalıştır
function enqueueOperation(roomId, operation) {
  if (!operationQueues[roomId]) {
    operationQueues[roomId] = {
      queue: [],
      processing: false
    };
  }

  return new Promise((resolve, reject) => {
    operationQueues[roomId].queue.push({
      operation,
      resolve,
      reject
    });
    processNextOperation(roomId);
  });
}

async function processNextOperation(roomId) {
  const q = operationQueues[roomId];
  if (!q || q.processing || q.queue.length === 0) return;

  q.processing = true;
  const { operation, resolve, reject } = q.queue.shift();

  try {
    const result = await operation();
    resolve(result);
  } catch (error) {
    reject(error);
  } finally {
    q.processing = false;
    // Sonraki işlemi başlat
    setImmediate(() => processNextOperation(roomId));
  }
}

// Periodic cleanup - Remove only truly empty rooms after 7 days
setInterval(() => {
  const now = Date.now();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;  // 7 days instead of 1
  
  Object.keys(rooms).forEach(roomId => {
    const room = rooms[roomId];
    
    // Only delete if:
    // 1. No players at all (never joined or all deleted manually)
    // 2. Room is older than 7 days
    if (room.players.length === 0 && (now - room.createdAt) > sevenDaysMs) {
      delete rooms[roomId];
      delete operationQueues[roomId];  // Clean up queue too
      console.log('Cleaned up empty room:', roomId, '(created', Math.floor((now - room.createdAt) / (24*60*60*1000)), 'days ago)');
    }
  });
}, 60 * 60 * 1000);  // Check every hour

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`🚀 Monopoly Backend çalışıyor: http://localhost:${PORT}`);
  console.log(`📡 Socket.io hazır`);
});