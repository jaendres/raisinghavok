// Game Night — Necromunda at-the-table tracker.
//
// A plug-in for server/table.js: it owns the snapshot shape, the per-field
// patch validation and the done-summary for one game, so table.js only has to
// dispatch to it. Same house rules as the other trackers:
//
// - Units are SNAPSHOTTED at creation. A gang comes in as the text export from
//   public/builders/necromunda (or as the already-parsed shape My Lists makes
//   from it), gets enriched from server/data/necromunda-catalog.json where the
//   fighter type matches, and is then frozen into the table. The live game
//   keeps working with the catalog gone.
// - Every state change is a single field patch, validated hard here against
//   the unit's OWN snapshot. The client is never trusted.
// - The tracker RECORDS state, it does not adjudicate dice. Nothing here rolls
//   an Injury dice, an Ammo check or a Bottle test — it remembers what the
//   players rolled. The one exception is the flesh-wound rule below, which is
//   arithmetic, not a roll.
//
// Rules encoded (2018 ruleset):
// - Flesh Wounds accumulate and each one reduces Toughness by 1. A fighter
//   whose Toughness is reduced to 0 goes Out of Action — so fleshWounds >= the
//   snapshot's base Toughness is an automatic OOA.
// - The Wounds track is the fighter's W stat. Losing the last wound does NOT
//   kill anyone: it means an Injury dice roll, whose result is a Flesh Wound,
//   Seriously Injured or Out of Action. So a full wound track raises an
//   "injury roll pending" flag and nothing else — the players roll, then tap
//   the condition chip. See injuryPending().
// - Condition is a four-state machine: active -> pinned -> seriouslyInjured ->
//   outOfAction. Any transition is allowed in either direction because the
//   table needs to undo a mis-tap and because Recovery/standing-up rules move
//   fighters back up the chain; the tracker does not police the order.
// - Ammo: a weapon that fails an Ammo check is Out of Ammo until it is
//   repaired (Ready action + Ammo roll). One flag per weapon PROFILE, since
//   multi-profile weapons carry an Ammo value per profile.
// - Bottle: a gang tests when the number of its fighters Out of Action is at
//   least half its starting crew. bottleState() reports that; whether the gang
//   actually bottled out is a recorded fact (side.bottled), not a roll.
const crypto = require('crypto');

let CATALOG = null;
try {
  // Read-only. Missing/broken catalog degrades to paste-only enrichment.
  CATALOG = require('./necromunda').CATALOG;
} catch {
  CATALOG = null;
}

const MAX_UNITS = 60;
const MAX_WEAPONS = 24;
const MAX_GEAR = 30;
const MAX_FLESH_WOUNDS = 10;   // a fighter is long gone before this; a hard cap, not a rule
const MAX_WOUNDS = 20;
const NOTES_MAX = 200;

const CONDITIONS = ['active', 'pinned', 'seriouslyInjured', 'outOfAction'];
const CONDITION_NAMES = {
  active: 'Active',
  pinned: 'Pinned',
  seriouslyInjured: 'Seriously Injured',
  outOfAction: 'Out of Action',
};

// Mid-game status flags. Fixed whitelist — `flag.<name>` never creates a key.
// Pinned lives in the condition machine; `prone` here is the separate
// "on the ground but not pinned" state (knocked down, crawling, Seriously
// Injured), which is why both exist.
const FLAGS = ['engaged', 'prone', 'broken', 'blaze', 'webbed', 'insane'];
const FLAG_NAMES = {
  engaged: 'Engaged',
  prone: 'Prone',
  broken: 'Broken',
  blaze: 'Blaze',
  webbed: 'Webbed',
  insane: 'Insane',
};

const STAT_KEYS = ['m', 'ws', 'bs', 's', 't', 'w', 'i', 'a', 'ld', 'cl', 'wil', 'int'];
const STAT_LABELS = { m: 'M', ws: 'WS', bs: 'BS', s: 'S', t: 'T', w: 'W', i: 'I', a: 'A', ld: 'Ld', cl: 'Cl', wil: 'Wil', int: 'Int' };

