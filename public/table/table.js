// Game Night — live at-the-table play tracker.
// Hash-routed like the league SPA, same account (mol_token), plain vanilla JS.
//
// iPad-first: every control is a real tap target, nothing needs hover, and
// updates are optimistic — tap the pip, see it fill, the server patch and the
// socket echo reconcile everyone else's screen.
//
// Three game modes, all snapshot-at-create (see server/table.js):
//   battletech-as      — Alpha Strike cards (this file renders them)
//   battletech-classic — Total Warfare record sheets (classic.js renders)
//   wh40k              — Warhammer 40k datasheets (wh40k.js renders)

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
  const method = String(opts.method || 'GET').toUpperCase();
  const once = async () => {
    const res = await fetch('/api' + path, { headers, ...opts });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
      // A mid-deploy restart answers with Azure's HTML 502/503, which is not
      // JSON — turn that into something a human can act on.
      if (data && data.error) throw new Error(data.error);
      const err = new Error(res.status === 502 || res.status === 503 || data === null
        ? "Site's restartin' — give it a few seconds an' try again."
        : 'server said no');
      err.retryable = res.status === 502 || res.status === 503 || data === null;
      throw err;
    }
    return data ?? {};
  };
  try {
    return await once();
  } catch (e) {
    // One automatic retry for reads only — writes must never double-fire.
    if (e.retryable && method === 'GET') {
      await new Promise((r) => setTimeout(r, 2000));
      return once();
    }
    throw e;
  }
}

function loginWall() {
  const href = discordSso ? '/api/auth/discord?return=/table/' : '/play/';
  $app.innerHTML = `
    <h1>Game Night</h1>
    <div class="sub">Members only</div>
    <div class="card" style="text-align:center;padding:40px">
      <p class="muted" style="margin-bottom:20px">Live table trackin' is for club members.<br>
      Log in wiv yer Discord.</p>
      <a class="btn" href="${href}">Log in${discordSso ? ' with Discord' : ''}</a>
    </div>`;
}

// ---- lobby ----

const isBattletech = (game) => game === 'battletech-as' || game === 'battletech-classic';

