// Game Night — live at-the-table play tracking API + realtime sync.
//
// Mounted from index.js with the app's existing auth helpers so this module
// adds routes without owning any auth policy of its own:
//
//   const gameNight = require('./table');
//   gameNight.mount(app, io, { authed, memberReader, builders, db });
//
// Design notes:
// - Unit stats are SNAPSHOTTED into the table at creation (via the builders
//   database) so a live game keeps working even if that database goes down
//   mid-session. A table is the record sheet, not a view over the archive.
//   The same rule holds for Classic BattleTech (the whole classic_sheets row
//   is copied into the table) and Warhammer 40k (the condensed datasheet is).
// - State changes are single-field patches, validated hard server-side against
//   the snapshot's maxima, then broadcast over a socket.io namespace so every
//   phone/iPad at the table shows the same sheet.
// - Sockets mirror the Mad Ork Lands pattern in index.js: the connection is
//   open, identity comes from an optional token in the payload (db.userByToken)
//   — knowing the 6-hex join code is what admits you to a table's room, same
//   as at the physical table.
const crypto = require('crypto');
const store = require('./tablestore');
const lists = require('./liststore');   // My Lists: solo play-reference lists
const alphaStrike = require('../public/builders/alphastrike.js');
const wh40k = require('./wh40k');       // module functions called directly, not over HTTP
const classic = require('./classic');   // classic_sheets reader (same DB as builders)

// Game registry — the lobby renders from this, and leagueGame maps a table's
// summary onto the league tracker's match report.
const GAMES = {
  'battletech-as': { name: 'BattleTech — Alpha Strike', leagueGame: 'battletech' },
  'battletech-classic': { name: 'BattleTech — Classic', leagueGame: 'battletech' },
  'wh40k': { name: 'Warhammer 40k', leagueGame: 'wh40k' },
};

// My Lists covers everything the tables do plus the paste-only games: their
// units come from a text export of our own builders (or any list that follows
// the same shape), parsed into simple stat cards — the paste carries the data.
const LIST_GAMES = {
  ...GAMES,
  necromunda: { name: 'Necromunda' },
  mcp: { name: 'Marvel Crisis Protocol' },
  trenchcrusade: { name: 'Trench Crusade' },
};

// Alpha Strike critical-hit maxima (per the master unit card):
// Engine 2 (second = destroyed), Fire Control 4, MP 4, Weapons 4.
const CRIT_MAX = { engine: 2, fireControl: 4, mp: 4, weapons: 4 };
const MAX_SIDES = 4;
const MAX_HEAT = 4;            // Alpha Strike heat scale
const CLASSIC_MAX_HEAT = 30;   // Total Warfare heat scale
const CLASSIC_PILOT_MAX = 6;   // pilot hits: 6th = dead
const MAX_ARMY_UNITS = 40;     // per side, wh40k
const MAX_40K_MODELS = 30;     // per unit

// Number() says null and '' are 0 and true is 1, which would let a client
// post null at a bounded field and have it silently accepted as zero. Only
// real numbers and numeric strings are values here.
const toInt = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) : NaN;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : NaN;
  }
  return NaN;
};
const clampSkill = (v, dflt) => {
  const n = toInt(v);
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), 8) : dflt;
};

// ---------------------------------------------------------------------------
// Alpha Strike snapshot + patch (unchanged behavior)
// ---------------------------------------------------------------------------

// Freeze one hydrated builders unit into a table record-sheet entry.
function snapshotUnit(u) {
  const skill = Number.isFinite(Number(u.skill)) ? Math.round(Number(u.skill)) : 4;
  return {
    uid: crypto.randomBytes(4).toString('hex'),
    unitId: u.id,                       // MUL id, kept for linking back to the builder
    name: String(u.name || 'Unit').slice(0, 60),
    skill,
    pv: alphaStrike.pvForSkill(u.pv, skill),
    maxArmor: Math.max(0, toInt(u.armor) || 0),
    maxStruct: Math.max(1, toInt(u.structure) || 1),
    // Display-line stats — snapshotted too, so the card renders with the DB down.
    move: u.move ?? null,
    tmm: u.tmm ?? alphaStrike.tmmForMove(u.move),
    damage: u.damage ?? null,
    overheat: u.overheat ?? 0,
    abilities: u.abilities ?? '',
    // Live state
    armorHit: 0,
    structHit: 0,
    crits: { engine: 0, fireControl: 0, mp: 0, weapons: 0 },
    heat: 0,
    notes: '',
    destroyed: false,
  };
}

// A unit is out when structure is gone or the engine takes its second crit.
function autoDestroyed(u) {
  return u.structHit >= u.maxStruct || u.crits.engine >= CRIT_MAX.engine;
}

// Apply one validated patch to an Alpha Strike unit.
// Returns { error } or { msg } (log line).
function applyUnitPatch(u, field, value) {
  if (field === 'armorHit') {
    const n = toInt(value);
    if (!(n >= 0 && n <= u.maxArmor)) return { error: `armor is 0-${u.maxArmor}` };
    u.armorHit = n;
    return { msg: `${u.name}: armor ${u.maxArmor - n}/${u.maxArmor}` };
  }
  if (field === 'structHit') {
    const n = toInt(value);
    if (!(n >= 0 && n <= u.maxStruct)) return { error: `structure is 0-${u.maxStruct}` };
    u.structHit = n;
    u.destroyed = autoDestroyed(u);
    return { msg: `${u.name}: structure ${u.maxStruct - n}/${u.maxStruct}${u.destroyed ? ' — DESTROYED' : ''}` };
  }
  if (field === 'heat') {
    const n = toInt(value);
    if (!(n >= 0 && n <= MAX_HEAT)) return { error: `heat is 0-${MAX_HEAT}` };
    u.heat = n;
    return { msg: `${u.name}: heat ${n}` };
  }
  if (field.startsWith('crits.')) {
    const key = field.slice('crits.'.length);
    if (!(key in CRIT_MAX)) return { error: 'unknown crit' };
    const n = toInt(value);
    if (!(n >= 0 && n <= CRIT_MAX[key])) return { error: `${key} crits are 0-${CRIT_MAX[key]}` };
    u.crits[key] = n;
    if (key === 'engine') u.destroyed = autoDestroyed(u);
    return { msg: `${u.name}: ${key} crit ${n}/${CRIT_MAX[key]}${u.destroyed && key === 'engine' ? ' — DESTROYED' : ''}` };
  }
  return { error: 'unknown field' };
}

// ---------------------------------------------------------------------------
// Classic BattleTech snapshot + patch
// ---------------------------------------------------------------------------

