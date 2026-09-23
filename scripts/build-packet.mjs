// Build the printable Chaos Protocol packet.
//
//   node scripts/build-packet.mjs [--out <dir>]
//
// Reads server/data/chaos-protocol.json — the same file the /campaign/ page
// renders — and emits a paper-first HTML packet, then prints it to PDF with
// headless Chrome. Generating from the JSON is the point: edit a table once
// and both the site and the packet change, so the Watcher's printout can
// never quietly disagree with the screen somebody else is reading.
//
// The packet is NOT the website in light mode. Screen and paper want
// different things: the site is dark, scrollable and interactive; the packet
// is ink-on-white, paginated, and organised by who needs to read what —
// everyone, then players, then the Watcher alone, then cut-outs. Roll buttons
// and the Panel One dealer have no meaning on paper and are left out.
//
// Chrome is used headless via --print-to-pdf. If it is not found, the HTML is
// still written and the path reported, so you can print it from any browser.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SRC = path.join(ROOT, 'server', 'data', 'chaos-protocol.json');

const outFlag = process.argv.indexOf('--out');
const OUT_DIR = outFlag > -1 ? process.argv[outFlag + 1] : path.join(ROOT, 'build');

const book = JSON.parse(fs.readFileSync(SRC, 'utf-8'));

// Chapters, grouped by who needs the page in front of them.
const PARTS = [
  { title: 'Everyone reads this', sections: ['gambit', 'pitch', 'night', 'icon'] },
  { title: 'Player reference', sections: ['panel', 'chaos', 'advance', 'loot', 'civilians'] },
  { title: "The Watcher's pages", sections: ['whim', 'reckoning'], note: 'Players: stop reading. Everything past here is the Watcher’s, and it is more fun if you find out at the table.' },
];
// Blocks that only make sense with a mouse.
const SCREEN_ONLY = new Set(['hand']);

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const byId = Object.fromEntries(book.sections.map((s) => [s.id, s]));

// ---- block rendering (paper variants of the site's renderers) --------------

function table(b) {
  const cols = (b.nHead ? [b.nHead] : []).concat(b.columns || []);
  const head = `<tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>`;
  const rows = (b.rows || []).map((r) => {
    const cells = [];
    if (b.nHead) cells.push(`<td class="n">${esc(r.n)}</td>`);
    (r.cells || []).forEach((c, i) => cells.push(`<td${i === 0 && b.strongFirst ? ' class="lead"' : ''}>${c}</td>`));
    return `<tr>${cells.join('')}</tr>`;
  }).join('');
  return `<div class="tbl${b.accent ? ' ' + b.accent : ''}">
    ${b.title ? `<div class="tbl-head"><h4>${esc(b.title)}</h4>${b.dice ? `<span class="dice">${esc(b.dice)}</span>` : ''}</div>` : ''}
    <table>${head}${rows}</table>
    ${b.note ? `<p class="note">${b.note}</p>` : ''}
  </div>`;
}

function faces() {
  const p = book.panelOne;
  const rows = p.faceOrder.map((k) => {
    const f = p.faces[k];
    return `<tr><td class="lead">${esc(f.name)}</td><td>${f.minor}</td><td>${f.major}</td></tr>`;
  }).join('');
  return `<div class="tbl">
    <div class="tbl-head"><h4>The Faces</h4><span class="dice">face = what</span></div>
    <table><tr><th>Face</th><th>Minor</th><th>Major</th></tr>${rows}</table>
  </div>`;
}

const scale = () => {
  const c = [];
  for (let i = 5; i >= 1; i--) c.push(`<div class="evil">${i}${i === 5 ? '<small>Evil</small>' : ''}</div>`);
  c.push('<div class="bal">0<small>Balance</small></div>');
  for (let i = 1; i <= 5; i++) c.push(`<div class="good">${i}${i === 5 ? '<small>Good</small>' : ''}</div>`);
  return `<div class="track">${c.join('')}</div>`;
};

