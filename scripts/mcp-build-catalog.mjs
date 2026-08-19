// Build server/data/mcp-catalog.json from the BSData Marvel Crisis Protocol
// repository (BattleScribe XML). Same catalog-in-repo pattern as Blood Bowl:
// this script runs offline, the generated JSON is committed, and the site
// never parses XML at runtime.
//
// Usage:
//   git clone --depth 1 https://github.com/BSData/marvel-crisis-protocol <dir>
//   node scripts/mcp-build-catalog.mjs <dir>
//
// No npm dependencies: BattleScribe files are plain, well-formed XML with
// double-quoted attributes and no CDATA, so a small stack tokenizer is enough.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoDir = process.argv[2];
if (!repoDir || !fs.existsSync(path.join(repoDir, 'MCP Inventory.cat'))) {
  console.error('usage: node scripts/mcp-build-catalog.mjs <path-to-BSData/marvel-crisis-protocol checkout>');
  process.exit(1);
}

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'data', 'mcp-catalog.json');

// ---------------------------------------------------------------- tiny XML

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => s
  .replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ENTITIES[e])
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/�/g, "'"); // source data has a few mangled apostrophes

function parseXML(src) {
  const root = { tag: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<\?[^?]*\?>|<!--[\s\S]*?-->|<([\w:-]+)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>|<\/([\w:-]+)\s*>|([^<]+)/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[1]) {                       // open tag
      const attrs = {};
      for (const a of m[2].matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[a[1]] = decode(a[2]);
      const el = { tag: m[1], attrs, children: [], text: '' };
      stack[stack.length - 1].children.push(el);
      if (!m[3]) stack.push(el);      // not self-closing
    } else if (m[4]) {                // close tag
      stack.pop();
    } else if (m[5]) {                // text
      const t = m[5];
      if (t.trim()) stack[stack.length - 1].text += decode(t);
    }
  }
  return root;
}

// depth-first search helpers
function* walk(el) {
  yield el;
  for (const c of el.children) yield* walk(c);
}
const kids = (el, tag) => el.children.filter((c) => c.tag === tag);
const descend = (el, ...tags) => tags.reduce((list, tag) => list.flatMap((e) => kids(e, tag)), [el]);

// characteristics of a profile -> { name: value }
function chars(profile) {
  const out = {};
  for (const c of descend(profile, 'characteristics', 'characteristic')) {
    out[c.attrs.name] = c.text.trim();
  }
  return out;
}

// ---------------------------------------------------------------- extract

const xml = fs.readFileSync(path.join(repoDir, 'MCP Inventory.cat'), 'utf-8');
const doc = parseXML(xml);

const gaps = [];
const intOr = (s, fallback = null) => {
  const n = parseInt(String(s ?? '').trim(), 10);
  return Number.isFinite(n) ? n : fallback;
};

// A banned/format flag lives either in the entry name ("{Banned - Standard}")
// or in a category link ("Banned - Timeline Standard").
const bannedIn = (entry) =>
  /\{Banned/i.test(entry.attrs.name) ||
  descend(entry, 'categoryLinks', 'categoryLink').some((c) => /^Banned/i.test(c.attrs.name));
const cleanName = (s) => s.replace(/\s*\{[^}]*\}\s*/g, ' ').replace(/\s+/g, ' ').trim();

// ---- characters (selectionEntry type="model") ----

const characters = [];
for (const el of walk(doc)) {
  if (el.tag !== 'selectionEntry' || el.attrs.type !== 'model') continue;

  const rawName = el.attrs.name;
  const nm = rawName.match(/^(.*?)\s*\(([^)]*)\)\s*$/); // "TITLE (Alter Ego)"
  const name = cleanName(nm ? nm[1] : rawName);
  const alterEgo = nm ? nm[2].trim() : null;

  const profiles = descend(el, 'profiles', 'profile');
  const charProfiles = profiles.filter((p) => p.attrs.typeName.trim() === 'Character');
  // Most characters have a Healthy/Injured pair. Size-changers (Ant-Man,
  // Wasp, ...) have a pair per form — the first pair is the normal form.
  // A couple (Hulkbuster) name their forms with no Healthy/Injured at all:
  // fall back to the first profile as the card front.
  let healthy = charProfiles.find((p) => /healthy/i.test(p.attrs.name));
  const injured = charProfiles.find((p) => /injured/i.test(p.attrs.name));
  if (!healthy && charProfiles.length) {
    healthy = charProfiles[0];
    gaps.push(`character "${rawName}": no Healthy profile, using "${healthy.attrs.name}"`);
  }
  if (!healthy) { gaps.push(`character "${rawName}": no Character profile, skipped`); continue; }
  if (charProfiles.length > 2) gaps.push(`character "${rawName}": ${charProfiles.length} Character profiles, using first Healthy/Injured pair`);
  const h = chars(healthy);
  const i = injured ? chars(injured) : {};
  if (!injured) gaps.push(`character "${rawName}": no Injured profile`);

  const threat = intOr(h.Threat);
  if (threat == null) gaps.push(`character "${rawName}": unparseable threat "${h.Threat}"`);

  // Affiliations come from category links; "Character" is the game-wide
  // category and "Grunts" marks summoned minions (threat 0, never picked
  // into a roster directly) — everything else on a model is an affiliation.
  const catNames = descend(el, 'categoryLinks', 'categoryLink')
    .map((c) => c.attrs.name.trim())
    .filter((n) => n && n !== 'Character' && !/^Set -/i.test(n) && !/^Banned/i.test(n));
  const grunt = catNames.includes('Grunts');
  const affiliations = catNames.filter((n) => n !== 'Grunts');

  // Leadership profiles mark the character as a possible affiliation leader.
  const leadership = profiles
    .filter((p) => p.attrs.typeName.trim() === 'Leadership')
    .map((p) => p.attrs.name.trim());

  // BattleScribe marks uniqueness as a max-1 constraint on the entry itself.
  const max = descend(el, 'constraints', 'constraint')
    .find((c) => c.attrs.type === 'max' && c.attrs.scope === 'parent');
  const unique = !max || parseFloat(max.attrs.value) <= 1;

  characters.push({
    id: el.attrs.id,
    name,
    alterEgo,
    threat,
    affiliations,
    stamina: { healthy: intOr(h.Stamina), injured: intOr(i.Stamina) },
    movement: (h.Speed || '').trim() || null,
    size: intOr(h.Size),
    defenses: { physical: intOr(h['Physical Defense']), energy: intOr(h['Energy Defense']), mystic: intOr(h['Mystic Defense']) },
    unique,
    grunt,
    leader: leadership.length > 0,
    leadership,
  });
}
characters.sort((a, b) => a.name.localeCompare(b.name));

