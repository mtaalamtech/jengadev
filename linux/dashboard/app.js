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

const SERVICE_LABELS = { caddy: 'Caddy', php82: 'PHP 8.2', php83: 'PHP 8.3', mariadb: 'MySQL (MariaDB)', postgres: 'PostgreSQL', mailpit: 'Mailpit', adminer: 'Adminer', phpmyadmin: 'phpMyAdmin' };
// Toolbar indicators + overview performance list, in display order. 'php'
// here always means "whichever php8x version is currently active" - Caddy
// only ever routes to one PHP version at a time, so that's the one users
// actually care about seeing at a glance, same as the Windows dashboard
// showing a single "PHP" row rather than one per installed version.
const OVERVIEW_SERVICES = ['caddy', 'php', 'mariadb', 'postgres', 'mailpit'];

let lastStatus = {};

function addLog(text, cls) {
  const out = document.getElementById('terminal-output');
  const time = new Date().toLocaleTimeString();
  const div = document.createElement('div');
  div.className = 'line' + (cls ? ' ' + cls : '');
  div.innerHTML = `<span class="time">[${time}]</span> ${text}`;
  out.appendChild(div);
  out.scrollTop = out.scrollHeight;
}

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

function showPane(name) {
  document.querySelectorAll('.pane').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById(`pane-${name}`).classList.add('active');
  document.querySelector(`.nav-item[data-pane="${name}"]`).classList.add('active');
  // Mailpit doesn't mind being framed, so it's embedded directly. Adminer
  // and phpMyAdmin both send X-Frame-Options: deny (confirmed against the
  // real containers, not an assumption) - embedding them just shows a
  // broken-page icon, so those two get a plain "open in new tab" link
  // instead, wired up in applyStatus() where the other links already are.
  if (name === 'mailpit') {
    const f = document.getElementById('mailpit-iframe');
    if (f.src === 'about:blank') f.src = `http://${window.location.hostname}:8025`;
    fetchMailpitConfig();
  }
  if (name === 'php') fetchPhpConfig();
  if (name === 'mysql') { fetchDbUsers('mysql'); fetchMysqlConfig(); }
  if (name === 'postgres') fetchDbUsers('postgres');
  if (name === 'ssl') fetchSslList();
}

// Resolves the pseudo-key used by the sidebar/pane PHP toggle to the real
// backend service name for whichever PHP version is currently active.
function activePhpService() {
  return (lastStatus.active_php) || 'php83';
}
function resolveServiceKey(key) {
  return key === 'php-active' ? activePhpService() : key;
}

function applyStatus(data) {
  lastStatus = data;

  // Toolbar indicators
  const toolbar = document.getElementById('global-status');
  toolbar.innerHTML = '';
  for (const key of OVERVIEW_SERVICES) {
    const backendKey = key === 'php' ? activePhpService() : key;
    const state = data[backendKey] || 'stopped';
    const label = key === 'php' ? 'PHP' : SERVICE_LABELS[backendKey].replace(' (MariaDB)', '');
    const div = document.createElement('div');
    div.className = 'indicator' + (state === 'running' ? ' running' : '');
    div.innerHTML = `<span class="dot"></span>${label}`;
    toolbar.appendChild(div);
  }

  // Overview performance list
  const perf = document.getElementById('perf-list');
  perf.innerHTML = '';
  for (const key of OVERVIEW_SERVICES) {
    const backendKey = key === 'php' ? activePhpService() : key;
    const state = data[backendKey] || 'stopped';
    const label = key === 'php' ? `PHP (${SERVICE_LABELS[backendKey]})` : SERVICE_LABELS[backendKey];
    const row = document.createElement('div');
    row.className = 'perf-row';
    row.innerHTML = `<span>${label}</span><span class="state ${state}">${state === 'running' ? 'Online' : 'Offline'}</span>`;
    perf.appendChild(row);
  }

  // Sidebar toggles + per-pane badges/buttons
  for (const toggleKey of ['caddy', 'php-active', 'mariadb', 'postgres', 'mailpit', 'adminer', 'phpmyadmin']) {
    const backendKey = resolveServiceKey(toggleKey);
    const state = data[backendKey] || 'stopped';
    const running = state === 'running';
    const checkbox = document.querySelector(`input[data-toggle="${toggleKey}"]`);
    if (checkbox) checkbox.checked = running;
    const badge = document.getElementById(`badge-${toggleKey}`);
    if (badge) { badge.textContent = running ? 'Running' : 'Stopped'; badge.className = 'status-badge ' + (running ? 'running' : 'stopped'); }
    const btn = document.getElementById(`toggle-${toggleKey}`);
    if (btn) btn.textContent = running ? 'Stop' : 'Start';
  }

  if (data.active_php) document.getElementById('php-select').value = data.active_php;

  const host = window.location.hostname;
  document.getElementById('link-mailpit').href = `http://${host}:8025`;
  document.getElementById('link-adminer').href = `http://${host}:8081`;
  document.getElementById('link-phpmyadmin').href = `http://${host}:8082`;
  document.getElementById('open-adminer').href = `http://${host}:8081`;
  document.getElementById('open-phpmyadmin').href = `http://${host}:8082`;
  document.getElementById('conn-host-mysql').textContent = host;
  document.getElementById('conn-host-postgres').textContent = host;
}

