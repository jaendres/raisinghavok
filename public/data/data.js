// Data — where every game's reference data came from, and how old it is.
//
// The site copies other people's work. Some of those copies are pulled
// nightly, one is final because the source no longer exists, one is over a
// year out of date, and two were compiled by hand with gaps their compiler
// wrote down. All of that was already recorded in the data; none of it was
// visible to whoever was reading a card at the table.
//
// This page is one card per source, rendered straight from
// GET /api/data-freshness. Same account and login wall as My Lists
// (mol_token), plain vanilla JS, no build step.

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
  const href = discordSso ? '/api/auth/discord?return=/data/' : '/play/';
  $app.innerHTML = `
    <h1>Data</h1>
    <div class="sub">Members only</div>
    <div class="card" style="text-align:center;padding:40px">
      <p class="muted" style="margin-bottom:20px">Where da club's game data comes from is for club members.<br>
      Log in wiv yer Discord.</p>
      <a class="btn" href="${href}">Log in${discordSso ? ' with Discord' : ''}</a>
    </div>`;
}

// ---- formatting ------------------------------------------------------------

const STATUS_WORD = {
  fresh: 'Fresh',
  aging: 'Aging',
  stale: 'Out of date',
  final: 'Final',
  unknown: 'Unrecorded',
};

const DAY = 24 * 60 * 60 * 1000;

// Dates render as the date plus how long ago, because "2024-12-26" and
// "20 months ago" land very differently and the second one is the point.
function ago(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const days = Math.floor((Date.now() - d.getTime()) / DAY);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 60) return `${days} days ago`;
  const months = Math.round(days / 30.44);
  if (months < 24) return `${months} months ago`;
  return `${Math.floor(days / 365.25)}+ years ago`;
}

// Rendered in UTC on purpose. Catalog dates are bare calendar days
// ("2024-12-26"), which parse as UTC midnight — formatted in a western
// timezone that becomes the 25th, and a page about being straight with
// people should not quietly move a date a day.
function dateText(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return esc(iso);
  const day = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return `${esc(day)} <span class="ago">(${esc(ago(iso))})</span>`;
}

function fact(key, valueHtml) {
  return `<div class="fact"><div class="k">${esc(key)}</div><div class="v">${valueHtml}</div></div>`;
}

function factNone(key, why) {
  return `<div class="fact"><div class="k">${esc(key)}</div><div class="v none">${esc(why)}</div></div>`;
}

// Long lists (Trench Crusade's gaps, Necromunda's caveats) are the reason
// this page exists, so they are never truncated away — just folded past the
// first few, with a real 34px button to open the rest.
let noteSeq = 0;
function noteList(title, items, cls, showFirst = 3) {
  if (!items || !items.length) return '';
  const id = 'nl' + (++noteSeq);
  const lis = items.map((t, i) =>
    `<li${i >= showFirst ? ' class="hidden"' : ''}>${esc(t)}</li>`).join('');
  const more = items.length > showFirst
    ? `<button class="more" data-more="${id}">Show all ${items.length}</button>`
    : '';
  return `<div class="notes ${cls}" id="${id}"><h3>${esc(title)}</h3><ul>${lis}</ul>${more}</div>`;
}

function counts(obj) {
  const entries = Object.entries(obj || {});
  if (!entries.length) return '';
  return `<div class="counts">${entries.map(([k, n]) =>
    `<div class="count"><b>${esc(Number(n).toLocaleString('en-GB'))}</b><span>${esc(k)}</span></div>`).join('')}</div>`;
}

function sourceCard(s) {
  const status = STATUS_WORD[s.status] ? s.status : 'unknown';

  const link = s.sourceUrl
    ? `${esc(s.source || s.sourceUrl)} — <a href="${esc(s.sourceUrl)}" target="_blank" rel="noopener noreferrer">${esc(s.sourceUrl)}</a>`
    : esc(s.source || 'not recorded');

  const refreshed = s.lastRefreshed
    ? fact(s.kind === 'database' ? 'Imported' : 'Compiled', dateText(s.lastRefreshed))
    : factNone(s.kind === 'database' ? 'Imported' : 'Compiled', 'not recorded');

  const upstream = s.upstreamDate
    ? fact('Upstream', /^\d{4}-\d{2}-\d{2}/.test(String(s.upstreamDate))
      ? dateText(s.upstreamDate)
      : esc(s.upstreamDate))
    : '';

  return `
    <section class="src is-${esc(status)}">
      <div class="src-head">
        <h2>${esc(s.game)}</h2>
        <span class="src-kind">${esc(s.kind === 'database' ? 'database' : 'catalog file')}</span>
        <span class="chip ${esc(status)}">${esc(STATUS_WORD[status])}</span>
      </div>
      ${s.label ? `<div class="src-label">${esc(s.label)}</div>` : ''}
      ${s.statusReason ? `<div class="src-why">${esc(s.statusReason)}</div>` : ''}
      <div class="src-facts">
        ${refreshed}
        ${upstream}
        ${fact('Source', link)}
      </div>
      ${counts(s.counts)}
      ${noteList('Warnings', s.warnings, 'warn', 4)}
      ${noteList('Known gaps', s.gaps, 'gap', 3)}
      ${noteList('Caveats & provenance', s.caveats, 'caveat', 3)}
      ${s.note ? `<div class="src-foot">${esc(s.note)}</div>` : ''}
    </section>`;
}

// ---- view ------------------------------------------------------------------

async function view() {
  $app.innerHTML = '<h1>Data</h1><p class="muted">Reading da books...</p>';
  const data = await api('/data-freshness');
  const sources = data.sources || [];

  const legend = ['fresh', 'aging', 'stale', 'final', 'unknown']
    .map((k) => `<span class="chip ${k}">${STATUS_WORD[k]}</span>`).join('');

  const dbWarn = data.databaseConfigured === false
    ? `<p class="error" style="margin-top:10px">The unit database is not configured on this server, so the 40k and BattleTech
       entries below can only report what they are, not how big or how old they are.</p>`
    : '';

  $app.innerHTML = `
    <h1>Data</h1>
    <div class="sub">Where it came from &amp; how old it is</div>

    <div class="intro">
      Almost nothing on this site is our own data. The army lists, statlines and points values are
      copied from Wahapedia, from an archive of the Master Unit List, from community BattleScribe
      catalogues, and from two catalogs somebody here compiled by hand out of PDFs.
      <b>Some of those copies are pulled fresh every night. One is over a year old. One can never be
      updated again because the site it came from was shut down.</b>
      This page says which is which, so you can tell whether the number on a card is worth arguing
      about before you argue about it.
      <div class="legend">${legend}<span class="txt">— per source, below</span></div>
      ${dbWarn}
    </div>

    <div class="src-grid">${sources.map(sourceCard).join('')}</div>

    <div class="stamp">Report assembled ${esc(new Date(data.generatedAt || Date.now()).toLocaleString('en-GB'))}. Cached for a minute.</div>`;
}

// "Show all N" on the long note lists.
$app.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button.more');
  if (!btn) return;
  const box = document.getElementById(btn.dataset.more);
  if (!box) return;
  box.querySelectorAll('li.hidden').forEach((li) => li.classList.remove('hidden'));
  btn.remove();
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
    await view();
  } catch (e) {
    $app.innerHTML = `<h1>Data</h1><p class="error">${esc(e.message)}</p>`;
  }
})();
