// Spellbound Chess server.
//   node server/index.js            -> LAN play on http://<your-ip>:3000
//   node server/index.js --tunnel   -> also opens a public internet link via Cloudflare quick tunnel
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const express = require('express');
const { Server } = require('socket.io');
const { Room } = require('./room');
const { users } = require('./users');
const keepAwake = require('./keepAwake');

const PORT = Number(process.env.PORT) || 3000;
const app = express();
app.use(express.json());
const soundsDir = path.join(__dirname, '..', 'public', 'sounds');

app.get('/api/sounds', (_req, res) => {
  try {
    const files = fs
      .readdirSync(soundsDir)
      .filter((f) => /\.(mp3|wav|ogg)$/i.test(f));
    res.json({ files });
  } catch {
    res.json({ files: [] });
  }
});

app.use(express.static(path.join(__dirname, '..', 'public')));
const server = http.createServer(app);
const io = new Server(server);

const rooms = new Map();
const quickMatchQueue = []; // [{ socket, token, name, cardInterval, rarityWeights }]
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion
function genCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function removeFromQueue(socket, token) {
  for (let i = quickMatchQueue.length - 1; i >= 0; i--) {
    if (quickMatchQueue[i].socket === socket || (token && quickMatchQueue[i].token === token) || !quickMatchQueue[i].socket.connected) {
      quickMatchQueue.splice(i, 1);
    }
  }
}

