// Game Night — live at-the-table play tracker.
// Hash-routed like the league SPA, same account (mol_token), plain vanilla JS.
//
// iPad-first: every control is a real 34px+ tap target, nothing needs hover,
// and updates are optimistic — tap the pip, see it fill, the server patch and
// the socket echo reconcile everyone else's screen.

// Discord SSO hands the session token back in the URL fragment (works if
// /table/ is ever added to the SSO return whitelist; harmless otherwise).
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

// play-screen state
let T = null;            // the current table object
let socket = null;
const undoStacks = new Map();  // uid -> [{ field, prev }]

const CRIT_ROWS = [
  ['engine', 'Engine', 2],
  ['fireControl', 'F. Ctrl', 4],
  ['mp', 'MP', 4],
  ['weapons', 'Weapons', 4],
];

function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch('/api' + path, { headers, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'server said no');
  return data;
}

function loginWall() {
  // /table/ isn't in the SSO return whitelist, so bounce via the league page —
  // same token, same localStorage.
  const href = discordSso ? '/api/auth/discord?return=/league/' : '/play/';
  $app.innerHTML = `
    <h1>Game Night</h1>
    <div class="sub">Members only</div>
    <div class="card" style="text-align:center;padding:40px">
      <p class="muted" style="margin-bottom:20px">Live table trackin' is for club members.<br>
      Log in wiv yer Discord${discordSso ? ' (you\'ll land on da league page — come back here after)' : ''}.</p>
      <a class="btn" href="${href}">Log in${discordSso ? ' with Discord' : ''}</a>
    </div>`;
}

// ---- lobby ----

async function viewLobby() {
  const [mine, games] = await Promise.all([api('/table'), api('/table-games')]);
  // Saved forces power "attach my force to a side"; the lobby still works if
  // the unit database is down — you just start with empty sides.
  let forces = [];
  try { forces = (await api('/builders/forces')).forces || []; } catch { /* db down / none saved */ }

  const statusTag = (t) => t.status === 'done' ? '<span class="tag">finished</span>'
    : t.status === 'playing' ? `<span class="tag" style="color:var(--ok)">round ${t.round}</span>`
    : '<span class="tag">setting up</span>';

  $app.innerHTML = `
    <h1>Game Night</h1>
    <div class="sub">Live table tracker — one sheet, every screen</div>

    <h2>My Tables</h2>
    <div class="card-grid">
      ${mine.tables.map((t) => `
        <div class="card tbl-card" data-open="${t.id}">
          <h3>${esc(t.name)}</h3>
          <div class="meta">${esc(t.gameName)} • ${t.sides.map((s) => esc(s.name)).join(' vs ')} ${statusTag(t)}</div>
          <div class="meta">code <span class="code">${t.id}</span> • by ${esc(t.createdBy)}</div>
        </div>`).join('') || '<p class="muted">No tables yet — start one below, or join wiv a code.</p>'}
    </div>

    <h2>Join a Table</h2>
    <div class="card">
      <div class="join-row">
        <input id="j-code" maxlength="6" placeholder="a1b2c3" autocapitalize="off" autocomplete="off">
        <button class="btn" id="j-go">Join</button>
        <span class="muted">— da 6-letter code off yer opponent's screen</span>
      </div>
      <div class="error" id="j-err"></div>
    </div>

    <h2>Start a Table</h2>
    <div class="card">
      <div class="form-grid">
        <label>Game <select id="n-game">${games.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select></label>
        <label>Table name <input id="n-name" maxlength="60" placeholder="Tuesday night grudge match"></label>
      </div>
      <h3 style="color:var(--bone);font-size:15px;margin:14px 0 8px">Sides</h3>
      <div id="n-sides"></div>
      <button class="btn ghost small" id="n-addside">+ side</button>
      <div style="margin-top:14px"><button class="btn" id="n-create">Open da Table</button></div>
      <div class="error" id="n-err"></div>
    </div>`;

  $app.querySelectorAll('[data-open]').forEach((el) => {
    el.onclick = () => { location.hash = '#/t/' + el.dataset.open; };
  });

  const goJoin = () => {
    const code = $app.querySelector('#j-code').value.trim().toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(code)) {
      $app.querySelector('#j-err').textContent = 'Codes are 6 letters/numbers, like a1b2c3.';
      return;
    }
    location.hash = '#/t/' + code;
  };
  $app.querySelector('#j-go').onclick = goJoin;
  $app.querySelector('#j-code').onkeydown = (e) => { if (e.key === 'Enter') goJoin(); };

  const forceOpts = `<option value="">— no force attached —</option>`
    + forces.map((f) => `<option value="${esc(f.name)}">${esc(f.name)}${f.totalPV != null ? ` (${f.totalPV} PV)` : ''}</option>`).join('');
  const $sides = $app.querySelector('#n-sides');
  const addSide = (name = '') => {
    if ($sides.children.length >= 4) return;
    const div = document.createElement('div');
    div.className = 'side-row';
    div.innerHTML = `
      <input class="s-name" maxlength="40" placeholder="Side ${$sides.children.length + 1}" value="${esc(name)}">
      <select class="s-force" title="attach one o' MY saved forces">${forceOpts}</select>
      <span class="rm" title="remove side">✕</span>`;
    div.querySelector('.rm').onclick = () => { if ($sides.children.length > 2) div.remove(); };
    $sides.appendChild(div);
  };
  addSide(me ? me : 'Home');
  addSide('Away');
  $app.querySelector('#n-addside').onclick = () => addSide();

  $app.querySelector('#n-create').onclick = async () => {
    const sides = [...$sides.querySelectorAll('.side-row')].map((r, i) => ({
      name: r.querySelector('.s-name').value.trim() || `Side ${i + 1}`,
      forceName: r.querySelector('.s-force').value || undefined,
    }));
    try {
      const t = await api('/table', {
        method: 'POST',
        body: JSON.stringify({
          game: $app.querySelector('#n-game').value,
          name: $app.querySelector('#n-name').value,
          sides,
        }),
      });
      location.hash = '#/t/' + t.id;
    } catch (e) { $app.querySelector('#n-err').textContent = e.message; }
  };
}

