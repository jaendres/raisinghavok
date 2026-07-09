// Mad Ork Lands — parts catalog. Loosely inspired by Gaslands-style vehicle
// building: a teef (cans) budget, build slots per hull, and weapon/upgrade
// costs. All stats here are the single source of truth — the garage UI reads
// this via /api/parts and the server validates every build against it.

const BUDGET = 50; // teef per rig

const HULLS = {
  warbike: {
    name: 'Warbike', desc: 'Fast, twitchy, made of spite. Dies if you sneeze on it.',
    cost: 5, slots: 1, hull: 14, topSpeed: 340, accel: 260, turn: 3.4,
    weight: 1, radius: 15,
  },
  grot_buggy: {
    name: 'Grot Buggy', desc: 'A lawnmower with ambitions. Nimble and cheap.',
    cost: 6, slots: 2, hull: 18, topSpeed: 310, accel: 230, turn: 3.0,
    weight: 1.2, radius: 18,
  },
  trukk: {
    name: 'Trukk', desc: 'Da classic. Room for dakka, goes okay, mostly stays in one piece.',
    cost: 12, slots: 2, hull: 28, topSpeed: 280, accel: 190, turn: 2.4,
    weight: 2, radius: 22,
  },
  speedsta: {
    name: 'Speedsta', desc: 'Kustom-tuned racer. Red paint from da factory.',
    cost: 15, slots: 2, hull: 24, topSpeed: 330, accel: 240, turn: 2.7,
    weight: 1.8, radius: 21,
  },
  gunwagon: {
    name: 'Gun Wagon', desc: 'A flatbed wiv opinions. Three slots of pure argument.',
    cost: 15, slots: 3, hull: 33, topSpeed: 260, accel: 170, turn: 2.1,
    weight: 2.5, radius: 25,
  },
  battlewagon: {
    name: 'Battlewagon', desc: 'Rolling fortress. Slow, angry, very hard to ignore.',
    cost: 22, slots: 4, hull: 45, topSpeed: 230, accel: 140, turn: 1.7,
    weight: 3.5, radius: 30,
  },
  war_rig: {
    name: 'War Rig', desc: 'WITNESS. Da biggest fing on da road. Ram it, regret it.',
    cost: 32, slots: 5, hull: 60, topSpeed: 220, accel: 120, turn: 1.4,
    weight: 5, radius: 36, ramBonus: 1.5,
  },
};

// arc: 'front' fires along facing (small cone), 'turret' fires at aim point,
// 'rear' drops behind the rig. ammo null = unlimited.
const WEAPONS = {
  grot_blasta: {
    name: 'Grot Blasta', desc: 'A grot wiv a gun on da back. Bad aim, good attitude.',
    cost: 1, slots: 0, type: 'hitscan', arc: 'turret',
    dmg: 0.3, range: 200, cooldown: 0.45, ammo: null, spread: 0.22,
  },
  big_shoota: {
    name: 'Big Shoota', desc: 'More dakka. Never enuff dakka. Never runs dry.',
    cost: 3, slots: 1, type: 'hitscan', arc: 'front',
    dmg: 0.4, range: 280, cooldown: 0.16, ammo: null, spread: 0.12,
  },
  twin_shoota: {
    name: 'Twin-Linked Shoota', desc: 'Two shootas welded togevver. Twice da noise.',
    cost: 5, slots: 1, type: 'hitscan', arc: 'front',
    dmg: 0.4, range: 280, cooldown: 0.09, ammo: null, spread: 0.15,
  },
  rokkit_launcha: {
    name: 'Rokkit Launcha', desc: 'Point away from face. Big boom, small blast.',
    cost: 4, slots: 1, type: 'projectile', arc: 'front',
    dmg: 3, range: 460, cooldown: 1.1, ammo: 14, speed: 520, aoe: 45,
  },
  kannon: {
    name: 'Killkannon', desc: 'A very big gun for makin very big holes.',
    cost: 8, slots: 2, type: 'projectile', arc: 'front',
    dmg: 5, range: 560, cooldown: 2.4, ammo: 10, speed: 640, aoe: 60,
  },
  skorcha: {
    name: 'Skorcha', desc: 'Burny burny burny. Short reach, long grudge.',
    cost: 6, slots: 1, type: 'flame', arc: 'front',
    dmg: 5, range: 150, cooldown: 0, ammo: 240, spread: 0.5, // dmg/sec, ammo = fuel ticks
  },
  harpoon: {
    name: 'Harpoon Launcha', desc: 'Stick em an slow em down. Fishin, ork style.',
    cost: 2, slots: 1, type: 'projectile', arc: 'front',
    dmg: 1, range: 380, cooldown: 1.6, ammo: 10, speed: 600, aoe: 0, slow: 2.2,
  },
  boomstikks: {
    name: 'Boomstikks', desc: 'A crate of stick grenades. Chuck an duck.',
    cost: 1, slots: 0, type: 'projectile', arc: 'front',
    dmg: 1.5, range: 240, cooldown: 0.9, ammo: 10, speed: 320, aoe: 50,
  },
  mine_droppa: {
    name: 'Mine Droppa', desc: 'Leave little surprises behind ya. Dey love surprises.',
    cost: 1, slots: 1, type: 'drop', arc: 'rear',
    dmg: 8, cooldown: 0.8, ammo: 6, hazard: 'mine', aoe: 62,
  },
  oil_squig: {
    name: 'Oil Squig Slick', desc: 'Squeezed squig juice. Whoever follows ya goes sideways.',
    cost: 2, slots: 1, type: 'drop', arc: 'rear',
    dmg: 0, cooldown: 0.8, ammo: 6, hazard: 'oil',
  },
  smoke_belcha: {
    name: 'Smoke Belcha', desc: 'Cough up a wall of black smog. Now ya see me...',
    cost: 1, slots: 1, type: 'drop', arc: 'rear',
    dmg: 0, cooldown: 0.8, ammo: 6, hazard: 'smoke',
  },
  wreckin_ball: {
    name: "Wreckin' Ball", desc: 'A ball an chain orbitin da rig. Get close, get flattened.',
    cost: 5, slots: 2, type: 'orbit', arc: 'none',
    dmg: 3, cooldown: 0.5, ammo: null, orbitRadius: 52,
  },
};

