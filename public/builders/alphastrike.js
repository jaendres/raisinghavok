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

  // ---- Total Warfare -------------------------------------------------------
  //
  // Battle Value adjusted for crew skill, indexed [gunnery][piloting].
  // Transcribed verbatim from the Master Unit List's Total Warfare force
  // builder (/Force/TWBuild) before that site shut down.
  //
  // Two independent checks that this table is the right one:
  //   mods[4][5] = 1.00 -- gunnery 4 / piloting 5 is the "regular" crew that a
  //     unit's headline Battle Value is quoted at, so the multiplier is 1.
  //   mods[4][4] = 1.10 -- Atlas AS7-D-DC base BV 1858 x 1.10 = 2044, which is
  //     exactly the value in the 9x9 grid MUL renders on that unit's own page.
  var BV_MODS = [
    [2.42, 2.31, 2.21, 2.10, 1.93, 1.75, 1.68, 1.59, 1.50],
    [2.21, 2.11, 2.02, 1.92, 1.76, 1.60, 1.54, 1.46, 1.38],
    [1.93, 1.85, 1.76, 1.68, 1.54, 1.40, 1.35, 1.28, 1.21],
    [1.66, 1.58, 1.51, 1.44, 1.32, 1.20, 1.16, 1.10, 1.04],
    [1.38, 1.32, 1.26, 1.20, 1.10, 1.00, 0.95, 0.90, 0.85],
    [1.31, 1.19, 1.13, 1.08, 0.99, 0.90, 0.86, 0.81, 0.77],
    [1.24, 1.12, 1.07, 1.02, 0.94, 0.85, 0.81, 0.77, 0.72],
    [1.17, 1.06, 1.01, 0.96, 0.88, 0.80, 0.76, 0.72, 0.68],
    [1.10, 0.99, 0.95, 0.90, 0.83, 0.75, 0.71, 0.68, 0.64]
  ];

  // Rounding note: verified against 486 cells of MUL's own rendered grids, of
  // which 482 match exactly. The four that differ are all exact halves -- e.g.
  // Baboon (Howler) base 645 x 2.10 = 1354.5 -- where MUL's server rounds
  // half-to-even (1354) while its force builder's JavaScript rounds half-up
  // (1355). The site disagrees with itself; we follow its force builder, since
  // that is the tool being replaced. The difference is at most 1 BV.
  function bvForCrew(baseBV, gunnery, piloting) {
    if (!Number.isFinite(baseBV)) return baseBV;
    var g = Math.min(Math.max(Math.round(gunnery), 0), 8);
    var p = Math.min(Math.max(Math.round(piloting), 0), 8);
    return Math.round(baseBV * BV_MODS[g][p]);
  }

  return {
    pvForSkill: pvForSkill,
    tmmForMove: tmmForMove,
    bvForCrew: bvForCrew,
    BV_MODS: BV_MODS,
    SKILLS: [0, 1, 2, 3, 4, 5, 6, 7, 8],
  };
}));
