// Trench Crusade warband builder — standalone page, same account plumbing as
// the builders SPA. The catalog comes from /api/builders/trenchcrusade/catalog
// (compiled from the freely published official rules — see its meta block for
// sources and admitted gaps). Warbands live in localStorage under
// 'tc-warbands'; nothing is stored server-side.

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
const SAVE_KEY = 'tc-warbands';
let me = null;
let discordSso = false;
let CAT = null;          // catalog
let band = null;         // working warband
const openArm = new Set();   // expanded armoury items

// Escapes quotes too: names like "Zamburak" or Assassin's Dagger land inside
// attribute values and onclick args.
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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

function loginWall() {
  const href = discordSso ? '/api/auth/discord?return=/builders/trenchcrusade/' : '/play/';
  $app.innerHTML = `
    <h1>Trench Crusade</h1>
    <div class="sub">Members only</div>
    <div class="card" style="text-align:center;padding:40px">
      <p class="muted" style="margin-bottom:20px">Da warband builder is for club members.<br>
      Log in wiv yer Discord to get in.</p>
      <a class="btn" href="${href}">Log in with Discord</a>
    </div>`;
}

// ---------------------------------------------------------------- helpers

const uid = () => Math.random().toString(16).slice(2, 10);
const saves = () => { try { return JSON.parse(localStorage.getItem(SAVE_KEY)) || {}; } catch { return {}; } };
const setSaves = (s) => localStorage.setItem(SAVE_KEY, JSON.stringify(s));

const wb = (key) => CAT.warbands.find((w) => w.key === key);
const bandDef = () => wb(band.key);
const mercsFor = (key) => wb('mercenaries').units
  .filter((u) => u.hiredBy === 'any' || (u.hiredBy || []).includes(key));

// A roster entry's definition: own faction list, or the mercenary list.
function unitDef(entry) {
  return entry.merc
    ? wb('mercenaries').units.find((u) => u.name === entry.type)
    : bandDef().units.find((u) => u.name === entry.type);
}
const itemDef = (name) => bandDef().armoury.find((a) => a.name === name);
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// Items a unit may buy: category flag on the unit, or a unit-specific
// allowance named in its `extra` list. Mercenaries come with fixed kit and
// buy nothing.
function allowedItems(entry) {
  const def = unitDef(entry);
  if (!def || entry.merc) return [];
  const catFlag = { melee: 'weapons', ranged: 'weapons', grenade: 'grenades', equipment: 'equipment', armour: 'armour' };
  return bandDef().armoury.filter((a) =>
    def.equip[catFlag[a.category]]
    || (def.extra || []).some((x) => norm(x) === norm(a.name)));
}

function unitCost(entry) {
  const def = unitDef(entry);
  if (!def) return { ducats: 0, glory: 0 };
  let ducats = def.ducats, glory = def.glory;
  for (const g of entry.items) {
    const it = itemDef(g);
    if (it) { ducats += it.ducats; glory += it.glory; }
  }
  return { ducats, glory };
}

function totals() {
  const t = { ducats: 0, glory: 0 };
  for (const e of band.units) {
    const c = unitCost(e);
    t.ducats += c.ducats;
    t.glory += c.glory;
  }
  return t;
}

const STAT_COLS = [
  ['movement', 'Move'], ['ranged', 'Ranged'], ['melee', 'Melee'], ['armour', 'Armour'], ['base', 'Base'],
];

function statlineHtml(u) {
  const rows = [u.stats, ...(u.altProfiles || [])];
  return `<div class="profile-wrap"><table class="statline">
    <tr>${(u.altProfiles ? ['<th></th>'] : []).join('')}${STAT_COLS.map(([, h]) => `<th>${h}</th>`).join('')}</tr>
    ${rows.map((s, i) => `<tr>
      ${u.altProfiles ? `<td style="font-size:11px;color:var(--dust)">${esc(i ? s.name : u.name)}</td>` : ''}
      ${STAT_COLS.map(([k]) => `<td>${esc(s[k] ?? '-')}</td>`).join('')}
    </tr>`).join('')}
  </table></div>`;
}

