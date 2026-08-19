// Tiny JSON-file store. Fine for a club-sized player base; swap for SQLite
// if the Waaagh ever outgrows it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// On Azure App Service, DATA_DIR=/home/data keeps the DB outside wwwroot so
// deployments never wipe accounts/stats.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

let db = { users: {}, tokens: {} };
let saveTimer = null;

function load() {
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  } catch {
    db = { users: {}, tokens: {} };
  }
  if (!db.users) db.users = {};
  if (!db.tokens) db.tokens = {};
  if (!db.leagues) db.leagues = {};
}

// League data lives in the same store; callers mutate the returned object and
// then call saveLeagues() to persist.
function leagues() { return db.leagues; }
function saveLeagues() { save(); }

function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 1));
  }, 250);
}

const scrypt = require('util').promisify(crypto.scrypt);
const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days

// async so a burst of login attempts can't stall the match loop
async function hashPassword(password, salt) {
  return (await scrypt(password, salt, 32)).toString('hex');
}

async function createUser(name, password) {
  const key = (name || '').toLowerCase();
  if (db.users[key]) return { error: 'Dat name is taken, ya git.' };
  if (!/^[a-zA-Z0-9_\- ]{2,20}$/.test(name)) return { error: 'Name: 2-20 letters/numbers.' };
  if (typeof password !== 'string' || password.length < 8) return { error: 'Password too puny (min 8).' };
  const salt = crypto.randomBytes(16).toString('hex');
  db.users[key] = {
    name, salt, pass: await hashPassword(password, salt),
    createdAt: new Date().toISOString(),
    stats: { games: 0, wins: 0, kills: 0, deaths: 0, damage: 0 },
    garage: [],
  };
  save();
  return { user: db.users[key] };
}

async function checkLogin(name, password) {
  const user = db.users[(name || '').toLowerCase()];
  if (!user || !user.pass) return null; // Discord-only accounts have no password
  const hash = await hashPassword(password || '', user.salt);
  const ok = crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(user.pass));
  return ok ? user : null;
}

// Find-or-create an account from a Discord identity. Never auto-links to an
// existing password account by name (that would allow account takeover via a
// matching Discord display name) — collisions get a suffix instead.
function upsertDiscordUser(discord) {
  for (const user of Object.values(db.users)) {
    if (user.discordId === discord.id) return user;
  }
  let base = String(discord.global_name || discord.username || 'Git')
    .replace(/[^a-zA-Z0-9_\- ]/g, '').trim().slice(0, 20) || 'Git';
  if (base.length < 2) base = 'Git ' + base;
  let name = base;
  if (db.users[name.toLowerCase()]) name = `${base.slice(0, 15)}-${discord.id.slice(-4)}`;
  const user = {
    name, discordId: discord.id, avatar: discord.avatar || null,
    salt: null, pass: null,
    createdAt: new Date().toISOString(),
    stats: { games: 0, wins: 0, kills: 0, deaths: 0, damage: 0 },
    garage: [],
  };
  db.users[name.toLowerCase()] = user;
  save();
  return user;
}

function issueToken(name) {
  const token = crypto.randomBytes(24).toString('hex');
  db.tokens[token] = { u: name.toLowerCase(), exp: Date.now() + TOKEN_TTL_MS };
  pruneTokens();
  save();
  return token;
}

function userByToken(token) {
  const entry = db.tokens[token];
  // pre-expiry entries were plain strings — treat as expired (forces re-login)
  if (!entry || typeof entry !== 'object' || entry.exp < Date.now()) {
    if (entry) { delete db.tokens[token]; save(); }
    return null;
  }
  return db.users[entry.u] || null;
}

function revokeToken(token) {
  if (db.tokens[token]) { delete db.tokens[token]; save(); }
}

function pruneTokens() {
  const now = Date.now();
  for (const [t, entry] of Object.entries(db.tokens)) {
    if (typeof entry !== 'object' || entry.exp < now) delete db.tokens[t];
  }
}

function getUser(name) {
  return db.users[(name || '').toLowerCase()] || null;
}

function saveGarage(name, builds) {
  const user = getUser(name);
  if (!user) return;
  user.garage = builds.slice(0, 10);
  save();
}

// ---- Builders: saved force lists ----
// Stored on the user record so a list built on the laptop is there on the
// phone at the table. Only ids and skills are kept — unit stats are looked up
// from the builders database at load time, so a re-imported archive updates
// every saved force at once instead of leaving stale copies around.

const MAX_FORCES = 40;
const MAX_UNITS_PER_FORCE = 60;

function forces(name) {
  const user = getUser(name);
  return user?.forces && typeof user.forces === 'object' ? user.forces : {};
}

function saveForce(name, forceName, units) {
  const user = getUser(name);
  if (!user) return { error: 'no such user' };

  const label = String(forceName || '').trim().slice(0, 60);
  if (!label) return { error: 'Give it a name first, git.' };

  const cleaned = (Array.isArray(units) ? units : [])
    .slice(0, MAX_UNITS_PER_FORCE)
    .map(u => {
      const entry = { id: Number(u.id), skill: Math.min(Math.max(Math.round(Number(u.skill)) || 4, 0), 8) };
      // Total Warfare crew skills, persisted additively: only when the client
      // sends finite numbers, so Alpha Strike saves keep their exact old shape.
      if (Number.isFinite(Number(u.gunnery))) entry.gunnery = Math.min(Math.max(Math.round(Number(u.gunnery)), 0), 8);
      if (Number.isFinite(Number(u.piloting))) entry.piloting = Math.min(Math.max(Math.round(Number(u.piloting)), 0), 8);
      return entry;
    })
    .filter(u => Number.isFinite(u.id));

  if (!user.forces) user.forces = {};
  if (!user.forces[label] && Object.keys(user.forces).length >= MAX_FORCES) {
    return { error: `Yer at ${MAX_FORCES} saved forces — delete one first.` };
  }

  user.forces[label] = { name: label, units: cleaned, updated: Date.now() };
  save();
  return { ok: true };
}

function deleteForce(name, forceName) {
  const user = getUser(name);
  if (!user?.forces) return { ok: true };
  delete user.forces[String(forceName)];
  save();
  return { ok: true };
}

function recordStats(name, delta) {
  const user = getUser(name);
  if (!user) return;
  for (const k of ['games', 'wins', 'kills', 'deaths', 'damage']) {
    user.stats[k] = Math.round(((user.stats[k] || 0) + (delta[k] || 0)) * 10) / 10;
  }
  save();
}

function leaderboard() {
  return Object.values(db.users)
    .map(u => ({ name: u.name, ...u.stats }))
    .sort((a, b) => b.wins - a.wins || b.kills - a.kills)
    .slice(0, 20);
}

load();
module.exports = { createUser, checkLogin, upsertDiscordUser, issueToken, userByToken, revokeToken, getUser, saveGarage, recordStats, leaderboard, leagues, saveLeagues, forces, saveForce, deleteForce };