async function fetchStatus() {
  try {
    const res = await fetch(`${API_BASE}/status`);
    const data = await res.json();
    applyStatus(data);
  } catch (e) { console.error(e); }
}

async function startService(name, opts) {
  opts = opts || {};
  // PHP images are prebuilt and pulled from ghcr.io rather than built
  // locally (that used to take 4+ minutes per version, compiling C
  // extensions from source on every fresh install - now it's a one-time
  // ~130MB download instead). A toast that vanishes after 3.5s would still
  // leave the user staring at a dashboard that looks idle for a slow first
  // pull, so this one for PHP stays up until the request actually finishes.
  const isPhp = /^php\d/.test(name); // php81/82/83 only - not phpmyadmin
  if (isPhp) {
    showToast(`Starting ${SERVICE_LABELS[name]}... first start downloads its image (~130MB), which may take a moment.`, false, true);
  } else if (!opts.silent) {
    showToast(`Starting ${SERVICE_LABELS[name] || name}...`, false);
  }
  try {
    const res = await fetch(`${API_BASE}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ service: name }) });
    const data = await res.json();
    if (!opts.silent) showToast(data.message, !data.success);
    addLog(data.message, data.success ? 'ok' : 'err');
    fetchStatus();
    return data;
  } catch (e) {
    if (!opts.silent) showToast('Error starting service', true);
    addLog(`Error starting ${name}`, 'err');
  }
}

async function stopService(name, opts) {
  opts = opts || {};
  try {
    const res = await fetch(`${API_BASE}/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ service: name }) });
    const data = await res.json();
    if (!opts.silent) showToast(data.message, !data.success);
    addLog(data.message, data.success ? 'ok' : 'err');
    fetchStatus();
    return data;
  } catch (e) {
    if (!opts.silent) showToast('Error stopping service', true);
    addLog(`Error stopping ${name}`, 'err');
  }
}

function onToggle(toggleKey, checkboxEl) {
  const backendKey = resolveServiceKey(toggleKey);
  if (checkboxEl.checked) startService(backendKey);
  else stopService(backendKey);
}

function toggleFromPane(toggleKey) {
  const backendKey = resolveServiceKey(toggleKey);
  const running = (lastStatus[backendKey] || 'stopped') === 'running';
  if (running) stopService(backendKey);
  else startService(backendKey);
}

async function startAll() {
  showToast('Starting all services...', false);
  const keys = ['caddy', activePhpService(), 'mariadb', 'postgres', 'mailpit', 'adminer', 'phpmyadmin'];
  for (const key of keys) await startService(key, { silent: true });
  showToast('All services started', false);
}

async function stopAll() {
  showToast('Stopping all services...', false);
  const keys = ['caddy', activePhpService(), 'mariadb', 'postgres', 'mailpit', 'adminer', 'phpmyadmin'];
  for (const key of keys) await stopService(key, { silent: true });
  showToast('All services stopped', false);
}