// Stricter than the house toInt(): Number(null), Number(''), Number([]) and
// Number(true) are all finite, and a client that posts any of those to a
// counter field is not sending a number. Only real numbers and numeric
// strings get through — everything else is NaN and gets rejected.
const toInt = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) : NaN;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : NaN;
  }
  return NaN;
};
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

// ---------------------------------------------------------------------------
// Catalog lookup (read-only)
// ---------------------------------------------------------------------------

const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Fighter type -> { def, gangKey, gangName, equipment } . Fighter names are
// unique across the seven gangs in the catalog, so a name match is enough.
let FIGHTER_INDEX = null;
function fighterIndex() {
  if (FIGHTER_INDEX) return FIGHTER_INDEX;
  FIGHTER_INDEX = new Map();
  for (const [gangKey, g] of Object.entries(CATALOG?.gangs || {})) {
    for (const f of g.fighters || []) {
      const key = normName(f.name);
      if (!FIGHTER_INDEX.has(key)) FIGHTER_INDEX.set(key, { def: f, gangKey, gangName: g.name });
    }
  }
  return FIGHTER_INDEX;
}

let WEAPON_INDEX = null;
function weaponIndex() {
  if (WEAPON_INDEX) return WEAPON_INDEX;
  WEAPON_INDEX = new Map();
  for (const [name, w] of Object.entries(CATALOG?.weapons || {})) WEAPON_INDEX.set(normName(name), { name, w });
  return WEAPON_INDEX;
}

const lookupFighter = (name) => (name ? fighterIndex().get(normName(name)) || null : null);
const lookupWeapon = (name) => (name ? weaponIndex().get(normName(name)) || null : null);

// Same display rules the builder's statSummary() uses: movement in inches,
// target numbers with a '+', flat values bare, 0 (n/a, e.g. vehicle crew) '-'.
const fmtInches = (v) => (v ? `${v}"` : '-');
const fmtPlus = (v) => (v ? `${v}+` : '-');
const fmtFlat = (v) => (v || v === 0 ? String(v || '-') : '-');

function statlineFromCatalog(stats) {
  return {
    m: fmtInches(stats.m), ws: fmtPlus(stats.ws), bs: fmtPlus(stats.bs),
    s: fmtFlat(stats.s), t: fmtFlat(stats.t), w: fmtFlat(stats.w),
    i: fmtPlus(stats.i), a: fmtFlat(stats.a),
    ld: fmtPlus(stats.ld), cl: fmtPlus(stats.cl), wil: fmtPlus(stats.wil), int: fmtPlus(stats.int),
  };
}

// One printed profile line, matching the builder's export format:
//   "Rng 4"/12" Acc +1/- S3 AP- D1 Am4+ — Pistol, Rapid Fire (1)"
function fmtProfile(p) {
  const base = `Rng ${p.rngS}/${p.rngL} Acc ${p.accS}/${p.accL} S${p.str} AP${p.ap} D${p.d} Am${p.ammo}`;
  return p.traits ? `${base} — ${p.traits}` : base;
}

