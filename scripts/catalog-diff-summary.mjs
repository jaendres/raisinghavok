// Summarise what moved in a rebuilt catalog, for the weekly check's pull
// request body.
//
// The useful question when volunteer data changes is not "which bytes
// differ" -- it is "did a gang just lose half its weapons". So this reports
// the count of every collection in the catalog, before and after, and says
// nothing about the rest. A sharp drop is the signal worth looking at.
//
// Usage: node scripts/catalog-diff-summary.mjs > summary.md
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const FILES = [
  ['Marvel Crisis Protocol', 'server/data/mcp-catalog.json'],
  ['Necromunda', 'server/data/necromunda-catalog.json'],
];

// Every array or object in the catalog, by size. Scalars (names, dates) are
// not interesting here and would drown the real signal.
function sizes(obj, prefix = '', out = {}, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 2) return out;
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'meta') continue; // rebuild stamps live here
    const label = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(value)) {
      out[label] = value.length;
    } else if (value && typeof value === 'object') {
      out[label] = Object.keys(value).length;
      sizes(value, label, out, depth + 1);
    }
  }
  return out;
}

const sections = [];

for (const [label, file] of FILES) {
  let before;
  try {
    before = JSON.parse(execSync(`git show HEAD:${file}`, { maxBuffer: 1 << 28, encoding: 'utf8' }));
  } catch {
    sections.push(`**${label}** — new file, nothing to compare against.`);
    continue;
  }
  const after = JSON.parse(readFileSync(file, 'utf8'));

  const b = sizes(before);
  const a = sizes(after);
  const moved = [...new Set([...Object.keys(b), ...Object.keys(a)])]
    .filter((k) => (b[k] ?? 0) !== (a[k] ?? 0))
    .sort((x, y) => Math.abs((a[y] ?? 0) - (b[y] ?? 0)) - Math.abs((a[x] ?? 0) - (b[x] ?? 0)))
    .slice(0, 20)
    .map((k) => {
      const from = b[k] ?? 0;
      const to = a[k] ?? 0;
      const delta = to - from;
      const flag = delta < 0 && Math.abs(delta) >= Math.max(3, from * 0.2) ? '  **← big drop**' : '';
      return `- \`${k}\`: ${from} → ${to} (${delta > 0 ? '+' : ''}${delta})${flag}`;
    });

  sections.push(
    `**${label}**\n` +
      (moved.length ? moved.join('\n') : '- contents changed, every total the same'),
  );
}

process.stdout.write(sections.join('\n\n') + '\n');
