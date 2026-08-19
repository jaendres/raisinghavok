// Game Night — My Lists (solo play reference) + live at-the-table play tracker.
// Hash-routed like the league SPA, same account (mol_token), plain vanilla JS.
//
// iPad-first: every control is a real tap target, nothing needs hover, and
// updates are optimistic — tap the pip, see it fill, the server patch and the
// socket echo reconcile everyone else's screen.
//
// Two modes on one page:
//   My Lists — a personal reference library: save a list per game system,
//   prop the iPad next to the table, read your units' stats/abilities and
//   the army rules while playing. Tracking (the tap-pips) is optional and
//   off by default so the reading view stays uncluttered. The list JSON is
//   loaded once; everything renders from that snapshot, so it stays readable
//   if the connection drops mid-game.
//   Tables — the shared live tracker (unchanged).
//
// Table/list snapshot game modes (see server/table.js):
//   battletech-as      — Alpha Strike cards (this file renders them)
//   battletech-classic — Total Warfare record sheets (classic.js renders)
//   wh40k              — Warhammer 40k datasheets (wh40k.js renders)
//   necromunda         — gang fighter cards (necromunda.js renders)
//   mcp                — Crisis Protocol character cards (mcp.js renders)
//   bloodbowl          — player cards + the match bar (bloodbowl.js renders)
//   trenchcrusade      — warband model cards (trenchcrusade.js renders)
//
// The four tracker games dispatch through the CARDS map below rather than a
// branch each; adding a sixth game is one entry there plus its <script> tag in
// index.html. simpleCardHTML() survives only as the graceful fallback for
// lists saved before the trackers existed.

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

// list reading-view state
let LST = null;              // the current list object (never set while T is)
let listTracking = false;    // tap-pips shown/hidden (reference mode default)
let collapsedAll = false;    // remember collapse-all across redraws

// which game a card belongs to (table or list, whichever is open)
const curGame = () => (T ? T.game : LST ? LST.game : null);

// ---- per-game card modules -------------------------------------------------
//
// One entry per tracker game. `mod` is looked up lazily so a blocked script
// degrades to the simple fallback card instead of throwing, and `fits` checks
// the unit actually carries that tracker's snapshot shape — a list saved
// before the trackers existed still holds simple cards and must not be fed to
// a card that expects tracker state.
const CARDS = {
  necromunda: {
    mod: () => window.NecromundaCard,
    fits: (u) => u && u.condition !== undefined && u.statline && !Array.isArray(u.statline),
  },
  mcp: {
    mod: () => window.McpCard,
    fits: (u) => u && u.side !== undefined && u.stamina && typeof u.stamina === 'object',
  },
  bloodbowl: {
    mod: () => window.BloodBowlCard,
    fits: (u) => u && u.events && typeof u.events === 'object' && u.state !== undefined,
  },
  trenchcrusade: {
    mod: () => window.TrenchCrusadeCard,
    fits: (u) => u && u.bloodMarkers !== undefined && u.state !== undefined,
  },
};

