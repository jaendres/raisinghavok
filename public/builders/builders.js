// Builders SPA — hash-routed, same account and token as the rest of the site.
//
// #/            list of builders
// #/battletech  Alpha Strike force builder

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

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch('/api' + path, { headers, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'server said no');
  return data;
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.append(el);
  setTimeout(() => el.remove(), 2400);
}

function loginWall() {
  const href = discordSso ? '/api/auth/discord?return=/builders/' : '/play/';
  $app.innerHTML = `
    <h1>Builders</h1>
    <div class="sub">Members only</div>
    <div class="card" style="text-align:center;padding:40px">
      <p class="muted" style="margin-bottom:20px">Da list builders are for club members.<br>
      Log in wiv yer Discord to get in.</p>
      <a class="btn" href="${href}">Log in with Discord</a>
    </div>`;
}

// ---------------------------------------------------------------- Alpha Strike

// Skill/PV maths comes from /builders/alphastrike.js, which the server also
// requires — one implementation of the rule, shared by both sides.
const { pvForSkill, tmmForMove, bvForCrew, SKILLS } = window.AlphaStrike;

// 'as' = Alpha Strike (point values, one skill), 'tw' = Total Warfare (battle
// values, separate gunnery and piloting). The Master Unit List kept these as two
// separate builders; here they are one screen with a mode switch, because the
// unit list and filters are identical either way.
const MODES = {
  as: { label: 'Alpha Strike', cost: 'PV', min: 'minPV', max: 'maxPV' },
  tw: { label: 'Total Warfare', cost: 'BV', min: 'minBV', max: 'maxBV' },
};

const bt = {
  mode: localStorage.getItem('bt_mode') === 'tw' ? 'tw' : 'as',
  meta: null,
  force: [],          // { uid, id, name, pv (base), skill, type, tonnage }
  statsById: new Map(), // full stats for anything seen, for the print sheet
  offset: 0,
  total: 0,
  uid: 1,
};

// Adjusted cost of one entry in the current mode.
const entryCost = (e) => (bt.mode === 'tw'
  ? bvForCrew(e.bv, e.gunnery ?? 4, e.piloting ?? 5)
  : pvForSkill(e.pv, e.skill ?? 4));

const forceTotal = () => bt.force.reduce((n, e) => n + (entryCost(e) || 0), 0);
const forceTonnage = () => bt.force.reduce((n, e) => n + (Number(e.tonnage) || 0), 0);

// Base cost before any crew adjustment — Total Warfare players quote both.
const forceBaseTotal = () => bt.force.reduce(
  (n, e) => n + (Number(bt.mode === 'tw' ? e.bv : e.pv) || 0), 0);

const dmg = (u) => [u.damage?.s, u.damage?.m, u.damage?.l]
  .map((d) => (d === null || d === undefined ? '-' : d)).join('/');

