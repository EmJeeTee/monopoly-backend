# Monopoly Bank Simulation - Backend

Node.js + Express + Socket.io backend for multiplayer Monopoly bank simulation.

## Özellikler

- 🎲 Multi-room (çoklu masa) sistemi
- 🔗 Link ile masa paylaşımı
- 👥 Real-time multiplayer desteği
- ✅ İşlem onay sistemi (minimum 1 onay gerekli)
- 📱 Mobil uyumlu WebSocket bağlantıları

## Kurulum

```bash
npm install
```

## Çalıştırma

### Development
```bash
npm start
```

### Production (Render.com)
Otomatik olarak `npm start` komutu çalışır.

## Environment Variables

`.env.example` dosyasını `.env` olarak kopyalayın ve değişkenleri ayarlayın:

```bash
PORT=3000
FRONTEND_URL=http://localhost:5173
```

Production'da Render.com üzerinden bu değişkenleri ayarlayın.

## API Endpoints

### POST /api/room/create
Yeni bir oyun masası oluşturur.

**Response:**
```json
{
  "roomId": "ABC123",
  "joinLink": "/room/ABC123"
}
```

### GET /api/room/:roomId
Masa bilgilerini getirir.

**Response:**
```json
{
  "id": "ABC123",
  "playerCount": 3,
  "players": [
    { "name": "Metin", "id": "socket-id-1" }
  ],
  "createdAt": 1234567890
}
```

## Socket.io Events

### Client → Server

- `joinRoom({ roomId, playerName })` - Masaya katıl
- `updateGameState({ roomId, gameState })` - Oyun durumunu güncelle
- `requestApproval({ roomId, action })` - İşlem onayı iste
- `approveAction({ approvalId, approve, voterName })` - İşlemi onayla/reddet

### Server → Client

- `playerJoined({ player, players })` - Oyuncu masaya katıldı
- `playerLeft({ playerId, playerName, players })` - Oyuncu ayrıldı
- `gameStateUpdated(gameState)` - Oyun durumu güncellendi
- `approvalRequest({ approvalId, action })` - Onay talebi geldi
- `actionApproved({ approvalId, action })` - İşlem onaylandı
- `actionRejected({ approvalId, action })` - İşlem reddedildi
- `approvalUpdated({ approvalId, approvals, rejections })` - Onay durumu güncellendi
- `error({ message })` - Hata mesajı

## Deployment

### Render.com

1. GitHub'a push et
2. Render.com'a git ve "New Web Service" oluştur
3. GitHub repo'sunu bağla
4. Ayarları yap:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Environment:** Node
5. Environment variables ekle:
   - `FRONTEND_URL`: `https://mpsimulation.com.tr`
6. Deploy et

## Teknolojiler

- Node.js (>= 18.0.0)
- Express.js
- Socket.io
- CORS

## License

MIT

## Author

EmJeeTee
