// Where every game's reference data came from, and how old it is.
//
// The club site copies other people's work: Wahapedia's 40k export, an
// archive of the Master Unit List, community BattleScribe catalogs, a couple
// of catalogs hand-compiled from PDFs. Every one of those already records its
// own provenance — an importedAt row, a meta.warning, a list of admitted gaps
// — but all of it was invisible to whoever was reading a card at the table.
// Someone looking at a threat value had no way to tell whether it was pulled
// last night or in 2024.
//
// This module gathers all of it into one payload for /data/. It is the only
// place in the codebase that treats "how stale is this" as a first-class
// question rather than a footnote.
//
// Same shape as the other modules (server/builders.js, server/wh40k.js):
// lazy pool, available() guard on the shared MUL_DATABASE_URL, read-only,
// and a mount() that registers the route behind the caller's member gate.
//
// One rule matters more than the others: this endpoint must never fail
// wholesale. If Postgres is unconfigured or hiccups, the catalog sources
// still report and the database ones come back status 'unknown' with the
// reason attached. A page about honesty that 502s is worse than useless.

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const CONNECTION = process.env.MUL_DATABASE_URL || '';

let pool = null;

function available() {
  return Boolean(CONNECTION);
}

function getPool() {
  if (!available()) throw new Error('Database is not configured (MUL_DATABASE_URL).');
  if (!pool) {
    pool = new Pool({
      connectionString: CONNECTION,
      ssl: { rejectUnauthorized: false }, // Azure Postgres requires TLS
      max: 2,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on('error', (err) => console.error('[freshness] idle client error:', err.message));
  }
  return pool;
}

const query = async (text, params = []) => (await getPool().query(text, params)).rows;

// ---- catalogs --------------------------------------------------------------
//
// Read once at require() time, same as the modules that serve them. The
// catalogs are checked into the repo, so they only change on deploy.
// Explicit utf-8: every one of these carries non-ASCII (en dashes, Teğmen).

function readCatalog(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', file), 'utf-8'));
  } catch (err) {
    console.error(`[freshness] ${file}:`, err.message);
    return null;
  }
}

const CATALOGS = {
  necromunda: readCatalog('necromunda-catalog.json'),
  mcp: readCatalog('mcp-catalog.json'),
  trenchcrusade: readCatalog('trenchcrusade-catalog.json'),
  bb: readCatalog('bb-catalog.json'),
};

// ---- age -------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

// Catalog dates are bare 'YYYY-MM-DD' as often as full timestamps; Date
// parses both, and anything it can't parse becomes null rather than NaN.
function parseDate(value) {
  if (!value) return null;
  const d = new Date(String(value).includes('T') ? value : `${value}T00:00:00Z`);
  return Number.isFinite(d.getTime()) ? d : null;
}

const daysSince = (date) => (date ? Math.floor((Date.now() - date.getTime()) / DAY) : null);

// Two clocks, because the sources move at two different speeds.
//
// Wahapedia republishes within minutes of an errata and CI pulls it nightly,
// so a fortnight-old 40k copy is genuinely stale. The community catalogs are
// compiled by hand against rulebooks that change once or twice a year — six
// months old there is normal, not alarming.
const NIGHTLY = { aging: 3, stale: 14 };
const SLOW = { aging: 183, stale: 365 };
// Blood Bowl moves on its own, slower clock: GW puts out roughly one FAQ or
// season a year, so a six-month-old capture is simply current and flagging it
// would be noise. A year means a release has probably landed; eighteen months
// means one definitely has.
const ANNUAL = { aging: 365, stale: 545 };

function ageStatus(date, thresholds) {
  const days = daysSince(date);
  if (days === null) return 'unknown';
  if (days >= thresholds.stale) return 'stale';
  if (days >= thresholds.aging) return 'aging';
  return 'fresh';
}

function agePhrase(date) {
  const days = daysSince(date);
  if (days === null) return 'no date recorded';
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 60) return `${days} days ago`;
  const months = Math.round(days / 30.44);
  if (months < 24) return `about ${months} months ago`;
  return `about ${Math.floor(days / 365.25)} years ago`;
}

// ---- database sources ------------------------------------------------------

