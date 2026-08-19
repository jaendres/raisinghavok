// Marvel Crisis Protocol roster builder.
//
// MCP structure: a ROSTER is 10 characters, 5 team tactic cards and 3 crisis
// cards of each type (extract / secure). At the table you agree a threat
// level and pick a SQUAD from your roster whose threat total fits it — so the
// builder has two views: the full roster editor and a "tonight's squad"
// selector that ticks characters until the threat budget is spent.
//
// Card data comes from /api/builders/mcp/catalog (generated from the BSData
// community files — see scripts/mcp-build-catalog.mjs). Rosters are the
// player's own and live in localStorage under 'mcp-rosters'.

// Discord SSO hands the session token back in the URL fragment (same account
// and token as the rest of the site).
(() => {
  const m = location.hash.match(/^#sso=([a-f0-9]+)$/);
  if (m) {
    localStorage.setItem('mol_token', m[1]);
    history.replaceState(null, '', location.pathname);
  }
})();

const $app = document.getElementById('app');
const token = localStorage.getItem('mol_token');

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

// ---------------------------------------------------------------- state

const ROSTER_CHARS = 10, ROSTER_TACTICS = 5, ROSTER_CRISES = 3;
const STORE = 'mcp-rosters';

const blankRoster = () => ({
  name: '', affiliation: '', threat: 17,
  characters: [],                       // catalog character ids
  tactics: [],                          // card names
  crises: { extract: [], secure: [] },  // card names
  squad: [],                            // subset of characters, for tonight
});

const st = {
  cat: null,             // catalog from the server
  byId: new Map(),
  tab: 'chars',          // chars | tactics | crises
  view: 'roster',        // roster | squad
  q: '', aff: '',
  roster: blankRoster(),
};

const loadStore = () => JSON.parse(localStorage.getItem(STORE) || '{}');
const saveStore = (s) => localStorage.setItem(STORE, JSON.stringify(s));

const charOf = (id) => st.byId.get(id);
const rosterThreat = () => st.roster.characters.reduce((s, id) => s + (charOf(id)?.threat || 0), 0);
const squadThreat = () => st.roster.squad.reduce((s, id) => s + (charOf(id)?.threat || 0), 0);

// A character leads the roster's chosen affiliation if one of its leadership
// abilities names it. Leadership strings look like "… (AFFILIATION: AVENGERS)".
function leadsAffiliation(c, aff) {
  if (!c.leader || !aff) return false;
  const target = aff.toUpperCase();
  return c.leadership.some((l) => l.toUpperCase().includes(target)) ||
    c.affiliations.some((a) => a.toUpperCase() === target); // fallback: leader of own affiliation
}

// ---------------------------------------------------------------- views

function render() {
  const r = st.roster;
  $app.innerHTML = `
    <h1>Crisis Protocol</h1>
    <div class="sub">Marvel Crisis Protocol — roster builder</div>
    <div class="bt-layout">
      <div class="bt-pane bt-filters">
        <h2>Filters</h2>
        <label>Search
          <input id="f-q" type="search" value="${esc(st.q)}" placeholder="name / alter ego">
        </label>
        <label>Affiliation
          <select id="f-aff">
            <option value="">All</option>
            ${st.cat.affiliations.map((a) =>
              `<option value="${esc(a)}" ${a === st.aff ? 'selected' : ''}>${esc(a)}</option>`).join('')}
          </select>
        </label>
        <p class="muted" style="margin-top:10px">★ marks affiliation leaders.
        Grunts (summoned minions, threat 0) are not shown — they come with their named character.</p>
      </div>

      <div class="bt-pane">
        <div class="mcp-tabs">
          <button class="btn ${st.tab === 'chars' ? '' : 'ghost'}" onclick="M.tab('chars')">Characters</button>
          <button class="btn ${st.tab === 'tactics' ? '' : 'ghost'}" onclick="M.tab('tactics')">Team Tactics</button>
          <button class="btn ${st.tab === 'crises' ? '' : 'ghost'}" onclick="M.tab('crises')">Crises</button>
        </div>
        <div class="bt-scroll">${st.tab === 'chars' ? charTable() : st.tab === 'tactics' ? tacticTable() : crisisTable()}</div>
      </div>

      <div class="bt-pane">${rosterPane()}</div>
    </div>`;

  document.getElementById('f-q').oninput = (e) => { st.q = e.target.value; renderKeepFocus('f-q'); };
  document.getElementById('f-aff').onchange = (e) => { st.aff = e.target.value; render(); };
}

// re-render but keep the search box focused with the caret at the end
function renderKeepFocus(id) {
  render();
  const el = document.getElementById(id);
  if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
}

const matchQ = (s) => !st.q || s.toLowerCase().includes(st.q.toLowerCase());

// Card names go into inline onclick attributes; esc() covers element text but
// not attribute quotes, so names travel URI-encoded instead.
const jsArg = (s) => "decodeURIComponent('" + encodeURIComponent(s) + "')";

function charTable() {
  const rows = st.cat.characters
    .filter((c) => !c.grunt)
    .filter((c) => matchQ(c.name + ' ' + (c.alterEgo || '')))
    .filter((c) => !st.aff || c.affiliations.includes(st.aff));
  return `<table class="bt-table mcp-table">
    <tr><th class="c-add"></th><th class="c-threat">Thr</th><th class="c-name">Character</th>
        <th class="c-stam">Stam</th><th class="c-mvsz">Mv/Sz</th></tr>
    ${rows.map((c) => {
      const inRoster = st.roster.characters.includes(c.id);
      return `<tr>
        <td class="c-add">${inRoster
          ? '<button class="rmbtn" onclick="M.dropChar(\'' + c.id + '\')">✕</button>'
          : '<button class="addbtn" onclick="M.addChar(\'' + c.id + '\')">+</button>'}</td>
        <td class="c-pv c-threat"><span class="pv">${c.threat ?? '?'}</span></td>
        <td class="c-name">
          <span class="uname">${c.leader ? '<span class="lead-star" title="' + esc(c.leadership.join(' / ')) + '">★</span> ' : ''}${esc(c.name)}</span>
          <span class="usub">${esc(c.alterEgo || '')}</span>
          <span class="aff-tags">${c.affiliations.map((a) =>
            `<span class="tag ${a === st.aff ? 'on' : ''}">${esc(a)}</span>`).join('')}</span>
        </td>
        <td class="c-stam">${c.stamina.healthy ?? '?'}${c.stamina.injured != null ? '<span class="stam-inj">/' + c.stamina.injured + '</span>' : ''}</td>
        <td class="c-mvsz">${esc(c.movement || '?')} / ${c.size ?? '?'}</td>
      </tr>`;
    }).join('')}
  </table>
  ${rows.length ? '' : '<p class="muted">Nuffin\' matches.</p>'}`;
}

function tacticTable() {
  const rows = st.cat.tactics
    .filter((t) => matchQ(t.name))
    .filter((t) => !st.aff || !t.affiliation || t.affiliation === st.aff);
  return `<table class="bt-table mcp-table">
    <tr><th class="c-add"></th><th class="c-name">Team Tactic</th><th class="c-type">Type</th></tr>
    ${rows.map((t) => {
      const inRoster = st.roster.tactics.includes(t.name);
      return `<tr>
        <td class="c-add">${inRoster
          ? '<button class="rmbtn" onclick="M.dropTactic(' + jsArg(t.name) + ')">✕</button>'
          : '<button class="addbtn" onclick="M.addTactic(' + jsArg(t.name) + ')">+</button>'}</td>
        <td class="c-name"><span class="uname">${esc(t.name)}</span>
          <span class="restr">${t.affiliation ? esc(t.affiliation) : 'Unrestricted'}</span>
          ${t.banned ? '<span class="banned"> · banned in standard</span>' : ''}</td>
        <td class="c-type">${esc(t.type || '')}</td>
      </tr>`;
    }).join('')}
  </table>
  ${rows.length ? '' : '<p class="muted">Nuffin\' matches.</p>'}`;
}

function crisisTable() {
  const rows = st.cat.crises.filter((c) => matchQ(c.name));
  return `<table class="bt-table mcp-table">
    <tr><th class="c-add"></th><th class="c-threat">Thr</th><th class="c-name">Crisis</th><th class="c-type">Type</th></tr>
    ${rows.map((c) => {
      const list = st.roster.crises[c.type];
      const inRoster = list.includes(c.name);
      return `<tr>
        <td class="c-add">${inRoster
          ? '<button class="rmbtn" onclick="M.dropCrisis(' + jsArg(c.name) + ',\'' + c.type + '\')">✕</button>'
          : '<button class="addbtn" onclick="M.addCrisis(' + jsArg(c.name) + ',\'' + c.type + '\')">+</button>'}</td>
        <td class="c-pv c-threat"><span class="pv">${c.threats.join('/')}</span></td>
        <td class="c-name"><span class="uname">${esc(c.name)}</span>
          ${c.banned ? '<span class="banned">banned in standard</span>' : ''}</td>
        <td class="c-type">${c.type === 'extract' ? 'Extract' : 'Secure'}</td>
      </tr>`;
    }).join('')}
  </table>`;
}

// ---------------------------------------------------------------- roster pane

function rosterPane() {
  const r = st.roster;
  const saved = Object.keys(loadStore()).sort();
  const isSquad = st.view === 'squad';
  const sqT = squadThreat();
  const over = sqT > r.threat;

  const charRows = r.characters.map((id) => {
    const c = charOf(id);
    if (!c) return '';
    const leads = leadsAffiliation(c, r.affiliation);
    const inSquad = r.squad.includes(id);
    return `<div class="rrow ${leads ? 'leadrow' : ''} ${isSquad && !inSquad ? 'benched' : ''}">
      ${isSquad ? `<input type="checkbox" ${inSquad ? 'checked' : ''} onchange="M.toggleSquad('${id}')">` : ''}
      <span class="rname">${leads ? '<span class="lead-star" title="leads ' + esc(r.affiliation) + '">★</span> ' : ''}${esc(c.name)}
        <span class="sub">${esc(c.alterEgo || '')}</span></span>
      <span class="rthreat">${c.threat}</span>
      ${isSquad ? '' : `<button class="rmbtn" onclick="M.dropChar('${id}')">✕</button>`}
    </div>`;
  }).join('');

  const dupEgos = (() => {
    const seen = {}, dup = new Set();
    for (const id of r.characters) {
      const e = charOf(id)?.alterEgo;
      if (!e) continue;
      if (seen[e]) dup.add(e); seen[e] = 1;
    }
    return [...dup];
  })();

  return `
    <h2>${isSquad ? "Tonight's Squad" : 'Roster'}</h2>
    <div class="mcp-tabs">
      <button class="btn small ${isSquad ? 'ghost' : ''}" onclick="M.view('roster')">Roster</button>
      <button class="btn small ${isSquad ? '' : 'ghost'}" onclick="M.view('squad')">Tonight's Squad</button>
    </div>

    <div class="force-bar">
      <input id="r-name" placeholder="roster name" value="${esc(r.name)}" onchange="M.setName(this.value)">
      <button class="btn small" onclick="M.save()">Save</button>
      <button class="btn small ghost" onclick="M.reset()">New</button>
    </div>
    ${saved.length ? `<label>Saved rosters
      <select onchange="M.load(this.value)">
        <option value="">— load —</option>
        ${saved.map((n) => `<option ${n === r.name ? 'selected' : ''}>${esc(n)}</option>`).join('')}
      </select></label>` : ''}

    <div class="form-grid" style="margin-top:10px">
      <label>Affiliation
        <select onchange="M.setAff(this.value)">
          <option value="">— none —</option>
          ${st.cat.affiliations.map((a) =>
            `<option ${a === r.affiliation ? 'selected' : ''}>${esc(a)}</option>`).join('')}
        </select>
      </label>
      <label>Threat level
        <input type="number" min="8" max="30" value="${r.threat}" onchange="M.setThreat(this.value)">
      </label>
    </div>

    ${dupEgos.length ? `<div class="warn">Same alter ego twice: ${esc(dupEgos.join(', '))}.
      One body per soul — only one of 'em can be in a squad.</div>` : ''}
    ${r.affiliation && !r.characters.some((id) => leadsAffiliation(charOf(id) || {}, r.affiliation))
      ? `<div class="warn" style="background:#2b2213;border-color:#b8860b;color:#ffd23f">No ${esc(r.affiliation)} leader in da roster yet.</div>` : ''}

    <div class="mcp-roster-list">
      <h3>Characters <span class="mcp-counts ${r.characters.length === ROSTER_CHARS ? 'full' : ''}">${r.characters.length}/${ROSTER_CHARS}</span></h3>
      ${charRows || '<p class="muted">Add characters from da list.</p>'}
      ${isSquad ? '' : `
      <h3>Team Tactics <span class="mcp-counts ${r.tactics.length === ROSTER_TACTICS ? 'full' : ''}">${r.tactics.length}/${ROSTER_TACTICS}</span></h3>
      ${r.tactics.map((n) => `<div class="rrow"><span class="rname">${esc(n)}</span>
        <button class="rmbtn" onclick="M.dropTactic(${jsArg(n)})">✕</button></div>`).join('') || '<p class="muted">None yet.</p>'}
      <h3>Extract Crises <span class="mcp-counts ${r.crises.extract.length === ROSTER_CRISES ? 'full' : ''}">${r.crises.extract.length}/${ROSTER_CRISES}</span></h3>
      ${r.crises.extract.map((n) => `<div class="rrow"><span class="rname">${esc(n)}</span>
        <button class="rmbtn" onclick="M.dropCrisis(${jsArg(n)},'extract')">✕</button></div>`).join('') || '<p class="muted">None yet.</p>'}
      <h3>Secure Crises <span class="mcp-counts ${r.crises.secure.length === ROSTER_CRISES ? 'full' : ''}">${r.crises.secure.length}/${ROSTER_CRISES}</span></h3>
      ${r.crises.secure.map((n) => `<div class="rrow"><span class="rname">${esc(n)}</span>
        <button class="rmbtn" onclick="M.dropCrisis(${jsArg(n)},'secure')">✕</button></div>`).join('') || '<p class="muted">None yet.</p>'}`}
    </div>

    <div class="mcp-meter">
      ${isSquad
        ? `<span>Squad threat <span class="mcp-counts">(${r.squad.length} picked)</span></span>
           <b class="${over ? 'over' : ''}">${sqT} / ${r.threat}</b>`
        : `<span>Roster threat <span class="mcp-counts">(squads are picked to ${r.threat} at da table)</span></span>
           <b>${rosterThreat()}</b>`}
    </div>
    ${isSquad && over ? '<div class="warn">Over budget! Bench somebody.</div>' : ''}

    <div class="force-actions">
      <button class="btn ghost" onclick="M.exportText()">Text</button>
      <button class="btn ghost" onclick="M.print()">Print</button>
      ${saved.includes(r.name) ? '<button class="btn ghost" onclick="M.del()">Delete</button>' : ''}
    </div>`;
}

// ---------------------------------------------------------------- actions

const M = {
  tab(t) { st.tab = t; render(); },
  view(v) { st.view = v; render(); },
  setName(v) { st.roster.name = v.trim(); },
  setAff(v) { st.roster.affiliation = v; render(); },
  setThreat(v) { st.roster.threat = Math.max(1, parseInt(v, 10) || 17); render(); },

  addChar(id) {
    const r = st.roster;
    if (r.characters.includes(id)) return;
    if (r.characters.length >= ROSTER_CHARS) return toast(`Roster is full (${ROSTER_CHARS} characters)`);
    r.characters.push(id);
    render();
  },
  dropChar(id) {
    const r = st.roster;
    r.characters = r.characters.filter((x) => x !== id);
    r.squad = r.squad.filter((x) => x !== id);
    render();
  },
  toggleSquad(id) {
    const r = st.roster;
    r.squad = r.squad.includes(id) ? r.squad.filter((x) => x !== id) : [...r.squad, id];
    render();
  },

  addTactic(name) {
    const r = st.roster;
    if (r.tactics.includes(name)) return;
    if (r.tactics.length >= ROSTER_TACTICS) return toast(`Already got ${ROSTER_TACTICS} tactics`);
    r.tactics.push(name);
    render();
  },
  dropTactic(name) { st.roster.tactics = st.roster.tactics.filter((x) => x !== name); render(); },

  addCrisis(name, type) {
    const list = st.roster.crises[type];
    if (list.includes(name)) return;
    if (list.length >= ROSTER_CRISES) return toast(`Already got ${ROSTER_CRISES} ${type} crises`);
    list.push(name);
    render();
  },
  dropCrisis(name, type) {
    st.roster.crises[type] = st.roster.crises[type].filter((x) => x !== name);
    render();
  },

  save() {
    const name = document.getElementById('r-name')?.value.trim() || st.roster.name;
    if (!name) return toast('Give da roster a name first');
    st.roster.name = name;
    const s = loadStore();
    s[name] = st.roster;
    saveStore(s);
    toast(`Saved "${name}"`);
    render();
  },
  load(name) {
    if (!name) return;
    const saved = loadStore()[name];
    if (!saved) return;
    st.roster = { ...blankRoster(), ...saved, crises: { ...blankRoster().crises, ...saved.crises } };
    // drop anything the catalog no longer knows
    st.roster.characters = st.roster.characters.filter((id) => charOf(id));
    st.roster.squad = (st.roster.squad || []).filter((id) => st.roster.characters.includes(id));
    render();
  },
  del() {
    const s = loadStore();
    delete s[st.roster.name];
    saveStore(s);
    toast('Deleted');
    render();
  },
  reset() { st.roster = blankRoster(); st.view = 'roster'; render(); },

  exportText() {
    const text = rosterText();
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal">
      <button class="modal-x">✕</button>
      <h2>${esc(st.roster.name || 'Roster')}</h2>
      <textarea class="export-text" readonly>${esc(text)}</textarea>
      <div class="modal-actions"><button class="btn" id="copybtn">Copy</button></div>
    </div>`;
    back.querySelector('.modal-x').onclick = () => back.remove();
    back.onclick = (e) => { if (e.target === back) back.remove(); };
    back.querySelector('#copybtn').onclick = async () => {
      try { await navigator.clipboard.writeText(text); toast('Copied'); }
      catch { back.querySelector('textarea').select(); document.execCommand('copy'); toast('Copied'); }
    };
    document.body.append(back);
  },

  print() {
    const sheet = document.createElement('div');
    sheet.id = 'printsheet';
    const r = st.roster;
    sheet.innerHTML = `
      <h1>${esc(r.name || 'MCP Roster')}</h1>
      <div class="p-meta">Marvel Crisis Protocol —
        ${r.affiliation ? esc(r.affiliation) + ' — ' : ''}threat level ${r.threat}
        — roster threat ${rosterThreat()}</div>
      <table>
        <tr><th>Thr</th><th>Character</th><th>Stamina H/I</th><th>Mv</th><th>Sz</th><th>Damage</th></tr>
        ${r.characters.map((id) => { const c = charOf(id); return c ? `<tr>
          <td class="num">${c.threat}</td>
          <td><span class="p-name">${esc(c.name)}</span> <span class="p-abil">${esc(c.alterEgo || '')}${leadsAffiliation(c, r.affiliation) ? ' — LEADER' : ''}</span></td>
          <td class="num">${c.stamina.healthy ?? '?'} / ${c.stamina.injured ?? '—'}</td>
          <td>${esc(c.movement || '?')}</td><td class="num">${c.size ?? '?'}</td>
          <td class="p-track"></td>
        </tr>` : ''; }).join('')}
      </table>
      <h1 style="margin-top:6mm;font-size:12pt">Team Tactics</h1>
      <table>${r.tactics.map((n) => `<tr><td>${esc(n)}</td></tr>`).join('') || '<tr><td>—</td></tr>'}</table>
      <h1 style="margin-top:4mm;font-size:12pt">Crises</h1>
      <table>
        ${r.crises.extract.map((n) => `<tr><td>Extract</td><td>${esc(n)}</td></tr>`).join('')}
        ${r.crises.secure.map((n) => `<tr><td>Secure</td><td>${esc(n)}</td></tr>`).join('')}
      </table>
      <div class="p-foot">Raising Havok Gaming Club — ${esc(st.cat.meta.warning)}</div>`;
    document.body.append(sheet);
    const cleanup = () => { sheet.remove(); window.removeEventListener('afterprint', cleanup); };
    window.addEventListener('afterprint', cleanup);
    window.print();
  },
};
window.M = M;

