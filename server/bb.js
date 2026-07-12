// Blood Bowl list builder + league bookkeeping engine (BB2025 rules).
// The catalog (teams/positions/skills/costs) is generated from the scraped
// rulebook — see bloodbowl-discord-bot/build_bb_catalog.py. Everything here
// validates against it server-side; the UI is just a convenient front end.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CATALOG = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'data', 'bb-catalog.json'), 'utf-8'));
const R = CATALOG.rules;

const id = () => crypto.randomBytes(5).toString('hex');
const clampName = (s, n = 24) => String(s || '').replace(/[<>]/g, '').trim().slice(0, n);

function positionOf(raceKey, posName) {
  const race = CATALOG.teams[raceKey];
  return race && race.positions.find(p => p.name === posName);
}

function skillCategory(skill) {
  for (const [cat, list] of Object.entries(CATALOG.skills.byCategory)) {
    if (list.includes(skill)) return cat;
  }
  return null;
}

// ---- values ----

function advValue(adv) {
  const V = R.valueIncrease;
  if (adv.stat) return V[adv.stat];
  let v = adv.mode === 'chooseSecondary' || adv.secondary ? V.secondarySkill : V.primarySkill;
  if (CATALOG.skills.elite.includes(adv.skill)) v += V.eliteExtra;
  return v;
}

function playerValue(raceKey, player) {
  const pos = positionOf(raceKey, player.position);
  if (!pos) return 0;
  return pos.cost + (player.advancements || []).reduce((s, a) => s + advValue(a), 0);
}

function teamValue(team) {
  const bb = team.bb;
  const race = CATALOG.teams[team.bbRace] || { staff: {}, rerollCost: 0 };
  let tv = 0;
  for (const p of bb.players) {
    if (!p.injuries.dead && !p.retired) tv += playerValue(team.bbRace, p);
  }
  tv += bb.rerolls * (race.rerollCost || 0);
  if (bb.apothecary) tv += race.staff.apothecary || 50000;
  tv += bb.coaches * (race.staff.coach || 10000);
  tv += bb.cheerleaders * (race.staff.cheerleader || 10000);
  return tv;
}

function currentTeamValue(team) {
  let ctv = teamValue(team);
  for (const p of team.bb.players) {
    if (p.injuries.mng && !p.injuries.dead && !p.retired) ctv -= playerValue(team.bbRace, p);
  }
  return ctv;
}

// effective stats after advancements and injuries (ag/pa/av are target
// numbers: improvements lower ag/pa and raise av; injuries do the reverse)
function effectiveStats(raceKey, player) {
  const pos = positionOf(raceKey, player.position);
  if (!pos) return {};
  const s = { ma: pos.ma, st: pos.st, ag: pos.ag, pa: pos.pa, av: pos.av };
  for (const a of player.advancements || []) {
    if (!a.stat) continue;
    if (a.stat === 'ag' || a.stat === 'pa') s[a.stat] -= 1;
    else s[a.stat] += 1;
  }
  const red = player.injuries.stats || {};
  for (const k of ['ma', 'st', 'ag', 'pa', 'av']) {
    const n = red[k] || 0;
    if (!n) continue;
    if (k === 'ag' || k === 'pa') s[k] += n;
    else s[k] -= n;
  }
  return s;
}

function allSkills(raceKey, player) {
  const pos = positionOf(raceKey, player.position);
  return [
    ...(pos ? pos.skills : []),
    ...(player.advancements || []).filter(a => a.skill).map(a => a.skill),
  ];
}

// ---- drafting ----

// draft = { players: [{position, name, num}], rerolls, apothecary,
//           coaches, cheerleaders, fans }
function validateDraft(raceKey, draft) {
  const race = CATALOG.teams[raceKey];
  if (!race) return { error: 'unknown race' };
  const players = Array.isArray(draft.players) ? draft.players : [];
  if (players.length < R.minPlayers) return { error: `need at least ${R.minPlayers} players` };
  if (players.length > R.maxPlayers) return { error: `no more than ${R.maxPlayers} players` };

  const counts = {};
  const nums = new Set();
  let cost = 0;
  for (const p of players) {
    const pos = positionOf(raceKey, p.position);
    if (!pos) return { error: `unknown position: ${p.position}` };
    counts[p.position] = (counts[p.position] || 0) + 1;
    if (counts[p.position] > pos.max) return { error: `too many ${p.position} (max ${pos.max})` };
    const num = parseInt(p.num, 10);
    if (!(num >= 1 && num <= 16)) return { error: 'player numbers must be 1-16' };
    if (nums.has(num)) return { error: `duplicate player number ${num}` };
    nums.add(num);
    cost += pos.cost;
  }

  const rerolls = Math.max(0, Math.min(R.maxRerolls, parseInt(draft.rerolls, 10) || 0));
  const coaches = Math.max(0, Math.min(R.staff.coach.max, parseInt(draft.coaches, 10) || 0));
  const cheerleaders = Math.max(0, Math.min(R.staff.cheerleader.max, parseInt(draft.cheerleaders, 10) || 0));
  const fans = Math.max(R.fans.start, Math.min(R.fans.draftMax, parseInt(draft.fans, 10) || R.fans.start));
  const apothecary = !!draft.apothecary && race.apothecary;

  cost += rerolls * race.rerollCost;
  cost += coaches * (race.staff.coach || 10000);
  cost += cheerleaders * (race.staff.cheerleader || 10000);
  cost += (fans - R.fans.start) * R.fans.cost;
  if (apothecary) cost += race.staff.apothecary || 50000;

  if (cost > R.draftBudget) return { error: `over budget: ${cost / 1000}k of ${R.draftBudget / 1000}k` };

  return {
    ok: true, cost,
    bb: {
      players: players.map(p => ({
        id: id(),
        num: parseInt(p.num, 10),
        name: clampName(p.name) || p.position,
        position: p.position,
        advancements: [],
        sppSpent: 0, sppExtra: 0,
        injuries: { ng: 0, mng: false, dead: false, stats: {} },
        retired: false,
      })),
      rerolls, apothecary, coaches, cheerleaders, fans,
      treasury: R.draftBudget - cost,
      log: [{ date: new Date().toISOString().slice(0, 10), text: `Team drafted (${cost / 1000}k spent)` }],
    },
  };
}

