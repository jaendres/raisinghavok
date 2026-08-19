// Warhammer 40k (11th edition) reference data, backed by Wahapedia's CSV
// export imported into the same Azure Postgres the BattleTech builder uses
// (scripts/wh40k-import.mjs, tables prefixed wh40k_).
//
// Same shape as server/builders.js: lazy pool, available() guard on the
// shared MUL_DATABASE_URL, read-only query functions. Description fields hold
// Wahapedia's HTML verbatim — the UI is responsible for sanitizing/rendering.

const { Pool } = require('pg');

const CONNECTION = process.env.MUL_DATABASE_URL || '';

let pool = null;
let metaCache = null;

// Optional part of the site: if the database is not configured, say so
// clearly rather than taking the club site down with it.
function available() {
  return Boolean(CONNECTION);
}

function getPool() {
  if (!available()) throw new Error('40k database is not configured (MUL_DATABASE_URL).');
  if (!pool) {
    pool = new Pool({
      connectionString: CONNECTION,
      ssl: { rejectUnauthorized: false }, // Azure Postgres requires TLS
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on('error', (err) => console.error('[wh40k] idle client error:', err.message));
  }
  return pool;
}

const query = async (text, params = []) => (await getPool().query(text, params)).rows;

// ---- meta ------------------------------------------------------------------

async function metaPayload() {
  if (metaCache) return metaCache;
  const [counts] = await query(
    `SELECT (SELECT COUNT(*) FROM wh40k_datasheets) AS datasheets,
            (SELECT COUNT(*) FROM wh40k_factions) AS factions,
            (SELECT COUNT(*) FROM wh40k_stratagems) AS stratagems`,
  );
  const [imported] = await query(`SELECT value FROM wh40k_meta WHERE key = 'importedAt'`);
  const [updated] = await query('SELECT last_update FROM wh40k_last_update LIMIT 1');
  metaCache = {
    source: 'https://wahapedia.ru/wh40k11ed/',
    importedAt: imported?.value ?? null,
    dataUpdatedAt: updated?.last_update ?? null,
    counts: {
      datasheets: Number(counts.datasheets),
      factions: Number(counts.factions),
      stratagems: Number(counts.stratagems),
    },
    factions: await getFactions(),
  };
  return metaCache;
}

async function getFactions() {
  return query('SELECT id, name, link FROM wh40k_factions ORDER BY name');
}

// ---- datasheet search ------------------------------------------------------

async function searchDatasheets(q = {}) {
  const where = ["COALESCE(d.virtual, 'false') <> 'true'"]; // virtual sheets aren't fieldable units
  const args = [];
  const add = (sql, value) => {
    args.push(value);
    where.push(sql.replace('$?', `$${args.length}`));
  };

  const text = String(q.q ?? '').trim();
  if (text) add('d.name ILIKE $?', `%${text}%`);

  // Accept either a faction id ('AC') or a faction name ('Adeptus Custodes').
  const faction = String(q.faction ?? '').trim();
  if (faction) {
    args.push(faction, faction);
    where.push(`(d.faction_id = $${args.length - 1} OR f.name ILIKE $${args.length})`);
  }

  const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
  args.push(limit);

  return query(
    `SELECT d.id, d.name, d.faction_id, f.name AS faction, d.role,
            (SELECT MIN(TRIM(mc.cost)::int) FROM wh40k_datasheets_models_cost mc
              WHERE mc.datasheet_id = d.id
                AND TRIM(COALESCE(mc.cost, '')) ~ '^[0-9]+$'
                AND TRIM(COALESCE(mc.description, '')) ~* '^[0-9]+ models?$') AS min_cost
       FROM wh40k_datasheets d
       LEFT JOIN wh40k_factions f ON f.id = d.faction_id
      WHERE ${where.join(' AND ')}
      ORDER BY d.name
      LIMIT $${args.length}`,
    args,
  );
}

// ---- full datasheet (one call = everything a condensed play card needs) ----

async function getDatasheet(id) {
  const sheetId = String(id);
  const [sheet] = await query(
    `SELECT d.*, f.name AS faction_name
       FROM wh40k_datasheets d
       LEFT JOIN wh40k_factions f ON f.id = d.faction_id
      WHERE d.id = $1`,
    [sheetId],
  );
  if (!sheet) return null;

  const [models, wargear, abilities, keywords, composition, options, costs, leads, ledBy] =
    await Promise.all([
      query(
        `SELECT line, name, m, t, sv, inv_sv, inv_sv_descr, w, ld, oc, base_size, base_size_descr
           FROM wh40k_datasheets_models WHERE datasheet_id = $1 ORDER BY line::int`,
        [sheetId],
      ),
      query(
        `SELECT line, line_in_wargear, dice, name, description, range, type, a, bs_ws, s, ap, d
           FROM wh40k_datasheets_wargear WHERE datasheet_id = $1
          ORDER BY line::int, COALESCE(NULLIF(line_in_wargear,'')::int, 0)`,
        [sheetId],
      ),
      // A datasheet ability either carries its own name/description or points
      // at a shared entry in wh40k_abilities (Core / Faction abilities).
      query(
        `SELECT da.line, da.model, da.type, da.parameter,
                COALESCE(NULLIF(da.name, ''), a.name) AS name,
                COALESCE(NULLIF(da.description, ''), a.description) AS description,
                a.legend
           FROM wh40k_datasheets_abilities da
           LEFT JOIN wh40k_abilities a ON a.id = da.ability_id
          WHERE da.datasheet_id = $1 ORDER BY da.line::int`,
        [sheetId],
      ),
      query(
        `SELECT keyword, model, is_faction_keyword
           FROM wh40k_datasheets_keywords WHERE datasheet_id = $1 ORDER BY keyword`,
        [sheetId],
      ),
      query(
        `SELECT line, description FROM wh40k_datasheets_unit_composition
          WHERE datasheet_id = $1 ORDER BY line::int`,
        [sheetId],
      ),
      query(
        `SELECT line, button, description FROM wh40k_datasheets_options
          WHERE datasheet_id = $1 ORDER BY line::int`,
        [sheetId],
      ),
      query(
        `SELECT line, description, cost FROM wh40k_datasheets_models_cost
          WHERE datasheet_id = $1 ORDER BY line::int`,
        [sheetId],
      ),
      // Leader info both ways: units this one can lead, and leaders that can
      // attach to this one.
      query(
        `SELECT l.attached_id AS id, d.name FROM wh40k_datasheets_leader l
           JOIN wh40k_datasheets d ON d.id = l.attached_id
          WHERE l.leader_id = $1 ORDER BY d.name`,
        [sheetId],
      ),
      query(
        `SELECT l.leader_id AS id, d.name FROM wh40k_datasheets_leader l
           JOIN wh40k_datasheets d ON d.id = l.leader_id
          WHERE l.attached_id = $1 ORDER BY d.name`,
        [sheetId],
      ),
    ]);

  return {
    id: sheet.id,
    name: sheet.name,
    faction: { id: sheet.faction_id, name: sheet.faction_name },
    role: sheet.role,
    legend: sheet.legend,
    loadout: sheet.loadout,
    transport: sheet.transport,
    virtual: sheet.virtual === 'true',
    leaderHead: sheet.leader_head,
    leaderFooter: sheet.leader_footer,
    damaged: { threshold: sheet.damaged_w, description: sheet.damaged_description },
    link: sheet.link,
    models,
    wargear: {
      ranged: wargear.filter((w) => w.type === 'Ranged'),
      melee: wargear.filter((w) => w.type === 'Melee'),
      other: wargear.filter((w) => w.type !== 'Ranged' && w.type !== 'Melee'),
    },
    abilities,
    keywords: {
      faction: keywords.filter((k) => k.is_faction_keyword === 'true').map((k) => k.keyword),
      unit: keywords.filter((k) => k.is_faction_keyword !== 'true').map((k) => k.keyword),
    },
    composition: composition.map((c) => c.description),
    options: options.map((o) => ({ button: o.button, description: o.description })),
    // Keep the header rows ("YOUR 1ST TO 3RD UNITS COST", "WARGEAR OPTIONS")
    // with cost null — the cost table renders faithfully only with them.
    costs: costs.map((c) => {
      const n = Number(String(c.cost ?? '').trim());
      return { description: c.description, cost: Number.isFinite(n) && c.cost !== null ? n : null };
    }),
    leader: { leads, ledBy },
  };
}

// ---- army list resolution --------------------------------------------------

// Normalise a name for matching: lowercase, drop possessives, strip
// punctuation/diacritic-ish clutter, collapse whitespace.
function normalise(s) {
  return String(s)
    .toLowerCase()
    .replace(/[’']s\b/g, 's')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Pull unit name + count + points out of one pasted line. Understands the GW
// app ("Custodian Guard (170 points)"), New Recruit ("Custodian Guard [170pts]",
// "2x Custodian Guard"), and BattleScribe ("Custodian Guard [95pts]") shapes.
function parseLine(raw) {
  let s = raw.trim();
  if (!s) return null;

  // Wargear/sub-option lines are indented or bulleted — not unit candidates.
  if (/^\s/.test(raw) || /^[•◦*·>-]/.test(s)) return null;

  // Section headers and list-size labels from the GW app.
  if (/^(\+\+|\*\*|==|--)/.test(s)) return null;
  if (/^(CHARACTERS?|BATTLELINE|DEDICATED TRANSPORTS?|OTHER DATASHEETS?|ALLIED UNITS?)$/i.test(s)) return null;
  if (/^(combat patrol|incursion|strike force|onslaught)\b/i.test(s)) return null;
  if (/^(exported with|created with|total|army rule|detachment)/i.test(s)) return null;

  let points = null;
  let count = 1;

  // Points: "(170 points)", "[170 pts]", "170pts"
  const pts = s.match(/[([]?\s*(\d+)\s*(?:pts?|points)\s*[)\]]?/i);
  if (pts) {
    points = Number(pts[1]);
    s = s.replace(pts[0], ' ');
  }

  // Leading or trailing multiplier: "3x Name" / "Name x3"
  const lead = s.match(/^(\d+)\s*[x×]\s+/i);
  if (lead) {
    count = Number(lead[1]);
    s = s.slice(lead[0].length);
  } else {
    const tail = s.match(/\s[x×]\s*(\d+)\s*$/i);
    if (tail) {
      count = Number(tail[1]);
      s = s.slice(0, tail.index);
    }
  }

  // Strip leftover brackets/separators, e.g. BattleScribe's "Unit [x] [y]".
  s = s.replace(/[[\]()|]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s || /^\d+$/.test(s)) return null;

  return { name: s, count, points };
}

async function resolveList(text) {
  const rows = await query('SELECT id, name, faction_id FROM wh40k_datasheets');
  const byExact = new Map();
  const byNorm = new Map();
  for (const r of rows) {
    const push = (map, key) => {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(r);
    };
    push(byExact, r.name.toLowerCase());
    push(byNorm, normalise(r.name));
  }

  const units = [];
  const unmatched = [];
  const lines = String(text ?? '').split(/\r?\n/);
  for (const raw of lines) {
    const parsed = parseLine(raw);
    if (!parsed) continue;

    const lower = parsed.name.toLowerCase();
    const norm = normalise(parsed.name);

    let matches = null;
    let confidence = 0;
    let how = null;

    if (byExact.has(lower)) {
      matches = byExact.get(lower);
      confidence = 1;
      how = 'exact';
    } else if (byNorm.has(norm)) {
      matches = byNorm.get(norm);
      confidence = 0.9;
      how = 'normalized';
    } else if (norm) {
      // Fuzzy: containment either way. Report every candidate rather than
      // silently picking one.
      const contains = rows.filter((r) => {
        const rn = normalise(r.name);
        return rn.includes(norm) || norm.includes(rn);
      });
      if (contains.length) {
        matches = contains;
        confidence = 0.6;
        how = 'fuzzy';
      }
    }

    if (!matches) {
      unmatched.push({ line: raw.trim(), parsedName: parsed.name });
      continue;
    }
    units.push({
      line: raw.trim(),
      parsedName: parsed.name,
      count: parsed.count,
      points: parsed.points,
      confidence,
      matchedBy: how,
      matches: matches
        .slice(0, 5)
        .map((m) => ({ id: m.id, name: m.name, factionId: m.faction_id })),
      ambiguous: matches.length > 1,
    });
  }

  return { units, unmatched };
}

// ---- routes ----------------------------------------------------------------

// Register the 40k builder routes. deps.memberReader is index.js's members-only
// gate, applied to every route just like the battletech ones.
function mount(app, deps = {}) {
  const memberReader = deps.memberReader
    || ((req, res, next) => next());

  function ready(req, res, next) {
    if (!available()) {
      return res.status(503).json({ error: 'Da 40k database ain\'t hooked up yet.' });
    }
    next();
  }

  app.get('/api/builders/wh40k/meta', memberReader, ready, async (req, res) => {
    try {
      res.json(await metaPayload());
    } catch (err) {
      console.error('[wh40k] meta:', err.message);
      res.status(502).json({ error: '40k database is not answering.' });
    }
  });

  app.get('/api/builders/wh40k/datasheets', memberReader, ready, async (req, res) => {
    try {
      res.json({ datasheets: await searchDatasheets(req.query) });
    } catch (err) {
      console.error('[wh40k] search:', err.message);
      res.status(502).json({ error: '40k database is not answering.' });
    }
  });

  app.get('/api/builders/wh40k/datasheets/:id', memberReader, ready, async (req, res) => {
    try {
      const found = await getDatasheet(req.params.id);
      if (!found) return res.status(404).json({ error: 'No such datasheet.' });
      res.json(found);
    } catch (err) {
      console.error('[wh40k] datasheet:', err.message);
      res.status(502).json({ error: '40k database is not answering.' });
    }
  });

  app.post('/api/builders/wh40k/resolve-list', memberReader, ready, async (req, res) => {
    try {
      const text = typeof req.body === 'string' ? req.body : req.body?.text;
      if (!text || typeof text !== 'string') {
        return res.status(400).json({ error: 'POST { text: "<pasted army list>" }' });
      }
      res.json(await resolveList(text));
    } catch (err) {
      console.error('[wh40k] resolve-list:', err.message);
      res.status(502).json({ error: '40k database is not answering.' });
    }
  });
}

module.exports = {
  available,
  metaPayload,
  getFactions,
  searchDatasheets,
  getDatasheet,
  resolveList,
  mount,
};