// Freeze one unit into a classic record-sheet entry. `hyd` is the hydrated
// builders unit (name + battle value), `raw` the saved-force entry (crew
// skills), `sheet` the full classic_sheets row from server/classic.js — the
// whole sheet is stored so the table works with the database down.
function snapshotClassicUnit(hyd, raw, sheet) {
  const gunnery = clampSkill(raw?.gunnery, 4);
  const piloting = clampSkill(raw?.piloting, 5);
  const baseBV = Number.isFinite(Number(hyd.bv)) ? Number(hyd.bv) : null;

  // Expand weapon entries with count > 1 into individual toggleable weapons.
  const weapons = [];
  for (const w of Array.isArray(sheet.weapons) ? sheet.weapons : []) {
    const count = Math.min(Math.max(toInt(w.count) || 1, 1), 12);
    for (let i = 0; i < count && weapons.length < 60; i++) {
      weapons.push({ name: String(w.name || '?').slice(0, 60), loc: String(w.location || '?').slice(0, 4) });
    }
  }

  // Sanitize the jsonb shapes into plain ints / 12-slot arrays.
  const armor = {};
  for (const [loc, v] of Object.entries(sheet.armor || {})) {
    const n = toInt(v);
    if (n >= 0) armor[loc] = n;
  }
  const internals = {};
  for (const [loc, v] of Object.entries(sheet.internals || {})) {
    const n = toInt(v);
    if (n >= 1) internals[loc] = n;
  }
  const crits = {};
  for (const [loc, slots] of Object.entries(sheet.crits || {})) {
    crits[loc] = (Array.isArray(slots) ? slots.slice(0, 12) : [])
      .map((s) => (s == null ? null : String(s).slice(0, 60)));
  }

  const armorHit = {};
  for (const loc of Object.keys(armor)) armorHit[loc] = 0;
  const structHit = {};
  for (const loc of Object.keys(internals)) structHit[loc] = 0;
  const critHits = {};
  for (const loc of Object.keys(crits)) critHits[loc] = [];

  return {
    uid: crypto.randomBytes(4).toString('hex'),
    unitId: hyd.id,
    name: String(`${sheet.chassis || ''} ${sheet.model || ''}`.trim() || hyd.name || 'Unit').slice(0, 60),
    gunnery,
    piloting,
    baseBV,
    bv: baseBV === null ? null : alphaStrike.bvForCrew(baseBV, gunnery, piloting),
    sheet: {
      chassis: sheet.chassis, model: sheet.model, config: sheet.config,
      mass: sheet.mass, techBase: sheet.techBase, era: sheet.era, role: sheet.role,
      engine: sheet.engine, structureType: sheet.structureType,
      heatSinks: sheet.heatSinks, heatSinkType: sheet.heatSinkType,
      walkMp: sheet.walkMp, jumpMp: sheet.jumpMp, armorType: sheet.armorType,
      quirks: Array.isArray(sheet.quirks) ? sheet.quirks.slice(0, 20) : [],
      armor, internals, crits, weapons,
    },
    // Live state
    armorHit,                 // { LOC: pips marked }
    structHit,                // { LOC: pips marked }
    heat: 0,                  // 0..30
    critHits,                 // { LOC: [slot indexes marked] }
    weaponsOut: [],           // indexes into sheet.weapons
    pilotHits: 0,             // 0..6 (6 = dead)
    notes: '',
    destroyed: false,
  };
}

// Marked engine crit slots across all locations (per the snapshot's own crit
// names — we follow the sheet data, not a re-derived engine table).
function classicEngineCrits(u) {
  let n = 0;
  for (const [loc, slots] of Object.entries(u.critHits || {})) {
    const names = u.sheet.crits[loc] || [];
    for (const s of slots) if (/engine/i.test(String(names[s] || ''))) n++;
  }
  return n;
}

// Destroyed on: CT structure gone, 3 engine crits, or pilot dead.
function classicAutoDestroyed(u) {
  const ct = u.sheet.internals.CT;
  if (ct != null && (u.structHit.CT || 0) >= ct) return true;
  if (classicEngineCrits(u) >= 3) return true;
  if (u.pilotHits >= CLASSIC_PILOT_MAX) return true;
  return false;
}

// Apply one validated patch to a classic unit. `status` gates crew edits to
// setup. Returns { error } or { msg }.
function applyClassicPatch(u, field, value, status) {
  if (field === 'gunnery' || field === 'piloting') {
    if (status !== 'setup') return { error: 'crew skills lock once da game starts' };
    const n = toInt(value);
    if (!(n >= 0 && n <= 8)) return { error: `${field} is 0-8` };
    u[field] = n;
    u.bv = u.baseBV === null ? null : alphaStrike.bvForCrew(u.baseBV, u.gunnery, u.piloting);
    return { msg: `${u.name}: ${field} ${n}${u.bv !== null ? ` (BV ${u.bv})` : ''}` };
  }
  if (field === 'heat') {
    const n = toInt(value);
    if (!(n >= 0 && n <= CLASSIC_MAX_HEAT)) return { error: `heat is 0-${CLASSIC_MAX_HEAT}` };
    u.heat = n;
    return { msg: `${u.name}: heat ${n}` };
  }
  if (field === 'pilotHits') {
    const n = toInt(value);
    if (!(n >= 0 && n <= CLASSIC_PILOT_MAX)) return { error: `pilot hits are 0-${CLASSIC_PILOT_MAX}` };
    u.pilotHits = n;
    u.destroyed = classicAutoDestroyed(u);
    return { msg: `${u.name}: pilot hit ${n}/${CLASSIC_PILOT_MAX}${n >= CLASSIC_PILOT_MAX ? ' — PILOT DEAD' : ''}${u.destroyed ? ' — DESTROYED' : ''}` };
  }
  if (field.startsWith('armorHit.')) {
    const loc = field.slice('armorHit.'.length);
    const max = u.sheet.armor[loc];
    if (max == null) return { error: 'unknown location' };
    const n = toInt(value);
    if (!(n >= 0 && n <= max)) return { error: `${loc} armor is 0-${max}` };
    u.armorHit[loc] = n;
    return { msg: `${u.name}: ${loc} armor ${max - n}/${max}` };
  }
  if (field.startsWith('structHit.')) {
    const loc = field.slice('structHit.'.length);
    const max = u.sheet.internals[loc];
    if (max == null) return { error: 'unknown location' };
    const n = toInt(value);
    if (!(n >= 0 && n <= max)) return { error: `${loc} structure is 0-${max}` };
    u.structHit[loc] = n;
    u.destroyed = classicAutoDestroyed(u);
    return { msg: `${u.name}: ${loc} structure ${max - n}/${max}${u.destroyed ? ' — DESTROYED' : ''}` };
  }
  if (field.startsWith('crit.')) {
    // crit.<LOC>.<slot> = true|false (marked / cleared)
    const parts = field.split('.');
    if (parts.length !== 3) return { error: 'bad crit field' };
    const loc = parts[1];
    const slot = toInt(parts[2]);
    const names = u.sheet.crits[loc];
    if (!names) return { error: 'unknown location' };
    if (!(slot >= 0 && slot < names.length) || names[slot] == null) return { error: 'no crit slot there' };
    const marked = new Set(u.critHits[loc] || []);
    if (value) marked.add(slot); else marked.delete(slot);
    u.critHits[loc] = [...marked].sort((a, b) => a - b);
    u.destroyed = classicAutoDestroyed(u);
    return { msg: `${u.name}: ${loc} crit ${value ? 'hit' : 'cleared'} — ${names[slot]}${u.destroyed ? ' — DESTROYED' : ''}` };
  }
  if (field.startsWith('weaponOut.')) {
    const idx = toInt(field.slice('weaponOut.'.length));
    const w = u.sheet.weapons[idx];
    if (!w) return { error: 'no such weapon' };
    const out = new Set(u.weaponsOut || []);
    if (value) out.add(idx); else out.delete(idx);
    u.weaponsOut = [...out].sort((a, b) => a - b);
    return { msg: `${u.name}: ${w.name} (${w.loc}) ${value ? 'destroyed' : 'restored'}` };
  }
  return { error: 'unknown field' };
}