function statSummary(s) {
  return `${s.movement} — R ${s.ranged} / M ${s.melee} — Armour ${s.armour}`;
}

const costHtml = (d, g) => [
  d ? `<span class="du">${d}d</span>` : '',
  g ? `<span class="gl">${g}g</span>` : '',
].filter(Boolean).join(' ') || '<span class="du">0d</span>';

// ---------------------------------------------------------------- warnings

function warnings() {
  const w = [];
  const def = bandDef();
  const t = totals();

  if (t.ducats > band.ducats) w.push(`Over budget by ${t.ducats - band.ducats} ducats.`);
  if (band.glory > 0 && t.glory > band.glory) w.push(`Over glory allowance by ${t.glory - band.glory} glory.`);
  if (band.glory === 0 && t.glory > 0) {
    w.push(`Spending ${t.glory} glory — agree an allowance with yer opponent (the rules suggest 6 for one-off games).`);
  }

  // leader requirements
  for (const req of def.requires || []) {
    const n = band.units.filter((e) => !e.merc && req.anyOf.includes(e.type)).length;
    if (n < req.min) w.push(`Must include ${req.min} of: ${req.anyOf.join(' or ')}.`);
  }

  // unit limits
  const counts = {};
  for (const e of band.units) counts[e.type] = (counts[e.type] || 0) + 1;
  for (const [type, n] of Object.entries(counts)) {
    const d = band.units.map(unitDef).find((x) => x && x.name === type)
      || def.units.find((x) => x.name === type)
      || wb('mercenaries').units.find((x) => x.name === type);
    if (d && d.max != null && n > d.max) w.push(`${n}× ${type} — maximum ${d.max}.`);
  }

  // armoury limits (warband-wide)
  const itemCounts = {};
  for (const e of band.units) for (const g of e.items) itemCounts[g] = (itemCounts[g] || 0) + 1;
  for (const [name, n] of Object.entries(itemCounts)) {
    const it = itemDef(name);
    if (it && it.limit != null && n > it.limit) w.push(`${n}× ${name} — Limit: ${it.limit} for the whole warband.`);
  }

  // faction quirks the catalog records as text
  if (band.key === 'hereticLegion') {
    for (const e of band.units.filter((x) => x.type === 'Wretched')) {
      const pricey = e.items.filter((g) => (itemDef(g)?.ducats || 0) > 10);
      if (pricey.length) w.push(`${e.label || 'Wretched'}: Wretched battlekit must cost 10 ducats or less each (${pricey.join(', ')}).`);
      const weapons = e.items.filter((g) => ['melee', 'ranged', 'grenade'].includes(itemDef(g)?.category));
      if (!weapons.length) w.push(`${e.label || 'Wretched'}: every Wretched must carry at least 1 weapon.`);
    }
  }
  if (band.key === 'court') {
    const wretched = band.units.filter((e) => e.type === 'Wretched').length;
    const demonic = band.units.filter((e) => (unitDef(e)?.keywords || []).includes('DEMONIC')).length;
    if (wretched && wretched >= demonic) {
      w.push(`${wretched} Wretched but only ${demonic} DEMONIC models — Wretched must be outnumbered by DEMONIC models.`);
    }
  }
  return w;
}

// ---------------------------------------------------------------- views

function render() {
  if (!band) return renderChooser();
  renderBuilder();
}