// ---- team tactic cards ----

const tactics = [];
for (const el of walk(doc)) {
  if (el.tag !== 'selectionEntry') continue;
  const profile = descend(el, 'profiles', 'profile')
    .find((p) => p.attrs.typeName.trim() === 'Team Tactics');
  if (!profile) continue;
  const c = chars(profile);
  // Restriction as printed: an affiliation name, a character-specific
  // grouping, or null for unrestricted cards ("Unaffiliated" in the data).
  let affiliation = (c.Affiliation || '').trim() || null;
  if (affiliation === 'Unaffiliated') affiliation = null;
  if (affiliation === 'Innate') {   // one known data typo in the source
    gaps.push(`tactic "${el.attrs.name}": affiliation "Innate" in source, treated as unrestricted`);
    affiliation = null;
  }
  tactics.push({
    name: cleanName(el.attrs.name),
    affiliation,
    type: (c.Type || '').trim() || null,          // Active / Reactive
    banned: bannedIn(el),
  });
}
tactics.sort((a, b) => a.name.localeCompare(b.name));

// ---- crisis cards ----

const crises = [];
const CRISIS_TYPE = { extraction: 'extract', secure: 'secure' };
for (const el of walk(doc)) {
  if (el.tag !== 'selectionEntry') continue;
  const profile = descend(el, 'profiles', 'profile')
    .find((p) => p.attrs.typeName.trim() === 'Crisis');
  if (!profile) continue;
  const c = chars(profile);
  const type = CRISIS_TYPE[(c.Type || '').trim().toLowerCase()];
  if (!type) { gaps.push(`crisis "${el.attrs.name}": unknown type "${c.Type}", skipped`); continue; }
  const threats = [...String(c.Threat || '').matchAll(/\d+/g)].map((m) => +m[0]);
  if (!threats.length) gaps.push(`crisis "${el.attrs.name}": no threat value`);
  crises.push({
    name: cleanName(el.attrs.name.replace(/^\(\d+[^)]*\)\s*/, '')), // strip "(15) " prefix
    type,
    threats,
    banned: bannedIn(el),
  });
}
crises.sort((a, b) => a.name.localeCompare(b.name));

// ---------------------------------------------------------------- meta + write

let commitHash = null;
let dataDate = null;
try {
  commitHash = execSync('git log -1 --format=%H', { cwd: repoDir }).toString().trim();
  dataDate = execSync('git log -1 --format=%cs', { cwd: repoDir }).toString().trim();
} catch { gaps.push('could not read git metadata from the BSData checkout'); }

const affiliations = [...new Set(characters.flatMap((c) => c.affiliations))].sort();

const catalog = {
  meta: {
    source: 'https://github.com/BSData/marvel-crisis-protocol',
    commitHash,
    dataDate,
    generated: new Date().toISOString().slice(0, 10),
    warning: `threat values as of ${dataDate || 'unknown date'}; verify against current AMG cards`,
  },
  affiliations,
  characters,
  tactics,
  crises,
};

fs.writeFileSync(OUT, JSON.stringify(catalog, null, 1) + '\n');

// ---------------------------------------------------------------- report

console.log(`wrote ${OUT}`);
console.log(`characters: ${characters.length}  (leaders: ${characters.filter((c) => c.leader).length}, non-unique: ${characters.filter((c) => !c.unique).length})`);
console.log(`team tactics: ${tactics.length}  (affiliation-restricted: ${tactics.filter((t) => t.affiliation).length}, banned: ${tactics.filter((t) => t.banned).length})`);
console.log(`crises: ${crises.length}  (extract: ${crises.filter((c) => c.type === 'extract').length}, secure: ${crises.filter((c) => c.type === 'secure').length}, banned: ${crises.filter((c) => c.banned).length})`);
console.log(`affiliations: ${affiliations.length}: ${affiliations.join(', ')}`);
console.log(`data date: ${dataDate}  commit: ${commitHash}`);
if (gaps.length) {
  console.log(`\ngaps (${gaps.length}):`);
  for (const g of gaps) console.log('  - ' + g);
} else {
  console.log('\nno gaps');
}
