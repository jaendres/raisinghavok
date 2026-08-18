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
const { pvForSkill, SKILLS } = window.AlphaStrike;

const bt = {
  meta: null,
  force: [],      // { uid, id, name, pv (base), skill, type, tonnage }
  offset: 0,
  total: 0,
  uid: 1,
};

const forceTotal = () => bt.force.reduce((n, e) => n + pvForSkill(e.pv, e.skill), 0);

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
    <h1>BattleTech — Alpha Strike</h1>
    <div class="sub">${m.counts.units.toLocaleString()} units &bull;
      ${m.counts.availabilityPairs.toLocaleString()} faction/era entries</div>

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
          <label>Min PV<input type="number" id="f-minpv" min="0"></label>
          <label>Max PV<input type="number" id="f-maxpv" min="0"></label>
        </div>
        <label>Sort<select id="f-sort">
          <option value="name">Name</option>
          <option value="pv">PV (high &rarr; low)</option>
          <option value="pvasc">PV (low &rarr; high)</option>
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
              <th class="c-pv num">PV</th>
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
              <th class="f-name">Unit</th><th class="f-skill">Skill</th>
              <th class="f-pv num">PV</th><th class="f-rm"></th>
            </tr></thead>
            <tbody id="force-list"></tbody>
          </table>
        </div>
        <p class="muted" id="force-empty">Nuffin' here yet — add units from da list.</p>
        <div class="force-total"><span class="muted"><span id="force-count">0</span> units</span><b id="force-pv">0</b></div>
        <div class="force-actions">
          <button class="btn ghost small" id="force-copy">Copy as text</button>
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
  put('minPV', 'f-minpv');
  put('maxPV', 'f-maxpv');
  put('sort', 'f-sort');
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
      <td class="c-pv num pv">${u.pv}</td>
      <td class="c-mv">${esc(u.move ?? '')}</td>
      <td class="c-dmg num">${dmg(u)}</td>
      <td class="c-as num">${u.armor ?? '-'}/${u.structure ?? '-'}</td>`;
    tr.querySelector('.addbtn').addEventListener('click', () => {
      bt.force.push({ uid: bt.uid++, id: u.id, name: u.name, pv: u.pv, skill: 4, type: u.type, tonnage: u.tonnage });
      renderForce();
    });
    frag.append(tr);
  }
  body.append(frag);

  bt.total = data.total;
  bt.offset = body.children.length;
  document.getElementById('bt-count').textContent = `${bt.offset} of ${data.total}`;
  document.getElementById('bt-more').style.display = bt.offset >= data.total ? 'none' : '';
}

function renderForce() {
  const body = document.getElementById('force-list');
  if (!body) return;
  body.textContent = '';

  for (const entry of bt.force) {
    const tr = document.createElement('tr');

    const name = document.createElement('td');
    name.className = 'f-name';
    name.textContent = entry.name;

    const skillCell = document.createElement('td');
    skillCell.className = 'f-skill';
    const sel = document.createElement('select');
    sel.className = 'skillsel';
    for (const s of SKILLS) {
      const o = document.createElement('option');
      o.value = String(s);
      o.textContent = String(s);
      if (s === entry.skill) o.selected = true;
      sel.append(o);
    }
    sel.addEventListener('change', () => { entry.skill = Number(sel.value); renderForce(); });
    skillCell.append(sel);

    const pv = document.createElement('td');
    pv.className = 'f-pv num pv';
    pv.textContent = String(pvForSkill(entry.pv, entry.skill));

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

    tr.append(name, skillCell, pv, rm);
    body.append(tr);
  }

  document.getElementById('force-pv').textContent = String(forceTotal());
  document.getElementById('force-count').textContent = String(bt.force.length);
  document.getElementById('force-empty').style.display = bt.force.length ? 'none' : '';
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

  for (const id of ['f-q', 'f-minpv', 'f-maxpv']) {
    document.getElementById(id).addEventListener('input', rerun);
  }
  for (const id of ['f-faction', 'f-era', 'f-type', 'f-role', 'f-sort']) {
    document.getElementById(id).addEventListener('change', () => runSearch());
  }

  document.getElementById('f-reset').addEventListener('click', () => {
    for (const id of ['f-q', 'f-minpv', 'f-maxpv']) document.getElementById(id).value = '';
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
          units: bt.force.map((e) => ({ id: e.id, skill: e.skill })),
        }),
      });
      await refreshSavedForces();
      document.getElementById('force-saved').value = name;
      toast(`Saved "${name}"`);
    } catch (err) { toast(err.message); }
  });

  document.getElementById('force-saved').addEventListener('change', async (ev) => {
    const name = ev.target.value;
    if (!name) return;
    try {
      const data = await api('/builders/forces/' + encodeURIComponent(name));
      bt.force = data.units.map((u) => ({
        uid: bt.uid++, id: u.id, name: u.name, pv: u.pv, skill: u.skill, type: u.type, tonnage: u.tonnage,
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
      <div class="card builder-card" onclick="location.href='/league/'">
        <div class="game">Blood Bowl</div>
        <h3>Team Draft &amp; Roster</h3>
        <div class="meta">Lives on da league page — draftin', advancement an' injuries.</div>
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