async function viewBattleTech() {
  if (!bt.meta) {
    try {
      bt.meta = await api('/builders/battletech/meta');
    } catch (err) {
      $app.innerHTML = `
        <div class="crumb"><a href="#/">&larr; Builders</a></div>
        <h1>Alpha Strike</h1>
        <div class="warn">Da unit database ain't answerin': ${esc(err.message)}</div>`;
      return;
    }
  }

  const m = bt.meta;
  const opts = (list, valuer = (v) => v, labeller = (v) => v) =>
    list.map((v) => `<option value="${esc(valuer(v))}">${esc(labeller(v))}</option>`).join('');

  $app.innerHTML = `
    <div class="crumb"><a href="#/">&larr; Builders</a></div>
    <h1>BattleTech</h1>
    <div class="sub">${m.counts.units.toLocaleString()} units &bull;
      ${m.counts.availabilityPairs.toLocaleString()} faction/era entries</div>
    <div class="modeswitch">
      <button class="btn small ${bt.mode === 'as' ? '' : 'ghost'}" data-mode="as">Alpha Strike</button>
      <button class="btn small ${bt.mode === 'tw' ? '' : 'ghost'}" data-mode="tw">Total Warfare</button>
    </div>

    <div class="bt-layout">
      <div class="bt-pane bt-filters">
        <h2>Filters</h2>
        <label>Search<input type="search" id="f-q" placeholder="Atlas, Timber Wolf…" autocomplete="off"></label>
        <label>Faction<select id="f-faction"><option value="">Any faction</option>
          ${opts(m.factions, (f) => f.id, (f) => f.name)}</select></label>
        <label>Era<select id="f-era"><option value="">Any era</option>
          ${opts(m.eras, (e) => e.id, (e) => e.name)}</select></label>
        <label>Type<select id="f-type"><option value="">Any type</option>${opts(m.types)}</select></label>
        <label>Role<select id="f-role"><option value="">Any role</option>${opts(m.roles)}</select></label>
        <div class="row">
          <label>Min ${MODES[bt.mode].cost}<input type="number" id="f-mincost" min="0"></label>
          <label>Max ${MODES[bt.mode].cost}<input type="number" id="f-maxcost" min="0"></label>
        </div>
        <label>Sort<select id="f-sort">
          <option value="name">Name</option>
          <option value="${bt.mode === 'tw' ? 'bv' : 'pv'}">${MODES[bt.mode].cost} (high &rarr; low)</option>
          <option value="${bt.mode === 'tw' ? 'bvasc' : 'pvasc'}">${MODES[bt.mode].cost} (low &rarr; high)</option>
          <option value="tonnage">Tonnage</option>
          <option value="type">Type</option>
        </select></label>
        <button class="btn ghost small" id="f-reset">Reset</button>
      </div>

      <div class="bt-pane">
        <h2>Units <span class="muted" id="bt-count" style="float:right;font-family:'Barlow Condensed'"></span></h2>
        <div class="bt-scroll">
          <table class="bt-table">
            <thead><tr>
              <th class="c-add"></th>
              <th class="c-name">Unit</th>
              <th class="c-pv num">${MODES[bt.mode].cost}</th>
              <th class="c-mv">Mv</th>
              <th class="c-dmg num">S/M/L</th>
              <th class="c-as num">A/S</th>
            </tr></thead>
            <tbody id="bt-results"></tbody>
          </table>
        </div>
        <button class="btn ghost small" id="bt-more" style="margin-top:10px;display:none">Load more</button>
      </div>

      <div class="bt-pane">
        <h2>Force</h2>
        <div class="force-bar">
          <input type="text" id="force-name" placeholder="Force name">
          <button class="btn small" id="force-save">Save</button>
          <button class="btn ghost small" id="force-del" title="Delete saved force">&#10005;</button>
        </div>
        <select id="force-saved" style="width:100%;margin-bottom:10px"><option value="">Saved forces…</option></select>
        <div class="bt-scroll">
          <table class="force-table">
            <thead><tr>
              <th class="f-name">Unit</th>
              ${bt.mode === 'tw'
                ? '<th class="f-skill">G</th><th class="f-skill">P</th>'
                : '<th class="f-skill">Skill</th>'}
              <th class="f-pv num">${MODES[bt.mode].cost}</th><th class="f-rm"></th>
            </tr></thead>
            <tbody id="force-list"></tbody>
          </table>
        </div>
        <p class="muted" id="force-empty">Nuffin' here yet — add units from da list.</p>
        <div class="force-total">
          <span class="muted"><span id="force-count">0</span> units &bull; <span id="force-tons">0</span>t</span>
          <b id="force-pv">0</b>
        </div>
        <div class="muted" id="force-base" style="text-align:right;font-size:13px"></div>
        <div class="force-actions">
          <button class="btn ghost small" id="force-print">Print sheet</button>
          <button class="btn ghost small" id="force-copy">Copy text</button>
          <button class="btn ghost small" id="force-clear">Clear</button>
        </div>
      </div>
    </div>`;

  wireBattleTech();
  await refreshSavedForces();
  renderForce();
  await runSearch();
}