function renderChooser() {
  const saved = saves();
  const savedHtml = Object.keys(saved).length ? `
    <h2>Saved Warbands</h2>
    <div class="card-grid">${Object.entries(saved).map(([n, b], i) => `
      <div class="card wb-card builder-card" onclick="TC.load(${i})">
        <div class="game">${esc(wb(b.key)?.name || b.key)}</div>
        <h3>${esc(n)}</h3>
        <div class="meta">${b.units.length} models — ${b.ducats} ducat game</div>
      </div>`).join('')}
    </div>` : '';

  $app.innerHTML = `
    <h1>Trench Crusade Warband Builder</h1>
    <div class="sub">${esc(CAT.meta.game)} — rules ${esc(CAT.meta.rulesVersion)}</div>
    <h2>Muster a Warband</h2>
    <div class="wb-grid">${CAT.warbands.map((w) => `
      <div class="card wb-card builder-card" onclick="TC.newBand('${w.key}')">
        <div class="game ${w.alignment === 'Fallen' ? 'fallen' : ''}">${esc(w.alignment)}</div>
        <h3>${esc(w.name)}</h3>
        <div class="meta">${esc(w.lore)}</div>
      </div>`).join('')}
    </div>
    ${savedHtml}
    <p class="muted" style="margin-top:20px">Compiled from the freely published official rules —
    the printed warband lists always win an argument over this builder.</p>`;
}

