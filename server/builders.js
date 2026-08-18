// Builders — army/force list builders for the games the club plays.
//
// First one is BattleTech Alpha Strike, backed by our private archive of the
// Master Unit List (masterunitlist.info), which shut down in 2026. The unit
// data lives in Azure Postgres rather than in this repo: it is ~8,700 units
// and ~200k availability rows, the filtering is genuinely multi-dimensional
// (name, point value range, faction x era), and that is what a real database
// is for.
//
// The pg driver is pure JavaScript, so this adds no native build step on the
// Azure host (which runs Node 20).
//
// Everything here is read-only reference data. Saved forces live on the user
// record in db.json, not in here.

const { Pool } = require('pg');

// Same module the browser loads at /builders/alphastrike.js -- one copy of the
// skill/point-value rule, used by both sides.
const { pvForSkill } = require('../public/builders/alphastrike.js');

const CONNECTION = process.env.MUL_DATABASE_URL || '';

let pool = null;
let metaCache = null;

// The builder is an optional part of the site. If the database is not
// configured, say so clearly rather than taking the club site down with it.
function available() {
  return Boolean(CONNECTION);
}

function getPool() {
  if (!available()) throw new Error('Builders database is not configured (MUL_DATABASE_URL).');
  if (!pool) {
    pool = new Pool({
      connectionString: CONNECTION,
      ssl: { rejectUnauthorized: false }, // Azure Postgres requires TLS
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on('error', (err) => console.error('[builders] idle client error:', err.message));
  }
  return pool;
}

const query = async (text, params = []) => (await getPool().query(text, params)).rows;

function shapeUnit(r) {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    role: r.role,
    tech: r.tech,
    rules: r.rules,
    tonnage: r.tonnage === null ? null : Number(r.tonnage),
    pv: r.point_value,
    bv: r.battle_value,
    size: r.size,
    move: r.move,
    tmm: r.tmm,
    armor: r.armor,
    structure: r.structure,
    threshold: r.threshold,
    damage: { s: r.dmg_short, m: r.dmg_medium, l: r.dmg_long, e: r.dmg_extreme },
    overheat: r.overheat,
    abilities: r.abilities,
    bfType: r.bf_type,
    introduced: r.introduced,
    tro: r.tro,
    image: r.image_url,
  };
}

// Meta changes only when the archive is re-imported, so it is cached for the
// life of the process instead of being rebuilt on every page load.
async function metaPayload() {
  if (metaCache) return metaCache;

  const [counts] = await query(
    `SELECT (SELECT COUNT(*) FROM mul_units) AS units,
            (SELECT COUNT(*) FROM mul_availability) AS availability_pairs,
            (SELECT COUNT(*) FROM mul_factions) AS factions,
            (SELECT COUNT(*) FROM mul_eras) AS eras`,
  );

  const distinct = async (col) =>
    (await query(`SELECT DISTINCT ${col} AS v FROM mul_units WHERE ${col} IS NOT NULL ORDER BY 1`))
      .map((r) => r.v);

  // Only offer factions and eras that something is actually available in, so
  // the dropdowns cannot produce an empty combination.
  // Offer only factions and eras that actually field something, using the same
  // table the filter queries so a dropdown can never produce an empty result.
  const factions = await query(
    `SELECT f.id, f.name FROM mul_factions f
      WHERE EXISTS (SELECT 1 FROM mul_faction_era_units fe WHERE fe.faction_id = f.id)
      ORDER BY f.name`,
  );
  const eras = await query(
    `SELECT e.id, e.name FROM mul_eras e
      WHERE EXISTS (SELECT 1 FROM mul_faction_era_units fe WHERE fe.era_id = e.id)
      ORDER BY e.id`,
  );

  const [imported] = await query(`SELECT value FROM mul_meta WHERE key = 'importedAt'`);

  metaCache = {
    source: 'http://masterunitlist.info',
    importedAt: imported?.value ?? null,
    counts: {
      units: Number(counts.units),
      availabilityPairs: Number(counts.availability_pairs),
      factions: Number(counts.factions),
      eras: Number(counts.eras),
    },
    types: await distinct('type'),
    roles: await distinct('role'),
    techs: await distinct('tech'),
    rulesLevels: await distinct('rules'),
    factions,
    eras,
  };
  return metaCache;
}

const SORTS = {
  name: 'name ASC',
  pv: 'point_value DESC, name ASC',
  pvasc: 'point_value ASC, name ASC',
  tonnage: 'tonnage DESC NULLS LAST, name ASC',
  type: 'type ASC, name ASC',
};

async function search(q = {}) {
  const where = ['point_value > 0'];
  const args = [];
  const add = (sql, value) => {
    args.push(value);
    where.push(sql.replace('$?', `$${args.length}`));
  };

  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const text = String(q.q ?? '').trim();
  if (text) add('name ILIKE $?', `%${text}%`);
  if (q.type) add('type = $?', String(q.type));
  if (q.role) add('role = $?', String(q.role));
  if (q.tech) add('tech = $?', String(q.tech));

  for (const [key, sql] of [
    ['minPV', 'point_value >= $?'],
    ['maxPV', 'point_value <= $?'],
    ['minTons', 'tonnage >= $?'],
    ['maxTons', 'tonnage <= $?'],
  ]) {
    const v = num(q[key]);
    if (v !== null) add(sql, v);
  }

  // Faction/era legality comes from mul_faction_era_units, which is MUL's own
  // faction listing, not the literal pairs printed on each unit's page.
  //
  // Unit pages name generic pools -- "HW Clan General", "IS Clan General",
  // "Inner Sphere General" -- and MUL folds those into every faction they
  // cover. Filtering the literal pairs gives Clan Wolf 72 units in the Clan
  // Invasion era where MUL gives 596, silently hiding most of what a player can
  // legally field.
  const faction = num(q.faction);
  const era = num(q.era);
  if (faction !== null || era !== null) {
    const conds = ['fe.unit_id = mul_units.id'];
    if (faction !== null) { args.push(faction); conds.push(`fe.faction_id = $${args.length}`); }
    if (era !== null) { args.push(era); conds.push(`fe.era_id = $${args.length}`); }
    where.push(`EXISTS (SELECT 1 FROM mul_faction_era_units fe WHERE ${conds.join(' AND ')})`);
  }

  const clause = `WHERE ${where.join(' AND ')}`;
  const [{ count }] = await query(`SELECT COUNT(*) AS count FROM mul_units ${clause}`, args);

  const limit = Math.min(Math.max(num(q.limit) ?? 100, 1), 500);
  const offset = Math.max(num(q.offset) ?? 0, 0);
  args.push(limit, offset);

  const rows = await query(
    `SELECT * FROM mul_units ${clause}
      ORDER BY ${SORTS[q.sort] || SORTS.name}
      LIMIT $${args.length - 1} OFFSET $${args.length}`,
    args,
  );

  return { total: Number(count), limit, offset, units: rows.map(shapeUnit) };
}

async function unit(id) {
  const [row] = await query('SELECT * FROM mul_units WHERE id = $1', [Number(id)]);
  if (!row) return null;

  const pairs = await query(
    `SELECT a.era_id, e.name AS era, a.faction_id, f.name AS faction
       FROM mul_availability a
       LEFT JOIN mul_eras e ON e.id = a.era_id
       LEFT JOIN mul_factions f ON f.id = a.faction_id
      WHERE a.unit_id = $1
      ORDER BY a.era_id, f.name`,
    [Number(id)],
  );

  const byEra = new Map();
  for (const p of pairs) {
    if (!byEra.has(p.era_id)) {
      byEra.set(p.era_id, { eraId: p.era_id, era: p.era ?? `Era ${p.era_id}`, factions: [] });
    }
    byEra.get(p.era_id).factions.push({ id: p.faction_id, name: p.faction ?? `Faction ${p.faction_id}` });
  }

  return { unit: shapeUnit(row), availability: [...byEra.values()] };
}

// Resolve a saved force (ids + skills) against current data, so a stored list
// still renders on any device.
async function hydrateForce(entries) {
  const list = (Array.isArray(entries) ? entries : []).slice(0, 60);
  if (!list.length) return [];

  const ids = [...new Set(list.map((e) => Number(e.id)).filter(Number.isFinite))];
  if (!ids.length) return [];

  const rows = await query('SELECT * FROM mul_units WHERE id = ANY($1::int[])', [ids]);
  const byId = new Map(rows.map((r) => [r.id, shapeUnit(r)]));

  return list
    .map((e) => {
      const found = byId.get(Number(e.id));
      if (!found) return null;
      const skill = Number(e.skill);
      return { ...found, skill: Number.isFinite(skill) ? Math.min(Math.max(Math.round(skill), 0), 8) : 4 };
    })
    .filter(Boolean);
}

// Summarise every saved force for the list dropdown.
//
// Saved forces hold only unit ids and pilot skills, so the point totals have to
// be recomputed from live unit data rather than read back from the save. All
// the forces are resolved in a single query instead of one per force.
async function summariseForces(saved) {
  const list = Object.values(saved ?? {});
  if (!list.length) return [];

  const ids = [...new Set(list.flatMap((f) => (f.units ?? []).map((u) => Number(u.id))))]
    .filter(Number.isFinite);

  let pvById = new Map();
  if (ids.length) {
    const rows = await query('SELECT id, point_value FROM mul_units WHERE id = ANY($1::int[])', [ids]);
    pvById = new Map(rows.map((r) => [r.id, r.point_value]));
  }

  return list
    .map((f) => ({
      name: f.name,
      units: f.units ?? [],
      updated: f.updated,
      totalPV: (f.units ?? []).reduce((n, u) => {
        const base = pvById.get(Number(u.id));
        return base === undefined ? n : n + pvForSkill(base, Number(u.skill));
      }, 0),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function health() {
  if (!available()) return { ok: false, error: 'not configured' };
  try {
    const [row] = await query('SELECT COUNT(*) AS n FROM mul_units');
    return { ok: true, units: Number(row.n) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { available, metaPayload, search, unit, hydrateForce, summariseForces, health };
