// Game Night — Marvel Crisis Protocol character card.
//
// Renders one snapshotted character (see server/tracker-mcp.js snapshotUnit).
// The whole card is built around the flip: an MCP character has TWO sides,
// Healthy and Injured, and which one is face-up decides how much stamina is
// left. The state strip at the top of the card says which side you are on and
// the damage pips below it run against THAT side's stamina — fill them and the
// server flips the card (Healthy -> Injured -> KO).
//
// Exposed as window.McpCard; table.js owns all event handling — this file only
// produces HTML carrying the data- attributes the delegated listeners read:
//   .pip[data-uid][data-field="damage"][data-n]   damage pips (shared handler)
//   [data-uid][data-toggle="effect.bleed"]        status chips (shared handler)
//   [data-uid][data-toggle="holdingObjective"]    objective chip (shared)
//   [data-uid][data-set="side"][data-v]           flip the card (new handler)
//   [data-uid][data-step="power"][data-d]         power +/- (new handler)
//   input.notes / [data-undo] / [data-wreck]      the shared .u-foot
(function () {
  'use strict';

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  // Status effects MCP actually puts on a character card. Order matches the
  // server's EFFECTS list (server/tracker-mcp.js) — the ids are the patch
  // fields, so the two must not drift apart.
  var EFFECTS = [
    ['bleed', 'Bleed'],
    ['poison', 'Poison'],
    ['stagger', 'Stagger'],
    ['shock', 'Shock'],
    ['slow', 'Slow'],
    ['hex', 'Hex'],
    ['root', 'Root'],
    ['incinerate', 'Incinerate'],
  ];

  var STATE_LABEL = { healthy: 'Healthy', injured: 'Injured', ko: 'KO' };

  // A character is out when its card has been flipped past Injured. Mirrors
  // server/tracker-mcp.js autoDestroyed so the optimistic client agrees.
  function autoDestroyed(u) {
    return u.side === 'ko';
  }

  function staminaOf(u) {
    if (u.side === 'injured') return u.stamina.injured;
    if (u.side === 'ko') return 0;
    return u.stamina.healthy;
  }

  // ---- the flip strip: three big face-up states, the current one lit -------
  function stateStrip(u) {
    var cells = ['healthy', 'injured', 'ko'].map(function (s) {
      var live = u.side === s;
      var stam = s === 'healthy' ? u.stamina.healthy : s === 'injured' ? u.stamina.injured : null;
      return '<button class="mcp-state mcp-' + s + (live ? ' on' : '') + '"' +
        ' data-uid="' + u.uid + '" data-set="side" data-v="' + s + '"' +
        ' aria-pressed="' + (live ? 'true' : 'false') + '"' +
        ' title="' + (s === 'ko' ? "mark KO'd" : 'put the ' + STATE_LABEL[s] + ' side face up') + '">' +
        '<span class="mcp-state-name">' + STATE_LABEL[s] + '</span>' +
        '<span class="mcp-state-sub">' + (stam == null ? 'out' : stam + ' stam') + '</span>' +
        '</button>';
    }).join('');
    return '<div class="mcp-flip" role="group" aria-label="card side">' + cells + '</div>';
  }

  // ---- damage pips against the FACE-UP side's stamina ----------------------
  // Tap semantics are the shared ones: pip k sets damage to k, tapping the
  // topmost filled pip clears it. Filling the last pip is the daze — the
  // server flips the card and hands back a fresh, empty track.
  function damageRow(u) {
    var max = staminaOf(u);
    if (u.side === 'ko') {
      return '<div class="pip-row mcp-dmg-row"><span class="plabel">Damage</span>' +
        '<span class="mcp-out">Out of da game</span></div>';
    }
    var pips = '';
    for (var k = 1; k <= max; k++) {
      pips += '<button class="pip mcp-dmg' + (k <= u.damage ? ' hit' : '') +
        (k === max ? ' mcp-brk' : '') + '"' +
        ' data-uid="' + u.uid + '" data-field="damage" data-n="' + k + '"' +
        ' aria-label="damage ' + k + ' of ' + max + '"></button>';
    }
    return '<div class="pip-row mcp-dmg-row"><span class="plabel">Damage</span>' + pips +
      '<span class="mcp-dmg-now">' + u.damage + '/' + max +
      '<span class="mcp-brk-hint"> — ' + (u.side === 'healthy' ? 'dazes' : "KO's") + ' at ' + max + '</span>' +
      '</span></div>';
  }

  // ---- power: a plain counter, big targets, no cap worth enforcing ---------
  function powerRow(u) {
    return '<div class="mcp-power-row">' +
      '<span class="plabel">Power</span>' +
      '<button class="mcp-step" data-uid="' + u.uid + '" data-step="power" data-d="-1" aria-label="spend power">−</button>' +
      '<b class="mcp-power">' + (u.power || 0) + '</b>' +
      '<button class="mcp-step" data-uid="' + u.uid + '" data-step="power" data-d="1" aria-label="gain power">+</button>' +
      '</div>';
  }

  function statLine(u) {
    var d = u.defenses || {};
    return '<div class="u-line mcp-stats">' +
      '<span class="mcp-def"><i>Phys</i> <b>' + (d.physical != null ? d.physical : '?') + '</b></span>' +
      '<span class="mcp-def"><i>Energy</i> <b>' + (d.energy != null ? d.energy : '?') + '</b></span>' +
      '<span class="mcp-def"><i>Mystic</i> <b>' + (d.mystic != null ? d.mystic : '?') + '</b></span>' +
      '<span class="mcp-def"><i>Mv</i> <b>' + esc(u.movement || '?') + '</b></span>' +
      '<span class="mcp-def"><i>Size</i> <b>' + (u.size != null ? u.size : '?') + '</b></span>' +
      '</div>';
  }

  function effectChips(u) {
    var fx = u.effects || {};
    var chips = EFFECTS.map(function (e) {
      var on = Boolean(fx[e[0]]);
      return '<button class="mcp-chip mcp-fx-' + e[0] + (on ? ' on' : '') + '"' +
        ' data-uid="' + u.uid + '" data-toggle="effect.' + e[0] + '"' +
        ' aria-pressed="' + (on ? 'true' : 'false') + '">' + e[1] + '</button>';
    }).join('');
    var obj = '<button class="mcp-chip mcp-obj' + (u.holdingObjective ? ' on' : '') + '"' +
      ' data-uid="' + u.uid + '" data-toggle="holdingObjective"' +
      ' aria-pressed="' + (u.holdingObjective ? 'true' : 'false') + '">◆ Hold Token</button>';
    return '<div class="sheet-sec mcp-fx-sec"><div class="sec-title">Status ' +
      '<span class="muted">tap what da character is suffering</span></div>' +
      '<div class="mcp-chips">' + chips + obj + '</div></div>';
  }

  function subLine(u) {
    var bits = [];
    if (u.alterEgo) bits.push(esc(u.alterEgo));
    if (u.affiliations && u.affiliations.length) bits.push(esc(u.affiliations.join(' / ')));
    if (!u.catalogMatched) bits.push('<span class="warn">not in da catalog</span>');
    return bits.length ? '<div class="u-line mcp-sub">' + bits.join(' • ') + '</div>' : '';
  }

  // status is the table's status ('setup' | 'playing' | 'done'); the card reads
  // the same on all three — table.js decides whether taps do anything.
  function html(u, status, canUndo) {
    var out = autoDestroyed(u) || u.destroyed;
    return '' +
      '<div class="unit-card mcp-card' + (out ? ' destroyed' : '') +
      ' mcp-side-' + esc(u.side) + '" data-card="' + u.uid + '">' +
      (out ? '<span class="wreck-badge">KO</span>' : '') +
      '<div class="u-top">' +
      '<span class="u-name">' + (u.leader ? '<span class="mcp-star" title="roster leader">★</span> ' : '') +
      esc(u.name) + '</span>' +
      '<span class="u-pv">' + (u.threat != null ? u.threat : '?') + ' THREAT</span>' +
      '</div>' +
      subLine(u) +
      stateStrip(u) +
      damageRow(u) +
      powerRow(u) +
      statLine(u) +
      effectChips(u) +
      (u.holdingObjective ? '<div class="mcp-carrying">Carrying an objective</div>' : '') +
      '<div class="u-foot">' +
      '<input class="notes" data-uid="' + u.uid + '" maxlength="200" placeholder="notes…" value="' + esc(u.notes) + '">' +
      '<button class="ubtn" data-undo="' + u.uid + '"' + (canUndo ? '' : ' disabled') + '>↩ Undo</button>' +
      '<button class="ubtn danger" data-wreck="' + u.uid + '">' + (out ? 'Revive' : 'KO') + '</button>' +
      '</div></div>';
  }

  window.McpCard = { html: html, autoDestroyed: autoDestroyed };
})();
