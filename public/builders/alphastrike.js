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

  return { pvForSkill: pvForSkill, SKILLS: [0, 1, 2, 3, 4, 5, 6, 7, 8] };
}));