async function switchPhp() {
  const version = document.getElementById('php-select').value;
  showToast(`Switching to ${SERVICE_LABELS[version]}...`, false);
  try {
    const res = await fetch(`${API_BASE}/php/switch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version }) });
    const data = await res.json();
    showToast(data.message, !data.success);
    addLog(data.message, data.success ? 'ok' : 'err');
    fetchStatus();
  } catch (e) { showToast('Error switching PHP version', true); }
}

let hostsCache = [];
let selectedHostName = null;

async function fetchHosts() {
  try {
    const res = await fetch(`${API_BASE}/hosts/list`);
    const data = await res.json();
    hostsCache = data.hosts || [];
    const container = document.getElementById('hosts-master-list');
    container.innerHTML = '';
    if (hostsCache.length === 0) {
      container.innerHTML = '<div style="color:var(--muted);padding:16px;">No hosts yet.</div>';
      showHostDetail(null);
      return;
    }
    for (const host of hostsCache) {
      const item = document.createElement('div');
      item.className = 'master-item' + (host.name === selectedHostName ? ' active' : '');
      item.onclick = () => selectHost(host.name);
      item.innerHTML = `<div class="master-item-domain">${host.domain}</div><div class="master-item-sub">${host.domain}</div>`;
      container.appendChild(item);
    }
    if (selectedHostName && hostsCache.some(h => h.name === selectedHostName)) {
      selectHost(selectedHostName);
    } else if (!selectedHostName) {
      showHostDetail(null);
    }
  } catch (e) { console.error(e); }
}

function showHostDetail(host) {
  document.getElementById('host-detail-empty').style.display = host ? 'none' : 'block';
  document.getElementById('host-detail-content').style.display = host ? 'block' : 'none';
}

async function selectHost(name) {
  selectedHostName = name;
  document.querySelectorAll('.master-item').forEach(el => el.classList.remove('active'));
  const host = hostsCache.find(h => h.name === name);
  if (!host) return;
  const idx = hostsCache.indexOf(host);
  const items = document.querySelectorAll('#hosts-master-list .master-item');
  if (items[idx]) items[idx].classList.add('active');

  showHostDetail(host);
  document.getElementById('detail-host-name').textContent = host.domain;
  document.getElementById('detail-host-url').textContent = `http://${host.domain}`;
  document.getElementById('detail-host-url').href = `http://${host.domain}`;
  document.getElementById('detail-host-path').textContent = 'Loading...';
  document.getElementById('detail-host-size').textContent = '...';
  document.getElementById('detail-host-stack').innerHTML = '';
  document.getElementById('detail-host-sqlite-list').innerHTML = '';

  try {
    const res = await fetch(`${API_BASE}/hosts/detail?name=${encodeURIComponent(name)}`);
    const data = await res.json();
    if (!data.success) return;
    document.getElementById('detail-host-path').textContent = data.path;
    document.getElementById('detail-host-size').textContent = data.sizeFormatted;
    document.getElementById('detail-host-stack').innerHTML = (data.stack || []).map(t => `<span class="tech-tag">${t}</span>`).join('') || '<span style="color:var(--muted); font-weight:400;">None detected</span>';
    renderSqliteList(data.sqliteFiles || []);
  } catch (e) { console.error(e); }
}

function renderSqliteList(files) {
  const container = document.getElementById('detail-host-sqlite-list');
  if (files.length === 0) {
    container.innerHTML = '<span style="color:var(--muted); font-size:0.85rem;">None found.</span>';
    return;
  }
  container.innerHTML = files.map(f => `
    <div class="sqlite-row">
      <span>${f}</span>
      <button class="ssl-action-link" style="color:var(--bad);" onclick="deleteSqliteFile('${f}')">Delete</button>
    </div>`).join('');
}

async function promptCreateSqlite() {
  if (!selectedHostName) return;
  const filename = prompt('Database filename (e.g. app.sqlite):');
  if (!filename) return;
  try {
    const res = await fetch(`${API_BASE}/hosts/sqlite/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: selectedHostName, filename }) });
    const data = await res.json();
    showToast(data.message, !data.success);
    addLog(data.message, data.success ? 'ok' : 'err');
    if (data.success) selectHost(selectedHostName);
  } catch (e) { showToast('Error creating database', true); }
}

async function deleteSqliteFile(filename) {
  if (!selectedHostName) return;
  if (!confirm(`Delete '${filename}'? This cannot be undone.`)) return;
  try {
    const res = await fetch(`${API_BASE}/hosts/sqlite/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: selectedHostName, filename }) });
    const data = await res.json();
    showToast(data.message, !data.success);
    addLog(data.message, data.success ? 'ok' : 'err');
    if (data.success) selectHost(selectedHostName);
  } catch (e) { showToast('Error deleting database', true); }
}

