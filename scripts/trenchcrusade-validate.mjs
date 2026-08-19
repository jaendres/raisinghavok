// Validate server/data/trenchcrusade-catalog.json — shape checks plus
// coverage stats, so a bad edit or regeneration fails loudly before deploy.
//
//   node scripts/trenchcrusade-validate.mjs
//
// Exits non-zero on any hard error. Warnings (equipment without a printed
// profile, advisory notes) are informational only.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = path.join(here, '..', 'server', 'data', 'trenchcrusade-catalog.json');

const cat = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf-8'));

const errors = [];
const warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// ---- meta ----------------------------------------------------------------
for (const k of ['game', 'rulesVersion', 'compiledDate', 'sources', 'note', 'gaps']) {
  if (!cat.meta?.[k]) err(`meta.${k} missing`);
}
if (!Array.isArray(cat.meta?.sources) || !cat.meta.sources.every((s) => /^https?:\/\//.test(s.url))) {
  err('meta.sources must be a list of {url, note} with http(s) urls');
}

// ---- rules ---------------------------------------------------------------
if (cat.rules?.standardDucats !== 700) err('rules.standardDucats should be 700 (official standard game)');
if (cat.rules?.leagueDefaultDucats !== 500) err('rules.leagueDefaultDucats should be 500 (club league setting)');

// ---- battlekit library ---------------------------------------------------
const VALID_CATS = new Set(['ranged', 'melee', 'grenade', 'equipment', 'armour']);
for (const [name, p] of Object.entries(cat.battlekit || {})) {
  if (!VALID_CATS.has(p.category)) err(`battlekit "${name}": bad category "${p.category}"`);
}

// ---- warbands ------------------------------------------------------------
const EXPECTED = [
  'hereticLegion', 'trenchPilgrims', 'newAntioch', 'ironSultanate',
  'blackGrail', 'court', 'mercenaries',
];
const keys = (cat.warbands || []).map((w) => w.key);
for (const k of EXPECTED) if (!keys.includes(k)) err(`warband "${k}" missing`);

const STAT_KEYS = ['movement', 'ranged', 'melee', 'armour', 'base'];
const TYPES = new Set(['elite', 'troop', 'mercenary']);

let totalUnits = 0;
let totalArmoury = 0;
let itemsWithProfile = 0;

for (const w of cat.warbands || []) {
  const where = (s) => `${w.key}: ${s}`;
  if (!w.name || !w.alignment || !w.lore) err(where('name/alignment/lore missing'));

  // units
  for (const u of w.units || []) {
    totalUnits++;
    const at = where(`unit "${u.name}"`);
    if (!u.name) err(where('unnamed unit'));
    if (!TYPES.has(u.type)) err(`${at}: bad type "${u.type}"`);
    if (!(u.ducats > 0 || u.glory > 0)) err(`${at}: no cost (ducats and glory both 0)`);
    if (!u.stats) { err(`${at}: no statline`); continue; }
    for (const k of STAT_KEYS) {
      if (u.stats[k] == null || u.stats[k] === '') err(`${at}: stats.${k} missing`);
    }
    if (u.max != null && u.max < (u.min || 0)) err(`${at}: max < min`);
    if (!Array.isArray(u.keywords)) err(`${at}: keywords missing`);
    if (!u.equip) err(`${at}: equip flags missing`);
    if (w.key === 'mercenaries' && !u.hiredBy) err(`${at}: mercenary without hiredBy`);
    if (u.hiredBy && u.hiredBy !== 'any') {
      for (const h of u.hiredBy) if (!EXPECTED.includes(h)) err(`${at}: hiredBy unknown warband "${h}"`);
    }
  }

  // leader requirements point at real units
  for (const req of w.requires || []) {
    for (const n of req.anyOf) {
      if (!(w.units || []).some((u) => u.name === n)) err(where(`requires names unknown unit "${n}"`));
    }
  }

  // armoury: every weapon-ish item must resolve to a profile (shared library
  // or inline); equipment without a profile is only a warning.
  for (const a of w.armoury || []) {
    totalArmoury++;
    const at = where(`armoury "${a.name}"`);
    if (!VALID_CATS.has(a.category)) err(`${at}: bad category "${a.category}"`);
    if (!(a.ducats > 0 || a.glory > 0)) err(`${at}: no price`);
    if (a.limit != null && !(a.limit > 0)) err(`${at}: bad limit ${a.limit}`);
    const profile = a.profile || cat.battlekit[a.name];
    if (profile) itemsWithProfile++;
    else if (a.category === 'ranged' || a.category === 'melee') err(`${at}: weapon has no profile (not in battlekit library, no inline profile)`);
    else warn(`${at}: no printed profile (rules text lives in the faction list)`);
  }

  // unit extra-allowance names that look like armoury items should resolve
  for (const u of w.units || []) {
    for (const x of u.extra || []) {
      const hit = (w.armoury || []).some((a) => norm(a.name) === norm(x)) || cat.battlekit[x];
      if (!hit) warn(where(`unit "${u.name}" extra "${x}" is an option menu, not an armoury item`));
    }
  }
}

// mercenaries hiredBy coverage: every faction can hire at least one
const mercs = cat.warbands.find((w) => w.key === 'mercenaries');
for (const k of EXPECTED.filter((x) => x !== 'mercenaries')) {
  const n = (mercs?.units || []).filter((u) => u.hiredBy === 'any' || u.hiredBy.includes(k)).length;
  if (!n) warn(`${k}: no hireable mercenaries`);
}

// ---- report ----------------------------------------------------------------
console.log(`Trench Crusade catalog — ${cat.meta.rulesVersion}`);
console.log(`compiled ${cat.meta.compiledDate}, ${cat.meta.sources.length} sources\n`);
console.log('coverage:');
for (const w of cat.warbands) {
  const elites = w.units.filter((u) => u.type === 'elite').length;
  const troops = w.units.filter((u) => u.type === 'troop').length;
  const withAbil = w.units.filter((u) => u.abilities?.length).length;
  console.log(
    `  ${w.name.padEnd(36)} ${String(w.units.length).padStart(2)} units` +
    ` (${elites} elite / ${troops} troop, ${withAbil} with abilities), ${w.armoury.length} armoury items`,
  );
}
console.log(`\n  totals: ${totalUnits} units, ${totalArmoury} armoury items` +
  ` (${itemsWithProfile} with printed profiles), ${Object.keys(cat.battlekit).length} shared battlekit profiles`);
console.log(`  admitted gaps: ${cat.meta.gaps.length}`);

if (warnings.length) {
  console.log(`\n${warnings.length} warnings (informational):`);
  for (const m of warnings.slice(0, 12)) console.log('  ~', m);
  if (warnings.length > 12) console.log(`  ~ ... and ${warnings.length - 12} more`);
}

if (errors.length) {
  console.error(`\n${errors.length} ERRORS:`);
  for (const m of errors) console.error('  !', m);
  process.exit(1);
}
console.log('\nOK — catalog shape is valid.');