async function wh40kSource() {
  const base = {
    id: 'wh40k',
    game: 'Warhammer 40,000',
    label: '11th edition datasheets, stratagems and detachments',
    kind: 'database',
    source: 'Wahapedia (wahapedia.ru)',
    sourceUrl: 'https://wahapedia.ru/wh40k11ed/',
    lastRefreshed: null,
    upstreamDate: null,
    counts: {},
    status: 'unknown',
    statusReason: '',
    note: 'Imported into our Postgres by scripts/wh40k-import.mjs. CI re-runs the '
      + 'import nightly and an admin can force it from the admin page, so this copy '
      + 'should never be more than a day behind Wahapedia.',
    warnings: [],
    gaps: [],
    caveats: [],
  };

  if (!available()) {
    return { ...base, statusReason: 'The unit database is not configured on this server (MUL_DATABASE_URL is unset), so nothing can be read about this import.' };
  }

  try {
    const meta = Object.fromEntries(
      (await query('SELECT key, value FROM wh40k_meta')).map((r) => [r.key, r.value]),
    );
    const [counts] = await query(
      `SELECT (SELECT COUNT(*) FROM wh40k_datasheets) AS datasheets,
              (SELECT COUNT(*) FROM wh40k_factions) AS factions,
              (SELECT COUNT(*) FROM wh40k_stratagems) AS stratagems,
              (SELECT COUNT(*) FROM wh40k_detachments) AS detachments,
              (SELECT COUNT(*) FROM wh40k_enhancements) AS enhancements`,
    );

    // Wahapedia stamps its own export; ours is the time we pulled it. Both
    // matter — a fresh import of a stale export is still stale data.
    let upstream = null;
    try {
      const [row] = await query('SELECT last_update FROM wh40k_last_update LIMIT 1');
      upstream = row?.last_update ?? null;
    } catch { /* table absent on an older import; the import date still stands */ }

    const importedAt = meta.importedAt ?? null;
    const imported = parseDate(importedAt);
    const status = ageStatus(imported, NIGHTLY);

    const missing = String(meta.missingFiles || '').split(',').map((s) => s.trim()).filter(Boolean);
    const files = String(meta.files || '').split(',').map((s) => s.trim()).filter(Boolean);

    return {
      ...base,
      source: meta.source ? 'Wahapedia (wahapedia.ru)' : base.source,
      sourceUrl: meta.source || base.sourceUrl,
      lastRefreshed: imported ? imported.toISOString() : null,
      upstreamDate: upstream ? String(upstream) : null,
      counts: {
        datasheets: Number(counts.datasheets),
        factions: Number(counts.factions),
        stratagems: Number(counts.stratagems),
        detachments: Number(counts.detachments),
        enhancements: Number(counts.enhancements),
      },
      status,
      statusReason: imported
        ? `Last imported ${agePhrase(imported)}. Nightly refresh means anything past ${NIGHTLY.aging} days is drifting and past ${NIGHTLY.stale} days is stale.`
        : 'The import left no importedAt stamp, so its age is unknown.',
      warnings: missing.length
        ? [`Wahapedia did not serve ${missing.length} of the expected files at import time (${missing.join(', ')}) — anything that lived in them is missing from our copy.`]
        : [],
      caveats: [
        `${files.length} CSV files imported from Wahapedia's public export.`,
        'Rules text is Wahapedia\'s HTML, reproduced verbatim. It is a fan-maintained transcription of GW\'s rules, not the rules themselves — the printed book wins any argument.',
      ],
    };
  } catch (err) {
    console.error('[freshness] wh40k:', err.message);
    return { ...base, statusReason: `The database did not answer: ${err.message}` };
  }
}