function renderBuilder() {
  const def = bandDef();
  const t = totals();
  const warns = warnings();
  const mercs = band.key === 'mercenaries' ? [] : mercsFor(band.key);

  $app.innerHTML = `
    <div class="crumb"><a href="#" onclick="TC.back();return false">← all warbands</a></div>
    <h1>${esc(def.name)}</h1>
    <div class="sub">${esc(def.alignment)} — ${esc(def.lore)}</div>
    ${def.special.length ? `<div class="rulebox"><ul>${def.special.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>` : ''}
    ${warns.length ? `<div class="warnbox"><ul>${warns.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
    <div class="bt-layout">
      <div class="bt-pane bt-filters">
        <h2>Warband</h2>
        <label>Warband name
          <input id="bname" value="${esc(band.name)}" maxlength="40" onchange="TC.setName(this.value)">
        </label>
        <label>Ducat budget
          <input type="number" min="0" step="10" value="${band.ducats}" onchange="TC.setDucats(this.value)">
        </label>
        <label>Glory allowance (0 = campaign only)
          <input type="number" min="0" step="1" value="${band.glory}" onchange="TC.setGlory(this.value)">
        </label>
        <div class="force-actions">
          <button class="btn small" onclick="TC.save()">Save</button>
          <button class="btn small ghost" onclick="TC.exportSheet()">Export</button>
        </div>
        <h2 style="margin-top:20px">Saved</h2>
        ${Object.keys(saves()).map((n, i) => `
          <div class="stafrow"><a href="#" onclick="TC.load(${i});return false">${esc(n)}</a>
            <button class="rmbtn" title="delete" onclick="TC.del(${i})">✕</button></div>`).join('') || '<p class="muted">Nothing saved yet.</p>'}
      </div>

      <div class="bt-pane">
        <h2>Recruit</h2>
        <div class="bt-scroll">
          <table class="tc-table">
            <tr><th class="c-add"></th><th class="c-name">Model</th><th class="c-cost">Cost</th></tr>
            ${def.units.map((u, i) => recruitRow(u, `TC.add(${i})`)).join('')}
          </table>
          ${mercs.length ? `
            <h2 style="margin-top:18px">Hire Mercenaries</h2>
            <table class="tc-table">
              <tr><th class="c-add"></th><th class="c-name">Mercenary</th><th class="c-cost">Glory</th></tr>
              ${mercs.map((u, i) => recruitRow(u, `TC.addMerc(${i})`)).join('')}
            </table>` : ''}
          ${def.armoury.length ? `<div class="armoury">
            <h2 style="margin-top:18px">Armoury</h2>
            ${armouryHtml(def)}
          </div>` : ''}
        </div>
      </div>

      <div class="bt-pane">
        <h2>Roster</h2>
        <div class="ducat-meter">
          <div class="box"><span class="lbl">Budget</span><b>${band.ducats}</b></div>
          <div class="box ${t.ducats > band.ducats ? 'over' : ''}"><span class="lbl">Ducats</span><b>${t.ducats}</b></div>
          <div class="box glory ${band.glory > 0 && t.glory > band.glory ? 'over' : ''}"><span class="lbl">Glory</span><b>${t.glory}</b></div>
          <div class="box"><span class="lbl">Models</span><b>${band.units.length}</b></div>
        </div>
        <p class="muted" style="margin-bottom:10px">${Math.max(0, band.ducats - t.ducats)} ducats left —
          ${band.units.filter((e) => unitDef(e)?.type === 'elite').length} elite /
          ${band.units.filter((e) => unitDef(e)?.type === 'troop').length} troop /
          ${band.units.filter((e) => e.merc || unitDef(e)?.type === 'mercenary').length} mercs</p>
        ${band.units.map(unitCardHtml).join('') || '<p class="muted">No models yet — recruit from the middle pane.</p>'}
      </div>
    </div>`;
}

function recruitRow(u, onclick) {
  const limit = u.min > 0 ? `${u.min}` : u.max != null ? `0-${u.max}` : 'any number';
  return `<tr>
    <td class="c-add"><button class="addbtn" title="add ${esc(u.name)}" onclick="${onclick}">+</button></td>
    <td class="c-name"><span class="uname">${esc(u.name)}</span>
      <span class="ucat">${esc(u.type)} — take ${limit}</span>
      <span class="ustat">${esc(statSummary(u.stats))}</span>
      ${u.note ? `<span class="ustat">${esc(u.note)}</span>` : ''}</td>
    <td class="c-cost">${costHtml(u.ducats, u.glory)}</td>
  </tr>`;
}

function armouryHtml(def) {
  const CAT_LABEL = { melee: 'Melee Weapons', ranged: 'Ranged Weapons', grenade: 'Grenades', armour: 'Armour & Shields', equipment: 'Equipment' };
  return Object.entries(CAT_LABEL).map(([cat, label]) => {
    const items = def.armoury.filter((a) => a.category === cat);
    if (!items.length) return '';
    return `<h3>${label}</h3>` + items.map((a) => {
      const open = openArm.has(a.name);
      const p = a.profile || CAT.battlekit[a.name];
      return `<div class="arm-row" onclick="TC.toggleArm('${esc(a.name)}')">
          <span>${esc(a.name)}${a.note ? ` <span class="muted">(${esc(a.note)})</span>` : ''}${a.limit != null && !a.note ? ` <span class="muted">(Limit: ${a.limit})</span>` : ''}</span>
          <span>${costHtml(a.ducats, a.glory)}</span>
        </div>
        ${open ? `<div class="arm-detail">${profileHtml(p)}</div>` : ''}`;
    }).join('');
  }).join('');
}

function profileHtml(p) {
  if (!p) return 'No printed profile — rules text lives in the faction list.';
  const bits = [];
  if (p.type) bits.push(`<b>${esc(p.type)}</b>`);
  if (p.range) bits.push(`Range ${esc(p.range)}`);
  if (p.keywords?.length) bits.push(`Keywords: ${esc(p.keywords.join(', '))}`);
  let html = bits.join(' — ');
  if (p.rules) html += `${html ? '<br>' : ''}${esc(p.rules)}`;
  return html || 'No printed profile.';
}

function unitCardHtml(e) {
  const def = unitDef(e);
  if (!def) return '';
  const c = unitCost(e);
  const allowed = allowedItems(e);
  return `<div class="unit-card ${e.merc || def.type === 'mercenary' ? 'merc' : ''}">
    <div class="uc-head">
      <input value="${esc(e.label)}" maxlength="30" placeholder="${esc(def.name)}"
        onchange="TC.rename('${e.id}', this.value)">
      <span class="uc-cost">${costHtml(c.ducats, c.glory)}</span>
      <button class="rmbtn" title="remove model" onclick="TC.remove('${e.id}')">✕</button>
    </div>
    <div class="uc-type">${esc(def.name)} — ${esc(def.type)} — base cost ${def.ducats ? def.ducats + 'd' : ''}${def.glory ? ' ' + def.glory + 'g' : ''}</div>
    ${statlineHtml(def)}
    ${def.keywords.length ? `<div class="kwline">${esc(def.keywords.join(', '))}</div>` : ''}
    ${def.abilities.map((a) => `<div class="abil"><b>${esc(a.name)}:</b> ${esc(a.text)}</div>`).join('')}
    ${def.note ? `<div class="unote">${esc(def.note)}</div>` : ''}
    ${(e.merc || def.type === 'mercenary') && def.extra?.length
      ? `<div class="unote">Comes with: ${esc(def.extra.join(', '))} (included).</div>` : ''}
    ${e.items.map((g, i) => `
      <div class="gear-row"><span>${esc(g)}</span>
        <span class="g-cost">${costHtml(itemDef(g)?.ducats || 0, itemDef(g)?.glory || 0)}
          <button class="rmbtn" title="remove" onclick="TC.dropItem('${e.id}', ${i})">✕</button></span>
      </div>`).join('')}
    ${allowed.length ? `<div class="gear-add">
      <select id="sel-${e.id}">
        ${allowed.map((a) => `<option value="${esc(a.name)}">${esc(a.name)} — ${a.ducats ? a.ducats + 'd' : a.glory + 'g'}${a.note ? ' (' + esc(a.note) + ')' : ''}</option>`).join('')}
      </select>
      <button class="btn small ghost" onclick="TC.addItem('${e.id}')">Equip</button>
    </div>` : ''}
  </div>`;
}

// ---------------------------------------------------------------- actions

const TC = {
  newBand(key) {
    band = {
      name: `${wb(key).name} Warband`,
      key,
      ducats: CAT.rules.leagueDefaultDucats,
      glory: 0,
      units: [],
    };
    render();
  },
  back() { band = null; render(); },
  setName(v) { band.name = v.trim() || band.name; render(); },
  setDucats(v) { band.ducats = Math.max(0, parseInt(v, 10) || 0); render(); },
  setGlory(v) { band.glory = Math.max(0, parseInt(v, 10) || 0); render(); },
  add(i) {
    const def = bandDef().units[i];
    if (!def) return;
    band.units.push({ id: uid(), type: def.name, label: '', items: [], merc: band.key === 'mercenaries' ? false : undefined });
    render();
  },
  addMerc(i) {
    const def = mercsFor(band.key)[i];
    if (!def) return;
    band.units.push({ id: uid(), type: def.name, label: '', items: [], merc: true });
    render();
  },
  remove(id) { band.units = band.units.filter((e) => e.id !== id); render(); },
  rename(id, v) { const e = band.units.find((x) => x.id === id); if (e) e.label = v.trim(); },
  addItem(id) {
    const e = band.units.find((x) => x.id === id);
    const sel = document.getElementById('sel-' + id);
    if (e && sel && sel.value) { e.items.push(sel.value); render(); }
  },
  dropItem(id, i) {
    const e = band.units.find((x) => x.id === id);
    if (e) { e.items.splice(i, 1); render(); }
  },
  toggleArm(name) {
    openArm.has(name) ? openArm.delete(name) : openArm.add(name);
    render();
  },
  save() {
    const s = saves();
    s[band.name] = band;
    setSaves(s);
    toast(`Saved "${band.name}"`);
    render();
  },
  load(i) {
    const s = saves();
    const name = Object.keys(s)[i];
    if (!name) return;
    band = s[name];
    render();
  },
  del(i) {
    const s = saves();
    const name = Object.keys(s)[i];
    if (!name || !confirm(`Delete warband "${name}"?`)) return;
    delete s[name];
    setSaves(s);
    toast('Deleted');
    render();
  },
  exportSheet() {
    const def = bandDef();
    const t = totals();
    const line = (c = '-') => c.repeat(58);
    let txt = `${band.name.toUpperCase()}\n${def.name} (${def.alignment})\n`;
    txt += `Budget ${band.ducats} ducats — spent ${t.ducats} ducats`;
    txt += t.glory ? ` + ${t.glory} glory\n` : '\n';
    txt += `${band.units.length} models\n`;
    for (const s of def.special) txt += `* ${s}\n`;
    txt += `${line('=')}\n`;
    for (const e of band.units) {
      const d = unitDef(e);
      if (!d) continue;
      const c = unitCost(e);
      txt += `\n${(e.label || d.name).toUpperCase()} — ${d.name} (${d.type}) — ${c.ducats ? c.ducats + 'd' : ''}${c.glory ? ' ' + c.glory + 'g' : ''}\n`;
      txt += `  ${statSummary(d.stats)} — base ${d.stats.base}\n`;
      if (d.altProfiles) for (const p of d.altProfiles) txt += `  ${p.name}: ${statSummary(p)} — base ${p.base}\n`;
      if (d.keywords.length) txt += `  Keywords: ${d.keywords.join(', ')}\n`;
      for (const a of d.abilities) txt += `  ${a.name}: ${a.text}\n`;
      if (d.note) txt += `  Note: ${d.note}\n`;
      if ((e.merc || d.type === 'mercenary') && d.extra?.length) txt += `  Comes with: ${d.extra.join(', ')}\n`;
      txt += e.items.length
        ? `  Battlekit: ${e.items.map((x) => `${x} (${itemDef(x)?.ducats ? itemDef(x).ducats + 'd' : (itemDef(x)?.glory || '?') + 'g'})`).join(', ')}\n`
        : '';
      for (const g of e.items) {
        const p = itemDef(g)?.profile || CAT.battlekit[g];
        if (p && (p.range || p.keywords)) {
          txt += `    ${g}: ${p.type || ''}${p.range ? ' Range ' + p.range : ''}${p.keywords?.length ? ' — ' + p.keywords.join(', ') : ''}\n`;
        }
      }
    }
    txt += `\n${line('=')}\nRaising Havok Gaming Club — built ${new Date().toISOString().slice(0, 10)}\n`;
    txt += `Catalog: Trench Crusade ${CAT.meta.rulesVersion}. The printed lists win any argument.\n`;

    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal">
      <button class="modal-x" onclick="this.closest('.modal-back').remove()">✕</button>
      <h2>${esc(band.name)}</h2>
      <div class="export-pre">${esc(txt)}</div>
      <div class="modal-actions no-print">
        <button class="btn small" id="copy-btn">Copy text</button>
        <button class="btn small ghost" onclick="window.print()">Print</button>
      </div>
    </div>`;
    back.addEventListener('click', (e) => { if (e.target === back) back.remove(); });
    back.querySelector('#copy-btn').onclick = () => {
      navigator.clipboard.writeText(txt).then(() => toast('Copied'), () => toast('Copy failed'));
    };
    document.body.append(back);
  },
};
window.TC = TC;

// ---------------------------------------------------------------- boot

async function boot() {
  try {
    const cfg = await fetch('/api/config').then((r) => r.json());
    discordSso = Boolean(cfg.discordEnabled);
  } catch { /* config is best-effort */ }

  try {
    me = await api('/me');
  } catch {
    me = null;
  }
  const who = document.getElementById('whoami');
  if (who) who.textContent = me ? `👤 ${me.name}` : '';
  if (!me) { loginWall(); return; }

  try {
    CAT = await api('/builders/trenchcrusade/catalog');
  } catch (e) {
    $app.innerHTML = `<div class="card"><p class="error">Could not load the Trench Crusade catalog: ${esc(e.message)}</p></div>`;
    return;
  }
  render();
}

boot();
