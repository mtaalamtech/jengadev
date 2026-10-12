const API_BASE = window.location.origin + '/api';

(function initDaemonToken() {
  const TOKEN_KEY = 'jengadev_token';
  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get('token');
  if (urlToken) {
    try { sessionStorage.setItem(TOKEN_KEY, urlToken); } catch (e) {}
    params.delete('token');
    const clean = window.location.pathname + (params.toString() ? '?' + params.toString() : '') + window.location.hash;
    window.history.replaceState({}, '', clean);
  }
  const nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    init = init || {};
    const headers = new Headers(init.headers || {});
    let token = '';
    try { token = sessionStorage.getItem(TOKEN_KEY) || ''; } catch (e) {}
    if (token) headers.set('X-JengaDev-Token', token);
    init.headers = headers;
    return nativeFetch(input, init);
  };
})();

const SERVICE_LABELS = { caddy: 'Caddy', php81: 'PHP 8.1', php82: 'PHP 8.2', php83: 'PHP 8.3', mariadb: 'MariaDB', postgres: 'PostgreSQL', mailpit: 'Mailpit', adminer: 'Adminer' };

let _toastHideTimer = null;
function showToast(msg, isError, persist) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isError ? ' error' : '');
  if (_toastHideTimer) clearTimeout(_toastHideTimer);
  if (!persist) {
    _toastHideTimer = setTimeout(() => { t.className = 'toast'; }, 3500);
  }
}

async function fetchStatus() {
  try {
    const res = await fetch(`${API_BASE}/status`);
    const data = await res.json();
    const container = document.getElementById('services');
    container.innerHTML = '';
    for (const [name, label] of Object.entries(SERVICE_LABELS)) {
      const state = data[name] || 'stopped';
      const row = document.createElement('div');
      row.className = 'svc-row';
      row.innerHTML = `
        <div><span class="dot ${state}"></span><span class="svc-name">${label}</span></div>
        <div>
          <button class="secondary" onclick="startService('${name}')">Start</button>
          <button class="secondary" onclick="stopService('${name}')">Stop</button>
        </div>`;
      container.appendChild(row);
    }
    if (data.active_php) document.getElementById('php-select').value = data.active_php;
  } catch (e) { console.error(e); }
}

async function startService(name) {
  // The first start of a PHP version builds its image from scratch,
  // compiling several C extensions - measured several minutes on a real
  // server. A toast that vanishes after 3.5s would leave the user staring
  // at a dashboard that looks like it's doing nothing for most of that
  // wait, so this one for PHP stays up (and the button disabled) until the
  // request actually finishes instead of auto-hiding.
  const isPhp = name.startsWith('php');
  const btn = event && event.target;
  if (isPhp) {
    showToast(`Starting ${SERVICE_LABELS[name]}... first start builds its image, which can take a few minutes.`, false, true);
    if (btn) btn.disabled = true;
  } else {
    showToast(`Starting ${SERVICE_LABELS[name] || name}...`, false);
  }
  try {
    const res = await fetch(`${API_BASE}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ service: name }) });
    const data = await res.json();
    showToast(data.message, !data.success);
    fetchStatus();
  } catch (e) {
    showToast('Error starting service', true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function stopService(name) {
  try {
    const res = await fetch(`${API_BASE}/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ service: name }) });
    const data = await res.json();
    showToast(data.message, !data.success);
    fetchStatus();
  } catch (e) { showToast('Error stopping service', true); }
}

async function switchPhp() {
  const version = document.getElementById('php-select').value;
  showToast(`Switching to ${SERVICE_LABELS[version]}...`, false);
  try {
    const res = await fetch(`${API_BASE}/php/switch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version }) });
    const data = await res.json();
    showToast(data.message, !data.success);
    fetchStatus();
  } catch (e) { showToast('Error switching PHP version', true); }
}

async function fetchHosts() {
  try {
    const res = await fetch(`${API_BASE}/hosts/list`);
    const data = await res.json();
    const container = document.getElementById('hosts');
    container.innerHTML = '';
    if (!data.hosts || data.hosts.length === 0) {
      container.innerHTML = '<div style="color:var(--muted);padding:10px 0;">No hosts yet.</div>';
      return;
    }
    for (const host of data.hosts) {
      const row = document.createElement('div');
      row.className = 'hosts-row';
      row.innerHTML = `
        <div class="host-domain"><a href="http://${host.domain}" target="_blank">${host.domain}</a></div>
        <button class="danger" onclick="deleteHost('${host.name}')">Delete</button>`;
      container.appendChild(row);
    }
  } catch (e) { console.error(e); }
}

async function createHost() {
  const input = document.getElementById('new-host-name');
  const name = input.value.trim();
  if (!name) return;
  try {
    const res = await fetch(`${API_BASE}/hosts/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    const data = await res.json();
    showToast(data.message, !data.success);
    if (data.success) { input.value = ''; fetchHosts(); }
  } catch (e) { showToast('Error creating host', true); }
}

async function deleteHost(name) {
  if (!confirm(`Delete '${name}' and all its files? This cannot be undone.`)) return;
  try {
    const res = await fetch(`${API_BASE}/hosts/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, confirm: name }) });
    const data = await res.json();
    showToast(data.message, !data.success);
    if (data.success) fetchHosts();
  } catch (e) { showToast('Error deleting host', true); }
}

fetchStatus();
fetchHosts();
setInterval(fetchStatus, 3000);
