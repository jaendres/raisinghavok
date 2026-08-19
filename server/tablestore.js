// Game Night — persistence for live at-the-table play tracking.
//
// Same tiny JSON-file pattern as db.js, but its own file (tables.json) so a
// busy game night can never corrupt accounts, and a wiped table store never
// touches anyone's league history. A table is a snapshot: unit stats are
// copied in at creation so the tracker keeps working even if the builders
// database goes away mid-game.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// On Azure App Service, DATA_DIR=/home/data keeps this outside wwwroot so
// deployments don't wipe live games (same convention as db.js).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'tables.json');

const MAX_ACTIVE = 20;              // club-sized: refuse politely beyond this
const LOG_CAP = 200;                // per-table event log entries
const STALE_MS = 30 * 24 * 3600 * 1000; // tables untouched this long get pruned

let store = { tables: {} };
let saveTimer = null;

function load() {
  try {
    store = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
  } catch {
    store = { tables: {} };
  }
  if (!store.tables || typeof store.tables !== 'object') store.tables = {};
}

function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(store, null, 1));
  }, 250);
}

// A join code the other player can read off a screen across the table:
// 6 hex characters, no ambiguous alphabet games.
function newId() {
  let id;
  do { id = crypto.randomBytes(3).toString('hex'); } while (store.tables[id]);
  return id;
}

// { game, name, createdBy, sides } -> { table } | { error }
// sides arrive fully built (units already snapshotted by the caller).
function create({ game, name, createdBy, sides }) {
  prune();
  const active = Object.values(store.tables).filter((t) => t.status !== 'done');
  if (active.length >= MAX_ACTIVE) {
    return { error: `Da club's already runnin' ${MAX_ACTIVE} tables — finish or scrap one first.` };
  }
  const now = Date.now();
  const table = {
    id: newId(),
    game,
    name,
    createdBy,
    created: now,
    updated: now,
    status: 'setup',       // 'setup' | 'playing' | 'done'
    round: 1,
    sides,                 // [{ name, owner, units: [...] }]
    members: [],           // everyone who has opened the table (for "my tables")
    log: [],               // [{ t, msg }], capped at LOG_CAP
  };
  store.tables[table.id] = table;
  save();
  return { table };
}

function get(id) {
  return store.tables[String(id || '').toLowerCase()] || null;
}

// Tables this user created, owns a side in, or has joined by code.
function byUser(name) {
  const k = String(name || '').toLowerCase();
  return Object.values(store.tables)
    .filter((t) =>
      String(t.createdBy || '').toLowerCase() === k
      || (t.sides || []).some((s) => String(s.owner || '').toLowerCase() === k)
      || (t.members || []).some((m) => String(m).toLowerCase() === k))
    .sort((a, b) => b.updated - a.updated);
}

function all() {
  return Object.values(store.tables).sort((a, b) => b.updated - a.updated);
}

// Whole-table save. Callers mutate the object from get() and then call this;
// it stamps the updated time and enforces the log cap.
function update(table) {
  table.updated = Date.now();
  if (Array.isArray(table.log) && table.log.length > LOG_CAP) {
    table.log = table.log.slice(-LOG_CAP);
  }
  store.tables[table.id] = table;
  save();
  return table;
}

function addLog(table, msg) {
  table.log.push({ t: Date.now(), msg: String(msg).slice(0, 140) });
  if (table.log.length > LOG_CAP) table.log = table.log.slice(-LOG_CAP);
}

function remove(id) {
  const key = String(id || '').toLowerCase();
  if (!store.tables[key]) return { ok: true };
  delete store.tables[key];
  save();
  return { ok: true };
}

// Drop tables nobody has touched in 30 days — a game night that never got
// finished shouldn't count against the active-table cap forever.
function prune() {
  const cutoff = Date.now() - STALE_MS;
  let dropped = 0;
  for (const [id, t] of Object.entries(store.tables)) {
    if ((t.updated || 0) < cutoff) { delete store.tables[id]; dropped++; }
  }
  if (dropped) save();
  return dropped;
}

load();
module.exports = { create, get, byUser, all, update, addLog, remove, prune, MAX_ACTIVE, LOG_CAP };