const UPGRADES = {
  eavy_armour: {
    name: "'Eavy Armour", desc: 'Bolt more metal on. +10 hull.',
    cost: 4, slots: 1, effect: { hull: 10 },
  },
  spiky_bitz: {
    name: 'Spiky Bitz', desc: 'Rams deal 60% more, an hurt you less.',
    cost: 3, slots: 1, effect: { ramDealt: 1.6, ramTaken: 0.85 },
  },
  boosta: {
    name: 'Nitro Boosta', desc: 'Press da red button. +80% speed for a bit. [E]',
    cost: 4, slots: 1, effect: { boost: true },
  },
  grot_riggers: {
    name: 'Grot Riggers', desc: 'Grots wiv hammers fix ya mid-fight. Slow hull regen.',
    cost: 5, slots: 1, effect: { regen: 0.9 },
  },
  turbocharga: {
    name: 'Turbocharga', desc: 'Moar power! +12% top speed.',
    cost: 3, slots: 1, effect: { speedMul: 1.12 },
  },
  rollcage: {
    name: 'Rollcage', desc: 'Take half damage from crashes an rams.',
    cost: 2, slots: 1, effect: { ramTaken: 0.5 },
  },
  red_paint: {
    name: 'Red Paint Job', desc: 'Red wunz go fasta. Everyone knows dat. +5% speed, no slot.',
    cost: 2, slots: 0, effect: { speedMul: 1.05 },
  },
};

// Validate a build { hull, weapons: [ids], upgrades: [ids], name } against
// budget and slots. Returns { ok, error?, cost, slots }.
function validateBuild(build) {
  if (!build || typeof build !== 'object') return { ok: false, error: 'no build' };
  const hull = HULLS[build.hull];
  if (!hull) return { ok: false, error: 'unknown hull' };
  const weapons = Array.isArray(build.weapons) ? build.weapons : [];
  const upgrades = Array.isArray(build.upgrades) ? build.upgrades : [];
  if (weapons.length > 6 || upgrades.length > 6) return { ok: false, error: 'too many parts' };

  let cost = hull.cost;
  let slots = 0;
  for (const id of weapons) {
    const w = WEAPONS[id];
    if (!w) return { ok: false, error: 'unknown weapon ' + id };
    cost += w.cost; slots += w.slots;
  }
  const seen = new Set();
  for (const id of upgrades) {
    const u = UPGRADES[id];
    if (!u) return { ok: false, error: 'unknown upgrade ' + id };
    if (seen.has(id)) return { ok: false, error: 'duplicate upgrade' };
    seen.add(id);
    cost += u.cost; slots += u.slots;
  }
  if (cost > BUDGET) return { ok: false, error: `over budget (${cost}/${BUDGET} teef)` };
  if (slots > hull.slots) return { ok: false, error: `not enuff slots (${slots}/${hull.slots})` };
  return { ok: true, cost, slots };
}

module.exports = { BUDGET, HULLS, WEAPONS, UPGRADES, validateBuild };
