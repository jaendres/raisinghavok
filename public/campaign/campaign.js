// Chaos Protocol — the club's own Marvel: Crisis Protocol campaign layer.
//
// Every other reader on the site renders somebody else's data. This one
// renders ours: server/data/chaos-protocol.json, served member-gated from
// GET /api/campaign/chaos-protocol. Same account and login wall as My Lists
// (mol_token), plain vanilla JS, no build step.
//
// Two things here are more than a render. Every rollable table gets a button
// that rolls its dice and highlights the row it landed on, so the Watcher can
// run a table off a laptop without reaching for a d20. And Panel One gets a
// dealer: five MCP dice, read as a poker hand, shape for magnitude and face
// for effect. The face spread it rolls against is panelOne.dieFaces in the
// JSON, not a constant in here, because it is the one number in this document
// nobody has verified against a real die.
//
// Rule text in the JSON is trusted HTML — we wrote it, it ships in the repo,
// and it carries <b>/<em>/<a> by design. Anything derived from it that could
// contain characters is escaped through esc() on the way out.

// Discord SSO hands the session token back in the URL fragment.
(() => {
  const m = location.hash.match(/^#sso=([a-f0-9]+)$/);
  if (m) {
    localStorage.setItem('mol_token', m[1]);
    history.replaceState(null, '', location.pathname);
  }
})();

const $app = document.getElementById('app');
const token = localStorage.getItem('mol_token');
let me = null;
let discordSso = false;
let book = null;

function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

async function api(path) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch('/api' + path, { headers });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) throw new Error((data && data.error) || "Site's restartin' — give it a few seconds an' try again.");
  return data ?? {};
}

function loginWall() {
  const href = discordSso ? '/api/auth/discord?return=/campaign/' : '/play/';
  $app.innerHTML = `
    <h1>Chaos Protocol</h1>
    <div class="sub">Members only</div>
    <div class="card" style="text-align:center;padding:40px">
      <p style="margin-bottom:20px;color:var(--dust)">Da club's campaign rules are for club members.<br>
      Log in wiv yer Discord.</p>
      <a class="btn" href="${href}">Log in${discordSso ? ' with Discord' : ''}</a>
    </div>`;
}

// ---- dice ------------------------------------------------------------------

// "d20" / "2d6" -> { total, parts }
function rollSpec(spec) {
  const m = /^(\d*)d(\d+)$/.exec(spec);
  if (!m) return null;
  const count = parseInt(m[1] || '1', 10);
  const sides = parseInt(m[2], 10);
  const parts = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    const r = 1 + Math.floor(Math.random() * sides);
    parts.push(r);
    total += r;
  }
  return { total, parts };
}

// A row's "n" is either "7" or a range like "2-3".
function rowMatches(n, value) {
  if (n == null) return false;
  const range = String(n).split('-');
  if (range.length === 2) return value >= +range[0] && value <= +range[1];
  return +n === value;
}

// ---- block renderers -------------------------------------------------------

function renderTable(b, key) {
  const cls = ['tbl', b.accent || '', b.narrow ? 'narrow' : ''].filter(Boolean).join(' ');
  const head = (b.title || b.roll)
    ? `<div class="tbl-head">
         ${b.title ? `<h3>${esc(b.title)}</h3>` : ''}
         ${b.dice ? `<span class="dice">${esc(b.dice)}</span>` : ''}
         ${b.roll ? `<button class="roll" type="button" data-roll="${esc(b.roll)}" data-for="${key}">Roll ${esc(b.roll)}</button>
                     <span class="result" id="res-${key}" aria-live="polite"></span>` : ''}
       </div>`
    : '';

  const cols = (b.nHead ? [b.nHead] : []).concat(b.columns || []);
  const thead = `<tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>`;

  const body = (b.rows || []).map((r) => {
    const cells = [];
    if (b.nHead) cells.push(`<td class="n">${esc(r.n)}</td>`);
    (r.cells || []).forEach((c, i) => {
      const first = (i === 0 && b.strongFirst) ? ' class="first"' : '';
      cells.push(`<td${first}>${c}</td>`);
    });
    // data-n drives the roll highlight; rows without one are never matched.
    return `<tr${r.n != null ? ` data-n="${esc(r.n)}"` : ''}>${cells.join('')}</tr>`;
  }).join('');

  return `<div class="${cls}" id="tbl-${key}">
    ${head}
    <div class="scroll"><table>${thead}${body}</table></div>
    ${b.note ? `<p class="note">${b.note}</p>` : ''}
  </div>`;
}

// Panel One's face table is built from the same object the dealer rolls
// against, so the two can never drift apart.
function renderFaces(b) {
  const p = book.panelOne;
  const rows = p.faceOrder.map((k) => {
    const f = p.faces[k];
    return `<tr><td class="first f-${esc(k)}">${esc(f.name)}</td><td>${f.minor}</td><td>${f.major}</td></tr>`;
  }).join('');
  return `<div class="tbl">
    <div class="tbl-head">
      <h3>${esc(b.title)}</h3><span class="dice">${esc(b.dice)}</span>
    </div>
    <div class="scroll"><table>
      <tr><th>Face</th><th>Minor</th><th>Major</th></tr>${rows}
    </table></div>
  </div>`;
}