const warclock = () => {
  const c = [];
  for (let i = 0; i <= 6; i++) {
    const tag = i === 0 ? '<small>Climb-down</small>' : i === 2 ? '<small>Start</small>' : i === 6 ? '<small>Invasion</small>' : '';
    c.push(`<div class="${i === 0 ? 'cold' : i === 6 ? 'hot' : 'mid'}${i === 2 ? ' start' : ''}">${i}${tag}</div>`);
  }
  return `<div class="track clock">${c.join('')}</div>`;
};

function block(b) {
  if (SCREEN_ONLY.has(b.type)) return '';
  switch (b.type) {
    case 'prose': return `<p>${b.html}</p>`;
    case 'h3': return `<h3>${esc(b.text)}</h3>`;
    case 'list': {
      const t = b.ordered ? 'ol' : 'ul';
      return `<${t}>${b.items.map((i) => `<li>${i}</li>`).join('')}</${t}>`;
    }
    case 'panels':
      return `<div class="panels">${b.items.map((p) => `<div class="pnl"><span class="num">${esc(p.label)}</span><h5>${esc(p.title)}</h5><p>${p.body}</p></div>`).join('')}</div>`;
    case 'caption':
      return `<div class="aside"><span class="who">${esc(b.label)}</span>${b.paras.map((p) => `<p>${p}</p>`).join('')}</div>`;
    case 'columns': return b.blocks.map(block).join('');
    case 'schedule':
      return `<table class="sched">${b.rows.map((r) => `<tr><td class="t">${esc(r.t)}</td><td><b>${esc(r.act)}</b> ${r.body}</td></tr>`).join('')}</table>`;
    case 'acts':
      return `${b.intro ? `<p>${b.intro}</p>` : ''}<div class="parties">${b.items.map((p) => `<div class="party ${esc(p.cls)}"><div class="who">${esc(p.who)}</div><div class="want">${esc(p.want)}</div><p>${p.body}</p></div>`).join('')}</div>`;
    case 'actbriefs':
      return `<div class="briefs">${b.items.map((a) => `<div class="brief">
        <div class="bhead"><span class="bn">${esc(a.n)}</span><h5>${esc(a.title)}</h5><span class="bwhen">${esc(a.when)}</span></div>
        <p class="bsit">${a.situation}</p>
        <table class="bsides">${a.sides.map(([who, want]) => `<tr><td class="bwho">${esc(who)}</td><td>${want}</td></tr>`).join('')}</table>
      </div>`).join('')}</div>`;
    case 'faces': return faces();
    case 'warclock': return warclock();
    case 'scale': return scale();
    case 'table': return table(b);
    case 'sheet': return '';   // the packet prints its own cut-out cards instead
    default: return '';
  }
}

const section = (s) => `<section class="chapter">
  <div class="eyebrow">${esc(s.eyebrow || '')}</div>
  <h2>${esc(s.heading)}</h2>
  ${s.lede ? `<p class="lede">${s.lede}</p>` : ''}
  ${s.blocks.map(block).join('')}
</section>`;

// ---- cut-outs -------------------------------------------------------------

const PLAYERS = 8;

const iconCard = (i) => `<div class="card">
  <div class="card-top"><b>Icon Card</b><span>${esc(book.event)}</span><span class="pl">Player ${i}</span></div>
  <div class="row"><div class="f">Player</div><div class="f">Icon (MCP card)</div><div class="f">Side / Threat</div></div>
  <div class="row"><div class="f">Secret Origin</div><div class="f">Stars owed</div></div>
  <div class="lbl">Advancements</div>
  <div class="row"><div class="f tall">Act I / Underdog</div><div class="f tall">Act II</div><div class="f tall">Act III</div></div>
  <div class="lbl">Items (three max)</div>
  <div class="row"><div class="f">1.</div><div class="f">2.</div><div class="f">3.</div></div>
  <div class="lbl">Injuries that stuck</div>
  <div class="row"><div class="f tall"></div></div>
  <div class="lbl">Civilians: circle the state each Downtime</div>
  <table class="civ">
    <tr><th>#</th><th>Name</th><th>Who / their deal</th><th>State</th></tr>
    <tr><td class="n">1</td><td></td><td></td><td class="st">Safe · Peril · Captive · Changed · Gone</td></tr>
    <tr><td class="n">2</td><td></td><td></td><td class="st">Safe · Peril · Captive · Changed · Gone</td></tr>
  </table>
</div>`;

