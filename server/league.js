// League tracker — leagues, teams with uploaded rosters, match results, and
// derived standings/stats. Game-agnostic core with Blood Bowl as the first
// configured game; add games by extending GAME_STATS.
const crypto = require('crypto');

// Per-game stat columns captured for each side of a match, plus SPP-style
// scoring weights used for per-player credit drill-downs.
const GAME_STATS = {
  bloodbowl: {
    name: 'Blood Bowl',
    score: 'td', // which stat decides the winner
    stats: [
      { id: 'td', name: 'Touchdowns' },
      { id: 'cas', name: 'Casualties' },
      { id: 'comp', name: 'Completions' },
      { id: 'int', name: 'Interceptions' },
    ],
    // SPP per credited action (BB-style: TD 3, CAS 2, COMP 1, INT 2, MVP 4)
    spp: { td: 3, cas: 2, comp: 1, int: 2, mvp: 4 },
    races: ['Amazon', 'Black Orc', 'Chaos Chosen', 'Chaos Dwarf', 'Dark Elf', 'Dwarf', 'Elven Union', 'Gnome', 'Goblin', 'Halfling', 'High Elf', 'Human', 'Imperial Nobility', 'Khorne', 'Lizardmen', 'Necromantic Horror', 'Norse', 'Nurgle', 'Ogre', 'Old World Alliance', 'Orc', 'Shambling Undead', 'Skaven', 'Snotling', 'Tomb Kings', 'Underworld Denizens', 'Vampire', 'Wood Elf'],
  },
};

function id() { return crypto.randomBytes(6).toString('hex'); }