// The card module for the open table/list, or null (unknown game, or the
// script did not load).
const cardMod = (game) => (CARDS[game] ? CARDS[game].mod() || null : null);

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
  // My Lists is the lobby's first citizen — the solo reference library.
  let myLists = [];
  try { myLists = (await api('/lists')).lists || []; } catch { /* fresh account / hiccup */ }
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

  // Group the list library by game system so "my Custodes" and "my lance"
  // never mix on the shelf.
  const byGame = new Map();
  for (const l of myLists) {
    if (!byGame.has(l.gameName)) byGame.set(l.gameName, []);
    byGame.get(l.gameName).push(l);
  }
  const listLibrary = myLists.length
    ? [...byGame.entries()].map(([gameName, ls]) => `
        <h3 class="list-group">${esc(gameName)}</h3>
        <div class="card-grid">
          ${ls.map((l) => `
            <div class="card tbl-card list-card" data-openlist="${l.id}">
              <h3>${esc(l.name)}</h3>
              <div class="meta">${l.units} unit${l.units === 1 ? '' : 's'}${l.faction ? ' • ' + esc(l.faction) : ''}${l.detachment ? ' • ' + esc(l.detachment) : ''}</div>
              <div class="meta">updated ${new Date(l.updated).toLocaleDateString()}</div>
            </div>`).join('')}
        </div>`).join('')
    : '<p class="muted">No lists yet — save one an\' yer units\' stats, abilities an\' army rules are always a tap away at da table.</p>';

  // My Lists leads (the solo reference library IS the point of the iPad),
  // then the shared live tracker below it.
  $app.innerHTML = `
    <h1>Game Night</h1>
    <div class="sub">Yer lists at da table — an' da live tracker beside 'em</div>

    <div class="lists-head">
      <h2>My Lists</h2>
      <a class="btn" href="#/lists/new">+ New List</a>
    </div>
    ${listLibrary}

    <div class="lobby-top" style="margin-top:26px">
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
  $app.querySelectorAll('[data-openlist]').forEach((el) => {
    el.onclick = () => { location.hash = '#/l/' + el.dataset.openlist; };
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
  // wh40k sides take a pasted army list (resolved before the table opens),
  // the paste games take their builder's text export, and Blood Bowl picks a
  // drafted league team (with a pasted roster as the fallback). Every one of
  // them may be left empty — the joiner fills it at the table.
  const sideRow = (name, preselect) => {
    const game = $game.value;
    const nameInput = `<input class="s-name" maxlength="40" placeholder="Side ${$sides.children.length + 1}" value="${esc(name)}">`;
    const rm = '<span class="rm" title="remove side">✕</span>';
    const div = document.createElement('div');
    div.className = 'side-row' + (game === 'wh40k' || CARDS[game] ? ' side-row-40k' : '');
    if (game === 'wh40k') {
      div.innerHTML = `${nameInput}${rm}
         <textarea class="s-army" rows="3" placeholder="paste an army list here (GW app / BattleScribe / New Recruit) — or leave empty an' add it at da table"></textarea>`;
    } else if (game === 'bloodbowl') {
      div.innerHTML = `${nameInput}${rm}
         <select class="s-bbteam" style="grid-column:1/-1"><option value="">— loading league teams —</option></select>
         <textarea class="s-text" rows="2" placeholder="…or paste a roster: one player per line (&quot;7 Grak, Blitzer&quot;)"></textarea>`;
      fillBbTeamSelects([div.querySelector('.s-bbteam')]);
    } else if (CARDS[game]) {
      div.innerHTML = `${nameInput}${rm}
         <textarea class="s-text" rows="3" placeholder="${esc(PASTE_HINTS[game] || 'paste yer list here')}"></textarea>`;
    } else {
      div.innerHTML = `${nameInput}
         <select class="s-force" title="attach one o' MY saved forces">${forceOpts(preselect)}</select>
         ${rm}`;
    }
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
    const sides = rows.map((r, i) => {
      const bbPick = (r.querySelector('.s-bbteam')?.value || '').split(':');
      return {
        name: r.querySelector('.s-name').value.trim() || `Side ${i + 1}`,
        forceName: r.querySelector('.s-force')?.value || undefined,
        armyText: r.querySelector('.s-army')?.value.trim() || undefined,
        text: r.querySelector('.s-text')?.value.trim() || undefined,
        leagueId: bbPick[0] || undefined,
        teamId: bbPick[1] || undefined,
      };
    });
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
        body: JSON.stringify({
          game,
          name,
          sides: sides.map((s) => (CARDS[game]
            ? { name: s.name, text: s.text, leagueId: s.leagueId, teamId: s.teamId }
            : { name: s.name, forceName: s.forceName })),
        }),
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

// ============================================================================
// My Lists — add-list flow + the reading view
// ============================================================================

// Games whose list source is a plain text paste: /lists/resolve answers with a
// parse preview (what parsed, what didn't) rather than a unit-picker. This is
// about where the list COMES FROM, not about which card renders it.
const isPasteGame = (game) => Boolean(CARDS[game]);

const PASTE_HINTS = {
  'battletech-as': 'paste a list — one unit per line, any builder\'s export ("Atlas AS7-D (4)", "2x Locust LCT-1V")',
  'battletech-classic': 'paste a list — one \'Mech per line ("Atlas AS7-D G3/P4")',
  wh40k: 'paste an army list (GW app / BattleScribe / New Recruit) — da detachment line comes along for free',
  necromunda: 'paste da text export from our Necromunda gang builder (Export → Copy text)',
  mcp: 'paste da text export from our Crisis Protocol roster builder (Text → Copy)',
  trenchcrusade: 'paste da text export from our Trench Crusade warband builder (Export → Copy text)',
  bloodbowl: 'paste a roster — one player per line ("7 Grak, Blitzer") — or pick a league team on da table screen',
};

// ---- add-list flow ----
async function viewNewList() {
  const games = await api('/list-games');
  let forces = [];
  try { forces = (await api('/builders/forces')).forces || []; } catch { /* db down / none saved */ }
  forces.sort((a, b) => (b.updated || 0) - (a.updated || 0));

  $app.innerHTML = `
    <div class="crumb"><a href="#/">Game Night</a> / new list</div>
    <h1>New List</h1>
    <div class="sub">Save a list once — read yer stats, abilities an' army rules at any table</div>
    <div class="card">
      <div class="form-grid">
        <label>Game <select id="nl-game">${games.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select></label>
        <label>List name <input id="nl-name" maxlength="60" placeholder="Tuesday Custodes"></label>
      </div>
      <div id="nl-src"></div>
      <div class="error" id="nl-err"></div>
    </div>
    <div id="nl-result"></div>`;

  const $game = $app.querySelector('#nl-game');
  const $src = $app.querySelector('#nl-src');
  const $err = $app.querySelector('#nl-err');
  const listName = () => $app.querySelector('#nl-name').value.trim();

  const renderSource = () => {
    const game = $game.value;
    const paste = `
      <textarea id="nl-paste" rows="8" class="claim-army" placeholder="${esc(PASTE_HINTS[game] || 'paste yer list here')}"></textarea>
      <div style="margin-top:10px"><button class="btn" id="nl-check">Check da List</button></div>`;
    if (isBattletech(game)) {
      $src.innerHTML = `
        <h3 class="nl-h3">From a saved force</h3>
        <div class="join-row">
          <select id="nl-force" style="min-width:220px"><option value="">— pick a saved force —</option>
            ${forces.map((f) => `<option value="${esc(f.name)}">${esc(f.name)}${f.totalPV != null ? ` (${f.totalPV} PV)` : ''}</option>`).join('')}
          </select>
          <button class="btn" id="nl-fromforce">Save List</button>
        </div>
        <h3 class="nl-h3">…or paste a list from any builder</h3>
        ${paste}`;
      $src.querySelector('#nl-fromforce').onclick = async () => {
        $err.textContent = '';
        const forceName = $src.querySelector('#nl-force').value;
        if (!forceName) { $err.textContent = 'Pick a saved force first.'; return; }
        if (!listName()) { $err.textContent = 'Give da list a name first.'; return; }
        try {
          const l = await api('/lists', { method: 'POST', body: JSON.stringify({ game, name: listName(), forceName }) });
          location.hash = '#/l/' + l.id;
        } catch (e) { $err.textContent = e.message; }
      };
    } else {
      $src.innerHTML = `<h3 class="nl-h3">Paste yer list</h3>${paste}`;
    }
    $src.querySelector('#nl-check').onclick = async () => {
      $err.textContent = '';
      const text = $src.querySelector('#nl-paste').value.trim();
      if (!text) { $err.textContent = 'Paste a list first.'; return; }
      if (!listName()) { $err.textContent = 'Give da list a name first.'; return; }
      try {
        const resolve = await api('/lists/resolve', { method: 'POST', body: JSON.stringify({ game, text }) });
        if (game === 'wh40k') render40kListResolve(game, listName(), resolve);
        else if (isPasteGame(game)) renderSimpleListPreview(game, listName(), text, resolve);
        else renderBtListResolve(game, listName(), resolve);
      } catch (e) { $err.textContent = e.message; }
    };
  };
  renderSource();
  $game.onchange = renderSource;
}

// ---- battletech paste resolve: pick the right unit, set skills, save ----
function renderBtListResolve(game, name, resolve) {
  const classic = game === 'battletech-classic';
  const $out = $app.querySelector('#nl-result');
  $out.innerHTML = `
    <h2>Check da Units</h2>
    <div class="card">
      ${resolve.units.map((u, ui) => `
        <div class="rs-row">
          <span class="rs-line" title="${esc(u.line)}">${esc(u.parsedName)}${u.count > 1 ? ` ×${u.count}` : ''}</span>
          <select class="rs-pick" data-unit="${ui}">
            ${u.matches.map((m, mi) => `<option value="${mi}"${mi === 0 ? ' selected' : ''}>${esc(m.name)}${classic ? (m.bv != null ? ` (BV ${m.bv})` : '') : (m.pv != null ? ` (${m.pv} PV)` : '')}</option>`).join('')}
            <option value="-1">— drop dis line —</option>
          </select>
          ${classic
            ? `<label class="rs-models">G <input type="number" min="0" max="8" class="rs-gun" data-unit="${ui}" value="${u.gunnery ?? 4}"></label>
               <label class="rs-models">P <input type="number" min="0" max="8" class="rs-pil" data-unit="${ui}" value="${u.piloting ?? 5}"></label>`
            : `<label class="rs-models">skill <input type="number" min="0" max="8" class="rs-skill" data-unit="${ui}" value="${u.skill ?? 4}"></label>`}
          ${u.ambiguous ? '<span class="tag" style="color:var(--rust)">ambiguous</span>' : ''}
        </div>`).join('') || '<p class="muted">No units matched in dat paste.</p>'}
      ${resolve.unmatched.length ? `
        <div class="rs-unmatched">
          <b>Not matched (dropped):</b>
          ${resolve.unmatched.map((x) => `<div class="muted">${esc(x.line)}</div>`).join('')}
        </div>` : ''}
      <div style="margin-top:14px"><button class="btn big" id="nl-save">Save List</button></div>
      <div class="error" id="nl-err2"></div>
    </div>`;
  $out.querySelector('#nl-save').onclick = async () => {
    const units = [];
    resolve.units.forEach((u, ui) => {
      const pick = +$out.querySelector(`.rs-pick[data-unit="${ui}"]`).value;
      if (pick < 0 || !u.matches[pick]) return;
      const entry = { id: u.matches[pick].id };
      if (classic) {
        entry.gunnery = +$out.querySelector(`.rs-gun[data-unit="${ui}"]`).value;
        entry.piloting = +$out.querySelector(`.rs-pil[data-unit="${ui}"]`).value;
        entry.skill = 4;
      } else {
        entry.skill = +$out.querySelector(`.rs-skill[data-unit="${ui}"]`).value;
      }
      for (let n = 0; n < Math.min(u.count || 1, 10); n++) units.push({ ...entry });
    });
    try {
      const l = await api('/lists', { method: 'POST', body: JSON.stringify({ game, name, units }) });
      location.hash = '#/l/' + l.id;
    } catch (e) { $out.querySelector('#nl-err2').textContent = e.message; }
  };
  $out.scrollIntoView({ behavior: 'smooth' });
}

// ---- wh40k paste resolve: units + detachment (detected or picked), save ----
function render40kListResolve(game, name, resolve) {
  const $out = $app.querySelector('#nl-result');
  const candidates = resolve.detachmentCandidates || [];
  const detected = resolve.detachment?.matches?.[0] || null;
  $out.innerHTML = `
    <h2>Check da List</h2>
    <div class="card">
      ${resolve.faction ? `<div class="u-line"><b>Faction:</b> ${esc(resolve.faction.name)}</div>` : ''}
      <div class="rs-row">
        <span class="rs-line">Detachment${detected ? ' (detected from da paste)' : ''}</span>
        <select class="rs-pick" id="nl-det">
          <option value="">— no detachment —</option>
          ${candidates.map((d) => `<option value="${d.id}"${detected && d.id === detected.id ? ' selected' : ''}>${esc(d.name)}</option>`).join('')}
          ${detected && !candidates.some((d) => d.id === detected.id)
            ? `<option value="${detected.id}" selected>${esc(detected.name)}</option>` : ''}
        </select>
      </div>
      ${resolve.units.map((u, ui) => `
        <div class="rs-row">
          <span class="rs-line" title="${esc(u.line)}">${esc(u.parsedName)}${u.count > 1 ? ` ×${u.count}` : ''}</span>
          <select class="rs-pick" data-unit="${ui}">
            ${u.matches.map((m, mi) => `<option value="${mi}"${mi === 0 ? ' selected' : ''}>${esc(m.name)} (${esc(m.factionId)})</option>`).join('')}
            <option value="-1">— drop dis line —</option>
          </select>
          <label class="rs-models">models <input type="number" min="1" max="30" placeholder="auto" data-unit="${ui}" class="rs-count"></label>
          ${u.ambiguous ? '<span class="tag" style="color:var(--rust)">ambiguous</span>' : ''}
        </div>`).join('') || '<p class="muted">No units matched in dat paste.</p>'}
      ${resolve.unmatched.length ? `
        <div class="rs-unmatched">
          <b>Not matched (dropped):</b>
          ${resolve.unmatched.map((x) => `<div class="muted">${esc(x.line)}</div>`).join('')}
        </div>` : ''}
      <div style="margin-top:14px"><button class="btn big" id="nl-save">Save List</button></div>
      <div class="error" id="nl-err2"></div>
    </div>`;
  $out.querySelector('#nl-save').onclick = async () => {
    const army = [];
    resolve.units.forEach((u, ui) => {
      const pick = +$out.querySelector(`.rs-pick[data-unit="${ui}"]`).value;
      if (pick < 0 || !u.matches[pick]) return;
      const modelsRaw = $out.querySelector(`.rs-count[data-unit="${ui}"]`).value;
      const models = modelsRaw === '' ? undefined : Math.min(Math.max(+modelsRaw || 1, 1), 30);
      for (let n = 0; n < Math.min(u.count || 1, 10); n++) army.push({ id: u.matches[pick].id, models });
    });
    const detachmentId = $out.querySelector('#nl-det').value || undefined;
    try {
      const l = await api('/lists', { method: 'POST', body: JSON.stringify({ game, name, army, detachmentId }) });
      location.hash = '#/l/' + l.id;
    } catch (e) { $out.querySelector('#nl-err2').textContent = e.message; }
  };
  $out.scrollIntoView({ behavior: 'smooth' });
}

// ---- paste-only games: parse preview with honest coverage, then save ----
function renderSimpleListPreview(game, name, text, resolve) {
  const $out = $app.querySelector('#nl-result');
  $out.innerHTML = `
    <h2>Check da Parse</h2>
    <div class="card">
      ${(resolve.header || []).length ? `<div class="u-line muted">${resolve.header.map(esc).join(' • ')}</div>` : ''}
      ${resolve.units.map((u) => `
        <div class="rs-row">
          <span class="rs-line">${esc(u.name)}</span>
          <span class="muted">${esc(u.subtitle || '')}${u.cost ? ' • ' + esc(u.cost) : ''}${u.statlines?.length ? '' : ' • no statline parsed'}</span>
        </div>`).join('') || '<p class="muted">No units parsed — is dat da builder\'s text export?</p>'}
      ${(resolve.unparsed || []).length ? `
        <div class="rs-unmatched">
          <b>Lines dat didn't parse (kept out):</b>
          ${resolve.unparsed.map((x) => `<div class="muted">${esc(x)}</div>`).join('')}
        </div>` : ''}
      ${resolve.units.length ? '<div style="margin-top:14px"><button class="btn big" id="nl-save">Save List</button></div>' : ''}
      <div class="error" id="nl-err2"></div>
    </div>`;
  const save = $out.querySelector('#nl-save');
  if (save) {
    save.onclick = async () => {
      try {
        const l = await api('/lists', { method: 'POST', body: JSON.stringify({ game, name, text }) });
        location.hash = '#/l/' + l.id;
      } catch (e) { $out.querySelector('#nl-err2').textContent = e.message; }
    };
  }
  $out.scrollIntoView({ behavior: 'smooth' });
}

// ---- the reading view ----

// One-line key stat for a collapsed card, per game.
function listKeyStat(u) {
  const game = curGame();
  if (game === 'battletech-as') return `SK ${u.skill} • PV ${u.pv}`;
  if (game === 'battletech-classic') {
    return `${u.sheet?.mass != null ? u.sheet.mass + 't • ' : ''}G${u.gunnery}/P${u.piloting}${u.bv != null ? ' • BV ' + u.bv : ''}`;
  }
  if (game === 'wh40k') {
    const m = u.statline?.[0];
    return m ? `T${m.t} • Sv${m.sv} • ${u.modelCount}×${u.woundsPer}W` : `${u.modelCount} models`;
  }
  // The tracker games keep their headline stat in different places.
  if (game === 'necromunda') return [u.type, u.cost].filter(Boolean).join(' • ');
  if (game === 'mcp') return u.threat ? `${u.threat} threat` : '';
  if (game === 'bloodbowl') return [u.number != null ? `#${u.number}` : '', u.position].filter(Boolean).join(' • ');
  if (game === 'trenchcrusade') return [u.catalogName, u.cost].filter(Boolean).join(' • ');
  return u.cost || u.subtitle || '';
}