// ---------------------------------------------------------------------------
// Warhammer 40k snapshot + patch
// ---------------------------------------------------------------------------

// Freeze one condensed datasheet into a table entry. Wound pips are grouped
// per model: modelCount groups of woundsPer, a model dies when its group
// fills, the unit is destroyed when every model is dead.
function snapshotWh40kUnit(ds, modelCount) {
  let count = toInt(modelCount);
  if (!(count >= 1)) {
    // Derive the default from unit composition, taking the low end of ranges
    // like "4-5 Custodian Guard" and summing lines ("1 Sergeant" + "4 Boyz").
    count = 0;
    for (const line of ds.composition || []) {
      const m = String(line).match(/^(\d+)/);
      if (m) count += Number(m[1]);
    }
    if (!(count >= 1)) count = 1;
  }
  count = Math.min(count, MAX_40K_MODELS);
  const woundsPer = Math.min(Math.max(toInt(ds.models?.[0]?.w) || 1, 1), 40);

  const wpn = (r) => ({
    name: String(r.name || '?').slice(0, 60),
    range: r.range, a: r.a, bs: r.bs_ws, s: r.s, ap: r.ap, d: r.d,
    kw: String(r.description || '').slice(0, 200),   // weapon keywords line
  });

  return {
    uid: crypto.randomBytes(4).toString('hex'),
    sheetId: ds.id,
    name: String(ds.name || 'Unit').slice(0, 60),
    faction: ds.faction?.name || '',
    statline: (ds.models || []).slice(0, 6).map((m) => ({
      name: m.name, m: m.m, t: m.t, sv: m.sv,
      inv: m.inv_sv && m.inv_sv !== '-' ? m.inv_sv : null,   // '-' means no invuln
      w: m.w, ld: m.ld, oc: m.oc,
    })),
    weapons: {
      ranged: (ds.wargear?.ranged || []).slice(0, 20).map(wpn),
      melee: (ds.wargear?.melee || []).slice(0, 20).map(wpn),
    },
    // Descriptions carry Wahapedia HTML — the client renders them inside a
    // sanitizing container (script/style/on* stripped there).
    abilities: (ds.abilities || []).filter((a) => a.name).slice(0, 20)
      .map((a) => ({ name: String(a.name).slice(0, 80), description: String(a.description || '') })),
    keywords: {
      faction: (ds.keywords?.faction || []).slice(0, 10),
      unit: (ds.keywords?.unit || []).slice(0, 20),
    },
    // Live state
    modelCount: count,
    woundsPer,
    wounds: Array(count).fill(0),   // wounds taken, per model
    notes: '',
    destroyed: false,
  };
}

function wh40kAutoDestroyed(u) {
  return u.wounds.every((w) => w >= u.woundsPer);
}

function applyWh40kPatch(u, field, value) {
  if (field.startsWith('wounds.')) {
    const i = toInt(field.slice('wounds.'.length));
    if (!(i >= 0 && i < u.modelCount)) return { error: 'no such model' };
    const n = toInt(value);
    if (!(n >= 0 && n <= u.woundsPer)) return { error: `wounds are 0-${u.woundsPer}` };
    u.wounds[i] = n;
    u.destroyed = wh40kAutoDestroyed(u);
    const dead = u.wounds.filter((w) => w >= u.woundsPer).length;
    return { msg: `${u.name}: model ${i + 1} at ${u.woundsPer - n}/${u.woundsPer}W (${u.modelCount - dead}/${u.modelCount} models)${u.destroyed ? ' — DESTROYED' : ''}` };
  }
  return { error: 'unknown field' };
}

// ---------------------------------------------------------------------------
// Simple stat cards (Necromunda / MCP / Trench Crusade) — paste-parsed lists
// ---------------------------------------------------------------------------

// One card shape for every paste-only game: a name line, one-line statlines,
// gear + profiles, abilities as text. Tracking is a single wound counter
// (when the export carries one) plus the shared notes/destroyed fields.
function snapshotSimpleUnit(p) {
  const line = (s, n) => String(s ?? '').slice(0, n);
  return {
    uid: crypto.randomBytes(4).toString('hex'),
    name: line(p.name || 'Unit', 60),
    subtitle: line(p.subtitle, 90),
    cost: line(p.cost, 30) || null,
    statlines: (p.statlines || []).slice(0, 6).map((s) => line(s, 180)),
    gear: (p.gear || []).slice(0, 30).map((s) => line(s, 120)),
    gearProfiles: (p.gearProfiles || []).slice(0, 40).map((s) => line(s, 220)),
    keywords: (p.keywords || []).slice(0, 20).map((s) => line(s, 60)),
    abilities: (p.abilities || []).slice(0, 25)
      .map((a) => ({ name: line(a.name, 80), text: line(a.text, 1200) })),
    // Live state
    maxWounds: Number.isFinite(Number(p.maxWounds)) && Number(p.maxWounds) >= 1
      ? Math.min(Math.round(Number(p.maxWounds)), 40) : null,
    woundsTaken: 0,
    notes: '',
    destroyed: false,
  };
}

function applySimplePatch(u, field, value) {
  if (field === 'woundsTaken') {
    if (!(u.maxWounds >= 1)) return { error: 'dis unit has no wound track' };
    const n = toInt(value);
    if (!(n >= 0 && n <= u.maxWounds)) return { error: `wounds are 0-${u.maxWounds}` };
    u.woundsTaken = n;
    u.destroyed = n >= u.maxWounds;
    return { msg: `${u.name}: ${u.maxWounds - n}/${u.maxWounds} wounds${u.destroyed ? ' — DOWN' : ''}` };
  }
  return { error: 'unknown field' };
}

// ---- paste parsers (match our own builders' text exports) ------------------
// Coverage note: each parser reports the non-blank lines it could not place
// in `unparsed`, so the client can show what got dropped instead of hiding it.