async function battletechSource() {
  const base = {
    id: 'battletech',
    game: 'BattleTech — Alpha Strike & Classic',
    label: 'Unit cards, availability and Total Warfare record sheets',
    kind: 'database',
    source: 'Master Unit List (masterunitlist.info)',
    sourceUrl: 'http://masterunitlist.info',
    lastRefreshed: null,
    upstreamDate: null,
    counts: {},
    status: 'final',
    statusReason: '',
    note: 'The Master Unit List shut down in 2026. We archived it first, and this '
      + 'is that archive. It will never refresh again because there is nothing left '
      + 'to refresh from — which makes it the most stable data on the site, not the '
      + 'least trustworthy. Treat it as a printed book: fixed, and correct as of the '
      + 'day the presses stopped.',
    warnings: [],
    gaps: [],
    caveats: [],
  };

  if (!available()) {
    return {
      ...base,
      status: 'unknown',
      statusReason: 'The unit database is not configured on this server (MUL_DATABASE_URL is unset), so the archive cannot be counted.',
    };
  }

  try {
    const meta = Object.fromEntries(
      (await query('SELECT key, value FROM mul_meta')).map((r) => [r.key, r.value]),
    );
    const [counts] = await query(
      `SELECT (SELECT COUNT(*) FROM mul_units) AS units,
              (SELECT COUNT(*) FROM classic_sheets) AS classic_sheets,
              (SELECT COUNT(*) FROM mul_availability) AS availability,
              (SELECT COUNT(*) FROM mul_factions) AS factions,
              (SELECT COUNT(*) FROM mul_eras) AS eras`,
    );

    const imported = parseDate(meta.importedAt);

    return {
      ...base,
      sourceUrl: meta.source || base.sourceUrl,
      lastRefreshed: imported ? imported.toISOString() : null,
      upstreamDate: null,
      counts: {
        'Alpha Strike units': Number(counts.units),
        'Classic record sheets': Number(counts.classic_sheets),
        'faction/era availability rows': Number(counts.availability),
        factions: Number(counts.factions),
        eras: Number(counts.eras),
      },
      status: 'final',
      statusReason: imported
        ? `Archived ${agePhrase(imported)}, and final from that moment: masterunitlist.info is gone, so there is no newer version of this data anywhere.`
        : 'Final: masterunitlist.info is gone, so there is no newer version of this data anywhere.',
      caveats: [
        'Faction and era legality comes from the MUL\'s own faction listing rather than the literal pairs printed on each unit page, so generic pools ("Inner Sphere General") expand into every faction they covered — the same way the MUL showed them.',
        `${Number(counts.classic_sheets).toLocaleString('en-GB')} of the ${Number(counts.units).toLocaleString('en-GB')} units have a Classic record sheet; the rest are Alpha Strike only.`,
      ],
    };
  } catch (err) {
    console.error('[freshness] battletech:', err.message);
    return {
      ...base,
      status: 'unknown',
      statusReason: `The database did not answer: ${err.message}`,
    };
  }
}

// ---- catalog sources -------------------------------------------------------

const countOf = (v) => (Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : 0);

function necromundaSource() {
  const cat = CATALOGS.necromunda;
  const base = {
    id: 'necromunda',
    game: 'Necromunda',
    label: '2018 ruleset, House of X era gang lists',
    kind: 'catalog',
    source: 'Hand-assembled from community datasets',
    sourceUrl: 'https://github.com/gyrinx-app/gyrinx',
    lastRefreshed: null,
    upstreamDate: null,
    counts: {},
    status: 'unknown',
    statusReason: '',
    note: '',
    warnings: [],
    gaps: [],
    caveats: [],
  };
  if (!cat) return { ...base, statusReason: 'The catalog file could not be read on this server.' };

  const meta = cat.meta || {};
  const compiled = parseDate(meta.generated);
  const gangs = cat.gangs || {};
  const fighters = Object.values(gangs).reduce((n, g) => n + countOf(g?.fighters), 0);

  const sources = (meta.sources || []).map((s) => {
    const where = s.repo || s.url || 'hand-compiled';
    const at = s.commit ? ` @ ${String(s.commit).slice(0, 8)}` : '';
    return `${where}${at} — ${s.role || s.note || ''}`.trim();
  });

  const rejected = meta.rejected
    ? [`Rejected ${meta.rejected.repo}: ${meta.rejected.why}`]
    : [];
  const skipped = (meta.report?.skipped || []).map((s) => `Skipped — ${s}`);
  const fixes = (meta.report?.fixes || []).map((s) => `Corrected — ${s}`);

  return {
    ...base,
    label: meta.edition || base.label,
    source: meta.source || base.source,
    lastRefreshed: compiled ? compiled.toISOString() : null,
    upstreamDate: meta.edition || null,
    counts: {
      gangs: countOf(gangs),
      fighters,
      weapons: countOf(cat.weapons),
      wargear: countOf(cat.wargear),
      skills: countOf(cat.skills),
    },
    status: ageStatus(compiled, SLOW),
    statusReason: compiled
      ? `Compiled ${agePhrase(compiled)}. Necromunda's community data moves slowly, so this only starts aging at six months.`
      : 'The catalog records no compile date.',
    note: 'There is no single clean machine-readable source for current Necromunda, so this catalog was stitched together from several and the seams are recorded below.',
    caveats: [...(meta.caveats || []), ...sources, ...rejected],
    gaps: [...skipped, ...fixes],
  };
}

