// Mad Ork Lands — app shell: auth, screen switching, socket, lobby.
const MOL = {
  token: localStorage.getItem('mol_token') || null,
  name: null,
  guest: false,
  parts: null,     // catalog from /api/parts
  garage: [],      // saved builds
  socket: null,
  myRigId: null,
};

const $ = (sel) => document.querySelector(sel);

function show(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $('#' + screenId).classList.add('active');
}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (MOL.token) headers.Authorization = 'Bearer ' + MOL.token;
  const res = await fetch('/api' + path, { headers, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'server said no');
  return data;
}

// ---- auth ----
async function doAuth(kind) {
  const name = $('#auth-name').value.trim();
  const password = $('#auth-pass').value;
  $('#auth-error').textContent = '';
  try {
    const data = await api('/' + kind, { method: 'POST', body: JSON.stringify({ name, password }) });
    MOL.token = data.token; MOL.name = data.name; MOL.guest = false;
    MOL.garage = data.garage || [];
    localStorage.setItem('mol_token', data.token);
    enterGarage(data.stats);
  } catch (e) {
    $('#auth-error').textContent = e.message;
  }
}

$('#btn-login').onclick = () => doAuth('login');
$('#btn-register').onclick = () => doAuth('register');
$('#auth-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doAuth('login'); });
$('#btn-guest').onclick = () => {
  MOL.token = null; MOL.guest = true;
  MOL.name = ($('#auth-name').value.trim() || 'Anonymous Git');
  MOL.garage = JSON.parse(localStorage.getItem('mol_guest_garage') || '[]');
  enterGarage(null);
};
$('#btn-logout').onclick = () => {
  localStorage.removeItem('mol_token');
  MOL.token = null; MOL.guest = false;
  if (MOL.socket) MOL.socket.emit('leaveQueue');
  show('screen-auth');
};

async function enterGarage(stats) {
  show('screen-garage');
  $('#whoami').textContent = MOL.name + (MOL.guest ? ' (guest — stats not saved)' : '');
  if (!MOL.parts) {
    MOL.parts = await api('/parts');
    Garage.init(MOL.parts);
  }
  Garage.renderSaved();
  renderStats(stats);
  refreshLeaderboard();
  connectSocket();
}

function renderStats(stats) {
  if (MOL.guest || !stats) { $('#my-stats').textContent = 'Guests got no legend. Sign up to be remembered.'; return; }
  $('#my-stats').textContent =
    `${stats.games} fights • ${stats.wins} wins • ${stats.kills} kills • ${Math.round(stats.damage)} damage dealt`;
}

async function refreshLeaderboard() {
  try {
    const rows = await api('/leaderboard');
    $('#leaderboard').innerHTML = rows.length
      ? rows.slice(0, 8).map((r, i) =>
          `<div class="lb-row"><span>${i + 1}. <b>${esc(r.name)}</b></span><span>${r.wins}W / ${r.kills}K</span></div>`).join('')
      : '<div class="lb-row">No warbosses yet. Be da first.</div>';
  } catch { /* leaderboard is decorative */ }
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// ---- socket / lobby ----
function connectSocket() {
  if (MOL.socket) { hello(); return; }
  MOL.socket = io();
  MOL.socket.on('connect', hello);
  MOL.socket.on('queue', (q) => {
    if (!q.players.length) { $('#queue-status').textContent = ''; return; }
    $('#queue-status').textContent = q.countdown !== null
      ? `WAAAGH! in ${q.countdown}... (${q.players.length} in)`
      : `${q.players.length} waitin'...`;
  });
  MOL.socket.on('youAre', ({ id }) => { MOL.myRigId = id; });
  MOL.socket.on('matchStart', (d) => Game.start(d));
  MOL.socket.on('state', (s) => Game.onState(s));
  MOL.socket.on('matchOver', ({ results }) => Game.onOver(results));
}

function hello() {
  MOL.socket.emit('hello', { token: MOL.token, guestName: MOL.guest ? MOL.name : null }, (res) => {
    if (res && res.name) MOL.name = res.name;
  });
}

$('#btn-play').onclick = () => {
  const build = Garage.currentBuild();
  $('#build-error').textContent = '';
  MOL.socket.emit('joinQueue', { build }, (res) => {
    if (res && res.error) { $('#build-error').textContent = res.error; return; }
    $('#queue-status').textContent = "You'z in. Waitin' for da fight...";
  });
};

$('#btn-back-garage').onclick = async () => {
  $('#results').classList.add('hidden');
  show('screen-garage');
  refreshLeaderboard();
  if (!MOL.guest && MOL.token) {
    try { const me = await api('/me'); renderStats(me.stats); } catch { }
  }
};

// resume session if token still valid
(async () => {
  if (!MOL.token) return;
  try {
    const me = await api('/me');
    MOL.name = me.name; MOL.garage = me.garage || [];
    enterGarage(me.stats);
  } catch {
    localStorage.removeItem('mol_token');
    MOL.token = null;
  }
})();