// public/builders/necromunda exportSheet(): header / "=== fence" / fighter
// blocks ("LABEL — Type (Category) — 130cr", statline, "Gear: …", indented
// weapon profile lines) / "=== fence" / footer.
function parseNecromundaExport(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const header = [];
  const units = [];
  const unparsed = [];
  let inBody = false;
  let cur = null;
  for (const raw of lines) {
    const s = raw.trim();
    if (/^={4,}$/.test(s)) {
      if (inBody) break;                 // second fence: footer starts
      inBody = true;
      continue;
    }
    if (!s) continue;
    if (!inBody) { header.push(s); continue; }

    const start = s.match(/^(.+?) — (.+?) \((.+?)\) — (\d+)cr$/);
    if (start && !/^\s/.test(raw)) {
      cur = {
        name: start[1], subtitle: `${start[2]} (${start[3]})`, cost: `${start[4]}cr`,
        statlines: [], gear: [], gearProfiles: [], keywords: [], abilities: [], maxWounds: null,
      };
      units.push(cur);
      continue;
    }
    if (cur && /^M[\d-]/.test(s) && /\bWS/.test(s)) {
      cur.statlines.push(s);
      const w = s.match(/\bW(\d+)\b/);
      if (w) cur.maxWounds = Number(w[1]);
      continue;
    }
    if (cur && /^Gear:/i.test(s)) {
      const g = s.replace(/^Gear:\s*/i, '');
      if (!/^none$/i.test(g)) cur.gear = g.split(/,\s+/);
      continue;
    }
    if (cur && /^\s{2}/.test(raw) && s.includes(':')) {
      cur.gearProfiles.push(s);
      continue;
    }
    unparsed.push(s);
  }
  return { header, sections: [], units, unparsed };
}

