// Game Night — Necromunda fighter card.
//
// Renders one snapshotted fighter (see server/tracker-necromunda.js
// snapshotUnits): the 12-stat statline with the flesh-wound-reduced Toughness
// shown live, the wound track, flesh-wound markers, the condition chips, the
// mid-game status flags, and the weapons list with a per-weapon OUT OF AMMO
// toggle.
//
// Exposed as window.NecromundaCard; table.js owns all event handling — this
// file only produces HTML carrying the shared data- attributes:
//   .pip / .sq  [data-uid][data-field][data-n]  -> set field to n (tap again clears)
//   [data-uid][data-toggle="ammoOut.3"|"flag.blaze"]  -> boolean toggle
//   [data-uid][data-set="condition"][data-value="pinned"]  -> set field to a value
//   [data-uid] on .notes / [data-undo] / [data-wreck]  -> the shared .u-foot
//
// readField() and applyLocal() are exported so table.js can delegate the
// necromunda-shaped fields instead of growing another branch per field.
(function () {
  'use strict';

  // Text-node escaping, as the other cards do it.
  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  // Attribute-value escaping. innerHTML does not escape quotes, and the notes
  // field is the one place player-typed text lands inside an attribute — a
  // note with a double quote in it would otherwise break out of value="…".
  function escAttr(s) {
    return esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var CONDITIONS = ['active', 'pinned', 'seriouslyInjured', 'outOfAction'];
  var CONDITION_NAMES = {
    active: 'Active',
    pinned: 'Pinned',
    seriouslyInjured: 'Seriously Injured',
    outOfAction: 'Out of Action',
  };
  // Short lines under each chip: what the state means at the table. The
  // tracker records the state, the players roll for it.
  var CONDITION_HINT = {
    active: 'ready',
    pinned: 'prone, no move',
    seriouslyInjured: 'prone, crawls',
    outOfAction: 'off da board',
  };
  var FLAGS = ['engaged', 'prone', 'broken', 'blaze', 'webbed', 'insane'];
  var FLAG_NAMES = {
    engaged: 'Engaged',
    prone: 'Prone',
    broken: 'Broken',
    blaze: 'Blaze',
    webbed: 'Webbed',
    insane: 'Insane',
  };
  var STAT_KEYS = ['m', 'ws', 'bs', 's', 't', 'w', 'i', 'a', 'ld', 'cl', 'wil', 'int'];
  var STAT_LABELS = { m: 'M', ws: 'WS', bs: 'BS', s: 'S', t: 'T', w: 'W', i: 'I', a: 'A', ld: 'Ld', cl: 'Cl', wil: 'Wil', int: 'Int' };
  var MAX_FLESH_WOUNDS = 10;

  var num = function (v) {
    var m = String(v == null ? '' : v).match(/(\d+)/);
    return m ? Number(m[1]) : null;
  };
  var int0 = function (v) { return Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0; };

  // ---- rules mirrors (the server remains the referee) ----------------------

  function baseToughness(u) {
    if (u && Number.isFinite(u.toughness)) return u.toughness;
    return num(u && u.statline ? u.statline.t : null);
  }

  // Each flesh wound is -1 Toughness; at 0 the fighter goes Out of Action.
  function effectiveToughness(u) {
    var base = baseToughness(u);
    if (!Number.isFinite(base)) return null;
    return Math.max(0, base - int0(u.fleshWounds));
  }

  function destroyedReason(u) {
    if (!u) return null;
    if (u.condition === 'outOfAction') return 'out of action';
    var base = baseToughness(u);
    if (Number.isFinite(base) && base > 0 && int0(u.fleshWounds) >= base) return 'Toughness 0';
    return null;
  }

  function autoDestroyed(u) { return destroyedReason(u) !== null; }

  // A full wound track is an Injury dice roll owed, not a dead fighter.
  function injuryPending(u) {
    if (!u || u.condition === 'outOfAction') return false;
    return int0(u.wounds) >= (int0(u.maxWounds) || 1);
  }

  // ---- field read / local apply (table.js delegates here) ------------------

  // Returns undefined for fields this game does not own, so a caller can fall
  // through to its own handling.
  function readField(u, field) {
    if (!u || typeof field !== 'string') return undefined;
    if (field === 'wounds') return int0(u.wounds);
    if (field === 'fleshWounds') return int0(u.fleshWounds);
    if (field === 'condition') return u.condition || 'active';
    if (field.indexOf('ammoOut.') === 0) {
      return (u.ammoOut || []).indexOf(+field.slice(8)) !== -1;
    }
    if (field.indexOf('flag.') === 0) {
      return Boolean((u.flags || {})[field.slice(5)]);
    }
    return undefined;
  }

  // Optimistic local write mirroring the server's rules. Returns true when it
  // handled the field.
  function applyLocal(u, field, value) {
    if (!u || typeof field !== 'string') return false;
    if (field === 'wounds') { u.wounds = int0(value); return true; }
    if (field === 'fleshWounds') {
      u.fleshWounds = int0(value);
      u.destroyed = autoDestroyed(u) ? true : (u.condition === 'outOfAction');
      return true;
    }
    if (field === 'condition') {
      if (CONDITIONS.indexOf(value) === -1) return true;
      u.condition = value;
      u.destroyed = value === 'outOfAction' ? true : autoDestroyed(u);
      return true;
    }
    if (field.indexOf('ammoOut.') === 0) {
      var i = +field.slice(8);
      var set = (u.ammoOut || []).filter(function (x) { return x !== i; });
      if (value) set.push(i);
      set.sort(function (a, b) { return a - b; });
      u.ammoOut = set;
      return true;
    }
    if (field.indexOf('flag.') === 0) {
      var key = field.slice(5);
      if (FLAGS.indexOf(key) === -1) return true;
      if (!u.flags || typeof u.flags !== 'object') u.flags = {};
      if (value) u.flags[key] = true; else delete u.flags[key];
      return true;
    }
    return false;
  }

  // ---- pieces --------------------------------------------------------------

  // 12-stat statline. Toughness prints as "base→effective" and goes red once
  // flesh wounds have bitten.
  function statTable(u) {
    var sl = u.statline || {};
    var base = baseToughness(u);
    var eff = effectiveToughness(u);
    var reduced = Number.isFinite(base) && Number.isFinite(eff) && eff < base;
    var heads = '';
    var cells = '';
    for (var i = 0; i < STAT_KEYS.length; i++) {
      var k = STAT_KEYS[i];
      heads += '<th class="num' + (k === 't' && reduced ? ' nec-t-head' : '') + '">' + STAT_LABELS[k] + '</th>';
      if (k === 't' && reduced) {
        cells += '<td class="num nec-t-cut"><s>' + esc(sl.t) + '</s>&nbsp;' + eff + '</td>';
      } else {
        cells += '<td class="num">' + esc(sl[k] == null ? '-' : sl[k]) + '</td>';
      }
    }
    return '<div class="wpn-wrap nec-stat-wrap"><table class="wpn-table stat-table nec-stats">' +
      '<thead><tr>' + heads + '</tr></thead><tbody><tr>' + cells + '</tr></tbody></table></div>';
  }

  // Wound track: circular pips, tap k to set the wounds taken to k.
  function woundRow(u) {
    var max = int0(u.maxWounds) || 1;
    var taken = int0(u.wounds);
    var mini = max > 6 ? ' nec-mini' : '';
    var out = '';
    for (var k = 1; k <= max; k++) {
      out += '<button class="pip nec-pip nec-wound' + mini + (k <= taken ? ' hit' : '') + '"' +
        ' data-uid="' + u.uid + '" data-field="wounds" data-n="' + k + '"' +
        ' aria-label="wound ' + k + ' of ' + max + '"></button>';
    }
    return '<div class="pip-row nec-row"><span class="plabel">Wounds</span>' + out +
      '<span class="nec-count">' + (max - taken) + '/' + max + '</span>' +
      (injuryPending(u) ? '<span class="nec-injury">Roll Injury dice</span>' : '') +
      '</div>';
  }

  // Flesh wounds: square markers, each one -1 Toughness. The track runs to the
  // fighter's base Toughness (that is where they go Out of Action), with a
  // couple of spares for tough customers and unreadable statlines.
  function fleshRow(u) {
    var base = baseToughness(u);
    var shown = Math.min(MAX_FLESH_WOUNDS, Math.max(Number.isFinite(base) && base > 0 ? base : 4, int0(u.fleshWounds) + 1, 3));
    var have = int0(u.fleshWounds);
    var out = '';
    for (var k = 1; k <= shown; k++) {
      var fatal = Number.isFinite(base) && base > 0 && k >= base;
      out += '<button class="sq nec-fw' + (fatal ? ' nec-fw-fatal' : '') + (k <= have ? ' hit' : '') + '"' +
        ' data-uid="' + u.uid + '" data-field="fleshWounds" data-n="' + k + '"' +
        ' aria-label="flesh wound ' + k + ' of ' + shown + '"></button>';
    }
    var eff = effectiveToughness(u);
    return '<div class="pip-row nec-row"><span class="plabel">Flesh Wd</span>' + out +
      '<span class="nec-count">' + (eff != null ? 'T ' + eff : '−1 T each') + '</span></div>';
  }

  // Condition chips — the state machine, one tap per state.
  function conditionChips(u) {
    var cur = u.condition || 'active';
    var chips = '';
    for (var i = 0; i < CONDITIONS.length; i++) {
      var c = CONDITIONS[i];
      chips += '<button class="nec-chip nec-chip-' + c + (c === cur ? ' on' : '') + '"' +
        ' data-uid="' + u.uid + '" data-set="condition" data-value="' + c + '"' +
        ' aria-pressed="' + (c === cur ? 'true' : 'false') + '">' +
        '<span class="nec-chip-n">' + CONDITION_NAMES[c] + '</span>' +
        '<span class="nec-chip-h">' + CONDITION_HINT[c] + '</span></button>';
    }
    return '<div class="sheet-sec"><div class="sec-title">Condition ' +
      '<span class="muted">' + esc(CONDITION_NAMES[cur] || cur) + '</span></div>' +
      '<div class="nec-chips">' + chips + '</div></div>';
  }

  function flagRow(u) {
    var on = u.flags || {};
    var out = '';
    for (var i = 0; i < FLAGS.length; i++) {
      var f = FLAGS[i];
      out += '<button class="nec-flag nec-flag-' + f + (on[f] ? ' on' : '') + '"' +
        ' data-uid="' + u.uid + '" data-toggle="flag.' + f + '"' +
        ' aria-pressed="' + (on[f] ? 'true' : 'false') + '">' + FLAG_NAMES[f] + '</button>';
    }
    return '<div class="sheet-sec"><div class="sec-title">Status</div>' +
      '<div class="nec-flags">' + out + '</div></div>';
  }

  // Weapons: name + profile line + the ammo toggle. A weapon that failed its
  // Ammo check stays out until it is repaired (Ready action + Ammo roll).
  function weaponList(u) {
    var ws = u.weapons || [];
    if (!ws.length) return '';
    var outSet = u.ammoOut || [];
    var rows = '';
    for (var i = 0; i < ws.length; i++) {
      var isOut = outSet.indexOf(i) !== -1;
      rows += '<div class="nec-wpn' + (isOut ? ' out' : '') + '">' +
        '<div class="nec-wpn-txt">' +
        '<div class="nec-wpn-name">' + esc(ws[i].name) + '</div>' +
        '<div class="nec-wpn-prof">' + esc(ws[i].profile) + '</div></div>' +
        '<button class="nec-ammo' + (isOut ? ' on' : '') + '" data-uid="' + u.uid + '"' +
        ' data-toggle="ammoOut.' + i + '" aria-pressed="' + (isOut ? 'true' : 'false') + '"' +
        ' title="ammo check failed — out until repaired">' + (isOut ? 'NO AMMO' : 'AMMO') + '</button>' +
        '</div>';
    }
    return '<div class="sheet-sec"><div class="sec-title">Weapons ' +
      '<span class="muted">tap AMMO on a failed check</span></div>' + rows + '</div>';
  }

  // ---- the card ------------------------------------------------------------

  function html(u, status, canUndo) {
    var down = Boolean(u.destroyed) || autoDestroyed(u);
    var reason = destroyedReason(u);
    var sub = [u.type, u.category ? '(' + u.category + ')' : '', u.gang].filter(Boolean).join(' ');
    return '' +
      '<div class="unit-card nec-card' + (down ? ' destroyed' : '') + '" data-card="' + u.uid + '">' +
      (down ? '<span class="wreck-badge">Out of Action</span>' : '') +
      '<div class="u-top"><span class="u-name">' + esc(u.name) + '</span>' +
      (u.cost ? '<span class="u-pv">' + esc(u.cost) + '</span>' : '') + '</div>' +
      (sub ? '<div class="u-line">' + esc(sub) +
        (u.enriched ? '' : ' <span class="nec-paste">from paste</span>') + '</div>' : '') +
      statTable(u) +
      '<div class="nec-tracks">' + woundRow(u) + fleshRow(u) + '</div>' +
      (reason ? '<div class="nec-reason">' + esc(reason) + '</div>' : '') +
      conditionChips(u) +
      flagRow(u) +
      weaponList(u) +
      ((u.gear || []).length
        ? '<div class="u-line nec-gear"><b>Gear:</b> ' + esc(u.gear.join(', ')) + '</div>'
        : '') +
      '<div class="u-foot">' +
      '<input class="notes" data-uid="' + u.uid + '" maxlength="200" placeholder="notes…" value="' + escAttr(u.notes) + '">' +
      '<button class="ubtn" data-undo="' + u.uid + '"' + (canUndo ? '' : ' disabled') + '>↩ Undo</button>' +
      '<button class="ubtn danger" data-wreck="' + u.uid + '">' + (u.destroyed ? 'Revive' : 'OOA') + '</button>' +
      '</div></div>';
  }

  // Gang bottle indicator — the side header renders this next to the gang name.
  // A gang tests once half its starting crew is Out of Action.
  function bottleState(side) {
    var units = (side && Array.isArray(side.units)) ? side.units : [];
    var fighters = units.length;
    var out = 0;
    for (var i = 0; i < fighters; i++) {
      if (units[i].destroyed || autoDestroyed(units[i])) out++;
    }
    return {
      fighters: fighters,
      out: out,
      standing: fighters - out,
      threshold: Math.ceil(fighters / 2),
      mustTest: fighters > 0 && out * 2 >= fighters,
      bottled: Boolean(side && side.bottled),
    };
  }

  function bottleHTML(side, sideIdx) {
    var b = bottleState(side);
    var cls = b.bottled ? ' bottled' : (b.mustTest ? ' testing' : '');
    return '<span class="nec-bottle' + cls + '" data-bottle="' + sideIdx + '">' +
      '<span class="lbl">Bottle</span>' +
      '<b>' + b.out + '/' + b.fighters + ' OOA</b>' +
      '<span class="nec-bottle-st">' +
      (b.bottled ? 'BOTTLED OUT' : (b.mustTest ? 'test at round start' : 'holding')) +
      '</span></span>';
  }

  window.NecromundaCard = {
    html: html,
    autoDestroyed: autoDestroyed,
    destroyedReason: destroyedReason,
    effectiveToughness: effectiveToughness,
    injuryPending: injuryPending,
    readField: readField,
    applyLocal: applyLocal,
    bottleState: bottleState,
    bottleHTML: bottleHTML,
    CONDITIONS: CONDITIONS,
    CONDITION_NAMES: CONDITION_NAMES,
    FLAGS: FLAGS,
    FLAG_NAMES: FLAG_NAMES,
  };
})();
