// Da Mek Shop — rig builder. Enforces teef budget + hull slots client-side
// (the server re-validates on joinQueue, so this is just for the UI).
const Garage = (() => {
  let P = null; // parts catalog
  const state = { hull: 'trukk', weapons: [], upgrades: [], name: '' };

  function init(parts) {
    P = parts;
    renderHulls();
    renderWeapons();
    renderUpgrades();
    $('#rig-name').addEventListener('input', () => { state.name = $('#rig-name').value; });
    $('#btn-save').onclick = saveBuild;
    update();
  }

  function cost() {
    let c = P.hulls[state.hull].cost;
    state.weapons.forEach(id => c += P.weapons[id].cost);
    state.upgrades.forEach(id => c += P.upgrades[id].cost);
    return c;
  }
  function slots() {
    let s = 0;
    state.weapons.forEach(id => s += P.weapons[id].slots);
    state.upgrades.forEach(id => s += P.upgrades[id].slots);
    return s;
  }

  function renderHulls() {
    $('#hull-list').innerHTML = Object.entries(P.hulls).map(([id, h]) => `
      <div class="part hull ${id === state.hull ? 'selected' : ''}" data-id="${id}">
        <div class="p-head"><span class="p-name">${h.name}</span><span class="p-cost">${h.cost} teef</span></div>
        <div class="p-desc">${h.desc}</div>
        <div class="p-stats">Hull ${h.hull} • ${h.slots} slots • Speed ${Math.round(h.topSpeed / 34)}/10 • Handlin' ${Math.round(h.turn / 0.34) / 10 * 10}/10</div>
      </div>`).join('');
    document.querySelectorAll('#hull-list .part').forEach(el => {
      el.onclick = () => { state.hull = el.dataset.id; renderHulls(); update(); };
    });
  }

  function renderWeapons() {
    $('#weapon-list').innerHTML = Object.entries(P.weapons).map(([id, w]) => {
      const n = state.weapons.filter(x => x === id).length;
      return `
      <div class="part weapon" data-id="${id}">
        <div class="p-head"><span class="p-name">${w.name}${n ? `<span class="qty">×${n}</span>` : ''}</span><span class="p-cost">${w.cost} teef / ${w.slots} slot</span></div>
        <div class="p-desc">${w.desc}</div>
        <div class="p-stats">${weaponStats(w)}</div>
      </div>`;
    }).join('');
    document.querySelectorAll('#weapon-list .part').forEach(el => {
      el.onclick = () => { addWeapon(el.dataset.id); };
    });
  }

  function weaponStats(w) {
    const bits = [];
    if (w.dmg) bits.push(`dmg ${w.dmg}${w.type === 'flame' ? '/s' : ''}`);
    if (w.range) bits.push(`range ${w.range}`);
    bits.push(w.ammo === null || w.ammo === undefined ? 'unlimited ammo' : `ammo ${w.ammo}`);
    bits.push(w.arc === 'front' ? 'fires forward' : w.arc === 'turret' ? 'auto-aims' : w.arc === 'rear' ? 'drops behind' : 'orbits');
    return bits.join(' • ');
  }

  function renderUpgrades() {
    $('#upgrade-list').innerHTML = Object.entries(P.upgrades).map(([id, u]) => `
      <div class="part upgrade ${state.upgrades.includes(id) ? 'selected' : ''}" data-id="${id}">
        <div class="p-head"><span class="p-name">${u.name}</span><span class="p-cost">${u.cost} teef / ${u.slots} slot</span></div>
        <div class="p-desc">${u.desc}</div>
      </div>`).join('');
    document.querySelectorAll('#upgrade-list .part').forEach(el => {
      el.onclick = () => {
        const id = el.dataset.id;
        const i = state.upgrades.indexOf(id);
        if (i >= 0) state.upgrades.splice(i, 1);
        else state.upgrades.push(id);
        renderUpgrades(); update();
      };
    });
  }

  function addWeapon(id) {
    if (state.weapons.length >= 6) return;
    state.weapons.push(id);
    renderWeapons(); update();
  }
  function removeWeapon(index) {
    state.weapons.splice(index, 1);
    renderWeapons(); update();
  }

  function update() {
    const h = P.hulls[state.hull];
    const c = cost(), s = slots();
    const overC = c > P.budget, overS = s > h.slots;

    $('#lbl-teef').textContent = `${c}/${P.budget}`;
    $('#bar-teef').style.width = Math.min(100, c / P.budget * 100) + '%';
    $('#bar-teef').className = overC ? 'over' : '';
    $('#lbl-slots').textContent = `${s}/${h.slots}`;
    $('#bar-slots').style.width = Math.min(100, h.slots ? s / h.slots * 100 : 100) + '%';
    $('#bar-slots').className = overS ? 'over' : '';

    let hull = h.hull, spd = 1;
    state.upgrades.forEach(id => {
      const e = P.upgrades[id].effect || {};
      if (e.hull) hull += e.hull;
      if (e.speedMul) spd *= e.speedMul;
    });
    $('#lbl-hull').textContent = hull;
    $('#lbl-speed').textContent = Math.round(h.topSpeed * spd);

    $('#loadout').innerHTML = [
      `<div class="lo-item"><span>${h.name}</span><span>${h.cost}t</span></div>`,
      ...state.weapons.map((id, i) =>
        `<div class="lo-item"><span>${P.weapons[id].name}</span><span>${P.weapons[id].cost}t <span class="rm" data-w="${i}">✕</span></span></div>`),
      ...state.upgrades.map(id =>
        `<div class="lo-item"><span>${P.upgrades[id].name}</span><span>${P.upgrades[id].cost}t</span></div>`),
    ].join('');
    document.querySelectorAll('#loadout .rm').forEach(el => {
      el.onclick = () => removeWeapon(+el.dataset.w);
    });

    $('#build-error').textContent = overC ? 'Too many teef spent!' : overS ? 'Not enuff slots on dis hull!' : '';
    $('#btn-play').disabled = overC || overS;
    $('#btn-play').style.opacity = (overC || overS) ? 0.5 : 1;
    drawPreview();
  }

  // top-down rig sketch matching in-game rendering
  function drawPreview() {
    const cv = $('#rig-preview'), ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.save();
    ctx.translate(cv.width / 2, cv.height / 2);
    ctx.rotate(-Math.PI / 2);
    drawRig(ctx, { hull: state.hull, color: '#ff6a1a', scale: 2.4, weapons: state.weapons }, P);
    ctx.restore();
  }

  function currentBuild() {
    return { hull: state.hull, weapons: [...state.weapons], upgrades: [...state.upgrades], name: state.name || 'Unnamed Rig' };
  }

  function loadBuild(b) {
    state.hull = b.hull; state.weapons = [...(b.weapons || [])]; state.upgrades = [...(b.upgrades || [])];
    state.name = b.name || '';
    $('#rig-name').value = state.name;
    renderHulls(); renderWeapons(); renderUpgrades(); update();
  }

  async function saveBuild() {
    const b = currentBuild();
    const i = MOL.garage.findIndex(x => x.name === b.name);
    if (i >= 0) MOL.garage[i] = b; else MOL.garage.push(b);
    MOL.garage = MOL.garage.slice(0, 10);
    if (MOL.guest) localStorage.setItem('mol_guest_garage', JSON.stringify(MOL.garage));
    else {
      try { await api('/garage', { method: 'POST', body: JSON.stringify({ builds: MOL.garage }) }); }
      catch (e) { $('#build-error').textContent = e.message; return; }
    }
    renderSaved();
  }

  function renderSaved() {
    $('#saved-builds').innerHTML = MOL.garage.map((b, i) =>
      `<span class="sb" data-i="${i}">${esc(b.name || 'Rig ' + (i + 1))}</span>`).join('');
    document.querySelectorAll('.saved-builds .sb').forEach(el => {
      el.onclick = () => loadBuild(MOL.garage[+el.dataset.i]);
    });
  }

  return { init, currentBuild, loadBuild, renderSaved };
})();