function listUnitShell(u) {
  return `
  <div class="lst-unit${collapsedAll ? ' collapsed' : ''}${u.destroyed ? ' unit-down' : ''}" data-lunit="${u.uid}" data-name="${esc(String(u.name).toLowerCase())}">
    <button class="lst-head" data-collapse="${u.uid}">
      <span class="lst-caret"></span>
      <span class="lst-head-name">${esc(u.name)}</span>
      <span class="lst-head-stat">${esc(listKeyStat(u))}</span>
    </button>
    <div class="lst-body">${cardHTML(u)}</div>
  </div>`;
}

// Sanitizer for rules text: reuse the 40k card's (Wahapedia HTML), fall back
// to plain-text escaping if that script didn't load.
const ruleHTML = (html) => (window.W40kCard ? W40kCard.sanitize(html) : esc(html));

function stratBlock(s) {
  return `
    <div class="strat">
      <div class="strat-top">
        <span class="strat-name">${esc(s.name)}</span>
        <span class="strat-cost">${esc(s.cost)}CP</span>
      </div>
      <div class="strat-meta">${esc([s.turn, s.phase].filter(Boolean).join(' • '))}</div>
      <div class="strat-body">${ruleHTML(s.description)}</div>
    </div>`;
}

function armyPanelHTML(l) {
  const a = l.army;
  if (!a) return '';
  if (l.game === 'wh40k') {
    const sec = (title, open, body) => body
      ? `<details class="army-sec"${open ? ' open' : ''}><summary class="sec-title">${title}</summary><div class="army-sec-body">${body}</div></details>`
      : '';
    return `
    <div class="card army-panel">
      <h2 style="margin-top:0">Army Rules${a.factionName ? ` — ${esc(a.factionName)}` : ''}${a.detachment ? ` <span class="tag">${esc(a.detachment.name)}</span>` : ''}</h2>
      ${a.error ? `<p class="error">Army rules lookup failed when dis list was saved — datasheets only.</p>` : ''}
      ${sec('Army Rule', true, (a.armyRules || []).map((r) => `
        <div class="rule-block"><div class="rule-name">${esc(r.name)}</div>${ruleHTML(r.description)}</div>`).join(''))}
      ${a.detachment ? sec(`Detachment — ${esc(a.detachment.name)}`, true, (a.detachment.rules || []).map((r) => `
        <div class="rule-block"><div class="rule-name">${esc(r.name)}</div>${ruleHTML(r.description)}</div>`).join('')) : ''}
      ${sec(`Stratagems (${(a.stratagems || []).length})`, true, (a.stratagems || []).map(stratBlock).join(''))}
      ${sec(`Enhancements (${(a.enhancements || []).length})`, false, (a.enhancements || []).map((e) => `
        <div class="rule-block"><div class="rule-name">${esc(e.name)} <span class="strat-cost">${esc(e.cost)} pts</span></div>${ruleHTML(e.description)}</div>`).join(''))}
      ${sec(`Core Stratagems (${(a.coreStratagems || []).length})`, false, (a.coreStratagems || []).map(stratBlock).join(''))}
    </div>`;
  }
  // paste-only games: the export's header block + reference sections
  const bits = [];
  if ((a.header || []).length) bits.push(a.header.map((h) => `<div class="u-line">${esc(h)}</div>`).join(''));
  for (const s of a.sections || []) {
    bits.push(`<div class="rule-block"><div class="rule-name">${esc(s.title)}</div>${s.items.map((i) => `<div class="u-line">${esc(i)}</div>`).join('')}</div>`);
  }
  if ((a.unparsed || []).length) {
    bits.push(`<details class="army-sec"><summary class="sec-title">Lines dat didn't parse (${a.unparsed.length})</summary><div class="army-sec-body">${a.unparsed.map((x) => `<div class="muted">${esc(x)}</div>`).join('')}</div></details>`);
  }
  return bits.length ? `<div class="card army-panel">${bits.join('')}</div>` : '';
}