async function viewLobby() {
  const [mine, games] = await Promise.all([api('/table'), api('/table-games')]);
  // Saved forces power "attach my force to a side"; the lobby still works if
  // the unit database is down — you just start with empty sides.
  let forces = [];
  try { forces = (await api('/builders/forces')).forces || []; } catch { /* db down / none saved */ }
  // Most recently saved force first — arrivals from the builders page just
  // saved the force they want on the table.
  const newestForce = forces.slice().sort((a, b) => (b.updated || 0) - (a.updated || 0))[0]?.name || '';

  const statusTag = (t) => t.status === 'done' ? '<span class="tag">finished</span>'
    : t.status === 'playing' ? `<span class="tag" style="color:var(--ok)">round ${t.round}</span>`
    : '<span class="tag">setting up</span>';

  // The action leads: start a table (pick game, attach force, play), join code
  // right beside it, then the table list.
  $app.innerHTML = `
    <h1>Game Night</h1>
    <div class="sub">Live table tracker — one sheet, every screen</div>

    <div class="lobby-top">
      <div class="card start-card">
        <h2 style="margin-top:0">Start a Table</h2>
        <div class="form-grid">
          <label>Game <select id="n-game">${games.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select></label>
          <label>Table name <input id="n-name" maxlength="60" placeholder="Tuesday night grudge match"></label>
        </div>
        <h3 style="color:var(--bone);font-size:15px;margin:14px 0 8px">Sides</h3>
        <div id="n-sides"></div>
        <button class="btn ghost small" id="n-addside">+ side</button>
        <div style="margin-top:14px"><button class="btn big" id="n-create">Open da Table</button></div>
        <div class="error" id="n-err"></div>
      </div>
      <div class="card join-card">
        <h2 style="margin-top:0">Join a Table</h2>
        <p class="muted" style="margin-bottom:8px">Punch in da 6-letter code off yer opponent's screen.</p>
        <div class="join-row">
          <input id="j-code" maxlength="6" placeholder="a1b2c3" autocapitalize="off" autocomplete="off">
          <button class="btn" id="j-go">Join</button>
        </div>
        <div class="error" id="j-err"></div>
      </div>
    </div>

    <h2>My Tables</h2>
    <div class="card-grid">
      ${mine.tables.map((t) => `
        <div class="card tbl-card" data-open="${t.id}">
          <h3>${esc(t.name)}</h3>
          <div class="meta">${esc(t.gameName)} • ${t.sides.map((s) => esc(s.name)).join(' vs ')} ${statusTag(t)}</div>
          <div class="meta">code <span class="code">${t.id}</span> • by ${esc(t.createdBy)}</div>
        </div>`).join('') || '<p class="muted">No tables yet — start one above, or join wiv a code.</p>'}
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

  const forceOpts = (selected) => `<option value="">— no force attached —</option>`
    + forces.map((f) => `<option value="${esc(f.name)}"${f.name === selected ? ' selected' : ''}>${esc(f.name)}${f.totalPV != null ? ` (${f.totalPV} PV)` : ''}</option>`).join('');
  const $sides = $app.querySelector('#n-sides');
  const $game = $app.querySelector('#n-game');

  // Per-game side inputs: battletech sides attach one of MY saved forces,
  // wh40k sides take a pasted army list (resolved before the table opens).
  const sideRow = (name, preselect) => {
    const div = document.createElement('div');
    div.className = 'side-row' + ($game.value === 'wh40k' ? ' side-row-40k' : '');
    div.innerHTML = $game.value === 'wh40k'
      ? `<input class="s-name" maxlength="40" placeholder="Side ${$sides.children.length + 1}" value="${esc(name)}">
         <span class="rm" title="remove side">✕</span>
         <textarea class="s-army" rows="3" placeholder="paste an army list here (GW app / BattleScribe / New Recruit) — or leave empty an' add it at da table"></textarea>`
      : `<input class="s-name" maxlength="40" placeholder="Side ${$sides.children.length + 1}" value="${esc(name)}">
         <select class="s-force" title="attach one o' MY saved forces">${forceOpts(preselect)}</select>
         <span class="rm" title="remove side">✕</span>`;
    div.querySelector('.rm').onclick = () => { if ($sides.children.length > 2) div.remove(); };
    return div;
  };
  const addSide = (name = '', preselect = '') => {
    if ($sides.children.length >= 4) return;
    $sides.appendChild(sideRow(name, preselect));
  };
  const resetSides = () => {
    $sides.innerHTML = '';
    // Hand-off from the builders page: preselect the freshest saved force.
    addSide(me ? me : 'Home', isBattletech($game.value) ? newestForce : '');
    addSide('Away');
  };
  resetSides();
  $game.onchange = resetSides;
  $app.querySelector('#n-addside').onclick = () => addSide();

  $app.querySelector('#n-create').onclick = async () => {
    const $err = $app.querySelector('#n-err');
    $err.textContent = '';
    const game = $game.value;
    const name = $app.querySelector('#n-name').value;
    const rows = [...$sides.querySelectorAll('.side-row')];
    const sides = rows.map((r, i) => ({
      name: r.querySelector('.s-name').value.trim() || `Side ${i + 1}`,
      forceName: r.querySelector('.s-force')?.value || undefined,
      armyText: r.querySelector('.s-army')?.value.trim() || undefined,
    }));
    try {
      if (game === 'wh40k' && sides.some((s) => s.armyText)) {
        // Resolve every pasted list first, then confirm on the resolve screen.
        const resolved = [];
        for (const s of sides) {
          resolved.push({
            name: s.name,
            resolve: s.armyText ? await api('/builders/wh40k/resolve-list', { method: 'POST', body: JSON.stringify({ text: s.armyText }) }) : null,
          });
        }
        renderResolveScreen(resolved, async (armies) => {
          const t = await api('/table', {
            method: 'POST',
            body: JSON.stringify({
              game, name,
              sides: resolved.map((s, i) => ({ name: s.name, army: armies[i] && armies[i].length ? armies[i] : undefined })),
            }),
          });
          location.hash = '#/t/' + t.id;
        });
        return;
      }
      const t = await api('/table', {
        method: 'POST',
        body: JSON.stringify({ game, name, sides: sides.map((s) => ({ name: s.name, forceName: s.forceName })) }),
      });
      location.hash = '#/t/' + t.id;
    } catch (e) { $err.textContent = e.message; }
  };
}

// ---- wh40k resolve screen ----
// sides: [{ name, resolve: { units, unmatched } | null }]
// onConfirm(armies) gets one [{ id, models? }] array per side (null resolve -> []).
function renderResolveScreen(sides, onConfirm) {
  $app.innerHTML = `
    <div class="crumb"><a href="#/">Game Night</a> / resolve army lists</div>
    <h1>Check da Lists</h1>
    <div class="sub">Pick da right datasheet where it's ambiguous — dropped lines don't hit da table</div>
    ${sides.map((s, si) => !s.resolve ? '' : `
      <h2>${esc(s.name)}</h2>
      <div class="card">
        ${s.resolve.units.map((u, ui) => `
          <div class="rs-row">
            <span class="rs-line" title="${esc(u.line)}">${esc(u.parsedName)}${u.count > 1 ? ` ×${u.count}` : ''}</span>
            <select class="rs-pick" data-side="${si}" data-unit="${ui}">
              ${u.matches.map((m, mi) => `<option value="${mi}"${mi === 0 ? ' selected' : ''}>${esc(m.name)} (${esc(m.factionId)})</option>`).join('')}
              <option value="-1">— drop dis line —</option>
            </select>
            <label class="rs-models">models <input type="number" min="1" max="30" placeholder="auto" data-side="${si}" data-unit="${ui}" class="rs-count"></label>
            ${u.ambiguous ? '<span class="tag" style="color:var(--rust)">ambiguous</span>' : ''}
          </div>`).join('') || '<p class="muted">Nothin\' parsed on dis side.</p>'}
        ${s.resolve.unmatched.length ? `
          <div class="rs-unmatched">
            <b>Not matched (dropped):</b>
            ${s.resolve.unmatched.map((x) => `<div class="muted">${esc(x.line)}</div>`).join('')}
          </div>` : ''}
      </div>`).join('')}
    <div style="margin-top:14px">
      <button class="btn big" id="rs-confirm">Looks Right — Open da Table</button>
      <a class="btn ghost" href="#/" style="margin-left:10px">Cancel</a>
    </div>
    <div class="error" id="rs-err"></div>`;

  $app.querySelector('#rs-confirm').onclick = async () => {
    const armies = sides.map((s, si) => {
      if (!s.resolve) return [];
      const army = [];
      s.resolve.units.forEach((u, ui) => {
        const pick = +$app.querySelector(`.rs-pick[data-side="${si}"][data-unit="${ui}"]`).value;
        if (pick < 0 || !u.matches[pick]) return; // dropped
        const modelsRaw = $app.querySelector(`.rs-count[data-side="${si}"][data-unit="${ui}"]`).value;
        const models = modelsRaw === '' ? undefined : Math.min(Math.max(+modelsRaw || 1, 1), 30);
        // A "3x Unit" line is three separate units on the table.
        for (let n = 0; n < Math.min(u.count || 1, 10); n++) army.push({ id: u.matches[pick].id, models });
      });
      return army;
    });
    try { await onConfirm(armies); } catch (e) { $app.querySelector('#rs-err').textContent = e.message; }
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
  if (field.startsWith('armorHit.')) u.armorHit[field.slice(9)] = value;
  else if (field.startsWith('structHit.')) u.structHit[field.slice(10)] = value;
  else if (field.startsWith('crit.')) {
    const [, loc, slot] = field.split('.');
    const set = new Set(u.critHits[loc] || []);
    if (value) set.add(+slot); else set.delete(+slot);
    u.critHits[loc] = [...set].sort((a, b) => a - b);
  } else if (field.startsWith('weaponOut.')) {
    const i = +field.slice(10);
    const set = new Set(u.weaponsOut || []);
    if (value) set.add(i); else set.delete(i);
    u.weaponsOut = [...set].sort((a, b) => a - b);
  } else if (field.startsWith('wounds.')) {
    u.wounds[+field.slice(7)] = value;
    u.destroyed = u.wounds.every((w) => w >= u.woundsPer);
  } else if (field === 'pilotHits') u.pilotHits = value;
  else if (field === 'gunnery' || field === 'piloting') {
    u[field] = value;
    if (window.AlphaStrike && u.baseBV != null) u.bv = AlphaStrike.bvForCrew(u.baseBV, u.gunnery, u.piloting);
  } else if (field === 'armorHit') u.armorHit = value;
  else if (field === 'structHit') u.structHit = value;
  else if (field === 'heat') u.heat = value;
  else if (field === 'notes') u.notes = value;
  else if (field === 'destroyed') u.destroyed = value;
  else if (field.startsWith('crits.')) u.crits[field.slice(6)] = value;

  if (T.game === 'battletech-as' && (field === 'structHit' || field === 'crits.engine')) {
    u.destroyed = u.structHit >= u.maxStruct || u.crits.engine >= 2;
  }
  if (T.game === 'battletech-classic' && window.ClassicCard
    && (field.startsWith('structHit.') || field.startsWith('crit.') || field === 'pilotHits')) {
    u.destroyed = ClassicCard.autoDestroyed(u);
  }
}

function readField(u, field) {
  if (field.startsWith('crits.')) return u.crits[field.slice(6)];
  if (field.startsWith('armorHit.')) return u.armorHit[field.slice(9)] || 0;
  if (field.startsWith('structHit.')) return u.structHit[field.slice(10)] || 0;
  if (field.startsWith('crit.')) {
    const [, loc, slot] = field.split('.');
    return (u.critHits[loc] || []).includes(+slot);
  }
  if (field.startsWith('weaponOut.')) return (u.weaponsOut || []).includes(+field.slice(10));
  if (field.startsWith('wounds.')) return u.wounds[+field.slice(7)] || 0;
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

// Side-level trackers (wh40k CP/VP). Optimistic, no undo stack — the +/-
// buttons are their own undo.
async function patchSide(sideIdx, field, value) {
  const s = T.sides[sideIdx];
  if (!s) return;
  const prev = s[field] || 0;
  s[field] = value;
  redrawSideTrackers(sideIdx);
  try {
    await api(`/table/${T.id}/state`, { method: 'POST', body: JSON.stringify({ side: sideIdx, field, value }) });
  } catch (e) {
    s[field] = prev;
    redrawSideTrackers(sideIdx);
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
// tap the topmost filled pip clears it (tap-same undoes one).
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

function asCardHTML(u) {
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

function cardHTML(u) {
  const canUndo = (undoStacks.get(u.uid) || []).length > 0;
  if (T.game === 'battletech-classic' && window.ClassicCard) return ClassicCard.html(u, T.status, canUndo);
  if (T.game === 'wh40k' && window.W40kCard) return W40kCard.html(u, canUndo);
  return asCardHTML(u);
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

function redrawSideTrackers(i) {
  const s = T.sides[i];
  const cp = document.getElementById(`cp-num-${i}`);
  const vp = document.getElementById(`vp-num-${i}`);
  if (cp) cp.textContent = s.cp || 0;
  if (vp) vp.textContent = s.vp || 0;
}

function sideSub(s) {
  const alive = s.units.filter((u) => !u.destroyed).length;
  if (T.game === 'battletech-classic') {
    const bv = s.units.reduce((n, u) => n + (u.bv || 0), 0);
    return `${s.owner ? s.owner + ' • ' : ''}${bv} BV • ${alive}/${s.units.length} standing`;
  }
  if (T.game === 'wh40k') {
    return `${s.owner ? s.owner + ' • ' : ''}${alive}/${s.units.length} units standing`;
  }
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

async function reloadTable() {
  try {
    T = await api('/table/' + T.id);
    renderPlay();
  } catch { /* keep the old view */ }
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
    if (p.reload) { reloadTable(); return; }
    if (p.unit) {
      for (const s of T.sides) {
        const i = s.units.findIndex((x) => x.uid === p.uid);
        if (i !== -1) s.units[i] = p.unit;
      }
      redrawCard(p.uid);
    }
    if (p.sideState != null && T.sides[p.side]) {
      T.sides[p.side].cp = p.sideState.cp;
      T.sides[p.side].vp = p.sideState.vp;
      redrawSideTrackers(p.side);
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

// Empty side: the owner-to-be brings units. Battletech games attach one of MY
// saved forces; wh40k pastes an army list (resolved before confirming).
function emptySideHTML(s, i) {
  if (T.status === 'done') return '<p class="muted">No units on dis side.</p>';
  if (T.game === 'wh40k') {
    return `
      <div class="card claim-card">
        <p class="muted">Nothin' deployed — paste yer army list an' claim dis side.</p>
        <textarea class="claim-army" data-side="${i}" rows="4" placeholder="paste an army list (GW app / BattleScribe / New Recruit)"></textarea>
        <div style="margin-top:8px"><button class="btn" data-claim40k="${i}">Check da List</button></div>
      </div>`;
  }
  return `
    <div class="card claim-card">
      <p class="muted">No units on dis side — bring a force from da <a href="/builders/">builder</a>.</p>
      <div class="join-row" style="margin-top:8px">
        <select class="claim-force" data-side="${i}" style="min-width:200px"><option value="">— pick a saved force —</option></select>
        <button class="btn" data-claimbt="${i}">Deploy</button>
      </div>
    </div>`;
}

function sideTrackersHTML(s, i) {
  if (T.game !== 'wh40k' || T.status === 'done') return '';
  return `
    <span class="side-track">
      <span class="lbl">CP</span>
      <button class="rbtn sm" data-tside="${i}" data-tfield="cp" data-d="-1">−</button>
      <b id="cp-num-${i}">${s.cp || 0}</b>
      <button class="rbtn sm" data-tside="${i}" data-tfield="cp" data-d="1">+</button>
    </span>
    <span class="side-track">
      <span class="lbl">VP</span>
      <button class="rbtn sm" data-tside="${i}" data-tfield="vp" data-d="-1">−</button>
      <b id="vp-num-${i}">${s.vp || 0}</b>
      <button class="rbtn sm" data-tside="${i}" data-tfield="vp" data-d="1">+</button>
    </span>`;
}

function renderPlay() {
  const done = T.status === 'done';
  $app.innerHTML = `
    <div class="crumb"><a href="#/">Game Night</a> / ${esc(T.name)}</div>
    <div class="play-head">
      <h1>${esc(T.name)}</h1>
      ${done ? '<span class="tag">finished</span>' : `
      <span class="round-ctl">
        <span class="lbl">${T.game === 'wh40k' ? 'Battle round' : 'Round'}</span>
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
        ${sideTrackersHTML(s, i)}
      </div>
      <div class="unit-grid${T.game === 'battletech-classic' ? ' classic-grid' : ''}">
        ${s.units.map(cardHTML).join('') || emptySideHTML(s, i)}
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
            <label>Victory points <input type="number" class="vp-input" data-vp="${esc(s.name)}" min="0" max="200" value="${T.game === 'wh40k' ? (s.vp || 0) : 0}"></label>
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

    // Populate the claim-a-side force dropdowns (battletech only).
    const claims = [...document.querySelectorAll('select.claim-force')];
    if (claims.length) {
      api('/builders/forces').then((r) => {
        const forces = (r.forces || []).slice().sort((a, b) => (b.updated || 0) - (a.updated || 0));
        claims.forEach((sel) => {
          sel.innerHTML = '<option value="">— pick a saved force —</option>'
            + forces.map((f) => `<option value="${esc(f.name)}">${esc(f.name)}${f.totalPV != null ? ` (${f.totalPV} PV)` : ''}</option>`).join('');
        });
      }).catch(() => { /* db down */ });
    }
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
  const pip = ev.target.closest('.pip[data-uid][data-field], .sq[data-uid][data-field]');
  if (pip && T && T.status !== 'done') {
    const { uid, field } = pip.dataset;
    const k = +pip.dataset.n;
    const u = unitByUid(uid);
    if (!u) return;
    const cur = readField(u, field);
    patch(uid, field, k === cur ? k - 1 : k);
    return;
  }
  // boolean toggles: crit slots, weapon-out buttons
  const tgl = ev.target.closest('[data-uid][data-toggle]');
  if (tgl && T && T.status !== 'done') {
    const u = unitByUid(tgl.dataset.uid);
    if (u) patch(u.uid, tgl.dataset.toggle, !readField(u, tgl.dataset.toggle));
    return;
  }
  const undoBtn = ev.target.closest('[data-undo]');
  if (undoBtn) { undoLast(undoBtn.dataset.undo); return; }
  const wreckBtn = ev.target.closest('[data-wreck]');
  if (wreckBtn && T && T.status !== 'done') {
    const u = unitByUid(wreckBtn.dataset.wreck);
    if (u) patch(u.uid, 'destroyed', !u.destroyed);
    return;
  }
  // side CP/VP steppers (wh40k)
  const tr = ev.target.closest('[data-tside][data-tfield]');
  if (tr && T && T.status !== 'done') {
    const i = +tr.dataset.tside;
    const s = T.sides[i];
    if (!s) return;
    const next = Math.max(0, (s[tr.dataset.tfield] || 0) + (+tr.dataset.d));
    patchSide(i, tr.dataset.tfield, next);
    return;
  }
  // claim an empty side
  const claimBt = ev.target.closest('[data-claimbt]');
  if (claimBt && T && T.status !== 'done') {
    const i = +claimBt.dataset.claimbt;
    const sel = document.querySelector(`select.claim-force[data-side="${i}"]`);
    if (!sel || !sel.value) { playErr('Pick a saved force first.'); return; }
    api(`/table/${T.id}/side/${i}/units`, { method: 'POST', body: JSON.stringify({ forceName: sel.value }) })
      .then((t) => { T = t; renderPlay(); })
      .catch((e) => playErr(e.message));
    return;
  }
  const claim40k = ev.target.closest('[data-claim40k]');
  if (claim40k && T && T.status !== 'done') {
    const i = +claim40k.dataset.claim40k;
    const ta = document.querySelector(`textarea.claim-army[data-side="${i}"]`);
    const text = ta ? ta.value.trim() : '';
    if (!text) { playErr('Paste an army list first.'); return; }
    const tableId = T.id;
    api('/builders/wh40k/resolve-list', { method: 'POST', body: JSON.stringify({ text }) })
      .then((resolve) => {
        renderResolveScreen([{ name: T.sides[i].name, resolve }], async (armies) => {
          const t = await api(`/table/${tableId}/side/${i}/units`, { method: 'POST', body: JSON.stringify({ army: armies[0] }) });
          T = t;
          renderPlay();
        });
      })
      .catch((e) => playErr(e.message));
  }
});
$app.addEventListener('change', (ev) => {
  const notes = ev.target.closest('input.notes[data-uid]');
  if (notes && T && T.status !== 'done') { patch(notes.dataset.uid, 'notes', notes.value, { undoable: false }); return; }
  // classic crew skills, editable during setup only
  const crew = ev.target.closest('select.crew-sel[data-uid][data-field]');
  if (crew && T && T.status === 'setup') patch(crew.dataset.uid, crew.dataset.field, +crew.value, { undoable: false });
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
