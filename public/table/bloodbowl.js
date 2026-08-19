// Game Night — Blood Bowl match tracker card + match bar.
//
// Renders the snapshot produced by server/tracker-bloodbowl.js. Two exports:
//
//   matchBarHtml(match, sides) — the centrepiece. Half, each team's turn
//     counter (the thing somebody taps every thirty seconds, so it is the
//     biggest control on the screen), score, rerolls remaining and weather,
//     sized to be read from the far side of the table.
//   html(unit, status, canUndo) — one player: number, name, position, the
//     MA/ST/AG/PA/AV line, skills, the state chips, and a stepper for every
//     SPP-earning event (TD / CAS / COMP / INT / DEF) plus the MVP toggle.
//
// Exposed as window.BloodBowlCard; table.js owns ALL event handling — this
// file only emits data- attributes for the shared delegated listeners:
//
//   [data-uid][data-field][data-val]        set a unit field to a string
//   [data-uid][data-field][data-d]          step a numeric unit field by d
//   [data-uid][data-toggle]                 flip a boolean unit field
//   input.notes[data-uid] / [data-undo] / [data-wreck]   (unchanged)
//   [data-mfield][data-d]                   step a match field by d
//   [data-mfield][data-mval]                set a match field absolutely
//   [data-mtoggle]                          flip a boolean match field
//   select/input[data-mfield]               set a match field on change
//   ...each with data-mside="<sideIdx>" when the field is per-side.
(function () {
  'use strict';

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  const STATES = [
    ['ready', 'Ready'],
    ['prone', 'Prone'],
    ['stunned', 'Stunned'],
    ['ko', "KO'd"],
    ['casualty', 'Cas'],
    ['sentOff', 'Sent Off'],
  ];
  const EVENTS = [
    ['td', 'TD', 'Touchdown', 3],
    ['cas', 'CAS', 'Casualty caused', 2],
    ['comp', 'COMP', 'Completion', 1],
    ['int', 'INT', 'Interception', 2],
    ['deflect', 'DEF', 'Deflection', 1],
  ];
  const WEATHER = ['Perfect Conditions', 'Sweltering Heat', 'Very Sunny', 'Pouring Rain', 'Blizzard'];
  const MAX_TURN = 8;
  const MAX_EVENT = 20;

  // Casualty and Sent Off take a player off the pitch for good; a KO goes to
  // the reserves box and can come back, so it does not count as destroyed.
  function autoDestroyed(u) {
    return !!u && (u.state === 'casualty' || u.state === 'sentOff');
  }

  // ---- match bar -----------------------------------------------------------

  function stepper(field, sideIdx, cls, valueHtml, opts) {
    const o = opts || {};
    const side = sideIdx == null ? '' : ' data-mside="' + sideIdx + '"';
    const dis = o.disabled ? ' disabled' : '';
    return '<span class="bb-step ' + cls + '">' +
      (o.label ? '<span class="bb-step-lbl">' + esc(o.label) + '</span>' : '') +
      '<button class="bb-sbtn" data-mfield="' + field + '"' + side + ' data-d="-1"' + dis +
      ' aria-label="' + esc((o.label || field) + ' down') + '">−</button>' +
      valueHtml +
      '<button class="bb-sbtn" data-mfield="' + field + '"' + side + ' data-d="1"' + dis +
      ' aria-label="' + esc((o.label || field) + ' up') + '">+</button>' +
      '</span>';
  }

  function turnPips(i, turn, disabled) {
    let out = '';
    for (let k = 1; k <= MAX_TURN; k++) {
      out += '<button class="bb-tpip' + (k <= turn ? ' on' : '') + (k === turn ? ' now' : '') + '"' +
        ' data-mfield="turn" data-mside="' + i + '" data-mval="' + k + '"' +
        (disabled ? ' disabled' : '') +
        ' aria-label="turn ' + k + ' of ' + MAX_TURN + '"></button>';
    }
    return '<div class="bb-tpips">' + out + '</div>';
  }

  function weatherSelect(match, disabled) {
    const cur = match.weather || WEATHER[0];
    const known = WEATHER.indexOf(cur) !== -1;
    const opts = WEATHER.map(function (w) {
      return '<option value="' + esc(w) + '"' + (w === cur ? ' selected' : '') + '>' + esc(w) + '</option>';
    }).join('') + (known ? '' : '<option value="' + esc(cur) + '" selected>' + esc(cur) + '</option>');
    return '<label class="bb-weather"><span class="bb-step-lbl">Weather</span>' +
      '<select class="bb-wsel" data-mfield="weather"' + (disabled ? ' disabled' : '') + '>' + opts + '</select></label>';
  }

  function halfLabel(half) {
    if (half >= 3) return 'OT';
    return half === 2 ? '2nd' : '1st';
  }

  function teamBlock(match, side, i, disabled) {
    const turn = match.turn[i] || 1;
    const score = match.score[i] || 0;
    const rr = match.rerolls[i] || 0;
    const base = (match.rerollBase || [])[i] || 0;
    const used = (match.rerollUsed || [])[i];
    const fame = (match.fame || [])[i] || 0;
    const ind = (match.inducements || [])[i] || '';
    return '<div class="bb-team">' +
      '<div class="bb-team-head"><span class="bb-team-name">' + esc(side && side.name ? side.name : 'Side ' + (i + 1)) + '</span>' +
      (side && side.owner ? '<span class="bb-team-coach">' + esc(side.owner) + '</span>' : '') + '</div>' +

      '<div class="bb-turnbox">' +
      stepper('turn', i, 'bb-turn', '<b class="bb-turnnum" id="bb-turn-' + i + '">' + turn + '</b>' +
        '<span class="bb-turnmax">/' + MAX_TURN + '</span>', { label: 'Turn', disabled: disabled }) +
      turnPips(i, turn, disabled) +
      '</div>' +

      '<div class="bb-row">' +
      stepper('score', i, 'bb-score', '<b class="bb-scorenum" id="bb-score-' + i + '">' + score + '</b>',
        { label: 'Score', disabled: disabled }) +
      stepper('rerolls', i, 'bb-rr', '<b class="bb-rrnum" id="bb-rr-' + i + '">' + rr + '</b>' +
        (base ? '<span class="bb-rrmax">/' + base + '</span>' : ''), { label: 'Rerolls', disabled: disabled }) +
      '</div>' +

      '<div class="bb-row bb-row-min">' +
      '<button class="bb-used' + (used ? ' on' : '') + '" data-mtoggle="rerollUsed" data-mside="' + i + '"' +
      (disabled ? ' disabled' : '') + '>' + (used ? '✓ RR used dis turn' : 'RR available') + '</button>' +
      stepper('fame', i, 'bb-fame', '<b class="bb-famenum" id="bb-fame-' + i + '">' + fame + '</b>',
        { label: 'FAME', disabled: disabled }) +
      '</div>' +

      '<label class="bb-ind"><span class="bb-step-lbl">Inducements</span>' +
      '<input class="bb-indinput" data-mfield="inducements" data-mside="' + i + '" maxlength="120"' +
      (disabled ? ' disabled' : '') + ' placeholder="bribes, star players…" value="' + esc(ind) + '"></label>' +
      '</div>';
  }

  // match: the table's match state (see server/tracker-bloodbowl.js newMatch).
  // sides: the table's sides, for names/owners. Returns '' when there is no
  // match state yet, so the caller can render it unconditionally.
  function matchBarHtml(match, sides, status) {
    if (!match || !Array.isArray(match.turn)) return '';
    const list = Array.isArray(sides) ? sides : [];
    const disabled = status === 'done';
    const half = match.half || 1;
    return '<div class="bb-matchbar' + (disabled ? ' bb-done' : '') + '">' +
      '<div class="bb-global">' +
      stepper('half', null, 'bb-half', '<b class="bb-halfnum" id="bb-half">' + esc(halfLabel(half)) + '</b>',
        { label: 'Half', disabled: disabled }) +
      '<span class="bb-scoreline">' +
      match.turn.map(function (_, i) {
        return '<span class="bb-sl-team">' + esc(list[i] && list[i].name ? list[i].name : 'Side ' + (i + 1)) + '</span>' +
          '<b class="bb-sl-num">' + (match.score[i] || 0) + '</b>';
      }).join('<span class="bb-sl-dash">—</span>') +
      '</span>' +
      weatherSelect(match, disabled) +
      '</div>' +
      '<div class="bb-teams">' +
      match.turn.map(function (_, i) { return teamBlock(match, list[i], i, disabled); }).join('') +
      '</div></div>';
  }

  // ---- player card ---------------------------------------------------------

  // AG, PA and AV are target numbers in BB2020/2025 — they print with a '+'.
  function statCells(u) {
    const s = u.statline || {};
    const cells = [
      ['MA', s.ma, false],
      ['ST', s.st, false],
      ['AG', s.ag, true],
      ['PA', s.pa, true],
      ['AV', s.av, true],
    ];
    return '<div class="bb-stats">' + cells.map(function (c) {
      const val = c[1] == null ? '–' : (c[1] + (c[2] ? '+' : ''));
      return '<span class="bb-stat"><span class="bb-stat-k">' + c[0] + '</span>' +
        '<b class="bb-stat-v">' + esc(val) + '</b></span>';
    }).join('') + '</div>';
  }

  function stateChips(u, disabled) {
    return '<div class="bb-states">' + STATES.map(function (st) {
      return '<button class="bb-chip bb-chip-' + st[0] + (u.state === st[0] ? ' on' : '') + '"' +
        ' data-uid="' + u.uid + '" data-field="state" data-val="' + st[0] + '"' +
        (disabled ? ' disabled' : '') +
        ' aria-pressed="' + (u.state === st[0]) + '">' + esc(st[1]) + '</button>';
    }).join('') + '</div>';
  }

  function eventSteppers(u, disabled) {
    const ev = u.events || {};
    return '<div class="bb-events">' + EVENTS.map(function (e) {
      const n = ev[e[0]] || 0;
      return '<div class="bb-ev' + (n ? ' has' : '') + '" title="' + esc(e[2]) + ' — ' + e[3] + ' SPP">' +
        '<span class="bb-ev-k">' + e[1] + '</span>' +
        '<div class="bb-ev-ctl">' +
        '<button class="bb-evbtn" data-uid="' + u.uid + '" data-field="event.' + e[0] + '" data-d="-1"' +
        (disabled || n <= 0 ? ' disabled' : '') + ' aria-label="' + esc(e[2]) + ' down">−</button>' +
        '<b class="bb-ev-n">' + n + '</b>' +
        '<button class="bb-evbtn bb-evbtn-up" data-uid="' + u.uid + '" data-field="event.' + e[0] + '" data-d="1"' +
        (disabled || n >= MAX_EVENT ? ' disabled' : '') + ' aria-label="' + esc(e[2]) + ' up">+</button>' +
        '</div></div>';
    }).join('') + '</div>';
  }

  function sppThisMatch(u) {
    const ev = u.events || {};
    return EVENTS.reduce(function (n, e) { return n + (ev[e[0]] || 0) * e[3]; }, 0) + (u.mvp ? 4 : 0);
  }

  // status: 'setup' | 'playing' | 'done' (a finished table is read-only).
  function html(u, status, canUndo) {
    const disabled = status === 'done';
    const off = autoDestroyed(u);
    const spp = sppThisMatch(u);
    return '' +
      '<div class="unit-card bb-card' + (off ? ' destroyed' : '') +
      (u.state === 'ko' ? ' bb-ko' : '') + (u.mvp ? ' bb-is-mvp' : '') + '" data-card="' + u.uid + '">' +
      (off ? '<span class="wreck-badge">' + (u.state === 'sentOff' ? 'Sent Off' : 'Casualty') + '</span>' : '') +
      '<div class="bb-top">' +
      '<span class="bb-num">' + (u.number == null ? '–' : esc(u.number)) + '</span>' +
      '<span class="bb-id"><span class="bb-name">' + esc(u.name) + '</span>' +
      (u.position ? '<span class="bb-pos">' + esc(u.position) + '</span>' : '') + '</span>' +
      '<span class="bb-spp' + (spp ? ' has' : '') + '">' + spp + ' SPP</span>' +
      '</div>' +
      statCells(u) +
      (u.skills && u.skills.length
        ? '<div class="bb-skills">' + esc(u.skills.join(', ')) + '</div>'
        : '<div class="bb-skills bb-none">no skills</div>') +
      stateChips(u, disabled) +
      eventSteppers(u, disabled) +
      '<div class="bb-mvprow">' +
      '<button class="bb-mvp' + (u.mvp ? ' on' : '') + '" data-uid="' + u.uid + '" data-toggle="mvp"' +
      (disabled ? ' disabled' : '') + ' aria-pressed="' + Boolean(u.mvp) + '">' +
      (u.mvp ? '★ MVP' : '☆ MVP') + '</button>' +
      '<span class="bb-mvphint">one per team, picked at da end</span>' +
      '</div>' +
      '<div class="u-foot">' +
      '<input class="notes" data-uid="' + u.uid + '" maxlength="200" placeholder="notes…" value="' + esc(u.notes || '') + '">' +
      '<button class="ubtn" data-undo="' + u.uid + '"' + (canUndo ? '' : ' disabled') + '>↩ Undo</button>' +
      '<button class="ubtn danger" data-wreck="' + u.uid + '">' + (off ? 'Revive' : 'Cas') + '</button>' +
      '</div></div>';
  }

  window.BloodBowlCard = {
    html: html,
    autoDestroyed: autoDestroyed,
    matchBarHtml: matchBarHtml,
    STATES: STATES,
    EVENTS: EVENTS,
    WEATHER: WEATHER,
    MAX_TURN: MAX_TURN,
    MAX_EVENT: MAX_EVENT,
  };
})();
