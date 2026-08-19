// Game Night — Trench Crusade at-the-table tracker.
//
// Plugs into server/table.js the same way the other games do: snapshot the
// units once (the table is the record sheet, not a view over the archive),
// then take single-field patches validated hard against that snapshot.
//
// Where the data comes from
// -------------------------
// A Trench Crusade side is PASTED, not hydrated from a database: the warband
// lives in localStorage in our own builder (public/builders/trenchcrusade),
// and the player pastes its text export. server/table.js already parses that
// export for My Lists (parseTrenchcrusadeExport) — pass its output straight
// in as { parsed }. If you only have the raw text, pass { text } and this
// module parses it with the same grammar.
//
// Every unit is then ENRICHED from server/data/trenchcrusade-catalog.json by
// unit name (statline, keywords, abilities, warband) and every battlekit item
// by item name (weapon profile, keywords, rules). Nothing is invented: a unit
// the catalog does not know keeps whatever the paste carried, and reports
// itself with matched:false.
//
// What is tracked, and how confident we are about it
// -------------------------------------------------
// * bloodMarkers — THE Trench Crusade mechanic. Markers are placed next to a
//   model and worsen its rolls; loads of catalog rules text places, removes
//   and counts them ("place 1 BLOOD MARKER next to the model…"). 0..20 here;
//   the rules place no universal ceiling, 20 is just a sane tracker cap.
// * state — active / injured / outOfAction. The rules' injury outcomes are
//   MINOR INJURY, DOWN and OUT OF ACTION (the catalog quotes all three, incl.
//   TOUGH converting an OUT OF ACTION into a DOWN). 'injured' is the tracker's
//   name for Down/Minor Injury; outOfAction means the model leaves the table.
// * wounds / maxWounds — TRACKER AID, NOT AN OFFICIAL CHARACTERISTIC. Trench
//   Crusade models have no Wounds stat (see any unit's stats block: movement,
//   ranged, melee, armour, base — that's all there is). maxWounds here counts
//   injury results absorbed before a model is out: 3 by default, 4 for TOUGH
//   models (TOUGH demonstrably buys one extra step). Treat it as a scratch
//   counter, not a rule.
// * activated — Trench Crusade alternates activations, one model at a time,
//   and each model activates once per round. Tracking who has gone is the
//   other thing players lose track of; roundReset() clears the whole table.
// * used[] — equipment spent. oneUse is flagged ONLY from evidence in the
//   catalog: the CONSUMABLE keyword, or rules text saying "once per game".
//   Ordinary grenades are NOT flagged (Frag/Gas/Incendiary carry no
//   CONSUMABLE keyword in the official armoury), but any item can still be
//   toggled spent, which is handy for RELOAD weapons.
//
// Warband level (VP / round / morale) is NOT owned by this module — it lives
// on the table's side objects. See MORALE_NOTE below: Trench Crusade does have
// a Morale Phase and Morale Checks (the catalog quotes both), but the exact
// check is not in the catalog, so the tracker models it as a plain flag.
'use strict';

const crypto = require('crypto');
const { CATALOG } = require('./trenchcrusade');

const id = 'trenchcrusade';
const name = 'Trench Crusade';
const leagueGame = 'trenchcrusade';

const MAX_UNITS = 40;
const MAX_BLOOD = 20;          // tracker ceiling, not a rules ceiling
const MAX_EQUIP = 30;
const NOTES_MAX = 200;
const STATES = ['active', 'injured', 'outOfAction'];
const DEFAULT_MAX_WOUNDS = 3;  // injury steps, see the header note

// Honest statement of what we do and don't know about the break/morale rule.
const MORALE_NOTE = 'Trench Crusade resolves a Morale Phase each round and the '
  + 'number of models still standing (not Down, not Out of Action) drives it. The '
  + 'exact check is not in our catalog, so the tracker only counts standing models '
  + 'and offers a plain broken flag — roll the check off the printed rules.';

const toInt = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : NaN);
const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '');
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

// ---------------------------------------------------------------------------
// Catalog indexes (built once at require time)
// ---------------------------------------------------------------------------

// norm(unit name) -> { def, warband }
const UNIT_INDEX = new Map();
// norm(item name) -> { name, profile, note, category }
const ITEM_INDEX = new Map();