// The one page a player actually keeps in front of them all night.
function quickRef() {
  const p = book.panelOne;
  const rows = p.faceOrder.map((k) => `<tr><td class="lead">${esc(p.faces[k].name)}</td><td>${p.faces[k].minor}</td><td>${p.faces[k].major}</td></tr>`).join('');
  const hands = byId.panel.blocks.find((b) => b.type === 'columns').blocks.find((b) => b.type === 'table');
  return `<div class="qr">
    <div class="card-top"><b>Panel One</b><span>Roll 5 MCP dice at the start of your activation</span></div>
    <table class="qr-t"><tr><th>Hand</th><th>What it does</th></tr>
      ${hands.rows.map((r) => `<tr><td class="lead">${r.cells[0]}</td><td>${r.cells[1]}</td></tr>`).join('')}
    </table>
    <table class="qr-t"><tr><th>Face</th><th>Minor</th><th>Major</th></tr>${rows}</table>
    <p class="fine"><b>Five Blanks</b> is the Quiet Issue: heal full, +3 Power, Watcher skips the next Whim.
       <b>Five Skulls</b> is the Cursed Issue: Bad Luck twice, then mark a star.</p>
  </div>`;
}

// ---- document -------------------------------------------------------------

const CSS = `
@page { size: letter; margin: 14mm 13mm 16mm; }
* { box-sizing: border-box; }
body { margin: 0; font: 10.2pt/1.45 Georgia, 'Times New Roman', serif; color: #14110f; background: #fff; }
h1, h2, h3, h4, h5, .num, .bn, th, .eyebrow, .who, .dice, .lbl, .card-top, .bwho, .t {
  font-family: 'Arial Narrow', Impact, Haettenschweiler, sans-serif; text-transform: uppercase; letter-spacing: .04em;
}
h1 { font-size: 40pt; line-height: .95; margin: 0; letter-spacing: .01em; }
h2 { font-size: 20pt; margin: 0 0 3pt; border-bottom: 2pt solid #14110f; padding-bottom: 2pt; }
h3 { font-size: 13pt; margin: 14pt 0 5pt; }
h4 { font-size: 11.5pt; margin: 0; }
h5 { font-size: 11pt; margin: 0; }
p { margin: 0 0 7pt; }
ul, ol { margin: 0 0 9pt 16pt; padding: 0; }
li { margin-bottom: 4pt; }
b { font-weight: 700; }
a { color: inherit; text-decoration: none; }
.eyebrow { font-size: 7.6pt; letter-spacing: .13em; color: #6a625a; margin-bottom: 1pt; }
.lede { font-size: 11pt; }

/* cover */
.cover { height: 232mm; display: flex; flex-direction: column; page-break-after: always; }
.cover .rule { border-top: 5pt solid #14110f; margin: 6pt 0 10pt; }
.cover .sys { font-family: 'Arial Narrow', Impact, sans-serif; text-transform: uppercase; letter-spacing: .22em; font-size: 9pt; }
.cover .ev { font-family: 'Arial Narrow', Impact, sans-serif; text-transform: uppercase; font-size: 23pt; margin-top: 10pt; }
.cover .hook { font-size: 12pt; max-width: 118mm; margin-top: 12pt; }
.cover .spacer { flex: 1; }
.cover .facts { display: flex; flex-wrap: wrap; gap: 5pt 14pt; border-top: 1pt solid #14110f; padding-top: 8pt; }
.cover .fact { min-width: 38mm; }
.cover .fact .k { display: block; font-family: 'Arial Narrow', Impact, sans-serif; text-transform: uppercase; font-size: 7.4pt; letter-spacing: .12em; color: #6a625a; }
.cover .credit { font-size: 8pt; color: #6a625a; margin-top: 10pt; }

/* part dividers + chapters */
.part { page-break-before: always; border-top: 5pt solid #14110f; padding-top: 6pt; margin-bottom: 12pt; }
.part .pt { font-family: 'Arial Narrow', Impact, sans-serif; text-transform: uppercase; letter-spacing: .2em; font-size: 8pt; color: #6a625a; }
.part h2 { border: none; font-size: 26pt; }
.part .note { font-size: 10pt; font-style: italic; max-width: 120mm; }
.chapter { page-break-before: always; }
.part + .chapter { page-break-before: avoid; }

/* tables */
.tbl { margin: 8pt 0 12pt; page-break-inside: auto; }
.tbl-head { display: flex; align-items: baseline; gap: 8pt; border-bottom: 1.5pt solid #14110f; padding-bottom: 2pt; margin-bottom: 4pt; }
.dice { font-size: 7.6pt; letter-spacing: .1em; color: #6a625a; margin-left: auto; }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-size: 7.8pt; letter-spacing: .1em; border-bottom: 1pt solid #14110f; padding: 3pt 4pt; }
td { padding: 3.4pt 4pt; border-bottom: .5pt solid #cfc7bd; vertical-align: top; font-size: 9.6pt; }
tr { page-break-inside: avoid; }
td.n { font-family: 'Arial Narrow', Impact, sans-serif; width: 8%; white-space: nowrap; }
td.lead { font-weight: 700; width: 20%; }
.tbl.hero th, .tbl.villain th { border-bottom-width: 2pt; }
.note { font-size: 8.6pt; color: #4a443e; font-style: italic; }
.sched td { font-size: 9.8pt; }
.sched td.t { width: 14mm; }

/* blocks */
.panels { display: flex; flex-wrap: wrap; gap: 7pt; margin-bottom: 9pt; }
.pnl { width: calc(50% - 4pt); border: .75pt solid #14110f; border-top-width: 2.5pt; padding: 6pt 8pt; page-break-inside: avoid; }
.pnl .num { font-size: 7.4pt; color: #6a625a; }
.pnl p { font-size: 9.2pt; margin: 3pt 0 0; }
.aside { border-left: 3pt solid #14110f; background: #f2efe9; padding: 7pt 10pt; margin: 9pt 0; page-break-inside: avoid; }
.aside .who { font-size: 7.6pt; letter-spacing: .13em; color: #6a625a; display: block; margin-bottom: 3pt; }
.aside p { font-size: 9.8pt; margin: 0; }
.aside p + p { margin-top: 5pt; }
.parties { display: flex; gap: 7pt; margin-bottom: 10pt; }
.party { flex: 1; border: .75pt solid #14110f; border-top-width: 3pt; padding: 7pt 9pt; page-break-inside: avoid; }
.party .who { font-size: 11pt; }
.party .want { font-weight: 700; margin: 2pt 0 4pt; }
.party p { font-size: 9pt; margin: 0; }
.briefs { display: block; }
.brief { border-left: 3pt solid #14110f; padding: 6pt 0 6pt 10pt; margin-bottom: 10pt; page-break-inside: avoid; }
.bhead { display: flex; align-items: baseline; gap: 8pt; }
.bn { font-size: 8pt; color: #6a625a; }
.bwhen { font-size: 7.6pt; color: #6a625a; margin-left: auto; }
.bsit { font-size: 9.8pt; margin: 4pt 0 5pt; }
.bsides td { border: none; padding: 2pt 4pt 2pt 0; font-size: 9.4pt; }
.bwho { width: 20mm; font-size: 8pt; vertical-align: top; }
.track { display: flex; border: 1pt solid #14110f; margin: 6pt 0 10pt; text-align: center; }
.track div { flex: 1; padding: 5pt 1pt; font-family: 'Arial Narrow', Impact, sans-serif; font-size: 12pt; border-left: .5pt solid #14110f; }
.track div:first-child { border-left: none; }
.track small { display: block; font-size: 6.2pt; letter-spacing: .06em; }
.track .evil, .track .hot { background: #ddd3d2; }
.track .good, .track .cold { background: #d4dbe2; }
.track .bal, .track .start { background: #efe4c4; }
.track .mid { background: #f4f1ea; }

/* cut-outs */
.cuts { page-break-before: always; }
.card, .qr {
  border: 1.2pt dashed #6a625a; padding: 8pt 10pt; margin-bottom: 8pt;
  height: 108mm; page-break-inside: avoid;
}
.qr { height: auto; min-height: 108mm; }
.card-top { display: flex; align-items: baseline; gap: 8pt; border-bottom: 1.5pt solid #14110f; padding-bottom: 3pt; margin-bottom: 6pt; font-size: 10pt; }
.card-top span { font-size: 7.6pt; letter-spacing: .1em; color: #6a625a; }
.card-top .pl { margin-left: auto; }
.row { display: flex; gap: 10pt; margin-bottom: 4pt; }
.f { flex: 1; border-bottom: .6pt dotted #6a625a; font-size: 7pt; color: #6a625a; padding-top: 11pt; }
.f.tall { padding-top: 20pt; }
.lbl { font-size: 7.4pt; letter-spacing: .12em; color: #6a625a; margin: 7pt 0 2pt; }
.civ td, .civ th { font-size: 8pt; padding: 2.5pt 3pt; }
.civ td { height: 15pt; }
.civ .st { font-size: 7.2pt; color: #6a625a; white-space: nowrap; }
.qr-t { margin-bottom: 5pt; }
.qr-t td, .qr-t th { font-size: 8.4pt; padding: 2.4pt 3pt; }
.qr .fine { font-size: 8pt; margin: 0; }
.cutnote { font-size: 8pt; color: #6a625a; font-style: italic; margin-bottom: 8pt; }
`;