// ---- play screen ----

function unitByUid(uid) {
  if (!T) return null;
  for (const s of T.sides) {
    const u = s.units.find((x) => x.uid === uid);
    if (u) return u;
  }
  return null;
}

// Mirror of the server's per-field rules so optimistic taps land on legal
// values; the server remains the referee.
function applyLocal(u, field, value) {
  if (field === 'armorHit') u.armorHit = value;
  else if (field === 'structHit') u.structHit = value;
  else if (field === 'heat') u.heat = value;
  else if (field === 'notes') u.notes = value;
  else if (field === 'destroyed') u.destroyed = value;
  else if (field.startsWith('crits.')) u.crits[field.slice(6)] = value;
  if (field === 'structHit' || field === 'crits.engine') {
    u.destroyed = u.structHit >= u.maxStruct || u.crits.engine >= 2;
  }
}

function readField(u, field) {
  if (field.startsWith('crits.')) return u.crits[field.slice(6)];
  return u[field];
}

function playErr(msg) {
  const el = document.getElementById('p-err');
  if (el) { el.textContent = msg; if (msg) setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 4000); }
}

async function patch(uid, field, value, { undoable = true } = {}) {
  const u = uid ? unitByUid(uid) : null;
  const prev = u ? readField(u, field) : T.round;
  // optimistic
  if (u) {
    if (undoable) {
      const stack = undoStacks.get(uid) || [];
      stack.push({ field, prev });
      undoStacks.set(uid, stack.slice(-20));
    }
    applyLocal(u, field, value);
    redrawCard(uid);
  } else if (field === 'round') {
    T.round = value;
    T.status = 'playing';
    redrawHead();
  }
  try {
    await api(`/table/${T.id}/state`, { method: 'POST', body: JSON.stringify({ uid, field, value }) });
  } catch (e) {
    // revert
    if (u) {
      if (undoable) (undoStacks.get(uid) || []).pop();
      applyLocal(u, field, prev);
      redrawCard(uid);
    } else if (field === 'round') { T.round = prev; redrawHead(); }
    playErr(e.message);
  }
}

