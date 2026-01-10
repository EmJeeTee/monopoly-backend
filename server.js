const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
require('dotenv').config();

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

// Test endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'Monopoly Backend Running!', 
    rooms: Object.keys(rooms).length,
    activeConnections: io.engine.clientsCount 
  });
});

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

  // Masaya katılma
  socket.on('joinRoom', ({ roomId, playerName }) => {
    if (!rooms[roomId]) {
      socket.emit('error', { message: 'Masa bulunamadı' });
      return;
    }

    // Aynı isimde oyuncu varsa güncelle (reconnect durumu)
    const existingPlayer = rooms[roomId].players.find(p => p.name === playerName);
    if (existingPlayer) {
      console.log(`🔄 ${playerName} yeniden bağlanıyor (eski: ${existingPlayer.id}, yeni: ${socket.id})`);
      existingPlayer.id = socket.id; // Socket ID'yi güncelle
      existingPlayer.joinedAt = Date.now(); // Son katılma zamanını güncelle
    // Önce room'a join ol (playerJoined event'ini alabilmesi için)
    socket.join(roomId);
    socket.roomId = roomId;
    socket.playerName = playerName;

    // Önce room'a join ol (playerJoined event'ini alabilmesi için)
    socket.join(roomId);
    socket.roomId = roomId;
    socket.playerName = playerName;


    } else {
      // Yeni oyuncu ekle
      const player = {
        id: socket.id,
        name: playerName,
        joinedAt: Date.now()
      };
      rooms[roomId].players.push(player);
      
      io.to(roomId).emit('playerJoined', {
        player,
        players: rooms[roomId].players
      });
      console.log(`👤 ${playerName} masaya katıldı: ${roomId} (${rooms[roomId].players.length} oyuncu)`);
      
      // Game state'e de ekle (otomatik)
      const gameState = rooms[roomId].gameState;
      const gamePlayerExists = Object.values(gameState.players || {}).some(p => p.name === playerName);
      
      if (!gamePlayerExists) {
        const newPlayerId = gameState.nextId || 1;
        const newGamePlayer = {
          id: newPlayerId,
          name: playerName,
          position: 'top',
          money: {
            5000000: 2,  // 2x 5M
            1000000: 4,  // 4x 1M
            500000: 1,   // 1x 500K
            200000: 1,   // 1x 200K
            100000: 2,   // 2x 100K
            50000: 1,    // 1x 50K
            10000: 5     // 5x 10K
          },
          properties: []
        };
        
        gameState.players = gameState.players || {};
        gameState.players[newPlayerId] = newGamePlayer;
        gameState.nextId = newPlayerId + 1;
        
        console.log(`🎮 ${playerName} oyuna eklendi (ID: ${newPlayerId})`);
        io.to(roomId).emit('gameStateUpdated', gameState);
      }
    }


    // Mevcut oyun durumunu gönder
    socket.emit('gameStateUpdated', rooms[roomId].gameState);
    socket.emit('actionLogUpdated', rooms[roomId].actionLog);
    socket.emit('redoLogUpdated', rooms[roomId].redoLog);
  });

  // Oyun durumu güncelleme
  socket.on('updateGameState', ({ roomId, gameState, action }) => {
    if (rooms[roomId]) {
      rooms[roomId].gameState = gameState;
      
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
            newState: gameState // Redo için yeni state'i kaydet
          },
          previousState: action.previousState
        };
        rooms[roomId].actionLog.push(logEntry);
        
        // Yeni action yapıldığında redo log'u temizle
        rooms[roomId].redoLog = [];
        
        io.to(roomId).emit('actionLogUpdated', rooms[roomId].actionLog);
        io.to(roomId).emit('redoLogUpdated', rooms[roomId].redoLog);
      }
      
      socket.to(roomId).emit('gameStateUpdated', gameState);
      console.log(`🎮 Oyun durumu güncellendi: ${roomId}`);
    }
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
  socket.on('requestApproval', ({ roomId, action }) => {
    const approvalId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
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
  })
    // Bağlantı kopunca
  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      const playerName = socket.playerName;
      rooms[roomId].players = rooms[roomId].players.filter(p => p.id !== socket.id);
      
      io.to(roomId).emit('playerLeft', {
        playerId: socket.id,
        playerName: playerName,
        players: rooms[roomId].players
      });
      
      console.log(`👋 ${playerName || socket.id} masadan ayrıldı: ${roomId} (${rooms[roomId].players.length} oyuncu)`);
      
      if (rooms[roomId].players.length === 0) {
        delete rooms[roomId];
        console.log(`��️  Masa silindi: ${roomId}`);
      }
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

setInterval(() => {
  const now = Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;
  
  Object.keys(rooms).forEach(roomId => {
    const room = rooms[roomId];
    if (room.players.length === 0 && (now - room.createdAt) > oneDayMs) {
      delete rooms[roomId];
      console.log(`🧹 Eski masa temizlendi: ${roomId}`);
    }
  });
}, 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`🚀 Monopoly Backend çalışıyor: http://localhost:${PORT}`);
  console.log(`📡 Socket.io hazır`);
});