const cover = `<div class="cover">
  <div class="sys">${esc(book.system)} &middot; Raising Havok Gaming Club</div>
  <div class="rule"></div>
  <h1>${esc(book.title)}</h1>
  <div class="ev">${esc(book.event)}</div>
  <p class="hook">Genosha has a new government. It is mutant, it is armed, and it did not ask.
     One character each, three acts, a Watcher who plays nobody, and a stack of tables that decide
     who gets gamma-irradiated and whose aunt gets kidnapped. The dice decide how history records it.</p>
  <div class="spacer"></div>
  <div class="facts">
    ${book.meta.map((f) => `<div class="fact"><span class="k">${esc(f.k)}</span>${esc(f.v)}</div>`).join('')}
    <div class="fact"><span class="k">Watcher</span>________________________</div>
    <div class="fact"><span class="k">Date</span>________________________</div>
  </div>
  <p class="credit">${esc(book.credit)}</p>
</div>`;

const parts = PARTS.map((p) => `
  <div class="part">
    <div class="pt">Part ${PARTS.indexOf(p) + 1}</div>
    <h2>${esc(p.title)}</h2>
    ${p.note ? `<p class="note">${p.note}</p>` : ''}
  </div>
  ${p.sections.map((id) => section(byId[id])).join('')}`).join('');

