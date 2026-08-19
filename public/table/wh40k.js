// Game Night — Warhammer 40k unit card.
//
// Renders one snapshotted datasheet (see server/table.js snapshotWh40kUnit):
// model statline, compact weapons tables, sanitized ability text, keywords,
// and wound pips grouped per model (a 5-model 2W unit is 5 groups of 2 — a
// model dies when its group fills; the unit is destroyed when all models are).
//
// Exposed as window.W40kCard; table.js owns all event handling.
(function () {
  'use strict';

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  // Ability descriptions carry Wahapedia HTML verbatim. Render them inside a
  // sanitizing container: strip <script>/<style> (and other active elements),
  // every on* attribute, and javascript: URLs — keep the rest of the markup.
  function sanitize(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = String(html == null ? '' : html);
    tpl.content.querySelectorAll('script,style,iframe,object,embed,link,meta,form,base').forEach(function (el) { el.remove(); });
    tpl.content.querySelectorAll('*').forEach(function (el) {
      Array.prototype.slice.call(el.attributes).forEach(function (attr) {
        if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
        else if ((attr.name === 'href' || attr.name === 'src' || attr.name === 'xlink:href')
          && /^\s*(javascript|data|vbscript):/i.test(attr.value)) el.removeAttribute(attr.name);
      });
    });
    return tpl.innerHTML;
  }

  function statTable(u) {
    const rows = u.statline.map(function (m) {
      return '<tr>' + (u.statline.length > 1 ? '<td>' + esc(m.name) + '</td>' : '') +
        '<td class="num">' + esc(m.m) + '</td><td class="num">' + esc(m.t) + '</td>' +
        '<td class="num">' + esc(m.sv) + '</td><td class="num">' + (m.inv ? esc(m.inv) + '++' : '—') + '</td>' +
        '<td class="num">' + esc(m.w) + '</td><td class="num">' + esc(m.ld) + '</td>' +
        '<td class="num">' + esc(m.oc) + '</td></tr>';
    }).join('');
    return '<div class="wpn-wrap"><table class="wpn-table stat-table"><thead><tr>' +
      (u.statline.length > 1 ? '<th></th>' : '') +
      '<th class="num">M</th><th class="num">T</th><th class="num">Sv</th><th class="num">Inv</th>' +
      '<th class="num">W</th><th class="num">Ld</th><th class="num">OC</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function weaponTable(list, kind) {
    if (!list.length) return '';
    const rows = list.map(function (w) {
      return '<tr><td>' + esc(w.name) +
        (w.kw ? '<div class="wpn-kw">' + esc(w.kw) + '</div>' : '') + '</td>' +
        '<td class="num">' + esc(w.range) + '</td><td class="num">' + esc(w.a) + '</td>' +
        '<td class="num">' + esc(w.bs) + (/^\d+$/.test(String(w.bs)) ? '+' : '') + '</td><td class="num">' + esc(w.s) + '</td>' +
        '<td class="num">' + esc(w.ap) + '</td><td class="num">' + esc(w.d) + '</td></tr>';
    }).join('');
    return '<div class="sec-title">' + kind + '</div>' +
      '<div class="wpn-wrap"><table class="wpn-table"><thead><tr>' +
      '<th>Weapon</th><th class="num">Rng</th><th class="num">A</th><th class="num">' +
      (kind === 'Melee' ? 'WS' : 'BS') + '</th><th class="num">S</th><th class="num">AP</th><th class="num">D</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  // Wound pips grouped per model. Tap semantics per group: pip k sets that
  // model's wounds-taken to k, tapping the topmost filled pip clears it.
  function woundGroups(u) {
    let out = '';
    for (let i = 0; i < u.modelCount; i++) {
      const taken = u.wounds[i] || 0;
      const dead = taken >= u.woundsPer;
      let grp = '';
      for (let k = 1; k <= u.woundsPer; k++) {
        grp += '<button class="pip tiny wound' + (k <= taken ? ' hit' : '') + '"' +
          ' data-uid="' + u.uid + '" data-field="wounds.' + i + '" data-n="' + k + '"' +
          ' aria-label="model ' + (i + 1) + ' wound ' + k + ' of ' + u.woundsPer + '"></button>';
      }
      out += '<span class="wound-group' + (dead ? ' dead' : '') + '" title="model ' + (i + 1) + '">' + grp + '</span>';
    }
    return out;
  }

  function abilityBlocks(u) {
    if (!u.abilities.length) return '';
    const blocks = u.abilities.map(function (a) {
      return '<details class="ability"><summary>' + esc(a.name) + '</summary>' +
        '<div class="ability-body">' + sanitize(a.description) + '</div></details>';
    }).join('');
    return '<div class="sheet-sec"><div class="sec-title">Abilities</div>' + blocks + '</div>';
  }

  function html(u, canUndo) {
    const dead = u.wounds.filter(function (w) { return w >= u.woundsPer; }).length;
    return '' +
      '<div class="unit-card w40k-card' + (u.destroyed ? ' destroyed' : '') + '" data-card="' + u.uid + '">' +
      (u.destroyed ? '<span class="wreck-badge">Destroyed</span>' : '') +
      '<div class="u-top"><span class="u-name">' + esc(u.name) + '</span>' +
      '<span class="u-pv">' + (u.modelCount - dead) + '/' + u.modelCount + ' models</span></div>' +
      (u.faction ? '<div class="u-line">' + esc(u.faction) + '</div>' : '') +
      statTable(u) +
      '<div class="sheet-sec"><div class="sec-title">Wounds <span class="muted">' + u.woundsPer + 'W per model</span></div>' +
      '<div class="wound-row">' + woundGroups(u) + '</div></div>' +
      '<div class="sheet-sec">' +
      weaponTable(u.weapons.ranged, 'Ranged') +
      weaponTable(u.weapons.melee, 'Melee') +
      '</div>' +
      abilityBlocks(u) +
      '<div class="kw-line"><b>Keywords:</b> ' + esc(u.keywords.unit.join(', ')) +
      (u.keywords.faction.length ? ' <b>· Faction:</b> ' + esc(u.keywords.faction.join(', ')) : '') + '</div>' +
      '<div class="u-foot">' +
      '<input class="notes" data-uid="' + u.uid + '" maxlength="200" placeholder="notes…" value="' + esc(u.notes) + '">' +
      '<button class="ubtn" data-undo="' + u.uid + '"' + (canUndo ? '' : ' disabled') + '>↩ Undo</button>' +
      '<button class="ubtn danger" data-wreck="' + u.uid + '">' + (u.destroyed ? 'Revive' : 'Wreck') + '</button>' +
      '</div></div>';
  }

  window.W40kCard = { html: html, sanitize: sanitize };
})();
