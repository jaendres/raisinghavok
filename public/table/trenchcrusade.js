// Game Night — Trench Crusade model card.
//
// Renders one snapshotted warband member (see server/tracker-trenchcrusade.js
// snapshotUnits): the four-stat line, the BLOOD MARKER counter — the number
// players actually lose track of, so it gets the biggest control on the card —
// the injury track and state chips, the once-per-round ACTIVATED toggle, and
// the model's battlekit with spent toggles.
//
// Exposed as window.TrenchCrusadeCard; table.js owns all event handling. Every
// control is a data-attribute the shared delegated listeners understand:
//   .pip / .sq  + data-uid + data-field + data-n   -> numeric set (tap-same clears)
//   [data-uid][data-toggle="field"]                -> boolean flip
//   [data-uid][data-set="field"][data-value="v"]   -> enum set  (NEW handler, see report)
//   [data-undo] / [data-wreck] / input.notes       -> shared foot controls
// applyLocal()/readField() are exported so table.js can delegate its optimistic
// update and current-value lookup for this game in one line each.
(function () {
  'use strict';

  var MAX_BLOOD = 20;        // matches the server's tracker ceiling
  var BLOOD_PIPS = 10;       // tap-pips shown; the stepper covers the rest
  var STATES = [
    ['active', 'Active'],
    ['injured', 'Injured / Down'],
    ['outOfAction', 'Out of Action'],
  ];

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  // A model is out of the game only when it is Out of Action — Blood Markers
  // never remove a model, they only make it worse at everything.
  function autoDestroyed(u) {
    return u.state === 'outOfAction';
  }

  // ---- optimistic-update helpers (table.js delegates to these) -------------

  function readField(u, field) {
    if (field.indexOf('used.') === 0) return (u.used || []).indexOf(+field.slice(5)) !== -1;
    return u[field];
  }

  function applyLocal(u, field, value) {
    if (field.indexOf('used.') === 0) {
      var i = +field.slice(5);
      var set = (u.used || []).filter(function (x) { return x !== i; });
      if (value) set.push(i);
      u.used = set.sort(function (a, b) { return a - b; });
      return;
    }
    if (field === 'bloodMarkers') { u.bloodMarkers = value; return; }
    if (field === 'wounds') {
      u.wounds = value;
      if (value >= u.maxWounds) u.state = 'outOfAction';
      else if (u.state === 'outOfAction') u.state = value > 0 ? 'injured' : 'active';
      u.destroyed = autoDestroyed(u);
      return;
    }
    if (field === 'state') {
      u.state = value;
      if (value === 'active') u.wounds = 0;
      if (value === 'outOfAction' && u.wounds < u.maxWounds) u.wounds = u.maxWounds;
      u.destroyed = autoDestroyed(u);
      return;
    }
    if (field === 'activated') { u.activated = Boolean(value); return; }
    if (field === 'notes') { u.notes = value; return; }
    if (field === 'destroyed') {
      u.destroyed = Boolean(value);
      if (u.destroyed) { u.state = 'outOfAction'; u.wounds = u.maxWounds; }
      else if (u.state === 'outOfAction') { u.state = 'active'; u.wounds = 0; }
    }
  }

  // ---- pieces --------------------------------------------------------------

  function statStrip(u) {
    var s = u.statline || {};
    var cell = function (label, v) {
      return '<div class="tc-stat"><span class="tc-stat-l">' + label + '</span>' +
        '<span class="tc-stat-v">' + esc(v == null || v === '' ? '—' : v) + '</span></div>';
    };
    var alts = (u.altProfiles || []).map(function (a) {
      return '<div class="tc-alt"><b>' + esc(a.name) + '</b> ' + esc(a.movement) +
        ' · R ' + esc(a.ranged) + ' / M ' + esc(a.melee) + ' · Armour ' + esc(a.armour) + '</div>';
    }).join('');
    return '<div class="tc-stats">' +
      cell('Move', s.movement) + cell('Ranged', s.ranged) +
      cell('Melee', s.melee) + cell('Armour', s.armour) +
      '</div>' + alts;
  }

  // THE control. Big stepper (the number you shout across the table) plus a
  // row of tap-pips for setting it straight from a dice result.
  function bloodBlock(u, live) {
    var n = u.bloodMarkers || 0;
    var pips = '';
    for (var k = 1; k <= BLOOD_PIPS; k++) {
      pips += '<button class="pip tc-bpip' + (k <= n ? ' hit' : '') + '"' +
        ' data-uid="' + u.uid + '" data-field="bloodMarkers" data-n="' + k + '"' +
        ' aria-label="blood marker ' + k + '"></button>';
    }
    var step = function (delta, glyph, off) {
      return '<button class="sq tc-bstep" data-uid="' + u.uid + '" data-field="bloodMarkers"' +
        ' data-n="' + (n + delta) + '"' + (off ? ' disabled' : '') +
        ' aria-label="' + (delta > 0 ? 'add' : 'remove') + ' blood marker">' + glyph + '</button>';
    };
    return '<div class="tc-blood' + (n > 0 ? ' bleeding' : '') + '">' +
      '<div class="tc-blood-head">Blood Markers</div>' +
      '<div class="tc-blood-row">' +
      step(-1, '−', !live || n <= 0) +
      '<span class="tc-blood-n">' + n + '</span>' +
      step(1, '+', !live || n >= MAX_BLOOD) +
      '<span class="tc-bpips">' + pips + '</span>' +
      '</div></div>';
  }

  function woundRow(u) {
    var max = u.maxWounds || 3;
    var n = u.wounds || 0;
    var pips = '';
    for (var k = 1; k <= max; k++) {
      pips += '<button class="pip tc-wpip' + (k <= n ? ' hit' : '') + '"' +
        ' data-uid="' + u.uid + '" data-field="wounds" data-n="' + k + '"' +
        ' aria-label="injury ' + k + ' of ' + max + '"></button>';
    }
    return '<div class="tc-row"><span class="tc-lbl" title="Trench Crusade has no Wounds stat — dis is a scratch injury counter">Injuries</span>' +
      pips + '</div>';
  }

  function stateChips(u) {
    var chips = STATES.map(function (s) {
      return '<button class="tc-chip' + (u.state === s[0] ? ' on' : '') + ' tc-chip-' + s[0] + '"' +
        ' data-uid="' + u.uid + '" data-set="state" data-value="' + s[0] + '">' + s[1] + '</button>';
    }).join('');
    return '<div class="tc-row"><span class="tc-lbl">State</span><span class="tc-chips">' + chips + '</span></div>';
  }

  function activatedBtn(u, live) {
    return '<button class="tc-act' + (u.activated ? ' on' : '') + '"' +
      ' data-uid="' + u.uid + '" data-toggle="activated"' + (live ? '' : ' disabled') + '>' +
      (u.activated ? '✓ Activated dis round' : 'Not yet activated') + '</button>';
  }

  function equipList(u) {
    var items = u.equipment || [];
    if (!items.length) return '';
    var rows = items.map(function (e, i) {
      var spent = (u.used || []).indexOf(i) !== -1;
      var p = e.profile || {};
      var bits = [];
      if (p.type) bits.push(esc(p.type));
      if (p.range && p.range !== '-') bits.push('Range ' + esc(p.range));
      if (p.keywords && p.keywords.length) {
        var kw = p.keywords.filter(function (k) { return k !== '-'; });
        if (kw.length) bits.push(esc(kw.join(', ')));
      }
      return '<div class="tc-item' + (spent ? ' spent' : '') + '">' +
        '<button class="tc-spend' + (spent ? ' on' : '') + '"' +
        ' data-uid="' + u.uid + '" data-toggle="used.' + i + '"' +
        ' aria-label="' + esc(e.name) + ' spent">' + (spent ? '✕' : '') + '</button>' +
        '<span class="tc-item-body">' +
        '<span class="tc-item-name">' + esc(e.name) +
        (e.oneUse ? '<span class="tc-oneuse">one use</span>' : '') + '</span>' +
        (bits.length ? '<span class="tc-item-prof">' + bits.join(' · ') + '</span>' : '') +
        (p.rules ? '<span class="tc-item-rules">' + esc(p.rules) + '</span>' : '') +
        (e.note ? '<span class="tc-item-note">' + esc(e.note) + '</span>' : '') +
        '</span></div>';
    }).join('');
    return '<div class="sheet-sec"><div class="sec-title">Battlekit <span class="tc-hint">tap da box when it\'s spent</span></div>' +
      '<div class="tc-items">' + rows + '</div></div>';
  }

  function abilityBlocks(u) {
    if (!u.abilities || !u.abilities.length) return '';
    var blocks = u.abilities.map(function (a) {
      return '<details class="tc-ability"><summary>' + esc(a.name) + '</summary>' +
        '<div class="tc-ability-body">' + esc(a.text) + '</div></details>';
    }).join('');
    return '<div class="sheet-sec"><div class="sec-title">Abilities</div>' + blocks + '</div>';
  }

  // ---- the card ------------------------------------------------------------

  function html(u, status, canUndo) {
    var live = status !== 'done';
    var out = u.destroyed || u.state === 'outOfAction';
    var subtitle = [u.catalogName && u.catalogName !== u.name ? u.catalogName : '',
      u.type ? '(' + u.type + ')' : '', u.warband || ''].filter(Boolean).join(' ');
    return '' +
      '<div class="unit-card tc-card' + (out ? ' destroyed' : '') + (u.activated && !out ? ' tc-gone' : '') +
      '" data-card="' + u.uid + '">' +
      (out ? '<span class="wreck-badge">Out of Action</span>' : '') +
      '<div class="u-top"><span class="u-name">' + esc(u.name) + '</span>' +
      (u.cost ? '<span class="u-pv">' + esc(u.cost) + '</span>' : '') + '</div>' +
      (subtitle ? '<div class="u-line">' + esc(subtitle) +
        (u.matched === false ? ' <span class="tc-unmatched">not in da catalog — stats from yer paste</span>' : '') +
        '</div>' : '') +
      statStrip(u) +
      bloodBlock(u, live) +
      activatedBtn(u, live) +
      woundRow(u) +
      stateChips(u) +
      equipList(u) +
      abilityBlocks(u) +
      ((u.keywords || []).length ? '<div class="kw-line"><b>Keywords:</b> ' + esc(u.keywords.join(', ')) + '</div>' : '') +
      '<div class="u-foot">' +
      '<input class="notes" data-uid="' + u.uid + '" maxlength="200" placeholder="notes…" value="' + esc(u.notes) + '">' +
      '<button class="ubtn" data-undo="' + u.uid + '"' + (canUndo ? '' : ' disabled') + '>↩ Undo</button>' +
      '<button class="ubtn danger" data-wreck="' + u.uid + '">' + (out ? 'Revive' : 'Out of Action') + '</button>' +
      '</div></div>';
  }

  window.TrenchCrusadeCard = {
    html: html,
    autoDestroyed: autoDestroyed,
    applyLocal: applyLocal,
    readField: readField,
    MAX_BLOOD: MAX_BLOOD,
  };
})();
