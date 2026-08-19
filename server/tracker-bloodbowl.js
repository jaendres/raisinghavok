// Game Night — Blood Bowl at-the-table tracker.
//
// Blood Bowl does not track damage, it tracks a MATCH: two teams, two halves
// of eight turns each, and the handful of things a player does that earn SPP.
// So this module carries two kinds of state:
//
//   * per player  — state (Ready/Prone/Stunned/KO'd/Casualty/Sent Off) and the
//     SPP-earning events as they happen (TD, CAS, COMP, INT, Deflection), plus
//     the end-of-match MVP pick.
//   * per match   — half, each team's turn counter, score, rerolls remaining,
//     weather, and the optional inducement/FAME bookkeeping.
//
// The per-player counts are the whole point: the league tracker credits
// individuals (server/league.js validSide -> side.scorers[{player,stat,count}]
// + side.mvp), and doneSummary() hands it exactly that shape, so a table
// finished here fills in a league match report without anyone retyping it.
//
// Wired into server/table.js the same way the other games are: GAMES entry,
// a snapshot call when a side is filled, a branch in applyPatch, and — new for
// this game — a match-level patch branch (see MATCH_FIELDS / applyMatchPatch).
//
// Read-only dependency on server/bb.js for the catalog, so a pasted roster
// still gets real statlines and starting skills.
const crypto = require('crypto');
const bb = require('./bb');

const CATALOG = bb.CATALOG;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Player states. `casualty` and `sentOff` are the two that take a player off
// the pitch for good, so they are the ones that mirror onto `destroyed` for
// the shared UI (dimmed card, "standing" counts, the Wreck/Revive button).
const STATES = ['ready', 'prone', 'stunned', 'ko', 'casualty', 'sentOff'];
const STATE_NAMES = {
  ready: 'Ready',
  prone: 'Prone',
  stunned: 'Stunned',
  ko: "KO'd",
  casualty: 'Casualty',
  sentOff: 'Sent Off',
};
const OFF_PITCH = ['casualty', 'sentOff'];

// SPP-earning events, tracked per player as they happen.
// Deflection is tracked because BB2020/2025 awards it SPP, but the league's
// GAME_STATS.bloodbowl has no `deflect` column — see doneSummary().
const EVENTS = ['td', 'cas', 'comp', 'int', 'deflect'];
const EVENT_NAMES = {
  td: 'Touchdown',
  cas: 'Casualty',
  comp: 'Completion',
  int: 'Interception',
  deflect: 'Deflection',
};
const EVENT_SHORT = { td: 'TD', cas: 'CAS', comp: 'COMP', int: 'INT', deflect: 'DEF' };
// Display-only SPP weights; the league is the authority (GAME_STATS.spp).
const SPP = { td: 3, cas: 2, comp: 1, int: 2, deflect: 1, mvp: 4 };
// The four the league actually stores per side.
const LEAGUE_STATS = ['td', 'cas', 'comp', 'int'];

const MAX_EVENT = 20;        // per player, per event, per match
const MAX_PLAYERS = 16;      // a Blood Bowl roster is 11-16
const MAX_HALF = 3;          // 1, 2, then 3 = overtime
const MAX_TURN = 8;          // eight team turns to a half
const MAX_SCORE = 20;
const MAX_REROLLS = 8;       // catalog rules.maxRerolls
const MAX_FAME = 2;
const MAX_INDUCEMENTS = 120; // characters

// BB2020/2025 weather table. Free text is accepted (house rules, Blood Bowl 7s
// tables), but these are what the client offers.
const WEATHER = [
  'Perfect Conditions',
  'Sweltering Heat',
  'Very Sunny',
  'Pouring Rain',
  'Blizzard',
];

const toInt = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : NaN);
const clip = (s, n) => String(s == null ? '' : s).replace(/[<>]/g, '').trim().slice(0, n);

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

// Every catalog position, flattened once, so a pasted roster can be matched to
// real statlines: "Blitzer" alone is ambiguous across teams, but an exact
// "Orc Blitzer" is not, and a race hint resolves the rest.
const POSITION_INDEX = (() => {
  const byRace = {};
  const byName = {};
  for (const [key, team] of Object.entries(CATALOG.teams || {})) {
    byRace[key] = {};
    for (const pos of team.positions || []) {
      const n = pos.name.toLowerCase();
      byRace[key][n] = pos;
      // First team to claim a bare position name wins; exact names are unique.
      if (!byName[n]) byName[n] = pos;
    }
  }
  return { byRace, byName };
})();

