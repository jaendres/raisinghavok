// Raising Havok — serves the club site at / and Mad Ork Lands at /play,
// plus the game API and socket.io multiplayer.
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const db = require('./db');
const parts = require('./parts');
const { Match } = require('./game');

const PORT = process.env.PORT || 3040;
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- REST API ----
app.get('/api/parts', (req, res) => {
  res.json({ budget: parts.BUDGET, hulls: parts.HULLS, weapons: parts.WEAPONS, upgrades: parts.UPGRADES });
});

app.post('/api/register', (req, res) => {
  const { name, password } = req.body || {};
  const result = db.createUser(name, password);
  if (result.error) return res.status(400).json({ error: result.error });
  const token = db.issueToken(result.user.name);
  res.json({ token, name: result.user.name, stats: result.user.stats, garage: result.user.garage });
});

app.post('/api/login', (req, res) => {
  const { name, password } = req.body || {};
  const user = db.checkLogin(name, password);
  if (!user) return res.status(401).json({ error: 'Wrong name or password, git.' });
  const token = db.issueToken(user.name);
  res.json({ token, name: user.name, stats: user.stats, garage: user.garage });
});

function authed(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  return db.userByToken(token);
}

app.get('/api/me', (req, res) => {
  const user = authed(req);
  if (!user) return res.status(401).json({ error: 'not logged in' });
  res.json({ name: user.name, stats: user.stats, garage: user.garage });
});

app.post('/api/garage', (req, res) => {
  const user = authed(req);
  if (!user) return res.status(401).json({ error: 'not logged in' });
  const builds = Array.isArray(req.body.builds) ? req.body.builds : [];
  for (const b of builds) {
    const v = parts.validateBuild(b);
    if (!v.ok) return res.status(400).json({ error: v.error });
    if (typeof b.name !== 'string' || b.name.length > 24) b.name = 'Unnamed Rig';
  }
  db.saveGarage(user.name, builds);
  res.json({ ok: true });
});

app.get('/api/leaderboard', (req, res) => res.json(db.leaderboard()));

// ---- Multiplayer lobby ----
// One global queue: countdown starts when the first player joins, match
// launches with humans + bots filling to MATCH_SIZE.
let queue = [];            // { socket, id, name, userName, build }
let countdown = null;
let countdownLeft = 0;
let matchCounter = 0;
const matches = new Map(); // socketId -> match

function queueState() {
  return { players: queue.map(q => q.name), countdown: countdown ? Math.ceil(countdownLeft) : null };
}
function broadcastQueue() { io.emit('queue', queueState()); }

function startCountdown() {
  if (countdown) return;
  countdownLeft = 6;
  countdown = setInterval(() => {
    countdownLeft--;
    broadcastQueue();
    if (countdownLeft <= 0) { clearInterval(countdown); countdown = null; launchMatch(); }
  }, 1000);
  broadcastQueue();
}

function launchMatch() {
  if (queue.length === 0) return;
  const entrants = queue.splice(0, 6);
  const roomId = 'match-' + (++matchCounter);
  for (const e of entrants) e.socket.join(roomId);
  const match = new Match(io, roomId, entrants, (m, results) => {
    // record stats for logged-in humans
    for (const r of m.rigs.values()) {
      if (r.isBot || !r.userName) continue;
      const place = results.find(x => x.name === r.name);
      db.recordStats(r.userName, {
        games: 1, wins: place && place.place === 1 ? 1 : 0,
        kills: r.kills, deaths: r.alive ? 0 : 1, damage: Math.round(r.damage),
      });
    }
    for (const e of entrants) { e.socket.leave(roomId); matches.delete(e.socket.id); }
  });
  for (const e of entrants) matches.set(e.socket.id, { match, rigId: e.id });
  io.to(roomId).emit('matchStart', { arena: 2400, obstacles: match.obstacles });
  for (const e of entrants) e.socket.emit('youAre', { id: e.id });
  broadcastQueue();
}

io.on('connection', (socket) => {
  let identity = null; // { name, userName|null }

  socket.on('hello', ({ token, guestName }, cb) => {
    const user = token ? db.userByToken(token) : null;
    if (user) identity = { name: user.name, userName: user.name };
    else {
      const name = String(guestName || 'Git').replace(/[^\w\- ]/g, '').slice(0, 16) || 'Git';
      identity = { name: name + ' (guest)', userName: null };
    }
    cb && cb({ ok: true, name: identity.name });
  });

  socket.on('joinQueue', ({ build }, cb) => {
    if (!identity) return cb && cb({ error: 'say hello first' });
    if (matches.has(socket.id) || queue.some(q => q.socket === socket)) return cb && cb({ error: 'already queued' });
    const v = parts.validateBuild(build);
    if (!v.ok) return cb && cb({ error: v.error });
    queue.push({ socket, id: 'p-' + socket.id, name: identity.name, userName: identity.userName, build });
    cb && cb({ ok: true });
    broadcastQueue();
    startCountdown();
  });

  socket.on('leaveQueue', () => {
    queue = queue.filter(q => q.socket !== socket);
    if (queue.length === 0 && countdown) { clearInterval(countdown); countdown = null; }
    broadcastQueue();
  });

  socket.on('input', (input) => {
    const m = matches.get(socket.id);
    if (m) m.match.setInput(m.rigId, input);
  });

  socket.on('disconnect', () => {
    queue = queue.filter(q => q.socket !== socket);
    if (queue.length === 0 && countdown) { clearInterval(countdown); countdown = null; }
    const m = matches.get(socket.id);
    if (m) { m.match.removePlayer(m.rigId); matches.delete(socket.id); }
    broadcastQueue();
  });
});

server.listen(PORT, () => {
  console.log(`Raising Havok up at http://localhost:${PORT}  (game at /play)`);
});
