// Admin jobs that keep our copies of other people's data current.
//
// Wahapedia republishes its 11th-edition export within minutes of an errata,
// so our 40k tables would drift the moment we shipped them. Refreshing must
// not mean a redeploy: an admin presses a button, this runs the same import
// script the repo already ships, and the new data is live.
//
// The import rewrites every wh40k_* table inside one transaction, so it runs
// as a child process rather than on the request — a refresh outliving the
// HTTP call is the point, and a crash in it can't take the site down.
const path = require('path');
const { spawn } = require('child_process');

const TAIL_LINES = 40;

// Only ever one at a time; the state is deliberately in-memory, since a
// restart mid-import means the transaction rolled back anyway.
let current = null; // { job, startedAt, by, done, ok, tail: [] }

const JOBS = {
  wh40k: {
    name: 'Warhammer 40k data',
    script: 'scripts/wh40k-import.mjs',
    needs: 'MUL_DATABASE_URL',
    source: 'wahapedia.ru',
  },
};

function mount(app, deps = {}) {
  const { authed, isAdmin } = deps;

  const adminOnly = (req, res, next) => {
    const user = authed(req);
    if (!user || !isAdmin(user.name)) {
      return res.status(403).json({ error: 'Admins only.' });
    }
    req.adminUser = user;
    return next();
  };

  // What can be refreshed, and when each was last brought up to date.
  app.get('/api/admin/jobs', adminOnly, (req, res) => {
    res.json({
      jobs: Object.entries(JOBS).map(([id, j]) => ({
        id, name: j.name, source: j.source, ready: Boolean(process.env[j.needs]),
      })),
      running: current && !current.done ? current.job : null,
      last: current,
    });
  });

  app.get('/api/admin/jobs/:id', adminOnly, (req, res) => {
    if (!JOBS[req.params.id]) return res.status(404).json({ error: 'No such job.' });
    res.json({ job: current && current.job === req.params.id ? current : null });
  });

  app.post('/api/admin/jobs/:id', adminOnly, (req, res) => {
    const job = JOBS[req.params.id];
    if (!job) return res.status(404).json({ error: 'No such job.' });
    if (current && !current.done) {
      return res.status(409).json({ error: `"${JOBS[current.job].name}" is already runnin'.`, started: current.startedAt });
    }
    if (!process.env[job.needs]) {
      return res.status(503).json({ error: `No ${job.needs} configured — nuffin' to refresh.` });
    }

    const root = path.join(__dirname, '..');
    const child = spawn(process.execPath, [path.join(root, job.script)], { env: process.env, cwd: root });

    const state = {
      job: req.params.id,
      startedAt: new Date().toISOString(),
      by: req.adminUser.name,
      done: false,
      ok: null,
      tail: [],
    };
    current = state;

    const keep = (buf) => {
      for (const line of String(buf).split(/\r?\n/)) {
        if (line.trim()) state.tail.push(line.trim());
      }
      if (state.tail.length > TAIL_LINES) state.tail = state.tail.slice(-TAIL_LINES);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (err) => {
      state.done = true;
      state.ok = false;
      state.tail.push(`could not start: ${err.message}`);
    });
    child.on('close', (code) => {
      state.done = true;
      state.ok = code === 0;
      console.log(`[admin] ${job.name} refresh by ${state.by} finished with code ${code}`);
    });

    res.json({ ok: true, job: req.params.id, started: state.startedAt });
  });
}

module.exports = { mount, JOBS };