function undoLast(uid) {
  const stack = undoStacks.get(uid) || [];
  const last = stack.pop();
  if (!last) return;
  patch(uid, last.field, last.prev, { undoable: false });
  redrawCard(uid);
}

// Bubble-row helper: pips 1..max, filled up to `n`. Tap pip k -> value k,
// tap the topmost filled pip -> value k-1 (tap-same undoes one).
function pips(u, field, max, n, cls) {
  let out = '';
  for (let k = 1; k <= max; k++) {
    out += `<button class="pip ${cls}${k <= n ? ' hit' : ''}${max > 10 ? ' mini' : ''}"
      data-uid="${u.uid}" data-field="${field}" data-n="${k}" aria-label="${cls} ${k} of ${max}"></button>`;
  }
  return out;
}

function squares(u, field, max, n, cls, numbered = false) {
  let out = '';
  for (let k = 1; k <= max; k++) {
    out += `<button class="sq ${cls}${k <= n ? ' hit' : ''}"
      data-uid="${u.uid}" data-field="${field}" data-n="${k}" aria-label="${cls} ${k} of ${max}">${numbered ? k : ''}</button>`;
  }
  return out;
}

function cardHTML(u) {
  const d = u.damage || {};
  const dmg = [d.s, d.m, d.l].map((x) => x ?? '–').join('/') + (d.e ? '/' + d.e : '');
  const canUndo = (undoStacks.get(u.uid) || []).length > 0;
  return `
  <div class="unit-card${u.destroyed ? ' destroyed' : ''}" data-card="${u.uid}">
    ${u.destroyed ? '<span class="wreck-badge">Destroyed</span>' : ''}
    <div class="u-top">
      <span class="u-name">${esc(u.name)}</span>
      <span class="u-pv">SK ${u.skill} • PV ${u.pv}</span>
    </div>
    <div class="u-line">MV <b>${esc(u.move ?? '?')}</b> • TMM <b>${u.tmm ?? '?'}</b> • DMG <b>${esc(dmg)}</b>${u.overheat ? ` • OV <b>${u.overheat}</b>` : ''}</div>
    ${u.abilities ? `<div class="u-line" style="font-size:12.5px;margin-top:-4px">${esc(u.abilities)}</div>` : ''}
    <div class="pip-row"><span class="plabel">Armor</span>${u.maxArmor ? pips(u, 'armorHit', u.maxArmor, u.armorHit, 'armor') : '<span class="muted">—</span>'}</div>
    <div class="pip-row"><span class="plabel">Struct</span>${pips(u, 'structHit', u.maxStruct, u.structHit, 'struct')}</div>
    <div class="pip-row"><span class="plabel">Heat</span>${squares(u, 'heat', 4, u.heat, 'heat', true)}</div>
    <div class="crit-grid">
      ${CRIT_ROWS.map(([key, label, max]) => `
        <div class="pip-row"><span class="plabel">${label}</span>${squares(u, 'crits.' + key, max, u.crits[key], 'crit')}</div>`).join('')}
    </div>
    <div class="u-foot">
      <input class="notes" data-uid="${u.uid}" maxlength="200" placeholder="notes…" value="${esc(u.notes)}">
      <button class="ubtn" data-undo="${u.uid}" ${canUndo ? '' : 'disabled'}>↩ Undo</button>
      <button class="ubtn danger" data-wreck="${u.uid}">${u.destroyed ? 'Revive' : 'Wreck'}</button>
    </div>
  </div>`;
}

function redrawCard(uid) {
  const u = unitByUid(uid);
  const el = document.querySelector(`[data-card="${uid}"]`);
  if (u && el) el.outerHTML = cardHTML(u);
  redrawSideTotals();
}

function redrawHead() {
  const el = document.getElementById('round-num');
  if (el) el.textContent = T.round;
}