function rosterText() {
  const r = st.roster;
  const lines = [];
  lines.push(`${r.name || 'MCP Roster'}${r.affiliation ? ' — ' + r.affiliation : ''}`);
  lines.push(`Marvel Crisis Protocol roster — threat level ${r.threat}`);
  lines.push('');
  lines.push(`CHARACTERS (${r.characters.length}/${ROSTER_CHARS}) — total threat ${rosterThreat()}`);
  for (const id of r.characters) {
    const c = charOf(id);
    if (!c) continue;
    lines.push(`  [${c.threat}] ${c.name}${leadsAffiliation(c, r.affiliation) ? ' *LEADER*' : ''}` +
      `  (stamina ${c.stamina.healthy ?? '?'}/${c.stamina.injured ?? '—'}, mv ${c.movement || '?'}, size ${c.size ?? '?'})`);
  }
  if (r.squad.length) {
    lines.push('');
    lines.push(`TONIGHT'S SQUAD — threat ${squadThreat()} / ${r.threat}`);
    for (const id of r.squad) {
      const c = charOf(id);
      if (c) lines.push(`  [${c.threat}] ${c.name}`);
    }
  }
  lines.push('');
  lines.push(`TEAM TACTICS (${r.tactics.length}/${ROSTER_TACTICS})`);
  for (const n of r.tactics) lines.push('  ' + n);
  lines.push('');
  lines.push(`EXTRACT CRISES (${r.crises.extract.length}/${ROSTER_CRISES})`);
  for (const n of r.crises.extract) lines.push('  ' + n);
  lines.push(`SECURE CRISES (${r.crises.secure.length}/${ROSTER_CRISES})`);
  for (const n of r.crises.secure) lines.push('  ' + n);
  lines.push('');
  lines.push(st.cat.meta.warning);
  return lines.join('\n');
}

