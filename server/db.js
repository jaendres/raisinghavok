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
}

function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 1));
  }, 250);
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString('hex');
}

function createUser(name, password) {
  const key = name.toLowerCase();
  if (db.users[key]) return { error: 'Dat name is taken, ya git.' };
  if (!/^[a-zA-Z0-9_\- ]{2,20}$/.test(name)) return { error: 'Name: 2-20 letters/numbers.' };
  if (typeof password !== 'string' || password.length < 4) return { error: 'Password too puny (min 4).' };
  const salt = crypto.randomBytes(16).toString('hex');
  db.users[key] = {
    name, salt, pass: hashPassword(password, salt),
    createdAt: new Date().toISOString(),
    stats: { games: 0, wins: 0, kills: 0, deaths: 0, damage: 0 },
    garage: [],
  };
  save();
  return { user: db.users[key] };
}

function checkLogin(name, password) {
  const user = db.users[(name || '').toLowerCase()];
  if (!user) return null;
  const hash = hashPassword(password || '', user.salt);
  const ok = crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(user.pass));
  return ok ? user : null;
}

function issueToken(name) {
  const token = crypto.randomBytes(24).toString('hex');
  db.tokens[token] = name.toLowerCase();
  save();
  return token;
}

function userByToken(token) {
  const key = db.tokens[token];
  return key ? db.users[key] : null;
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
module.exports = { createUser, checkLogin, issueToken, userByToken, getUser, saveGarage, recordStats, leaderboard };