function redrawSideTotals() {
  T.sides.forEach((s, i) => {
    const el = document.getElementById('side-sub-' + i);
    if (el) el.textContent = sideSub(s);
  });
}

function sideSub(s) {
  const alive = s.units.filter((u) => !u.destroyed).length;
  const pv = s.units.reduce((n, u) => n + (u.pv || 0), 0);
  return `${s.owner ? s.owner + ' • ' : ''}${pv} PV • ${alive}/${s.units.length} standing`;
}

function redrawLog() {
  const el = document.getElementById('play-log');
  if (!el) return;
  el.innerHTML = [...T.log].reverse().map((e) =>
    `<div><span class="t">${new Date(e.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>${esc(e.msg)}</div>`).join('')
    || '<span class="muted">Nothing yet.</span>';
}

function connectSocket(id) {
  if (socket) { socket.disconnect(); socket = null; }
  if (typeof io === 'undefined') return; // socket.io script blocked — polling-free but functional
  socket = io('/table');
  const join = () => socket.emit('join', { id, token }, (r) => {
    // full-table refresh on (re)join catches anything missed while offline
    if (r && r.table && T && r.table.id === T.id) { T = r.table; renderPlay(); }
  });
  socket.on('connect', join);
  socket.on('state', (p) => {
    if (!T || p.id !== T.id) return;
    T.round = p.round; T.status = p.status; T.updated = p.updated;
    if (p.unit) {
      for (const s of T.sides) {
        const i = s.units.findIndex((x) => x.uid === p.uid);
        if (i !== -1) s.units[i] = p.unit;
      }
      redrawCard(p.uid);
    }
    redrawHead();
    if (p.done) { T.status = 'done'; T.result = p.done; renderPlay(); }
  });
  socket.on('log', (entry) => {
    if (!T) return;
    T.log.push(entry);
    if (T.log.length > 200) T.log = T.log.slice(-200);
    redrawLog();
  });
  socket.on('scrapped', (p) => {
    if (T && p.id === T.id) { playErr('Table was scrapped.'); location.hash = '#/'; }
  });
}

function renderPlay() {
  const done = T.status === 'done';
  $app.innerHTML = `
    <div class="crumb"><a href="#/">Game Night</a> / ${esc(T.name)}</div>
    <div class="play-head">
      <h1>${esc(T.name)}</h1>
      ${done ? '<span class="tag">finished</span>' : `
      <span class="round-ctl">
        <span class="lbl">Round</span>
        <button class="rbtn" id="round-dn">−</button>
        <b id="round-num">${T.round}</b>
        <button class="rbtn" id="round-up">+</button>
      </span>`}
      <span class="join-code"><span class="lbl">Join code</span><b>${T.id}</b></span>
    </div>
    <div class="error" id="p-err"></div>

    ${done && T.result ? doneHTML(T.result) : ''}

    ${T.sides.map((s, i) => `
      <div class="side-title">
        <h2>${esc(s.name)}</h2>
        <span class="muted" id="side-sub-${i}">${sideSub(s)}</span>
      </div>
      <div class="unit-grid">
        ${s.units.map(cardHTML).join('') || '<p class="muted">No units on dis side — bring a force from da <a href="/builders/">builder</a>.</p>'}
      </div>`).join('')}

    ${done ? '' : `
    <h2>Finish</h2>
    <div class="card" id="finish-card">
      <p class="muted">Score yer objectives at da table, punch in da VP, an' file it to da league.</p>
      <div class="finish-grid" style="margin-top:10px">
        ${T.sides.map((s) => `
          <div>
            <h3 style="color:var(--bone);font-size:15px;margin-bottom:6px">${esc(s.name)}</h3>
            <div class="muted" style="margin-bottom:6px">${s.units.filter((u) => u.destroyed).length} lost so far</div>
            <label>Victory points <input type="number" class="vp-input" data-vp="${esc(s.name)}" min="0" max="99" value="0"></label>
          </div>`).join('')}
      </div>
      <div style="margin-top:14px"><button class="btn big" id="p-finish">Finish Table</button></div>
    </div>`}

    <h2>Log</h2>
    <div class="card play-log" id="play-log"></div>`;

  redrawLog();

  if (!done) {
    document.getElementById('round-up').onclick = () => patch(null, 'round', T.round + 1);
    document.getElementById('round-dn').onclick = () => { if (T.round > 1) patch(null, 'round', T.round - 1); };
    document.getElementById('p-finish').onclick = async () => {
      const vp = {};
      document.querySelectorAll('[data-vp]').forEach((el) => { vp[el.dataset.vp] = +el.value || 0; });
      try {
        const sum = await api(`/table/${T.id}/done`, { method: 'POST', body: JSON.stringify({ vp }) });
        // handoff for the league's match report form (the league page may read
        // this later; we only write it)
        localStorage.setItem('gamenight-handoff', JSON.stringify({
          from: 'gamenight', tableId: T.id, tableName: T.name, finished: Date.now(), ...sum,
        }));
        T.status = 'done';
        T.result = sum;
        renderPlay();
      } catch (e) { playErr(e.message); }
    };
  }
}

