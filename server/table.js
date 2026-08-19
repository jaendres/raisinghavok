// Game Night — live at-the-table play tracking API + realtime sync.
//
// Mounted from index.js with the app's existing auth helpers so this module
// adds routes without owning any auth policy of its own:
//
//   const gameNight = require('./table');
//   gameNight.mount(app, io, { authed, memberReader, builders, db });
//
// Design notes:
// - Unit stats are SNAPSHOTTED into the table at creation (via the builders
//   database) so a live game keeps working even if that database goes down
//   mid-session. A table is the record sheet, not a view over the archive.
// - State changes are single-field patches, validated hard server-side, then
//   broadcast over a socket.io namespace so every phone/iPad at the table
//   shows the same sheet.
// - Sockets mirror the Mad Ork Lands pattern in index.js: the connection is
//   open, identity comes from an optional token in the payload (db.userByToken)
//   — knowing the 6-hex join code is what admits you to a table's room, same
//   as at the physical table.
const crypto = require('crypto');
const store = require('./tablestore');
const alphaStrike = require('../public/builders/alphastrike.js');

// Game registry — v1 is Alpha Strike only, but the shape leaves room for more.
// leagueGame maps a table's summary onto the league tracker's match report.
const GAMES = {
  'battletech-as': { name: 'BattleTech: Alpha Strike', leagueGame: 'battletech' },
};

// Alpha Strike critical-hit maxima (per the master unit card):
// Engine 2 (second = destroyed), Fire Control 4, MP 4, Weapons 4.
const CRIT_MAX = { engine: 2, fireControl: 4, mp: 4, weapons: 4 };
const MAX_SIDES = 4;
const MAX_HEAT = 4;

const toInt = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : NaN);

// Freeze one hydrated builders unit into a table record-sheet entry.
function snapshotUnit(u) {
  const skill = Number.isFinite(Number(u.skill)) ? Math.round(Number(u.skill)) : 4;
  return {
    uid: crypto.randomBytes(4).toString('hex'),
    unitId: u.id,                       // MUL id, kept for linking back to the builder
    name: String(u.name || 'Unit').slice(0, 60),
    skill,
    pv: alphaStrike.pvForSkill(u.pv, skill),
    maxArmor: Math.max(0, toInt(u.armor) || 0),
    maxStruct: Math.max(1, toInt(u.structure) || 1),
    // Display-line stats — snapshotted too, so the card renders with the DB down.
    move: u.move ?? null,
    tmm: u.tmm ?? alphaStrike.tmmForMove(u.move),
    damage: u.damage ?? null,
    overheat: u.overheat ?? 0,
    abilities: u.abilities ?? '',
    // Live state
    armorHit: 0,
    structHit: 0,
    crits: { engine: 0, fireControl: 0, mp: 0, weapons: 0 },
    heat: 0,
    notes: '',
    destroyed: false,
  };
}

// A unit is out when structure is gone or the engine takes its second crit.
function autoDestroyed(u) {
  return u.structHit >= u.maxStruct || u.crits.engine >= CRIT_MAX.engine;
}

// Apply one validated patch to a unit. Returns { error } or { msg } (log line).
function applyUnitPatch(u, field, value) {
  if (field === 'armorHit') {
    const n = toInt(value);
    if (!(n >= 0 && n <= u.maxArmor)) return { error: `armor is 0-${u.maxArmor}` };
    u.armorHit = n;
    return { msg: `${u.name}: armor ${u.maxArmor - n}/${u.maxArmor}` };
  }
  if (field === 'structHit') {
    const n = toInt(value);
    if (!(n >= 0 && n <= u.maxStruct)) return { error: `structure is 0-${u.maxStruct}` };
    u.structHit = n;
    u.destroyed = autoDestroyed(u);
    return { msg: `${u.name}: structure ${u.maxStruct - n}/${u.maxStruct}${u.destroyed ? ' — DESTROYED' : ''}` };
  }
  if (field === 'heat') {
    const n = toInt(value);
    if (!(n >= 0 && n <= MAX_HEAT)) return { error: `heat is 0-${MAX_HEAT}` };
    u.heat = n;
    return { msg: `${u.name}: heat ${n}` };
  }
  if (field === 'notes') {
    if (typeof value !== 'string') return { error: 'notes must be text' };
    u.notes = value.slice(0, 200);
    return { msg: `${u.name}: note updated` };
  }
  if (field === 'destroyed') {
    u.destroyed = Boolean(value);
    return { msg: `${u.name}: ${u.destroyed ? 'marked destroyed' : 'back in da fight'}` };
  }
  if (field.startsWith('crits.')) {
    const key = field.slice('crits.'.length);
    if (!(key in CRIT_MAX)) return { error: 'unknown crit' };
    const n = toInt(value);
    if (!(n >= 0 && n <= CRIT_MAX[key])) return { error: `${key} crits are 0-${CRIT_MAX[key]}` };
    u.crits[key] = n;
    if (key === 'engine') u.destroyed = autoDestroyed(u);
    return { msg: `${u.name}: ${key} crit ${n}/${CRIT_MAX[key]}${u.destroyed && key === 'engine' ? ' — DESTROYED' : ''}` };
  }
  return { error: 'unknown field' };
}