function openHostInBrowser() {
  const host = hostsCache.find(h => h.name === selectedHostName);
  if (host) window.open(`http://${host.domain}`, '_blank');
}

function showNewHostModal() {
  document.getElementById('new-host-name').value = '';
  document.getElementById('new-host-modal').classList.add('show');
}

async function createHost() {
  const input = document.getElementById('new-host-name');
  const name = input.value.trim();
  if (!name) return;
  try {
    const res = await fetch(`${API_BASE}/hosts/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    const data = await res.json();
    showToast(data.message, !data.success);
    addLog(data.message, data.success ? 'ok' : 'err');
    if (data.success) { closeModal('new-host-modal'); fetchHosts(); }
  } catch (e) { showToast('Error creating host', true); }
}

async function deleteHostFromDetail() {
  if (!selectedHostName) return;
  const name = selectedHostName;
  if (!confirm(`Delete '${name}' and all its files? This cannot be undone.`)) return;
  try {
    const res = await fetch(`${API_BASE}/hosts/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, confirm: name }) });
    const data = await res.json();
    showToast(data.message, !data.success);
    addLog(data.message, data.success ? 'ok' : 'err');
    if (data.success) { selectedHostName = null; fetchHosts(); }
  } catch (e) { showToast('Error deleting host', true); }
}

// --- Database user management (kind is 'mysql' or 'postgres') ---
async function fetchDbUsers(kind) {
  try {
    const res = await fetch(`${API_BASE}/${kind}/users/list`);
    const data = await res.json();
    const container = document.getElementById(`${kind}-users-list`);
    container.innerHTML = '';
    if (!data.users || data.users.length === 0) {
      container.innerHTML = '<div style="color:var(--muted);padding:8px 0;">No users yet.</div>';
      return;
    }
    for (const u of data.users) {
      const row = document.createElement('div');
      row.className = 'hosts-row';
      row.innerHTML = `
        <div class="host-domain">${u.User}</div>
        <div style="display:flex; gap:8px;">
          <button class="secondary" onclick="promptDbUserPassword('${kind}','${u.User}')">Password</button>
          <button class="secondary" onclick="promptDbUserGrant('${kind}','${u.User}')">Grant DB</button>
          <button class="danger" onclick="deleteDbUser('${kind}','${u.User}')">Delete</button>
        </div>`;
      container.appendChild(row);
    }
  } catch (e) { console.error(e); }
}

async function createDbUser(kind) {
  const uInput = document.getElementById(`${kind}-new-username`);
  const pInput = document.getElementById(`${kind}-new-password`);
  const username = uInput.value.trim();
  const password = pInput.value;
  if (!username) return;
  try {
    const res = await fetch(`${API_BASE}/${kind}/users/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    const data = await res.json();
    showToast(data.message, !data.success);
    addLog(data.message, data.success ? 'ok' : 'err');
    if (data.success) { uInput.value = ''; pInput.value = ''; fetchDbUsers(kind); }
  } catch (e) { showToast('Error creating user', true); }
}

async function deleteDbUser(kind, username) {
  if (!confirm(`Delete user '${username}'? This cannot be undone.`)) return;
  try {
    const res = await fetch(`${API_BASE}/${kind}/users/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username }) });
    const data = await res.json();
    showToast(data.message, !data.success);
    addLog(data.message, data.success ? 'ok' : 'err');
    if (data.success) fetchDbUsers(kind);
  } catch (e) { showToast('Error deleting user', true); }
}