// Resolve a race hint to a catalog key: accepts the key ('black_orc'), the
// display name ('Black Orc'), or nothing.
function raceKey(hint) {
  if (!hint) return null;
  const s = String(hint).toLowerCase().trim();
  if (CATALOG.teams[s]) return s;
  const slug = s.replace(/[^a-z0-9]+/g, '_');
  if (CATALOG.teams[slug]) return slug;
  for (const [key, team] of Object.entries(CATALOG.teams || {})) {
    if (String(team.name || '').toLowerCase() === s) return key;
  }
  return null;
}

function lookupPosition(position, race) {
  const n = String(position || '').toLowerCase().trim();
  if (!n) return null;
  const rk = raceKey(race);
  if (rk && POSITION_INDEX.byRace[rk]) {
    const exact = POSITION_INDEX.byRace[rk][n];
    if (exact) return exact;
    // "Blitzer" inside an Orc roster means "Orc Blitzer".
    for (const [name, pos] of Object.entries(POSITION_INDEX.byRace[rk])) {
      if (name.endsWith(' ' + n)) return pos;
    }
  }
  return POSITION_INDEX.byName[n] || null;
}

const emptyEvents = () => ({ td: 0, cas: 0, comp: 0, int: 0, deflect: 0 });

// One player, frozen into the table. Same rule as every other game here: the
// stats are COPIED in, so the match keeps working with the league or the
// catalog unavailable mid-session.
function makeUnit({ number, name, position, statline, skills }) {
  // Number(null) is 0, which would silently invent a shirt number 0.
  const num = number === null || number === undefined || number === '' ? NaN : toInt(number);
  return {
    uid: crypto.randomBytes(4).toString('hex'),
    number: num >= 0 && num <= 99 ? num : null,
    name: clip(name, 40) || 'Player',
    position: clip(position, 40),
    statline: {
      ma: statline && Number.isFinite(Number(statline.ma)) ? Number(statline.ma) : null,
      st: statline && Number.isFinite(Number(statline.st)) ? Number(statline.st) : null,
      ag: statline && Number.isFinite(Number(statline.ag)) ? Number(statline.ag) : null,
      pa: statline && Number.isFinite(Number(statline.pa)) ? Number(statline.pa) : null,
      av: statline && Number.isFinite(Number(statline.av)) ? Number(statline.av) : null,
    },
    skills: (Array.isArray(skills) ? skills : []).slice(0, 20).map((s) => clip(s, 40)).filter(Boolean),
    // Live state
    state: 'ready',
    events: emptyEvents(),
    mvp: false,
    notes: '',
    destroyed: false,
  };
}

// Pull players out of a league team's Blood Bowl roster — the object served by
// GET /api/league/:id/team/:tid/bb, i.e. bb.serializeTeam():
//   { race, raceName, rerolls, fans, tv, ctv, players: [{ num, name, nickname,
//     position, stats:{ma,st,ag,pa,av}, skills:[], injuries:{dead,mng,...},
//     retired, ... }] }
// A plain array (a league team's un-drafted `roster`: [{num,name,position}])
// works too, so a team that never used the BB builder can still play.
function fromRoster(roster, raceHint) {
  const race = (roster && !Array.isArray(roster) ? (roster.race || roster.raceName) : null) || raceHint || null;
  const list = Array.isArray(roster) ? roster : (roster && Array.isArray(roster.players) ? roster.players : []);
  const units = [];
  for (const p of list) {
    if (!p) continue;
    // Dead, retired and miss-next-game players cannot take the field.
    if (p.retired || (p.injuries && (p.injuries.dead || p.injuries.mng))) continue;
    const pos = lookupPosition(p.position, race);
    units.push(makeUnit({
      number: p.num != null ? p.num : p.number,
      name: p.name,
      // Prefer the catalog's canonical name ("Clanrat" -> "Skaven Clanrat"),
      // so the card and the league report agree on what a player is.
      position: pos ? pos.name : (p.position || ''),
      statline: p.stats || p.statline
        || (pos ? { ma: pos.ma, st: pos.st, ag: pos.ag, pa: pos.pa, av: pos.av } : null),
      skills: Array.isArray(p.skills) && p.skills.length ? p.skills : (pos ? pos.skills : []),
    }));
    if (units.length >= MAX_PLAYERS) break;
  }
  return units;
}