function renderDealer() {
  return `<div class="dealer" id="dealer">
    <div class="bar">
      <span class="lbl">Deal a hand</span>
      <button class="roll" type="button" id="deal">Roll 5 dice</button>
      <span class="hint">Simulated spread, see the note below</span>
    </div>
    <div class="dice-row" id="dice"></div>
    <div class="verdict" id="verdict" aria-live="polite">
      <span class="hand">Ready</span>
      <p class="demo">Hit the button to deal five dice and read the hand.</p>
    </div>
  </div>
  <p class="printnote">The dealer rolls against a face spread of
    ${esc(book.panelOne.dieFaces.join(', '))}. If a real MCP die differs, fix
    <b>panelOne.dieFaces</b> in the campaign JSON and nothing else changes.</p>`;
}

function renderScale() {
  const cells = [];
  for (let i = 5; i >= 1; i--) cells.push(`<div class="evil">${i}${i === 5 ? '<small>Evil</small>' : ''}</div>`);
  cells.push('<div class="bal">0<small>Balance</small></div>');
  for (let i = 1; i <= 5; i++) cells.push(`<div class="good">${i}${i === 5 ? '<small>Good</small>' : ''}</div>`);
  return `<div class="scale" aria-label="Cosmic Scale, five steps each way from Balance">${cells.join('')}</div>`;
}

function renderSheet() {
  const fld = (label, tall) => `<div class="fld${tall ? ' tall' : ''}">${esc(label)}</div>`;
  return `<div class="iconcard">
    <div class="grp">Who</div>
    <div class="fields">${fld('Player')}${fld('Icon (MCP card)')}${fld('Side and threat')}</div>
    <div class="grp">Secret</div>
    <div class="fields">${fld('Secret Origin (show the Watcher)')}${fld('Stars owed (free Advancement rolls)')}</div>
    <div class="grp">Advancements</div>
    <div class="fields">${fld('Act I / Underdog', true)}${fld('Act II', true)}${fld('Act III', true)}</div>
    <div class="grp">Items (three max)</div>
    <div class="fields">${fld('1.')}${fld('2.')}${fld('3.')}</div>
    <div class="grp">Injuries and conditions that stuck</div>
    <div class="fields">${fld('', true)}</div>
    <div class="grp">Civilians</div>
    <div class="scroll"><table>
      <tr><th>#</th><th>Name</th><th>Who</th><th>Their deal</th><th>State: Safe / Peril / Captive / Changed / Gone</th></tr>
      <tr><td class="n">1</td><td></td><td></td><td></td><td></td></tr>
      <tr><td class="n">2</td><td></td><td></td><td></td><td></td></tr>
    </table></div>
  </div>
  <p class="printnote">Print this page for a clean copy: the nav, the rail and every button drop out, and each chapter starts on its own sheet.</p>`;
}

let keySeq = 0;

function renderBlock(b) {
  switch (b.type) {
    case 'prose':
      return `<p class="${b.lede ? 'lede' : 'prose'}">${b.html}</p>`;
    case 'h3':
      return `<h3>${esc(b.text)}</h3>`;
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      return `<${tag}>${b.items.map((i) => `<li>${i}</li>`).join('')}</${tag}>`;
    }
    case 'panels':
      return `<div class="panels">${b.items.map((p) => `
        <div class="pnl">
          <span class="num">${esc(p.label)}</span>
          <h4>${esc(p.title)}</h4>
          <p>${p.body}</p>
        </div>`).join('')}</div>`;
    case 'caption':
      return `<div class="aside">
        <span class="who">${esc(b.label)}</span>
        ${b.paras.map((p) => `<p>${p}</p>`).join('')}
      </div>`;
    case 'columns':
      return `<div class="pair">${b.blocks.map(renderBlock).join('')}</div>`;
    case 'schedule':
      return `<div class="sched">${b.rows.map((r) => `
        <div class="row">
          <span class="t">${esc(r.t)}</span>
          <span class="what"><b>${esc(r.act)}</b> ${r.body}</span>
        </div>`).join('')}</div>`;
    case 'table':
      return renderTable(b, String(++keySeq));
    case 'faces':
      return renderFaces(b);
    case 'hand':
      return renderDealer();
    case 'scale':
      return renderScale();
    case 'sheet':
      return renderSheet();
    default:
      return '';
  }
}

// ---- page ------------------------------------------------------------------

