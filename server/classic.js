// Classic BattleTech (Total Warfare) record sheets, backed by the same Azure
// Postgres as the builders archive (table classic_sheets, one row per MUL id).
//
// Same shape as server/builders.js / server/wh40k.js: lazy pool, available()
// guard on the shared MUL_DATABASE_URL, read-only query functions, and a
// mount() that registers the API routes behind the caller's member gate.

const { Pool } = require('pg');

const CONNECTION = process.env.MUL_DATABASE_URL || '';

let pool = null;

// Optional part of the site: if the database is not configured, say so
// clearly rather than taking the club site down with it.
function available() {
  return Boolean(CONNECTION);
}

function getPool() {
  if (!available()) throw new Error('Classic sheets database is not configured (MUL_DATABASE_URL).');
  if (!pool) {
    pool = new Pool({
      connectionString: CONNECTION,
      ssl: { rejectUnauthorized: false }, // Azure Postgres requires TLS
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on('error', (err) => console.error('[classic] idle client error:', err.message));
  }
  return pool;
}

const query = async (text, params = []) => (await getPool().query(text, params)).rows;

// Full record sheet for one MUL id, jsonb columns already parsed by pg.
// Returns null when the unit has no classic sheet in the archive.
async function getSheet(mulId) {
  const id = Number(mulId);
  if (!Number.isFinite(id)) return null;
  const [row] = await query('SELECT * FROM classic_sheets WHERE mul_id = $1', [id]);
  if (!row) return null;
  return {
    mulId: row.mul_id,
    chassis: row.chassis,
    model: row.model,
    config: row.config,
    omni: row.omni,
    mass: row.mass === null ? null : Number(row.mass),
    techBase: row.tech_base,
    era: row.era,
    source: row.source,
    rulesLevel: row.rules_level,
    role: row.role,
    engine: row.engine,
    structureType: row.structure_type,
    heatSinks: row.heat_sinks,
    heatSinkType: row.heat_sink_type,
    walkMp: row.walk_mp,
    jumpMp: row.jump_mp,
    armorType: row.armor_type,
    armor: row.armor || {},          // per-location, incl. rear RTL/RTR/RTC
    internals: row.internals || {},  // per-location
    weapons: row.weapons || [],      // [{ name, count, location }]
    crits: row.crits || {},          // per-location 12-slot arrays (null = empty)
    quirks: row.quirks || [],
  };
}

async function health() {
  if (!available()) return { ok: false, error: 'not configured' };
  try {
    const [row] = await query('SELECT COUNT(*) AS n FROM classic_sheets');
    return { ok: true, sheets: Number(row.n) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Register the classic-sheet routes. deps.memberReader is index.js's
// members-only gate, applied just like the battletech builder routes.
function mount(app, deps = {}) {
  const memberReader = deps.memberReader || ((req, res, next) => next());

  app.get('/api/builders/battletech/classic/:id', memberReader, async (req, res) => {
    if (!available()) {
      return res.status(503).json({ error: 'Da classic sheets database ain\'t hooked up yet.' });
    }
    try {
      const sheet = await getSheet(req.params.id);
      if (!sheet) return res.status(404).json({ error: 'No classic record sheet for dat unit.' });
      res.json(sheet);
    } catch (err) {
      console.error('[classic] sheet:', err.message);
      res.status(502).json({ error: 'Classic sheets database is not answering.' });
    }
  });
}

module.exports = { available, getSheet, health, mount };
