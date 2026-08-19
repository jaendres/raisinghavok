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

// Alpha Strike critical-hit maxima (per the master unit card):
// Engine 2 (second = destroyed), Fire Control 4, MP 4, Weapons 4.
const CRIT_MAX = { engine: 2, fireControl: 4, mp: 4, weapons: 4 };
const MAX_SIDES = 4;
const MAX_HEAT = 4;            // Alpha Strike heat scale
const CLASSIC_MAX_HEAT = 30;   // Total Warfare heat scale
const CLASSIC_PILOT_MAX = 6;   // pilot hits: 6th = dead
const MAX_ARMY_UNITS = 40;     // per side, wh40k
const MAX_40K_MODELS = 30;     // per unit

const toInt = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : NaN);
const clampSkill = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), 0), 8) : dflt;
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
  return applyUnitPatch(u, field, value);
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

  // Build a side's units from one of the CALLER's saved forces. For classic,
  // every unit also needs a classic_sheets row; crew skills come from the
  // saved force entries (hydrateForce strips them, so they are re-paired from
  // the raw save, which preserves order).
  // Returns { units } or { status, error }.
  async function buildForceUnits(user, forceName, game) {
    const saved = db.forces(user.name)[String(forceName)];
    if (!saved) return { status: 404, error: `No saved force called "${String(forceName).slice(0, 60)}".` };
    if (!builders.available()) return { status: 503, error: 'Da unit database ain\'t hooked up — can\'t load dat force.' };
    if (game === 'battletech-classic' && !classic.available()) {
      return { status: 503, error: 'Da classic sheets database ain\'t hooked up.' };
    }
    let hydrated;
    try {
      hydrated = await builders.hydrateForce(saved.units);
    } catch (err) {
      console.error('[table] hydrate:', err.message);
      return { status: 502, error: 'Unit database is not answering.' };
    }
    if (game !== 'battletech-classic') return { units: hydrated.map(snapshotUnit) };

    // Pair hydrated units back to their raw saved entries (order-preserving).
    const pairs = [];
    let j = 0;
    for (const e of saved.units || []) {
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

  // Build a wh40k side from a confirmed army list: [{ id, models? }].
  // The client resolves the pasted text first (POST /api/builders/wh40k/
  // resolve-list) and sends only picked datasheet ids here.
  async function buildArmyUnits(army) {
    if (!wh40k.available()) return { status: 503, error: 'Da 40k database ain\'t hooked up.' };
    const list = (Array.isArray(army) ? army : []).slice(0, MAX_ARMY_UNITS);
    if (!list.length) return { status: 400, error: 'Army list came through empty.' };
    const units = [];
    for (const entry of list) {
      let ds;
      try {
        ds = await wh40k.getDatasheet(entry?.id);
      } catch (err) {
        console.error('[table] datasheet:', err.message);
        return { status: 502, error: '40k database is not answering.' };
      }
      if (!ds) return { status: 404, error: `No datasheet with id "${String(entry?.id).slice(0, 20)}".` };
      units.push(snapshotWh40kUnit(ds, entry?.models));
    }
    return { units };
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
}

module.exports = { mount, GAMES, CRIT_MAX };
