// My Lists — persistence for solo play-reference lists.
//
// Same tiny debounced JSON-file pattern as tablestore.js, but its own file
// (lists.json) so a player's saved reference library and the club's live
// tables can never corrupt each other. A list is a snapshot: unit stats (and
// for 40k the army/detachment rules block) are copied in at creation so the
// list stays readable at the table even if the reference database goes away.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// On Azure App Service, DATA_DIR=/home/data keeps this outside wwwroot so
// deployments don't wipe anyone's library (same convention as tablestore.js).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'lists.json');

const MAX_PER_USER = 30;   // a personal reference library, not an archive

let store = { lists: {} };
let saveTimer = null;

function load() {
  try {
    store = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
  } catch {
    store = { lists: {} };
  }
  if (!store.lists || typeof store.lists !== 'object') store.lists = {};
}

function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(store, null, 1));
  }, 250);
}

// Lists are private (never joined by code), so the id is longer than a table's
// 6-hex join code — nobody has to read it off a screen.
function newId() {
  let id;
  do { id = crypto.randomBytes(5).toString('hex'); } while (store.lists[id]);
  return id;
}

// { owner, game, name, units, army? } -> { list } | { error }
// units arrive fully snapshotted by the caller (server/table.js).
function create({ owner, game, name, units, army }) {
  const mine = byUser(owner);
  if (mine.length >= MAX_PER_USER) {
    return { error: `Yer at ${MAX_PER_USER} saved lists — delete one first.` };
  }
  const now = Date.now();
  const list = {
    id: newId(),
    owner,
    game,
    name,
    units,                    // same snapshot shapes the table modes use
    army: army || null,       // 40k rules block / paste-game header block
    created: now,
    updated: now,
  };
  store.lists[list.id] = list;
  save();
  return { list };
}

function get(id) {
  return store.lists[String(id || '').toLowerCase()] || null;
}

function byUser(owner) {
  const k = String(owner || '').toLowerCase();
  return Object.values(store.lists)
    .filter((l) => String(l.owner || '').toLowerCase() === k)
    .sort((a, b) => b.updated - a.updated);
}

// Whole-list save. Callers mutate the object from get() and then call this.
function update(list) {
  list.updated = Date.now();
  store.lists[list.id] = list;
  save();
  return list;
}

function remove(id) {
  const key = String(id || '').toLowerCase();
  if (!store.lists[key]) return { ok: true };
  delete store.lists[key];
  save();
  return { ok: true };
}

load();
module.exports = { create, get, byUser, update, remove, MAX_PER_USER };