// ---------------------------------------------------------------- boot

function loginWall() {
  $app.innerHTML = `
    <h1>Crisis Protocol</h1>
    <div class="sub">Members only</div>
    <div class="card" style="text-align:center;padding:40px">
      <p class="muted" style="margin-bottom:20px">Da roster builder is for club members.<br>
      Log in wiv yer Discord to get in.</p>
      <a class="btn" href="/api/auth/discord?return=/builders/mcp/">Log in with Discord</a>
    </div>`;
}

async function boot() {
  let me = null;
  try { me = await api('/me'); } catch { /* not logged in */ }
  const who = document.getElementById('whoami');
  if (who) who.textContent = me ? `👤 ${me.name}` : '';
  if (!me) return loginWall();

  try {
    st.cat = await api('/builders/mcp/catalog');
  } catch (e) {
    $app.innerHTML = `<div class="warn">Could not load da card catalog: ${esc(e.message)}</div>`;
    return;
  }
  st.byId = new Map(st.cat.characters.map((c) => [c.id, c]));

  // data-lag caveat, always visible
  const warn = document.getElementById('datawarn');
  if (warn && st.cat.meta) {
    warn.textContent = `⚠ Card data from BSData (${st.cat.meta.dataDate}) — ${st.cat.meta.warning}.`;
  }

  render();
}

boot();