function renderListView() {
  const l = LST;
  const gameName = ({ 'battletech-as': 'BattleTech — Alpha Strike', 'battletech-classic': 'BattleTech — Classic', wh40k: 'Warhammer 40k', necromunda: 'Necromunda', mcp: 'Marvel Crisis Protocol', bloodbowl: 'Blood Bowl', trenchcrusade: 'Trench Crusade' })[l.game] || l.game;
  $app.innerHTML = `
    <div class="crumb"><a href="#/">Game Night</a> / ${esc(l.name)}</div>
    <div class="play-head list-head">
      <h1>${esc(l.name)}</h1>
      <span class="tag">${esc(gameName)}</span>
      <input id="l-search" type="search" placeholder="filter units…" autocomplete="off">
      <span class="list-actions">
        <button class="btn ghost small" id="l-track">${listTracking ? 'Tracking: ON' : 'Tracking: OFF'}</button>
        <button class="btn ghost small" id="l-collapse">${collapsedAll ? 'Expand all' : 'Collapse all'}</button>
      </span>
    </div>
    <div class="error" id="p-err"></div>
    ${armyPanelHTML(l)}
    <div class="list-grid${listTracking ? '' : ' ref-mode'}" id="list-grid">
      ${l.units.map(listUnitShell).join('') || '<p class="muted">Dis list is empty.</p>'}
    </div>
    <div class="list-foot">
      <button class="btn ghost small" id="l-reset">Reset damage</button>
      <button class="btn ghost small danger-btn" id="l-delete">Delete list</button>
    </div>`;

  // live name filter — pure DOM, works offline
  $app.querySelector('#l-search').oninput = (ev) => {
    const q = ev.target.value.trim().toLowerCase();
    $app.querySelectorAll('.lst-unit').forEach((el) => {
      el.classList.toggle('filtered-out', Boolean(q) && !el.dataset.name.includes(q));
    });
  };
  $app.querySelector('#l-track').onclick = () => {
    listTracking = !listTracking;
    const grid = $app.querySelector('#list-grid');
    if (grid) grid.classList.toggle('ref-mode', !listTracking);
    $app.querySelector('#l-track').textContent = listTracking ? 'Tracking: ON' : 'Tracking: OFF';
  };
  $app.querySelector('#l-collapse').onclick = () => {
    collapsedAll = !collapsedAll;
    $app.querySelectorAll('.lst-unit').forEach((el) => el.classList.toggle('collapsed', collapsedAll));
    $app.querySelector('#l-collapse').textContent = collapsedAll ? 'Expand all' : 'Collapse all';
  };
  $app.querySelector('#l-reset').onclick = async () => {
    if (!confirm('Clear all damage trackin\' on dis list?')) return;
    try {
      LST = await api(`/lists/${l.id}/reset`, { method: 'POST' });
      undoStacks.clear();
      renderListView();
    } catch (e) { playErr(e.message); }
  };
  $app.querySelector('#l-delete').onclick = async () => {
    if (!confirm(`Delete "${l.name}" for good?`)) return;
    try {
      await api(`/lists/${l.id}`, { method: 'DELETE' });
      location.hash = '#/';
    } catch (e) { playErr(e.message); }
  };
}

async function viewList(id) {
  try {
    LST = await api('/lists/' + id);
  } catch (e) {
    $app.innerHTML = `<h1>Game Night</h1><div class="card"><p class="error">${esc(e.message)}</p><a class="btn ghost" href="#/">Back to da lobby</a></div>`;
    return;
  }
  undoStacks.clear();
  renderListView();
}

// ---- play screen ----

function unitByUid(uid) {
  if (LST) return LST.units.find((x) => x.uid === uid) || null;
  if (!T) return null;
  for (const s of T.sides) {
    const u = s.units.find((x) => x.uid === uid);
    if (u) return u;
  }
  return null;
}

