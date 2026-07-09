// Mad Ork Lands — server-authoritative match simulation.
// Top-down arena battle royale: shrinking Scrap Storm, last rig rollin' wins.
const { HULLS, WEAPONS, UPGRADES } = require('./parts');

const TICK = 1 / 30;
const ARENA = 2400;
const MATCH_SIZE = 6;
const BOT_NAMES = ['Grimgutz', 'Skabrot', 'Wazdakka Jr', 'Mek Nogsplitta', 'Zoglug', 'Badthug', 'Snikkit', 'Gutrippa', 'Drivin Miss Dakka', 'Morkfist'];
const BOT_BUILDS = [
  { hull: 'trukk', weapons: ['big_shoota', 'rokkit_launcha'], upgrades: ['eavy_armour', 'red_paint'] },
  { hull: 'warbike', weapons: ['twin_shoota'], upgrades: ['red_paint'] },
  { hull: 'gunwagon', weapons: ['kannon', 'big_shoota'], upgrades: ['rollcage'] },
  { hull: 'speedsta', weapons: ['skorcha', 'boomstikks'], upgrades: ['boosta', 'red_paint'] },
  { hull: 'battlewagon', weapons: ['big_shoota', 'big_shoota', 'mine_droppa'], upgrades: ['spiky_bitz'] },
  { hull: 'grot_buggy', weapons: ['rokkit_launcha', 'grot_blasta'], upgrades: ['turbocharga'] },
];

let nextEntityId = 1;

function makeRig(id, name, build, isBot, color) {
  const hull = HULLS[build.hull];
  let maxHull = hull.hull, speedMul = 1, regen = 0, ramDealt = hull.ramBonus || 1, ramTaken = 1, hasBoost = false;
  for (const uid of build.upgrades || []) {
    const e = (UPGRADES[uid] || {}).effect || {};
    if (e.hull) maxHull += e.hull;
    if (e.speedMul) speedMul *= e.speedMul;
    if (e.regen) regen += e.regen;
    if (e.ramDealt) ramDealt *= e.ramDealt;
    if (e.ramTaken) ramTaken *= e.ramTaken;
    if (e.boost) hasBoost = true;
  }
  return {
    id, name, isBot, color, build,
    hullId: build.hull, radius: hull.radius, weight: hull.weight,
    topSpeed: hull.topSpeed * speedMul, accel: hull.accel, turn: hull.turn,
    hp: maxHull, maxHp: maxHull, regen, ramDealt, ramTaken, hasBoost,
    x: 0, y: 0, angle: 0, speed: 0,
    input: { steer: 0, throttle: 0, fire: false, drop: false, boost: false },
    weapons: (build.weapons || []).map(wid => ({ id: wid, cd: 0, ammo: WEAPONS[wid].ammo })),
    boostCd: 0, boostTime: 0, oilTime: 0, slowTime: 0,
    alive: true, kills: 0, damage: 0, lastHitBy: null, lastHitTime: 0,
    ai: isBot ? { turnBias: (Math.random() - 0.5) * 0.6, retarget: 0, target: null } : null,
  };
}