function doneHTML(sum) {
  return `
  <div class="card">
    <h2 style="margin-top:0">Final Tally</h2>
    <div class="finish-grid">
      ${sum.sides.map((s) => `
        <div style="text-align:center">
          <h3 style="color:var(--bone);font-size:16px">${esc(s.name)}</h3>
          <div class="done-num">${s.vp} VP</div>
          <div class="muted">${s.kills} kills • ${s.lost} lost</div>
        </div>`).join('')}
    </div>
    <p style="margin-top:14px"><a class="btn" href="/league/">File it in da League Tracker →</a>
    <span class="muted" style="margin-left:10px">da tally's saved on dis device for yer match report</span></p>
  </div>`;
}

async function viewPlay(id) {
  try {
    T = await api('/table/' + id);
  } catch (e) {
    $app.innerHTML = `<h1>Game Night</h1><div class="card"><p class="error">${esc(e.message)}</p><a class="btn ghost" href="#/">Back to da lobby</a></div>`;
    return;
  }
  undoStacks.clear();
  renderPlay();
  connectSocket(T.id);
}

// ---- tap handling: one delegated listener survives every re-render ----
$app.addEventListener('click', (ev) => {
  const pip = ev.target.closest('.pip[data-uid], .sq[data-uid]');
  if (pip && T && T.status !== 'done') {
    const { uid, field } = pip.dataset;
    const k = +pip.dataset.n;
    const u = unitByUid(uid);
    if (!u) return;
    const cur = readField(u, field);
    patch(uid, field, k === cur ? k - 1 : k);
    return;
  }
  const undoBtn = ev.target.closest('[data-undo]');
  if (undoBtn) { undoLast(undoBtn.dataset.undo); return; }
  const wreckBtn = ev.target.closest('[data-wreck]');
  if (wreckBtn && T && T.status !== 'done') {
    const u = unitByUid(wreckBtn.dataset.wreck);
    if (u) patch(u.uid, 'destroyed', !u.destroyed);
  }
});
$app.addEventListener('change', (ev) => {
  const notes = ev.target.closest('input.notes[data-uid]');
  if (notes && T && T.status !== 'done') patch(notes.dataset.uid, 'notes', notes.value, { undoable: false });
});

// ---- router ----

async function route() {
  if (socket && !location.hash.startsWith('#/t/')) { socket.disconnect(); socket = null; T = null; }
  if (!me) return loginWall();
  const m = location.hash.match(/^#\/t\/([0-9a-f]{6})/);
  try {
    if (m) await viewPlay(m[1]);
    else await viewLobby();
  } catch (e) {
    $app.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

window.addEventListener('hashchange', route);

(async () => {
  try { discordSso = (await api('/config')).discordEnabled; } catch { /* fine */ }
  if (token) {
    try {
      me = (await api('/me')).name;
      document.getElementById('whoami').textContent = me;
    } catch { me = null; }
  }
  route();
})();