function filterParams() {
  const p = new URLSearchParams();
  const put = (key, id) => {
    const el = document.getElementById(id);
    if (el && el.value.trim()) p.set(key, el.value.trim());
  };
  put('q', 'f-q');
  put('faction', 'f-faction');
  put('era', 'f-era');
  put('type', 'f-type');
  put('role', 'f-role');
  put(MODES[bt.mode].min, 'f-mincost');
  put(MODES[bt.mode].max, 'f-maxcost');
  put('sort', 'f-sort');
  p.set('mode', bt.mode);
  return p;
}

async function runSearch({ append = false } = {}) {
  const p = filterParams();
  if (!append) bt.offset = 0;
  p.set('offset', String(bt.offset));
  p.set('limit', '150');

  let data;
  try {
    data = await api('/builders/battletech/units?' + p);
  } catch (err) {
    toast(err.message);
    return;
  }

  const body = document.getElementById('bt-results');
  if (!append) body.textContent = '';

  const frag = document.createDocumentFragment();
  for (const u of data.units) {
    bt.statsById.set(u.id, u);
    // Type, role and abilities go under the name rather than in their own
    // columns. Abilities strings run long enough to push the table wider than
    // the pane, and the add button is the one thing that must never be the
    // part that gets scrolled off.
    const sub = [u.type, u.role && u.role !== 'None' ? u.role : null, u.tonnage ? `${u.tonnage}t` : null]
      .filter(Boolean).join(' · ');
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="c-add"><button class="addbtn" title="Add to force">+</button></td>
      <td class="c-name">
        <span class="uname">${esc(u.name)}</span>
        <span class="usub">${esc(sub)}</span>
        ${u.abilities ? `<span class="uabil">${esc(u.abilities)}</span>` : ''}
      </td>
      <td class="c-pv num pv">${bt.mode === 'tw' ? (u.bv ?? '—') : u.pv}</td>
      <td class="c-mv">${esc(u.move ?? '')}</td>
      <td class="c-dmg num">${dmg(u)}</td>
      <td class="c-as num">${u.armor ?? '-'}/${u.structure ?? '-'}</td>`;
    tr.querySelector('.uname').addEventListener('click', () => openUnit(u.id));
    tr.querySelector('.addbtn').addEventListener('click', () => addToForce(u));
    frag.append(tr);
  }
  body.append(frag);

  bt.total = data.total;
  bt.offset = body.children.length;
  document.getElementById('bt-count').textContent = `${bt.offset} of ${data.total}`;
  document.getElementById('bt-more').style.display = bt.offset >= data.total ? 'none' : '';
}

// Store both costs and both crew schemes on every entry, so switching mode
// re-prices the same force instead of forcing you to rebuild it.
function addToForce(u) {
  bt.statsById.set(u.id, u);
  bt.force.push({
    uid: bt.uid++, id: u.id, name: u.name,
    pv: u.pv, bv: u.bv,
    skill: 4,            // Alpha Strike: one skill, 4 is regular
    gunnery: 4, piloting: 5, // Total Warfare: 4/5 is the regular crew
    type: u.type, tonnage: u.tonnage, move: u.move,
  });
  renderForce();
}

function renderForce() {
  const body = document.getElementById('force-list');
  if (!body) return;
  body.textContent = '';

  const skillSelect = (value, onChange) => {
    const sel = document.createElement('select');
    sel.className = 'skillsel';
    for (const v of SKILLS) {
      const o = document.createElement('option');
      o.value = String(v);
      o.textContent = String(v);
      if (v === value) o.selected = true;
      sel.append(o);
    }
    sel.addEventListener('change', () => { onChange(Number(sel.value)); renderForce(); });
    return sel;
  };

  for (const entry of bt.force) {
    const tr = document.createElement('tr');

    const name = document.createElement('td');
    name.className = 'f-name';
    name.textContent = entry.name;
    tr.append(name);

    if (bt.mode === 'tw') {
      // Total Warfare prices a unit from gunnery and piloting separately.
      const g = document.createElement('td');
      g.className = 'f-skill';
      g.append(skillSelect(entry.gunnery ?? 4, (v) => { entry.gunnery = v; }));
      const pl = document.createElement('td');
      pl.className = 'f-skill';
      pl.append(skillSelect(entry.piloting ?? 5, (v) => { entry.piloting = v; }));
      tr.append(g, pl);
    } else {
      const sk = document.createElement('td');
      sk.className = 'f-skill';
      sk.append(skillSelect(entry.skill ?? 4, (v) => { entry.skill = v; }));
      tr.append(sk);
    }

    const cost = document.createElement('td');
    cost.className = 'f-pv num pv';
    cost.textContent = String(entryCost(entry) ?? '—');

    const rm = document.createElement('td');
    rm.className = 'f-rm';
    const btn = document.createElement('button');
    btn.className = 'rmbtn';
    btn.textContent = '✕';
    btn.title = 'Remove';
    btn.addEventListener('click', () => {
      bt.force = bt.force.filter((e) => e.uid !== entry.uid);
      renderForce();
    });
    rm.append(btn);

    tr.append(cost, rm);
    body.append(tr);
  }

  const tons = forceTonnage();
  document.getElementById('force-tons').textContent = tons % 1 ? tons.toFixed(1) : String(tons);
  const base = document.getElementById('force-base');
  if (base) {
    base.textContent = bt.force.length
      ? `base ${forceBaseTotal()} ${MODES[bt.mode].cost} before crew adjustment`
      : '';
  }

  document.getElementById('force-pv').textContent = String(forceTotal());
  document.getElementById('force-count').textContent = String(bt.force.length);
  document.getElementById('force-empty').style.display = bt.force.length ? 'none' : '';
}

// After a save, the next thing anyone wants is to play the thing — so say so.
// One persistent line under the force pane, not a toast that vanishes.
function showGameNightHandoff(name) {
  let el = document.getElementById('gamenight-handoff');
  if (!el) {
    const bar = document.getElementById('force-saved');
    if (!bar) return;
    el = document.createElement('div');
    el.id = 'gamenight-handoff';
    el.style.cssText = 'margin:0 0 10px;padding:8px 10px;border:1px solid var(--rust-dk);background:#1d1210;font-size:14px';
    bar.insertAdjacentElement('afterend', el);
  }
  el.innerHTML = `&#9876; <b>${name.replace(/[&<>"']/g, (c) => ('&#' + c.charCodeAt(0) + ';'))}</b> is ready to play &mdash;
    <a href="/table/" style="color:var(--rust)">track damage at Game Night &rarr;</a>`;
}

async function refreshSavedForces() {
  const sel = document.getElementById('force-saved');
  if (!sel) return;
  let saved = [];
  try {
    saved = (await api('/builders/forces')).forces ?? [];
  } catch { /* not fatal — the builder still works unsaved */ }

  sel.textContent = '';
  const first = document.createElement('option');
  first.value = '';
  first.textContent = 'Saved forces…';
  sel.append(first);
  for (const f of saved) {
    const o = document.createElement('option');
    o.value = f.name;
    o.textContent = `${f.name} (${f.units.length} units, ${f.totalPV} PV)`;
    sel.append(o);
  }
}

function wireBattleTech() {
  const debounce = (fn, ms) => {
    let t;
    return () => { clearTimeout(t); t = setTimeout(fn, ms); };
  };
  const rerun = debounce(() => runSearch(), 250);

  for (const id of ['f-q', 'f-mincost', 'f-maxcost']) {
    document.getElementById(id).addEventListener('input', rerun);
  }

  // Switching mode re-renders the whole screen (labels, columns, crew selects)
  // and re-prices the force that is already assembled.
  for (const b of document.querySelectorAll('.modeswitch button')) {
    b.addEventListener('click', () => {
      const next = b.dataset.mode;
      if (next === bt.mode) return;
      bt.mode = next;
      localStorage.setItem('bt_mode', next);
      viewBattleTech();
    });
  }
  for (const id of ['f-faction', 'f-era', 'f-type', 'f-role', 'f-sort']) {
    document.getElementById(id).addEventListener('change', () => runSearch());
  }

  document.getElementById('f-reset').addEventListener('click', () => {
    for (const id of ['f-q', 'f-mincost', 'f-maxcost']) document.getElementById(id).value = '';
    for (const id of ['f-faction', 'f-era', 'f-type', 'f-role']) document.getElementById(id).value = '';
    document.getElementById('f-sort').value = 'name';
    runSearch();
  });

  document.getElementById('bt-more').addEventListener('click', () => runSearch({ append: true }));

  document.getElementById('force-save').addEventListener('click', async () => {
    const name = document.getElementById('force-name').value.trim();
    if (!name) return toast('Give it a name first, git.');
    try {
      await api('/builders/forces', {
        method: 'POST',
        body: JSON.stringify({
          name,
          units: bt.force.map((e) => ({
            id: e.id, skill: e.skill, gunnery: e.gunnery, piloting: e.piloting,
          })),
        }),
      });
      await refreshSavedForces();
      document.getElementById('force-saved').value = name;
      toast(`Saved "${name}"`);
      showGameNightHandoff(name);
    } catch (err) { toast(err.message); }
  });

  document.getElementById('force-saved').addEventListener('change', async (ev) => {
    const name = ev.target.value;
    if (!name) return;
    try {
      const data = await api('/builders/forces/' + encodeURIComponent(name));
      for (const u of data.units) bt.statsById.set(u.id, u);
      bt.force = data.units.map((u) => ({
        uid: bt.uid++, id: u.id, name: u.name,
        pv: u.pv, bv: u.bv,
        skill: u.skill ?? 4,
        gunnery: u.gunnery ?? 4, piloting: u.piloting ?? 5,
        type: u.type, tonnage: u.tonnage, move: u.move,
      }));
      document.getElementById('force-name').value = name;
      renderForce();
    } catch (err) { toast(err.message); }
  });

  document.getElementById('force-del').addEventListener('click', async () => {
    const name = document.getElementById('force-saved').value;
    if (!name) return;
    try {
      await api('/builders/forces/' + encodeURIComponent(name), { method: 'DELETE' });
      await refreshSavedForces();
      toast(`Deleted "${name}"`);
    } catch (err) { toast(err.message); }
  });

  document.getElementById('force-print').addEventListener('click', () => printForce());

  document.getElementById('force-clear').addEventListener('click', () => {
    bt.force = [];
    renderForce();
  });

  document.getElementById('force-copy').addEventListener('click', async () => {
    const name = document.getElementById('force-name').value.trim() || 'Force';
    const lines = bt.force.map((e) => `  ${e.name} — skill ${e.skill} — ${pvForSkill(e.pv, e.skill)} PV`);
    const text = `${name}\n${lines.join('\n')}\n\n${bt.force.length} units, ${forceTotal()} PV`;
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied to clipboard');
    } catch {
      toast('Clipboard blocked — select an’ copy manually');
    }
  });
}

// ------------------------------------------------------------- unit detail

// Images sit behind the same member check as everything else, and an <img>
// tag cannot send an Authorization header. So the bytes are fetched with the
// token and handed to the page as a blob url -- which also keeps the session
// token out of URLs, browser history and referrer headers.
async function imageObjectUrl(path) {
  const res = await fetch(path, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
  if (!res.ok) return null;
  return URL.createObjectURL(await res.blob());
}

const cardPath = (id) => `/api/builders/battletech/units/${id}/card`;

// Full unit sheet in a modal: the rendered Alpha Strike card, the stat line,
// and every faction/era it is legal in. The card is the same image the Master
// Unit List printed, archived before that site closed.
async function openUnit(id) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = '<div class="modal"><p class="muted">Loading…</p></div>';
  back.addEventListener('click', (ev) => { if (ev.target === back) back.remove(); });
  document.body.append(back);

  const onEsc = (ev) => { if (ev.key === 'Escape') { back.remove(); document.removeEventListener('keydown', onEsc); } };
  document.addEventListener('keydown', onEsc);

  let data;
  try {
    data = await api(`/builders/battletech/units/${id}`);
  } catch (err) {
    back.querySelector('.modal').innerHTML = `<div class="warn">${esc(err.message)}</div>`;
    return;
  }

  const u = data.unit;
  const stat = (label, value) => `<div class="st"><span>${label}</span><b>${esc(value ?? '—')}</b></div>`;

  back.querySelector('.modal').innerHTML = `
    <button class="modal-x" title="Close">&#10005;</button>
    <h2>${esc(u.name)}</h2>
    <div class="sub">${esc([u.type, u.role && u.role !== 'None' ? u.role : null, u.tech, u.rules]
      .filter(Boolean).join(' · '))}</div>

    <div class="unit-body">
      <div class="unit-card">
        <div id="card-slot"><p class="muted">Loading card…</p></div>
      </div>

      <div class="unit-facts">
        <div class="stats">
          ${stat('PV', u.pv)}${stat('Size', u.size)}${stat('Tonnage', u.tonnage)}
          ${stat('Move', u.move)}${stat('TMM', tmmForMove(u.move))}${stat('Overheat', u.overheat)}
          ${stat('Armor', u.armor)}${stat('Structure', u.structure)}${stat('Threshold', u.threshold)}
          ${stat('S / M / L / E', `${u.damage.s ?? '-'} / ${u.damage.m ?? '-'} / ${u.damage.l ?? '-'} / ${u.damage.e ?? '-'}`)}
          ${stat('Battle Value', u.bv)}${stat('Introduced', u.introduced)}
        </div>
        ${u.abilities ? `<p class="abilities"><span>Abilities</span> ${esc(u.abilities)}</p>` : ''}
        ${u.tro ? `<p class="muted">Source: ${esc(u.tro)}</p>` : ''}

        <h3>Availability</h3>
        ${data.availability.length ? data.availability.map((e) => `
          <details class="era">
            <summary>${esc(e.era)} <span class="muted">(${e.factions.length})</span></summary>
            <div class="factions">${e.factions.map((f) => esc(f.name)).join(' · ')}</div>
          </details>`).join('')
          : '<p class="muted">No faction availability recorded.</p>'}
      </div>
    </div>

    <div class="modal-actions">
      <button class="btn small" id="modal-add">Add to force</button>
      <button class="btn ghost small" id="modal-close">Close</button>
    </div>`;

  // Load the card, then wire "open in new tab" to the same blob so the full
  // size image opens without a second authenticated request.
  (async () => {
    const slot = back.querySelector('#card-slot');
    if (!slot) return;
    const url = await imageObjectUrl(cardPath(u.id));
    if (!url) {
      slot.innerHTML = '<p class="muted">No card was archived for this unit — the source site could not render one.</p>';
      return;
    }
    slot.innerHTML = '';
    const img = document.createElement('img');
    img.src = url;
    img.alt = `Alpha Strike card for ${u.name}`;
    const open = document.createElement('button');
    open.className = 'btn ghost small';
    open.textContent = 'Open card in new tab';
    open.addEventListener('click', () => window.open(url, '_blank', 'noopener'));
    slot.append(img, open);
  })();

  const close = () => { back.remove(); document.removeEventListener('keydown', onEsc); };
  back.querySelector('.modal-x').addEventListener('click', close);
  back.querySelector('#modal-close').addEventListener('click', close);
  bt.statsById.set(u.id, u);
  back.querySelector('#modal-add').addEventListener('click', () => {
    addToForce(u);
    toast(`Added ${u.name}`);
    close();
  });
}

// ----------------------------------------------------------- print playsheet

// A play sheet, not a screenshot of the app: one row per unit with everything
// needed at the table, sized to print on a single sheet where possible.
function printForce() {
  if (!bt.force.length) return toast('Add some units first.');
  const name = document.getElementById('force-name').value.trim() || 'Force';

  const tw = bt.mode === 'tw';
  const rows = bt.force.map((e) => {
    const u = bt.statsById?.get(e.id) ?? {};
    const crew = tw
      ? `<td class="num">${e.gunnery ?? 4}</td><td class="num">${e.piloting ?? 5}</td>`
      : `<td class="num">${e.skill ?? 4}</td>`;
    return `<tr>
      <td class="p-name">${esc(e.name)}</td>
      <td>${esc(u.type ?? e.type ?? '')}</td>
      ${crew}
      <td class="num">${entryCost(e)}</td>
      <td>${esc(u.move ?? e.move ?? '')}</td>
      <td class="num">${tmmForMove(u.move ?? e.move) ?? ''}</td>
      <td class="num">${u.damage ? `${u.damage.s ?? '-'}/${u.damage.m ?? '-'}/${u.damage.l ?? '-'}` : ''}</td>
      <td class="num">${u.overheat ?? ''}</td>
      <td class="num">${u.armor ?? ''} / ${u.structure ?? ''}</td>
      <td class="p-abil">${esc(u.abilities ?? '')}</td>
      <td class="p-track"></td>
    </tr>`;
  }).join('');

  const sheet = document.createElement('div');
  sheet.id = 'printsheet';
  sheet.innerHTML = `
    <h1>${esc(name)}</h1>
    <div class="p-meta">${bt.force.length} units &bull; ${forceTonnage()} tons &bull;
      ${forceTotal()} ${MODES[bt.mode].cost} &bull; ${MODES[bt.mode].label}</div>
    <table>
      <thead><tr>
        <th>Unit</th><th>Type</th>
        ${tw ? '<th class="num">G</th><th class="num">P</th>' : '<th class="num">Sk</th>'}
        <th class="num">${MODES[bt.mode].cost}</th>
        <th>Mv</th><th class="num">TMM</th><th class="num">S/M/L</th><th class="num">OV</th>
        <th class="num">A / S</th><th>Abilities</th><th>Damage track</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="p-foot">Raising Havok — from our archive of the Master Unit List</p>`;

  document.body.append(sheet);
  const cleanup = () => { sheet.remove(); window.removeEventListener('afterprint', cleanup); };
  window.addEventListener('afterprint', cleanup);
  window.print();
}

// ------------------------------------------------------------------ chooser

function viewHome() {
  $app.innerHTML = `
    <h1>Builders</h1>
    <div class="sub">Raising Havok — list builders for da games we play</div>
    <div class="card-grid">
      <div class="card builder-card" onclick="location.hash='#/battletech'">
        <div class="game">BattleTech</div>
        <h3>Alpha Strike Force Builder</h3>
        <div class="meta">Full unit roster wiv faction an' era availability, skill-adjusted PV,
          an' saved forces. Built from our own archive of da Master Unit List.</div>
      </div>
      <div class="card builder-card" onclick="location.href='/builders/mcp/'">
        <div class="game">Marvel Crisis Protocol</div>
        <h3>Roster Builder</h3>
        <div class="meta">Ten characters, five tactics, six crises — den pick tonight's squad
          to da threat level. Card data from da BSData community files (Dec 2024 — check yer
          threat values against current AMG cards).</div>
      </div>
      <div class="card builder-card" onclick="location.href='/league/'">
        <div class="game">Blood Bowl</div>
        <h3>Team Draft &amp; Roster</h3>
        <div class="meta">Draftin', advancement an' injuries. A Blood Bowl roster belongs to a
          team in a league, so pick yer league an' team on da league page an' da draft screen
          opens from there.</div>
      </div>
    </div>`;
}

// -------------------------------------------------------------------- router

async function route() {
  if (!me) { loginWall(); return; }
  const hash = location.hash || '#/';
  if (hash.startsWith('#/battletech')) return viewBattleTech();
  return viewHome();
}

async function boot() {
  try {
    const cfg = await fetch('/api/config').then((r) => r.json());
    discordSso = Boolean(cfg.discordEnabled);
  } catch { /* config is best-effort */ }

  try {
    me = await api('/me');
  } catch {
    me = null;
  }

  const who = document.getElementById('whoami');
  if (who) who.textContent = me ? `👤 ${me.name}` : '';

  window.addEventListener('hashchange', route);
  route();
}

boot();
