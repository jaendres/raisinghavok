#!/usr/bin/env node
// Builds server/data/necromunda-catalog.json for the Necromunda gang builder.
//
// Why this isn't a straight BSData import: the task originally pointed at
// github.com/BSData/necromunda, but that repo turned out to be Necromunda
// *1st edition* (1995) — deprecated by its own README. The sibling repo
// github.com/BSData/necromunda-gang-war covers the current (2017+) game but
// was last touched in 2020: it predates the House of X books, is missing
// Delaque and Enforcers entirely, and prices fighters at Gang War-era costs.
//
// So the catalog is assembled honestly from three layers:
//   1. FIGHTERS  — gyrinx-app/gyrinx (Apache-2.0) content YAML: House-book-era
//      fighter types, costs and full statlines for the seven core gangs.
//   2. WEAPON/WARGEAR PROFILES + five house equipment lists — parsed from the
//      BSData necromunda-gang-war XML (.gst shared profiles + per-gang .cat
//      equipment groups). Weapon profiles are stable across the edition;
//      per-gang prices are Gang War era where no better source exists.
//   3. HAND OVERLAY — Delaque and Enforcer equipment access (their .cat files
//      never existed), price fallbacks from the gyrinx Trading Post list, and
//      gang-composition rules. Anything hand-entered is marked as such.
//
// Usage:
//   node scripts/necromunda-build-catalog.mjs --bsdata <dir> --gyrinx <dir> [--out <file>]
//   node scripts/necromunda-build-catalog.mjs --check          # validate the checked-in JSON only
//
// No dependencies beyond Node core (the XML walker and YAML reader below are
// scoped to exactly the subset these files use).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DEFAULT = path.join(ROOT, 'server', 'data', 'necromunda-catalog.json');

// ---------------------------------------------------------------- CLI

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : undefined;
};
const CHECK_ONLY = args.includes('--check');
const OUT = opt('out') || OUT_DEFAULT;

// ---------------------------------------------------------------- tiny XML

const ENT = { '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' };
const decode = (s) => s.replace(/&(?:quot|apos|lt|gt|amp);/g, (m) => ENT[m]);

// Minimal element-tree parser for BattleScribe files: elements, attributes,
// text. No CDATA/doctype/processing-instruction support (none appear).
function parseXml(text) {
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[^>]*\?>|<\/([\w:-]+)\s*>|<([\w:-]+)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[1]) { stack.pop(); continue; }                    // close tag
    if (m[2]) {                                             // open tag
      const attrs = {};
      for (const a of m[3].matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[a[1]] = decode(a[2]);
      const node = { tag: m[2], attrs, children: [] };
      stack[stack.length - 1].children.push(node);
      if (!m[4]) stack.push(node);
    } else if (m[5] && m[5].trim()) {
      stack[stack.length - 1].children.push({ tag: '#text', text: decode(m[5].trim()), children: [] });
    }
  }
  return root;
}

function* walk(node) {
  yield node;
  for (const c of node.children) yield* walk(c);
}

