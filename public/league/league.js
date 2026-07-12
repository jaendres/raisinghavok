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
  return ''; // reads are members-only now; the login wall handles logged-out users
}

function loginWall() {
  const href = discordSso ? '/api/auth/discord?return=/league/' : '/play/';
  $app.innerHTML = `
    <h1>League Tracker</h1>
    <div class="sub">Members only</div>
    <div class="card" style="text-align:center;padding:40px">
      <p class="muted" style="margin-bottom:20px">League standings an' records are for club members.<br>
      Log in wiv yer Discord to get in.</p>
      <a class="btn" href="${href}">Log in with Discord</a>
    </div>`;
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
    ${l.game === 'bloodbowl' ? `
    <div class="card" style="text-align:center;padding:26px">
      <p class="muted" style="margin-bottom:14px">Blood Bowl teams get drafted proper — official BB2025 rosters, 1,000k budget, positional limits, da lot.</p>
      <a class="btn" href="#/l/${l.id}/draft">🏈 Open da List Builder</a>
    </div>` : `
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
    </div>`}` : ''}
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

  const tFile = document.getElementById('t-file'); // absent on Blood Bowl leagues (list builder instead)
  if (tFile) {
    tFile.onchange = async (ev) => {
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
}

// ---- Name Forge: race-flavored player/nickname/team-name generators ----
const NameForge = (() => {
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const GROUPS = {
    orky: ['orc', 'black_orc', 'goblin', 'snotling', 'ogre', 'underworld_denizens'],
    dwarfy: ['dwarf', 'chaos_dwarf'],
    elfy: ['elven_union', 'dark_elf', 'high_elf', 'wood_elf'],
    ratty: ['skaven'],
    grave: ['shambling_undead', 'necromantic_horror', 'tomb_kings', 'vampire'],
    chaos: ['chaos_chosen', 'khorne', 'nurgle', 'chaos_renegades'],
    human: ['human', 'imperial_nobility', 'norse', 'amazon', 'old_world_alliance', 'bretonnian', 'halfling', 'gnome', 'lizardmen'],
  };
  const groupOf = (race) => Object.keys(GROUPS).find(g => GROUPS[g].includes(race)) || 'human';
  const N = {
    orky: { a: ['Grak', 'Zog', 'Mork', 'Snag', 'Urg', 'Wazz', 'Gob', 'Skab', 'Drog', 'Nub', 'Ruk', 'Thrug'], b: ['gob', 'fang', 'tusk', 'basha', 'snik', 'zag', 'nash', 'grim', 'lug', 'rot'] },
    dwarfy: { a: ['Thorgrim', 'Baragor', 'Durin', 'Grimm', 'Okri', 'Zharruk', 'Morgrim', 'Khazek', 'Drong', 'Balik'], b: ['sson', 'gard', 'grund', 'nir', 'bek', 'dur', 'zad', 'rik'] },
    elfy: { a: ['Aeth', 'Lor', 'Syl', 'Fael', 'Ithil', 'Cal', 'Thal', 'Elar', 'Vael', 'Nim'], b: ['andor', 'ien', 'wing', 'anel', 'ael', 'oril', 'las', 'ion', 'aris'] },
    ratty: { a: ['Skree', 'Vrisk', 'Snik', 'Queek', 'Fes', 'Skab', 'Ratch', 'Vek', 'Pesk', 'Krit'], b: ['tail', 'fang', 'nik', 'sqeek', 'claw', 'gnaw', 'itch', 'vex'] },
    grave: { a: ['Mort', 'Vlad', 'Kha', 'Ner', 'Set', 'Dreg', 'Ossu', 'Barrow', 'Grimm', 'Amen'], b: ['emhet', 'ath', 'akh', 'ula', 'gor', 'crypt', 'mor', 'ankh'] },
    chaos: { a: ['Khar', 'Vor', 'Skul', 'Mal', 'Gore', 'Thar', 'Bael', 'Drax', 'Vex', 'Ruin'], b: ['gath', 'thak', 'doom', 'maw', 'rend', 'gore', 'oth', 'us'] },
    human: { a: ['Franz', 'Kurt', 'Hilda', 'Bruno', 'Greta', 'Otto', 'Elsa', 'Marcus', 'Astrid', 'Klaus', 'Sigrid', 'Bjorn'], b: [' Steinhammer', ' von Bock', ' Griffbane', ' Altdorfer', ' the Younger', ' Brandt', ' Snowmane', ' of Nuln', ' Half-Pint', ' Ironboot'] },
  };
  const NICKS = {
    orky: ['da Crusha', 'Bonebreaka', 'Skullsplitta', 'da Sneaky', 'Squig-Breath', 'Two-Teef', 'da Ballhog', 'Wazzock', 'Face-Stompa', 'da Unstoppable'],
    dwarfy: ['the Anvil', 'Grudgebearer', 'Stonefist', 'the Immovable', 'Beardsplitter', 'One-Eye', 'the Slayer', 'Oathkeeper'],
    elfy: ['the Swift', 'Winddancer', 'the Untouchable', 'Silverstep', 'the Show-Off', 'Leafblade', 'the Flawless'],
    ratty: ['the Sneak', 'Nine-Lives', 'Cheese-Thief', 'the Twitchy', 'Tunnel-Rat', 'Quick-Quick', 'the Expendable'],
    grave: ['the Twice-Dead', 'Gravewalker', 'the Cold', 'Bonefinger', 'the Patient', 'Tomb-Born', 'the Returned'],
    chaos: ['the Defiler', 'Skulltaker', 'the Blessed', 'Doomhand', 'the Marked', 'Bloodfist', 'the Hungering'],
    human: ['the Hammer', 'Three-Fingers', 'the Turnip', 'Ironboot', 'the Lucky', 'Ballhawk', 'the Wall', 'Mad-Eye', 'the Reliable'],
    any: ['the Ref\'s Nightmare', 'Two-Deaths', 'the Fumbler', 'Golden Boots', 'the Insurance Risk', 'One-More-Game', 'the Contract Dispute'],
  };
  const TEAMS = {
    orky: [['Da', ['Skull', 'Iron', 'Rust', 'Mud', 'Blood'], ['Krushas', 'Stompas', 'Splittas', 'Renegadez', 'Boyz']], [['Badlandz', 'Gouged Eye', 'Broken Fang', 'Scrap Heap'], ['Maraudaz', 'Wreckas', 'Raidaz']]],
    dwarfy: [[['Zharr-Naggrund', 'Karak', 'Iron Peak', 'Grudgeford'], ['Smog', 'Hammerers', 'Anvils', 'Longbeards', 'Grudges']], [['Da'], ['Anvil Splitters', 'Tall Hats', 'Furnace Kings']]],
    elfy: [[['Silvermoon', 'Gladewind', 'Starfall', 'Loren'], ['Arrows', 'Dancers', 'Spires', 'Wardens']]],
    ratty: [[['Under-City', 'Skavenblight', 'Sewer', 'Warp'], ['Scurriers', 'Gnawers', 'Stormvermin', 'Rats']]],
    grave: [[['Crypt', 'Barrow', 'Khemri', 'Midnight'], ['Shamblers', 'Wraiths', 'Eternals', 'Kings']]],
    chaos: [[['Doom', 'Gore', 'Plague', 'Skull'], ['Reavers', 'Chosen', 'Heralds', 'Legion']]],
    human: [[['Altdorf', 'Reikland', 'Nuln', 'Middenheim', 'Bright Crusaders'], ['Eagles', 'Hammers', 'Reavers', 'Royals', 'Wanderers']]],
  };
  return {
    player(race) { const g = groupOf(race); const n = N[g]; return pick(n.a) + pick(n.b); },
    nickname(race) { const g = groupOf(race); return pick(Math.random() < 0.25 ? NICKS.any : NICKS[g]); },
    team(race) {
      const g = groupOf(race);
      const pattern = pick(TEAMS[g]);
      return pattern.map(part => Array.isArray(part) ? pick(part) : part).join(' ');
    },
  };
})();

// ---- Blood Bowl list builder ----
let bbCatalog = null;
async function catalog() {
  if (!bbCatalog) bbCatalog = await api('/bb/catalog');
  return bbCatalog;
}
const gold = (n) => (n / 1000) + 'k';

async function viewDraft(id) {
  const [l, cat] = await Promise.all([api('/league/' + id), catalog()]);
  const races = Object.entries(cat.teams).sort((a, b) => a[1].name.localeCompare(b[1].name));
  const R = cat.rules;
  const state = { race: races[0][0], counts: {}, names: {}, rerolls: 0, apothecary: false, coaches: 0, cheerleaders: 0, fans: 1, teamName: '' };

  function render() {
    const race = cat.teams[state.race];
    let cost = 0, playerCount = 0;
    for (const p of race.positions) {
      const n = state.counts[p.name] || 0;
      cost += n * p.cost; playerCount += n;
    }
    cost += state.rerolls * race.rerollCost
      + state.coaches * (race.staff.coach || 10000)
      + state.cheerleaders * (race.staff.cheerleader || 10000)
      + (state.fans - 1) * R.fans.cost
      + (state.apothecary ? (race.staff.apothecary || 50000) : 0);
    const left = R.draftBudget - cost;
    const ok = playerCount >= R.minPlayers && playerCount <= R.maxPlayers && left >= 0;

    $app.innerHTML = `
      <div class="crumb"><a href="#/">Leagues</a> / <a href="#/l/${id}">${esc(l.name)}</a> / Draft a team</div>
      <h1>Draft a Team</h1>
      <div class="sub">${esc(race.name)} — Tier ${esc(race.tier || '?')} • official BB2025 rules, validated server-side</div>
      <div class="two-col">
        <div>
          <div class="card">
            <div class="form-grid">
              <label>Team name
                <span style="display:flex;gap:6px"><input id="d-name" maxlength="60" value="${esc(state.teamName)}" style="flex:1">
                <button class="cbtn" id="d-genteam" title="roll a team name" style="width:34px;height:34px">🎲</button></span>
              </label>
              <label>Race <select id="d-race">${races.map(([k, r]) => `<option value="${k}" ${k === state.race ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>
            </div>
            ${race.specialRules.length ? `<p class="muted" style="margin-top:8px">Special rules: ${race.specialRules.map(esc).join(', ')}</p>` : ''}
          </div>
          <h2>Positionals</h2>
          <div class="card" style="overflow-x:auto">
            <table>
              <tr><th></th><th>Position</th><th class="num">MA</th><th class="num">ST</th><th class="num">AG</th><th class="num">PA</th><th class="num">AV</th><th>Skills</th><th>Pri</th><th>Sec</th><th class="num">Cost</th><th class="num">Max</th></tr>
              ${race.positions.map(p => {
                const n = state.counts[p.name] || 0;
                return `<tr>
                  <td class="counter"><button data-pos="${esc(p.name)}" data-d="-1" class="cbtn">−</button><b>${n}</b><button data-pos="${esc(p.name)}" data-d="1" class="cbtn">+</button></td>
                  <td>${esc(p.name)}</td>
                  <td class="num">${p.ma}</td><td class="num">${p.st}</td><td class="num">${p.ag}+</td><td class="num">${p.pa ? p.pa + '+' : '-'}</td><td class="num">${p.av}+</td>
                  <td class="muted" style="font-size:13px">${p.skills.map(esc).join(', ') || '—'}</td>
                  <td class="muted">${p.primary.join('')}</td><td class="muted">${p.secondary.join('')}</td>
                  <td class="num">${gold(p.cost)}</td><td class="num">${p.max}</td>
                </tr>`;
              }).join('')}
            </table>
          </div>
          <h2>Names & Numbers <span class="muted" style="font-size:13px;text-transform:none">(optional — blank = position name)</span>
            <button class="btn small ghost" id="d-genall" style="margin-left:10px">🎲 name da lot</button></h2>
          <div class="card" id="d-players">
            ${draftPlayers(race).map((p, i) => `
              <div class="scorer-row" style="grid-template-columns:60px 2fr 34px 1fr">
                <input value="${p.num}" data-i="${i}" class="d-num" type="number" min="1" max="16">
                <input placeholder="${esc(p.position)}" value="${esc(state.names[i] || '')}" data-i="${i}" class="d-pname" maxlength="24">
                <button class="cbtn d-genname" data-i="${i}" title="roll a name">🎲</button>
                <span class="muted" style="line-height:34px">${esc(p.position)}</span>
              </div>`).join('') || '<p class="muted">Add players above.</p>'}
          </div>
        </div>
        <div>
          <h2>Sideline & Extras</h2>
          <div class="card">
            <div class="stafrow">Re-rolls (${gold(race.rerollCost)}) <span class="counter"><button class="cbtn" data-k="rerolls" data-d="-1">−</button><b>${state.rerolls}</b><button class="cbtn" data-k="rerolls" data-d="1">+</button></span></div>
            <div class="stafrow">Assistant coaches (10k) <span class="counter"><button class="cbtn" data-k="coaches" data-d="-1">−</button><b>${state.coaches}</b><button class="cbtn" data-k="coaches" data-d="1">+</button></span></div>
            <div class="stafrow">Cheerleaders (10k) <span class="counter"><button class="cbtn" data-k="cheerleaders" data-d="-1">−</button><b>${state.cheerleaders}</b><button class="cbtn" data-k="cheerleaders" data-d="1">+</button></span></div>
            <div class="stafrow">Dedicated fans (5k, max 3) <span class="counter"><button class="cbtn" data-k="fans" data-d="-1">−</button><b>${state.fans}</b><button class="cbtn" data-k="fans" data-d="1">+</button></span></div>
            ${race.apothecary ? `<div class="stafrow">Apothecary (${gold(race.staff.apothecary || 50000)}) <label style="flex-direction:row;align-items:center"><input type="checkbox" id="d-apo" ${state.apothecary ? 'checked' : ''}></label></div>` : '<div class="stafrow muted">No apothecary for this team</div>'}
          </div>
          <h2>Budget</h2>
          <div class="card">
            <div class="stafrow">Players <b>${playerCount} <span class="muted">(${R.minPlayers}–${R.maxPlayers})</span></b></div>
            <div class="stafrow">Spent <b>${gold(cost)}</b></div>
            <div class="stafrow">Treasury left <b class="${left < 0 ? 'loss' : 'win'}">${gold(left)}</b></div>
            <button class="btn big" id="d-submit" ${ok ? '' : 'disabled style="opacity:.5"'}>Draft Dis Team</button>
            <div class="error" id="d-err">${playerCount < R.minPlayers ? `Need at least ${R.minPlayers} players.` : ''}</div>
          </div>
        </div>
      </div>`;
    bindDraft(race);
  }

  function draftPlayers(race) {
    const out = [];
    let num = 1;
    for (const p of race.positions) {
      for (let i = 0; i < (state.counts[p.name] || 0); i++) out.push({ position: p.name, num: num++ });
    }
    return out;
  }

  function bindDraft(race) {
    $app.querySelectorAll('.cbtn').forEach(b => b.onclick = () => {
      const d = +b.dataset.d;
      if (b.dataset.pos) {
        const pos = race.positions.find(p => p.name === b.dataset.pos);
        const cur = state.counts[pos.name] || 0;
        state.counts[pos.name] = Math.max(0, Math.min(pos.max, cur + d));
      } else {
        const limits = { rerolls: 8, coaches: 6, cheerleaders: 12, fans: 3 };
        const min = b.dataset.k === 'fans' ? 1 : 0;
        state[b.dataset.k] = Math.max(min, Math.min(limits[b.dataset.k], state[b.dataset.k] + d));
      }
      state.teamName = $app.querySelector('#d-name').value;
      render();
    });
    $app.querySelector('#d-race').onchange = (e) => { state.race = e.target.value; state.counts = {}; state.names = {}; render(); };
    $app.querySelectorAll('.d-pname').forEach(inp => inp.oninput = () => { state.names[+inp.dataset.i] = inp.value; });
    $app.querySelector('#d-genteam').onclick = () => { $app.querySelector('#d-name').value = NameForge.team(state.race); };
    $app.querySelectorAll('.d-genname').forEach(b => b.onclick = () => {
      const i = +b.dataset.i;
      state.names[i] = NameForge.player(state.race);
      $app.querySelector(`.d-pname[data-i="${i}"]`).value = state.names[i];
    });
    $app.querySelector('#d-genall').onclick = () => {
      $app.querySelectorAll('.d-pname').forEach(inp => {
        if (!inp.value) { state.names[+inp.dataset.i] = NameForge.player(state.race); inp.value = state.names[+inp.dataset.i]; }
      });
    };
    const apo = $app.querySelector('#d-apo');
    if (apo) apo.onchange = () => { state.apothecary = apo.checked; state.teamName = $app.querySelector('#d-name').value; render(); };
    $app.querySelector('#d-submit').onclick = async () => {
      state.teamName = $app.querySelector('#d-name').value;
      const nums = [...$app.querySelectorAll('.d-num')].map(i => +i.value);
      const players = draftPlayers(race).map((p, i) => ({
        position: p.position, num: nums[i] || p.num, name: state.names[i] || '',
      }));
      try {
        const t = await api(`/league/${id}/team`, {
          method: 'POST',
          body: JSON.stringify({
            name: state.teamName, race: state.race,
            draft: { players, rerolls: state.rerolls, apothecary: state.apothecary, coaches: state.coaches, cheerleaders: state.cheerleaders, fans: state.fans },
          }),
        });
        location.hash = `#/l/${id}/t/${t.id}`;
      } catch (e) { $app.querySelector('#d-err').textContent = e.message; }
    };
  }

  render();
}

async function viewTeam(id, tid) {
  const l = await api('/league/' + id);
  const t = l.teams[tid];
  if (!t) { $app.innerHTML = '<p class="muted">No such team.</p>'; return; }
  if (t.bb) return viewBBTeam(l, tid);
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

async function viewBBTeam(l, tid) {
  const t = l.teams[tid];
  const [sheet, cat] = await Promise.all([api(`/league/${l.id}/team/${tid}/bb`), catalog()]);
  const canEdit = me && (me.toLowerCase() === (t.coach || '').toLowerCase());
  const row = l.standings.find(r => r.teamId === tid) || {};
  const matches = l.matches.filter(m => m.home.teamId === tid || m.away.teamId === tid);
  const race = cat.teams[sheet.race];
  const R = cat.rules;

  const statCell = (p, k) => {
    const pos = race.positions.find(x => x.name === p.position);
    const base = pos ? pos[k] : null;
    const v = p.stats[k];
    const suffix = (k === 'ag' || k === 'pa' || k === 'av') ? '+' : '';
    if (v == null || base == null) return '-';
    const better = (k === 'ag' || k === 'pa') ? v < base : v > base;
    const worse = (k === 'ag' || k === 'pa') ? v > base : v < base;
    return `<span class="${better ? 'win' : worse ? 'loss' : ''}">${v}${suffix}</span>`;
  };
  const badges = (p) =>
    (p.injuries.dead ? '<span class="badge dead">DEAD</span>' : '')
    + (p.retired ? '<span class="badge">RETIRED</span>' : '')
    + (p.injuries.mng ? '<span class="badge mng">MNG</span>' : '')
    + (p.injuries.ng ? `<span class="badge ng">NG×${p.injuries.ng}</span>` : '');

  $app.innerHTML = `
    <div class="crumb"><a href="#/">Leagues</a> / <a href="#/l/${l.id}">${esc(l.name)}</a> / ${esc(t.name)}</div>
    <h1>${esc(t.name)}</h1>
    <div class="sub">${esc(sheet.raceName)} • Coach ${esc(t.coach)} • ${row.w || 0}W ${row.d || 0}D ${row.l || 0}L
      • TV ${gold(sheet.tv)} • CTV ${gold(sheet.ctv)}</div>

    <h2>Roster</h2>
    <div class="card" style="overflow-x:auto">
      <table>
        <tr><th class="num">#</th><th>Player</th><th>Position</th>
          <th class="num">MA</th><th class="num">ST</th><th class="num">AG</th><th class="num">PA</th><th class="num">AV</th>
          <th>Skills</th><th>Level</th><th class="num" title="knockouts caused">KO</th><th class="num">SPP</th><th class="num">Value</th>${canEdit ? '<th></th>' : ''}</tr>
        ${sheet.players.sort((a, b) => a.num - b.num).map(p => `
          <tr class="${p.injuries.dead || p.retired ? 'gone' : ''}">
            <td class="num">${p.num}</td>
            <td>${esc(p.name)}${p.nickname ? ` <span class="nick">“${esc(p.nickname)}”</span>` : ''} ${badges(p)}</td>
            <td class="muted">${esc(p.position)}</td>
            <td class="num">${statCell(p, 'ma')}</td><td class="num">${statCell(p, 'st')}</td>
            <td class="num">${statCell(p, 'ag')}</td><td class="num">${statCell(p, 'pa')}</td><td class="num">${statCell(p, 'av')}</td>
            <td style="font-size:13px">${p.skills.map(s => `<span class="${p.advancements.some(a => a.skill === s) ? 'win' : 'muted'}">${esc(s)}</span>`).join(', ') || '—'}</td>
            <td class="muted" style="font-size:13px">${esc(p.level)}</td>
            <td class="num">${p.counters.ko || 0}</td>
            <td class="num" title="earned ${p.sppEarned}, spent ${p.sppSpent}"><b>${p.sppAvailable}</b><span class="muted">/${p.sppEarned}</span></td>
            <td class="num">${gold(p.value)}</td>
            ${canEdit ? `<td class="rowbtns">
              ${!p.injuries.dead && !p.retired && p.nextCosts ? `<button class="btn small" data-adv="${p.id}">Advance</button>` : ''}
              <button class="btn small ghost" data-inj="${p.id}">…</button>
            </td>` : ''}
          </tr>
          <tr class="detail hidden" id="panel-${p.id}"><td colspan="${canEdit ? 14 : 13}"></td></tr>
        `).join('')}
      </table>
      <p class="muted" style="margin-top:6px">SPP shown as available/earned — earned comes from named scorers an' MVPs in match reports (nicknames count too). Green stats/skills = advancements.</p>
    </div>

    ${sheet.players.some(p => p.injuries.dead) ? `
    <h2>💀 Da Graveyard</h2>
    <div class="card">
      ${sheet.players.filter(p => p.injuries.dead).map(p => `
        <div class="stafrow"><span>💀 <b>${esc(p.name)}</b>${p.nickname ? ` “${esc(p.nickname)}”` : ''}
          <span class="muted">— ${esc(p.position)}, ${esc(p.level)}${p.diedAt ? `, died ${esc(p.diedAt)}` : ''}</span></span>
          <span class="muted">${p.sppEarned} SPP earned • ${p.counters.ko || 0} KOs caused</span></div>`).join('')}
      <p class="muted" style="margin-top:6px">Dey died doin' what dey loved: gettin' stomped for our entertainment.</p>
    </div>` : ''}

    <div class="two-col">
      <div>
        <h2>Matches</h2>
        <div class="card" style="overflow-x:auto">
          <table>${[...matches].reverse().map(m => matchRow(l, m, tid)).join('') || '<tr><td class="muted">No matches yet.</td></tr>'}</table>
        </div>
      </div>
      <div>
        <h2>Club</h2>
        <div class="card">
          <div class="stafrow">Treasury <b>${gold(sheet.treasury)}</b></div>
          <div class="stafrow">Re-rolls <b>${sheet.rerolls}</b>${canEdit ? ` <button class="btn small ghost" data-buy="reroll">buy ${gold(sheet.rerollCost * 2)}</button>` : ''}</div>
          <div class="stafrow">Apothecary <b>${sheet.apothecary ? 'yes' : 'no'}</b>${canEdit && !sheet.apothecary && race.apothecary ? ` <button class="btn small ghost" data-buy="apothecary">hire ${gold(race.staff.apothecary || 50000)}</button>` : ''}</div>
          <div class="stafrow">Coaches <b>${sheet.coaches}</b>${canEdit ? ` <button class="btn small ghost" data-buy="coach">+</button>` : ''}</div>
          <div class="stafrow">Cheerleaders <b>${sheet.cheerleaders}</b>${canEdit ? ` <button class="btn small ghost" data-buy="cheerleader">+</button>` : ''}</div>
          <div class="stafrow">Dedicated fans <b>${sheet.fans}</b>${canEdit ? ` <button class="btn small ghost" data-fans="1">+</button><button class="btn small ghost" data-fans="-1">−</button>` : ''}</div>
          ${canEdit ? `
          <div class="stafrow" style="margin-top:10px">
            <input id="tr-delta" type="number" step="10000" placeholder="±gold (winnings...)" style="width:150px">
            <input id="tr-note" placeholder="note" maxlength="60" style="flex:1">
            <button class="btn small" id="tr-apply">apply</button>
          </div>
          <div class="stafrow">
            <select id="h-pos">${race.positions.map(p => `<option value="${esc(p.name)}">${esc(p.name)} (${gold(p.cost)})</option>`).join('')}</select>
            <input id="h-name" placeholder="name" maxlength="24" style="width:110px">
            <input id="h-num" type="number" min="1" max="16" placeholder="#" style="width:52px">
            <button class="btn small" id="h-hire">hire</button>
          </div>` : ''}
          <div class="error" id="bb-err"></div>
        </div>
        <h2>Team Log</h2>
        <div class="card" style="max-height:260px;overflow-y:auto;font-size:14px">
          ${sheet.log.slice().reverse().map(e => `<div class="muted">${esc(e.date)} — ${esc(e.text)}</div>`).join('')}
        </div>
      </div>
    </div>`;

  if (!canEdit) return;
  const err = (m) => { $app.querySelector('#bb-err').textContent = m; };
  const act = async (action, body) => {
    try { await api(`/league/${l.id}/team/${tid}/bb/${action}`, { method: 'POST', body: JSON.stringify(body) }); route(); }
    catch (e) { err(e.message); }
  };

  // advancement panel
  $app.querySelectorAll('[data-adv]').forEach(b => b.onclick = () => {
    const p = sheet.players.find(x => x.id === b.dataset.adv);
    const pos = race.positions.find(x => x.name === p.position);
    const panel = $app.querySelector(`#panel-${p.id}`);
    const catsFor = (letters) => letters.map(ltr => R.categories[ltr]).filter(Boolean);
    const skillOpts = (cats) => cats.flatMap(c =>
      cat.skills.byCategory[c].filter(s => !p.skills.includes(s))
        .map(s => `<option value="${esc(s)}">${esc(s)}${cat.skills.elite.includes(s) ? ' ★elite' : ''} (${c})</option>`)).join('');
    panel.classList.remove('hidden');
    panel.firstElementChild.innerHTML = `
      <div class="advpanel">
        <b>${esc(p.name)}</b> — ${p.sppAvailable} SPP available •
        <select id="a-mode">
          <option value="randomPrimary">Random primary (rolled at da table) — ${p.nextCosts.randomPrimary} SPP</option>
          <option value="choosePrimary">Choose primary — ${p.nextCosts.choosePrimary} SPP</option>
          <option value="chooseSecondary">Choose secondary — ${p.nextCosts.chooseSecondary} SPP</option>
          <option value="characteristic">Characteristic — ${p.nextCosts.characteristic} SPP</option>
        </select>
        <span id="a-pick"></span>
        <button class="btn small" id="a-go">Spend SPP</button>
        <button class="btn small ghost" id="a-x">✕</button>
      </div>`;
    const pick = panel.querySelector('#a-pick');
    const renderPick = () => {
      const mode = panel.querySelector('#a-mode').value;
      if (mode === 'characteristic') {
        pick.innerHTML = `<select id="a-stat"><option value="ma">+1 MA</option><option value="st">+1 ST</option><option value="ag">+1 AG</option><option value="pa">+1 PA</option><option value="av">+1 AV</option></select>
          <span class="muted">or skill instead:</span> <select id="a-skill"><option value="">(take da stat)</option>${skillOpts(catsFor([...pos.primary, ...pos.secondary]))}</select>`;
      } else {
        const cats = mode === 'chooseSecondary' ? catsFor(pos.secondary) : catsFor(pos.primary);
        pick.innerHTML = `<select id="a-skill">${skillOpts(cats)}</select>`;
      }
    };
    renderPick();
    panel.querySelector('#a-mode').onchange = renderPick;
    panel.querySelector('#a-x').onclick = () => panel.classList.add('hidden');
    panel.querySelector('#a-go').onclick = () => {
      const mode = panel.querySelector('#a-mode').value;
      const skillEl = panel.querySelector('#a-skill');
      const statEl = panel.querySelector('#a-stat');
      const body = { playerId: p.id, mode };
      if (mode === 'characteristic' && statEl && !(skillEl && skillEl.value)) body.stat = statEl.value;
      else body.skill = skillEl.value;
      act('advance', body);
    };
  });

  // injury / admin panel
  $app.querySelectorAll('[data-inj]').forEach(b => b.onclick = () => {
    const p = sheet.players.find(x => x.id === b.dataset.inj);
    const panel = $app.querySelector(`#panel-${p.id}`);
    panel.classList.remove('hidden');
    panel.firstElementChild.innerHTML = `
      <div class="advpanel">
        <b>${esc(p.name)}</b>:
        <input id="i-nick" placeholder="nickname" maxlength="20" value="${esc(p.nickname)}" style="width:130px">
        <button class="cbtn" id="i-nickgen" title="roll a nickname">🎲</button>
        <button class="btn small ghost" id="i-nicksave">save</button>
        <span class="muted">KO:</span>
        <button class="cbtn" data-ko="-1">−</button><b>${p.counters.ko || 0}</b><button class="cbtn" data-ko="1">+</button>
        <span style="flex:1"></span>
        <button class="btn small ghost" data-k="mng">${p.injuries.mng ? 'clear MNG' : 'miss next game'}</button>
        <button class="btn small ghost" data-k="ng">+niggling</button>
        <select id="i-stat"><option value="">stat injury…</option><option value="ma">-1 MA</option><option value="st">-1 ST</option><option value="ag">-1 AG</option><option value="pa">-1 PA</option><option value="av">-1 AV</option></select>
        <input id="i-spp" type="number" min="-20" max="20" placeholder="±SPP" style="width:70px" title="manual SPP correction">
        <button class="btn small ghost" id="i-sppgo">adj</button>
        <button class="btn small ghost" data-k="retire">${p.retired ? 'unretire' : 'retire'}</button>
        <button class="btn small ghost" data-k="dead">${p.injuries.dead ? 'not dead' : '💀 dead'}</button>
        <button class="btn small ghost" id="i-fire">fire</button>
        <button class="btn small ghost" id="i-x">✕</button>
      </div>`;
    panel.querySelectorAll('[data-k]').forEach(x => x.onclick = () => act('injury', { playerId: p.id, kind: x.dataset.k }));
    panel.querySelectorAll('[data-ko]').forEach(x => x.onclick = () => act('counter', { playerId: p.id, key: 'ko', delta: +x.dataset.ko }));
    panel.querySelector('#i-nickgen').onclick = () => { panel.querySelector('#i-nick').value = NameForge.nickname(sheet.race); };
    panel.querySelector('#i-nicksave').onclick = () => act('nickname', { playerId: p.id, nickname: panel.querySelector('#i-nick').value });
    panel.querySelector('#i-stat').onchange = (e) => e.target.value && act('injury', { playerId: p.id, kind: 'stat', stat: e.target.value });
    panel.querySelector('#i-sppgo').onclick = () => act('spp', { playerId: p.id, delta: +panel.querySelector('#i-spp').value });
    panel.querySelector('#i-fire').onclick = () => confirm(`Fire ${p.name}? No refunds.`) && act('fire', { playerId: p.id });
    panel.querySelector('#i-x').onclick = () => panel.classList.add('hidden');
  });

  $app.querySelectorAll('[data-buy]').forEach(b => b.onclick = () => act('buy', { item: b.dataset.buy }));
  $app.querySelectorAll('[data-fans]').forEach(b => b.onclick = () => act('fans', { delta: +b.dataset.fans }));
  const trBtn = $app.querySelector('#tr-apply');
  if (trBtn) trBtn.onclick = () => act('treasury', { delta: +$app.querySelector('#tr-delta').value, note: $app.querySelector('#tr-note').value });
  const hireBtn = $app.querySelector('#h-hire');
  if (hireBtn) hireBtn.onclick = () => act('hire', {
    position: $app.querySelector('#h-pos').value,
    name: $app.querySelector('#h-name').value,
    num: +$app.querySelector('#h-num').value,
  });
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
  if (!me) { loginWall(); return; }
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  try {
    if (parts[0] === 'l' && parts[1] && parts[2] === 'draft') await viewDraft(parts[1]);
    else if (parts[0] === 'l' && parts[1] && parts[2] === 't' && parts[3]) await viewTeam(parts[1], parts[3]);
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
