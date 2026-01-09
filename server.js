const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
require('dotenv').config();

const app = express();
const httpServer = createServer(app);

// CORS ayarları
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true
}));
app.use(express.json());

// Socket.io kurulumu
const io = new Server(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true,
    methods: ['GET', 'POST']
  }
});

// In-memory storage (başlangıç için)
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
    gameState: null,
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

// Socket bağlantıları
io.on('connection', (socket) => {
  console.log('🔌 Yeni bağlantı:', socket.id);

  // Masaya katılma
  socket.on('joinRoom', ({ roomId, playerName }) => {
    if (!rooms[roomId]) {
      socket.emit('error', { message: 'Masa bulunamadı' });
      return;
    }

    // Aynı isimde oyuncu var mı kontrol et
    const existingPlayer = rooms[roomId].players.find(p => p.name === playerName);
    if (existingPlayer) {
      socket.emit('error', { message: 'Bu isimde bir oyuncu zaten var' });
      return;
    }

    const player = {
      id: socket.id,
      name: playerName,
      joinedAt: Date.now()
    };

    rooms[roomId].players.push(player);
    socket.join(roomId);
    socket.roomId = roomId;
    socket.playerName = playerName;

    // Tüm oyunculara yeni katılımı bildir
    io.to(roomId).emit('playerJoined', {
      player,
      players: rooms[roomId].players
    });

    // Mevcut oyun durumunu gönder
    if (rooms[roomId].gameState) {
      socket.emit('gameStateUpdated', rooms[roomId].gameState);
    }

    console.log(`👤 ${playerName} masaya katıldı: ${roomId} (${rooms[roomId].players.length} oyuncu)`);
  });

  // Oyun durumu güncelleme
  socket.on('updateGameState', ({ roomId, gameState }) => {
    if (rooms[roomId]) {
      rooms[roomId].gameState = gameState;
      // Kendisi hariç tüm oyunculara gönder
      socket.to(roomId).emit('gameStateUpdated', gameState);
      console.log(`🎮 Oyun durumu güncellendi: ${roomId}`);
    }
  });

  // İşlem onayı isteme (para ekleme/çıkarma, vb.)
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

    // Tüm oyunculara (kendisi dahil) onay isteğini gönder
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

    // Zaten oy kullanmış mı kontrol et
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

    // En az 1 onay varsa işlemi onayla
    if (action.approvals.length >= 1) {
      io.to(action.roomId).emit('actionApproved', {
        approvalId,
        action
      });
      console.log(`🎉 İşlem onaylandı: ${action.type}`);
      delete pendingActions[approvalId];
    } 
    // 2 veya daha fazla red varsa reddet
    else if (action.rejections.length >= 2) {
      io.to(action.roomId).emit('actionRejected', {
        approvalId,
        action
      });
      console.log(`🚫 İşlem reddedildi: ${action.type}`);
      delete pendingActions[approvalId];
    }
    // Aksi halde beklemede tut ve güncel durumu gönder
    else {
      io.to(action.roomId).emit('approvalUpdated', {
        approvalId,
        approvals: action.approvals.length,
        rejections: action.rejections.length
      });
    }
  });

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
      
      // Masa boşaldıysa sil
      if (rooms[roomId].players.length === 0) {
        delete rooms[roomId];
        console.log(`🗑️  Masa silindi: ${roomId}`);
      }
    }
  });
});

// Yardımcı fonksiyon - Benzersiz masa ID oluştur
function generateRoomId() {
  let id;
  do {
    id = Math.random().toString(36).substring(2, 8).toUpperCase();
  } while (rooms[id]); // ID çakışması varsa yeni üret
  return id;
}

// Temizlik - 24 saatten eski boş masaları sil
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
}, 60 * 60 * 1000); // Her saat kontrol et

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`🚀 Monopoly Backend çalışıyor: http://localhost:${PORT}`);
  console.log(`📡 Socket.io hazır`);
});
