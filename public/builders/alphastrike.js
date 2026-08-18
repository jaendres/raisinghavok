// Alpha Strike point-value adjustment for pilot skill.
//
// Transcribed verbatim from the Master Unit List's own force builder
// (/Force/Build) before that site shut down. Deliberately not "tidied up" or
// re-derived: this is game rules, and matching what the club already played
// against matters more than a neater formulation.
//
// Written as a UMD wrapper so the browser and the Node server share one copy.
// A game rule implemented twice is a game rule that will eventually disagree
// with itself.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AlphaStrike = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Skill 4 is the baseline. Better pilots (lower skill) cost more, worse
  // pilots cost less, and the adjustment scales with the unit's base PV.
  function pvForSkill(basePV, skill) {
    if (!Number.isFinite(basePV) || !Number.isFinite(skill)) return basePV;

    var multiplier;
    if (skill < 4) {
      multiplier = basePV < 8
        ? (4 - skill)
        : (4 - skill) * Math.ceil((Math.max(basePV - 7, 1) / 5) + 1);
    } else {
      multiplier = basePV < 15
        ? -(skill - 4)
        : -((skill - 4) * Math.ceil(((basePV - 14) / 10.0) + 1));
    }

    return Math.max(basePV + multiplier, 1);
  }

  // Target Movement Modifier, derived from a unit's movement.
  //
  // The Master Unit List's JSON reports TMM as 0 for every single unit -- the
  // field is simply never populated -- while the card it renders shows the real
  // value. TMM is consulted on every attack roll, so it is derived here from
  // the movement rate instead of trusting that field.
  //
  // Verified against the cards MUL itself rendered:
  //   Atlas AS7-D-DC   MV  6"  -> TMM 1
  //   Panther PNT-9ALAG MV 10" -> TMM 2
  //   Mongoose MON-68  MV 14"  -> TMM 3
  //   Snow Fox 2       MV 20"  -> TMM 4
  var TMM_BANDS = [
    [4, 0], [8, 1], [12, 2], [18, 3], [34, 4],
  ];

  function tmmForMove(move) {
    if (move === null || move === undefined) return null;
    // Movement looks like '6"', '4"j', '6"t', or '8"/6"j' for multi-mode units.
    // Alpha Strike takes the primary (first) movement rate.
    var m = String(move).match(/(\d+)/);
    if (!m) return null;
    var inches = Number(m[1]);
    for (var i = 0; i < TMM_BANDS.length; i++) {
      if (inches <= TMM_BANDS[i][0]) return TMM_BANDS[i][1];
    }
    return 5;
  }

  return {
    pvForSkill: pvForSkill,
    tmmForMove: tmmForMove,
    SKILLS: [0, 1, 2, 3, 4, 5, 6, 7, 8],
  };
}));