// MCP's optimistic mirror of server/tracker-mcp.js. That card module exposes
// no applyLocal, so the handful of fields it emits are mirrored here —
// including the daze flip, which is the whole point of the card.
function mcpLocal(u, field, value) {
  const setSide = (s) => {
    u.side = s;
    u.damage = s === 'ko' ? ((u.stamina && u.stamina.injured) || 0) : 0;
    u.destroyed = s === 'ko';
  };
  if (field === 'damage') {
    const max = (u.side === 'injured' ? u.stamina.injured : u.stamina.healthy) || 0;
    if (value < max) { u.damage = value; return true; }
    setSide(u.side === 'healthy' ? 'injured' : 'ko');
    return true;
  }
  if (field === 'side') {
    const s = typeof value === 'number' ? ['healthy', 'injured', 'ko'][value] : String(value);
    if (['healthy', 'injured', 'ko'].includes(s)) setSide(s);
    return true;
  }
  if (field === 'power') { u.power = value; return true; }
  if (field.startsWith('effect.')) {
    const k = field.slice(7);
    if (!u.effects || typeof u.effects !== 'object') u.effects = {};
    if (value) u.effects[k] = true; else delete u.effects[k];
    return true;
  }
  if (field === 'holdingObjective') { u.holdingObjective = Boolean(value); return true; }
  if (field === 'destroyed') {
    if (value) setSide('ko');
    else if (u.side === 'ko') setSide('injured');
    else u.destroyed = false;
    return true;
  }
  return false;
}

// Blood Bowl's optimistic mirror of server/tracker-bloodbowl.js. `casualty`
// and `sentOff` are the two states that take a player off the pitch for good,
// which is what `destroyed` means for the shared dimming / Wreck button.
const BB_OFF_PITCH = ['casualty', 'sentOff'];
function bbLocal(u, field, value) {
  if (field === 'state') {
    u.state = String(value);
    u.destroyed = BB_OFF_PITCH.includes(u.state);
    return true;
  }
  if (field.startsWith('event.')) {
    if (!u.events || typeof u.events !== 'object') u.events = {};
    u.events[field.slice(6)] = value;
    return true;
  }
  if (field === 'mvp') { u.mvp = Boolean(value); return true; }
  if (field === 'destroyed') {
    u.destroyed = Boolean(value);
    if (u.destroyed && !BB_OFF_PITCH.includes(u.state)) u.state = 'casualty';
    if (!u.destroyed && BB_OFF_PITCH.includes(u.state)) u.state = 'ready';
    return true;
  }
  return false;
}

// Mirror of the server's per-field rules so optimistic taps land on legal
// values; the server remains the referee.
//
// Tracker games delegate: Necromunda and Trench Crusade ship their own
// applyLocal (they own the rules that keep `destroyed` honest), MCP and Blood
// Bowl are mirrored above, and notes/destroyed/legacy wounds fall through.
function applyLocal(u, field, value) {
  const g = curGame();
  if (CARDS[g]) {
    const mod = cardMod(g);
    if (mod && typeof mod.applyLocal === 'function' && mod.applyLocal(u, field, value) !== false) return;
    if (g === 'mcp' && mcpLocal(u, field, value)) return;
    if (g === 'bloodbowl' && bbLocal(u, field, value)) return;
    if (field === 'notes') { u.notes = value; return; }
    if (field === 'destroyed') { u.destroyed = Boolean(value); return; }
    if (field === 'woundsTaken') {                 // legacy simple-card list
      u.woundsTaken = value;
      u.destroyed = u.maxWounds != null && value >= u.maxWounds;
    }
    return;
  }
  applyLocalBt(u, field, value);
}

// BattleTech (Alpha Strike + Classic) and 40k fields.
function applyLocalBt(u, field, value) {
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
  else if (field === 'woundsTaken') {
    u.woundsTaken = value;
    u.destroyed = u.maxWounds != null && value >= u.maxWounds;
  } else if (field.startsWith('crits.')) u.crits[field.slice(6)] = value;

  const game = curGame();
  if (game === 'battletech-as' && (field === 'structHit' || field === 'crits.engine')) {
    u.destroyed = u.structHit >= u.maxStruct || u.crits.engine >= 2;
  }
  if (game === 'battletech-classic' && window.ClassicCard
    && (field.startsWith('structHit.') || field.startsWith('crit.') || field === 'pilotHits')) {
    u.destroyed = ClassicCard.autoDestroyed(u);
  }
}