// Lean listing shape for the lobby.
function summary(t) {
  return {
    id: t.id,
    game: t.game,
    gameName: GAMES[t.game]?.name ?? t.game,
    name: t.name,
    createdBy: t.createdBy,
    status: t.status,
    round: t.round,
    updated: t.updated,
    sides: (t.sides || []).map((s) => ({ name: s.name, owner: s.owner, units: s.units.length })),
  };
}

// Per-side destroyed counts -> the league's battletech match-report shape.
// kills = enemy units downed (everything destroyed on the other sides),
// lost = own units downed. vp comes from the caller — objectives are scored
// on the tabletop, not derivable from the record sheets.
function doneSummary(t, vpBySide) {
  const destroyed = (s) => s.units.filter((u) => u.destroyed).length;
  const totalDestroyed = t.sides.reduce((n, s) => n + destroyed(s), 0);
  return {
    game: GAMES[t.game]?.leagueGame ?? 'battletech',
    table: t.name,
    sides: t.sides.map((s) => ({
      name: s.name,
      vp: Math.max(0, toInt(vpBySide[s.name]) || 0),
      kills: totalDestroyed - destroyed(s),
      lost: destroyed(s),
    })),
  };
}

function mount(app, io, deps) {
  const { authed, memberReader, builders, db } = deps;

  // ---- realtime: one room per table on a dedicated namespace, so these
  // handlers never tangle with the Mad Ork Lands listeners on the root io.
  const nsp = io.of('/table');
  const room = (id) => 'table:' + id;

  nsp.on('connection', (socket) => {
    // Join by table id (the join code). Token is optional and only names you
    // in the log — mirroring index.js, where game sockets authenticate via an
    // optional token in the event payload rather than at connect.
    socket.on('join', (payload, cb) => {
      const { id, token } = payload || {};
      const t = store.get(id);
      if (!t) return cb && cb({ error: 'no such table' });
      socket.join(room(t.id));
      const user = token ? db.userByToken(token) : null;
      cb && cb({ ok: true, name: user ? user.name : null, table: t });
    });
    socket.on('leave', (payload) => {
      if (payload && payload.id) socket.leave(room(String(payload.id).toLowerCase()));
    });
  });

  const broadcast = (t, patchInfo) => {
    nsp.to(room(t.id)).emit('state', {
      id: t.id, round: t.round, status: t.status, updated: t.updated, ...patchInfo,
    });
    const last = t.log[t.log.length - 1];
    if (last) nsp.to(room(t.id)).emit('log', last);
  };

  // memberReader admits the bot key without a user; writes need a real account.
  const needUser = (req, res) => {
    const user = authed(req);
    if (!user) res.status(401).json({ error: 'log in first' });
    return user;
  };

  // ---- create a table ----
  // body: { game, name, sides: [{ name, forceName? }] }
  // forceName pulls the CREATOR's saved force and snapshots full unit stats.
  app.post('/api/table', memberReader, async (req, res) => {
    const user = needUser(req, res);
    if (!user) return;
    const { game, name, sides } = req.body || {};
    if (!GAMES[game]) return res.status(400).json({ error: 'unknown game' });
    const label = String(name || '').trim().slice(0, 60);
    if (!label) return res.status(400).json({ error: 'Give da table a name first.' });
    const rawSides = (Array.isArray(sides) ? sides : []).slice(0, MAX_SIDES);
    if (rawSides.length < 2) return res.status(400).json({ error: 'A game needs at least two sides.' });

    const built = [];
    for (const s of rawSides) {
      const sideName = String(s?.name || '').trim().slice(0, 40) || `Side ${built.length + 1}`;
      let units = [];
      let owner = null;
      if (s?.forceName) {
        const saved = db.forces(user.name)[String(s.forceName)];
        if (!saved) return res.status(404).json({ error: `No saved force called "${String(s.forceName).slice(0, 60)}".` });
        if (!builders.available()) return res.status(503).json({ error: 'Da unit database ain\'t hooked up — can\'t load dat force.' });
        try {
          units = (await builders.hydrateForce(saved.units)).map(snapshotUnit);
        } catch (err) {
          console.error('[table] hydrate:', err.message);
          return res.status(502).json({ error: 'Unit database is not answering.' });
        }
        owner = user.name;
      }
      built.push({ name: sideName, owner, units });
    }

    const r = store.create({ game, name: label, createdBy: user.name, sides: built });
    if (r.error) return res.status(400).json({ error: r.error });
    store.addLog(r.table, `Table opened by ${user.name}`);
    store.update(r.table);
    res.json(r.table);
  });

  // ---- my tables (created, own a side in, or joined by code) ----
  app.get('/api/table', memberReader, (req, res) => {
    const user = authed(req);
    // bot key without a user account sees everything (club-internal anyway)
    const tables = user ? store.byUser(user.name) : store.all();
    res.json({ tables: tables.map(summary) });
  });

  // ---- one table (this is also "join by code") ----
  app.get('/api/table/:id', memberReader, (req, res) => {
    const t = store.get(req.params.id);
    if (!t) return res.status(404).json({ error: 'No table wiv dat code.' });
    const user = authed(req);
    // Opening a table enrolls you: it shows up under "my tables" from then on.
    if (user) {
      const mine = user.name.toLowerCase();
      const known = t.createdBy.toLowerCase() === mine
        || t.sides.some((s) => (s.owner || '').toLowerCase() === mine)
        || (t.members || []).some((m) => m.toLowerCase() === mine);
      if (!known) {
        t.members.push(user.name);
        store.addLog(t, `${user.name} joined da table`);
        store.update(t);
        broadcast(t, {});
      }
    }
    res.json(t);
  });

  // ---- live state patch ----
  // body: { uid, field, value }  (uid omitted for table-level fields: 'round')
  app.post('/api/table/:id/state', memberReader, (req, res) => {
    const user = needUser(req, res);
    if (!user) return;
    const t = store.get(req.params.id);
    if (!t) return res.status(404).json({ error: 'no such table' });
    if (t.status === 'done') return res.status(400).json({ error: 'Dat table is finished.' });
    const { uid, field, value } = req.body || {};
    if (typeof field !== 'string') return res.status(400).json({ error: 'patch needs a field' });

    if (field === 'round') {
      const n = toInt(value);
      if (!(n >= 1 && n <= 999)) return res.status(400).json({ error: 'round is 1-999' });
      t.round = n;
      t.status = 'playing';
      store.addLog(t, `Round ${n}`);
      store.update(t);
      broadcast(t, {});
      return res.json({ ok: true, round: t.round });
    }

    const unit = t.sides.flatMap((s) => s.units).find((u) => u.uid === uid);
    if (!unit) return res.status(404).json({ error: 'no such unit' });
    const r = applyUnitPatch(unit, field, value);
    if (r.error) return res.status(400).json({ error: r.error });
    t.status = 'playing';
    store.addLog(t, r.msg);
    store.update(t);
    broadcast(t, { uid: unit.uid, unit });
    res.json({ ok: true, unit });
  });

  // ---- finalize ----
  // body: { vp: { [sideName]: number } } — VP is scored at the table.
  // Returns a summary shaped for the league's battletech match report.
  app.post('/api/table/:id/done', memberReader, (req, res) => {
    const user = needUser(req, res);
    if (!user) return;
    const t = store.get(req.params.id);
    if (!t) return res.status(404).json({ error: 'no such table' });
    const vpBySide = (req.body && typeof req.body.vp === 'object' && req.body.vp) || {};
    const sum = doneSummary(t, vpBySide);
    t.status = 'done';
    t.result = sum;
    store.addLog(t, `Game over — ${sum.sides.map((s) => `${s.name} ${s.vp}VP (${s.kills} kills)`).join(' vs ')}`);
    store.update(t);
    broadcast(t, { done: sum });
    res.json(sum);
  });

  // ---- scrap a table (creator or nobody) ----
  app.delete('/api/table/:id', memberReader, (req, res) => {
    const user = needUser(req, res);
    if (!user) return;
    const t = store.get(req.params.id);
    if (!t) return res.json({ ok: true });
    if (t.createdBy.toLowerCase() !== user.name.toLowerCase()) {
      return res.status(403).json({ error: 'Only da table\'s creator can scrap it.' });
    }
    nsp.to(room(t.id)).emit('scrapped', { id: t.id });
    res.json(store.remove(t.id));
  });

  // The lobby renders games from this registry so more games can slot in.
  app.get('/api/table-games', memberReader, (req, res) => {
    res.json(Object.entries(GAMES).map(([id, g]) => ({ id, name: g.name })));
  });
}

module.exports = { mount, GAMES, CRIT_MAX };
