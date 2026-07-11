// Raising Havok — serves the club site at / and Mad Ork Lands at /play,
// plus the game API and socket.io multiplayer.
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const db = require('./db');
const parts = require('./parts');
const { rateLimit, verifyCaptcha, RECAPTCHA_SITE_KEY } = require('./security');
const { Match } = require('./game');

const PORT = process.env.PORT || 3040;
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.set('trust proxy', 1); // Azure front end — req.ip = real client IP for rate limiting
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- REST API ----
app.get('/api/parts', (req, res) => {
  res.json({ budget: parts.BUDGET, hulls: parts.HULLS, weapons: parts.WEAPONS, upgrades: parts.UPGRADES });
});

app.get('/api/config', (req, res) => {
  res.json({
    recaptchaSiteKey: RECAPTCHA_SITE_KEY || null,
    discordEnabled: !!process.env.DISCORD_CLIENT_ID,
  });
});

// ---- Discord SSO ----
// Config-gated: activates when DISCORD_CLIENT_ID/SECRET app settings are set
// (same Discord application as the Blood Bowl bot). Flow: /api/auth/discord
// redirects to Discord -> callback exchanges the code, upserts the account,
// and hands the session token to the client in the URL fragment (fragments
// never reach servers or logs).
const ssoStates = new Map(); // state -> { exp, ret }, CSRF protection + return target
const SSO_RETURNS = ['/play/', '/league/', '/'];

app.get('/api/auth/discord', (req, res) => {
  if (!process.env.DISCORD_CLIENT_ID) return res.status(404).send('Discord SSO not configured');
  const state = require('crypto').randomBytes(16).toString('hex');
  const ret = SSO_RETURNS.includes(req.query.return) ? req.query.return : '/play/';
  ssoStates.set(state, { exp: Date.now() + 10 * 60 * 1000, ret });
  for (const [s, v] of ssoStates) if (v.exp < Date.now()) ssoStates.delete(s);
  const redirectUri = `${req.protocol}://${req.get('host')}/api/auth/discord/callback`;
  res.redirect('https://discord.com/oauth2/authorize?' + new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    response_type: 'code',
    scope: 'identify guilds', // guilds: verify club-server membership
    redirect_uri: redirectUri,
    state,
  }));
});

app.get('/api/auth/discord/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const known = ssoStates.get(String(state));
  const ret = known ? known.ret : '/play/';
  if (error) return res.redirect(ret + '#ssoerr=' + encodeURIComponent(String(error)));
  if (!code || !known) {
    return res.redirect(ret + '#ssoerr=bad_state');
  }
  ssoStates.delete(String(state));
  try {
    const redirectUri = `${req.protocol}://${req.get('host')}/api/auth/discord/callback`;
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET || '',
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: redirectUri,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error(tokenData.error_description || 'token exchange failed');
    const meRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: 'Bearer ' + tokenData.access_token },
    });
    const me = await meRes.json();
    if (!me.id) throw new Error('could not fetch Discord profile');

    // Membership gate: only members of the club's Discord server get in.
    if (process.env.DISCORD_GUILD_ID) {
      const guildsRes = await fetch('https://discord.com/api/users/@me/guilds', {
        headers: { Authorization: 'Bearer ' + tokenData.access_token },
      });
      const guilds = await guildsRes.json();
      const isMember = Array.isArray(guilds)
        && guilds.some(g => g.id === process.env.DISCORD_GUILD_ID);
      if (!isMember) {
        return res.redirect(ret + '#ssoerr=' + encodeURIComponent(
          'Members only — dis Discord ain\'t in da Raising Havok server.'));
      }
    }
    const user = db.upsertDiscordUser(me);
    const token = db.issueToken(user.name);
    res.redirect(ret + '#sso=' + token);
  } catch (e) {
    console.error('discord sso:', e.message);
    res.redirect(ret + '#ssoerr=' + encodeURIComponent('Discord login failed, try again'));
  }
});

app.post('/api/register', rateLimit('register', 5, 3600), async (req, res) => {
  const { name, password, captcha, email } = req.body || {};
  // honeypot: real users never see the "email" field; bots autofill it
  if (email) return res.status(400).json({ error: 'Nice try, bot.' });
  if (!await verifyCaptcha(captcha, req.ip)) {
    return res.status(400).json({ error: "Captcha says you'z a grot. Try again." });
  }
  const result = await db.createUser(name, password);
  if (result.error) return res.status(400).json({ error: result.error });
  const token = db.issueToken(result.user.name);
  res.json({ token, name: result.user.name, stats: result.user.stats, garage: result.user.garage });
});

app.post('/api/login', rateLimit('login', 10, 600), async (req, res) => {
  const { name, password } = req.body || {};
  const user = await db.checkLogin(name, password);
  if (!user) return res.status(401).json({ error: 'Wrong name or password, git.' });
  const token = db.issueToken(user.name);
  res.json({ token, name: user.name, stats: user.stats, garage: user.garage });
});

