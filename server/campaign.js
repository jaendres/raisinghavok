// Campaign layers — club-written rules that sit on top of a published game.
//
// First one is Chaos Protocol, a one-night Marvel: Crisis Protocol campaign:
// one character per player, a Watcher who plays nobody, and a stack of random
// tables for advancements, loot, civilians and dice chaos. Unlike every other
// data source on the site, this one is ours — written for the club, not
// harvested from anyone — but it is still member-gated, because it is fan
// content built on somebody else's game and it belongs at our table.
//
// The rules live in data/chaos-protocol.json as structured blocks rather than
// a wall of HTML, so the page can render Roll buttons straight from the same
// rows the Watcher reads. That also means the MCP dice face spread used by
// the Panel One dealer is one array (panelOne.dieFaces) instead of a constant
// buried in client JS.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', 'chaos-protocol.json');

// Read once at boot, same as the catalogs. Restart to pick up an edit.
const CAMPAIGNS = { 'chaos-protocol': JSON.parse(fs.readFileSync(FILE, 'utf-8')) };

// mount(app, { memberReader }) — the gate comes from server/index.js so this
// module stays free of any auth details beyond "members can read".
function mount(app, { memberReader }) {
  app.get('/api/campaign/:id', memberReader, (req, res) => {
    const campaign = CAMPAIGNS[req.params.id];
    if (!campaign) return res.status(404).json({ error: 'No such campaign.' });
    res.json(campaign);
  });
}

module.exports = { CAMPAIGNS, mount };