for (const band of CATALOG.warbands || []) {
  for (const def of band.units || []) {
    const key = norm(def.name);
    if (key && !UNIT_INDEX.has(key)) UNIT_INDEX.set(key, { def, warband: band.name });
  }
}
for (const [itemName, profile] of Object.entries(CATALOG.battlekit || {})) {
  const key = norm(itemName);
  if (key) ITEM_INDEX.set(key, { name: itemName, profile, note: null, category: profile.category || null });
}
for (const band of CATALOG.warbands || []) {
  for (const entry of band.armoury || []) {
    const key = norm(entry.name);
    if (!key) continue;
    const known = ITEM_INDEX.get(key);
    if (known) {
      // Keep the shared battlekit profile, but pick up a stipulation note and
      // fill in a profile the battlekit table never carried.
      if (!known.note && entry.note) known.note = entry.note;
      if (!known.profile && entry.profile) known.profile = entry.profile;
    } else {
      ITEM_INDEX.set(key, {
        name: entry.name,
        profile: entry.profile || null,
        note: entry.note || null,
        category: entry.category || null,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Paste parsing ({ text } path)
// ---------------------------------------------------------------------------

// Same grammar as server/table.js parseTrenchcrusadeExport, which follows the
// builder's exportSheet(): header lines / "====" fence / unit blocks
// ("LABEL — Unit Name (type) — 95d 1g", then indented statline, Keywords:,
// "Ability: text", Battlekit:, then deeper-indented item profile lines) /
// "====" fence / footer. Kept here so { text } works without table.js
// exporting its parser; pass { parsed } and this is never used.
function parseText(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
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
    if (/^\s{4,}/.test(raw)) { cur.gearProfiles.push(s); continue; }
    if (/Armour/i.test(s) && !s.includes(': ')) { cur.statlines.push(s); continue; }
    const kw = s.match(/^Keywords:\s*(.*)$/i);
    if (kw) { cur.keywords = kw[1].split(/,\s+/); continue; }
    const kit = s.match(/^Battlekit:\s*(.*)$/i);
    if (kit) { cur.gear = kit[1].split(/,\s+/); continue; }
    const ab = s.match(/^([^:]{1,60}):\s+(.*)$/);
    if (ab) {
      if (/Armour/i.test(ab[2])) cur.statlines.push(s);
      else cur.abilities.push({ name: ab[1], text: ab[2] });
      continue;
    }
    unparsed.push(s);
  }
  return { header, sections: [], units, unparsed };
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

// "6"/Infantry — R +1 DICE / M +1 DICE — Armour -2 — base 32mm"
const STAT_RE = /^(.+?)\s+—\s+R\s+(.+?)\s+\/\s+M\s+(.+?)\s+—\s+Armour\s+(\S+)(?:\s+—\s+base\s+(.+))?$/;

function parseStatline(s) {
  const m = String(s == null ? '' : s).trim().match(STAT_RE);
  if (!m) return null;
  return {
    movement: m[1].trim(), ranged: m[2].trim(), melee: m[3].trim(),
    armour: m[4].trim(), base: m[5] ? m[5].trim() : null,
  };
}

const statFromDef = (s) => ({
  movement: clip(s.movement, 40), ranged: clip(s.ranged, 30),
  melee: clip(s.melee, 30), armour: clip(s.armour, 20),
});

// CONSUMABLE (the rules' own one-use keyword) or an explicit "once per game".
function isOneUse(profile, note) {
  if (!profile && !note) return false;
  const kw = ((profile && profile.keywords) || []).map((k) => String(k).toUpperCase());
  if (kw.includes('CONSUMABLE')) return true;
  const text = `${(profile && profile.rules) || ''} ${note || ''}`;
  return /once\s+per\s+game/i.test(text);
}

// "Trench Knife (1d)" / "Hellblade (2g)" -> "Trench Knife"
const stripCost = (s) => String(s == null ? '' : s).replace(/\s*\((?:\d+[dg]|[?]g)\)\s*$/i, '').trim();

function equipEntry(rawName) {
  const itemName = stripCost(rawName);
  if (!itemName) return null;
  const known = ITEM_INDEX.get(norm(itemName));
  const profile = known && known.profile
    ? {
      category: clip(known.profile.category || known.category, 20) || null,
      type: clip(known.profile.type, 30) || null,
      range: clip(known.profile.range, 30) || null,
      keywords: (known.profile.keywords || []).slice(0, 12).map((k) => clip(k, 40)),
      rules: clip(known.profile.rules, 900) || null,
    }
    : null;
  const note = known && known.note ? clip(known.note, 120) : null;
  return {
    name: clip(known ? known.name : itemName, 60),
    profile,
    oneUse: isOneUse(profile, note),
    note,
    matched: Boolean(known),
  };
}

// Freeze one parsed warband member into a table record-sheet entry.
function snapshotUnit(p) {
  // The export prints "LABEL — Unit Name (type)"; the parser puts the label in
  // .name and "Unit Name (type)" in .subtitle. The catalog is keyed on the
  // unit name, so split the subtitle back apart.
  const sub = String(p.subtitle || '').match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  const catalogName = sub ? sub[1].trim() : String(p.subtitle || p.name || '').trim();
  const type = sub ? sub[2].trim() : '';
  const hit = UNIT_INDEX.get(norm(catalogName));
  const def = hit ? hit.def : null;

  // Statline: catalog first, the pasted line as the fallback.
  const pasted = parseStatline((p.statlines || [])[0]);
  const statline = def ? statFromDef(def.stats) : (pasted
    ? { movement: clip(pasted.movement, 40), ranged: clip(pasted.ranged, 30), melee: clip(pasted.melee, 30), armour: clip(pasted.armour, 20) }
    : { movement: '?', ranged: '?', melee: '?', armour: '?' });

  // Alternate profiles (e.g. Grail Thrall -> Fly Thrall) ride along for
  // reference; they are not separately tracked.
  const altProfiles = def && Array.isArray(def.altProfiles)
    ? def.altProfiles.slice(0, 4).map((a) => ({ name: clip(a.name, 40), ...statFromDef(a) }))
    : (p.statlines || []).slice(1, 5).map((line) => {
      const m = String(line).match(/^([^:]{1,40}):\s+(.*)$/);
      const st = parseStatline(m ? m[2] : line);
      return st ? { name: m ? m[1].trim() : 'Alt', movement: st.movement, ranged: st.ranged, melee: st.melee, armour: st.armour } : null;
    }).filter(Boolean);

  const keywords = (def ? def.keywords : (p.keywords || [])).slice(0, 20).map((k) => clip(k, 40));

  const abilities = [];
  const seenAbility = new Set();
  for (const a of (def ? def.abilities : []) || []) {
    if (!a || !a.name) continue;
    seenAbility.add(norm(a.name));
    abilities.push({ name: clip(a.name, 80), text: clip(a.text, 1200) });
  }
  // Anything the paste carried that the catalog didn't (notes, "Comes with").
  const extraEquip = [];
  for (const a of p.abilities || []) {
    if (!a || !a.name) continue;
    if (/^comes with$/i.test(a.name)) {
      for (const g of String(a.text || '').split(/,\s+/)) extraEquip.push(g);
      continue;
    }
    if (seenAbility.has(norm(a.name))) continue;
    abilities.push({ name: clip(a.name, 80), text: clip(a.text, 1200) });
  }
  if (def && def.note && !abilities.some((a) => /^note$/i.test(a.name))) {
    abilities.push({ name: 'Note', text: clip(def.note, 1200) });
  }

  const equipment = [];
  const seenEquip = new Set();
  for (const raw of [...(p.gear || []), ...extraEquip]) {
    if (equipment.length >= MAX_EQUIP) break;
    const e = equipEntry(raw);
    if (!e || !e.name) continue;
    const key = norm(e.name) + '|' + equipment.length;   // duplicates are legal (2 pistols)
    if (seenEquip.has(key)) continue;
    seenEquip.add(key);
    equipment.push(e);
  }

  // Injury steps — a tracker aid, see the header note. TOUGH buys one step.
  const maxWounds = keywords.some((k) => /^TOUGH$/i.test(k)) ? DEFAULT_MAX_WOUNDS + 1 : DEFAULT_MAX_WOUNDS;

  return {
    uid: crypto.randomBytes(4).toString('hex'),
    name: clip(p.name || catalogName || 'Model', 60),
    catalogName: clip(catalogName, 60),
    warband: hit ? clip(hit.warband, 60) : null,
    type: clip(type || (def ? def.type : ''), 30),
    cost: clip(p.cost, 30) || null,
    base: def ? clip(def.stats.base, 20) : (pasted && pasted.base ? clip(pasted.base, 20) : null),
    matched: Boolean(def),
    statline,
    altProfiles,
    keywords,
    abilities: abilities.slice(0, 25),
    equipment,
    // ---- live state ----
    bloodMarkers: 0,
    wounds: 0,
    maxWounds,
    state: 'active',
    activated: false,
    used: [],          // indexes into equipment
    notes: '',
    destroyed: false,
  };
}

// snapshotUnits({ parsed }) / ({ text }) / ({ parsed, text }) -> Unit[]
//
// Returns an ARRAY of units (so `.map`/`.length` work like every other
// snapshot path). The array also carries two non-unit properties for callers
// that want them — they JSON-serialize away harmlessly:
//   .unparsed  lines the parser could not place (show them, don't hide them)
//   .header    the export's header lines (warband name, budget, warband rules)
function snapshotUnits(input) {
  const src = input && typeof input === 'object' ? input : { text: input };
  let parsed = src.parsed;
  if (Array.isArray(parsed)) parsed = { units: parsed, unparsed: [], header: [] };
  if (!parsed || !Array.isArray(parsed.units) || !parsed.units.length) {
    parsed = typeof src.text === 'string' ? parseText(src.text) : { units: [], unparsed: [], header: [] };
  }
  const units = (parsed.units || []).slice(0, MAX_UNITS).map(snapshotUnit);
  Object.defineProperty(units, 'unparsed', {
    value: (parsed.unparsed || []).slice(0, 40).map((s) => clip(s, 200)), enumerable: false,
  });
  Object.defineProperty(units, 'header', {
    value: (parsed.header || []).slice(0, 20).map((s) => clip(s, 200)), enumerable: false,
  });
  return units;
}

// ---------------------------------------------------------------------------
// Patch
// ---------------------------------------------------------------------------

// A model is out of the game when it is Out of Action — Blood Markers alone
// never remove a model, they only make it worse at everything.
function autoDestroyed(u) {
  return u.state === 'outOfAction';
}

const stateLabel = { active: 'Active', injured: 'Injured / Down', outOfAction: 'OUT OF ACTION' };

// Apply one validated patch. Returns { error } on refusal, otherwise
// { ok: true, msg } — msg is the log line server/table.js writes.
function applyPatch(u, field, value) {
  if (!u || typeof field !== 'string') return { error: 'bad patch' };

  if (field === 'bloodMarkers') {
    const n = toInt(value);
    if (!(n >= 0 && n <= MAX_BLOOD)) return { error: `blood markers are 0-${MAX_BLOOD}` };
    u.bloodMarkers = n;
    return { ok: true, msg: `${u.name}: ${n} BLOOD MARKER${n === 1 ? '' : 'S'}` };
  }

  if (field === 'wounds') {
    const max = Number.isFinite(Number(u.maxWounds)) ? Number(u.maxWounds) : DEFAULT_MAX_WOUNDS;
    const n = toInt(value);
    if (!(n >= 0 && n <= max)) return { error: `injuries are 0-${max}` };
    u.wounds = n;
    // Filling the injury track puts the model out; clearing it brings it back.
    if (n >= max) u.state = 'outOfAction';
    else if (u.state === 'outOfAction') u.state = n > 0 ? 'injured' : 'active';
    u.destroyed = autoDestroyed(u);
    return { ok: true, msg: `${u.name}: ${n}/${max} injuries — ${stateLabel[u.state]}` };
  }

  if (field === 'state') {
    const v = String(value);
    if (!STATES.includes(v)) return { error: `state is one of ${STATES.join('/')}` };
    u.state = v;
    if (v === 'active') u.wounds = 0;
    if (v === 'outOfAction' && u.wounds < u.maxWounds) u.wounds = u.maxWounds;
    u.destroyed = autoDestroyed(u);
    return { ok: true, msg: `${u.name}: ${stateLabel[v]}` };
  }

  if (field === 'activated') {
    u.activated = Boolean(value);
    return { ok: true, msg: `${u.name}: ${u.activated ? 'activated dis round' : 'activation cleared'}` };
  }

  if (field.startsWith('used.')) {
    const i = toInt(field.slice('used.'.length));
    const item = (u.equipment || [])[i];
    if (!item) return { error: 'no such equipment' };
    const set = new Set(u.used || []);
    if (value) set.add(i); else set.delete(i);
    u.used = [...set].sort((a, b) => a - b);
    return { ok: true, msg: `${u.name}: ${item.name} ${value ? 'spent' : 'back on da belt'}` };
  }

  if (field === 'notes') {
    if (typeof value !== 'string') return { error: 'notes must be text' };
    u.notes = value.slice(0, NOTES_MAX);
    return { ok: true, msg: `${u.name}: note updated` };
  }

  if (field === 'destroyed') {
    // Keeps the shared Wreck/Revive button honest against `state`.
    u.destroyed = Boolean(value);
    if (u.destroyed) {
      u.state = 'outOfAction';
      u.wounds = u.maxWounds;
    } else if (u.state === 'outOfAction') {
      u.state = 'active';
      u.wounds = 0;
    }
    return { ok: true, msg: `${u.name}: ${u.destroyed ? 'taken OUT OF ACTION' : 'back in da fight'}` };
  }

  return { error: 'unknown field' };
}

// ---------------------------------------------------------------------------
// Round + warband level
// ---------------------------------------------------------------------------

// Alternating activation: every model activates once per round, so the round
// advancing must clear the whole table's activation marks. Call this from the
// round patch in server/table.js. Accepts a flat unit array, an array of
// sides, or a table. Returns how many flags it cleared.
function roundReset(units) {
  const list = flattenUnits(units);
  let n = 0;
  for (const u of list) {
    if (u && u.activated) { u.activated = false; n++; }
  }
  return n;
}

function flattenUnits(x) {
  if (!x) return [];
  if (Array.isArray(x)) {
    return x.flatMap((e) => (e && Array.isArray(e.units) ? e.units : [e]));
  }
  if (Array.isArray(x.sides)) return x.sides.flatMap((s) => s.units || []);
  if (Array.isArray(x.units)) return x.units;
  return [];
}

// Models still on their feet — what the Morale Phase counts (the catalog's
// Field Shrine rule spells it out: models "that are not Down or Out of
// Action"). Exposed so the orchestrator can show it next to the break flag.
function standingModels(units) {
  return flattenUnits(units).filter((u) => u && u.state === 'active' && !u.destroyed).length;
}

const takenOut = (u) => Boolean(u && (u.destroyed || u.state === 'outOfAction'));

// League match report. `sides` is the table's sides array
// ([{ name, vp?, units: [...] }]); `vpBySide` optionally overrides VP by side
// name (VP is scored on the tabletop, same as every other game here).
// Stats match server/league.js GAME_STATS.trenchcrusade exactly: vp, cas.
// cas = ENEMY models taken out (a casualty you caused, not one you suffered).
function doneSummary(sides, vpBySide) {
  const list = Array.isArray(sides) ? sides : (sides && Array.isArray(sides.sides) ? sides.sides : []);
  const by = vpBySide && typeof vpBySide === 'object' ? vpBySide : {};
  const out = (s) => (s.units || []).filter(takenOut).length;
  const total = list.reduce((n, s) => n + out(s), 0);
  return {
    game: leagueGame,
    sides: list.map((s) => {
      const fromBody = toInt(by[s.name]);
      const vp = Number.isFinite(fromBody) ? fromBody : (toInt(s.vp) || 0);
      return {
        name: s.name,
        vp: Math.max(0, Number.isFinite(vp) ? vp : 0),
        cas: total - out(s),
      };
    }),
  };
}

// Zero a unit's live tracking back to its snapshot (My Lists' reset button).
function resetTracking(u) {
  u.bloodMarkers = 0;
  u.wounds = 0;
  u.state = 'active';
  u.activated = false;
  u.used = [];
  u.notes = '';
  u.destroyed = false;
}

module.exports = {
  id,
  name,
  leagueGame,
  snapshotUnits,
  applyPatch,
  autoDestroyed,
  doneSummary,
  roundReset,
  // extras the orchestrator may find useful
  parseText,
  resetTracking,
  standingModels,
  STATES,
  MAX_BLOOD,
  MORALE_NOTE,
  catalogVersion: (CATALOG.meta && CATALOG.meta.rulesVersion) || null,
};