function mcpSource() {
  const cat = CATALOGS.mcp;
  const base = {
    id: 'mcp',
    game: 'Marvel Crisis Protocol',
    label: 'Character cards, team tactics and crises',
    kind: 'catalog',
    source: 'BSData community catalogue',
    sourceUrl: 'https://github.com/BSData/marvel-crisis-protocol',
    lastRefreshed: null,
    upstreamDate: null,
    counts: {},
    status: 'unknown',
    statusReason: '',
    note: '',
    warnings: [],
    gaps: [],
    caveats: [],
  };
  if (!cat) return { ...base, statusReason: 'The catalog file could not be read on this server.' };

  const meta = cat.meta || {};
  // The date that decides the status is the date of the DATA, not the date we
  // last rebuilt the file from it. Regenerating a 2024 snapshot in 2026 does
  // not make it 2026 data, and pretending otherwise is exactly the dishonesty
  // this page exists to remove.
  const dataDate = parseDate(meta.dataDate);
  const generated = parseDate(meta.generated);

  return {
    ...base,
    source: meta.source ? 'BSData community catalogue' : base.source,
    sourceUrl: meta.source || base.sourceUrl,
    lastRefreshed: generated ? generated.toISOString() : null,
    upstreamDate: meta.dataDate || null,
    counts: {
      characters: countOf(cat.characters),
      'team tactics cards': countOf(cat.tactics),
      crises: countOf(cat.crises),
      affiliations: countOf(cat.affiliations),
    },
    status: ageStatus(dataDate, SLOW),
    statusReason: dataDate
      ? `The upstream data is dated ${meta.dataDate} — ${agePhrase(dataDate)}. AMG has issued card changes since then that this copy does not have.`
      : 'The catalog records no data date.',
    note: 'This is the one to be careful with. The file was rebuilt recently, but it was rebuilt from a snapshot that is over a year old, so the rebuild date means nothing on its own.',
    warnings: [
      ...(meta.warning ? [meta.warning] : []),
      'Check any threat value against the current AMG card before you pay points for it in a game that matters.',
    ],
    caveats: [
      ...(meta.commitHash ? [`Built from BSData commit ${String(meta.commitHash).slice(0, 12)}.`] : []),
      ...(meta.generated ? [`Catalog file regenerated ${meta.generated} — that is when we last rebuilt it, not when the data was current.`] : []),
    ],
  };
}

function trenchCrusadeSource() {
  const cat = CATALOGS.trenchcrusade;
  const base = {
    id: 'trenchcrusade',
    game: 'Trench Crusade',
    label: 'Warband lists, armouries and battle kit',
    kind: 'catalog',
    source: 'Official free rules + community dataset',
    sourceUrl: 'https://www.trenchcrusade.com/rules/',
    lastRefreshed: null,
    upstreamDate: null,
    counts: {},
    status: 'unknown',
    statusReason: '',
    note: '',
    warnings: [],
    gaps: [],
    caveats: [],
  };
  if (!cat) return { ...base, statusReason: 'The catalog file could not be read on this server.' };

  const meta = cat.meta || {};
  const compiled = parseDate(meta.compiledDate);
  const warbands = cat.warbands || [];
  const units = warbands.reduce((n, w) => n + countOf(w?.units), 0);

  return {
    ...base,
    label: meta.rulesVersion ? `Rules version ${meta.rulesVersion}` : base.label,
    lastRefreshed: compiled ? compiled.toISOString() : null,
    upstreamDate: meta.rulesVersion || null,
    sourceUrl: (meta.sources || [])[0]?.url || base.sourceUrl,
    counts: {
      warbands: countOf(warbands),
      ...(units ? { units } : {}),
      'battle kit entries': countOf(cat.battlekit),
    },
    status: ageStatus(compiled, SLOW),
    statusReason: compiled
      ? `Compiled ${agePhrase(compiled)} against rules version ${meta.rulesVersion || 'unknown'}.`
      : 'The catalog records no compile date.',
    note: meta.note || '',
    // The gap list is the point of this entry. Where a value could not be
    // confirmed against the official PDF, the unit was left out and written
    // down here instead of guessed — so an absence in the builder is a
    // recorded decision, not a bug.
    gaps: meta.gaps || [],
    caveats: (meta.sources || []).map((s) => `${s.url}${s.note ? ` — ${s.note}` : ''}`),
  };
}