// public/builders/mcp rosterText(): name/threat header, then labelled sections
// — characters carry "[threat] Name (stamina h/i, mv M, size S)"; tactics and
// crises are plain indented names (kept as reference sections, not units).
function parseMcpExport(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const header = [];
  const units = [];
  const sections = [];
  const unparsed = [];
  let section = null;
  for (const raw of lines) {
    const s = raw.trim();
    if (!s) continue;
    const sec = s.match(/^(CHARACTERS|TONIGHT'S SQUAD|TEAM TACTICS|EXTRACT CRISES|SECURE CRISES)\b(.*)$/);
    if (sec) {
      section = { title: s, kind: sec[1], items: [] };
      if (sec[1] !== 'CHARACTERS') sections.push(section);
      continue;
    }
    if (!section) {
      header.push(s);
      continue;
    }
    // Section entries are indented in the export; a flush-left line after the
    // sections is the catalog warning footer — report it, don't absorb it.
    if (!/^\s/.test(raw)) { unparsed.push(s); continue; }
    if (section.kind === 'CHARACTERS') {
      const m = s.match(/^\[(\d+)\]\s+(.+?)(\s*\*LEADER\*)?\s*\(stamina ([^,]+), mv ([^,]+), size ([^)]+)\)$/);
      if (m) {
        const healthy = Number(m[4].split('/')[0]);
        const injured = Number(m[4].split('/')[1]);
        units.push({
          name: m[2], subtitle: `Threat ${m[1]}${m[3] ? ' — LEADER' : ''}`, cost: `${m[1]} threat`,
          statlines: [`Stamina ${m[4]} — Mv ${m[5]} — Size ${m[6]}`],
          gear: [], gearProfiles: [], keywords: [], abilities: [],
          maxWounds: Number.isFinite(healthy)
            ? healthy + (Number.isFinite(injured) ? injured : 0) : null,
        });
        continue;
      }
      unparsed.push(s);
      continue;
    }
    // squad / tactics / crises entries ride along as reference sections
    section.items.push(s.replace(/^\[(\d+)\]\s+/, '[$1] '));
  }
  return { header, sections: sections.filter((x) => x.items.length).map(({ title, items }) => ({ title, items })), units, unparsed };
}

// public/builders/trenchcrusade exportSheet(): header (incl. "* special"
// lines) / fence / unit blocks ("LABEL — Name (type) — 90d 1g", indented
// statline/Keywords/abilities/Battlekit, deeper-indented item profiles).
function parseTrenchcrusadeExport(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const header = [];
  const units = [];
  const unparsed = [];
  let inBody = false;
  let cur = null;
  for (const raw of lines) {
    const s = raw.trim();
    if (/^={4,}$/.test(s)) {
      if (inBody) break;
      inBody = true;
      continue;
    }
    if (!s) continue;
    if (!inBody) { header.push(s); continue; }

    if (!/^\s/.test(raw)) {
      const start = s.match(/^(.+?) — (.+?) \((.+?)\)(?: — (.*))?$/);
      if (start) {
        cur = {
          name: start[1], subtitle: `${start[2]} (${start[3]})`, cost: start[4] || null,
          statlines: [], gear: [], gearProfiles: [], keywords: [], abilities: [], maxWounds: null,
        };
        units.push(cur);
        continue;
      }
      unparsed.push(s);
      continue;
    }
    if (!cur) { unparsed.push(s); continue; }
    if (/^\s{4,}/.test(raw)) { cur.gearProfiles.push(s); continue; }   // item profiles
    if (/Armour/i.test(s) && !s.includes(': ')) { cur.statlines.push(s); continue; }
    const kw = s.match(/^Keywords:\s*(.*)$/i);
    if (kw) { cur.keywords = kw[1].split(/,\s+/); continue; }
    const kit = s.match(/^Battlekit:\s*(.*)$/i);
    if (kit) { cur.gear = kit[1].split(/,\s+/); continue; }
    const ab = s.match(/^([^:]{1,60}):\s+(.*)$/);
    if (ab) {
      // alt profiles print as "Name: <statline> — base N" — keep them with the stats
      if (/Armour/i.test(ab[2])) cur.statlines.push(s);
      else cur.abilities.push({ name: ab[1], text: ab[2] });
      continue;
    }
    unparsed.push(s);
  }
  return { header, sections: [], units, unparsed };
}

const SIMPLE_PARSERS = {
  necromunda: parseNecromundaExport,
  mcp: parseMcpExport,
  trenchcrusade: parseTrenchcrusadeExport,
};

// ---------------------------------------------------------------------------
// BattleTech pasted-list resolution (any builder's text export)
// ---------------------------------------------------------------------------

const normaliseBt = (s) => String(s)
  .toLowerCase()
  .replace(/[’']s\b/g, 's')
  .replace(/[^a-z0-9 ]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// Pull a unit name (+ optional skill / crew) out of one pasted line. Handles
// our own force lists, MUL/Flechs-style "Atlas AS7-D (52)" cost tags, and
// MegaMek-ish "Atlas AS7-D — Gunnery 3 / Piloting 4".
function parseBtLine(raw) {
  let s = raw.trim();
  if (!s) return null;
  if (/^\s/.test(raw) || /^[•◦*·>]/.test(s)) return null;
  if (/^[=~_#+*-]{3,}/.test(s)) return null;
  if (/^(total|force|lance|star|binary|company|era|faction|rules|tech|catalog|raising havok|built|exported|created|battle value|point value|pv\b|bv\b)/i.test(s)) return null;

  let count = 1;
  const lead = s.match(/^(\d+)\s*[x×]\s+/i);
  if (lead) { count = Math.min(Number(lead[1]), 10); s = s.slice(lead[0].length); }

  let gunnery = null;
  let piloting = null;
  const crew = s.match(/g(?:unnery)?\s*:?\s*(\d)\s*[/,]\s*p(?:iloting)?\s*:?\s*(\d)/i);
  if (crew) { gunnery = Number(crew[1]); piloting = Number(crew[2]); s = s.replace(crew[0], ' '); }

  let skill = null;
  const sk = s.match(/[([]\s*(?:skill|sk)\s*:?\s*(\d)\s*[)\]]/i) || s.match(/\bskill\s*:?\s*(\d)\b/i);
  if (sk) { skill = Number(sk[1]); s = s.replace(sk[0], ' '); }

  // cost tags: "(52 pts)", "[52pv]", "BV 2000", "@ 52", bare trailing "(52)"
  s = s.replace(/[([{]?\s*\d+\s*(?:pts?|points|pv|bv)\s*[)\]}]?/ig, ' ');
  s = s.replace(/[@—-]\s*\d+\s*$/g, ' ');
  const bare = s.match(/\(\s*(\d)\s*\)\s*$/);
  if (bare && skill === null) { skill = Number(bare[1]); s = s.slice(0, bare.index); }
  s = s.replace(/\(\s*\d+\s*\)\s*$/g, ' ');

  s = s.replace(/[[\]()|]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s || /^\d+$/.test(s) || s.length < 2) return null;
  return { name: s, count, skill, gunnery, piloting };
}

// ---------------------------------------------------------------------------
// Shared patch dispatch
// ---------------------------------------------------------------------------

// Fields every game shares, then per-game rules.
function applyPatch(t, u, field, value) {
  if (field === 'notes') {
    if (typeof value !== 'string') return { error: 'notes must be text' };
    u.notes = value.slice(0, 200);
    return { msg: `${u.name}: note updated` };
  }
  if (field === 'destroyed') {
    u.destroyed = Boolean(value);
    return { msg: `${u.name}: ${u.destroyed ? 'marked destroyed' : 'back in da fight'}` };
  }
  if (t.game === 'battletech-classic') return applyClassicPatch(u, field, value, t.status);
  if (t.game === 'wh40k') return applyWh40kPatch(u, field, value);
  if (SIMPLE_PARSERS[t.game]) return applySimplePatch(u, field, value);
  return applyUnitPatch(u, field, value);
}

// Zero a unit's live tracking state back to the snapshot (list reset).
function resetTracking(game, u) {
  u.notes = '';
  u.destroyed = false;
  if (game === 'battletech-as') {
    u.armorHit = 0;
    u.structHit = 0;
    u.heat = 0;
    u.crits = { engine: 0, fireControl: 0, mp: 0, weapons: 0 };
  } else if (game === 'battletech-classic') {
    for (const k of Object.keys(u.armorHit || {})) u.armorHit[k] = 0;
    for (const k of Object.keys(u.structHit || {})) u.structHit[k] = 0;
    for (const k of Object.keys(u.critHits || {})) u.critHits[k] = [];
    u.weaponsOut = [];
    u.heat = 0;
    u.pilotHits = 0;
  } else if (game === 'wh40k') {
    u.wounds = u.wounds.map(() => 0);
  } else {
    u.woundsTaken = 0;
  }
}

// ---------------------------------------------------------------------------

// Lean listing shape for the lobby.
function summary(t) {
  return {
    id: t.id,
    game: t.game,
    gameName: GAMES[t.game]?.name ?? t.game,
    name: t.name,
    createdBy: t.createdBy,
    status: t.status,
    round: t.round,
    updated: t.updated,
    sides: (t.sides || []).map((s) => ({ name: s.name, owner: s.owner, units: s.units.length })),
  };
}

// Per-side destroyed counts -> the league's match-report shape (battletech and
// wh40k share the vp/kills/lost column set). kills = enemy units downed, lost
// = own units downed. vp comes from the caller (objectives are scored on the
// tabletop); for wh40k the side's live VP tracker is the default.
function doneSummary(t, vpBySide) {
  const destroyed = (s) => s.units.filter((u) => u.destroyed).length;
  const totalDestroyed = t.sides.reduce((n, s) => n + destroyed(s), 0);
  return {
    game: GAMES[t.game]?.leagueGame ?? 'battletech',
    table: t.name,
    sides: t.sides.map((s) => {
      const fromBody = toInt(vpBySide[s.name]);
      const vp = Number.isFinite(fromBody) ? fromBody : (toInt(s.vp) || 0);
      return {
        name: s.name,
        vp: Math.max(0, vp),
        kills: totalDestroyed - destroyed(s),
        lost: destroyed(s),
      };
    }),
  };
}

function mount(app, io, deps) {
  const { authed, memberReader, builders, db } = deps;

  // ---- realtime: one room per table on a dedicated namespace, so these
  // handlers never tangle with the Mad Ork Lands listeners on the root io.
  const nsp = io.of('/table');
  const room = (id) => 'table:' + id;

  nsp.on('connection', (socket) => {
    // Join by table id (the join code). Token is optional and only names you
    // in the log — mirroring index.js, where game sockets authenticate via an
    // optional token in the event payload rather than at connect.
    socket.on('join', (payload, cb) => {
      const { id, token } = payload || {};
      const t = store.get(id);
      if (!t) return cb && cb({ error: 'no such table' });
      socket.join(room(t.id));
      const user = token ? db.userByToken(token) : null;
      cb && cb({ ok: true, name: user ? user.name : null, table: t });
    });
    socket.on('leave', (payload) => {
      if (payload && payload.id) socket.leave(room(String(payload.id).toLowerCase()));
    });
  });

  const broadcast = (t, patchInfo) => {
    nsp.to(room(t.id)).emit('state', {
      id: t.id, round: t.round, status: t.status, updated: t.updated, ...patchInfo,
    });
    const last = t.log[t.log.length - 1];
    if (last) nsp.to(room(t.id)).emit('log', last);
  };

  // memberReader admits the bot key without a user; writes need a real account.
  const needUser = (req, res) => {
    const user = authed(req);
    if (!user) res.status(401).json({ error: 'log in first' });
    return user;
  };

  // Build units from raw force entries [{ id, skill, gunnery?, piloting? }].
  // For classic, every unit also needs a classic_sheets row; crew skills come
  // from the entries (hydrateForce strips them, so they are re-paired from
  // the raw entries, which preserves order).
  // Returns { units } or { status, error }.
  async function buildEntriesUnits(entries, game) {
    if (!builders.available()) return { status: 503, error: 'Da unit database ain\'t hooked up — can\'t load dat force.' };
    if (game === 'battletech-classic' && !classic.available()) {
      return { status: 503, error: 'Da classic sheets database ain\'t hooked up.' };
    }
    let hydrated;
    try {
      hydrated = await builders.hydrateForce(entries);
    } catch (err) {
      console.error('[table] hydrate:', err.message);
      return { status: 502, error: 'Unit database is not answering.' };
    }
    if (game !== 'battletech-classic') return { units: hydrated.map(snapshotUnit) };

    // Pair hydrated units back to their raw entries (order-preserving).
    const pairs = [];
    let j = 0;
    for (const e of entries || []) {
      if (j < hydrated.length && Number(e.id) === Number(hydrated[j].id)) {
        pairs.push([hydrated[j], e]);
        j++;
      }
    }
    const units = [];
    const missing = [];
    for (const [hyd, raw] of pairs) {
      let sheet;
      try {
        sheet = await classic.getSheet(hyd.id);
      } catch (err) {
        console.error('[table] classic sheet:', err.message);
        return { status: 502, error: 'Classic sheets database is not answering.' };
      }
      if (!sheet) { missing.push(hyd.name); continue; }
      units.push(snapshotClassicUnit(hyd, raw, sheet));
    }
    if (missing.length) {
      return { status: 400, error: `No classic record sheet for: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}. Drop 'em or play Alpha Strike.` };
    }
    return { units };
  }

  // Build a side's units from one of the CALLER's saved forces — same
  // snapshot path as pasted-list entries above.
  async function buildForceUnits(user, forceName, game) {
    const saved = db.forces(user.name)[String(forceName)];
    if (!saved) return { status: 404, error: `No saved force called "${String(forceName).slice(0, 60)}".` };
    return buildEntriesUnits(saved.units || [], game);
  }

  // Build a wh40k side from a confirmed army list: [{ id, models? }].
  // The client resolves the pasted text first (POST /api/builders/wh40k/
  // resolve-list) and sends only picked datasheet ids here.
  async function buildArmyUnits(army) {
    if (!wh40k.available()) return { status: 503, error: 'Da 40k database ain\'t hooked up.' };
    const list = (Array.isArray(army) ? army : []).slice(0, MAX_ARMY_UNITS);
    if (!list.length) return { status: 400, error: 'Army list came through empty.' };
    const units = [];
    let factionId = null;
    for (const entry of list) {
      let ds;
      try {
        ds = await wh40k.getDatasheet(entry?.id);
      } catch (err) {
        console.error('[table] datasheet:', err.message);
        return { status: 502, error: '40k database is not answering.' };
      }
      if (!ds) return { status: 404, error: `No datasheet with id "${String(entry?.id).slice(0, 20)}".` };
      if (!factionId && ds.faction?.id) factionId = ds.faction.id;
      units.push(snapshotWh40kUnit(ds, entry?.models));
    }
    return { units, factionId };
  }

  // ---- create a table ----
  // body: { game, name, sides: [{ name, forceName?, army? }] }
  // forceName pulls the CREATOR's saved force (battletech games);
  // army is a confirmed wh40k list: [{ id, models? }].
  app.post('/api/table', memberReader, async (req, res) => {
    const user = needUser(req, res);
    if (!user) return;
    const { game, name, sides } = req.body || {};
    if (!GAMES[game]) return res.status(400).json({ error: 'unknown game' });
    const label = String(name || '').trim().slice(0, 60);
    if (!label) return res.status(400).json({ error: 'Give da table a name first.' });
    const rawSides = (Array.isArray(sides) ? sides : []).slice(0, MAX_SIDES);
    if (rawSides.length < 2) return res.status(400).json({ error: 'A game needs at least two sides.' });

    const built = [];
    for (const s of rawSides) {
      const sideName = String(s?.name || '').trim().slice(0, 40) || `Side ${built.length + 1}`;
      let units = [];
      let owner = null;
      if (game === 'wh40k') {
        if (s?.forceName) return res.status(400).json({ error: '40k sides take a pasted army list, not a saved force.' });
        if (Array.isArray(s?.army) && s.army.length) {
          const r = await buildArmyUnits(s.army);
          if (r.error) return res.status(r.status).json({ error: r.error });
          units = r.units;
          owner = user.name;
        }
      } else if (s?.forceName) {
        const r = await buildForceUnits(user, s.forceName, game);
        if (r.error) return res.status(r.status).json({ error: r.error });
        units = r.units;
        owner = user.name;
      }
      const side = { name: sideName, owner, units };
      if (game === 'wh40k') { side.cp = 0; side.vp = 0; }
      built.push(side);
    }

    const r = store.create({ game, name: label, createdBy: user.name, sides: built });
    if (r.error) return res.status(400).json({ error: r.error });
    store.addLog(r.table, `Table opened by ${user.name}`);
    store.update(r.table);
    res.json(r.table);
  });

  // ---- my tables (created, own a side in, or joined by code) ----
  app.get('/api/table', memberReader, (req, res) => {
    const user = authed(req);
    // bot key without a user account sees everything (club-internal anyway)
    const tables = user ? store.byUser(user.name) : store.all();
    res.json({ tables: tables.map(summary) });
  });

  // ---- one table (this is also "join by code") ----
  app.get('/api/table/:id', memberReader, (req, res) => {
    const t = store.get(req.params.id);
    if (!t) return res.status(404).json({ error: 'No table wiv dat code.' });
    const user = authed(req);
    // Opening a table enrolls you: it shows up under "my tables" from then on.
    if (user) {
      const mine = user.name.toLowerCase();
      const known = t.createdBy.toLowerCase() === mine
        || t.sides.some((s) => (s.owner || '').toLowerCase() === mine)
        || (t.members || []).some((m) => m.toLowerCase() === mine);
      if (!known) {
        t.members.push(user.name);
        store.addLog(t, `${user.name} joined da table`);
        store.update(t);
        broadcast(t, {});
      }
    }
    res.json(t);
  });

  // ---- bring units to an empty side (a joiner claiming their side) ----
  // body: { forceName } (battletech games, the CALLER's saved force) or
  //       { army: [{ id, models? }] } (wh40k, a confirmed resolved list)
  app.post('/api/table/:id/side/:idx/units', memberReader, async (req, res) => {
    const user = needUser(req, res);
    if (!user) return;
    const t = store.get(req.params.id);
    if (!t) return res.status(404).json({ error: 'no such table' });
    if (t.status === 'done') return res.status(400).json({ error: 'Dat table is finished.' });
    const idx = toInt(req.params.idx);
    const side = t.sides[idx];
    if (!side) return res.status(404).json({ error: 'no such side' });
    if (side.units.length) return res.status(400).json({ error: `${side.name} already has units on it.` });

    const r = t.game === 'wh40k'
      ? await buildArmyUnits(req.body?.army)
      : await buildForceUnits(user, req.body?.forceName, t.game);
    if (r.error) return res.status(r.status).json({ error: r.error });

    side.units = r.units;
    side.owner = user.name;
    store.addLog(t, `${user.name} brought a force to ${side.name}`);
    store.update(t);
    broadcast(t, { reload: true });
    res.json(t);
  });

  // ---- live state patch ----
  // body: { uid, field, value }         — unit fields
  //       { field: 'round', value }     — table-level
  //       { side, field: 'cp'|'vp', value } — side-level trackers (wh40k)
  app.post('/api/table/:id/state', memberReader, (req, res) => {
    const user = needUser(req, res);
    if (!user) return;
    const t = store.get(req.params.id);
    if (!t) return res.status(404).json({ error: 'no such table' });
    if (t.status === 'done') return res.status(400).json({ error: 'Dat table is finished.' });
    const { uid, side: sideIdx, field, value } = req.body || {};
    if (typeof field !== 'string') return res.status(400).json({ error: 'patch needs a field' });

    if (field === 'round') {
      const n = toInt(value);
      if (!(n >= 1 && n <= 999)) return res.status(400).json({ error: 'round is 1-999' });
      t.round = n;
      t.status = 'playing';
      store.addLog(t, `Round ${n}`);
      store.update(t);
      broadcast(t, {});
      return res.json({ ok: true, round: t.round });
    }

    // Side-level CP / VP trackers (wh40k). Battle round is the shared round.
    if ((field === 'cp' || field === 'vp') && uid == null) {
      if (t.game !== 'wh40k') return res.status(400).json({ error: 'no side trackers in dis game' });
      const side = t.sides[toInt(sideIdx)];
      if (!side) return res.status(404).json({ error: 'no such side' });
      const n = toInt(value);
      const max = field === 'cp' ? 99 : 200;
      if (!(n >= 0 && n <= max)) return res.status(400).json({ error: `${field} is 0-${max}` });
      side[field] = n;
      store.addLog(t, `${side.name}: ${field.toUpperCase()} ${n}`);
      store.update(t);
      broadcast(t, { side: toInt(sideIdx), sideState: { cp: side.cp, vp: side.vp } });
      return res.json({ ok: true, side: toInt(sideIdx), [field]: n });
    }

    const unit = t.sides.flatMap((s) => s.units).find((u) => u.uid === uid);
    if (!unit) return res.status(404).json({ error: 'no such unit' });
    const r = applyPatch(t, unit, field, value);
    if (r.error) return res.status(400).json({ error: r.error });
    // Crew edits are a setup activity; everything else means the game is on.
    if (!(field === 'gunnery' || field === 'piloting' || field === 'notes')) t.status = 'playing';
    store.addLog(t, r.msg);
    store.update(t);
    broadcast(t, { uid: unit.uid, unit });
    res.json({ ok: true, unit });
  });

  // ---- finalize ----
  // body: { vp: { [sideName]: number } } — VP is scored at the table; for
  // wh40k the side's live VP tracker fills in when the body omits a side.
  // Returns a summary shaped for the league's match report.
  app.post('/api/table/:id/done', memberReader, (req, res) => {
    const user = needUser(req, res);
    if (!user) return;
    const t = store.get(req.params.id);
    if (!t) return res.status(404).json({ error: 'no such table' });
    const vpBySide = (req.body && typeof req.body.vp === 'object' && req.body.vp) || {};
    const sum = doneSummary(t, vpBySide);
    t.status = 'done';
    t.result = sum;
    store.addLog(t, `Game over — ${sum.sides.map((s) => `${s.name} ${s.vp}VP (${s.kills} kills)`).join(' vs ')}`);
    store.update(t);
    broadcast(t, { done: sum });
    res.json(sum);
  });

  // ---- scrap a table (creator or nobody) ----
  app.delete('/api/table/:id', memberReader, (req, res) => {
    const user = needUser(req, res);
    if (!user) return;
    const t = store.get(req.params.id);
    if (!t) return res.json({ ok: true });
    if (t.createdBy.toLowerCase() !== user.name.toLowerCase()) {
      return res.status(403).json({ error: 'Only da table\'s creator can scrap it.' });
    }
    nsp.to(room(t.id)).emit('scrapped', { id: t.id });
    res.json(store.remove(t.id));
  });

  // The lobby renders games from this registry so more games can slot in.
  app.get('/api/table-games', memberReader, (req, res) => {
    res.json(Object.entries(GAMES).map(([id, g]) => ({ id, name: g.name })));
  });

  // =========================================================================
  // My Lists — solo play-reference lists. Saved server-side on the user so a
  // list built on the desktop reads on the iPad. Same snapshot shapes and the
  // same per-field patch validation as the tables, minus the sockets.
  // =========================================================================

  const MAX_LIST_UNITS = 60;

  // Match pasted unit names against mul_units by name (exact → normalized →
  // fuzzy containment), reporting honest unmatched lines. Works with a list
  // pasted from ANY BattleTech builder: skill defaults to 4 (AS) and crew to
  // 4/5 (classic) unless the paste carries them.
  async function resolveBtList(text, game) {
    if (!builders.available()) return { status: 503, error: 'Da unit database ain\'t hooked up.' };
    const mode = game === 'battletech-classic' ? 'tw' : undefined;
    const units = [];
    const unmatched = [];
    for (const raw of String(text ?? '').split(/\r?\n/)) {
      const parsed = parseBtLine(raw);
      if (!parsed) continue;
      const lower = parsed.name.toLowerCase();
      const norm = normaliseBt(parsed.name);
      let rows;
      try {
        rows = (await builders.search({ q: parsed.name, limit: 100, mode })).units;
      } catch (err) {
        console.error('[lists] bt search:', err.message);
        return { status: 502, error: 'Unit database is not answering.' };
      }
      let matches = rows.filter((r) => r.name.toLowerCase() === lower);
      let how = 'exact';
      if (!matches.length) { matches = rows.filter((r) => normaliseBt(r.name) === norm); how = 'normalized'; }
      if (!matches.length && rows.length) { matches = rows; how = 'fuzzy'; }
      if (!matches.length) {
        // Punctuation differences defeat ILIKE — retry on the chassis word,
        // then keep only names that contain (or are contained by) the paste.
        const chassis = parsed.name.split(/\s+/)[0];
        if (chassis && chassis.length >= 3) {
          try {
            const alt = (await builders.search({ q: chassis, limit: 300, mode })).units;
            matches = alt.filter((r) => {
              const rn = normaliseBt(r.name);
              return rn.includes(norm) || norm.includes(rn);
            });
            how = 'fuzzy';
          } catch { /* reported as unmatched below */ }
        }
      }
      if (!matches.length) {
        unmatched.push({ line: raw.trim(), parsedName: parsed.name });
        continue;
      }
      units.push({
        line: raw.trim(),
        parsedName: parsed.name,
        count: parsed.count,
        skill: parsed.skill,
        gunnery: parsed.gunnery,
        piloting: parsed.piloting,
        matchedBy: how,
        ambiguous: matches.length > 1,
        matches: matches.slice(0, 8).map((m) => ({ id: m.id, name: m.name, pv: m.pv, bv: m.bv })),
      });
    }
    return { units, unmatched };
  }

  const listSummary = (l) => ({
    id: l.id,
    game: l.game,
    gameName: LIST_GAMES[l.game]?.name ?? l.game,
    name: l.name,
    units: l.units.length,
    faction: l.army?.factionName || null,
    detachment: l.army?.detachment?.name || null,
    created: l.created,
    updated: l.updated,
  });

  // Lists are private: a wrong id and someone else's id answer the same way.
  const myList = (req, res) => {
    const user = needUser(req, res);
    if (!user) return null;
    const l = lists.get(req.params.id);
    if (!l || String(l.owner).toLowerCase() !== user.name.toLowerCase()) {
      res.status(404).json({ error: 'No such list.' });
      return null;
    }
    return { user, l };
  };

  app.get('/api/list-games', memberReader, (req, res) => {
    res.json(Object.entries(LIST_GAMES).map(([id, g]) => ({ id, name: g.name })));
  });

  app.get('/api/lists', memberReader, (req, res) => {
    const user = needUser(req, res);
    if (!user) return;
    res.json({ lists: lists.byUser(user.name).map(listSummary) });
  });

  // Resolve a pasted list without saving: wh40k → datasheet matching plus
  // faction/detachment detection; battletech → mul_units name matching;
  // paste-only games → a parse preview (units + honest unparsed lines).
  app.post('/api/lists/resolve', memberReader, async (req, res) => {
    const user = needUser(req, res);
    if (!user) return;
    const { game, text } = req.body || {};
    if (!LIST_GAMES[game]) return res.status(400).json({ error: 'unknown game' });
    if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'Paste a list first.' });
    try {
      if (game === 'wh40k') {
        if (!wh40k.available()) return res.status(503).json({ error: 'Da 40k database ain\'t hooked up.' });
        return res.json(await wh40k.resolveList(text));
      }
      if (SIMPLE_PARSERS[game]) {
        const parsed = SIMPLE_PARSERS[game](text);
        return res.json({
          header: parsed.header,
          sections: parsed.sections,
          units: parsed.units.map(snapshotSimpleUnit),
          unparsed: parsed.unparsed,
        });
      }
      const r = await resolveBtList(text, game);
      if (r.error) return res.status(r.status).json({ error: r.error });
      res.json(r);
    } catch (err) {
      console.error('[lists] resolve:', err.message);
      res.status(502).json({ error: 'Reference database is not answering.' });
    }
  });

  // Create a list — body by game:
  //   battletech: { game, name, forceName }                       (saved force)
  //            or { game, name, units: [{id, skill, gunnery?, piloting?}] }
  //   wh40k:      { game, name, army: [{id, models?}], detachmentId? | detachmentName? }
  //   paste games:{ game, name, text }                            (builder export)
  app.post('/api/lists', memberReader, async (req, res) => {
    const user = needUser(req, res);
    if (!user) return;
    const { game, forceName, army: armyEntries, detachmentId, detachmentName, text } = req.body || {};
    if (!LIST_GAMES[game]) return res.status(400).json({ error: 'unknown game' });
    const name = String(req.body?.name || '').trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: 'Give da list a name first.' });

    let units = [];
    let army = null;
    try {
      if (game === 'wh40k') {
        const r = await buildArmyUnits(armyEntries);
        if (r.error) return res.status(r.status).json({ error: r.error });
        units = r.units;
        try {
          const rules = await wh40k.getArmyRules({ factionId: r.factionId, detachmentId, detachmentName });
          if (rules) {
            army = {
              factionId: rules.faction?.id ?? r.factionId ?? null,
              factionName: rules.faction?.name ?? null,
              armyRules: rules.armyRules,
              detachment: rules.detachment,
              stratagems: rules.stratagems,
              enhancements: rules.enhancements,
              coreStratagems: rules.coreStratagems,
            };
          }
        } catch (err) {
          // The datasheets alone are still worth saving — flag the gap.
          console.error('[lists] army rules:', err.message);
          army = { factionId: r.factionId ?? null, factionName: null, error: 'army rules lookup failed' };
        }
      } else if (SIMPLE_PARSERS[game]) {
        if (typeof text !== 'string' || !text.trim()) {
          return res.status(400).json({ error: 'Paste yer builder\'s text export.' });
        }
        const parsed = SIMPLE_PARSERS[game](text);
        if (!parsed.units.length) {
          return res.status(400).json({ error: 'Could not find any units in dat paste — use da builder\'s Export text.' });
        }
        units = parsed.units.slice(0, MAX_LIST_UNITS).map(snapshotSimpleUnit);
        army = {
          header: parsed.header.slice(0, 12),
          sections: parsed.sections,
          unparsed: parsed.unparsed.slice(0, 30),
        };
      } else if (forceName) {
        const r = await buildForceUnits(user, forceName, game);
        if (r.error) return res.status(r.status).json({ error: r.error });
        units = r.units;
      } else {
        const entries = (Array.isArray(req.body?.units) ? req.body.units : [])
          .slice(0, MAX_LIST_UNITS)
          .map((e) => ({ id: Number(e?.id), skill: e?.skill, gunnery: e?.gunnery, piloting: e?.piloting }))
          .filter((e) => Number.isFinite(e.id));
        if (!entries.length) return res.status(400).json({ error: 'List came through empty.' });
        const r = await buildEntriesUnits(entries, game);
        if (r.error) return res.status(r.status).json({ error: r.error });
        units = r.units;
      }
    } catch (err) {
      console.error('[lists] create:', err.message);
      return res.status(502).json({ error: 'Reference database is not answering.' });
    }
    if (!units.length) return res.status(400).json({ error: 'List came through empty.' });

    const made = lists.create({ owner: user.name, game, name, units, army });
    if (made.error) return res.status(400).json({ error: made.error });
    res.json(made.list);
  });

  app.get('/api/lists/:id', memberReader, (req, res) => {
    const got = myList(req, res);
    if (!got) return;
    res.json(got.l);
  });

  // Solo damage tracking — the same per-field validation the tables run,
  // no sockets needed (one reader, one screen).
  app.post('/api/lists/:id/track', memberReader, (req, res) => {
    const got = myList(req, res);
    if (!got) return;
    const { l } = got;
    const { uid, field, value } = req.body || {};
    if (typeof field !== 'string') return res.status(400).json({ error: 'patch needs a field' });
    const unit = l.units.find((u) => u.uid === uid);
    if (!unit) return res.status(404).json({ error: 'no such unit' });
    // status 'setup' keeps classic crew skills editable — it's YOUR list
    const r = applyPatch({ game: l.game, status: 'setup' }, unit, field, value);
    if (r.error) return res.status(400).json({ error: r.error });
    lists.update(l);
    res.json({ ok: true, unit });
  });

  app.post('/api/lists/:id/reset', memberReader, (req, res) => {
    const got = myList(req, res);
    if (!got) return;
    for (const u of got.l.units) resetTracking(got.l.game, u);
    lists.update(got.l);
    res.json(got.l);
  });

  app.delete('/api/lists/:id', memberReader, (req, res) => {
    const user = needUser(req, res);
    if (!user) return;
    const l = lists.get(req.params.id);
    if (!l) return res.json({ ok: true });
    if (String(l.owner).toLowerCase() !== user.name.toLowerCase()) {
      return res.status(404).json({ error: 'No such list.' });
    }
    res.json(lists.remove(l.id));
  });
}

module.exports = { mount, GAMES, CRIT_MAX };
