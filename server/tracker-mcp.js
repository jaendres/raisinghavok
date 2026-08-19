// Game Night — Marvel Crisis Protocol at-the-table tracker.
//
// Plugs into server/table.js the same way the other games do: a snapshot
// function that freezes a roster into record-sheet units, a hard-validated
// single-field patch function, and a done-summary that maps onto the league
// tracker's MCP columns (server/league.js GAME_STATS.mcp -> vp / kos / lost).
//
//   const trackerMcp = require('./tracker-mcp');
//
// Input is the ALREADY-PARSED paste My Lists produces (server/table.js
// parseMcpExport, which reads our own builder's rosterText() export). The
// paste carries name / threat / stamina / movement / size; everything else
// (defenses, alter ego, affiliations) is enriched from the committed catalog
// in server/data/mcp-catalog.json by character name. A raw { text } is also
// accepted so the module stands alone (harness, scripts) — it re-parses the
// same export format.
//
// THE CENTRAL MECHANIC — the daze flip. A character starts Healthy with its
// Healthy stamina. Damage accumulates against the FACE-UP side of its card:
//   - damage reaches Healthy stamina -> the character is Dazed: the card flips
//     to its Injured side, damage resets to 0, stamina becomes the Injured
//     value.
//   - damage reaches Injured stamina -> the character is KO'd and removed.
// The SERVER performs that flip inside applyPatch, so every phone at the table
// agrees on which side is face-up; the client never decides it.
//
// What this module does NOT do: adjudicate. VP is scored per round on the
// crisis cards by the players — the tracker records the number they agree on.
const crypto = require('crypto');
const { CATALOG } = require('./mcp');   // read-only reference data

const MAX_UNITS = 30;          // roster cap with room to spare (builder caps at 10)
const MAX_POWER = 99;          // no cap in the rules; a sane ceiling for a counter
const MAX_VP = 99;
const MAX_NOTES = 200;
const MAX_STAMINA = 30;        // guards a malformed paste, not a rules limit
const SIDES = ['healthy', 'injured', 'ko'];

// Status effects MCP actually uses on a character card, plus the objective
// token, which is tracked separately (holdingObjective) because it is a thing
// you carry, not a condition you suffer.
const EFFECTS = ['bleed', 'poison', 'stagger', 'shock', 'slow', 'hex', 'root', 'incinerate'];
const EFFECT_LABEL = {
  bleed: 'Bleed', poison: 'Poison', stagger: 'Stagger', shock: 'Shock',
  slow: 'Slow', hex: 'Hex', root: 'Root', incinerate: 'Incinerate',
};

// Side-level trackers the orchestrator wires into the play header.
const SIDE_FIELDS = ['vp'];

const toInt = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : NaN);
// Same, but null for "not a number" so ?? can fall through to the catalog.
const intOrNull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))
  ? null : Math.round(Number(v)));
const clampInt = (v, lo, hi, dflt) => {
  const n = intOrNull(v);
  return n === null ? dflt : Math.min(Math.max(n, lo), hi);
};

// ---------------------------------------------------------------------------
// Catalog lookup
// ---------------------------------------------------------------------------