// ---------------------------------------------------------------------------
// Paste parsing — public/builders/necromunda exportSheet()
// ---------------------------------------------------------------------------
//
// Deliberately the same grammar server/table.js parseNecromundaExport() uses,
// so a paste that My Lists accepts is a paste this accepts:
//   header lines / "====" fence / fighter blocks / "====" fence / footer
// A fighter block is:
//   "LABEL — Type (Category) — 130cr"
//   "M4" WS3+ BS3+ S4 T4 W2 I3+ A3 Ld5+ Cl4+ Wil8+ Int7+"
//   "Gear: Bolt pistol (10cr), Flak Armor (10cr)"
//   "  Bolt pistol: Rng 4"/12" Acc +1/- S3 AP- D1 Am4+ — Pistol"   (indented)
function parseExport(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const header = [];
  const units = [];
  const unparsed = [];
  let inBody = false;
  let cur = null;
  for (const raw of lines) {
    const s = raw.trim();
    if (/^={4,}$/.test(s)) {
      if (inBody) break;               // second fence: the footer starts
      inBody = true;
      continue;
    }
    if (!s) continue;
    if (!inBody) { header.push(s); continue; }

    const start = s.match(/^(.+?) — (.+?) \((.+?)\) — (\d+)cr$/);
    if (start && !/^\s/.test(raw)) {
      cur = {
        name: start[1], subtitle: `${start[2]} (${start[3]})`, cost: `${start[4]}cr`,
        type: start[2], category: start[3],
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

// "M4\" WS3+ BS3+ S4 T4 W2 I3+ A3 Ld5+ Cl4+ Wil8+ Int7+" -> the 12 stats.
// Each key gets its own anchored pattern so WS/BS never eat S, W never eats
// Wil, and I never eats Int.
const STAT_PATTERNS = {
  m: /\bM(\d+"?|-)/,
  ws: /\bWS(\d+\+|-)/,
  bs: /\bBS(\d+\+|-)/,
  s: /\bS(\d+|-)(?![\d+])/,
  t: /\bT(\d+|-)(?![\d+])/,
  w: /\bW(\d+|-)(?![\d+])/,
  i: /\bI(\d+\+|-)(?![\d+])/,
  a: /\bA(\d+|-)(?![\d+])/,
  ld: /\bLd(\d+\+|-)/,
  cl: /\bCl(\d+\+|-)/,
  wil: /\bWil(\d+\+|-)/,
  int: /\bInt(\d+\+|-)/,
};

function statlineFromText(line) {
  const out = {};
  for (const k of STAT_KEYS) {
    const m = String(line || '').match(STAT_PATTERNS[k]);
    let v = m ? m[1] : '-';
    if (k === 'm' && m && !/"/.test(v) && v !== '-') v += '"';
    out[k] = v;
  }
  return out;
}

// The number behind a stat cell, or null for '-' / unreadable.
function statNum(v) {
  const m = String(v == null ? '' : v).match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

// "Bolt pistol (10cr)" -> "Bolt pistol"
const stripCost = (s) => String(s || '').replace(/\s*\(\d+cr\)\s*$/i, '').trim();

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

// Build the weapons/gear split for one fighter. Catalog weapons expand into
// one entry per profile (each profile carries its own Ammo value, so ammo
// tracking is per profile); everything else lands in gear. Where the catalog
// has nothing, the paste's own indented profile lines are used verbatim.
function splitKit(parsed, def) {
  const weapons = [];
  const gear = [];
  const named = [];

  // Gear as the paste lists it, plus whatever the catalog says the fighter
  // carries by default (a paste always wins on conflicts — it is the record of
  // what was actually on the table).
  const rawGear = Array.isArray(parsed?.gear) && parsed.gear.length
    ? parsed.gear
    : (def?.defaultEquipment || []);
  for (const g of rawGear.slice(0, MAX_GEAR)) named.push(stripCost(g));

  // Profile lines from the paste, keyed by the text before the first colon
  // ("Bolt pistol" or "Combi-weapon (bolter)").
  const pasteProfiles = new Map();
  for (const line of parsed?.gearProfiles || []) {
    const i = String(line).indexOf(':');
    if (i < 1) continue;
    const label = String(line).slice(0, i).trim();
    const body = String(line).slice(i + 1).trim();
    const base = normName(label.replace(/\s*\([^)]*\)\s*$/, ''));
    const list = pasteProfiles.get(base) || [];
    list.push({ label, body });
    pasteProfiles.set(base, list);
  }

  for (const name of named) {
    const hit = lookupWeapon(name);
    if (hit && (hit.w.profiles || []).length) {
      for (const p of hit.w.profiles) {
        if (weapons.length >= MAX_WEAPONS) break;
        weapons.push({
          name: clip(p.name ? `${hit.name} (${p.name})` : hit.name, 80),
          profile: clip(fmtProfile(p), 220),
        });
      }
      pasteProfiles.delete(normName(name));
      continue;
    }
    const fromPaste = pasteProfiles.get(normName(name));
    if (fromPaste && fromPaste.length) {
      for (const p of fromPaste) {
        if (weapons.length >= MAX_WEAPONS) break;
        weapons.push({ name: clip(p.label, 80), profile: clip(p.body, 220) });
      }
      pasteProfiles.delete(normName(name));
      continue;
    }
    if (gear.length < MAX_GEAR) gear.push(clip(name, 80));
  }

  // Profile lines whose gear entry never showed up (a hand-edited paste) are
  // still weapons — carry them rather than dropping them silently.
  for (const list of pasteProfiles.values()) {
    for (const p of list) {
      if (weapons.length >= MAX_WEAPONS) break;
      weapons.push({ name: clip(p.label, 80), profile: clip(p.body, 220) });
    }
  }
  return { weapons, gear };
}

// Freeze one parsed fighter into a tracker unit.
function snapshotUnit(parsed) {
  const p = parsed || {};
  // "Forge Tyrant (Leader)" -> type / category, when the caller did not split.
  let type = clip(p.type, 60);
  let category = clip(p.category, 40);
  if (!type && p.subtitle) {
    const m = String(p.subtitle).match(/^(.+?)\s*\((.+?)\)\s*$/);
    if (m) { type = m[1]; category = m[2]; } else { type = String(p.subtitle); }
  }

  const hit = lookupFighter(type) || lookupFighter(p.name);
  const def = hit?.def || null;
  if (def) {
    if (!type) type = def.name;
    if (!category) category = def.category;
  }

  const statline = def
    ? statlineFromCatalog(def.stats)
    : statlineFromText((p.statlines || [])[0] || '');

  const toughness = statNum(statline.t);
  let maxWounds = statNum(statline.w);
  const pasteW = toInt(p.maxWounds);
  if (!(maxWounds >= 1) && pasteW >= 1) maxWounds = pasteW;
  if (!(maxWounds >= 1)) maxWounds = 1;
  maxWounds = Math.min(maxWounds, MAX_WOUNDS);

  const { weapons, gear } = splitKit(p, def);

  const cost = p.cost != null ? clip(p.cost, 20) : (def ? `${def.cost}cr` : null);

  return {
    uid: crypto.randomBytes(4).toString('hex'),
    name: clip(p.name || type || 'Fighter', 60),
    type: clip(type || 'Fighter', 60),
    category: clip(category, 40),
    gang: clip(hit?.gangName || '', 60),
    cost,
    enriched: Boolean(def),           // false = the paste is all we have
    statline,
    toughness,                        // base T as a number, or null if unreadable
    weapons,
    gear,
    // Live state
    maxWounds,
    wounds: 0,
    fleshWounds: 0,
    condition: 'active',
    ammoOut: [],                      // indexes into weapons[]
    flags: {},                        // subset of FLAGS -> true
    notes: '',
    destroyed: false,
  };
}

// snapshotUnits(input) — input is { parsed } (My Lists' already-parsed paste),
// { text } (the raw builder export), or both; a bare string or a bare array is
// accepted too. Also tolerates the older simple-card shape so a list saved
// before this tracker existed still opens.
function snapshotUnits(input) {
  let parsedUnits = null;

  if (typeof input === 'string') {
    parsedUnits = parseExport(input).units;
  } else if (Array.isArray(input)) {
    parsedUnits = input;
  } else if (input && typeof input === 'object') {
    const p = input.parsed;
    if (Array.isArray(p)) parsedUnits = p;
    else if (p && Array.isArray(p.units)) parsedUnits = p.units;
    if ((!parsedUnits || !parsedUnits.length) && typeof input.text === 'string') {
      parsedUnits = parseExport(input.text).units;
    }
  }
  if (!Array.isArray(parsedUnits)) return [];
  return parsedUnits.slice(0, MAX_UNITS).map(snapshotUnit);
}

// ---------------------------------------------------------------------------
// Derived rules
// ---------------------------------------------------------------------------

// Toughness after flesh wounds. Never below 0.
function effectiveToughness(u) {
  const base = Number.isFinite(u?.toughness) ? u.toughness : statNum(u?.statline?.t);
  if (!Number.isFinite(base)) return null;
  return Math.max(0, base - (toInt(u.fleshWounds) || 0));
}

// Losing the last wound means an Injury dice roll — the players roll it, this
// only flags that one is owed.
function injuryPending(u) {
  if (!u) return false;
  if (u.condition === 'outOfAction') return false;
  return (toInt(u.wounds) || 0) >= (toInt(u.maxWounds) || 1);
}

// Why this fighter is out, or null. Flesh wounds reducing Toughness to 0 is
// the only arithmetic kill in the rules; a full wound track is NOT one.
function destroyedReason(u) {
  if (!u) return null;
  if (u.condition === 'outOfAction') return 'out of action';
  const base = Number.isFinite(u.toughness) ? u.toughness : statNum(u?.statline?.t);
  if (Number.isFinite(base) && base > 0 && (toInt(u.fleshWounds) || 0) >= base) {
    return 'Toughness reduced to 0 by flesh wounds';
  }
  return null;
}

function autoDestroyed(u) {
  return destroyedReason(u) !== null;
}

// A fighter counts as Out of Action for scoring and for the bottle test when
// the rules put them out, or when a player manually marked them down.
function isOutOfAction(u) {
  return Boolean(u && (u.destroyed || autoDestroyed(u)));
}

// ---------------------------------------------------------------------------
// Patch
// ---------------------------------------------------------------------------

// applyPatch(unit, field, value) -> { ok: true, msg } | { error }
// Every bound is read off the unit's own snapshot, never off the request.
function applyPatch(u, field, value) {
  if (!u || typeof field !== 'string') return { error: 'patch needs a field' };

  if (field === 'wounds') {
    const n = toInt(value);
    const max = toInt(u.maxWounds) || 1;
    if (!(n >= 0 && n <= max)) return { error: `wounds are 0-${max}` };
    u.wounds = n;
    const left = max - n;
    return {
      ok: true,
      msg: `${u.name}: ${left}/${max} wounds${left === 0 && u.condition !== 'outOfAction' ? ' — ROLL INJURY DICE' : ''}`,
    };
  }

  if (field === 'fleshWounds') {
    const n = toInt(value);
    if (!(n >= 0 && n <= MAX_FLESH_WOUNDS)) return { error: `flesh wounds are 0-${MAX_FLESH_WOUNDS}` };
    u.fleshWounds = n;
    const wasOut = u.destroyed;
    if (autoDestroyed(u)) u.destroyed = true;
    else if (wasOut && u.condition !== 'outOfAction') u.destroyed = false;
    const eff = effectiveToughness(u);
    return {
      ok: true,
      msg: `${u.name}: ${n} flesh wound${n === 1 ? '' : 's'}${eff != null ? ` — T${eff}` : ''}${u.destroyed && !wasOut ? ' — OUT OF ACTION' : ''}`,
    };
  }

  if (field === 'condition') {
    if (!CONDITIONS.includes(value)) return { error: `condition is one of ${CONDITIONS.join(', ')}` };
    u.condition = value;
    // Out of Action is the one condition that also downs the card; stepping
    // back off it revives unless the flesh-wound rule still holds them down.
    u.destroyed = value === 'outOfAction' ? true : autoDestroyed(u);
    return { ok: true, msg: `${u.name}: ${CONDITION_NAMES[value]}` };
  }

  if (field.startsWith('ammoOut.')) {
    const idx = toInt(field.slice('ammoOut.'.length));
    const w = (u.weapons || [])[idx];
    if (!w) return { error: 'no such weapon' };
    const out = new Set(u.ammoOut || []);
    if (value) out.add(idx); else out.delete(idx);
    u.ammoOut = [...out].sort((a, b) => a - b);
    return { ok: true, msg: `${u.name}: ${w.name} ${value ? 'OUT OF AMMO' : 'reloaded'}` };
  }

  if (field.startsWith('flag.')) {
    const key = field.slice('flag.'.length);
    if (!FLAGS.includes(key)) return { error: 'unknown status flag' };
    if (!u.flags || typeof u.flags !== 'object') u.flags = {};
    if (value) u.flags[key] = true; else delete u.flags[key];
    return { ok: true, msg: `${u.name}: ${FLAG_NAMES[key]} ${value ? 'on' : 'off'}` };
  }

  if (field === 'notes') {
    if (typeof value !== 'string') return { error: 'notes must be text' };
    u.notes = value.slice(0, NOTES_MAX);
    return { ok: true, msg: `${u.name}: note updated` };
  }

  if (field === 'destroyed') {
    const want = Boolean(value);
    // Manually reviving a fighter the rules put out only works if the rules
    // have let go: clear the condition / flesh wounds first.
    if (!want && autoDestroyed(u)) {
      return { error: `${u.name} is out by da rules (${destroyedReason(u)}) — clear dat first` };
    }
    u.destroyed = want;
    if (want && u.condition !== 'outOfAction') u.condition = 'outOfAction';
    return { ok: true, msg: `${u.name}: ${want ? 'OUT OF ACTION' : 'back in da fight'}` };
  }

  return { error: 'unknown field' };
}

// Zero a unit's live state back to its snapshot (My Lists' reset).
function resetTracking(u) {
  if (!u) return;
  u.wounds = 0;
  u.fleshWounds = 0;
  u.condition = 'active';
  u.ammoOut = [];
  u.flags = {};
  u.notes = '';
  u.destroyed = false;
}

// ---------------------------------------------------------------------------
// Gang-level: bottle test
// ---------------------------------------------------------------------------

// bottleState(side) -> what the gang bottle indicator needs.
// A gang must take a Bottle test at the start of a round once the number of
// its fighters Out of Action is at least half its starting crew. Whether the
// test was then failed is recorded on the side (side.bottled), not rolled.
function bottleState(side) {
  const units = Array.isArray(side?.units) ? side.units : [];
  const fighters = units.length;
  const out = units.filter(isOutOfAction).length;
  return {
    fighters,
    out,
    standing: fighters - out,
    threshold: Math.ceil(fighters / 2),     // "half the gang", rounded up, for display
    mustTest: fighters > 0 && out * 2 >= fighters,
    bottled: Boolean(side?.bottled),
  };
}

// Side-level patch: the bottle switch, and the VP the table scores by hand.
// applySidePatch(side, field, value) -> { ok: true, msg } | { error }
function applySidePatch(side, field, value) {
  if (!side) return { error: 'no such side' };
  if (field === 'bottled') {
    side.bottled = Boolean(value);
    return { ok: true, msg: `${side.name}: ${side.bottled ? 'BOTTLED OUT' : 'holding da ground'}` };
  }
  if (field === 'vp') {
    const n = toInt(value);
    if (!(n >= 0 && n <= 200)) return { error: 'vp is 0-200' };
    side.vp = n;
    return { ok: true, msg: `${side.name}: VP ${n}` };
  }
  return { error: 'unknown field' };
}

// ---------------------------------------------------------------------------
// Done summary -> league.js GAME_STATS.necromunda
// ---------------------------------------------------------------------------

// doneSummary(sides, vpBySide) -> { game: 'necromunda', sides: [{ name, vp, oop, lost }] }
// oop = enemy fighters this side put Out of Action, lost = its own.
// vp is scored on the tabletop: it comes from vpBySide by side name, falling
// back to the side's own live tracker.
function doneSummary(sides, vpBySide) {
  const list = Array.isArray(sides) ? sides : [];
  const outOf = (s) => (Array.isArray(s?.units) ? s.units : []).filter(isOutOfAction).length;
  const totalOut = list.reduce((n, s) => n + outOf(s), 0);
  const byName = (vpBySide && typeof vpBySide === 'object') ? vpBySide : {};
  return {
    game: 'necromunda',
    sides: list.map((s) => {
      const fromBody = toInt(byName[s?.name]);
      const vp = Number.isFinite(fromBody) ? fromBody : (toInt(s?.vp) || 0);
      const lost = outOf(s);
      return {
        name: s?.name,
        vp: Math.max(0, vp),
        oop: totalOut - lost,
        lost,
      };
    }),
  };
}

module.exports = {
  id: 'necromunda',
  name: 'Necromunda',
  leagueGame: 'necromunda',
  // core contract
  snapshotUnits,
  applyPatch,
  autoDestroyed,
  doneSummary,
  bottleState,
  // helpers the table/list plumbing wants
  parseExport,
  resetTracking,
  applySidePatch,
  destroyedReason,
  effectiveToughness,
  injuryPending,
  isOutOfAction,
  // shared vocabulary (the client card renders from these)
  CONDITIONS,
  CONDITION_NAMES,
  FLAGS,
  FLAG_NAMES,
  STAT_KEYS,
  STAT_LABELS,
  MAX_FLESH_WOUNDS,
};