function view() {
  const rail = book.sections.map((s) => `<a href="#${esc(s.id)}">${esc(s.nav)}</a>`).join('');
  const facts = book.meta.map((f) => `<div class="fact"><span class="k">${esc(f.k)}</span><span class="v">${esc(f.v)}</span></div>`).join('');

  const sections = book.sections.map((s) => `
    <section class="sec" id="${esc(s.id)}">
      ${s.eyebrow ? `<div class="eyebrow">${esc(s.eyebrow)}</div>` : ''}
      <h2>${esc(s.heading)}</h2>
      ${s.lede ? `<p class="lede">${s.lede}</p>` : ''}
      ${s.blocks.map(renderBlock).join('')}
    </section>`).join('');

  $app.innerHTML = `
    <div class="head">
      <h1>${esc(book.title)}</h1>
      <div class="sub">${esc(book.system)}</div>
      <p class="tagline">${esc(book.tagline)}</p>
      <div class="facts">${facts}</div>
    </div>
    <div class="rail">${rail}</div>
    ${sections}
    <p class="stamp printnote">${esc(book.credit)}</p>`;
}

// ---- interaction -----------------------------------------------------------

// One delegated handler for every table's Roll button.
$app.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button.roll');
  if (!btn || btn.id === 'deal') return;
  const res = rollSpec(btn.dataset.roll);
  if (!res) return;

  const wrap = document.getElementById('tbl-' + btn.dataset.for);
  const out = document.getElementById('res-' + btn.dataset.for);
  let landed = '';
  wrap.querySelectorAll('tr[data-n]').forEach((tr) => {
    tr.classList.remove('hit');
    if (rowMatches(tr.dataset.n, res.total)) {
      tr.classList.add('hit');
      const cell = tr.querySelector('td:nth-child(2)');
      landed = cell ? cell.textContent.trim().replace(/\.$/, '') : '';
    }
  });
  if (landed.length > 46) landed = landed.slice(0, 46) + '...';
  const parts = res.parts.length > 1 ? ` (${res.parts.join(' + ')})` : '';
  out.innerHTML = `<b>${res.total}</b>${esc(parts)}${landed ? ': ' + esc(landed) : ''}`;
});

// Panel One: five dice, read as a poker hand.
function readHand(counts) {
  const p = book.panelOne;
  const shape = Object.keys(counts).map((f) => ({ f, c: counts[f] })).sort((a, b) => b.c - a.c);
  const top = shape[0];
  const name = (f) => esc(p.faces[f].name);
  const minor = (f) => `<b>${name(f)}, Minor:</b> ${p.faces[f].minor}`;
  const major = (f) => `<b>${name(f)}, Major:</b> ${p.faces[f].major}`;

  if (top.c === 5) {
    const special = p.special[top.f];
    if (special) return { title: special.title, lines: special.lines };
    return { title: 'Cover Story', lines: [
      `<b>${name(top.f)}, Major, doubled:</b> ${p.faces[top.f].major}`,
      'Gain 3 Power, and the Cosmic Scale moves one step toward your side. Somebody photograph this.',
    ] };
  }
  if (top.c === 4) return { title: 'Four of a kind', lines: [major(top.f), 'Double every number it names.'] };
  if (top.c === 3 && shape[1].c === 2) return { title: 'Full house', lines: [major(top.f), minor(shape[1].f)] };
  if (top.c === 3) return { title: 'Three of a kind', lines: [major(top.f)] };
  if (top.c === 2 && shape[1].c === 2) return { title: 'Two pair', lines: [minor(top.f), minor(shape[1].f)] };
  if (top.c === 2) return { title: 'One pair', lines: [minor(top.f)] };
  return { title: 'Full spread', lines: [
    'All five dice showing different faces. Roll on the Watcher’s Whim immediately, and where the result is ambiguous, <em>you</em> choose who it hits.',
  ] };
}

$app.addEventListener('click', (ev) => {
  if (!ev.target.closest('#deal')) return;
  const p = book.panelOne;
  const faces = [];
  const counts = {};
  for (let i = 0; i < 5; i++) {
    const f = p.dieFaces[Math.floor(Math.random() * p.dieFaces.length)];
    faces.push(f);
    counts[f] = (counts[f] || 0) + 1;
  }
  // Group matching dice together, then by the face order the tables use.
  const rank = {};
  p.faceOrder.forEach((f, i) => { rank[f] = p.faceOrder.length - i; });
  faces.sort((a, b) => (counts[b] - counts[a]) || (rank[b] - rank[a]));

  document.getElementById('dice').innerHTML = faces
    .map((f) => `<span class="die f-${esc(f)}">${esc(p.faces[f].name)}</span>`).join('');

  const r = readHand(counts);
  document.getElementById('verdict').innerHTML =
    `<span class="hand">${esc(r.title)}</span>` + r.lines.map((l) => `<p>${l}</p>`).join('');
});

(async () => {
  try { discordSso = (await api('/config')).discordEnabled; } catch { /* fine */ }
  if (token) {
    try {
      me = (await api('/me')).name;
      document.getElementById('whoami').textContent = me;
    } catch { me = null; }
  }
  if (!me) return loginWall();
  try {
    book = await api('/campaign/chaos-protocol');
    view();
  } catch (e) {
    $app.innerHTML = `<h1>Chaos Protocol</h1><p class="error">${esc(e.message)}</p>`;
  }
})();