// Shared top-down rig drawing (also used in-game). Faces +x.
function drawRig(ctx, opts, P) {
  const hull = P.hulls[opts.hull] || { radius: 22 };
  const s = (opts.scale || 1) * (hull.radius / 22);
  const c = opts.color || '#ff6a1a';
  const L = 44 * s, W = 26 * s;

  // wheels
  ctx.fillStyle = '#181410';
  [[-L * 0.32, -W * 0.62], [-L * 0.32, W * 0.42], [L * 0.28, -W * 0.62], [L * 0.28, W * 0.42]]
    .forEach(([x, y]) => ctx.fillRect(x, y, L * 0.22, W * 0.2));

  // body
  ctx.fillStyle = c;
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(L * 0.5, 0);
  ctx.lineTo(L * 0.3, -W * 0.5);
  ctx.lineTo(-L * 0.5, -W * 0.42);
  ctx.lineTo(-L * 0.5, W * 0.42);
  ctx.lineTo(L * 0.3, W * 0.5);
  ctx.closePath();
  ctx.fill(); ctx.stroke();

  // cab + engine block
  ctx.fillStyle = '#00000055';
  ctx.fillRect(-L * 0.28, -W * 0.3, L * 0.34, W * 0.6);
  ctx.fillStyle = '#2b2118';
  ctx.fillRect(L * 0.1, -W * 0.22, L * 0.26, W * 0.44);

  // dakka barrels for each mounted weapon
  const wpns = opts.weapons || [];
  ctx.fillStyle = '#3a332b';
  wpns.slice(0, 4).forEach((id, i) => {
    const y = (i - (Math.min(wpns.length, 4) - 1) / 2) * W * 0.3;
    ctx.fillRect(L * 0.34, y - 2 * s, L * 0.3, 4 * s);
  });

  // spiky glyph
  ctx.fillStyle = '#00000088';
  ctx.beginPath();
  ctx.arc(-L * 0.15, 0, W * 0.16, 0, Math.PI * 2);
  ctx.fill();
}
