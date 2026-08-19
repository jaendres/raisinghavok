// Game Night — Classic BattleTech (Total Warfare) record-sheet card.
//
// Renders one snapshotted classic unit (see server/table.js
// snapshotClassicUnit) as a tappable record sheet: armor pips laid out as the
// humanoid silhouette, internal-structure pips per location, the 0-30 heat
// scale with the canonical Total Warfare penalty breakpoints, crit slots,
// weapons with destroyed toggles, and the pilot hits track.
//
// Exposed as window.ClassicCard; table.js owns all event handling — this file
// only produces HTML with the same data-uid/data-field attributes the shared
// delegated listeners understand.
(function () {
  'use strict';

  // Escapes for attribute context too: notes are rendered into value="..."
  // and a bare quote would break out of the attribute. textContent/innerHTML
  // leaves " alone, so the replacements are spelled out.
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ---- Total Warfare heat scale (canonical breakpoint labels) --------------
  const HEAT_EFFECTS = [
    [30, 'Shutdown'],
    [28, 'Ammo Exp. avoid on 8+'],
    [26, 'Shutdown, avoid on 10+'],
    [25, '−5 Movement Points'],
    [24, '+4 Modifier to Fire'],
    [23, 'Ammo Exp. avoid on 6+'],
    [22, 'Shutdown, avoid on 8+'],
    [20, '−4 Movement Points'],
    [19, 'Ammo Exp. avoid on 4+'],
    [18, 'Shutdown, avoid on 6+'],
    [17, '+3 Modifier to Fire'],
    [15, '−3 Movement Points'],
    [14, 'Shutdown, avoid on 4+'],
    [13, '+2 Modifier to Fire'],
    [10, '−2 Movement Points'],
    [8, '+1 Modifier to Fire'],
    [5, '−1 Movement Points'],
  ];
  const HEAT_AT = new Map(HEAT_EFFECTS.map(function (e) { return [e[0], e[1]]; }));

  // ---- Weapon quick-reference ----------------------------------------------
  // The classic_sheets weapons jsonb carries name/count/location only, so the
  // dmg/heat/range columns come from this Total Warfare reference table.
  // Format: name -> [heat, damage, min, short, medium, long]. Unknown weapons
  // render with dashes. Where IS and Clan share a display name, the CLAN map
  // overrides when the sheet's tech base is Clan.
  const W = {
    'Small Laser': [1, 3, 0, 1, 2, 3],
    'Medium Laser': [3, 5, 0, 3, 6, 9],
    'Large Laser': [8, 8, 0, 5, 10, 15],
    'ER Small Laser': [2, 3, 0, 2, 4, 5],
    'ER Medium Laser': [5, 5, 0, 4, 8, 12],
    'ER Large Laser': [12, 8, 0, 7, 14, 19],
    'Small Pulse Laser': [2, 3, 0, 1, 2, 3],
    'Medium Pulse Laser': [4, 6, 0, 2, 4, 6],
    'Large Pulse Laser': [10, 9, 0, 3, 7, 10],
    'Small X-Pulse Laser': [3, 3, 0, 2, 4, 5],
    'Medium X-Pulse Laser': [6, 6, 0, 3, 6, 9],
    'Large X-Pulse Laser': [14, 9, 0, 5, 10, 15],
    'PPC': [10, 10, 3, 6, 12, 18],
    'ER PPC': [15, 10, 0, 7, 14, 23],
    'Light PPC': [5, 5, 3, 6, 12, 18],
    'Heavy PPC': [15, 15, 3, 6, 12, 18],
    'Snub-Nose PPC': [10, '10/8/5', 0, 9, 13, 15],
    'Flamer': [3, 2, 0, 1, 2, 3],
    'ER Flamer': [4, 2, 0, 3, 5, 7],
    'Heavy Flamer': [5, 4, 0, 2, 3, 4],
    'Plasma Rifle': [10, 10, 0, 5, 10, 15],
    'AC/2': [1, 2, 4, 8, 16, 24],
    'AC/5': [1, 5, 3, 6, 12, 18],
    'AC/10': [3, 10, 0, 5, 10, 15],
    'AC/20': [7, 20, 0, 3, 6, 9],
    'Light AC/2': [1, 2, 0, 6, 12, 18],
    'Light AC/5': [1, 5, 0, 5, 10, 15],
    'Ultra AC/2': [1, 2, 3, 8, 17, 25],
    'Ultra AC/5': [1, 5, 2, 6, 13, 20],
    'Ultra AC/10': [4, 10, 0, 6, 12, 20],
    'Ultra AC/20': [8, 20, 0, 3, 7, 10],
    'Rotary AC/2': [1, 2, 0, 6, 12, 18],
    'Rotary AC/5': [1, 5, 0, 5, 10, 15],
    'LB 2-X AC': [1, 2, 4, 9, 18, 27],
    'LB 5-X AC': [1, 5, 3, 7, 14, 21],
    'LB 10-X AC': [2, 10, 0, 6, 12, 18],
    'LB 20-X AC': [6, 20, 0, 4, 8, 12],
    'Gauss Rifle': [1, 15, 2, 7, 15, 22],
    'Light Gauss Rifle': [1, 8, 3, 8, 17, 25],
    'Heavy Gauss Rifle': [2, '25/20/10', 4, 6, 13, 20],
    'Silver Bullet Gauss Rifle': [1, '15c', 2, 7, 15, 22],
    'Magshot': [1, 2, 0, 3, 6, 9],
    'Machine Gun': [0, 2, 0, 1, 2, 3],
    'Light Machine Gun': [0, 1, 0, 2, 4, 6],
    'Heavy Machine Gun': [0, 3, 0, 1, 2, 2],
    'LRM 5': [2, '1/msl', 6, 7, 14, 21],
    'LRM 10': [4, '1/msl', 6, 7, 14, 21],
    'LRM 15': [5, '1/msl', 6, 7, 14, 21],
    'LRM 20': [6, '1/msl', 6, 7, 14, 21],
    'LRT 5': [2, '1/msl', 6, 7, 14, 21],
    'LRT 15': [5, '1/msl', 6, 7, 14, 21],
    'SRM 2': [2, '2/msl', 0, 3, 6, 9],
    'SRM 4': [3, '2/msl', 0, 3, 6, 9],
    'SRM 6': [4, '2/msl', 0, 3, 6, 9],
    'SRM 2 (I-OS)': [2, '2/msl', 0, 3, 6, 9],
    'SRT 4': [3, '2/msl', 0, 3, 6, 9],
    'Streak SRM 2': [2, '2/msl', 0, 3, 6, 9],
    'Streak SRM 4': [3, '2/msl', 0, 3, 6, 9],
    'Streak SRM 6': [4, '2/msl', 0, 3, 6, 9],
    'MML 3': [2, 'LRM/SRM', 0, '3/6/9', '·', 'L 7/14/21'],
    'MML 5': [3, 'LRM/SRM', 0, '3/6/9', '·', 'L 7/14/21'],
    'MML 7': [4, 'LRM/SRM', 0, '3/6/9', '·', 'L 7/14/21'],
    'MML 9': [5, 'LRM/SRM', 0, '3/6/9', '·', 'L 7/14/21'],
    'MRM 10': [4, '1/msl', 0, 3, 8, 15],
    'MRM 20': [6, '1/msl', 0, 3, 8, 15],
    'MRM 30': [10, '1/msl', 0, 3, 8, 15],
    'MRM 40': [12, '1/msl', 0, 3, 8, 15],
    'Rocket Launcher 10': [3, '1/msl', 0, 5, 11, 18],
    'Rocket Launcher 15': [4, '1/msl', 0, 4, 9, 15],
    'Rocket Launcher 20': [5, '1/msl', 0, 3, 7, 12],
    'Thunderbolt 5': [3, 5, 5, 6, 12, 18],
    'Thunderbolt 10': [5, 10, 5, 6, 12, 18],
    'Thunderbolt 15': [7, 15, 5, 6, 12, 18],
    'Thunderbolt 20': [8, 20, 5, 6, 12, 18],
    'Anti-Missile System': [1, 'PD', 0, '—', '—', '—'],
    'Laser AMS': [7, 'PD', 0, '—', '—', '—'],
    'TAG': [0, 'designator', 0, 5, 9, 15],
    'Light TAG': [0, 'designator', 0, 3, 6, 9],
    'Narc': [0, 'pod', 0, 3, 6, 9],
    'iNarc': [0, 'pod', 0, 4, 9, 15],
    'Arrow IV': [10, '20 (arty)', 0, '—', '—', '8 boards'],
    'Binary Laser (Blazer) Cannon': [16, 12, 0, 5, 10, 15],
    'Bombast Laser': [12, 12, 0, 5, 10, 15],
  };
  // Clan overrides (looked up when the sheet's tech base says Clan).
  const WC = {
    'ER Micro Laser': [1, 2, 0, 1, 2, 4],
    'ER Small Laser': [2, 5, 0, 2, 4, 6],
    'ER Medium Laser': [5, 7, 0, 5, 10, 15],
    'ER Large Laser': [12, 10, 0, 8, 15, 25],
    'Micro Pulse Laser': [1, 3, 0, 1, 2, 3],
    'Small Pulse Laser': [2, 3, 0, 2, 4, 6],
    'Medium Pulse Laser': [4, 7, 0, 4, 8, 12],
    'Large Pulse Laser': [10, 10, 0, 6, 14, 20],
    'ER Small Pulse Laser': [3, 5, 0, 2, 4, 6],
    'ER Medium Pulse Laser': [6, 7, 0, 5, 9, 14],
    'ER Large Pulse Laser': [13, 10, 0, 7, 15, 23],
    'Heavy Small Laser': [3, 6, 0, 1, 2, 3],
    'Heavy Medium Laser': [7, 10, 0, 3, 6, 9],
    'Heavy Large Laser': [18, 16, 0, 5, 10, 15],
    'Improved Heavy Small Laser': [3, 6, 0, 2, 4, 6],
    'Improved Heavy Medium Laser': [7, 10, 0, 5, 10, 15],
    'Improved Heavy Large Laser': [18, 16, 0, 8, 15, 25],
    'ER PPC': [15, 15, 0, 7, 14, 23],
    'Plasma Cannon': [7, 'heat 2D6', 0, 6, 12, 18],
    'Ultra AC/2': [1, 2, 2, 9, 18, 27],
    'Ultra AC/5': [1, 5, 0, 7, 14, 21],
    'Ultra AC/10': [3, 10, 0, 6, 12, 18],
    'Ultra AC/20': [7, 20, 0, 4, 8, 12],
    'LB 2-X AC': [1, 2, 4, 10, 20, 30],
    'LB 5-X AC': [1, 5, 3, 8, 15, 24],
    'LB 10-X AC': [2, 10, 0, 6, 12, 18],
    'LB 20-X AC': [6, 20, 0, 4, 8, 12],
    'AP Gauss Rifle': [1, 3, 0, 3, 6, 9],
    'HAG/20': [4, '20c', 2, 8, 16, 24],
    'HAG/30': [6, '30c', 2, 8, 16, 24],
    'HAG/40': [8, '40c', 2, 8, 16, 24],
    'ATM 3': [2, '2/msl', 4, 5, 10, 15],
    'ATM 6': [4, '2/msl', 4, 5, 10, 15],
    'ATM 9': [6, '2/msl', 4, 5, 10, 15],
    'ATM 12': [8, '2/msl', 4, 5, 10, 15],
    'Streak SRM 2': [2, '2/msl', 0, 4, 8, 12],
    'Streak SRM 4': [3, '2/msl', 0, 4, 8, 12],
    'Streak SRM 6': [4, '2/msl', 0, 4, 8, 12],
    'Streak LRM 5': [2, '1/msl', 0, 7, 14, 21],
    'Streak LRM 10': [4, '1/msl', 0, 7, 14, 21],
    'Streak LRM 15': [5, '1/msl', 0, 7, 14, 21],
    'Streak LRM 20': [6, '1/msl', 0, 7, 14, 21],
    'LRM 5': [2, '1/msl', 0, 7, 14, 21],
    'LRM 10': [4, '1/msl', 0, 7, 14, 21],
    'LRM 15': [5, '1/msl', 0, 7, 14, 21],
    'LRM 20': [6, '1/msl', 0, 7, 14, 21],
    'LRT 15': [5, '1/msl', 0, 7, 14, 21],
  };

  function weaponStats(name, techBase) {
    const clan = /clan/i.test(String(techBase || ''));
    return (clan && WC[name]) || W[name] || WC[name] || null;
  }

  // ---- destroy rules (mirror of the server's classicAutoDestroyed) ---------
  function engineCrits(u) {
    let n = 0;
    for (const loc in u.critHits || {}) {
      const names = u.sheet.crits[loc] || [];
      (u.critHits[loc] || []).forEach(function (s) {
        if (/engine/i.test(String(names[s] || ''))) n++;
      });
    }
    return n;
  }

  function autoDestroyed(u) {
    const ct = u.sheet.internals.CT;
    if (ct != null && (u.structHit.CT || 0) >= ct) return true;
    if (engineCrits(u) >= 3) return true;
    if (u.pilotHits >= 6) return true;
    return false;
  }

  // ---- render helpers ------------------------------------------------------

  // Bubble row: pips 1..max, filled up to n. Tap pip k -> value k, tap the
  // topmost filled pip -> k-1 (same semantics as the Alpha Strike card).
  function pips(uid, field, max, n, cls) {
    let out = '';
    for (let k = 1; k <= max; k++) {
      out += '<button class="pip tiny ' + cls + (k <= n ? ' hit' : '') + '"' +
        ' data-uid="' + uid + '" data-field="' + field + '" data-n="' + k + '"' +
        ' aria-label="' + cls + ' ' + k + ' of ' + max + '"></button>';
    }
    return out;
  }

  function locBox(u, loc, label) {
    const armor = u.sheet.armor[loc];
    const struct = u.sheet.internals[loc];
    if (armor == null && struct == null) return '';
    let html = '<div class="loc-box" style="grid-area:' + loc.toLowerCase() + '">' +
      '<div class="loc-name">' + esc(label || loc) +
      (armor != null ? ' <span class="loc-max">' + (armor - (u.armorHit[loc] || 0)) + '/' + armor + '</span>' : '') +
      '</div>';
    if (armor != null && armor > 0) {
      html += '<div class="loc-pips">' + pips(u.uid, 'armorHit.' + loc, armor, u.armorHit[loc] || 0, 'armor') + '</div>';
    }
    if (struct != null) {
      html += '<div class="loc-pips struct-pips">' + pips(u.uid, 'structHit.' + loc, struct, u.structHit[loc] || 0, 'struct') + '</div>';
    }
    return html + '</div>';
  }

  function heatTrack(u) {
    let cells = '';
    for (let k = 1; k <= 30; k++) {
      const label = HEAT_AT.get(k);
      cells += '<button class="sq heatc' + (k <= u.heat ? ' hit' : '') + (label ? ' brk' : '') + '"' +
        ' data-uid="' + u.uid + '" data-field="heat" data-n="' + k + '"' +
        (label ? ' title="' + esc(k + ': ' + label) + '"' : '') +
        ' aria-label="heat ' + k + ' of 30">' + k + '</button>';
    }
    // Active effects at the current heat level, worst first.
    const active = HEAT_EFFECTS.filter(function (e) { return u.heat >= e[0]; });
    const legend = HEAT_EFFECTS.slice().reverse().map(function (e) {
      return '<span class="heat-fx' + (u.heat >= e[0] ? ' on' : '') + '">' + e[0] + ' ' + esc(e[1]) + '</span>';
    }).join('');
    return '<div class="sheet-sec"><div class="sec-title">Heat <b>' + u.heat + '</b>' +
      (active.length ? ' <span class="heat-now">' + esc(active[0][1]) + '</span>' : '') +
      '</div><div class="heat-track">' + cells + '</div>' +
      '<div class="heat-legend">' + legend + '</div></div>';
  }

  const CRIT_ORDER = ['HD', 'CT', 'LT', 'RT', 'LA', 'RA', 'LL', 'RL'];
  const LOC_NAMES = {
    HD: 'Head', CT: 'Center Torso', LT: 'Left Torso', RT: 'Right Torso',
    LA: 'Left Arm', RA: 'Right Arm', LL: 'Left Leg', RL: 'Right Leg',
  };

  function critPanel(u) {
    const cols = CRIT_ORDER.filter(function (loc) { return (u.sheet.crits[loc] || []).some(function (s) { return s != null; }); })
      .map(function (loc) {
        const names = u.sheet.crits[loc];
        const marked = u.critHits[loc] || [];
        const rows = names.map(function (name, i) {
          if (name == null) return '';
          const hit = marked.indexOf(i) !== -1;
          return '<button class="crit-slot' + (hit ? ' hit' : '') + '" data-uid="' + u.uid + '"' +
            ' data-toggle="crit.' + loc + '.' + i + '"><span class="cs-n">' + (i + 1) + '</span>' + esc(name) + '</button>';
        }).join('');
        return '<div class="crit-loc"><div class="crit-loc-name">' + esc(LOC_NAMES[loc] || loc) + '</div>' + rows + '</div>';
      }).join('');
    return '<details class="sheet-sec"><summary class="sec-title">Critical Hits' +
      (engineCrits(u) ? ' <span class="warn">engine ' + engineCrits(u) + '/3</span>' : '') +
      '</summary><div class="crit-panel">' + cols + '</div></details>';
  }

  function weaponsPanel(u) {
    if (!u.sheet.weapons.length) return '';
    const rows = u.sheet.weapons.map(function (w, i) {
      const out = (u.weaponsOut || []).indexOf(i) !== -1;
      const st = weaponStats(w.name, u.sheet.techBase);
      const rng = st ? ((st[2] ? st[2] + ' / ' : '') + st[3] + ' / ' + st[4] + ' / ' + st[5]) : '—';
      return '<tr class="' + (out ? 'wout' : '') + '"><td>' + esc(w.name) + '</td><td>' + esc(w.loc) + '</td>' +
        '<td class="num">' + (st ? esc(st[1]) : '—') + '</td><td class="num">' + (st ? st[0] : '—') + '</td>' +
        '<td class="num">' + esc(rng) + '</td>' +
        '<td><button class="ubtn wout-btn' + (out ? ' danger' : '') + '" data-uid="' + u.uid + '"' +
        ' data-toggle="weaponOut.' + i + '">' + (out ? 'OUT' : 'ok') + '</button></td></tr>';
    }).join('');
    return '<div class="sheet-sec"><div class="sec-title">Weapons</div>' +
      '<div class="wpn-wrap"><table class="wpn-table"><thead><tr>' +
      '<th>Weapon</th><th>Loc</th><th class="num">Dmg</th><th class="num">Ht</th><th class="num">Min / S / M / L</th><th></th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div></div>';
  }

  // Pilot hits: 6 boxes with the consciousness numbers under them.
  const PILOT_ROLLS = ['3', '5', '7', '10', '11', 'DEAD'];
  function pilotTrack(u) {
    let boxes = '';
    for (let k = 1; k <= 6; k++) {
      boxes += '<span class="pilot-cell"><button class="sq pilot' + (k <= u.pilotHits ? ' hit' : '') + '"' +
        ' data-uid="' + u.uid + '" data-field="pilotHits" data-n="' + k + '"' +
        ' aria-label="pilot hit ' + k + ' of 6"></button>' +
        '<span class="pilot-roll">' + PILOT_ROLLS[k - 1] + '</span></span>';
    }
    return '<div class="sheet-sec"><div class="sec-title">Pilot Hits' +
      (u.pilotHits >= 6 ? ' <span class="warn">DEAD</span>' : ' <span class="muted">consciousness roll</span>') +
      '</div><div class="pilot-track">' + boxes + '</div></div>';
  }

  function crewSelect(u, field, val) {
    let opts = '';
    for (let k = 0; k <= 8; k++) opts += '<option value="' + k + '"' + (k === val ? ' selected' : '') + '>' + k + '</option>';
    return '<label class="crew-lbl">' + (field === 'gunnery' ? 'Gunnery' : 'Piloting') +
      ' <select class="crew-sel" data-uid="' + u.uid + '" data-field="' + field + '">' + opts + '</select></label>';
  }

  // ---- the card ------------------------------------------------------------
  function html(u, status, canUndo) {
    const s = u.sheet;
    const run = s.walkMp ? Math.ceil(s.walkMp * 1.5) : 0;
    return '' +
      '<div class="unit-card classic-card' + (u.destroyed ? ' destroyed' : '') + '" data-card="' + u.uid + '">' +
      (u.destroyed ? '<span class="wreck-badge">Destroyed</span>' : '') +
      '<div class="u-top"><span class="u-name">' + esc(u.name) + '</span>' +
      '<span class="u-pv">G' + u.gunnery + '/P' + u.piloting + (u.bv != null ? ' • BV ' + u.bv : '') + '</span></div>' +
      '<div class="u-line">' + (s.mass != null ? s.mass + 't' : '') + ' • MV <b>' + (s.walkMp ?? '?') + '/' + run +
      (s.jumpMp ? '/' + s.jumpMp + 'j' : '') + '</b>' +
      (s.role ? ' • ' + esc(s.role) : '') + (s.techBase ? ' • ' + esc(s.techBase) : '') +
      ' • ' + (s.heatSinks ?? '?') + ' ' + esc(s.heatSinkType || '') + ' HS</div>' +
      (status === 'setup'
        ? '<div class="crew-row">' + crewSelect(u, 'gunnery', u.gunnery) + crewSelect(u, 'piloting', u.piloting) +
          '<span class="muted">crew locks when da game starts</span></div>'
        : '') +
      // Armor + structure silhouette: head top, arms flanking the torsos,
      // rear-armor row under the torsos, legs below.
      '<div class="sheet-sec"><div class="sec-title">Armor <span class="key"><i class="pip tiny armor demo"></i> armor <i class="pip tiny struct demo"></i> structure</span></div>' +
      '<div class="mech-grid">' +
      locBox(u, 'HD') + locBox(u, 'LA') + locBox(u, 'LT') + locBox(u, 'CT') + locBox(u, 'RT') + locBox(u, 'RA') +
      locBox(u, 'RTL', 'RTL (rear)') + locBox(u, 'RTC', 'RTC (rear)') + locBox(u, 'RTR', 'RTR (rear)') +
      locBox(u, 'LL') + locBox(u, 'RL') +
      '</div></div>' +
      heatTrack(u) +
      weaponsPanel(u) +
      pilotTrack(u) +
      critPanel(u) +
      '<div class="u-foot">' +
      '<input class="notes" data-uid="' + u.uid + '" maxlength="200" placeholder="notes…" value="' + esc(u.notes) + '">' +
      '<button class="ubtn" data-undo="' + u.uid + '"' + (canUndo ? '' : ' disabled') + '>↩ Undo</button>' +
      '<button class="ubtn danger" data-wreck="' + u.uid + '">' + (u.destroyed ? 'Revive' : 'Wreck') + '</button>' +
      '</div></div>';
  }

  window.ClassicCard = { html: html, autoDestroyed: autoDestroyed, weaponStats: weaponStats, HEAT_EFFECTS: HEAT_EFFECTS };
})();