app.post('/api/logout', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (token) db.revokeToken(token);
  res.json({ ok: true });
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

// ---- League tracker API ----
const league = require('./league');

// Reads are members-only: any logged-in account, or the bot's shared key.
// (League data lists club members by name — not for the public internet.)
function memberReader(req, res, next) {
  if (authed(req)) return next();
  const key = req.headers['x-league-key'];
  if (process.env.LEAGUE_API_KEY && key === process.env.LEAGUE_API_KEY) return next();
  res.status(401).json({ error: 'Members only — log in to see da league.' });
}

app.get('/api/leaderboard', memberReader, (req, res) => res.json(db.leaderboard()));

// Writers must be logged-in users, or the Discord bot presenting the shared
// LEAGUE_API_KEY (so match results posted in Discord flow straight in).
function leagueWriter(req, res, next) {
  const user = authed(req);
  if (user) {
    // League identity is club Discord identity — password/guest accounts can
    // play the game but league actions need a Discord-linked account.
    if (!user.discordId && process.env.DISCORD_CLIENT_ID) {
      return res.status(403).json({ error: 'League actions need a Discord login — use "Log in wiv Discord".' });
    }
    req.reporter = user.name;
    return next();
  }
  const key = req.headers['x-league-key'];
  if (process.env.LEAGUE_API_KEY && key === process.env.LEAGUE_API_KEY) {
    req.reporter = String(req.body.reportedBy || 'discord').slice(0, 40);
    return next();
  }
  res.status(401).json({ error: 'log in first' });
}

// Admins (comma-separated ADMIN_USERS app setting) may delete/edit.
function isAdmin(name) {
  return (process.env.ADMIN_USERS || '').toLowerCase().split(',').map(s => s.trim())
    .includes((name || '').toLowerCase());
}

app.get('/api/league', memberReader, (req, res) => {
  res.json(Object.values(db.leagues()).map(league.summary));
});

app.get('/api/games', (req, res) => {
  res.json(Object.entries(league.GAME_STATS).map(([id, g]) => ({ id, name: g.name })));
});

app.get('/api/league/:id', memberReader, (req, res) => {
  const l = db.leagues()[req.params.id];
  if (!l) return res.status(404).json({ error: 'no such league' });
  res.json(league.full(l));
});

app.post('/api/league', leagueWriter, (req, res) => {
  const { name, game, season } = req.body || {};
  if (!name || String(name).trim().length < 2) return res.status(400).json({ error: 'league needs a name' });
  const l = league.makeLeague({ name: String(name).trim(), game, season });
  db.leagues()[l.id] = l;
  db.saveLeagues();
  res.json(league.summary(l));
});

app.post('/api/league/:id/team', leagueWriter, (req, res) => {
  const l = db.leagues()[req.params.id];
  if (!l) return res.status(404).json({ error: 'no such league' });
  const { name, coach, race, rosterText } = req.body || {};
  if (!name || String(name).trim().length < 2) return res.status(400).json({ error: 'team needs a name' });
  if (Object.keys(l.teams).length >= 30) return res.status(400).json({ error: 'league is full' });
  const t = league.makeTeam({ name: String(name).trim(), coach: coach || req.reporter, race, rosterText });
  l.teams[t.id] = t;
  db.saveLeagues();
  res.json(t);
});

app.put('/api/league/:id/team/:tid', leagueWriter, (req, res) => {
  const l = db.leagues()[req.params.id];
  const t = l && l.teams[req.params.tid];
  if (!t) return res.status(404).json({ error: 'no such team' });
  // coaches may edit their own team; admins may edit any
  if (t.coach.toLowerCase() !== req.reporter.toLowerCase() && !isAdmin(req.reporter)) {
    return res.status(403).json({ error: 'not your team (admins can edit any)' });
  }
  const { name, race, rosterText } = req.body || {};
  if (name && String(name).trim().length >= 2) t.name = String(name).trim().slice(0, 60);
  if (race !== undefined) t.race = String(race).slice(0, 40);
  if (rosterText !== undefined) {
    t.rosterText = String(rosterText).slice(0, 8000);
    t.roster = league.parseRoster(t.rosterText);
  }
  db.saveLeagues();
  res.json(t);
});

app.post('/api/league/:id/match', leagueWriter, (req, res) => {
  const l = db.leagues()[req.params.id];
  if (!l) return res.status(404).json({ error: 'no such league' });
  if (l.matches.length >= 500) return res.status(400).json({ error: 'match limit reached' });
  const result = league.makeMatch(l, { ...req.body, reportedBy: req.reporter });
  if (result.error) return res.status(400).json({ error: result.error });
  l.matches.push(result.match);
  db.saveLeagues();
  res.json(result.match);
});

app.delete('/api/league/:id/match/:mid', leagueWriter, (req, res) => {
  const l = db.leagues()[req.params.id];
  if (!l) return res.status(404).json({ error: 'no such league' });
  const m = l.matches.find(x => x.id === req.params.mid);
  if (!m) return res.status(404).json({ error: 'no such match' });
  if (m.reportedBy.toLowerCase() !== req.reporter.toLowerCase() && !isAdmin(req.reporter)) {
    return res.status(403).json({ error: 'only the reporter or an admin can delete' });
  }
  l.matches = l.matches.filter(x => x.id !== req.params.mid);
  db.saveLeagues();
  res.json({ ok: true });
});

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
