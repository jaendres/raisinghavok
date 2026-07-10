// League tracker SPA — hash-routed report pages with drill-down.
// Reuses the Mad Ork Lands account (same localStorage token, same API).

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

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch('/api' + path, { headers, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'server said no');
  return data;
}

function loginNote() {
  if (me) return '';
  const href = discordSso ? '/api/auth/discord?return=/league/' : '/play/';
  return `<p class="muted">Viewing as a spectator — <a href="${href}">log in with Discord</a> to add teams or report matches.</p>`;
}

// ---- views ----

async function viewHome() {
  const [leagues, games] = await Promise.all([api('/league'), api('/games')]);
  $app.innerHTML = `
    <h1>League Tracker</h1>
    <div class="sub">Raising Havok — seasons, standings an' grudges</div>
    ${loginNote()}
    <div class="card-grid">
      ${leagues.map(l => `
        <div class="card league-card" onclick="location.hash='#/l/${l.id}'">
          <h3>${esc(l.name)}</h3>
          <div class="meta">${esc(l.gameName)} • Season ${esc(l.season)} • ${l.teams} teams • ${l.matches} matches
            ${l.status !== 'active' ? ' • <span class="tag">finished</span>' : ''}</div>
        </div>`).join('') || '<p class="muted">No leagues yet.</p>'}
    </div>
    ${me ? `
    <h2>Start a League</h2>
    <div class="card">
      <div class="form-grid">
        <label>Name <input id="nl-name" maxlength="60" placeholder="RH Blood Bowl League"></label>
        <label>Game <select id="nl-game">${games.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select></label>
        <label>Season <input id="nl-season" maxlength="20" value="1"></label>
      </div>
      <div style="margin-top:12px"><button class="btn" id="nl-create">Create League</button></div>
      <div class="error" id="nl-err"></div>
    </div>` : ''}
  `;
  const btn = document.getElementById('nl-create');
  if (btn) btn.onclick = async () => {
    try {
      const l = await api('/league', { method: 'POST', body: JSON.stringify({ name: document.getElementById('nl-name').value, game: document.getElementById('nl-game').value, season: document.getElementById('nl-season').value }) });
      location.hash = '#/l/' + l.id;
    } catch (e) { document.getElementById('nl-err').textContent = e.message; }
  };
}

function teamName(l, id) { return l.teams[id] ? l.teams[id].name : '???'; }

function matchRow(l, m, focusTeam) {
  const hs = m.home.stats[l.scoreStat] || 0, as = m.away.stats[l.scoreStat] || 0;
  const cls = (tid) => {
    const mine = tid === focusTeam;
    if (!mine) return '';
    const my = m.home.teamId === tid ? hs : as, their = m.home.teamId === tid ? as : hs;
    return my > their ? 'win' : my < their ? 'loss' : 'draw';
  };
  return `<tr>
    <td>${esc(m.date)}${m.round ? ` <span class="tag">R${esc(m.round)}</span>` : ''}</td>
    <td class="${cls(m.home.teamId)}"><a href="#/l/${l.id}/t/${m.home.teamId}">${esc(teamName(l, m.home.teamId))}</a></td>
    <td class="score-big num">${hs} – ${as}</td>
    <td class="${cls(m.away.teamId)}"><a href="#/l/${l.id}/t/${m.away.teamId}">${esc(teamName(l, m.away.teamId))}</a></td>
    <td class="muted">cas ${m.home.stats.cas || 0}–${m.away.stats.cas || 0}${m.notes ? ' • ' + esc(m.notes) : ''}</td>
  </tr>`;
}

async function viewLeague(id) {
  const l = await api('/league/' + id);
  const cols = l.statCols;
  const maxFor = Math.max(1, ...l.standings.map(r => r[l.scoreStat + 'For']));
  $app.innerHTML = `
    <div class="crumb"><a href="#/">Leagues</a> / ${esc(l.name)}</div>
    <h1>${esc(l.name)}</h1>
    <div class="sub">${esc(l.gameName)} • Season ${esc(l.season)} • ${l.standings.length} teams • ${l.matches.length} matches played</div>
    ${loginNote()}

    <h2>Standings</h2>
    <div class="card" style="overflow-x:auto">
      <table>
        <tr><th>#</th><th>Team</th><th>Coach</th><th>Race</th><th class="num">P</th><th class="num">W</th><th class="num">D</th><th class="num">L</th>
        ${cols.map(c => `<th class="num">${esc(c.name)}</th>`).join('')}<th class="num">Pts</th></tr>
        ${l.standings.map((r, i) => `
          <tr class="click" onclick="location.hash='#/l/${l.id}/t/${r.teamId}'">
            <td class="pos">${i + 1}</td><td>${esc(r.team)}</td><td class="muted">${esc(r.coach)}</td><td class="muted">${esc(r.race)}</td>
            <td class="num">${r.played}</td><td class="num win">${r.w}</td><td class="num draw">${r.d}</td><td class="num loss">${r.l}</td>
            ${cols.map(c => `<td class="num">${r[c.id + 'For']}<span class="muted">/${r[c.id + 'Against']}</span></td>`).join('')}
            <td class="num score-big">${r.pts}</td>
          </tr>`).join('') || '<tr><td colspan="12" class="muted">No teams yet.</td></tr>'}
      </table>
      <p class="muted" style="margin-top:6px">Stat columns show For/<span class="muted">Against</span>. Click a team to drill in.</p>
    </div>

    <div class="two-col">
      <div>
        <h2>Top Players (SPP)</h2>
        <div class="card" style="overflow-x:auto">
          <table>
            <tr><th>Player</th><th>Team</th>${cols.map(c => `<th class="num">${esc(c.id).toUpperCase()}</th>`).join('')}<th class="num">MVP</th><th class="num">SPP</th></tr>
            ${l.playerStats.slice(0, 15).map(p => `
              <tr class="click" onclick="location.hash='#/l/${l.id}/p/${p.teamId}/${encodeURIComponent(p.player)}'">
                <td>${esc(p.player)}</td><td class="muted">${esc(p.team)}</td>
                ${cols.map(c => `<td class="num">${p[c.id]}</td>`).join('')}
                <td class="num">${p.mvp}</td><td class="num score-big">${p.spp}</td>
              </tr>`).join('') || '<tr><td colspan="9" class="muted">No player stats yet — name yer scorers when reporting matches.</td></tr>'}
          </table>
        </div>
      </div>
      <div>
        <h2>${esc(cols[0].name)} Scored</h2>
        <div class="card">
          ${l.standings.map(r => `
            <div class="bar-row"><span class="lbl">${esc(r.team)}</span>
              <div class="bar" style="width:${(r[l.scoreStat + 'For'] / maxFor) * 100}%"></div>
              <b>${r[l.scoreStat + 'For']}</b></div>`).join('') || '<p class="muted">Nothing yet.</p>'}
        </div>
      </div>
    </div>

    <h2>Matches</h2>
    <div class="card" style="overflow-x:auto">
      <table>${[...l.matches].reverse().map(m => matchRow(l, m)).join('') || '<tr><td class="muted">No matches reported yet.</td></tr>'}</table>
    </div>

    ${me ? `
    <h2>Report a Match</h2>
    <div class="card" id="report-card">
      <div class="form-grid">
        <label>Round <input id="m-round" maxlength="20" placeholder="1"></label>
        <label>Date <input id="m-date" type="date" value="${new Date().toISOString().slice(0, 10)}"></label>
      </div>
      <div class="match-sides" style="margin-top:12px">
        ${['home', 'away'].map(side => `
        <div>
          <h3 style="color:var(--bone);font-size:15px;margin-bottom:8px">${side.toUpperCase()}</h3>
          <label>Team <select id="${side}-team">${Object.values(l.teams).map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></label>
          <div class="form-grid" style="margin-top:8px">
            ${cols.map(c => `<label>${esc(c.name)} <input id="${side}-${c.id}" type="number" min="0" max="99" value="0"></label>`).join('')}
          </div>
          <label style="margin-top:8px">MVP (player name) <input id="${side}-mvp" maxlength="40"></label>
          <div style="margin-top:8px">
            <div class="muted" style="margin-bottom:4px">Scorers (for player stats — optional)</div>
            <div id="${side}-scorers"></div>
            <button class="btn ghost small" data-add-scorer="${side}">+ scorer</button>
          </div>
        </div>`).join('')}
      </div>
      <label style="margin-top:10px">Notes <input id="m-notes" maxlength="200" placeholder="Grudge match, 3 dead goblins"></label>
      <div style="margin-top:12px"><button class="btn" id="m-save">Report Match</button></div>
      <div class="error" id="m-err"></div>
    </div>

    <h2>Add a Team</h2>
    <div class="card">
      <div class="form-grid">
        <label>Team name <input id="t-name" maxlength="60"></label>
        <label>Coach <input id="t-coach" maxlength="40" value="${esc(me)}"></label>
        <label>Race/Roster <select id="t-race">${(l.races || []).map(r => `<option>${esc(r)}</option>`).join('')}</select></label>
      </div>
      <label style="margin-top:10px">Roster — paste or upload, one player per line: <b>number, name, position</b>
        <textarea id="t-roster" placeholder="1, Grak da Crusha, Black Orc&#10;2, Snik, Goblin Bribed Ref..."></textarea>
      </label>
      <div style="margin-top:8px"><input type="file" id="t-file" accept=".txt,.csv"> <span class="muted">or upload a .txt/.csv</span></div>
      <div style="margin-top:12px"><button class="btn" id="t-save">Add Team</button></div>
      <div class="error" id="t-err"></div>
    </div>` : ''}
  `;

  if (!me) return;

  // scorer row helpers
  const addScorer = (side) => {
    const div = document.createElement('div');
    div.className = 'scorer-row';
    div.innerHTML = `<input placeholder="player name" maxlength="40" class="sc-player">
      <select class="sc-stat">${cols.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
      <input type="number" class="sc-count" min="1" max="20" value="1">
      <span class="rm">✕</span>`;
    div.querySelector('.rm').onclick = () => div.remove();
    document.getElementById(side + '-scorers').appendChild(div);
  };
  document.querySelectorAll('[data-add-scorer]').forEach(b => b.onclick = () => addScorer(b.dataset.addScorer));

  document.getElementById('m-save').onclick = async () => {
    const side = (s) => ({
      teamId: document.getElementById(s + '-team').value,
      stats: Object.fromEntries(cols.map(c => [c.id, +document.getElementById(`${s}-${c.id}`).value || 0])),
      mvp: document.getElementById(s + '-mvp').value.trim(),
      scorers: [...document.querySelectorAll(`#${s}-scorers .scorer-row`)].map(r => ({
        player: r.querySelector('.sc-player').value.trim(),
        stat: r.querySelector('.sc-stat').value,
        count: +r.querySelector('.sc-count').value || 1,
      })).filter(x => x.player),
    });
    try {
      await api(`/league/${l.id}/match`, { method: 'POST', body: JSON.stringify({ round: document.getElementById('m-round').value, date: document.getElementById('m-date').value, notes: document.getElementById('m-notes').value, home: side('home'), away: side('away') }) });
      route();
    } catch (e) { document.getElementById('m-err').textContent = e.message; }
  };

  document.getElementById('t-file').onchange = async (ev) => {
    const f = ev.target.files[0];
    if (f) document.getElementById('t-roster').value = (await f.text()).slice(0, 8000);
  };
  document.getElementById('t-save').onclick = async () => {
    try {
      await api(`/league/${l.id}/team`, { method: 'POST', body: JSON.stringify({ name: document.getElementById('t-name').value, coach: document.getElementById('t-coach').value, race: document.getElementById('t-race').value, rosterText: document.getElementById('t-roster').value }) });
      route();
    } catch (e) { document.getElementById('t-err').textContent = e.message; }
  };
}

async function viewTeam(id, tid) {
  const l = await api('/league/' + id);
  const t = l.teams[tid];
  if (!t) { $app.innerHTML = '<p class="muted">No such team.</p>'; return; }
  const row = l.standings.find(r => r.teamId === tid) || {};
  const matches = l.matches.filter(m => m.home.teamId === tid || m.away.teamId === tid);
  const players = l.playerStats.filter(p => p.teamId === tid);
  const canEdit = me && (me.toLowerCase() === (t.coach || '').toLowerCase());
  $app.innerHTML = `
    <div class="crumb"><a href="#/">Leagues</a> / <a href="#/l/${l.id}">${esc(l.name)}</a> / ${esc(t.name)}</div>
    <h1>${esc(t.name)}</h1>
    <div class="sub">${esc(t.race)} • Coach ${esc(t.coach)} • ${row.w || 0}W ${row.d || 0}D ${row.l || 0}L • ${row.pts || 0} league points</div>

    <div class="two-col">
      <div>
        <h2>Matches</h2>
        <div class="card" style="overflow-x:auto">
          <table>${[...matches].reverse().map(m => matchRow(l, m, tid)).join('') || '<tr><td class="muted">No matches yet.</td></tr>'}</table>
        </div>
        <h2>Player Stats</h2>
        <div class="card" style="overflow-x:auto">
          <table>
            <tr><th>Player</th>${l.statCols.map(c => `<th class="num">${esc(c.id).toUpperCase()}</th>`).join('')}<th class="num">MVP</th><th class="num">SPP</th></tr>
            ${players.map(p => `
              <tr class="click" onclick="location.hash='#/l/${l.id}/p/${tid}/${encodeURIComponent(p.player)}'">
                <td>${esc(p.player)}</td>${l.statCols.map(c => `<td class="num">${p[c.id]}</td>`).join('')}
                <td class="num">${p.mvp}</td><td class="num score-big">${p.spp}</td></tr>`).join('') || '<tr><td class="muted" colspan="8">No credited actions yet.</td></tr>'}
          </table>
        </div>
      </div>
      <div>
        <h2>Roster</h2>
        <div class="card" style="overflow-x:auto">
          <table>
            <tr><th class="num">#</th><th>Player</th><th>Position</th></tr>
            ${t.roster.map(p => `<tr><td class="num">${p.num ?? ''}</td><td>${esc(p.name)}</td><td class="muted">${esc(p.position)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No roster uploaded.</td></tr>'}
          </table>
        </div>
        ${canEdit ? `
        <h2>Update Roster</h2>
        <div class="card">
          <textarea id="e-roster">${esc(t.rosterText)}</textarea>
          <div style="margin-top:8px"><input type="file" id="e-file" accept=".txt,.csv"></div>
          <div style="margin-top:10px"><button class="btn" id="e-save">Save Roster</button></div>
          <div class="error" id="e-err"></div>
        </div>` : ''}
      </div>
    </div>
  `;
  if (canEdit) {
    document.getElementById('e-file').onchange = async (ev) => {
      const f = ev.target.files[0];
      if (f) document.getElementById('e-roster').value = (await f.text()).slice(0, 8000);
    };
    document.getElementById('e-save').onclick = async () => {
      try {
        await api(`/league/${l.id}/team/${tid}`, { method: 'PUT', body: JSON.stringify({ rosterText: document.getElementById('e-roster').value }) });
        route();
      } catch (e) { document.getElementById('e-err').textContent = e.message; }
    };
  }
}

async function viewPlayer(id, tid, name) {
  const l = await api('/league/' + id);
  const t = l.teams[tid];
  const stats = l.playerStats.find(p => p.teamId === tid && p.player.toLowerCase() === name.toLowerCase());
  const appearances = l.matches.filter(m => [m.home, m.away].some(s =>
    s.teamId === tid && ((s.scorers || []).some(sc => sc.player.toLowerCase() === name.toLowerCase()) || (s.mvp || '').toLowerCase() === name.toLowerCase())));
  $app.innerHTML = `
    <div class="crumb"><a href="#/">Leagues</a> / <a href="#/l/${l.id}">${esc(l.name)}</a> / <a href="#/l/${l.id}/t/${tid}">${esc(t ? t.name : '?')}</a> / ${esc(name)}</div>
    <h1>${esc(name)}</h1>
    <div class="sub">${esc(t ? t.name : '')} • ${stats ? stats.spp + ' SPP' : 'no credited actions yet'}</div>
    ${stats ? `
    <div class="card">
      <table>
        <tr>${l.statCols.map(c => `<th class="num">${esc(c.name)}</th>`).join('')}<th class="num">MVPs</th><th class="num">SPP</th></tr>
        <tr>${l.statCols.map(c => `<td class="num score-big">${stats[c.id]}</td>`).join('')}<td class="num score-big">${stats.mvp}</td><td class="num score-big" style="color:var(--rust)">${stats.spp}</td></tr>
      </table>
    </div>` : ''}
    <h2>Match Log</h2>
    <div class="card" style="overflow-x:auto">
      <table>
        ${appearances.reverse().map(m => {
          const side = m.home.teamId === tid ? m.home : m.away;
          const deeds = (side.scorers || []).filter(sc => sc.player.toLowerCase() === name.toLowerCase())
            .map(sc => `${sc.count}× ${sc.stat.toUpperCase()}`);
          if ((side.mvp || '').toLowerCase() === name.toLowerCase()) deeds.push('MVP');
          return `<tr><td>${esc(m.date)}</td>
            <td>${esc(teamName(l, m.home.teamId))} <b class="score-big">${m.home.stats[l.scoreStat]}–${m.away.stats[l.scoreStat]}</b> ${esc(teamName(l, m.away.teamId))}</td>
            <td class="win">${deeds.join(', ')}</td></tr>`;
        }).join('') || '<tr><td class="muted">No appearances logged.</td></tr>'}
      </table>
    </div>
  `;
}

// ---- router ----
async function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  try {
    if (parts[0] === 'l' && parts[1] && parts[2] === 't' && parts[3]) await viewTeam(parts[1], parts[3]);
    else if (parts[0] === 'l' && parts[1] && parts[2] === 'p' && parts[3] && parts[4]) await viewPlayer(parts[1], parts[3], decodeURIComponent(parts[4]));
    else if (parts[0] === 'l' && parts[1]) await viewLeague(parts[1]);
    else await viewHome();
  } catch (e) {
    $app.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

(async () => {
  try { discordSso = (await api('/config')).discordEnabled; } catch { }
  if (token) {
    try { me = (await api('/me')).name; } catch { me = null; }
  }
  const who = document.getElementById('whoami');
  if (me) {
    who.innerHTML = `Coach ${esc(me)} &nbsp;<a href="#" id="nav-logout">log out</a>`;
    document.getElementById('nav-logout').onclick = async (e) => {
      e.preventDefault();
      try { await api('/logout', { method: 'POST', body: '{}' }); } catch { }
      localStorage.removeItem('mol_token');
      location.reload();
    };
  } else {
    who.innerHTML = `<a href="${discordSso ? '/api/auth/discord?return=/league/' : '/play/'}">Log in</a>`;
  }
  route();
})();