// ---------------------------------------------------------------- tiny YAML
// Reads the gyrinx content files: a top-level key holding a list of flat maps,
// each possibly containing one level of nested map (stats:) or empty list.
function parseGyrinxYaml(text) {
  const items = [];
  let cur = null, nest = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\t/g, '  ');
    let m;
    if ((m = line.match(/^  - (\w+): (.*)$/))) {
      cur = { [m[1]]: yval(m[2]) };
      items.push(cur); nest = null;
    } else if (!cur) {
      continue;
    } else if ((m = line.match(/^    (\w+):\s*$/))) {
      nest = {}; cur[m[1]] = nest;
    } else if ((m = line.match(/^    (\w+): (.*)$/))) {
      nest = null; cur[m[1]] = yval(m[2]);
    } else if ((m = line.match(/^      (\w+): (.*)$/))) {
      if (nest) nest[m[1]] = yval(m[2]);
    }
  }
  return items;
}
function yval(s) {
  s = s.trim();
  if (s === '[]') return [];
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  return s.replace(/^['"]|['"]$/g, '');
}

// ---------------------------------------------------------------- name keys

// Normalized key for matching names across sources ("Stub Gun" / "Stub gun" /
// '"Renderizer" Serrated Axe', UK/US armour spelling, etc.).
const norm = (s) => String(s).toLowerCase().replace(/armour/g, 'armor').replace(/[^a-z0-9]+/g, '');
// A profile like "Shotgun - Solid Slug" belongs to base weapon "Shotgun".
const baseOf = (name) => name.split(' - ')[0].trim();

// ---------------------------------------------------------------- BSData

function gitCommit(dir) {
  try {
    const head = fs.readFileSync(path.join(dir, '.git', 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref:')) return head;
    return fs.readFileSync(path.join(dir, '.git', head.slice(5).trim()), 'utf8').trim();
  } catch { return 'unknown'; }
}

const WEAPON_CHARS = { 'Rng S': 'rngS', 'Rng L': 'rngL', 'Acc S': 'accS', 'Acc L': 'accL', Str: 'str', AP: 'ap', D: 'd', Ammo: 'ammo', Traits: 'traits' };

function readProfiles(tree) {
  const out = [];
  for (const n of walk(tree)) {
    if (n.tag !== 'profile' || n.attrs.profileTypeName !== 'Weapon') continue;
    const p = { name: n.attrs.name };
    for (const c of walk(n)) {
      if (c.tag === 'characteristic' && WEAPON_CHARS[c.attrs.name]) {
        p[WEAPON_CHARS[c.attrs.name]] = c.attrs.value ?? '-';
      }
    }
    out.push(p);
  }
  return out;
}

// name -> credits for every selectionEntry that carries a nonzero Credits cost
function readCosts(tree, into = new Map()) {
  for (const n of walk(tree)) {
    if (n.tag !== 'selectionEntry') continue;
    for (const c of n.children) {
      if (c.tag !== 'costs') continue;
      for (const cost of c.children) {
        if (cost.tag === 'cost' && cost.attrs.name?.trim() === 'Credits') {
          const v = parseFloat(cost.attrs.value);
          if (v > 0 && !into.has(norm(n.attrs.name))) into.set(norm(n.attrs.name), Math.round(v));
        }
      }
    }
  }
  return into;
}

function idIndex(tree, into = new Map()) {
  for (const n of walk(tree)) {
    if ((n.tag === 'selectionEntry' || n.tag === 'selectionEntryGroup') && n.attrs.id) {
      into.set(n.attrs.id, n);
    }
  }
  return into;
}

// Union of item names linked from every group literally named Weapons/Wargear
// in a .cat, following group links one level deep (e.g. "Goliath Weapons").
function readGangEquipment(catTree, ids) {
  const names = new Set();
  const addFrom = (groupNode, depth) => {
    if (!groupNode || depth > 3) return;
    for (const c of groupNode.children) {
      if (c.tag === 'selectionEntries' || c.tag === 'selectionEntryGroups' || c.tag === 'entryLinks') {
        for (const e of c.children) {
          if (e.tag === 'selectionEntry') names.add(e.attrs.name);
          else if (e.tag === 'selectionEntryGroup') addFrom(e, depth + 1);
          else if (e.tag === 'entryLink') {
            const t = ids.get(e.attrs.targetId);
            if (!t) continue;
            if (t.tag === 'selectionEntry') names.add(t.attrs.name);
            else addFrom(t, depth + 1);
          }
        }
      }
    }
  };
  for (const n of walk(catTree)) {
    if (n.tag === 'selectionEntryGroup' && (n.attrs.name === 'Weapons' || n.attrs.name === 'Wargear')) {
      addFrom(n, 0);
    }
  }
  return [...names];
}

// ---------------------------------------------------------------- hand data
// Everything below this line is hand-compiled (and says so in the meta).

const GANGS = [
  { key: 'goliath',  name: 'Goliath',           book: 'House of Chains (2019)',  gyrinx: 'goliath_hoc.yaml',  cat: 'Goliath.cat',  houseSkill: 'Muscle' },
  { key: 'escher',   name: 'Escher',            book: 'House of Blades (2019)',  gyrinx: 'escher_hob.yaml',   cat: 'Escher.cat',   houseSkill: 'Finesse' },
  { key: 'orlock',   name: 'Orlock',            book: 'House of Iron (2020)',    gyrinx: 'orlock_hoi.yaml',   cat: 'Orlock.cat',   houseSkill: 'Bravado' },
  { key: 'vansaar',  name: 'Van Saar',          book: 'House of Artifice (2020)',gyrinx: 'van_saar_hoa.yaml', cat: 'Van Saar.cat', houseSkill: 'Tech' },
  { key: 'delaque',  name: 'Delaque',           book: 'House of Shadow (2021)',  gyrinx: 'delaque_hos.yaml',  cat: null,           houseSkill: 'Obfuscation' },
  { key: 'cawdor',   name: 'Cawdor',            book: 'House of Faith (2021)',   gyrinx: 'cawdor_hof.yaml',   cat: 'Cawdor.cat',   houseSkill: 'Piety' },
  { key: 'enforcers',name: 'Palanite Enforcers',book: 'Book of Judgement (2019)',gyrinx: 'enforcers.yaml',    cat: null,           houseSkill: 'Palanite Drill' },
];

// Fighter-level fixes to the gyrinx data (each is reported when applied).
const FIGHTER_FIXES = [
  { gang: 'escher', type: 'Queen', set: { category: 'Leader' }, why: 'Escher Gang Queen is the gang Leader; source file categorises her as Champion' },
];

// Equipment access for the two gangs BSData never covered. Names must resolve
// against parsed profiles or the wargear list; prices resolve via the
// Gang War shared costs, then the gyrinx Trading Post list, then `cost` here.
const HAND_EQUIPMENT = {
  delaque: [
    'Stub gun', 'Autopistol', 'Laspistol', 'Plasma pistol', 'Web Pistol',
    'Autogun', 'Lasgun', 'Shotgun', 'Long Las', 'Long Rifle',
    'Flamer', 'Meltagun', 'Web gun', 'Grenade Launcher',
    'Fighting knife', 'Stiletto knife', 'Power knife', 'Sword', 'Shock Stave',
    'Frag grenade', 'Krak grenade', 'Smoke grenade', 'Choke gas grenade',
    'Flak Armor', 'Mesh Armor', 'Armoured undersuit',
    'Filter plugs', 'Photo-goggles', 'Respirator', 'Infra-sight', 'Grapnel launcher',
  ],
  enforcers: [
    'Stub gun', 'Autopistol',
    { name: 'Enforcer Boltgun', cost: 50, note: 'improved ammo roll vs standard boltgun; profile shown is the standard boltgun' , aliasProfile: 'Boltgun' },
    { name: 'Concussion Carbine', cost: 30, note: 'Book of Judgement — profile not in source data' },
    'Combat Shotgun', 'Shotgun', 'Grenade Launcher', 'Heavy Stubber',
    'Shock Baton', 'Shock Stave',
    'Frag grenade', 'Krak grenade', 'Smoke grenade', 'Photon flash flare',
    { name: 'Vigilance Assault Shield', cost: 40, note: 'Subjugator pattern; treated as wargear' },
    'Layered Flak Armor', 'Hardened Layered Flak', 'Magnacles', 'Photo-goggles', 'Respirator',
  ],
  // Signature House-book items the Gang War data predates (hand prices).
  cawdor: [
    { name: 'Polearm', cost: 15, note: 'House of Faith price, hand-entered' },
    { name: 'Blunderbuss', cost: 30, note: 'House of Faith price, hand-entered', aliasProfile: 'Bluderbuss' },
  ],
  vansaar: [
    { name: 'Armoured Bodyglove', cost: 15, note: 'House of Artifice price, hand-entered; counts as armour' },
  ],
  // Standard kit every house list can buy even where the Gang War data lacked it.
  common: ['Flak Armor', 'Mesh Armor'],
};

const RULES = {
  startingCredits: 1000,
  leader: 'A gang must include exactly one Leader.',
  gangFighterMajority: 'Fighters with the Gang Fighter rule (Gangers and Juves) must make up at least half the gang.',
  specialists: 'At gang founding only one Ganger may be upgraded to a Specialist (campaign play).',
  notes: 'Light-touch validation only: the builder warns, it does not referee. Check the House books for anything contentious.',
};

const CAVEATS = [
  'Fighter names, costs and statlines come from the gyrinx-app content library (House of X era) and were spot-checked against community sources.',
  'Weapon profiles and the five house equipment lists come from BSData necromunda-gang-war (last updated 2020): per-gang prices there are Gang War era and may differ from the House books by small amounts; weapons the House books added later are missing from those lists.',
  'Delaque and Enforcer equipment access is hand-compiled; prices for those items are Trading Post prices (or hand-entered where marked) rather than house-list prices.',
  'Items marked with an empty profile list (e.g. Concussion Carbine) have no profile in the source data — look them up in the book.',
  'Ld/Cl/Wil/Int and WS/BS/I are target numbers (render with a +). Crew statlines of 0 mean the characteristic does not apply (vehicle crew).',
];

// ---------------------------------------------------------------- validation

function validateCatalog(cat) {
  const errs = [];
  const must = (cond, msg) => { if (!cond) errs.push(msg); };
  must(cat.meta && Array.isArray(cat.meta.sources) && cat.meta.sources.length >= 2, 'meta.sources missing');
  must(cat.meta?.rules?.startingCredits > 0, 'meta.rules.startingCredits missing');
  must(cat.weapons && typeof cat.weapons === 'object', 'weapons dict missing');
  must(cat.wargear && typeof cat.wargear === 'object', 'wargear dict missing');
  const gangs = Object.entries(cat.gangs || {});
  must(gangs.length >= 7, `expected >=7 gangs, got ${gangs.length}`);
  for (const [key, g] of gangs) {
    must(Array.isArray(g.fighters) && g.fighters.length >= 4, `${key}: too few fighters`);
    must(g.fighters.some((f) => f.category === 'Leader'), `${key}: no leader fighter`);
    must(Array.isArray(g.equipment) && g.equipment.length >= 10, `${key}: equipment list too short`);
    for (const f of g.fighters || []) {
      must(typeof f.cost === 'number' && f.cost >= 0, `${key}/${f.name}: bad cost`);
      for (const k of ['m', 'ws', 'bs', 's', 't', 'w', 'i', 'a', 'ld', 'cl', 'wil', 'int']) {
        must(typeof f.stats?.[k] === 'number', `${key}/${f.name}: missing stat ${k}`);
      }
    }
    for (const e of g.equipment || []) {
      must(typeof e.cost === 'number' && e.cost > 0, `${key}/${e.name}: unpriced equipment`);
      must(cat.weapons[e.name] || cat.wargear[e.name], `${key}/${e.name}: not in weapons/wargear`);
    }
  }
  for (const [name, w] of Object.entries(cat.weapons || {})) {
    must(Array.isArray(w.profiles), `weapon ${name}: profiles not a list`);
  }
  return errs;
}

// ---------------------------------------------------------------- build

function build(bsdataDir, gyrinxDir) {
  const report = { skipped: [], fixes: [], counts: {} };

  // ---- BSData: profiles, costs, per-gang lists
  const gstText = fs.readFileSync(path.join(bsdataDir, 'Necromunda-Gang-War.gst'), 'utf8');
  const gst = parseXml(gstText);
  const ids = idIndex(gst);
  const costs = readCosts(gst);
  const allProfiles = readProfiles(gst);

  const catTrees = {};
  for (const g of GANGS) {
    if (!g.cat) continue;
    const tree = parseXml(fs.readFileSync(path.join(bsdataDir, g.cat), 'utf8'));
    catTrees[g.key] = tree;
    idIndex(tree, ids);
    readCosts(tree, costs);
    allProfiles.push(...readProfiles(tree));
  }

  // Group profiles by base weapon name.
  const weaponsByKey = new Map(); // norm(base) -> { name, profiles }
  for (const p of allProfiles) {
    const base = baseOf(p.name);
    const k = norm(base);
    if (!weaponsByKey.has(k)) weaponsByKey.set(k, { name: base, profiles: [] });
    const w = weaponsByKey.get(k);
    if (!w.profiles.some((q) => q.name === p.name)) {
      w.profiles.push({
        name: p.name === base ? undefined : p.name.slice(base.length).replace(/^\s*-\s*/, ''),
        rngS: p.rngS ?? '-', rngL: p.rngL ?? '-', accS: p.accS ?? '-', accL: p.accL ?? '-',
        str: p.str ?? '-', ap: p.ap ?? '-', d: p.d ?? '-', ammo: p.ammo ?? '-',
        traits: p.traits === '-' ? '' : (p.traits ?? ''),
      });
    }
  }

  // ---- gyrinx: fighters, trading-post prices, skills
  const gy = (f) => parseGyrinxYaml(fs.readFileSync(path.join(gyrinxDir, 'content', 'necromunda-2018', 'data', f), 'utf8'));
  const tpItems = gy('equipment.yaml');
  const tp = new Map(); // norm(name) -> {cost, category}
  for (const e of tpItems) {
    if (e.name && typeof e.trading_post_cost === 'number' && e.trading_post_cost > 0) {
      const k = norm(e.name);
      if (!tp.has(k)) tp.set(k, { cost: e.trading_post_cost, category: e.category });
    }
  }
  const skills = {};
  for (const s of gy('skill.yaml')) {
    if (!s.category || !s.name) continue;
    (skills[s.category] ||= []).push(s.name);
  }

  // ---- assemble gangs
  const gangs = {};
  const usedWeapons = new Map();
  const wargear = {};
  const statKeys = ['m', 'ws', 'bs', 's', 't', 'w', 'i', 'a', 'ld', 'cl', 'wil', 'int'];

  const CAT_ORDER = { Leader: 0, Champion: 1, Prospect: 2, Ganger: 3, Juve: 4, Crew: 5 };

  for (const g of GANGS) {
    // fighters
    const rows = gy(path.join('fighter', g.gyrinx));
    const seen = new Set();
    const fighters = [];
    for (const r of rows) {
      if (!r.type || !r.category || typeof r.cost !== 'number') { report.skipped.push(`${g.key}: fighter row missing fields`); continue; }
      const dupKey = r.type + '|' + r.category + '|' + r.cost;
      if (seen.has(dupKey)) { report.fixes.push(`${g.key}: deduped repeated "${r.type}"`); continue; }
      seen.add(dupKey);
      const f = { name: r.type, category: r.category, cost: r.cost, stats: {}, defaultEquipment: [] };
      for (const fix of FIGHTER_FIXES) {
        if (fix.gang === g.key && fix.type === r.type) { Object.assign(f, fix.set); report.fixes.push(`${g.key}: ${r.type} — ${fix.why}`); }
      }
      let ok = true;
      for (const k of statKeys) {
        const v = r.stats?.[k];
        if (typeof v !== 'number') { ok = false; break; }
        f.stats[k] = v;
      }
      if (!ok) { report.skipped.push(`${g.key}: ${r.type} — incomplete statline`); continue; }
      if (f.name.includes('Specialist')) f.specialist = true;
      if (f.category === 'Crew') f.note = 'Vehicle crew (Ash Wastes) — vehicle rules not modeled here.';
      fighters.push(f);
    }
    fighters.sort((a, b) => (CAT_ORDER[a.category] ?? 9) - (CAT_ORDER[b.category] ?? 9) || b.cost - a.cost);

    // equipment
    let names;
    let listSource;
    if (catTrees[g.key]) {
      names = readGangEquipment(catTrees[g.key], ids)
        .concat(HAND_EQUIPMENT.common, HAND_EQUIPMENT[g.key] || []);
      listSource = 'bsdata-gang-war (+hand additions)';
    } else {
      names = HAND_EQUIPMENT[g.key] || [];
      listSource = 'hand-compiled';
    }

    const equipment = [];
    const eqSeen = new Set();
    for (const item of names) {
      const spec = typeof item === 'string' ? { name: item } : item;
      const k = norm(spec.name);
      // skip meta-entries that leak from BattleScribe group plumbing
      if (/^(juve|champion|leader|ganger|specialist|trading post)\b/i.test(spec.name) || /skills?$/i.test(spec.name)) continue;

      const profKey = norm(spec.aliasProfile || baseOf(spec.name));
      const weapon = weaponsByKey.get(profKey);
      const tpHit = tp.get(k);
      const cost = costs.get(k) ?? tpHit?.cost ?? spec.cost;
      if (typeof cost !== 'number') { report.skipped.push(`${g.key}: "${spec.name}" — no price in any source`); continue; }
      const priceSource = costs.has(k) ? 'gang-war' : tpHit ? 'trading-post' : 'hand';
      const category = tpHit?.category
        || (weapon ? 'Weapons' : /grenade|charge|flare/i.test(spec.name) ? 'Grenades' : 'Gear');

      // Canonical display name: the profile's base name (fixes case drift like
      // "Frag grenade" vs "Frag Grenade" across source files), except for
      // aliased items that deliberately keep their own name.
      const canonical = weapon && !spec.aliasProfile ? weapon.name : spec.name;
      if (eqSeen.has(norm(canonical)) || eqSeen.has(k)) continue;
      eqSeen.add(norm(canonical));
      const entry = { name: canonical, cost, category, priceSource };
      if (spec.note) entry.note = spec.note;
      equipment.push(entry);

      if (weapon) {
        if (!usedWeapons.has(canonical)) {
          usedWeapons.set(canonical, { category, profiles: weapon.profiles, ...(spec.aliasProfile ? { profileOf: weapon.name } : {}) });
        }
      } else if (!wargear[canonical]) {
        wargear[canonical] = { category, ...(spec.note ? { note: spec.note } : {}) };
      }
    }
    equipment.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

    gangs[g.key] = {
      name: g.name, book: g.book, houseSkill: g.houseSkill,
      equipmentListSource: listSource,
      fighters, equipment,
    };
    report.counts[g.key] = { fighters: fighters.length, equipment: equipment.length };
  }

  const weapons = Object.fromEntries([...usedWeapons.entries()].sort((a, b) => a[0].localeCompare(b[0])));

  const catalog = {
    meta: {
      game: 'Necromunda',
      edition: '2018 ruleset, House of X era gang lists',
      generated: new Date().toISOString().slice(0, 10),
      source: 'hand-assembled from the sources below (no single clean machine source exists)',
      sources: [
        {
          role: 'fighters (types, costs, statlines) + trading-post prices + skill lists',
          repo: 'github.com/gyrinx-app/gyrinx', license: 'Apache-2.0',
          commit: gitCommit(gyrinxDir),
          files: 'content/necromunda-2018/data/{fighter/*,equipment.yaml,skill.yaml}',
        },
        {
          role: 'weapon/wargear profiles + Goliath/Escher/Orlock/Van Saar/Cawdor equipment lists and prices',
          repo: 'github.com/BSData/necromunda-gang-war',
          commit: gitCommit(bsdataDir),
          edition: 'Necromunda: Gang War (2017–2020 data)',
        },
        {
          role: 'Delaque + Enforcer equipment access, fixes, composition rules',
          repo: 'hand-compiled', note: 'see CAVEATS',
        },
      ],
      rejected: {
        repo: 'github.com/BSData/necromunda',
        why: 'Necromunda 1st edition (1995); README marks it deprecated/unsupported — wrong game for a current-rules builder.',
      },
      rules: RULES,
      caveats: CAVEATS,
      report,
    },
    skills,
    weapons,
    wargear,
    gangs,
  };

  const errs = validateCatalog(catalog);
  return { catalog, errs, report };
}

// ---------------------------------------------------------------- main

if (CHECK_ONLY) {
  const cat = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const errs = validateCatalog(cat);
  if (errs.length) { console.error('INVALID:\n  ' + errs.join('\n  ')); process.exit(1); }
  console.log(`OK: ${Object.keys(cat.gangs).length} gangs, ${Object.keys(cat.weapons).length} weapons, ${Object.keys(cat.wargear).length} wargear items.`);
  process.exit(0);
}

const bsdataDir = opt('bsdata');
const gyrinxDir = opt('gyrinx');
if (!bsdataDir || !gyrinxDir) {
  console.error('Usage: node scripts/necromunda-build-catalog.mjs --bsdata <necromunda-gang-war clone> --gyrinx <gyrinx clone> [--out <file>]');
  console.error('   or: node scripts/necromunda-build-catalog.mjs --check');
  process.exit(2);
}

const { catalog, errs, report } = build(bsdataDir, gyrinxDir);
if (errs.length) {
  console.error('Catalog failed validation:\n  ' + errs.join('\n  '));
  process.exit(1);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(catalog, null, 1) + '\n');

console.log(`Wrote ${OUT}`);
console.log(`Gangs: ${Object.keys(catalog.gangs).length}`);
for (const [k, c] of Object.entries(report.counts)) console.log(`  ${k}: ${c.fighters} fighters, ${c.equipment} equipment items`);
console.log(`Weapons: ${Object.keys(catalog.weapons).length}, wargear: ${Object.keys(catalog.wargear).length}, skill sets: ${Object.keys(catalog.skills).length}`);
if (report.fixes.length) console.log('Fixes applied:\n  ' + report.fixes.join('\n  '));
if (report.skipped.length) console.log('Skipped/flagged:\n  ' + report.skipped.join('\n  '));