async function promptDbUserPassword(kind, username) {
  const password = prompt(`New password for '${username}':`);
  if (password === null) return;
  try {
    const res = await fetch(`${API_BASE}/${kind}/users/password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    const data = await res.json();
    showToast(data.message, !data.success);
    addLog(data.message, data.success ? 'ok' : 'err');
  } catch (e) { showToast('Error updating password', true); }
}

async function promptDbUserGrant(kind, username) {
  const dbName = prompt(`Grant '${username}' full access to which database?`);
  if (!dbName) return;
  try {
    const res = await fetch(`${API_BASE}/${kind}/users/grant`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, dbName }) });
    const data = await res.json();
    showToast(data.message, !data.success);
    addLog(data.message, data.success ? 'ok' : 'err');
  } catch (e) { showToast('Error granting access', true); }
}

// --- PHP ini configuration + extensions ---
async function fetchPhpConfig() {
  try {
    const res = await fetch(`${API_BASE}/php/config`);
    const data = await res.json();
    for (const key of ['memory_limit', 'max_execution_time', 'upload_max_filesize', 'post_max_size']) {
      const el = document.getElementById(`php-cfg-${key}`);
      if (el && data.config) el.value = data.config[key] || '';
    }
    const list = document.getElementById('php-extensions-list');
    list.innerHTML = '';
    for (const ext of data.extensions || []) {
      const span = document.createElement('span');
      span.className = 'ext-tag';
      span.textContent = ext;
      list.appendChild(span);
    }
  } catch (e) { console.error(e); }
}

async function savePhpConfig() {
  const config = {};
  for (const key of ['memory_limit', 'max_execution_time', 'upload_max_filesize', 'post_max_size']) {
    config[key] = document.getElementById(`php-cfg-${key}`).value.trim();
  }
  try {
    const res = await fetch(`${API_BASE}/php/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config }) });
    const data = await res.json();
    showToast(data.message, !data.success);
    addLog(data.message, data.success ? 'ok' : 'err');
  } catch (e) { showToast('Error saving PHP configuration', true); }
}

// --- MySQL my.cnf configuration ---
async function fetchMysqlConfig() {
  try {
    const res = await fetch(`${API_BASE}/mysql/config`);
    const data = await res.json();
    for (const key of ['max_allowed_packet', 'innodb_buffer_pool_size']) {
      const el = document.getElementById(`mysql-cfg-${key}`);
      if (el && data.config) el.value = data.config[key] || '';
    }
  } catch (e) { console.error(e); }
}

