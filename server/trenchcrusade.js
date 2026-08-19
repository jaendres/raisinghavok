// Trench Crusade warband builder — server side.
// The catalog (warbands/units/armoury/battlekit) is compiled from the freely
// published official rules and checked into server/data/ — see the catalog's
// own meta block for sources, verification notes and admitted gaps, and
// scripts/trenchcrusade-validate.mjs for the shape checks.
// Warbands are built and saved client-side (localStorage); the server only
// serves the catalog, gated the same way as the other builders.
const fs = require('fs');
const path = require('path');

const CATALOG = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'data', 'trenchcrusade-catalog.json'), 'utf-8'));

// mount(app, { memberReader }) — registers the catalog route. memberReader is
// index.js's members-only gate (logged-in account or bot key).
function mount(app, { memberReader }) {
  app.get('/api/builders/trenchcrusade/catalog', memberReader, (req, res) => res.json(CATALOG));
}

module.exports = { CATALOG, mount };