io.on('connection', (socket) => {
  const room = () => socket.data.room;
  const color = () => socket.data.color;

  // ---------- User Authentication ----------
  socket.on('auth:register', ({ username, password } = {}, cb) => {
    const res = users.register(username, password);
    if (res.error) {
      if (typeof cb === 'function') cb({ success: false, error: res.error });
      return;
    }
    socket.data.user = res.user;
    if (typeof cb === 'function') cb({ success: true, token: res.token, user: res.user });
  });

  socket.on('auth:login', ({ username, password } = {}, cb) => {
    const res = users.login(username, password);
    if (res.error) {
      if (typeof cb === 'function') cb({ success: false, error: res.error });
      return;
    }
    socket.data.user = res.user;
    if (typeof cb === 'function') cb({ success: true, token: res.token, user: res.user });
  });

  socket.on('auth:verifyToken', ({ authToken } = {}, cb) => {
    const user = users.getUserByToken(authToken);
    if (!user) {
      if (typeof cb === 'function') cb({ success: false, invalid: true });
      return;
    }
    socket.data.user = user;
    if (typeof cb === 'function') cb({ success: true, user });
  });

  socket.on('auth:logout', ({ authToken } = {}, cb) => {
    users.logout(authToken);
    socket.data.user = null;
    if (typeof cb === 'function') cb({ success: true });
  });

  // ---------- Shop & Skill Cards ----------
  socket.on('shop:getCatalog', (cb) => {
    let freshUser = null;
    if (socket.data.user) {
      const u = users.getUserById(socket.data.user.id);
      freshUser = u ? users.publicProfile(u) : socket.data.user;
      socket.data.user = freshUser;
    }
    if (typeof cb === 'function') cb({ catalog: users.getShopCatalog(), user: freshUser });
  });

  socket.on('shop:buySkill', ({ skillId } = {}, cb) => {
    if (!socket.data.user) {
      if (typeof cb === 'function') cb({ error: 'Please log in to purchase skill cards.' });
      return;
    }
    const res = users.buySkill(socket.data.user.id, skillId);
    if (res.user) {
      socket.data.user = res.user;
      if (room()) {
        const c = color();
        if (c && room().seats[c]) {
          room().seats[c].user = res.user;
          room().broadcast();
        }
      }
    }
    if (typeof cb === 'function') cb(res);
  });

  socket.on('shop:equipSkill', ({ skillId } = {}, cb) => {
    if (!socket.data.user) {
      if (typeof cb === 'function') cb({ error: 'Please log in to equip skill cards.' });
      return;
    }
    const res = users.equipSkill(socket.data.user.id, skillId);
    if (res.user) {
      socket.data.user = res.user;
      if (room()) {
        const c = color();
        if (c && room().seats[c]) {
          room().seats[c].user = res.user;
          room().broadcast();
        }
      }
    }
    if (typeof cb === 'function') cb(res);
  });

  // ---------- Matchmaking & Room Management ----------
  socket.on('create', ({ name, token, cardInterval, rarityWeights, authToken } = {}) => {
    if (authToken && !socket.data.user) {
      const u = users.getUserByToken(authToken);
      if (u) socket.data.user = u;
    }
    const user = socket.data.user || null;
    const playerName = user ? user.username : (name || 'Player');

    removeFromQueue(socket, token);
    if (room()) room().leave(socket);
    const code = genCode();
    const r = new Room(code, (c) => rooms.delete(c), cardInterval, rarityWeights);
    rooms.set(code, r);
    r.join(socket, String(token || socket.id), playerName, user);
    console.log(`[room ${code}] created by ${playerName} (cards every ${r.cardIntervalTurns} turns)`);
  });

  socket.on('quickMatch', ({ name, token, cardInterval, rarityWeights, authToken } = {}) => {
    if (authToken && !socket.data.user) {
      const u = users.getUserByToken(authToken);
      if (u) socket.data.user = u;
    }
    const user = socket.data.user || null;
    const playerName = user ? user.username : (name || 'Player');
    const tk = String(token || socket.id);

    removeFromQueue(socket, tk);
    if (room()) {
      room().leave(socket);
      socket.data.room = null;
    }
    // Find a waiting player in the queue
    while (quickMatchQueue.length > 0) {
      const oppEntry = quickMatchQueue.shift();
      if (oppEntry.socket && oppEntry.socket.connected && oppEntry.token !== tk) {
        const code = genCode();
        const r = new Room(code, (c) => rooms.delete(c), oppEntry.cardInterval, oppEntry.rarityWeights);
        rooms.set(code, r);
        r.join(oppEntry.socket, oppEntry.token, oppEntry.name, oppEntry.user);
        r.join(socket, tk, playerName, user);
        oppEntry.socket.emit('quickMatchStatus', { waiting: false, matched: true });
        socket.emit('quickMatchStatus', { waiting: false, matched: true });
        console.log(`[quickmatch ${code}] ${oppEntry.name} vs ${playerName}`);
        return;
      }
    }
    quickMatchQueue.push({ socket, token: tk, name: playerName, user, cardInterval, rarityWeights });
    socket.emit('quickMatchStatus', { waiting: true });
    console.log(`[quickmatch] ${playerName} is searching for an opponent...`);
  });

  socket.on('cancelQuickMatch', () => {
    removeFromQueue(socket);
    socket.emit('quickMatchStatus', { waiting: false });
  });

  socket.on('join', ({ code, name, token, authToken } = {}) => {
    if (authToken && !socket.data.user) {
      const u = users.getUserByToken(authToken);
      if (u) socket.data.user = u;
    }
    const user = socket.data.user || null;
    const playerName = user ? user.username : (name || 'Player');

    removeFromQueue(socket, token);
    code = String(code || '').trim().toUpperCase();
    const r = rooms.get(code);
    if (!r) return socket.emit('errorMsg', `Room "${code}" was not found.`);
    if (room() && room() !== r) room().leave(socket);
    const res = r.join(socket, String(token || socket.id), playerName, user);
    if (res.error) socket.emit('errorMsg', res.error);
  });

  socket.on('move', (d) => room() && room().move(color(), d || {}));
  socket.on('useSkill', (params, cb) => {
    if (typeof params === 'function') {
      cb = params;
      params = {};
    }
    if (!room()) {
      if (typeof cb === 'function') cb({ error: 'Not in a game.' });
      return;
    }
    const res = room().useSkill(color(), params || {});
    if (typeof cb === 'function') cb(res || { success: true });
  });
  socket.on('pickCard', (i) => room() && room().pickCard(color(), i));
  socket.on('skipToCards', () => room() && room().skipToCards(color()));
  socket.on('testCard', (id) => room() && room().testCard(color(), id));
  socket.on('forceLastKing', () => room() && room().forceLastKing(color()));
  socket.on('resign', () => room() && room().resign(color()));
  socket.on('offerDraw', () => room() && room().offerDraw(color()));
  socket.on('respondDraw', (a) => room() && room().respondDraw(color(), !!a));
  socket.on('rematch', () => room() && room().requestRematch(color()));
  socket.on('claimWin', () => room() && room().claimWin(color()));
  socket.on('chat', (t) => room() && room().sendChat(color(), t));
  socket.on('leaveRoom', () => {
    removeFromQueue(socket);
    if (room()) room().leave(socket);
    socket.data.room = null;
  });
  socket.on('disconnect', () => {
    removeFromQueue(socket);
    if (room()) room().leave(socket);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log('\n  ♞  SPELLBOUND CHESS server is running');
  console.log(`     This PC:        http://localhost:${PORT}`);
  ips.forEach((ip) => console.log(`     Same Wi-Fi/LAN: http://${ip}:${PORT}`));
  keepAwake.start();
  if (process.argv.includes('--tunnel')) require('./tunnel').start(PORT);
  else console.log('     (Run start-online.bat to get a public internet link)\n');
  console.log('  Close this window to stop the server.\n');
});
