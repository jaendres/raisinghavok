// Marvel Crisis Protocol roster builder — reference data endpoint.
//
// Same catalog-in-repo pattern as Blood Bowl (server/bb.js): the catalog is
// generated offline by scripts/mcp-build-catalog.mjs from the BSData
// marvel-crisis-protocol repository and committed as JSON, so the site never
// parses BattleScribe XML at runtime and works with no external service.
//
// Rosters live in the browser (localStorage) — this module only serves the
// card data. NOTE: the source data was last updated Dec 2024, so threat
// values may lag AMG's current cards; catalog.meta.warning carries the
// caveat and the builder UI shows it in its footer.

const fs = require('fs');
const path = require('path');

const CATALOG = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'data', 'mcp-catalog.json'), 'utf-8'));

// mount(app, { memberReader }) — wired up from server/index.js so this module
// stays free of any auth details beyond "members can read".
function mount(app, { memberReader }) {
  app.get('/api/builders/mcp/catalog', memberReader, (req, res) => res.json(CATALOG));
}

module.exports = { CATALOG, mount };