function bloodBowlSource() {
  const cat = CATALOGS.bb;
  const base = {
    id: 'bloodbowl',
    game: 'Blood Bowl',
    label: 'BB2025 team rosters, positions and skills',
    kind: 'catalog',
    source: 'Scraped from the BB2025 rulebook by our own Discord bot toolchain',
    sourceUrl: null,
    lastRefreshed: null,
    upstreamDate: null,
    counts: {},
    status: 'unknown',
    statusReason: '',
    note: '',
    warnings: [],
    gaps: [],
    caveats: [],
  };
  if (!cat) return { ...base, statusReason: 'The catalog file could not be read on this server.' };

  const teams = cat.teams || {};
  const positions = Object.values(teams).reduce((n, t) => n + countOf(t?.positions), 0);
  const skills = Object.values(cat.skills?.byCategory || {}).reduce((n, l) => n + countOf(l), 0);

  const counts = {
    teams: countOf(teams),
    positions,
    skills,
    'rules text entries': countOf(cat.descriptions),
  };

  const meta = cat.meta;

  // Older copies of this catalog predate the generator recording anything.
  // Rather than guess an age from the file's timestamp, say it is unrecorded.
  if (!meta || !meta.capturedDate) {
    return {
      ...base,
      counts,
      status: 'unknown',
      statusReason: 'This copy of the catalog carries no provenance — no capture date, no source. Its age genuinely is not recorded, so we do not claim one.',
      note: 'Rebuilding it with the current build_bb_catalog.py would stamp where and when it came from.',
      warnings: [
        'Treat costs and statlines as needing a look at the rulebook if a game hinges on them.',
      ],
    };
  }

  // Blood Bowl is the one game here with no feed to follow: the rules are not
  // published openly, so there is nothing to poll and nothing to schedule.
  // It ages until someone re-captures it by hand, and the page says so rather
  // than implying an automation exists.
  const captured = parseDate(meta.capturedDate);
  const status = ageStatus(captured, ANNUAL);

  return {
    ...base,
    counts,
    source: `Community reference for ${meta.edition || 'BB2025'}, captured by hand`,
    sourceUrl: null,
    lastRefreshed: null,
    upstreamDate: meta.capturedDate,
    status,
    statusReason: captured
      ? `Captured ${agePhrase(captured)}. Nothing refreshes this on a schedule.`
      : 'Capture date could not be read.',
    note: meta.note || '',
    warnings: [
      'Blood Bowl is the only game here that nothing keeps current automatically — its rules are not published openly, so there is no feed to follow. It goes out of date quietly after an FAQ.',
    ],
    caveats: [
      `Captured from ${(meta.capturedFrom || []).join(', ') || 'a community reference'} on ${meta.capturedDate}, built by ${meta.pipeline || 'the club bot'}.`,
      'Re-capturing after a new FAQ is a manual job, on purpose.',
    ],
  };
}

// ---- payload ---------------------------------------------------------------

const CACHE_MS = 60_000;
let cache = null; // { at, payload }

async function payload() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.payload;

  // The database sources are settled independently: a broken wh40k_meta must
  // not cost us the BattleTech counts, and neither may cost us the catalogs.
  const [wh40k, battletech] = await Promise.all([
    wh40kSource().catch((err) => ({ id: 'wh40k', game: 'Warhammer 40,000', kind: 'database', status: 'unknown', statusReason: err.message, counts: {}, warnings: [], gaps: [], caveats: [] })),
    battletechSource().catch((err) => ({ id: 'battletech', game: 'BattleTech — Alpha Strike & Classic', kind: 'database', status: 'unknown', statusReason: err.message, counts: {}, warnings: [], gaps: [], caveats: [] })),
  ]);

  const out = {
    generatedAt: new Date().toISOString(),
    databaseConfigured: available(),
    sources: [
      wh40k,
      battletech,
      necromundaSource(),
      mcpSource(),
      trenchCrusadeSource(),
      bloodBowlSource(),
    ],
  };

  cache = { at: Date.now(), payload: out };
  return out;
}

// mount(app, { memberReader }) — wired from server/index.js so this module
// stays free of any auth details beyond "members can read".
function mount(app, { memberReader }) {
  app.get('/api/data-freshness', memberReader, async (req, res) => {
    try {
      res.json(await payload());
    } catch (err) {
      // Should be unreachable: every source settles itself. Belt and braces.
      console.error('[freshness] payload:', err.message);
      res.status(500).json({ error: 'Could not assemble the data report.' });
    }
  });
}

module.exports = { available, payload, mount };