// ---- advancements ----

// body = { mode, skill? , stat? } ; sppAvailable computed by caller from
// league scorer credits + manual adjustments.
function applyAdvancement(team, player, body, sppAvailable) {
  const advCount = player.advancements.length;
  if (advCount >= R.maxAdvancements) return { error: 'player is already a Legend (6 advancements)' };
  const costs = R.advancementCosts[body.mode];
  if (!costs) return { error: 'unknown advancement mode' };
  const sppCost = costs[advCount];
  if (sppAvailable < sppCost) return { error: `needs ${sppCost} SPP (has ${sppAvailable})` };

  const pos = positionOf(team.bbRace, player.position);
  const adv = { mode: body.mode, spp: sppCost };

  if (body.mode === 'characteristic' && body.stat) {
    const stat = String(body.stat).toLowerCase();
    if (!['ma', 'st', 'ag', 'pa', 'av'].includes(stat)) return { error: 'bad stat' };
    const already = player.advancements.filter(a => a.stat === stat).length;
    if (already >= R.statCaps.maxImprovementsPerStat) return { error: `${stat.toUpperCase()} already improved twice` };
    const eff = effectiveStats(team.bbRace, player);
    const capped =
      (stat === 'ag' || stat === 'pa') ? eff[stat] - 1 < R.statCaps[stat]
      : eff[stat] + 1 > R.statCaps[stat];
    if (capped) return { error: `${stat.toUpperCase()} is at its maximum` };
    adv.stat = stat;
  } else {
    // skill pick (also allowed on a characteristic roll, per the rules)
    const skill = String(body.skill || '').trim();
    const cat = skillCategory(skill);
    if (!cat) return { error: 'unknown skill' };
    const catLetter = Object.entries(R.categories).find(([, v]) => v === cat)[0];
    const isPrimary = pos.primary.includes(catLetter);
    const isSecondary = pos.secondary.includes(catLetter);
    if (body.mode === 'chooseSecondary') {
      if (!isSecondary) return { error: `${cat} is not a secondary category for ${player.position}` };
      adv.secondary = true;
    } else if (body.mode === 'characteristic') {
      if (!isPrimary && !isSecondary) return { error: `${player.position} has no access to ${cat}` };
      adv.secondary = !isPrimary;
    } else {
      if (!isPrimary) return { error: `${cat} is not a primary category for ${player.position}` };
    }
    if (allSkills(team.bbRace, player).includes(skill)) return { error: 'player already has that skill' };
    adv.skill = skill;
  }

  adv.value = advValue(adv);
  player.advancements.push(adv);
  player.sppSpent += sppCost;
  team.bb.log.push({
    date: new Date().toISOString().slice(0, 10),
    text: `${player.name}: ${adv.skill || '+1 ' + adv.stat.toUpperCase()} (${body.mode}, ${sppCost} SPP)`,
  });
  return { ok: true, adv };
}

// ---- serialization for the UI ----

function serializeTeam(team, sppEarnedByName) {
  const bb = team.bb;
  const race = CATALOG.teams[team.bbRace];
  return {
    race: team.bbRace, raceName: race ? race.name : team.bbRace,
    rerolls: bb.rerolls, apothecary: bb.apothecary,
    coaches: bb.coaches, cheerleaders: bb.cheerleaders, fans: bb.fans,
    treasury: bb.treasury,
    tv: teamValue(team), ctv: currentTeamValue(team),
    rerollCost: race ? race.rerollCost : 0,
    log: bb.log.slice(-30),
    players: bb.players.map(p => {
      const earned = sppEarnedByName(p.name) + (p.sppExtra || 0);
      return {
        id: p.id, num: p.num, name: p.name, position: p.position,
        stats: effectiveStats(team.bbRace, p),
        skills: allSkills(team.bbRace, p),
        advancements: p.advancements,
        level: R.levels[Math.min(p.advancements.length, R.levels.length - 1)],
        value: (p.injuries.dead || p.retired) ? 0 : playerValue(team.bbRace, p),
        sppEarned: earned, sppSpent: p.sppSpent,
        sppAvailable: Math.max(0, earned - p.sppSpent),
        nextCosts: p.advancements.length < R.maxAdvancements
          ? Object.fromEntries(Object.entries(R.advancementCosts).map(([m, c]) => [m, c[p.advancements.length]]))
          : null,
        injuries: p.injuries, retired: p.retired,
      };
    }),
  };
}

module.exports = {
  CATALOG, RULES: R,
  validateDraft, applyAdvancement, serializeTeam,
  playerValue, teamValue, currentTeamValue, positionOf, clampName, id,
};