const cuts = `<div class="part">
    <div class="pt">Part 4</div>
    <h2>Cut these out</h2>
    <p class="note">One Icon card per player, kept all campaign. The Panel One card is the only thing a player needs in front of them during a round.</p>
  </div>
  <div class="cuts"><p class="cutnote">Panel One reference: print one per player.</p>${quickRef()}</div>
  ${// two cards to a page, so eight players is four sheets
    Array.from({ length: Math.ceil(PLAYERS / 2) }, (_, page) => {
      const first = page * 2 + 1;
      const cards = [first, first + 1].filter((n) => n <= PLAYERS).map(iconCard).join('');
      return `<div class="cuts">${cards}</div>`;
    }).join('')}`;

const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(book.title)}: ${esc(book.event)}</title>
<style>${CSS}</style></head>
<body>${cover}${parts}${cuts}</body></html>`;

fs.mkdirSync(OUT_DIR, { recursive: true });
const htmlPath = path.join(OUT_DIR, 'chaos-protocol-packet.html');
const pdfPath = path.join(OUT_DIR, 'chaos-protocol-packet.pdf');
fs.writeFileSync(htmlPath, html, 'utf-8');
console.log('html  ->', htmlPath);

const CHROMES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
];
const chrome = CHROMES.find((c) => fs.existsSync(c));
if (!chrome) {
  console.log('pdf   -> skipped, no Chrome found. Open the HTML and print to PDF.');
  process.exit(0);
}
execFileSync(chrome, [
  '--headless', '--disable-gpu', '--no-pdf-header-footer',
  `--print-to-pdf=${pdfPath}`, 'file:///' + htmlPath.replace(/\\/g, '/'),
], { stdio: 'ignore' });
console.log('pdf   ->', pdfPath);