async function saveMysqlConfig() {
  const config = {};
  for (const key of ['max_allowed_packet', 'innodb_buffer_pool_size']) {
    config[key] = document.getElementById(`mysql-cfg-${key}`).value.trim();
  }
  try {
    const res = await fetch(`${API_BASE}/mysql/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config }) });
    const data = await res.json();
    showToast(data.message, !data.success);
    addLog(data.message, data.success ? 'ok' : 'err');
  } catch (e) { showToast('Error saving MySQL configuration', true); }
}

// --- Mailpit configuration ---
async function fetchMailpitConfig() {
  try {
    const res = await fetch(`${API_BASE}/mailpit/config`);
    const data = await res.json();
    for (const key of ['smtp_port', 'web_port', 'auth_user', 'auth_pass']) {
      const el = document.getElementById(`mailpit-cfg-${key}`);
      if (el && data.config) el.value = data.config[key] || '';
    }
  } catch (e) { console.error(e); }
}

async function saveMailpitConfig() {
  const body = {};
  for (const key of ['smtp_port', 'web_port', 'auth_user', 'auth_pass']) {
    body[key] = document.getElementById(`mailpit-cfg-${key}`).value.trim();
  }
  try {
    const res = await fetch(`${API_BASE}/mailpit/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    showToast(data.message, !data.success);
    addLog(data.message, data.success ? 'ok' : 'err');
    // Ports may have changed - the iframe needs reloading against whatever
    // the new published port actually is, not the one it loaded with.
    if (data.success) document.getElementById('mailpit-iframe').src = `http://${window.location.hostname}:${body.web_port}`;
  } catch (e) { showToast('Error saving Mailpit configuration', true); }
}

// --- SSL tools ---
function closeModal(id) { document.getElementById(id).classList.remove('show'); }

async function fetchSslList() {
  try {
    const res = await fetch(`${API_BASE}/ssl/list`);
    const data = await res.json();
    const container = document.getElementById('ssl-list');
    container.innerHTML = '';
    if (!data.ssls || data.ssls.length === 0) {
      container.innerHTML = '<tr><td colspan="6" style="color:var(--muted); padding:20px 16px;">No hosts yet - create one from the Hosts tab first.</td></tr>';
      return;
    }
    for (const s of data.ssls) {
      const row = document.createElement('tr');
      const expires = s.expires ? new Date(s.expires).toLocaleDateString() : '—';
      const pillClass = s.status === 'active' ? 'active' : (s.status === 'csr pending' ? 'pending' : '');
      let actions = '';
      if (s.status === 'none') {
        actions = `<button class="ssl-action-link" onclick="openCsrModal('${s.domain}')">Generate CSR</button>`;
      } else if (s.status === 'csr pending') {
        actions = `<button class="ssl-action-link" onclick="openCsrModal('${s.domain}')">View/Regenerate CSR</button>
          <button class="ssl-action-link" onclick="openUploadModal('${s.domain}')">Upload Certificate</button>`;
      } else if (s.status === 'active') {
        actions = `<button class="ssl-action-link" onclick="openCsrModal('${s.domain}')">Renew</button>`;
      }
      row.innerHTML = `
        <td style="font-weight:600;">${s.name}</td>
        <td>${s.domain}</td>
        <td>${s.type || 'RSA 2048'}</td>
        <td><span class="ssl-status-pill ${pillClass}">${s.status}</span></td>
        <td>${expires}</td>
        <td style="text-align:right;">${actions}</td>`;
      container.appendChild(row);
    }
  } catch (e) { console.error(e); }
}

function openCsrModal(domain) {
  document.getElementById('csr-domain').value = domain;
  document.getElementById('csr-domain-display').textContent = domain;
  document.getElementById('csr-organization').value = '';
  document.getElementById('csr-email').value = '';
  document.getElementById('csr-country').value = '';
  document.getElementById('csr-state').value = '';
  document.getElementById('csr-locality').value = '';
  document.getElementById('csr-result').style.display = 'none';
  document.getElementById('csr-modal').classList.add('show');
}

async function submitGenerateCsr() {
  const domain = document.getElementById('csr-domain').value;
  const body = {
    domain,
    organization: document.getElementById('csr-organization').value.trim(),
    email: document.getElementById('csr-email').value.trim(),
    country: document.getElementById('csr-country').value.trim(),
    state: document.getElementById('csr-state').value.trim(),
    locality: document.getElementById('csr-locality').value.trim()
  };
  try {
    const res = await fetch(`${API_BASE}/ssl/generate-csr`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    showToast(data.message, !data.success);
    addLog(data.message, data.success ? 'ok' : 'err');
    if (data.success) {
      document.getElementById('csr-output').value = data.csr;
      document.getElementById('csr-result').style.display = 'block';
      fetchSslList();
    }
  } catch (e) { showToast('Error generating CSR', true); }
}

function openUploadModal(domain) {
  document.getElementById('upload-domain').value = domain;
  document.getElementById('upload-domain-display').textContent = domain;
  document.getElementById('upload-cert-text').value = '';
  document.getElementById('upload-cert-modal').classList.add('show');
}

async function submitUploadCert() {
  const domain = document.getElementById('upload-domain').value;
  const certificate = document.getElementById('upload-cert-text').value.trim();
  try {
    const res = await fetch(`${API_BASE}/ssl/upload`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domain, certificate }) });
    const data = await res.json();
    showToast(data.message, !data.success);
    addLog(data.message, data.success ? 'ok' : 'err');
    if (data.success) { closeModal('upload-cert-modal'); fetchSslList(); }
  } catch (e) { showToast('Error uploading certificate', true); }
}

// --- Share dashboard access ---
async function initShareLink() {
  try {
    const res = await fetch(`${API_BASE}/token`);
    const data = await res.json();
    if (data.token) document.getElementById('share-link').value = `${window.location.origin}/?token=${data.token}`;
  } catch (e) { console.error(e); }
}

function copyShareLink() {
  const input = document.getElementById('share-link');
  input.select();
  input.setSelectionRange(0, input.value.length);
  // navigator.clipboard only exists in a secure context (HTTPS or
  // localhost) - this dashboard is plain HTTP from a LAN IP by design, so
  // it's undefined here and calling .writeText on it throws synchronously,
  // before any .then/.catch ever runs. document.execCommand('copy') is
  // deprecated but still works from any context and needs no permission
  // prompt, so it's the one that actually works for this page.
  try {
    if (document.execCommand('copy')) {
      showToast('Link copied to clipboard', false);
    } else {
      showToast('Could not copy - select and copy manually', true);
    }
  } catch (e) {
    showToast('Could not copy - select and copy manually', true);
  }
}

fetchStatus();
fetchHosts();
initShareLink();
setInterval(fetchStatus, 3000);