class Match {
  constructor(io, roomId, entrants, onEnd) {
    this.io = io;
    this.room = roomId;
    this.onEnd = onEnd;
    this.rigs = new Map();
    this.projectiles = [];
    this.hazards = [];   // mines, oil, smoke
    this.events = [];    // one-shot fx for clients
    this.time = 0;
    this.over = false;
    this.placements = [];

    // Scrap Storm: shrinks from full arena to a small circle
    this.zone = { x: 0, y: 0, r: ARENA * 0.7, targetR: 140, duration: 150 };

    // scattered scrap-pile obstacles
    this.obstacles = [];
    for (let i = 0; i < 22; i++) {
      const a = Math.random() * Math.PI * 2, d = 200 + Math.random() * (ARENA * 0.62);
      this.obstacles.push({ x: Math.cos(a) * d, y: Math.sin(a) * d, r: 28 + Math.random() * 40 });
    }

    const colors = ['#ff6a1a', '#ffd23f', '#7ec850', '#4fc3f7', '#e05656', '#c07cff', '#f78fb3', '#9ee7d8'];
    let i = 0;
    for (const e of entrants) {
      const rig = makeRig(e.id, e.name, e.build, false, colors[i % colors.length]);
      rig.socket = e.socket;
      rig.userName = e.userName; // null for guests
      this.spawn(rig, i, entrants.length + Math.max(0, MATCH_SIZE - entrants.length));
      this.rigs.set(e.id, rig);
      i++;
    }
    for (let b = entrants.length; b < MATCH_SIZE; b++) {
      const id = 'bot-' + nextEntityId++;
      const rig = makeRig(id, BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)] + ' [Bot]',
        BOT_BUILDS[b % BOT_BUILDS.length], true, colors[i % colors.length]);
      this.spawn(rig, i, MATCH_SIZE);
      this.rigs.set(id, rig);
      i++;
    }

    this.interval = setInterval(() => this.tick(), TICK * 1000);
  }

  spawn(rig, index, total) {
    const a = (index / total) * Math.PI * 2;
    const d = ARENA * 0.55;
    rig.x = Math.cos(a) * d;
    rig.y = Math.sin(a) * d;
    rig.angle = a + Math.PI; // face center
  }

  setInput(id, input) {
    const rig = this.rigs.get(id);
    if (!rig || !rig.alive) return;
    rig.input.steer = Math.max(-1, Math.min(1, +input.steer || 0));
    rig.input.throttle = Math.max(-1, Math.min(1, +input.throttle || 0));
    rig.input.fire = !!input.fire;
    rig.input.drop = !!input.drop;
    rig.input.boost = !!input.boost;
  }

  removePlayer(id) {
    const rig = this.rigs.get(id);
    if (rig && rig.alive && !this.over) this.kill(rig, null, 'left da fight');
    if (rig) rig.socket = null;
  }

  aliveRigs() { return [...this.rigs.values()].filter(r => r.alive); }

  tick() {
    const dt = TICK;
    this.time += dt;

    // zone shrink
    const z = this.zone;
    const startR = ARENA * 0.7;
    z.r = Math.max(z.targetR, startR - (startR - z.targetR) * (this.time / z.duration));

    for (const rig of this.aliveRigs()) {
      if (rig.ai) this.botThink(rig, dt);
      this.movePhysics(rig, dt);
      this.fireWeapons(rig, dt);
      if (rig.regen && rig.hp < rig.maxHp) rig.hp = Math.min(rig.maxHp, rig.hp + rig.regen * dt);
      // storm damage
      const dist = Math.hypot(rig.x - z.x, rig.y - z.y);
      if (dist > z.r) this.damage(rig, (1.2 + this.time / 60) * dt, null, 'da Scrap Storm');
    }

    this.stepProjectiles(dt);
    this.stepHazards(dt);
    this.rigCollisions(dt);
    this.checkEnd();
    this.broadcast();
    this.events = [];
  }

  movePhysics(rig, dt) {
    const inp = rig.input;
    if (inp.boost && rig.hasBoost && rig.boostCd <= 0) {
      rig.boostTime = 1.2; rig.boostCd = 6;
      this.events.push({ t: 'boost', id: rig.id });
    }
    rig.boostCd = Math.max(0, rig.boostCd - dt);
    rig.boostTime = Math.max(0, rig.boostTime - dt);
    rig.oilTime = Math.max(0, rig.oilTime - dt);
    rig.slowTime = Math.max(0, rig.slowTime - dt);

    let top = rig.topSpeed * (rig.boostTime > 0 ? 1.8 : 1) * (rig.slowTime > 0 ? 0.55 : 1);
    const grip = rig.oilTime > 0 ? 0.15 : 1;

    // throttle
    if (inp.throttle > 0) rig.speed += rig.accel * inp.throttle * dt;
    else if (inp.throttle < 0) rig.speed += rig.accel * 1.4 * inp.throttle * dt; // brake/reverse
    else rig.speed *= (1 - 0.8 * dt); // coast friction
    rig.speed = Math.max(-top * 0.4, Math.min(top, rig.speed));

    // steering scales with speed, damped near zero
    const speedFactor = Math.min(1, Math.abs(rig.speed) / (rig.topSpeed * 0.3));
    rig.angle += inp.steer * rig.turn * speedFactor * Math.sign(rig.speed || 1) * grip * dt;

    rig.x += Math.cos(rig.angle) * rig.speed * dt;
    rig.y += Math.sin(rig.angle) * rig.speed * dt;

    // arena hard edge
    const edge = ARENA * 0.72;
    const d = Math.hypot(rig.x, rig.y);
    if (d > edge) { rig.x *= edge / d; rig.y *= edge / d; rig.speed *= 0.5; }

    // obstacles
    for (const o of this.obstacles) {
      const dx = rig.x - o.x, dy = rig.y - o.y;
      const dist = Math.hypot(dx, dy), min = o.r + rig.radius;
      if (dist < min && dist > 0) {
        rig.x = o.x + (dx / dist) * min;
        rig.y = o.y + (dy / dist) * min;
        if (Math.abs(rig.speed) > 140) {
          this.damage(rig, Math.abs(rig.speed) / 140 * rig.ramTaken, null, 'a scrap pile');
          this.events.push({ t: 'crash', x: rig.x, y: rig.y });
        }
        rig.speed *= 0.4;
      }
    }
  }

  fireWeapons(rig, dt) {
    for (const slot of rig.weapons) {
      const w = WEAPONS[slot.id];
      slot.cd = Math.max(0, slot.cd - dt);

      if (w.type === 'orbit') { this.orbitBall(rig, slot, w, dt); continue; }

      const wants = (w.arc === 'rear' || w.type === 'drop') ? rig.input.drop : rig.input.fire;
      if (!wants || slot.cd > 0) continue;
      if (slot.ammo !== null && slot.ammo <= 0) continue;

      if (w.type === 'hitscan') {
        slot.cd = w.cooldown;
        const spread = (Math.random() - 0.5) * (w.spread || 0.1);
        let ang = rig.angle + spread;
        if (w.arc === 'turret') { // grot aims at nearest enemy
          const t = this.nearestEnemy(rig, w.range);
          if (t) ang = Math.atan2(t.y - rig.y, t.x - rig.x) + spread;
        }
        const hit = this.raycast(rig, ang, w.range);
        const ex = rig.x + Math.cos(ang) * (hit ? hit.dist : w.range);
        const ey = rig.y + Math.sin(ang) * (hit ? hit.dist : w.range);
        this.events.push({ t: 'shot', x1: rig.x, y1: rig.y, x2: ex, y2: ey });
        if (hit && hit.rig) this.damage(hit.rig, w.dmg, rig, 'dakka');
      } else if (w.type === 'projectile') {
        slot.cd = w.cooldown;
        if (slot.ammo !== null) slot.ammo--;
        const ang = rig.angle + (Math.random() - 0.5) * 0.04;
        this.projectiles.push({
          id: nextEntityId++, kind: slot.id, owner: rig.id,
          x: rig.x + Math.cos(ang) * (rig.radius + 6), y: rig.y + Math.sin(ang) * (rig.radius + 6),
          vx: Math.cos(ang) * w.speed + Math.cos(rig.angle) * rig.speed * 0.5,
          vy: Math.sin(ang) * w.speed + Math.sin(rig.angle) * rig.speed * 0.5,
          ttl: w.range / w.speed, dmg: w.dmg, aoe: w.aoe || 0, slow: w.slow || 0,
        });
      } else if (w.type === 'flame') {
        if (slot.ammo !== null) { slot.ammo -= 1; if (slot.ammo < 0) { slot.ammo = 0; continue; } }
        this.events.push({ t: 'flame', id: rig.id, a: rig.angle, r: w.range });
        for (const other of this.aliveRigs()) {
          if (other === rig) continue;
          const dx = other.x - rig.x, dy = other.y - rig.y;
          const dist = Math.hypot(dx, dy);
          if (dist < w.range + other.radius) {
            const da = Math.abs(normAngle(Math.atan2(dy, dx) - rig.angle));
            if (da < w.spread) this.damage(other, w.dmg * dt, rig, 'da skorcha');
          }
        }
      } else if (w.type === 'drop') {
        slot.cd = w.cooldown;
        if (slot.ammo !== null) slot.ammo--;
        const bx = rig.x - Math.cos(rig.angle) * (rig.radius + 14);
        const by = rig.y - Math.sin(rig.angle) * (rig.radius + 14);
        if (w.hazard === 'mine') this.hazards.push({ id: nextEntityId++, kind: 'mine', x: bx, y: by, r: 16, aoe: w.aoe, dmg: w.dmg, owner: rig.id, arm: 0.6, ttl: 60 });
        if (w.hazard === 'oil') this.hazards.push({ id: nextEntityId++, kind: 'oil', x: bx, y: by, r: 46, owner: rig.id, ttl: 14 });
        if (w.hazard === 'smoke') this.hazards.push({ id: nextEntityId++, kind: 'smoke', x: bx, y: by, r: 64, owner: rig.id, ttl: 9 });
      }
    }
  }

  orbitBall(rig, slot, w, dt) {
    slot.orbitA = (slot.orbitA || 0) + 4.2 * dt;
    const bx = rig.x + Math.cos(slot.orbitA) * w.orbitRadius;
    const by = rig.y + Math.sin(slot.orbitA) * w.orbitRadius;
    slot.bx = bx; slot.by = by;
    if (slot.cd > 0) return;
    for (const other of this.aliveRigs()) {
      if (other === rig) continue;
      if (Math.hypot(other.x - bx, other.y - by) < other.radius + 12) {
        slot.cd = w.cooldown;
        this.damage(other, w.dmg, rig, "da wreckin' ball");
        this.events.push({ t: 'crash', x: bx, y: by });
        other.speed *= 0.6;
        break;
      }
    }
  }

  nearestEnemy(rig, range) {
    let best = null, bd = range;
    for (const other of this.aliveRigs()) {
      if (other === rig) continue;
      const d = Math.hypot(other.x - rig.x, other.y - rig.y);
      if (d < bd && !this.inSmoke(other)) { bd = d; best = other; }
    }
    return best;
  }

  inSmoke(rig) {
    return this.hazards.some(h => h.kind === 'smoke' && Math.hypot(rig.x - h.x, rig.y - h.y) < h.r);
  }

  raycast(shooter, angle, range) {
    const dx = Math.cos(angle), dy = Math.sin(angle);
    let best = null, bd = range;
    for (const other of this.aliveRigs()) {
      if (other === shooter) continue;
      // distance from ray to rig center
      const ox = other.x - shooter.x, oy = other.y - shooter.y;
      const proj = ox * dx + oy * dy;
      if (proj < 0 || proj > bd) continue;
      const perp = Math.abs(ox * dy - oy * dx);
      if (perp < other.radius + 4) { bd = proj; best = { rig: other, dist: proj }; }
    }
    // obstacles block shots
    for (const o of this.obstacles) {
      const ox = o.x - shooter.x, oy = o.y - shooter.y;
      const proj = ox * dx + oy * dy;
      if (proj < 0 || proj > bd) continue;
      const perp = Math.abs(ox * dy - oy * dx);
      if (perp < o.r) { bd = proj; best = { rig: null, dist: proj }; }
    }
    return best;
  }

  stepProjectiles(dt) {
    for (const p of this.projectiles) {
      p.ttl -= dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      let boom = p.ttl <= 0;
      if (!boom) for (const o of this.obstacles) {
        if (Math.hypot(p.x - o.x, p.y - o.y) < o.r) { boom = true; break; }
      }
      if (!boom) for (const rig of this.aliveRigs()) {
        if (rig.id === p.owner) continue;
        if (Math.hypot(p.x - rig.x, p.y - rig.y) < rig.radius + 6) {
          boom = true;
          if (p.slow) { rig.slowTime = p.slow; this.events.push({ t: 'harpoon', id: rig.id }); }
          if (!p.aoe) this.damage(rig, p.dmg, this.rigs.get(p.owner), 'a rokkit');
          break;
        }
      }
      if (boom) {
        p.dead = true;
        if (p.aoe) {
          this.events.push({ t: 'boom', x: p.x, y: p.y, r: p.aoe });
          for (const rig of this.aliveRigs()) {
            const d = Math.hypot(p.x - rig.x, p.y - rig.y);
            if (d < p.aoe + rig.radius) this.damage(rig, p.dmg * (1 - d / (p.aoe + rig.radius) * 0.5), this.rigs.get(p.owner), 'a big boom');
          }
        }
      }
    }
    this.projectiles = this.projectiles.filter(p => !p.dead);
  }

  stepHazards(dt) {
    for (const h of this.hazards) {
      h.ttl -= dt;
      if (h.arm > 0) { h.arm -= dt; continue; }
      if (h.kind === 'mine') {
        for (const rig of this.aliveRigs()) {
          if (Math.hypot(rig.x - h.x, rig.y - h.y) < rig.radius + h.r) {
            h.ttl = -1;
            this.events.push({ t: 'boom', x: h.x, y: h.y, r: h.aoe });
            for (const r2 of this.aliveRigs()) {
              const d = Math.hypot(r2.x - h.x, r2.y - h.y);
              if (d < h.aoe + r2.radius) this.damage(r2, h.dmg, this.rigs.get(h.owner), 'a mine');
            }
            break;
          }
        }
      } else if (h.kind === 'oil') {
        for (const rig of this.aliveRigs()) {
          if (rig.id !== h.owner && Math.hypot(rig.x - h.x, rig.y - h.y) < rig.radius + h.r) rig.oilTime = 0.8;
        }
      }
    }
    this.hazards = this.hazards.filter(h => h.ttl > 0);
  }

  rigCollisions() {
    const rigs = this.aliveRigs();
    for (let i = 0; i < rigs.length; i++) for (let j = i + 1; j < rigs.length; j++) {
      const a = rigs[i], b = rigs[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.hypot(dx, dy), min = a.radius + b.radius;
      if (dist >= min || dist === 0) continue;
      const nx = dx / dist, ny = dy / dist;
      // separate by weight
      const total = a.weight + b.weight;
      const push = (min - dist);
      a.x -= nx * push * (b.weight / total); a.y -= ny * push * (b.weight / total);
      b.x += nx * push * (a.weight / total); b.y += ny * push * (a.weight / total);
      // impact = closing speed along normal
      const va = a.speed * (Math.cos(a.angle) * nx + Math.sin(a.angle) * ny);
      const vb = b.speed * (Math.cos(b.angle) * nx + Math.sin(b.angle) * ny);
      const impact = Math.max(0, va - vb);
      const recentRam = (this.time - (a.lastRam || -9) < 0.5) || (this.time - (b.lastRam || -9) < 0.5);
      if (impact > 130 && !recentRam) {
        a.lastRam = b.lastRam = this.time;
        const base = impact / 200;
        this.damage(b, base * a.ramDealt * (a.weight / b.weight) * b.ramTaken, a, 'a ram');
        this.damage(a, base * 0.5 * (b.weight / a.weight) * a.ramTaken, b, 'a ram');
        this.events.push({ t: 'crash', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        a.speed *= 0.55; b.speed *= 0.55;
      }
    }
  }

  damage(rig, amount, attacker, how) {
    if (!rig.alive || this.over || amount <= 0) return;
    rig.hp -= amount;
    if (attacker && attacker !== rig) {
      attacker.damage += amount;
      rig.lastHitBy = attacker.id;
      rig.lastHitTime = this.time;
    }
    if (rig.hp <= 0) this.kill(rig, attacker, how);
  }

  kill(rig, attacker, how) {
    rig.alive = false;
    rig.hp = 0;
    // credit recent damager for storm/obstacle deaths
    if (!attacker && rig.lastHitBy && this.time - rig.lastHitTime < 6) {
      attacker = this.rigs.get(rig.lastHitBy);
    }
    if (attacker && attacker !== rig && attacker.alive) attacker.kills++;
    this.placements.unshift(rig);
    this.events.push({ t: 'wreck', x: rig.x, y: rig.y, name: rig.name, by: attacker ? attacker.name : how });
  }

  checkEnd() {
    if (this.over) return;
    const alive = this.aliveRigs();
    const humansConnected = [...this.rigs.values()].some(r => !r.isBot && r.socket);
    if (alive.length <= 1 || !humansConnected) {
      this.over = true;
      clearInterval(this.interval);
      if (alive[0]) this.placements.unshift(alive[0]);
      const results = this.placements.map((r, i) => ({
        place: i + 1, name: r.name, isBot: r.isBot, kills: r.kills, damage: Math.round(r.damage),
      }));
      this.io.to(this.room).emit('matchOver', { results });
      this.onEnd(this, results);
    }
  }

  broadcast() {
    const state = {
      t: Math.round(this.time * 10) / 10,
      zone: { x: this.zone.x, y: this.zone.y, r: Math.round(this.zone.r) },
      rigs: [...this.rigs.values()].map(r => ({
        id: r.id, name: r.name, color: r.color, hull: r.hullId,
        x: Math.round(r.x), y: Math.round(r.y), a: Math.round(r.angle * 100) / 100,
        hp: Math.round(r.hp * 10) / 10, maxHp: r.maxHp, alive: r.alive,
        boost: r.boostTime > 0, oil: r.oilTime > 0,
        ball: r.weapons.filter(s => WEAPONS[s.id].type === 'orbit').map(s => ({ x: Math.round(s.bx || r.x), y: Math.round(s.by || r.y) }))[0] || null,
        ammo: r.weapons.map(s => ({ id: s.id, ammo: s.ammo })),
        boostCd: Math.round(r.boostCd * 10) / 10,
      })),
      projectiles: this.projectiles.map(p => ({ id: p.id, kind: p.kind, x: Math.round(p.x), y: Math.round(p.y) })),
      hazards: this.hazards.map(h => ({ id: h.id, kind: h.kind, x: Math.round(h.x), y: Math.round(h.y), r: h.r })),
      events: this.events,
    };
    this.io.to(this.room).emit('state', state);
  }
}

function normAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

// ---- Bot AI ----
Match.prototype.botThink = function (rig, dt) {
  const ai = rig.ai;
  ai.retarget -= dt;
  if (ai.retarget <= 0 || !ai.target || !ai.target.alive) {
    ai.retarget = 1.5 + Math.random();
    ai.target = this.nearestEnemy(rig, 9999);
  }
  const z = this.zone;
  const distFromCenter = Math.hypot(rig.x - z.x, rig.y - z.y);
  let tx, ty;
  if (distFromCenter > z.r * 0.85) { tx = z.x; ty = z.y; } // run from storm first
  else if (ai.target) { tx = ai.target.x; ty = ai.target.y; }
  else { tx = z.x; ty = z.y; }

  const want = Math.atan2(ty - rig.y, tx - rig.x);
  const da = normAngle(want - rig.angle);
  rig.input.steer = Math.max(-1, Math.min(1, da * 2 + ai.turnBias * Math.sin(this.time * 0.7)));
  const targetDist = ai.target ? Math.hypot(ai.target.x - rig.x, ai.target.y - rig.y) : 999;
  rig.input.throttle = targetDist < 120 && Math.abs(da) > 2 ? -0.5 : 1;
  rig.input.fire = !!ai.target && Math.abs(da) < 0.35 && targetDist < 360
    && this.time > 3 && Math.random() < 0.8; // hold fire early, jitter trigger finger
  rig.input.drop = targetDist < 160 && Math.random() < 0.02;
  rig.input.boost = rig.hasBoost && distFromCenter > z.r && rig.boostCd <= 0;
};

module.exports = { Match, MATCH_SIZE, ARENA };