// Parse a pasted roster: one player per line, "number, name, position".
// Tolerates the separators people actually paste — commas, em/en dashes,
// " - ", tabs, pipes — plus "#7" numbering and "(Blitzer)" parentheticals.
// Lines that carry no position still land as players; nothing is silently
// dropped except blanks, comments and obvious headers.
function fromText(text, race) {
  const units = [];
  for (const raw of String(text == null ? '' : text).split(/\r?\n/)) {
    let s = raw.trim();
    // '#' starts a comment, but '#7 Grak' is a shirt number.
    if (!s || /^(#\s*[^0-9]|\/\/)/.test(s)) continue;
    if (/^[=~_*-]{3,}$/.test(s)) continue;
    if (/^(team|roster|coach|race|rerolls?|apothecary|cheerleaders?|coaches|fans|treasury|team value|tv|players?)\s*[:=]/i.test(s)) continue;

    let number = null;
    const lead = s.match(/^#?\s*(\d{1,2})\s*[.)\-,:]?\s+/);
    if (lead) { number = Number(lead[1]); s = s.slice(lead[0].length); }

    let position = '';
    const paren = s.match(/\(([^)]{2,40})\)\s*$/);
    if (paren) { position = paren[1]; s = s.slice(0, paren.index); }
    if (!position) {
      const parts = s.split(/\s*(?:,|—|–|\||\t|\s-\s)\s*/).map((x) => x.trim()).filter(Boolean);
      if (parts.length >= 2) {
        // A trailing bare number is a cost/value column, not the position.
        while (parts.length > 2 && /^\d+k?$/i.test(parts[parts.length - 1])) parts.pop();
        s = parts[0];
        position = parts[1];
        if (number === null && /^\d{1,2}$/.test(s) && parts.length >= 3) {
          number = Number(s); s = parts[1]; position = parts[2];
        }
      }
    }

    const name = s.replace(/\s+/g, ' ').trim();
    if (!name) continue;
    const pos = lookupPosition(position, race);
    units.push(makeUnit({
      number,
      name,
      position: pos ? pos.name : (position || ''),
      statline: pos ? { ma: pos.ma, st: pos.st, ag: pos.ag, pa: pos.pa, av: pos.av } : null,
      skills: pos ? pos.skills : [],
    }));
    if (units.length >= MAX_PLAYERS) break;
  }
  return units;
}

// snapshotUnits(input) -> players.
// input: { roster } — a league team's Blood Bowl roster object (or array)
//        { text }   — a pasted roster, one player per line
//        { race }   — optional catalog key or display name, sharpens position
//                     lookups for both paths
function snapshotUnits(input) {
  const src = input || {};
  if (src.roster) return fromRoster(src.roster, src.race);
  if (typeof src.text === 'string' && src.text.trim()) return fromText(src.text, src.race);
  if (Array.isArray(src)) return fromRoster(src, null);
  return [];
}

// Team-level numbers worth seeding the match bar with, read off the same
// roster object. Returns nulls when the source does not carry them.
function snapshotMeta(input) {
  const src = input || {};
  const r = src.roster && !Array.isArray(src.roster) ? src.roster : null;
  return {
    race: r ? (r.race || null) : (raceKey(src.race) || null),
    raceName: r ? (r.raceName || r.race || null) : null,
    rerolls: r && Number.isFinite(Number(r.rerolls))
      ? Math.min(Math.max(Math.round(Number(r.rerolls)), 0), MAX_REROLLS) : 0,
    fans: r && Number.isFinite(Number(r.fans)) ? Math.min(Math.max(Math.round(Number(r.fans)), 0), 7) : null,
    tv: r && Number.isFinite(Number(r.tv)) ? Number(r.tv) : null,
  };
}

// A player is off the pitch for good on a casualty or a sending-off. KO'd
// players go to the reserves box and can come back next drive, so they are
// NOT destroyed.
function autoDestroyed(unit) {
  return OFF_PITCH.includes(unit && unit.state);
}

// ---------------------------------------------------------------------------
// Player patches
// ---------------------------------------------------------------------------

// applyPatch(unit, field, value) -> { ok:true, msg } | { error }
// Fields:
//   state          — one of STATES
//   event.<k>      — k in EVENTS, integer 0..MAX_EVENT (the client sends the
//                    new absolute value; +/- is a client-side stepper)
//   mvp            — boolean
//   notes          — string, 200 chars
//   destroyed      — boolean; kept in step with state so the shared
//                    Wreck/Revive button means something in this game too
function applyPatch(unit, field, value) {
  if (!unit || typeof field !== 'string') return { error: 'patch needs a field' };
  const who = unit.number != null ? `#${unit.number} ${unit.name}` : unit.name;

  if (field === 'state') {
    const s = String(value);
    if (!STATES.includes(s)) return { error: `state is one of ${STATES.join('/')}` };
    unit.state = s;
    unit.destroyed = autoDestroyed(unit);
    return { ok: true, msg: `${who}: ${STATE_NAMES[s]}` };
  }

  if (field.startsWith('event.')) {
    const key = field.slice('event.'.length);
    if (!EVENTS.includes(key)) return { error: 'unknown event' };
    const n = toInt(value);
    if (!(n >= 0 && n <= MAX_EVENT)) return { error: `${EVENT_SHORT[key]} is 0-${MAX_EVENT}` };
    const was = unit.events[key];
    unit.events[key] = n;
    if (n > was) return { ok: true, msg: `${who}: ${EVENT_NAMES[key]}${n > 1 ? ` (${n})` : ''}` };
    return { ok: true, msg: `${who}: ${EVENT_SHORT[key]} ${n}` };
  }

  if (field === 'mvp') {
    unit.mvp = Boolean(value);
    return { ok: true, msg: `${who}: ${unit.mvp ? 'MVP!' : 'MVP taken back'}` };
  }

  if (field === 'notes') {
    if (typeof value !== 'string') return { error: 'notes must be text' };
    unit.notes = value.slice(0, 200);
    return { ok: true, msg: `${who}: note updated` };
  }

  if (field === 'destroyed') {
    const off = Boolean(value);
    unit.destroyed = off;
    if (off && !OFF_PITCH.includes(unit.state)) unit.state = 'casualty';
    if (!off && OFF_PITCH.includes(unit.state)) unit.state = 'ready';
    return { ok: true, msg: `${who}: ${off ? 'off da pitch' : 'back on his feet'}` };
  }

  return { error: 'unknown field' };
}

// Zero a player's live tracking back to the snapshot (list/table reset).
function resetTracking(unit) {
  unit.state = 'ready';
  unit.events = emptyEvents();
  unit.mvp = false;
  unit.notes = '';
  unit.destroyed = false;
}

// ---------------------------------------------------------------------------
// Match-level state
// ---------------------------------------------------------------------------

// The table stores ONE match object alongside the sides. Per-side values are
// arrays indexed by side index, so the shape stays flat and JSON-friendly:
//
//   match = {
//     half: 1, weather: 'Perfect Conditions',
//     turn: [1, 1], score: [0, 0],
//     rerolls: [3, 3], rerollBase: [3, 3], rerollUsed: [false, false],
//     fame: [0, 0], inducements: ['', ''],
//   }
//
// MATCH_FIELDS is the description the orchestrator (and the client) render
// from: `perSide` says whether the field is patched as "<field>.<sideIdx>".
const MATCH_FIELDS = {
  half: { label: 'Half', type: 'int', min: 1, max: MAX_HALF, dflt: 1, perSide: false },
  turn: { label: 'Turn', type: 'int', min: 1, max: MAX_TURN, dflt: 1, perSide: true },
  score: { label: 'Score', type: 'int', min: 0, max: MAX_SCORE, dflt: 0, perSide: true },
  rerolls: { label: 'Rerolls', type: 'int', min: 0, max: MAX_REROLLS, dflt: 0, perSide: true },
  weather: { label: 'Weather', type: 'string', max: 40, dflt: WEATHER[0], options: WEATHER, perSide: false },
  // Optional bookkeeping — the match runs perfectly well without these.
  rerollBase: { label: 'Team rerolls', type: 'int', min: 0, max: MAX_REROLLS, dflt: 0, perSide: true, optional: true },
  rerollUsed: { label: 'RR used dis turn', type: 'bool', dflt: false, perSide: true, optional: true },
  fame: { label: 'FAME', type: 'int', min: 0, max: MAX_FAME, dflt: 0, perSide: true, optional: true },
  inducements: { label: 'Inducements', type: 'string', max: MAX_INDUCEMENTS, dflt: '', perSide: true, optional: true },
};

// Build the match state for a table. `seeds` is one entry per side, normally
// snapshotMeta() output, so each team starts with its own reroll count.
function newMatch(sideCount, seeds) {
  const n = Math.max(2, Math.min(Math.round(Number(sideCount) || 2), 4));
  const per = (fn) => Array.from({ length: n }, (_, i) => fn(i));
  const seed = (i) => (Array.isArray(seeds) && seeds[i]) || {};
  const rr = (i) => {
    const v = toInt(seed(i).rerolls);
    return v >= 0 && v <= MAX_REROLLS ? v : 0;
  };
  return {
    half: 1,
    weather: WEATHER[0],
    turn: per(() => 1),
    score: per(() => 0),
    rerolls: per(rr),
    rerollBase: per(rr),
    rerollUsed: per(() => false),
    fame: per((i) => {
      const f = toInt(seed(i).fans);
      return f >= 0 && f <= MAX_FAME ? f : 0;
    }),
    inducements: per(() => ''),
  };
}

// Split "turn.1" into { key:'turn', idx:1 }.
function splitField(field) {
  const dot = String(field).indexOf('.');
  if (dot === -1) return { key: String(field), idx: null };
  return { key: String(field).slice(0, dot), idx: toInt(String(field).slice(dot + 1)) };
}

// applyMatchPatch(match, field, value) -> { ok:true, msg } | { error }
// Per-side fields are patched as "<field>.<sideIdx>", e.g. "turn.0".
//
// Two rules are enforced here rather than left to whoever taps, because both
// are book-keeping the table always gets wrong:
//   * a new half resets both turn counters to 1 and refills every team's
//     rerolls from rerollBase (rerolls do not carry over between halves);
//   * moving a team's turn counter clears that team's "reroll used" flag,
//     since the limit is one team reroll per team turn.
function applyMatchPatch(match, field, value) {
  if (!match || typeof field !== 'string') return { error: 'patch needs a field' };
  const { key, idx } = splitField(field);
  const def = MATCH_FIELDS[key];
  if (!def) return { error: 'unknown match field' };

  if (def.perSide) {
    if (!Array.isArray(match[key])) return { error: 'unknown match field' };
    // idx null means the caller sent "turn" instead of "turn.0"; null coerces
    // to 0 in a numeric comparison, so it has to be rejected explicitly.
    if (idx === null) return { error: `${key} needs a side index (${key}.0)` };
    if (!(idx >= 0 && idx < match[key].length)) return { error: 'no such side' };
  } else if (idx !== null) {
    return { error: `${key} is not a per-side field` };
  }

  if (def.type === 'int') {
    const n = toInt(value);
    if (!(n >= def.min && n <= def.max)) return { error: `${key} is ${def.min}-${def.max}` };
    if (def.perSide) match[key][idx] = n; else match[key] = n;

    if (key === 'half') {
      match.turn = match.turn.map(() => 1);
      match.rerolls = match.rerolls.map((_, i) => match.rerollBase[i] || 0);
      match.rerollUsed = match.rerollUsed.map(() => false);
      return { ok: true, msg: n >= MAX_HALF ? 'Overtime — turns reset, rerolls refilled' : `Half ${n} — turns reset, rerolls refilled` };
    }
    if (key === 'turn') {
      match.rerollUsed[idx] = false;
      return { ok: true, msg: `Side ${idx + 1}: turn ${n}/${MAX_TURN}` };
    }
    if (key === 'rerollBase') {
      // Setting the team's reroll count during setup also sets what it has now
      // -- including upwards, which is the whole point when a team joins a
      // side that started empty on zero.
      match.rerolls[idx] = n;
      return { ok: true, msg: `Side ${idx + 1}: ${n} team rerolls` };
    }
    return { ok: true, msg: `Side ${idx + 1}: ${def.label} ${n}` };
  }

  if (def.type === 'bool') {
    const b = Boolean(value);
    match[key][idx] = b;
    return { ok: true, msg: `Side ${idx + 1}: ${b ? 'reroll used dis turn' : 'reroll available'}` };
  }

  // string
  if (typeof value !== 'string') return { error: `${key} must be text` };
  const s = clip(value, def.max);
  if (def.perSide) match[key][idx] = s; else match[key] = s;
  return { ok: true, msg: def.perSide ? `Side ${idx + 1}: ${def.label} — ${s || 'none'}` : `${def.label}: ${s || 'none'}` };
}

// ---------------------------------------------------------------------------
// Done summary -> league match report
// ---------------------------------------------------------------------------

// Sum the per-player events into the four stats the league stores for Blood
// Bowl (GAME_STATS.bloodbowl: td / cas / comp / int), and hand back the
// individual credit alongside it.
//
// `scorers` and `mvp` are already in the league's POST shape — league.js
// validSide() takes side.scorers = [{ player, stat, count }] and side.mvp =
// "<player name>" — so the match report can be filed without reshaping.
// Deflections are deliberately NOT in `scorers`: the league has no `deflect`
// stat, and validSide() silently rewrites an unknown stat id to 'td', which
// would invent touchdowns. They stay visible in `players[].deflect`.
function doneSummary(sides) {
  const list = Array.isArray(sides) ? sides : [];
  return {
    game: 'bloodbowl',
    sides: list.map((s, i) => {
      const units = (s && Array.isArray(s.units) ? s.units : []);
      const totals = { td: 0, cas: 0, comp: 0, int: 0, deflect: 0 };
      const players = [];
      const scorers = [];
      let mvp = '';
      for (const u of units) {
        const ev = u.events || emptyEvents();
        for (const k of EVENTS) totals[k] += Math.max(0, toInt(ev[k]) || 0);
        const row = {
          name: u.name,
          td: ev.td || 0,
          cas: ev.cas || 0,
          comp: ev.comp || 0,
          int: ev.int || 0,
          deflect: ev.deflect || 0,
          mvp: Boolean(u.mvp),
        };
        row.spp = LEAGUE_STATS.reduce((n, k) => n + row[k] * SPP[k], 0)
          + row.deflect * SPP.deflect + (row.mvp ? SPP.mvp : 0);
        if (row.td || row.cas || row.comp || row.int || row.deflect || row.mvp) players.push(row);
        for (const k of LEAGUE_STATS) {
          if (row[k] > 0) scorers.push({ player: u.name, stat: k, count: Math.min(row[k], MAX_EVENT) });
        }
        // One MVP per side; the first flagged player wins if the UI let two through.
        if (row.mvp && !mvp) mvp = u.name;
      }
      return {
        name: (s && s.name) || `Side ${i + 1}`,
        td: totals.td,
        cas: totals.cas,
        comp: totals.comp,
        int: totals.int,
        deflect: totals.deflect,
        players,
        scorers: scorers.slice(0, 30),
        mvp,
      };
    }),
  };
}

module.exports = {
  id: 'bloodbowl',
  name: 'Blood Bowl',
  leagueGame: 'bloodbowl',
  snapshotUnits,
  snapshotMeta,
  applyPatch,
  autoDestroyed,
  resetTracking,
  MATCH_FIELDS,
  newMatch,
  applyMatchPatch,
  doneSummary,
  // Shared vocabulary for the client and the orchestrator.
  STATES, STATE_NAMES, OFF_PITCH, EVENTS, EVENT_NAMES, EVENT_SHORT, SPP, LEAGUE_STATS,
  WEATHER, MAX_EVENT, MAX_PLAYERS, MAX_HALF, MAX_TURN, MAX_SCORE, MAX_REROLLS,
};