function readField(u, field) {
  const g = curGame();
  if (CARDS[g]) {
    const mod = cardMod(g);
    if (mod && typeof mod.readField === 'function') {
      const v = mod.readField(u, field);
      if (v !== undefined) return v;
    }
    // The fields MCP's and Blood Bowl's cards emit that are not plain keys.
    if (field.startsWith('effect.')) return Boolean((u.effects || {})[field.slice(7)]);
    if (field.startsWith('event.')) return (u.events || {})[field.slice(6)] || 0;
    return u[field];
  }
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

// One optimistic patch path for lists (solo — POST /api/lists/:id/track).
async function patchList(uid, field, value, { undoable = true } = {}) {
  const u = unitByUid(uid);
  if (!u || !LST) return;
  const prev = readField(u, field);
  if (undoable) {
    const stack = undoStacks.get(uid) || [];
    stack.push({ field, prev });
    undoStacks.set(uid, stack.slice(-20));
  }
  applyLocal(u, field, value);
  redrawCard(uid);
  try {
    await api(`/lists/${LST.id}/track`, { method: 'POST', body: JSON.stringify({ uid, field, value }) });
  } catch (e) {
    if (undoable) (undoStacks.get(uid) || []).pop();
    applyLocal(u, field, prev);
    redrawCard(uid);
    playErr(e.message);
  }
}

async function patch(uid, field, value, { undoable = true } = {}) {
  if (LST) return patchList(uid, field, value, { undoable });
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

// Side-level trackers (wh40k CP/VP, the tracker games' VP, Necromunda's
// bottle switch). Optimistic, no undo stack — the +/- buttons are their own
// undo, and the bottle chip toggles back.
async function patchSide(sideIdx, field, value) {
  const s = T.sides[sideIdx];
  if (!s) return;
  const prev = s[field];
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

// ---- Blood Bowl match state (half / turn / score / rerolls / weather) ------
//
// The only table-level state any game keeps beyond the round counter. Patched
// as "<field>" or "<field>.<sideIdx>" (see server/tracker-bloodbowl.js
// MATCH_FIELDS); the route answers with the whole match object, and the socket
// echo repaints every other phone.
function matchField(field, side) {
  return side === null || side === undefined || side === '' ? field : `${field}.${side}`;
}

function redrawMatchBar() {
  const el = document.querySelector('.bb-matchbar');
  if (!el || !window.BloodBowlCard) return;
  const html = BloodBowlCard.matchBarHtml(T.match, T.sides, T.status);
  if (html) el.outerHTML = html;
}

async function patchMatch(field, side, value, { redraw = true } = {}) {
  if (!T || !T.match) return;
  const key = matchField(field, side);
  const before = JSON.stringify(T.match);
  // optimistic: half/turn resets are the server's business, so this only
  // writes the tapped cell and lets the response reconcile the rest.
  if (Array.isArray(T.match[field])) T.match[field][+side] = value;
  else T.match[field] = value;
  if (redraw) redrawMatchBar();
  try {
    const r = await api(`/table/${T.id}/state`, { method: 'POST', body: JSON.stringify({ field: key, value }) });
    if (r && r.match) { T.match = r.match; redrawMatchBar(); }
  } catch (e) {
    T.match = JSON.parse(before);
    redrawMatchBar();
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
    <div class="u-line">MV <b>${esc(u.move ?? '?')}</b> • TMM <b>${u.tmm ?? '?'}</b> • DMG <b>${esc(dmg)}</b>${u.overheat ? ` • OV <b>${u.overheat}</b>` : ''}<span class="ref-stat"> • A <b>${u.maxArmor}</b> • S <b>${u.maxStruct}</b></span></div>
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

// Simple stat card for the paste-only list games (necromunda / mcp /
// trenchcrusade): statline + gear + abilities as text, one optional wound
// track. Same data-uid/data-field wiring as every other card.
function simpleCardHTML(u) {
  const canUndo = (undoStacks.get(u.uid) || []).length > 0;
  return `
  <div class="unit-card simple-card${u.destroyed ? ' destroyed' : ''}" data-card="${u.uid}">
    ${u.destroyed ? '<span class="wreck-badge">Down</span>' : ''}
    <div class="u-top">
      <span class="u-name">${esc(u.name)}</span>
      ${u.cost ? `<span class="u-pv">${esc(u.cost)}</span>` : ''}
    </div>
    ${u.subtitle ? `<div class="u-line">${esc(u.subtitle)}</div>` : ''}
    ${(u.statlines || []).map((s) => `<div class="u-line statline-txt"><b>${esc(s)}</b></div>`).join('')}
    ${u.maxWounds ? `<div class="pip-row"><span class="plabel">Wounds</span>${pips(u, 'woundsTaken', u.maxWounds, u.woundsTaken || 0, 'wound')}</div>` : ''}
    ${(u.gear || []).length ? `<div class="u-line"><b>Gear:</b> ${esc(u.gear.join(', '))}</div>` : ''}
    ${(u.gearProfiles || []).length ? `
      <div class="sheet-sec"><div class="sec-title">Weapon profiles</div>
        ${u.gearProfiles.map((p) => `<div class="u-line profile-txt">${esc(p)}</div>`).join('')}
      </div>` : ''}
    ${(u.abilities || []).length ? `
      <div class="sheet-sec"><div class="sec-title">Abilities</div>
        ${u.abilities.map((a) => `<div class="u-line ability-txt"><b>${esc(a.name)}:</b> ${esc(a.text)}</div>`).join('')}
      </div>` : ''}
    ${(u.keywords || []).length ? `<div class="kw-line"><b>Keywords:</b> ${esc(u.keywords.join(', '))}</div>` : ''}
    <div class="u-foot">
      <input class="notes" data-uid="${u.uid}" maxlength="200" placeholder="notes…" value="${esc(u.notes)}">
      <button class="ubtn" data-undo="${u.uid}" ${canUndo ? '' : 'disabled'}>↩ Undo</button>
      <button class="ubtn danger" data-wreck="${u.uid}">${u.destroyed ? 'Revive' : 'Down'}</button>
    </div>
  </div>`;
}

function cardHTML(u) {
  const canUndo = (undoStacks.get(u.uid) || []).length > 0;
  const game = curGame();
  // Lists render classic cards with 'setup' status so crew skills stay
  // editable — it's your own list, not a locked live game.
  if (game === 'battletech-classic' && window.ClassicCard) return ClassicCard.html(u, T ? T.status : 'setup', canUndo);
  if (game === 'wh40k' && window.W40kCard) return W40kCard.html(u, canUndo);
  if (CARDS[game]) {
    const mod = cardMod(game);
    // Legacy simple-shaped units (and a card script that failed to load) fall
    // back rather than rendering a broken card.
    if (mod && CARDS[game].fits(u)) return mod.html(u, T ? T.status : 'setup', canUndo);
    return simpleCardHTML(u);
  }
  return asCardHTML(u);
}

function redrawCard(uid) {
  const u = unitByUid(uid);
  const el = document.querySelector(`[data-card="${uid}"]`);
  if (u && el) el.outerHTML = cardHTML(u);
  if (LST) {
    // keep the collapsed one-line header honest about a downed unit
    const wrap = document.querySelector(`.lst-unit[data-lunit="${uid}"]`);
    if (wrap && u) wrap.classList.toggle('unit-down', Boolean(u.destroyed));
    return;
  }
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

// Repaint the whole tracker strip: the CP/VP numbers, and Necromunda's bottle
// chip, which changes shape (holding / test / bottled) rather than just text.
function redrawSideTrackers(i) {
  const el = document.getElementById(`side-track-${i}`);
  if (el) { el.innerHTML = sideTrackersHTML(T.sides[i], i); return; }
  const cp = document.getElementById(`cp-num-${i}`);
  const vp = document.getElementById(`vp-num-${i}`);
  if (cp) cp.textContent = T.sides[i].cp || 0;
  if (vp) vp.textContent = T.sides[i].vp || 0;
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
  if (CARDS[T.game]) {
    // The tracker games carry no points total on the snapshot — what the table
    // wants to see is how many models are still up.
    const what = T.game === 'bloodbowl' ? 'on da pitch' : 'standing';
    return `${s.owner ? s.owner + ' • ' : ''}${alive}/${s.units.length} ${what}`;
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
      T.sides[p.side].bottled = p.sideState.bottled;
      redrawSideTrackers(p.side);
    }
    // Blood Bowl match state (half / turn / score / rerolls / weather).
    if (p.match) { T.match = p.match; redrawMatchBar(); }
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
  if (T.game === 'bloodbowl') {
    return `
      <div class="card claim-card">
        <p class="muted">No team on dis side — bring one o' yer league teams, or paste a roster.</p>
        <div class="join-row" style="margin-top:8px">
          <select class="claim-bb" data-side="${i}" style="min-width:240px"><option value="">— loading league teams —</option></select>
          <button class="btn" data-claimbb="${i}">Take da Field</button>
        </div>
        <textarea class="claim-army" data-side="${i}" rows="3" placeholder="…or paste a roster: one player per line (&quot;7 Grak, Blitzer&quot;)"></textarea>
      </div>`;
  }
  if (CARDS[T.game]) {
    return `
      <div class="card claim-card">
        <p class="muted">No units on dis side — paste yer list from da <a href="/builders/">builder</a>'s text export.</p>
        <textarea class="claim-army" data-side="${i}" rows="4" placeholder="${esc(PASTE_HINTS[T.game] || 'paste yer list here')}"></textarea>
        <div style="margin-top:8px"><button class="btn" data-claimpaste="${i}">Deploy</button></div>
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

// Games with a hand-scored side tracker. CP stays wh40k-only; VP is shared by
// wh40k and the three tracker games that score objectives on the tabletop
// (Blood Bowl scores touchdowns on the match bar instead).
const SIDE_VP_GAMES = ['wh40k', 'necromunda', 'mcp', 'trenchcrusade'];

function sideTrackersHTML(s, i) {
  if (T.status === 'done' || !SIDE_VP_GAMES.includes(T.game)) return '';
  const cp = T.game === 'wh40k' ? `
    <span class="side-track">
      <span class="lbl">CP</span>
      <button class="rbtn sm" data-tside="${i}" data-tfield="cp" data-d="-1">−</button>
      <b id="cp-num-${i}">${s.cp || 0}</b>
      <button class="rbtn sm" data-tside="${i}" data-tfield="cp" data-d="1">+</button>
    </span>` : '';
  // Necromunda's gang bottle indicator: how close the gang is to testing, and
  // whether it has bottled out. The card module owns the markup.
  const bottle = T.game === 'necromunda' && window.NecromundaCard
    ? NecromundaCard.bottleHTML(s, i) : '';
  return `${cp}
    <span class="side-track">
      <span class="lbl">VP</span>
      <button class="rbtn sm" data-tside="${i}" data-tfield="vp" data-d="-1">−</button>
      <b id="vp-num-${i}">${s.vp || 0}</b>
      <button class="rbtn sm" data-tside="${i}" data-tfield="vp" data-d="1">+</button>
    </span>${bottle}`;
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

    ${T.game === 'bloodbowl' && window.BloodBowlCard ? BloodBowlCard.matchBarHtml(T.match, T.sides, T.status) : ''}

    <div class="error" id="p-err"></div>

    ${done && T.result ? doneHTML(T.result) : ''}

    ${T.sides.map((s, i) => `
      <div class="side-title">
        <h2>${esc(s.name)}</h2>
        <span class="muted" id="side-sub-${i}">${sideSub(s)}</span>
        <span class="side-tracks" id="side-track-${i}">${sideTrackersHTML(s, i)}</span>
      </div>
      <div class="unit-grid${T.game === 'battletech-classic' ? ' classic-grid' : ''}">
        ${s.units.map(cardHTML).join('') || emptySideHTML(s, i)}
      </div>`).join('')}

    ${done ? '' : `
    <h2>Finish</h2>
    <div class="card" id="finish-card">
      <p class="muted">${T.game === 'bloodbowl'
        ? 'Da score, da TDs and da casualties are already on da cards — just file it.'
        : 'Score yer objectives at da table, punch in da VP, and file it to da league.'}</p>
      <div class="finish-grid" style="margin-top:10px">
        ${T.sides.map((s) => `
          <div>
            <h3 style="color:var(--bone);font-size:15px;margin-bottom:6px">${esc(s.name)}</h3>
            <div class="muted" style="margin-bottom:6px">${s.units.filter((u) => u.destroyed).length} ${T.game === 'bloodbowl' ? 'off da pitch' : 'lost'} so far</div>
            ${T.game === 'bloodbowl' ? '' : `<label>Victory points <input type="number" class="vp-input" data-vp="${esc(s.name)}" min="0" max="200" value="${s.vp || 0}"></label>`}
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

    // Populate the claim-a-side league-team dropdowns (bloodbowl only).
    const bbClaims = [...document.querySelectorAll('select.claim-bb')];
    if (bbClaims.length) fillBbTeamSelects(bbClaims);
  }
}

// Every drafted Blood Bowl team across the club's Blood Bowl leagues, as
// "<leagueId>:<teamId>" options. A team that was never drafted through the
// list builder has no roster to snapshot, so it is left out.
async function fillBbTeamSelects(selects) {
  let opts = '<option value="">— no league teams found —</option>';
  try {
    const leagues = await api('/league');
    const bbLeagues = (leagues || []).filter((l) => l.game === 'bloodbowl');
    const rows = [];
    for (const l of bbLeagues) {
      const full = await api('/league/' + l.id);
      for (const t of Object.values(full.teams || {})) {
        if (t.bb) rows.push({ v: `${l.id}:${t.id}`, label: `${t.name} — ${t.race || '?'} (${l.name})` });
      }
    }
    if (rows.length) {
      opts = '<option value="">— pick a league team —</option>'
        + rows.map((r) => `<option value="${esc(r.v)}">${esc(r.label)}</option>`).join('');
    }
  } catch { /* leagues unavailable — the paste box still works */ }
  selects.forEach((sel) => { sel.innerHTML = opts; });
}

// Each game's doneSummary carries its OWN league stat ids, so the tally reads
// them per game rather than printing `undefined`:
//   battletech / wh40k  vp + kills + lost      necromunda  vp + oop + lost
//   mcp                 vp + kos + lost        trenchcrusade  vp + cas
//   bloodbowl           td + cas + comp + int  (and no vp at all)
function doneHTML(sum) {
  const headline = (s) => (sum.game === 'bloodbowl' ? `${s.td} TD` : `${s.vp} VP`);
  const detail = (s) => {
    if (sum.game === 'bloodbowl') {
      return `${s.cas} cas • ${s.comp} comp • ${s.int} int${s.mvp ? ` • MVP ${esc(s.mvp)}` : ''}`;
    }
    if (sum.game === 'necromunda') return `${s.oop} out of action • ${s.lost} lost`;
    if (sum.game === 'mcp') return `${s.kos} KOs • ${s.lost} lost`;
    if (sum.game === 'trenchcrusade') return `${s.cas} casualties`;
    return `${s.kills} kills • ${s.lost} lost`;
  };
  return `
  <div class="card">
    <h2 style="margin-top:0">Final Tally</h2>
    <div class="finish-grid">
      ${sum.sides.map((s) => `
        <div style="text-align:center">
          <h3 style="color:var(--bone);font-size:16px">${esc(s.name)}</h3>
          <div class="done-num">${headline(s)}</div>
          <div class="muted">${detail(s)}</div>
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

// Tracking taps are live on an unfinished table, or on a list with the
// tracking toggle ON (reference mode leaves the stats read-only).
const canTrack = () => (T && T.status !== 'done') || (LST && listTracking);

// Ceiling for a delegated +/- stepper, mirroring the server's caps
// (tracker-mcp MAX_POWER, tracker-bloodbowl MAX_EVENT). The server is still
// the referee — this only stops the button firing a patch it knows is illegal.
function stepMax(field) {
  if (field === 'power') return 99;
  if (field.startsWith('event.')) return (window.BloodBowlCard && BloodBowlCard.MAX_EVENT) || 20;
  return 99;
}

// The units sharing a side with this one (a list is one "side").
function sideUnitsOf(uid) {
  if (LST) return LST.units;
  if (!T) return [];
  return (T.sides.find((s) => s.units.some((u) => u.uid === uid)) || { units: [] }).units;
}

$app.addEventListener('click', (ev) => {
  // list view: collapse/expand one unit card to its one-line header
  const head = ev.target.closest('[data-collapse]');
  if (head && LST) {
    head.closest('.lst-unit')?.classList.toggle('collapsed');
    return;
  }
  const pip = ev.target.closest('.pip[data-uid][data-field], .sq[data-uid][data-field]');
  if (pip && canTrack()) {
    const { uid, field } = pip.dataset;
    const k = +pip.dataset.n;
    const u = unitByUid(uid);
    if (!u) return;
    const cur = readField(u, field);
    patch(uid, field, k === cur ? k - 1 : k);
    return;
  }
  // enum setters: a chip that SETS a field to a fixed value rather than
  // stepping it. The cards spell it three ways — necromunda/trenchcrusade
  // [data-set][data-value], mcp [data-set][data-v], bloodbowl
  // [data-field][data-val] — so all three are read here.
  const setter = ev.target.closest('[data-uid][data-set], [data-uid][data-field][data-val]');
  if (setter && canTrack()) {
    const d = setter.dataset;
    const field = d.set || d.field;
    const value = d.value !== undefined ? d.value : (d.v !== undefined ? d.v : d.val);
    if (field && value !== undefined) { patch(d.uid, field, value); return; }
  }
  // numeric steppers: mcp power [data-step][data-d], bloodbowl SPP events
  // [data-field][data-d]. Clamped client-side so a tap at the end of the
  // track is a no-op instead of a rejected patch.
  const step = ev.target.closest('[data-uid][data-step][data-d], [data-uid][data-field][data-d]');
  if (step && canTrack()) {
    const d = step.dataset;
    const field = d.step || d.field;
    const u = unitByUid(d.uid);
    if (!u) return;
    const cur = +readField(u, field) || 0;
    const next = Math.max(0, Math.min(cur + (+d.d), stepMax(field)));
    if (next !== cur) patch(d.uid, field, next);
    return;
  }
  // boolean toggles: crit slots, weapon-out buttons, status chips, MVP
  const tgl = ev.target.closest('[data-uid][data-toggle]');
  if (tgl && canTrack()) {
    const u = unitByUid(tgl.dataset.uid);
    if (!u) return;
    const on = !readField(u, tgl.dataset.toggle);
    // One MVP per side: taking the crown clears whoever wore it.
    if (tgl.dataset.toggle === 'mvp' && on && curGame() === 'bloodbowl') {
      for (const other of sideUnitsOf(u.uid)) {
        if (other.uid !== u.uid && other.mvp) patch(other.uid, 'mvp', false, { undoable: false });
      }
    }
    patch(u.uid, tgl.dataset.toggle, on);
    return;
  }
  const undoBtn = ev.target.closest('[data-undo]');
  if (undoBtn) { undoLast(undoBtn.dataset.undo); return; }
  const wreckBtn = ev.target.closest('[data-wreck]');
  if (wreckBtn && canTrack()) {
    const u = unitByUid(wreckBtn.dataset.wreck);
    if (u) patch(u.uid, 'destroyed', !u.destroyed);
    return;
  }
  // side CP/VP steppers (wh40k + the tracker games' VP)
  const tr = ev.target.closest('[data-tside][data-tfield]');
  if (tr && T && T.status !== 'done') {
    const i = +tr.dataset.tside;
    const s = T.sides[i];
    if (!s) return;
    const next = Math.max(0, (s[tr.dataset.tfield] || 0) + (+tr.dataset.d));
    patchSide(i, tr.dataset.tfield, next);
    return;
  }
  // Necromunda gang bottle switch (the chip in the side header)
  const bottle = ev.target.closest('[data-bottle]');
  if (bottle && T && T.status !== 'done') {
    const i = +bottle.dataset.bottle;
    if (T.sides[i]) patchSide(i, 'bottled', !T.sides[i].bottled);
    return;
  }
  // ---- Blood Bowl match bar ----
  // step a match field ([data-mfield][data-d], optional [data-mside])
  const mstep = ev.target.closest('[data-mfield][data-d]');
  if (mstep && T && T.match && T.status !== 'done') {
    const d = mstep.dataset;
    const field = d.mfield;
    const side = d.mside === undefined ? null : +d.mside;
    const cur = side === null ? (T.match[field] || 0) : ((T.match[field] || [])[side] || 0);
    patchMatch(field, side, cur + (+d.d));
    return;
  }
  // set a match field absolutely ([data-mfield][data-mval]) — the turn counters
  const mval = ev.target.closest('[data-mfield][data-mval]');
  if (mval && T && T.match && T.status !== 'done') {
    const d = mval.dataset;
    patchMatch(d.mfield, d.mside === undefined ? null : +d.mside, +d.mval);
    return;
  }
  // flip a boolean match field ([data-mtoggle]) — "reroll used dis turn"
  const mtgl = ev.target.closest('[data-mtoggle]');
  if (mtgl && T && T.match && T.status !== 'done') {
    const d = mtgl.dataset;
    const side = d.mside === undefined ? null : +d.mside;
    const cur = side === null ? T.match[d.mtoggle] : (T.match[d.mtoggle] || [])[side];
    patchMatch(d.mtoggle, side, !cur);
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
    return;
  }
  // claim a paste-game side (necromunda / mcp / trenchcrusade): the server
  // parses and snapshots the same way it does at create time.
  const claimPaste = ev.target.closest('[data-claimpaste]');
  if (claimPaste && T && T.status !== 'done') {
    const i = +claimPaste.dataset.claimpaste;
    const ta = document.querySelector(`textarea.claim-army[data-side="${i}"]`);
    const text = ta ? ta.value.trim() : '';
    if (!text) { playErr('Paste yer list first.'); return; }
    api(`/table/${T.id}/side/${i}/units`, { method: 'POST', body: JSON.stringify({ text }) })
      .then((t) => { T = t; renderPlay(); })
      .catch((e) => playErr(e.message));
    return;
  }
  // claim a Blood Bowl side: a drafted league team, or a pasted roster.
  const claimBb = ev.target.closest('[data-claimbb]');
  if (claimBb && T && T.status !== 'done') {
    const i = +claimBb.dataset.claimbb;
    const sel = document.querySelector(`select.claim-bb[data-side="${i}"]`);
    const ta = document.querySelector(`textarea.claim-army[data-side="${i}"]`);
    const pick = sel && sel.value ? sel.value.split(':') : null;
    const text = ta ? ta.value.trim() : '';
    if (!pick && !text) { playErr('Pick a league team or paste a roster.'); return; }
    const body = pick ? { leagueId: pick[0], teamId: pick[1] } : { text };
    api(`/table/${T.id}/side/${i}/units`, { method: 'POST', body: JSON.stringify(body) })
      .then((t) => { T = t; renderPlay(); })
      .catch((e) => playErr(e.message));
  }
});
$app.addEventListener('change', (ev) => {
  const notes = ev.target.closest('input.notes[data-uid]');
  if (notes && canTrack()) { patch(notes.dataset.uid, 'notes', notes.value, { undoable: false }); return; }
  // classic crew skills: editable during table setup, and any time on a list
  const crew = ev.target.closest('select.crew-sel[data-uid][data-field]');
  if (crew && ((T && T.status === 'setup') || (LST && listTracking))) {
    patch(crew.dataset.uid, crew.dataset.field, +crew.value, { undoable: false });
    return;
  }
  // Blood Bowl match bar: the weather picker and the inducements box. The
  // inducements input keeps its own text, so it is patched without a repaint.
  const wsel = ev.target.closest('select.bb-wsel[data-mfield]');
  if (wsel && T && T.match && T.status !== 'done') {
    patchMatch(wsel.dataset.mfield, wsel.dataset.mside === undefined ? null : +wsel.dataset.mside, wsel.value);
    return;
  }
  const ind = ev.target.closest('input.bb-indinput[data-mfield]');
  if (ind && T && T.match && T.status !== 'done') {
    patchMatch(ind.dataset.mfield, ind.dataset.mside === undefined ? null : +ind.dataset.mside, ind.value, { redraw: false });
  }
});

// ---- router ----

async function route() {
  if (socket && !location.hash.startsWith('#/t/')) { socket.disconnect(); socket = null; }
  if (!location.hash.startsWith('#/t/')) T = null;
  if (!location.hash.startsWith('#/l/')) { LST = null; collapsedAll = false; }
  if (!me) return loginWall();
  const mt = location.hash.match(/^#\/t\/([0-9a-f]{6})/);
  const ml = location.hash.match(/^#\/l\/([0-9a-f]{6,16})/);
  try {
    if (mt) await viewPlay(mt[1]);
    else if (ml) await viewList(ml[1]);
    else if (location.hash.startsWith('#/lists/new')) await viewNewList();
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