// Parse a pasted/uploaded roster. Accepts "1, Grak, Blitzer" CSV-ish lines or
// free text; always keeps the raw line so nothing uploaded is ever lost.
function parseRoster(text) {
  if (typeof text !== 'string') return [];
  return text.split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !/^(#|\/\/)/.test(l))
    .slice(0, 40)
    .map(line => {
      const parts = line.split(',').map(s => s.trim()).filter(Boolean);
      let num = null, name = line, position = '';
      if (parts.length >= 2) {
        if (/^\d{1,2}$/.test(parts[0])) { num = +parts[0]; name = parts[1]; position = parts[2] || ''; }
        else { name = parts[0]; position = parts[1]; }
      }
      return { num, name: name.slice(0, 40), position: position.slice(0, 40), raw: line.slice(0, 200) };
    });
}

function makeLeague({ name, game, season }) {
  const g = GAME_STATS[game] ? game : 'bloodbowl';
  return {
    id: id(), name: String(name).slice(0, 60), game: g,
    season: String(season || '1').slice(0, 20),
    status: 'active', createdAt: new Date().toISOString(),
    teams: {}, matches: [],
  };
}

function makeTeam({ name, coach, race, rosterText }) {
  return {
    id: id(), name: String(name).slice(0, 60), coach: String(coach || '').slice(0, 40),
    race: String(race || '').slice(0, 40),
    rosterText: String(rosterText || '').slice(0, 8000),
    roster: parseRoster(rosterText),
    createdAt: new Date().toISOString(),
  };
}

// side = { teamId, stats: {td:2,...}, scorers: [{player, stat, count}], mvp }
function validSide(league, side) {
  if (!side || !league.teams[side.teamId]) return 'unknown team';
  const cfg = GAME_STATS[league.game];
  side.stats = side.stats || {};
  for (const s of cfg.stats) {
    const v = Math.round(+side.stats[s.id] || 0);
    if (v < 0 || v > 99) return 'bad stat value';
    side.stats[s.id] = v;
  }
  side.scorers = (Array.isArray(side.scorers) ? side.scorers : []).slice(0, 30).map(sc => ({
    player: String(sc.player || '').slice(0, 40),
    stat: cfg.stats.some(s => s.id === sc.stat) ? sc.stat : 'td',
    count: Math.min(20, Math.max(1, Math.round(+sc.count || 1))),
  })).filter(sc => sc.player);
  side.mvp = String(side.mvp || '').slice(0, 40);
  return null;
}

function makeMatch(league, { round, date, home, away, notes, reportedBy }) {
  if (home.teamId === away.teamId) return { error: 'a team cannot play itself' };
  const err = validSide(league, home) || validSide(league, away);
  if (err) return { error: err };
  return {
    match: {
      id: id(), round: String(round || '').slice(0, 20),
      date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date().toISOString().slice(0, 10),
      home: { teamId: home.teamId, stats: home.stats, scorers: home.scorers, mvp: home.mvp },
      away: { teamId: away.teamId, stats: away.stats, scorers: away.scorers, mvp: away.mvp },
      notes: String(notes || '').slice(0, 500),
      reportedBy: String(reportedBy || '').slice(0, 40),
      createdAt: new Date().toISOString(),
    },
  };
}

// ---- derived views ----

function standings(league) {
  const cfg = GAME_STATS[league.game];
  const rows = {};
  for (const t of Object.values(league.teams)) {
    rows[t.id] = { teamId: t.id, team: t.name, coach: t.coach, race: t.race, played: 0, w: 0, d: 0, l: 0, pts: 0 };
    for (const s of cfg.stats) { rows[t.id][s.id + 'For'] = 0; rows[t.id][s.id + 'Against'] = 0; }
  }
  for (const m of league.matches) {
    const h = rows[m.home.teamId], a = rows[m.away.teamId];
    if (!h || !a) continue;
    h.played++; a.played++;
    for (const s of cfg.stats) {
      h[s.id + 'For'] += m.home.stats[s.id] || 0; h[s.id + 'Against'] += m.away.stats[s.id] || 0;
      a[s.id + 'For'] += m.away.stats[s.id] || 0; a[s.id + 'Against'] += m.home.stats[s.id] || 0;
    }
    const hs = m.home.stats[cfg.score] || 0, as = m.away.stats[cfg.score] || 0;
    if (hs > as) { h.w++; h.pts += 3; a.l++; }
    else if (hs < as) { a.w++; a.pts += 3; h.l++; }
    else { h.d++; a.d++; h.pts++; a.pts++; }
  }
  const sc = cfg.score;
  return Object.values(rows).sort((x, y) =>
    y.pts - x.pts ||
    (y[sc + 'For'] - y[sc + 'Against']) - (x[sc + 'For'] - x[sc + 'Against']) ||
    y.casFor - x.casFor || 0);
}

// per-player stats from scorer credits + MVPs, with SPP totals
function playerStats(league) {
  const cfg = GAME_STATS[league.game];
  const players = {}; // "teamId::name" -> row
  const row = (teamId, name) => {
    const key = teamId + '::' + name.toLowerCase();
    if (!players[key]) {
      const team = league.teams[teamId];
      players[key] = { player: name, teamId, team: team ? team.name : '?', games: 0, mvp: 0, spp: 0 };
      for (const s of cfg.stats) players[key][s.id] = 0;
    }
    return players[key];
  };
  for (const m of league.matches) {
    for (const side of [m.home, m.away]) {
      const seen = new Set();
      for (const sc of side.scorers || []) {
        const r = row(side.teamId, sc.player);
        r[sc.stat] += sc.count;
        r.spp += (cfg.spp[sc.stat] || 0) * sc.count;
        seen.add(sc.player.toLowerCase());
      }
      if (side.mvp) {
        const r = row(side.teamId, side.mvp);
        r.mvp++; r.spp += cfg.spp.mvp;
        seen.add(side.mvp.toLowerCase());
      }
      for (const p of seen) players[side.teamId + '::' + p].games++;
    }
  }
  return Object.values(players).sort((a, b) => b.spp - a.spp);
}

function summary(league) {
  return {
    id: league.id, name: league.name, game: league.game,
    gameName: GAME_STATS[league.game].name, season: league.season,
    status: league.status, teams: Object.keys(league.teams).length,
    matches: league.matches.length, createdAt: league.createdAt,
  };
}

function full(league) {
  return {
    ...league,
    gameName: GAME_STATS[league.game].name,
    statCols: GAME_STATS[league.game].stats,
    scoreStat: GAME_STATS[league.game].score,
    races: GAME_STATS[league.game].races,
    standings: standings(league),
    playerStats: playerStats(league),
  };
}

module.exports = { GAME_STATS, makeLeague, makeTeam, makeMatch, summary, full, parseRoster };