// Character names come off a paste, so match forgivingly: case, punctuation
// and spacing vary ("Ant-Man", "ANT MAN", "Ant Man (Scott Lang)").
const normName = (s) => String(s ?? '')
  .toLowerCase()
  .replace(/[’']s\b/g, 's')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

const CHAR_BY_NAME = new Map();
for (const c of CATALOG.characters || []) {
  const k = normName(c.name);
  if (k && !CHAR_BY_NAME.has(k)) CHAR_BY_NAME.set(k, c);
}

function catalogChar(name) {
  return CHAR_BY_NAME.get(normName(name)) || null;
}

// Every team tactic / crisis name in the catalog — the paste carries the names
// the roster picked, this is what the club owns. Exposed for the client's
// crisis picker (names only; the cards themselves are on the table).
const TACTIC_NAMES = (CATALOG.tactics || []).map((t) => t.name || String(t)).filter(Boolean);
const CRISIS_NAMES = (CATALOG.crises || []).map((c) => c.name || String(c)).filter(Boolean);

// ---------------------------------------------------------------------------
// Paste parsing (standalone path — prefer table.js's parseMcpExport)
// ---------------------------------------------------------------------------

// Mirrors public/builders/mcp rosterText(): a header, then labelled sections.
// Characters print as "  [5] NAME *LEADER*  (stamina 6/6, mv L, size 2)";
// tactics and crises are plain indented names.
const SECTION_RE = /^(CHARACTERS|TONIGHT'S SQUAD|TEAM TACTICS|EXTRACT CRISES|SECURE CRISES)\b/;
const CHAR_RE = /^\[(\d+)\]\s+(.+?)(\s*\*LEADER\*)?\s*\(stamina ([^,]+), mv ([^,]+), size ([^)]+)\)$/;

function parseText(text) {
  const header = [];
  const units = [];
  const sections = [];
  const unparsed = [];
  let section = null;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const s = raw.trim();
    if (!s) continue;
    const sec = s.match(SECTION_RE);
    if (sec) {
      section = { title: s, kind: sec[1], items: [] };
      sections.push(section);
      continue;
    }
    if (!section) { header.push(s); continue; }
    if (!/^\s/.test(raw)) { unparsed.push(s); continue; }   // catalog warning footer
    if (section.kind === 'CHARACTERS') {
      const m = s.match(CHAR_RE);
      if (!m) { unparsed.push(s); continue; }
      const [h, i] = String(m[4]).split('/');
      units.push({
        name: m[2],
        threat: Number(m[1]),
        leader: Boolean(m[3]),
        stamina: { healthy: Number(h), injured: Number(i) },
        movement: m[5].trim(),
        size: Number(m[6]),
      });
      continue;
    }
    section.items.push(s);
  }
  return { header, sections: sections.map(({ title, kind, items }) => ({ title, kind, items })), units, unparsed };
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

// Read a value out of a parsed entry, whichever parser produced it: the
// explicit field (this module's parseText) wins, then the simple-card fields
// table.js's parseMcpExport fills in (subtitle "Threat 5 — LEADER", cost
// "5 threat", statline "Stamina 6/6 — Mv M — Size 4").
function readEntry(p) {
  const subtitle = String(p.subtitle ?? '');
  const stat = (p.statlines || []).join(' ');
  const out = {
    name: String(p.name ?? '').trim(),
    threat: intOrNull(p.threat),
    leader: p.leader === true || /\bLEADER\b/.test(subtitle),
    healthy: intOrNull(p.stamina?.healthy),
    injured: intOrNull(p.stamina?.injured),
    movement: p.movement ? String(p.movement).trim() : null,
    size: intOrNull(p.size),
  };
  if (out.threat === null) {
    const m = subtitle.match(/Threat\s+(\d+)/i) || String(p.cost ?? '').match(/(\d+)\s*threat/i);
    if (m) out.threat = Number(m[1]);
  }
  const st = stat.match(/Stamina\s+(\d+)\s*\/\s*(\d+|—|-)/i);
  if (st) {
    if (out.healthy === null) out.healthy = Number(st[1]);
    if (out.injured === null) out.injured = intOrNull(st[2]);
  }
  const mv = stat.match(/Mv\s+([SML])\b/i);
  if (mv && !out.movement) out.movement = mv[1].toUpperCase();
  const sz = stat.match(/Size\s+(\d+)/i);
  if (sz && out.size === null) out.size = Number(sz[1]);
  return out;
}

// Freeze one roster character into a table record-sheet entry. Catalog values
// fill every gap the paste left (defenses are catalog-only — the export does
// not carry them), and the whole card is stored so the table keeps working if
// the catalog is swapped out mid-season.
function snapshotUnit(p) {
  const e = readEntry(p || {});
  const c = catalogChar(e.name);
  const healthy = clampInt(e.healthy ?? c?.stamina?.healthy, 1, MAX_STAMINA,
    clampInt(c?.stamina?.healthy, 1, MAX_STAMINA, 5));
  const injured = clampInt(e.injured ?? c?.stamina?.injured, 1, MAX_STAMINA,
    clampInt(c?.stamina?.injured, 1, MAX_STAMINA, healthy));
  const mv = String(e.movement || c?.movement || 'M').toUpperCase();
  return {
    uid: crypto.randomBytes(4).toString('hex'),
    name: String(e.name || c?.name || 'Character').slice(0, 60),
    alterEgo: String(c?.alterEgo || '').slice(0, 60) || null,
    affiliations: (c?.affiliations || []).slice(0, 4).map((s) => String(s).slice(0, 40)),
    threat: clampInt(e.threat ?? c?.threat, 0, 99, 0),
    stamina: { healthy, injured },
    movement: /^[SML]$/.test(mv) ? mv : 'M',
    size: clampInt(e.size ?? c?.size, 1, 9, 3),
    defenses: {
      physical: clampInt(c?.defenses?.physical, 0, 9, 3),
      energy: clampInt(c?.defenses?.energy, 0, 9, 3),
      mystic: clampInt(c?.defenses?.mystic, 0, 9, 3),
    },
    leader: Boolean(e.leader),
    catalogMatched: Boolean(c),      // false = the paste alone is carrying this card
    // Live state
    side: 'healthy',
    damage: 0,
    power: 0,
    effects: {},
    holdingObjective: false,
    notes: '',
    destroyed: false,
  };
}

// snapshotUnits({ parsed }) — the parsed paste from My Lists (preferred);
// snapshotUnits({ text }) — a raw builder export; both are accepted, and a
// bare array or string works too so the harness can drive it directly.
function snapshotUnits(input) {
  let entries = [];
  if (Array.isArray(input)) entries = input;
  else if (typeof input === 'string') entries = parseText(input).units;
  else if (input && typeof input === 'object') {
    if (Array.isArray(input.parsed?.units)) entries = input.parsed.units;
    else if (Array.isArray(input.units)) entries = input.units;
    else if (typeof input.text === 'string') entries = parseText(input.text).units;
  }
  return entries.slice(0, MAX_UNITS).map(snapshotUnit);
}

// The roster's tactics and crises ride along as reference, not units: the
// crisis in play is picked from these names, the tactic names are the hand.
function snapshotRefs(input) {
  let sections = [];
  if (input && typeof input === 'object') {
    if (Array.isArray(input.parsed?.sections)) sections = input.parsed.sections;
    else if (Array.isArray(input.sections)) sections = input.sections;
    else if (typeof input.text === 'string') sections = parseText(input.text).sections;
  } else if (typeof input === 'string') sections = parseText(input).sections;

  const clean = (items) => (items || []).slice(0, 20)
    .map((s) => String(s).replace(/^\[(\d+)\]\s*/, '').trim().slice(0, 80))
    .filter(Boolean);
  const pick = (kind, needle) => {
    const s = sections.find((x) => (x.kind || x.title || '').startsWith(kind)
      || new RegExp(needle, 'i').test(x.title || ''));
    return s ? clean(s.items) : [];
  };
  return {
    squad: pick("TONIGHT'S SQUAD", "tonight's squad"),
    tactics: pick('TEAM TACTICS', 'team tactics'),
    crises: {
      extract: pick('EXTRACT CRISES', 'extract crises'),
      secure: pick('SECURE CRISES', 'secure crises'),
    },
  };
}

// ---------------------------------------------------------------------------
// Patch
// ---------------------------------------------------------------------------

// Stamina of the face-up side. A KO'd card has no track left.
function staminaOf(u) {
  if (u.side === 'injured') return u.stamina.injured;
  if (u.side === 'ko') return 0;
  return u.stamina.healthy;
}

// A character is out when its card has been flipped past Injured.
function autoDestroyed(u) {
  return u.side === 'ko';
}

// Put a card onto a given side, clearing the damage track — this is the
// physical action: you flip the card and sweep the damage counters off it.
function setSide(u, side) {
  u.side = side;
  if (side === 'ko') {
    u.damage = u.stamina.injured;   // the Injured track is full — that is what KO'd it
    u.destroyed = true;
  } else {
    u.damage = 0;
    u.destroyed = false;
  }
}

// Apply one validated patch. Everything is checked against the unit's OWN
// snapshot, never against anything the client sent.
// Returns { ok: true, msg } (msg is the play-log line) or { error }.
function applyPatch(u, field, value) {
  if (typeof field !== 'string') return { error: 'patch needs a field' };

  // --- damage: the daze flip lives here, server-side and explicit ----------
  if (field === 'damage') {
    if (u.side === 'ko') return { error: `${u.name} is KO'd — no damage track left` };
    const max = staminaOf(u);
    const n = toInt(value);
    if (!(n >= 0 && n <= max)) return { error: `damage is 0-${max}` };
    if (n < max) {
      u.damage = n;
      return { ok: true, msg: `${u.name}: ${n}/${max} damage (${u.side})` };
    }
    // n === max -> the stamina track is full: the card flips.
    if (u.side === 'healthy') {
      setSide(u, 'injured');
      return { ok: true, msg: `${u.name}: DAZED — flipped to Injured (${u.stamina.injured} stamina)` };
    }
    setSide(u, 'ko');
    return { ok: true, msg: `${u.name}: KO'd` };
  }

  // --- side: manual override, including un-dazing a mis-tap ---------------
  if (field === 'side') {
    // Numeric 0/1/2 is accepted so a plain pip/square control can drive this.
    const side = typeof value === 'number' ? SIDES[value] : String(value ?? '').toLowerCase();
    if (!SIDES.includes(side)) return { error: "side is healthy, injured or ko" };
    if (side === u.side) return { ok: true, msg: `${u.name}: already ${side}` };
    setSide(u, side);
    const label = side === 'ko' ? "KO'd" : side === 'injured' ? 'Injured side up' : 'Healthy side up';
    return { ok: true, msg: `${u.name}: ${label}` };
  }

  if (field === 'power') {
    const n = toInt(value);
    if (!(n >= 0 && n <= MAX_POWER)) return { error: `power is 0-${MAX_POWER}` };
    u.power = n;
    return { ok: true, msg: `${u.name}: ${n} power` };
  }

  if (field.startsWith('effect.')) {
    const key = field.slice('effect.'.length).toLowerCase();
    if (!EFFECTS.includes(key)) return { error: 'unknown status effect' };
    const on = Boolean(value);
    if (on) u.effects[key] = true;
    else delete u.effects[key];
    return { ok: true, msg: `${u.name}: ${EFFECT_LABEL[key]}${on ? '' : ' cleared'}` };
  }

  if (field === 'holdingObjective') {
    u.holdingObjective = Boolean(value);
    return { ok: true, msg: `${u.name}: ${u.holdingObjective ? 'picked up an objective' : 'dropped da objective'}` };
  }

  if (field === 'notes') {
    if (typeof value !== 'string') return { error: 'notes must be text' };
    u.notes = value.slice(0, MAX_NOTES);
    return { ok: true, msg: `${u.name}: note updated` };
  }

  // Marking a character out by hand is the same as KO'ing it — keep the card
  // side honest either way, so autoDestroyed and the badge never disagree.
  if (field === 'destroyed') {
    const on = Boolean(value);
    if (on) setSide(u, 'ko');
    else if (u.side === 'ko') setSide(u, 'injured');
    else u.destroyed = false;
    return { ok: true, msg: `${u.name}: ${on ? "KO'd" : 'back in da fight'}` };
  }

  return { error: 'unknown field' };
}

// Zero the live tracking back to the snapshot (My Lists' reset).
function resetTracking(u) {
  u.side = 'healthy';
  u.damage = 0;
  u.power = 0;
  u.effects = {};
  u.holdingObjective = false;
  u.notes = '';
  u.destroyed = false;
}

// ---------------------------------------------------------------------------
// Side-level trackers
// ---------------------------------------------------------------------------

// VP is scored per round on the crisis cards, by the players. The tracker
// records the agreed number; it never works it out.
function applySidePatch(side, field, value) {
  if (field !== 'vp') return { error: 'no such side tracker' };
  const n = toInt(value);
  if (!(n >= 0 && n <= MAX_VP)) return { error: `vp is 0-${MAX_VP}` };
  side.vp = n;
  return { ok: true, msg: `${side.name}: ${n} VP` };
}

// Header line for a side: threat brought, characters still standing.
function sideSummary(side) {
  const units = side?.units || [];
  return {
    threat: units.reduce((n, u) => n + (u.threat || 0), 0),
    standing: units.filter((u) => !u.destroyed && !autoDestroyed(u)).length,
    total: units.length,
  };
}

// ---------------------------------------------------------------------------
// Done summary -> league match report (GAME_STATS.mcp: vp / kos / lost)
// ---------------------------------------------------------------------------

// sides: [{ name, units, vp }]. kos = ENEMY characters KO'd, lost = own.
// vpBySide (optional) lets the finish screen override the live VP tracker.
function doneSummary(sides, vpBySide) {
  const list = Array.isArray(sides) ? sides : [];
  const out = vpBySide && typeof vpBySide === 'object' ? vpBySide : {};
  const kod = (s) => (s.units || []).filter((u) => u.destroyed || autoDestroyed(u)).length;
  const totalKod = list.reduce((n, s) => n + kod(s), 0);
  return {
    game: 'mcp',
    sides: list.map((s) => {
      const override = toInt(out[s.name]);
      const vp = Number.isFinite(override) ? override : (toInt(s.vp) || 0);
      return {
        name: s.name,
        vp: Math.min(Math.max(vp, 0), MAX_VP),
        kos: totalKod - kod(s),
        lost: kod(s),
      };
    }),
  };
}

module.exports = {
  id: 'mcp',
  name: 'Marvel Crisis Protocol',
  leagueGame: 'mcp',
  // table wiring
  snapshotUnits,
  snapshotRefs,
  applyPatch,
  applySidePatch,
  autoDestroyed,
  resetTracking,
  doneSummary,
  sideSummary,
  SIDE_FIELDS,
  // reference / testing
  EFFECTS,
  EFFECT_LABEL,
  SIDES,
  MAX_POWER,
  MAX_VP,
  TACTIC_NAMES,
  CRISIS_NAMES,
  parseText,
  catalogChar,
};
