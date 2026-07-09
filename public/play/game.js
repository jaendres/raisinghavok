// Mad Ork Lands — canvas renderer, input, and net sync.
const Game = (() => {
  const cv = $('#game-canvas');
  const ctx = cv.getContext('2d');
  let state = null, prevState = null, stateTime = 0;
  let running = false;
  let fx = [];            // client-side particles/tracers
  let shake = 0;
  const keys = {};
  let lastInput = '';

  window.addEventListener('keydown', e => {
    keys[e.code] = true;
    if (running && ['Space', 'ShiftLeft', 'ShiftRight'].includes(e.code)) e.preventDefault();
  });
  window.addEventListener('keyup', e => { keys[e.code] = false; });

  function resize() { cv.width = innerWidth; cv.height = innerHeight; }
  window.addEventListener('resize', resize);

  function start(d) {
    show('screen-game');
    resize();
    obstacleCache = (d && d.obstacles) || [];
    running = true;
    state = prevState = null;
    fx = [];
    $('#results').classList.add('hidden');
    $('#killfeed').innerHTML = '';
    $('#game-msg').textContent = 'WAAAGH!';
    setTimeout(() => { if ($('#game-msg').textContent === 'WAAAGH!') $('#game-msg').textContent = ''; }, 1500);
    requestAnimationFrame(loop);
    inputTimer = setInterval(sendInput, 50);
  }

  let inputTimer = null;

  function sendInput() {
    if (!running || !MOL.socket) return;
    const input = {
      throttle: (keys.KeyW || keys.ArrowUp ? 1 : 0) + (keys.KeyS || keys.ArrowDown ? -1 : 0),
      steer: (keys.KeyD || keys.ArrowRight ? 1 : 0) + (keys.KeyA || keys.ArrowLeft ? -1 : 0),
      fire: !!keys.Space,
      drop: !!(keys.ShiftLeft || keys.ShiftRight),
      boost: !!keys.KeyE,
    };
    const s = JSON.stringify(input);
    if (s !== lastInput) { MOL.socket.emit('input', input); lastInput = s; }
    else if (input.fire || input.drop) MOL.socket.emit('input', input); // keep-alive while held
  }

  function onState(s) {
    prevState = state;
    state = s;
    stateTime = performance.now();
    for (const e of s.events || []) handleEvent(e);
  }

  function handleEvent(e) {
    if (e.t === 'shot') fx.push({ kind: 'tracer', x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2, ttl: 0.07 });
    if (e.t === 'boom') { fx.push({ kind: 'boom', x: e.x, y: e.y, r: e.r, ttl: 0.45, max: 0.45 }); shake = Math.min(14, shake + 8); }
    if (e.t === 'crash') fx.push({ kind: 'sparks', x: e.x, y: e.y, ttl: 0.3 });
    if (e.t === 'flame') fx.push({ kind: 'flame', id: e.id, a: e.a, r: e.r, ttl: 0.1 });
    if (e.t === 'wreck') {
      fx.push({ kind: 'boom', x: e.x, y: e.y, r: 70, ttl: 0.7, max: 0.7 });
      shake = Math.min(18, shake + 10);
      addKillfeed(`<b>${esc(e.name)}</b> wrecked by ${esc(String(e.by || 'da wasteland'))}`);
    }
  }

  function addKillfeed(html) {
    const div = document.createElement('div');
    div.innerHTML = html;
    $('#killfeed').prepend(div);
    while ($('#killfeed').children.length > 6) $('#killfeed').lastChild.remove();
    setTimeout(() => div.remove(), 7000);
  }

  function me() { return state && state.rigs.find(r => r.id === MOL.myRigId); }

  // interpolate rigs between the two latest snapshots
  function lerped() {
    if (!state) return [];
    if (!prevState) return state.rigs;
    const dt = (performance.now() - stateTime) / 66; // broadcast ~30Hz
    const t = Math.min(1, dt);
    return state.rigs.map(r => {
      const p = prevState.rigs.find(x => x.id === r.id);
      if (!p || !r.alive) return r;
      let da = r.a - p.a;
      while (da > Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      return { ...r, x: p.x + (r.x - p.x) * t, y: p.y + (r.y - p.y) * t, a: p.a + da * t };
    });
  }

  function loop() {
    if (!running) return;
    requestAnimationFrame(loop);
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (!state) return;

    const rigs = lerped();
    const my = rigs.find(r => r.id === MOL.myRigId) || rigs.find(r => r.alive) || rigs[0];
    const camX = my ? my.x : 0, camY = my ? my.y : 0;

    ctx.save();
    if (shake > 0) { ctx.translate((Math.random() - .5) * shake, (Math.random() - .5) * shake); shake *= 0.88; if (shake < .3) shake = 0; }
    ctx.translate(cv.width / 2 - camX, cv.height / 2 - camY);

    drawGround(camX, camY);
    drawZone();

    // hazards
    for (const h of state.hazards) {
      if (h.kind === 'oil') {
        ctx.fillStyle = '#0e0d12cc';
        ctx.beginPath(); ctx.ellipse(h.x, h.y, h.r, h.r * 0.7, 0, 0, Math.PI * 2); ctx.fill();
      } else if (h.kind === 'mine') {
        ctx.fillStyle = '#5a5347';
        ctx.beginPath(); ctx.arc(h.x, h.y, 9, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = Math.floor(performance.now() / 400) % 2 ? '#ff3b30' : '#701510';
        ctx.beginPath(); ctx.arc(h.x, h.y, 3.5, 0, Math.PI * 2); ctx.fill();
      }
    }

    // rigs
    for (const r of rigs) {
      if (!r.alive) { drawWreck(r); continue; }
      ctx.save();
      ctx.translate(r.x, r.y);
      // boost flame
      if (r.boost) {
        ctx.save(); ctx.rotate(r.a);
        ctx.fillStyle = '#ff9c33';
        const hull = MOL.parts.hulls[r.hull];
        const back = -(hull ? hull.radius : 22) * 2;
        ctx.beginPath();
        ctx.moveTo(back, -6); ctx.lineTo(back - 18 - Math.random() * 14, 0); ctx.lineTo(back, 6);
        ctx.fill(); ctx.restore();
      }
      ctx.save(); ctx.rotate(r.a);
      drawRig(ctx, { hull: r.hull, color: r.color, weapons: (r.ammo || []).map(a => a.id) }, MOL.parts);
      ctx.restore();
      // wreckin' ball
      if (r.ball) {
        ctx.strokeStyle = '#6b6257'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(r.ball.x - r.x, r.ball.y - r.y); ctx.stroke();
        ctx.fillStyle = '#3a332b';
        ctx.beginPath(); ctx.arc(r.ball.x - r.x, r.ball.y - r.y, 11, 0, Math.PI * 2); ctx.fill();
      }
      // name + hp
      ctx.font = '13px Barlow Condensed, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = r.id === MOL.myRigId ? '#ffd23f' : '#e8e0d0';
      ctx.fillText(r.name, 0, -38);
      const w = 44;
      ctx.fillStyle = '#000a'; ctx.fillRect(-w / 2, -34, w, 5);
      ctx.fillStyle = r.hp / r.maxHp > .35 ? '#7ec850' : '#ff3b30';
      ctx.fillRect(-w / 2, -34, w * Math.max(0, r.hp / r.maxHp), 5);
      ctx.restore();
    }

    // projectiles
    for (const p of state.projectiles) {
      ctx.fillStyle = p.kind === 'kannon' ? '#ffd23f' : p.kind === 'harpoon' ? '#c8bfae' : '#ff6a1a';
      ctx.beginPath(); ctx.arc(p.x, p.y, p.kind === 'kannon' ? 6 : 4, 0, Math.PI * 2); ctx.fill();
      fx.push({ kind: 'trail', x: p.x, y: p.y, ttl: 0.15 });
    }

    // smoke on top
    for (const h of state.hazards) {
      if (h.kind === 'smoke') {
        ctx.fillStyle = '#15120fd9';
        for (let i = 0; i < 4; i++) {
          const wob = Math.sin(performance.now() / 500 + i * 2) * 8;
          ctx.beginPath(); ctx.arc(h.x + wob, h.y + (i - 1.5) * 14, h.r * 0.55, 0, Math.PI * 2); ctx.fill();
        }
      }
    }

    drawFx();
    ctx.restore();

    drawHud(rigs, my);
  }

  function drawGround(camX, camY) {
    // wasteland grid + arena edge
    ctx.fillStyle = '#1a1409';
    ctx.beginPath(); ctx.arc(0, 0, 2400 * 0.72 + 40, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#241c0e';
    ctx.lineWidth = 1;
    const g = 120, x0 = Math.floor((camX - cv.width) / g) * g, y0 = Math.floor((camY - cv.height) / g) * g;
    ctx.beginPath();
    for (let x = x0; x < camX + cv.width; x += g) { ctx.moveTo(x, camY - cv.height); ctx.lineTo(x, camY + cv.height); }
    for (let y = y0; y < camY + cv.height; y += g) { ctx.moveTo(camX - cv.width, y); ctx.lineTo(camX + cv.width, y); }
    ctx.stroke();
    // scrap piles
    for (const o of obstacles()) {
      ctx.fillStyle = '#2e2618';
      ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#3d3220';
      ctx.beginPath(); ctx.arc(o.x - o.r * .25, o.y - o.r * .2, o.r * .55, 0, Math.PI * 2); ctx.fill();
    }
    ctx.strokeStyle = '#4a3d31'; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.arc(0, 0, 2400 * 0.72, 0, Math.PI * 2); ctx.stroke();
  }

  // obstacles come once via first state? server doesn't send them — approximate:
  // server includes them in every state? No — keep a cache from 'obstacles' field if present.
  let obstacleCache = [];
  function obstacles() {
    if (state && state.obstacles) obstacleCache = state.obstacles;
    return obstacleCache;
  }

  function drawZone() {
    if (!state.zone) return;
    const z = state.zone;
    ctx.strokeStyle = '#ff6a1a';
    ctx.lineWidth = 3;
    ctx.setLineDash([14, 10]);
    ctx.beginPath(); ctx.arc(z.x, z.y, z.r, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    // storm outside
    ctx.save();
    ctx.beginPath();
    ctx.arc(z.x, z.y, z.r, 0, Math.PI * 2);
    ctx.rect(z.x + 4000, z.y - 4000, -8000, 8000); // even-odd donut
    ctx.clip('evenodd');
    ctx.fillStyle = '#b8480d2a';
    ctx.fillRect(z.x - 4000, z.y - 4000, 8000, 8000);
    ctx.restore();
  }

  function drawWreck(r) {
    ctx.save();
    ctx.translate(r.x, r.y); ctx.rotate(r.a);
    ctx.fillStyle = '#26201a';
    ctx.fillRect(-20, -12, 40, 24);
    ctx.fillStyle = '#171310';
    ctx.beginPath(); ctx.arc(0, 0, 9, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function drawFx() {
    const now = 1 / 60;
    for (const f of fx) {
      f.ttl -= now;
      if (f.kind === 'tracer') {
        ctx.strokeStyle = '#ffd23fcc'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(f.x1, f.y1); ctx.lineTo(f.x2, f.y2); ctx.stroke();
      } else if (f.kind === 'boom') {
        const p = 1 - f.ttl / f.max;
        ctx.strokeStyle = `rgba(255,106,26,${1 - p})`;
        ctx.lineWidth = 5;
        ctx.beginPath(); ctx.arc(f.x, f.y, f.r * p, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = `rgba(255,210,63,${(1 - p) * 0.5})`;
        ctx.beginPath(); ctx.arc(f.x, f.y, f.r * p * 0.7, 0, Math.PI * 2); ctx.fill();
      } else if (f.kind === 'sparks') {
        ctx.fillStyle = '#ffd23f';
        for (let i = 0; i < 5; i++) ctx.fillRect(f.x + (Math.random() - .5) * 26, f.y + (Math.random() - .5) * 26, 3, 3);
      } else if (f.kind === 'trail') {
        ctx.fillStyle = `rgba(155,143,125,${f.ttl * 3})`;
        ctx.beginPath(); ctx.arc(f.x, f.y, 3, 0, Math.PI * 2); ctx.fill();
      } else if (f.kind === 'flame') {
        const r = state.rigs.find(x => x.id === f.id);
        if (r) {
          ctx.fillStyle = `rgba(255,${120 + Math.random() * 80 | 0},30,0.5)`;
          ctx.save(); ctx.translate(r.x, r.y); ctx.rotate(f.a);
          ctx.beginPath(); ctx.moveTo(16, 0);
          ctx.lineTo(f.r, -f.r * 0.5); ctx.lineTo(f.r + 14, 0); ctx.lineTo(f.r, f.r * 0.5);
          ctx.closePath(); ctx.fill(); ctx.restore();
        }
      }
    }
    fx = fx.filter(f => f.ttl > 0);
  }

  function drawHud(rigs, my) {
    const alive = rigs.filter(r => r.alive).length;
    $('#hud-alive').textContent = `${alive} RIGS ROLLIN'`;
    const m = me();
    if (m) {
      $('#hud-hp-fill').style.width = Math.max(0, m.hp / m.maxHp * 100) + '%';
      $('#hud-hp-text').textContent = m.alive ? `${Math.ceil(m.hp)} / ${m.maxHp}` : 'WRECKED';
      $('#hud-ammo').innerHTML = (m.ammo || [])
        .map(a => `<span class="am">${(MOL.parts.weapons[a.id] || {}).name || a.id}: <b>${a.ammo === null ? '∞' : a.ammo}</b></span>`).join('');
      $('#hud-boost').textContent = m.boostCd > 0 ? `Boosta: ${m.boostCd.toFixed(1)}s` : '';
      if (!m.alive && $('#results').classList.contains('hidden') && !$('#game-msg').textContent) {
        $('#game-msg').textContent = 'WRECKED! Watchin da rest...';
      }
    }
  }

  function onOver(results) {
    running = false;
    clearInterval(inputTimer);
    const mine = results.find(r => !r.isBot && r.name.startsWith(MOL.name.replace(' (guest)', '')));
    $('#results-title').textContent =
      results[0] && !results[0].isBot && me() && state.rigs.find(r => r.id === MOL.myRigId && r.alive)
        ? 'LAST RIG ROLLIN!' : 'SCRAP!';
    $('#results-list').innerHTML = results.map(r => `
      <div class="rr ${mine && r.name === mine.name ? 'me' : ''}">
        <span class="pl">#${r.place}</span><span class="nm">${esc(r.name)}</span>
        <span class="kd">${r.kills} kills • ${r.damage} dmg</span>
      </div>`).join('');
    $('#results').classList.remove('hidden');
    $('#game-msg').textContent = '';
  }

  return { start, onState, onOver };
})();
