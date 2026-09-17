const API_BASE = window.location.origin + '/api';
let SYS_PORTS = { caddy_http: 80, caddy_https: 443 };

// The daemon requires a per-install token (X-JengaDev-Token) on every /api/*
// call. JengaDev's launcher opens this page with ?token=... in the URL; pull
// it into sessionStorage once and scrub it from the visible address bar so it
// doesn't linger in browser history, then attach it to every fetch from here
// on. A fresh tab that wasn't opened by the launcher (no token anywhere) will
// get 401s - shown as a banner rather than a silently broken dashboard.
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
        return nativeFetch(input, init).then(function (res) {
            if (res.status === 401) showAuthBanner();
            return res;
        });
    };

    function showAuthBanner() {
        if (document.getElementById('jd-auth-banner')) return;
        const bar = document.createElement('div');
        bar.id = 'jd-auth-banner';
        bar.textContent = 'No authenticated session. Close this tab and reopen JengaDev from its desktop icon or Start Menu shortcut.';
        bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#c0293a;color:#fff;' +
            'padding:10px 16px;font-family:system-ui,sans-serif;font-size:14px;text-align:center;';
        document.body.appendChild(bar);
    }
})();

// Utilities
function escapeHTML(str) {
    const p = document.createElement('p');
    p.appendChild(document.createTextNode(str));
    return p.innerHTML;
}

function showToast(message, isError = false) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = 'toast show ' + (isError ? 'error' : '');
    setTimeout(() => { toast.classList.remove('show'); }, 3000);
}

// Tab Switching
function activateTab(tabId) {
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    const tabEl = document.querySelector(`.nav-item[data-tab="${tabId}"]`);
    if (tabEl) tabEl.classList.add('active');
    
    document.querySelectorAll('.tab-pane').forEach(c => c.classList.remove('active'));
    const contentEl = document.getElementById(`pane-${tabId}`);
    if (contentEl) contentEl.classList.add('active');
    
    if (tabId === 'hosts') {
        fetchHosts();
    }
    
    if (tabId === 'mailpit') {
        const iframe = document.getElementById('mailpit-iframe');
        if (iframe) iframe.src = iframe.src;
    }
}

document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
        if(item.classList.contains('nav-section-title') || e.target.tagName === 'INPUT' || e.target.classList.contains('slider')) return;
        const tabId = item.dataset.tab;
        window.location.hash = tabId;
        activateTab(tabId);
    });
});

window.addEventListener('DOMContentLoaded', () => {
    const hash = window.location.hash.replace('#', '') || 'overview';
    activateTab(hash);
});

// Service Management
// Global Variables
let lastLogCount = { caddy: 0, php: 0, mysql: 0, postgres: 0, mailpit: 0 };
const terminalOutput = document.getElementById('terminal-output');

let isFetchingStatus = false;
async function fetchStatus() {
    if (isFetchingStatus) return;
    isFetchingStatus = true;
    try {
        const res = await fetch(`${API_BASE}/status`);
        const data = await res.json();
        if (data.ports) SYS_PORTS = data.ports;
        updateStatusUI(data);
        
        // Update PHP Select if we haven't yet or if it changed
        if (data.active_php && document.getElementById('php-version-select').getAttribute('data-active') !== data.active_php) {
            document.getElementById('php-version-select').setAttribute('data-active', data.active_php);
            fetchPhpVersions();
        }
    } catch (e) {
        updateStatusUI({ caddy: 'stopped', php: 'stopped', mysql: 'stopped' });
    } finally {
        isFetchingStatus = false;
    }
}

let currentServices = {};

let lastMailpitState = 'stopped';

function updateStatusUI(services) {
    currentServices = services || {};
    
    if (services.mysql === 'running' && window._lastMysqlStatus !== 'running') {
        fetchDbUsers('mysql').then(success => { if (!success) window._lastMysqlStatus = null; });
        fetchDatabases();
    }
    if (services.postgres === 'running' && window._lastPostgresStatus !== 'running') {
        fetchDbUsers('postgres').then(success => { if (!success) window._lastPostgresStatus = null; });
    }
    window._lastMysqlStatus = services.mysql;
    window._lastPostgresStatus = services.postgres;

    ['caddy', 'php', 'mysql', 'postgres', 'mailpit'].forEach(service => {
        const isRunning = services[service] === 'running';
        
        // Top toolbar indicator
        const ind = document.getElementById(`ind-${service}`);
        if(ind) {
            if(isRunning) ind.classList.add('running');
            else ind.classList.remove('running');
        }
        


// Sidebar toggle
        const toggle = document.getElementById(`toggle-sidebar-${service}`);
        if(toggle) {
            toggle.checked = isRunning;
        }
        
        // Service Pane details
        const pane = document.getElementById(`pane-${service}`);
        if(!pane) return;
        
        const badge = pane.querySelector('.status-badge');
        const btnToggle = pane.querySelector('.btn-toggle');
        if (btnToggle) btnToggle.disabled = false;
        
        if (isRunning) {
            if (badge) {
                badge.className = 'status-badge status-running';
                badge.textContent = 'Running';
            }
            if (btnToggle) {
                btnToggle.textContent = 'Stop';
                btnToggle.className = 'btn btn-secondary btn-toggle';
            }
        } else {
            if (badge) {
                badge.className = 'status-badge status-offline';
                badge.textContent = 'Offline';
            }
            if (btnToggle) {
                btnToggle.textContent = 'Start';
                btnToggle.className = 'btn btn-primary btn-toggle';
            }
        }
    });

    // Handle Mailpit UI
    if (services.mailpit) {
        const mailpitRunning = services.mailpit === 'running';
        const isInstalled = services.installed && services.installed.mailpit;
        const ind = document.getElementById('ind-mailpit');
        if(ind) {
            if(mailpitRunning) ind.classList.add('running');
            else ind.classList.remove('running');
        }
        const toggle = document.getElementById('toggle-sidebar-mailpit');
        if(toggle) toggle.checked = mailpitRunning;

        const btnInstall = document.getElementById('btn-install-mailpit');
        const btnStart = document.getElementById('btn-start-mailpit');
        const btnStop = document.getElementById('btn-stop-mailpit');
        const mailpitIframe = document.getElementById('mailpit-iframe-container');
        const mailpitSettings = document.getElementById('mailpit-settings-container');
        
        if (mailpitRunning) {
            if (btnInstall) btnInstall.style.display = 'none';
            if (btnStart) btnStart.style.display = 'none';
            if (btnStop) btnStop.style.display = 'inline-block';
            if (mailpitIframe) mailpitIframe.style.display = 'block';
            if (mailpitSettings) mailpitSettings.style.display = 'block';
        } else {
            if (mailpitIframe) mailpitIframe.style.display = 'none';
            if (isInstalled) {
                if (btnInstall) btnInstall.style.display = 'none';
                if (btnStart) btnStart.style.display = 'inline-block';
                if (btnStop) btnStop.style.display = 'none';
                if (mailpitSettings) mailpitSettings.style.display = 'block';
            } else {
                if (btnInstall) btnInstall.style.display = 'inline-block';
                if (btnStart) btnStart.style.display = 'none';
                if (btnStop) btnStop.style.display = 'none';
                if (mailpitSettings) mailpitSettings.style.display = 'none';
            }
        }
    }
    
    // Handle Postgres UI
    if (services.postgres) {
        const pgRunning = services.postgres === 'running';
        const isPgInstalled = services.installed && services.installed.postgres;
        const isMysqlInstalled = services.installed && services.installed.mysql;
        
        document.getElementById('postgres-installed-view').style.display = isPgInstalled ? 'block' : 'none';
        document.getElementById('postgres-uninstalled-view').style.display = isPgInstalled ? 'none' : 'block';
        
        const btnInstallPg = document.getElementById('btn-install-postgres');
        const btnInstallMysql = document.getElementById('btn-install-mysql');
        
        document.getElementById('mysql-installed-view').style.display = isMysqlInstalled ? 'block' : 'none';
        document.getElementById('mysql-uninstalled-view').style.display = isMysqlInstalled ? 'none' : 'block';
        
        const btnTogglePg = document.getElementById('btn-postgres-toggle');
        const badgePg = document.getElementById('badge-postgres');
        
        const btnToggleMysql = document.querySelector('#pane-mysql .btn-toggle');
        
        if (pgRunning) {
            if (btnInstallPg) btnInstallPg.style.display = 'none';
            if (btnTogglePg) {
                btnTogglePg.textContent = 'Stop';
                btnTogglePg.className = 'btn btn-secondary btn-toggle';
                btnTogglePg.disabled = false;
            }
            if (badgePg) { badgePg.textContent = 'Running'; badgePg.className = 'status-badge status-running'; }
        } else {
            if (isPgInstalled) {
                if (btnInstallPg) btnInstallPg.style.display = 'none';
                if (btnTogglePg) {
                    btnTogglePg.textContent = 'Start';
                    btnTogglePg.className = 'btn btn-primary btn-toggle';
                    btnTogglePg.disabled = false;
                }
            } else {
                if (btnInstallPg) btnInstallPg.style.display = 'inline-block';
                if (btnTogglePg) btnTogglePg.disabled = true;
            }
            if (badgePg) { badgePg.textContent = 'Stopped'; badgePg.className = 'status-badge status-offline'; }
        }
        
        // Handle Top Bar DB Buttons
        const dbRunning = pgRunning || (services.mysql === 'running');
        const btnPhpMyAdmin = document.getElementById('top-btn-phpmyadmin');
        const btnAdminer = document.getElementById('top-btn-adminer');
        
        if (btnPhpMyAdmin && btnAdminer) {
            if (dbRunning) {
                btnPhpMyAdmin.style.display = (services.mysql === 'running') ? 'inline-block' : 'none';
                btnAdminer.style.display = 'inline-block';
            } else {
                btnPhpMyAdmin.style.display = 'none';
                btnAdminer.style.display = 'none';
            }
        }
        
        if (btnInstallMysql) {
            btnInstallMysql.style.display = isMysqlInstalled ? 'none' : 'inline-block';
        }
        if (btnToggleMysql && !isMysqlInstalled) {
            btnToggleMysql.disabled = true;
        } else if (btnToggleMysql) {
            btnToggleMysql.disabled = false;
        }
    }
    
    if (loadedPhpExtensions.length === 0) {
        loadPhpConfig();
    }
    
    if (lastMailpitState !== 'running' && services.mailpit === 'running') {
        const frame = document.getElementById('mailpit-frame');
        if (frame) {
            setTimeout(() => {
                frame.src = frame.src;
            }, 1500);
        }
    }
    lastMailpitState = services.mailpit || 'stopped';
}

async function installMailpit() {
    const btn = document.getElementById('btn-install-mailpit');
    btn.innerHTML = 'Downloading Mailpit...';
    btn.disabled = true;
    showToast('Downloading Mailpit from GitHub. This may take a moment...', false);
    
    try {
        const res = await fetch(`${API_BASE}/mailpit/install`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            showToast(data.message, false);
            btn.style.display = 'none';
            document.getElementById('btn-start-mailpit').style.display = 'inline-block';
            document.getElementById('mailpit-settings-container').style.display = 'block';
            startService('mailpit');
        } else {
            showToast(data.message, true);
            btn.innerHTML = 'Install & Start Mailpit';
            btn.disabled = false;
        }
    } catch(e) {
        showToast('Error installing Mailpit', true);
        btn.innerHTML = 'Install & Start Mailpit';
        btn.disabled = false;
    }
}

async function fetchMailpitConfig() {
    try {
        const res = await fetch(`${API_BASE}/mailpit/config`);
        const config = await res.json();
        document.getElementById('mailpit-smtp-port').value = config.smtp_port || 1025;
        document.getElementById('mailpit-web-port').value = config.web_port || 8025;
        document.getElementById('mailpit-user').value = config.auth_user || '';
        document.getElementById('mailpit-pass').value = config.auth_pass || '';
    } catch(e) {}
}

async function saveMailpitConfig() {
    const config = {
        smtp_port: parseInt(document.getElementById('mailpit-smtp-port').value) || 1025,
        web_port: parseInt(document.getElementById('mailpit-web-port').value) || 8025,
        auth_user: document.getElementById('mailpit-user').value || '',
        auth_pass: document.getElementById('mailpit-pass').value || ''
    };
    
    try {
        const res = await fetch(`${API_BASE}/mailpit/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        });
        const data = await res.json();
        showToast(data.message, !data.success);
        if (data.success) fetchMailpitConfig();
    } catch(e) {
        showToast('Error saving Mailpit configuration', true);
    }
}

async function installPostgres() {
    const btn = document.getElementById('btn-install-postgres');
    btn.innerHTML = 'Downloading PostgreSQL (400MB)...';
    btn.disabled = true;
    showToast('Downloading PostgreSQL binaries from EnterpriseDB. This will take a while...', false);
    
    try {
        const res = await fetch(`${API_BASE}/postgres/install`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            showToast(data.message, false);
            btn.style.display = 'none';
            document.getElementById('btn-postgres-toggle').disabled = false;
            startService('postgres');
        } else {
            showToast(data.message, true);
            btn.innerHTML = 'Install PostgreSQL';
            btn.disabled = false;
        }
    } catch(e) {
        showToast('Error installing PostgreSQL', true);
        btn.innerHTML = 'Install PostgreSQL';
        btn.disabled = false;
    }
}

async function openAdminer() {
    showToast('Opening Adminer...', false);
    // Trigger Adminer install if needed, then open window
    try {
        await fetch(`${API_BASE}/adminer/install`, { method: 'POST' });
        const p = SYS_PORTS.caddy_http === 80 ? '' : `:${SYS_PORTS.caddy_http}`;
        window.open(`http://adminer.jengadev${p}`, '_blank');
    } catch(e) {
        showToast('Failed to install Adminer', true);
    }
}

async function startService(service) {
    await performServiceAction(service, '/start');
}

async function stopService(service) {
    await performServiceAction(service, '/stop');
}

async function toggleService(service) {
    const pane = document.getElementById(`pane-${service}`);
    const btn = pane.querySelector('.btn-toggle');
    const isStarting = btn.textContent === 'Start';
    await performServiceAction(service, isStarting ? '/start' : '/stop');
}

async function performServiceAction(service, endpoint) {
    const pane = document.getElementById(`pane-${service}`);
    const btn = pane ? pane.querySelector('.btn-toggle') : null;
    
    if (btn) {
        btn.disabled = true;
        btn.textContent = '...';
    }
    
    try {
        const res = await fetch(`${API_BASE}${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ service })
        });
        const data = await res.json();
        if (!data.success) showToast(data.message, true);
    } catch (err) {
        showToast('Connection error', true);
    }
    
    setTimeout(fetchStatus, 500);
}

document.getElementById('btn-start-all').addEventListener('click', () => {
    const activeServices = ['caddy', 'php'];
    if (currentServices && currentServices.installed) {
        if (currentServices.installed.mysql) activeServices.push('mysql');
        if (currentServices.installed.postgres) activeServices.push('postgres');
        if (currentServices.installed.mailpit) activeServices.push('mailpit');
    }
    activeServices.forEach((svc, idx) => {
        setTimeout(() => performServiceAction(svc, '/start'), idx * 500);
    });
});

document.getElementById('btn-stop-all').addEventListener('click', () => {
    const activeServices = ['caddy', 'php'];
    if (currentServices && currentServices.installed) {
        if (currentServices.installed.mysql) activeServices.push('mysql');
        if (currentServices.installed.postgres) activeServices.push('postgres');
        if (currentServices.installed.mailpit) activeServices.push('mailpit');
    }
    activeServices.forEach((svc, idx) => {
        setTimeout(() => performServiceAction(svc, '/stop'), idx * 500);
    });
});

// Logs Polling (Combined for Overview)
let isFetchingLogs = false;
async function fetchLogs() {
    if (isFetchingLogs) return;
    isFetchingLogs = true;
    try {
        for (const service of ['caddy', 'php', 'mysql', 'postgres', 'mailpit']) {
            const res = await fetch(`${API_BASE}/logs/${service}`);
            const logs = await res.json();
            
            if (logs.length > lastLogCount[service]) {
                const newLogs = logs.slice(lastLogCount[service]);
                newLogs.forEach(log => {
                    const div = document.createElement('div');
                    // log is an object: { timestamp, message, type }
                    const isError = log.type === 'error' || (log.message && log.message.toLowerCase().includes('error'));
                    div.className = `log-line ${isError ? 'error' : ''}`;
                    const timeStr = new Date(log.timestamp).toLocaleTimeString();
                    div.innerHTML = `<span class="time">[${timeStr}] [${service.toUpperCase()}]</span> ${escapeHTML(log.message || log)}`;
                    terminalOutput.appendChild(div);
                });
                lastLogCount[service] = logs.length;
                terminalOutput.scrollTop = terminalOutput.scrollHeight;
            }
        }
    } catch (e) {
        console.error('Logs fetch failed:', e);
    } finally {
        isFetchingLogs = false;
    }
}

function clearLogs() {
    terminalOutput.innerHTML = '';
}

// Hosts Management
function showNewHostModal() { document.getElementById('host-modal').style.display = 'flex'; }
function closeHostModal() { document.getElementById('host-modal').style.display = 'none'; document.getElementById('new-host-name').value = ''; }

function showDownloadPhpModal() { document.getElementById('php-download-modal').style.display = 'flex'; }
function closePhpModal() { document.getElementById('php-download-modal').style.display = 'none'; }

// === PHP VERSION MANAGEMENT ===
async function fetchPhpVersions() {
    try {
        const res = await fetch(`${API_BASE}/php/versions`);
        const data = await res.json();
        if (data.success) {
            const select = document.getElementById('php-version-select');
            select.innerHTML = '';
            data.versions.forEach(v => {
                const opt = document.createElement('option');
                opt.value = v.folder;
                opt.text = v.folder;
                if (v.folder === data.active) opt.selected = true;
                select.appendChild(opt);
            });
        }
    } catch (e) { console.error(e); }
}

async function switchPhpVersion(folder) {
    appendLog(`Switching PHP version to ${folder}...`);
    try {
        await fetch(`${API_BASE}/php/switch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folder })
        });
        appendLog(`Successfully switched to ${folder}.`);
    } catch (e) {
        appendLog(`Failed to switch PHP version.`);
    }
}

let phpDlInterval;
async function startPhpDownload() {
    const val = document.getElementById('php-download-select').value;
    const [url, folder] = val.split('|');
    const btn = document.getElementById('btn-start-php-dl');
    
    btn.disabled = true;
    document.getElementById('php-dl-progress').innerText = "Initiating download...";
    
    try {
        await fetch(`${API_BASE}/php/download`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, versionFolder: folder })
        });
        
        phpDlInterval = setInterval(async () => {
            const res = await fetch(`${API_BASE}/php/download/status`);
            const data = await res.json();
            document.getElementById('php-dl-progress').innerText = data.progress;
            
            if (!data.isDownloading) {
                clearInterval(phpDlInterval);
                btn.disabled = false;
                if (data.progress === 'Complete') {
                    appendLog(`Successfully downloaded and installed ${folder}.`);
                    fetchPhpVersions();
                    setTimeout(closePhpModal, 1500);
                }
            }
        }, 1000);
    } catch (e) {
        document.getElementById('php-dl-progress').innerText = "Error starting download.";
        btn.disabled = false;
    }
}

// ==============================

// === PHP & MYSQL CONFIGURATION ===
let loadedPhpExtensions = [];

async function loadPhpConfig() {
    try {
        const res = await fetch(`${API_BASE}/php/config`);
        const data = await res.json();
        if (data.success && data.config) {
            document.getElementById('php-cfg-memory_limit').value = data.config.memory_limit || '';
            document.getElementById('php-cfg-max_execution_time').value = data.config.max_execution_time || '';
            document.getElementById('php-cfg-upload_max_filesize').value = data.config.upload_max_filesize || '';
            document.getElementById('php-cfg-post_max_size').value = data.config.post_max_size || '';
            
            const container = document.getElementById('php-extensions-container');
            if (container && data.extensions) {
                container.innerHTML = '';
                loadedPhpExtensions = Object.keys(data.extensions).sort();
                
                loadedPhpExtensions.forEach(ext => {
                    const isEnabled = data.extensions[ext];
                    const div = document.createElement('label');
                    div.className = 'switch-row php-ext-item';
                    div.dataset.ext = ext;
                    div.innerHTML = `
                        <span>${ext}</span>
                        <label class="switch"><input type="checkbox" id="php-ext-${ext}" ${isEnabled ? 'checked' : ''}><span class="slider"></span></label>
                    `;
                    container.appendChild(div);
                });
            }
        }
    } catch (e) {}
}

document.getElementById('php-ext-search').addEventListener('input', (e) => {
    const term = e.target.value.toLowerCase();
    let found = false;
    document.querySelectorAll('.php-ext-item').forEach(el => {
        if (el.dataset.ext.toLowerCase().includes(term)) {
            el.style.display = 'flex';
            found = true;
        } else {
            el.style.display = 'none';
        }
    });
    
    let installPrompt = document.getElementById('pecl-install-prompt');
    if (!installPrompt) {
        installPrompt = document.createElement('div');
        installPrompt.id = 'pecl-install-prompt';
        installPrompt.style.padding = '15px';
        installPrompt.style.textAlign = 'center';
        installPrompt.style.background = 'rgba(96, 165, 250, 0.1)';
        installPrompt.style.borderRadius = '8px';
        installPrompt.style.marginTop = '10px';
        document.getElementById('php-extensions-container').parentNode.appendChild(installPrompt);
    }
    
    if (!found && term.length > 1) {
        installPrompt.style.display = 'block';
        installPrompt.innerHTML = `
            <p style="color: var(--text-muted); margin-bottom: 10px;">Extension <strong>${term}</strong> not found locally.</p>
            <button class="btn btn-primary" onclick="installPeclExtension('${term}')"><i class="fas fa-cloud-download-alt"></i> Download from PECL</button>
        `;
    } else {
        installPrompt.style.display = 'none';
    }
});

async function installPeclExtension(ext) {
    const btn = event.currentTarget;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Downloading...';
    btn.disabled = true;
    showToast(`Downloading php_${ext}.dll from PECL...`, false);
    
    try {
        const res = await fetch(`${API_BASE}/php/install-extension`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ extension: ext })
        });
        const data = await res.json();
        if (data.success) {
            showToast(data.message, false);
            document.getElementById('php-ext-search').value = '';
            fetchPhpConfig(); // reload
        } else {
            showToast(data.message, true);
        }
    } catch (e) {
        showToast('Error downloading extension', true);
    }
    btn.innerHTML = '<i class="fas fa-cloud-download-alt"></i> Download from PECL';
    btn.disabled = false;
}

async function savePhpConfig() {
    const config = {
        memory_limit: document.getElementById('php-cfg-memory_limit').value,
        max_execution_time: document.getElementById('php-cfg-max_execution_time').value,
        upload_max_filesize: document.getElementById('php-cfg-upload_max_filesize').value,
        post_max_size: document.getElementById('php-cfg-post_max_size').value
    };
    
    const extensions = {};
    loadedPhpExtensions.forEach(ext => {
        const el = document.getElementById(`php-ext-${ext}`);
        if (el) extensions[ext] = el.checked;
    });
    
    try {
        const res = await fetch(`${API_BASE}/php/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ config, extensions })
        });
        const data = await res.json();
        showToast(data.message, !data.success);
    } catch (e) {
        showToast('Error saving PHP config', true);
    }
}

async function loadMysqlConfig() {
    try {
        const res = await fetch(`${API_BASE}/mysql/config`);
        const data = await res.json();
        if (data.success && data.config) {
            document.getElementById('mysql-cfg-port').value = data.config.port || '';
            document.getElementById('mysql-cfg-max_allowed_packet').value = data.config.max_allowed_packet || '';
            document.getElementById('mysql-cfg-innodb_buffer_pool_size').value = data.config.innodb_buffer_pool_size || '';
        }
    } catch (e) {}
}

async function saveMysqlConfig() {
    const config = {
        port: document.getElementById('mysql-cfg-port').value,
        max_allowed_packet: document.getElementById('mysql-cfg-max_allowed_packet').value,
        innodb_buffer_pool_size: document.getElementById('mysql-cfg-innodb_buffer_pool_size').value
    };
    
    try {
        const res = await fetch(`${API_BASE}/mysql/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ config })
        });
        const data = await res.json();
        showToast(data.message, !data.success);
    } catch (e) {
        showToast('Error saving MySQL config', true);
    }
}

// Database Operations
async function backupMysql() {
    const dbName = document.getElementById('mysql-backup-db').value.trim();
    showToast('Starting backup...', false);
    try {
        const res = await fetch(`${API_BASE}/mysql/backup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dbName })
        });
        const data = await res.json();
        showToast(data.message, !data.success);
    } catch (e) {
        showToast('Error running backup', true);
    }
}

async function restoreMysql() {
    const dbName = document.getElementById('mysql-restore-db').value.trim();
    const filePath = document.getElementById('mysql-restore-file').value.trim();
    if (!filePath) return showToast('Please enter an absolute file path', true);
    
    showToast('Starting restore...', false);
    try {
        const res = await fetch(`${API_BASE}/mysql/restore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dbName, filePath })
        });
        const data = await res.json();
        showToast(data.message, !data.success);
    } catch (e) {
        showToast('Error restoring database', true);
    }
}

// SSL Generator & Management
async function fetchSslList() {
    try {
        const res = await fetch(`${API_BASE}/ssl/list`);
        const data = await res.json();
        
        const list = document.getElementById('ssl-master-list');
        if (!list) return;
        
        list.innerHTML = '';
        if (data.ssls.length === 0) {
            list.innerHTML = '<tr><td colspan="6" style="padding: 15px; text-align: center; color: var(--text-muted);">No websites found. Create a host first.</td></tr>';
            return;
        }
        
        data.ssls.forEach(ssl => {
            const tr = document.createElement('tr');
            tr.style.borderBottom = '1px solid rgba(255,255,255,0.05)';
            
            let statusBadge = '';
            let actions = '';
            
            if (ssl.status === 'none') {
                statusBadge = '<span style="color: var(--text-muted); font-size: 12px; padding: 3px 8px; border-radius: 4px; background: rgba(255,255,255,0.05);">none</span>';
                actions = `<a href="#" onclick="openCsrModal('${ssl.domain}')" style="color: #60a5fa; margin-left: 10px; text-decoration: none;"><i class="fas fa-key"></i> Generate CSR</a>`;
            } else if (ssl.status === 'csr pending') {
                statusBadge = '<span style="color: #f59e0b; font-size: 12px; padding: 3px 8px; border-radius: 4px; background: rgba(245, 158, 11, 0.1);">csr pending</span>';
                actions = `
                    <a href="#" onclick="openUploadModal('${ssl.domain}')" style="color: #10b981; margin-left: 10px; text-decoration: none;"><i class="fas fa-upload"></i> Upload Cert</a>
                    <a href="#" onclick="openCsrModal('${ssl.domain}')" style="color: #60a5fa; margin-left: 10px; text-decoration: none;" title="Regenerate"><i class="fas fa-sync"></i> Regenerate</a>
                `;
            } else if (ssl.status === 'active') {
                statusBadge = '<span style="color: #10b981; font-size: 12px; padding: 3px 8px; border-radius: 4px; background: rgba(16, 185, 129, 0.1);">active</span>';
                const expDate = new Date(ssl.expires).toLocaleDateString();
                const daysLeft = Math.round((new Date(ssl.expires) - new Date()) / (1000 * 60 * 60 * 24));
                ssl.expires = `${expDate} (${daysLeft}d)`;
                actions = `
                    <a href="#" onclick="openCsrModal('${ssl.domain}')" style="color: #60a5fa; margin-left: 10px; text-decoration: none;"><i class="fas fa-sync"></i> Renew</a>
                `;
            }
            
            tr.innerHTML = `
                <td style="padding: 15px; font-weight: 500;">${ssl.name}</td>
                <td style="padding: 15px; color: var(--text-muted);">${ssl.domain}</td>
                <td style="padding: 15px; color: var(--text-muted);">${ssl.type}</td>
                <td style="padding: 15px;">${statusBadge}</td>
                <td style="padding: 15px; color: var(--text-muted);">${ssl.expires || '—'}</td>
                <td style="padding: 15px; text-align: right;">${actions}</td>
            `;
            list.appendChild(tr);
        });
        
        const expiringDomains = data.ssls.filter(s => s.status === 'active' && Math.round((new Date(s.expires) - new Date()) / (1000 * 60 * 60 * 24)) <= 14).map(s => s.domain);
        const alertsDiv = document.getElementById('global-alerts');
        const alertsText = document.getElementById('global-alerts-text');
        if (expiringDomains.length > 0) {
            alertsText.innerHTML = `<strong>Action Required:</strong> SSL certificates for <strong>${expiringDomains.join(', ')}</strong> will expire in less than 14 days.`;
            alertsDiv.style.display = 'flex';
        } else {
            alertsDiv.style.display = 'none';
        }
        
    } catch(e) {
        console.error(e);
    }
}

function openCsrModal(domain) {
    document.getElementById('csr-domain').value = domain;
    document.getElementById('csr-domain-display').value = domain;
    document.getElementById('csr-results').style.display = 'none';
    document.getElementById('csr-generate-btn').style.display = 'block';
    document.getElementById('csr-modal').style.display = 'flex';
}
function closeCsrModal() { document.getElementById('csr-modal').style.display = 'none'; }

function openUploadModal(domain) {
    document.getElementById('upload-domain').value = domain;
    document.getElementById('upload-cert-text').value = '';
    document.getElementById('upload-cert-modal').style.display = 'flex';
}
function closeUploadModal() { document.getElementById('upload-cert-modal').style.display = 'none'; }

async function submitCsr() {
    const domain = document.getElementById('csr-domain').value;
    const payload = {
        domain,
        organization: document.getElementById('csr-org').value.trim(),
        country: document.getElementById('csr-country').value.trim(),
        state: document.getElementById('csr-state').value.trim(),
        locality: document.getElementById('csr-locality').value.trim(),
        email: document.getElementById('csr-email').value.trim()
    };
    
    showToast('Generating keys...', false);
    try {
        const res = await fetch(`${API_BASE}/ssl/generate-csr`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.success) {
            document.getElementById('csr-results').style.display = 'block';
            document.getElementById('csr-generate-btn').style.display = 'none';
            document.getElementById('csr-out-key').value = "Saved securely on the server.";
            document.getElementById('csr-out-csr').value = data.csr;
            showToast('CSR Generated Successfully', false);
            fetchSslList();
        } else {
            showToast(data.message, true);
        }
    } catch (e) {
        showToast('Error generating CSR', true);
    }
}

async function submitUploadCert() {
    const domain = document.getElementById('upload-domain').value;
    const certificate = document.getElementById('upload-cert-text').value.trim();
    if (!certificate) return showToast('Please paste the certificate', true);
    
    showToast('Activating SSL...', false);
    try {
        const res = await fetch(`${API_BASE}/ssl/upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ domain, certificate })
        });
        const data = await res.json();
        if (data.success) {
            showToast('SSL Activated Successfully', false);
            closeUploadModal();
            fetchSslList();
        } else {
            showToast(data.message, true);
        }
    } catch (e) {
        showToast('Error uploading cert', true);
    }
}

async function createHost() {
    const name = document.getElementById('new-host-name').value.trim();
    if (!name) return showToast('Please enter a name', true);
    
    showToast('Creating...', false);
    try {
        const res = await fetch(`${API_BASE}/hosts/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        const data = await res.json();
        if (data.success) {
            closeHostModal();
            fetchHosts();
            showToast(data.message, false);
        } else {
            showToast(data.message, true);
        }
    } catch (e) {
        showToast('Error creating host', true);
    }
}

async function openInExplorer() {
    const path = document.getElementById('detail-host-path').innerText;
    if (!path) return;
    try {
        await fetch(`${API_BASE}/hosts/open-explorer`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hostPath: path })
        });
    } catch(e) {}
}

async function openEditor(editor) {
    const path = document.getElementById('detail-host-path').innerText;
    if (!path || !editor) return;
    try {
        await fetch(`${API_BASE}/hosts/open-editor`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hostPath: path, editor })
        });
    } catch(e) {}
}

async function deleteHost() {
    const name = document.getElementById('detail-host-name').innerText;
    if (!name) return;
    
    if (!confirm(`Are you sure you want to permanently delete the host '${name}' and ALL of its files? This action cannot be undone.`)) {
        return;
    }
    
    showToast(`Deleting host ${name}...`, false);
    try {
        const res = await fetch(`${API_BASE}/hosts/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, confirm: name })
        });
        const data = await res.json();
        if (data.success) {
            showToast(data.message, false);
            document.getElementById('host-detail-view').style.display = 'none';
            fetchHosts();
        } else {
            showToast(data.message, true);
        }
    } catch(e) {
        showToast('Error deleting host', true);
    }
}

// PHP Config==============================

// Sidebar Toggles Logic
document.querySelectorAll('.switch input').forEach(toggle => {
    toggle.addEventListener('change', (e) => {
        const service = e.target.id.replace('toggle-sidebar-', '');
        if (e.target.checked) {
            startService(service);
        } else {
            stopService(service);
        }
    });
});

// Init
let selectedHostName = null;

async function fetchHosts() {
    try {
        const res = await fetch(`${API_BASE}/hosts/list`);
        const data = await res.json();
        const list = document.getElementById('hosts-master-list');
        list.innerHTML = '';
        if (data.hosts.length === 0) {
            list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted)">No hosts found.</div>';
            document.getElementById('host-detail-view').style.display = 'none';
            selectedHostName = null;
            return;
        }

        let matchedIndex = -1;
        data.hosts.forEach((host, index) => {
            const div = document.createElement('div');
            div.className = 'master-item';
            div.innerHTML = `
                <div>
                    <div style="font-weight: 500;">${escapeHTML(host.name)}</div>
                    <div style="font-size: 0.8rem; color: var(--text-muted);">${escapeHTML(host.domain)}</div>
                </div>
            `;
            div.onclick = () => {
                document.querySelectorAll('.master-item').forEach(el => el.classList.remove('selected'));
                div.classList.add('selected');
                selectedHostName = host.name;
                showHostDetail(host.name, host.domain, host.path.replace(/\\/g, '\\\\'), host.meta ? host.meta.size : 0, host.meta && host.meta.stack ? host.meta.stack.join(',') : '', host.meta && host.meta.sqliteDbs ? host.meta.sqliteDbs : []);
            };
            list.appendChild(div);

            // Keep whatever host the user had selected across auto-refreshes;
            // only default to the first host if nothing was selected yet, or
            // the previously selected host no longer exists in the list.
            if (host.name === selectedHostName) matchedIndex = index;
        });

        if (matchedIndex === -1) matchedIndex = 0;
        const items = list.children;
        if (items[matchedIndex]) items[matchedIndex].click();
    } catch (e) {
        console.error(e);
        document.getElementById('hosts-master-list').innerHTML = '<div style="padding:20px;text-align:center;color:red">Failed to load hosts.</div>';
    }
}

function showHostDetail(name, domain, hostPath, sizeBytes, stackStr, sqliteDbs = []) {
    document.getElementById('detail-host-name').innerText = name;
    const p = SYS_PORTS.caddy_http === 80 ? '' : `:${SYS_PORTS.caddy_http}`;
    document.getElementById('detail-host-url').innerText = `http://${domain}${p}`;
    document.getElementById('detail-host-url').href = `http://${domain}${p}`;
    document.getElementById('detail-host-path').innerText = hostPath;
    
    // Format Size
    const size = parseInt(sizeBytes) || 0;
    let sizeStr = size + ' B';
    if (size > 1024 * 1024 * 1024) sizeStr = (size / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    else if (size > 1024 * 1024) sizeStr = (size / (1024 * 1024)).toFixed(2) + ' MB';
    else if (size > 1024) sizeStr = (size / 1024).toFixed(2) + ' KB';
    document.getElementById('detail-host-size').innerText = sizeStr;
    
    // Format Stack Badges
    const stackDiv = document.getElementById('detail-host-stack');
    stackDiv.innerHTML = '';
    const stacks = stackStr ? stackStr.split(',') : [];
    if (stacks.length === 0) {
        stackDiv.innerHTML = '<span style="color:var(--text-muted);">Unknown</span>';
    } else {
        stacks.forEach(s => {
            let color = '#3b82f6'; // default blue
            if (s === 'Laravel') color = '#ef4444';
            if (s === 'WordPress') color = '#0ea5e9';
            if (s === 'Node.js') color = '#22c55e';
            if (s === 'Vue') color = '#10b981';
            if (s === 'React') color = '#61dafb';
            if (s === 'Tailwind CSS') color = '#38bdf8';
            if (s === 'PHP') color = '#777bb3';
            if (s === 'HTML/CSS') color = '#f97316';
            
            stackDiv.innerHTML += `<span style="background: ${color}20; color: ${color}; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;">${s}</span>`;
        });
    }

    document.getElementById('host-detail-view').style.display = 'block';
}

async function createHost() {
    const name = document.getElementById('new-host-name').value.trim();
    if (!name) return;
    
    try {
        const res = await fetch(`${API_BASE}/hosts/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        const data = await res.json();
        showToast(data.message, !data.success);
        if (data.success) {
            closeHostModal();
            fetchHosts();
        }
    } catch (e) {
        showToast('Error creating host', true);
    }
}

// Close modal on outside click
window.onclick = function(event) {
    if (event.target == document.getElementById('host-modal')) closeHostModal();
    if (event.target == document.getElementById('php-download-modal')) closePhpModal();
    if (event.target == document.getElementById('csr-modal')) closeCsrModal();
    if (event.target == document.getElementById('upload-cert-modal')) closeUploadModal();
}

// Init
// Performance Polling
let isFetchingPerformance = false;
async function fetchPerformance() {
    if (isFetchingPerformance) return;
    isFetchingPerformance = true;
    try {
        const res = await fetch(`${API_BASE}/performance`);
        const data = await res.json();
        
        ['caddy', 'php', 'mysql', 'postgres', 'mailpit'].forEach(service => {
            const label = document.getElementById(`perf-${service}`);
            const bar = document.getElementById(`perf-${service}-bar`);
            
            if (data.stats && data.stats[service]) {
                const cpu = data.stats[service].cpu;
                const memMb = (data.stats[service].memory / 1024 / 1024).toFixed(1);
                label.innerText = `${cpu.toFixed(1)}% CPU | ${memMb} MB`;
                label.style.color = 'var(--text-main)';
                
                // Visual width (max 100%)
                const cpuWidth = Math.min(cpu, 100);
                bar.style.width = `${cpuWidth}%`;
            } else {
                label.innerText = 'Offline';
                label.style.color = 'var(--text-muted)';
                bar.style.width = '0%';
            }
        });
    } catch (e) {
        console.error('Performance fetch failed:', e);
    } finally {
        isFetchingPerformance = false;
    }
}

// Init
setInterval(fetchStatus, 2000);
setInterval(fetchLogs, 2000);
setInterval(fetchPerformance, 2000);
setInterval(fetchHosts, 5000);

// Auto-updater UI. One check on load is enough - no need to hammer the
// update feed on a fast interval like the status/logs polling above.
let latestUpdateInfo = null;
async function checkForUpdates() {
    try {
        const res = await fetch(`${API_BASE}/update/check`);
        const data = await res.json();
        if (!data.configured || !data.updateAvailable) return;
        latestUpdateInfo = data;
        document.getElementById('update-banner-text').textContent =
            `JengaDev ${data.latestVersion} is available (you have ${data.currentVersion}).`;
        document.getElementById('update-banner').style.display = 'flex';
    } catch (e) { /* update feed unreachable - stay quiet, this isn't a user-facing error */ }
}

async function applyUpdate() {
    const btn = document.getElementById('btn-apply-update');
    btn.disabled = true;
    btn.textContent = 'Downloading & verifying...';
    try {
        const res = await fetch(`${API_BASE}/update/apply`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            document.getElementById('update-banner-text').textContent = data.message;
        } else {
            showToast(data.message, true);
            btn.disabled = false;
            btn.textContent = 'Download & Install';
        }
    } catch (e) {
        showToast('Update failed to start', true);
        btn.disabled = false;
        btn.textContent = 'Download & Install';
    }
}
document.getElementById('btn-apply-update').addEventListener('click', applyUpdate);
checkForUpdates();
setInterval(checkForUpdates, 6 * 60 * 60 * 1000);

async function installMysql() {
    const btn = document.getElementById('btn-install-mysql');
    if(btn) {
        btn.innerHTML = 'Downloading MySQL/MariaDB (200MB)...';
        btn.disabled = true;
    }
    showToast('Downloading MySQL binaries. This will take a while...', false);
    
    try {
        const res = await fetch(`${API_BASE}/mysql/install`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            showToast(data.message, false);
            if(btn) btn.style.display = 'none';
            document.getElementById('toggle-sidebar-mysql').disabled = false;
            performServiceAction('mysql', '/start');
        } else {
            showToast(data.message, true);
            if(btn) {
                btn.innerHTML = 'Install MySQL';
                btn.disabled = false;
            }
        }
    } catch(e) {
        showToast('Error installing MySQL', true);
        if(btn) {
            btn.innerHTML = 'Install MySQL';
            btn.disabled = false;
        }
    }
}

fetchStatus();
fetchLogs();
fetchPerformance();
fetchSslList();
loadPhpConfig();
loadMysqlConfig();
fetchMailpitConfig();
// Db users are now fetched dynamically when the service starts via updateStatusUI

// --- Database User Management ---
let currentDbEngine = '';
let currentGrantUser = '';

async function fetchDbUsers(engine) {
    try {
        const res = await fetch(`${API_BASE}/${engine}/users/list`);
        const data = await res.json();
        const list = document.getElementById(`${engine}-users-list`);
        if (!list) return false;
        
        // Always include default user
        const defaultUsername = engine === 'mysql' ? 'root' : 'postgres';
        let usersToRender = [{ User: defaultUsername }];
        
        if (data.success && data.users.length > 0) {
            // Merge custom users, avoiding duplicating the default user if the API returned it
            const customUsers = data.users.filter(u => u.User !== defaultUsername);
            usersToRender = usersToRender.concat(customUsers);
        }
        
        renderDbUsers(engine, usersToRender);
        
        return data.success; // Return actual success status for polling
    } catch(e) {
        console.error(e);
        return false;
    }
}

function renderDbUsers(engine, usersToRender) {
    const list = document.getElementById(`${engine}-users-list`);
    if (!list) return;
    
    list.innerHTML = '';
    
    if (!usersToRender || usersToRender.length === 0) {
        list.innerHTML = '<div style="color: var(--text-muted);">No users found</div>';
        return;
    }
    
    const defaultUsername = engine === 'mysql' ? 'root' : 'postgres';
    
    usersToRender.forEach(user => {
        const username = user.User || user.usename;
        const isProtected = [defaultUsername].includes(username);
        const defaultBadge = isProtected ? `<span style="font-size: 0.7rem; background: var(--primary); padding: 2px 6px; border-radius: 10px; color: white; margin-left: 10px;">Default</span>` : '';
        const div = document.createElement('div');
        div.style.cssText = 'background: var(--surface); padding: 12px; border-radius: 6px; border: 1px solid var(--border);';
        
        div.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <div>
                    <strong>${username}</strong>${defaultBadge}
                </div>
                <div style="display:flex; gap: 5px; flex-wrap: wrap;">
                    ${!isProtected ? `<button class="btn btn-secondary" style="padding: 5px 10px; font-size: 0.8rem;" onclick="document.getElementById('${engine}-grant-container-${username}').style.display = 'flex'">Privileges</button>` : ''}
                    <button class="btn btn-secondary" style="padding: 5px 10px; font-size: 0.8rem;" onclick="document.getElementById('${engine}-pwd-container-${username}').style.display = 'flex'">Change Password</button>
                    ${!isProtected ? `<button class="btn" style="padding: 5px 10px; font-size: 0.8rem; background: #ef4444; color: white;" onclick="deleteDbUser('${engine}', '${username}')">Delete</button>` : ''}
                </div>
            </div>
            ${!isProtected ? `
            <div id="${engine}-grant-container-${username}" style="display: none; margin-top: 10px; display: flex; gap: 5px;">
                <input type="text" list="${engine}-databases-list" id="${engine}-grant-input-${username}" class="input-text" placeholder="Database Name (e.g. myapp_db)" style="flex: 1; padding: 5px; font-size: 0.8rem;">
                <button class="btn btn-primary" style="padding: 5px 10px; font-size: 0.8rem;" onclick="grantDbAccessInline('${engine}', '${username}')">Grant</button>
            </div>
            ` : ''}
            <div id="${engine}-pwd-container-${username}" style="display: none; margin-top: 10px; display: flex; gap: 5px;">
                <input type="password" id="${engine}-pwd-input-${username}" class="input-text" placeholder="New Password" style="flex: 1; padding: 5px; font-size: 0.8rem;">
                <button class="btn btn-primary" style="padding: 5px 10px; font-size: 0.8rem;" onclick="changeDbPasswordInline('${engine}', '${username}')">Save</button>
            </div>
        `;
        list.appendChild(div);
    });
}

async function fetchDatabases() {
    for (const engine of ['mysql', 'postgres']) {
        try {
            const res = await fetch(`${API_BASE}/${engine}/databases/list`);
            const data = await res.json();
            const datalist = document.getElementById(`${engine}-databases-list`);
            if (datalist && data.success && data.databases) {
                datalist.innerHTML = data.databases.map(db => `<option value="${db}">`).join('');
            }
        } catch(e) { console.error(`Failed to fetch ${engine} databases:`, e); }
    }
}

async function browseSqlFile() {
    try {
        const res = await fetch(`${API_BASE}/dialog/open-file`);
        const data = await res.json();
        if (data.success && data.file) {
            document.getElementById('mysql-restore-file').value = data.file;
        }
    } catch(e) {
        showToast('Failed to open file browser', true);
    }
}

async function createDbUserInline(engine) {
    const usernameInput = document.getElementById(`${engine}-new-username`);
    const passwordInput = document.getElementById(`${engine}-new-password`);
    const username = usernameInput.value;
    const password = passwordInput.value;
    
    if (!username) return showToast('Username required', true);
    
    try {
        const res = await fetch(`${API_BASE}/${engine}/users/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        showToast(data.message, !data.success);
        if (data.success) {
            usernameInput.value = '';
            passwordInput.value = '';
            fetchDbUsers(engine);
        }
    } catch(e) {
        showToast('Error creating user', true);
    }
}

async function deleteDbUser(engine, username) {
    if (!confirm(`Are you sure you want to delete the user '${username}'?`)) return;
    try {
        const res = await fetch(`${API_BASE}/${engine}/users/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username })
        });
        const data = await res.json();
        showToast(data.message, !data.success);
        if (data.success) fetchDbUsers(engine);
    } catch(e) {
        showToast('Error deleting user', true);
    }
}

async function grantDbAccessInline(engine, username) {
    const dbInput = document.getElementById(`${engine}-grant-input-${username}`);
    const dbName = dbInput.value;
    
    if (!dbName) return showToast('Database Name required', true);
    
    try {
        const res = await fetch(`${API_BASE}/${engine}/users/grant`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, dbName })
        });
        const data = await res.json();
        showToast(data.message, !data.success);
        if (data.success) {
            document.getElementById(`${engine}-grant-container-${username}`).style.display = 'none';
            dbInput.value = '';
        }
    } catch(e) {
        showToast('Error granting privileges', true);
    }
}

async function changeDbPasswordInline(engine, username) {
    const passwordInput = document.getElementById(`${engine}-pwd-input-${username}`);
    const password = passwordInput.value;
    
    try {
        const res = await fetch(`${API_BASE}/${engine}/users/password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        showToast(data.message, !data.success);
        if (data.success) {
            document.getElementById(`${engine}-pwd-container-${username}`).style.display = 'none';
            passwordInput.value = '';
        }
    } catch(e) {
        showToast('Error changing password', true);
    }
}

// Attach to window onclick
const oldOnclick = window.onclick;
window.onclick = function(event) {
    if (oldOnclick) oldOnclick(event);
    if (event.target == document.getElementById('dbuser-modal')) closeDbUserModal();
    if (event.target == document.getElementById('grant-modal')) closeGrantModal();
    if (event.target == document.getElementById('password-modal')) closePasswordModal();
}

async function promptCreateSqlite() {
    const name = document.getElementById('detail-host-name').innerText;
    const dbName = prompt('Enter SQLite database name (e.g., database.sqlite):', 'database.sqlite');
    if (!dbName) return;
    
    showToast('Creating database...', false);
    try {
        const res = await fetch(`${API_BASE}/hosts/sqlite/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host: name, dbName })
        });
        const data = await res.json();
        if (data.success) {
            showToast('Database created successfully', false);
            setTimeout(loadHosts, 1000);
        } else {
            showToast(data.message || 'Failed to create database', true);
        }
    } catch(e) {
        showToast('Error creating database', true);
    }
}

async function openAdminerSqlite(dbPathEncoded) {
    showToast('Opening Adminer...', false);
    try {
        await fetch(`${API_BASE}/adminer/install`, { method: 'POST' });
        const p = SYS_PORTS.caddy_http === 80 ? '' : `:${SYS_PORTS.caddy_http}`;
        window.open(`http://adminer.jengadev${p}/?sqlite=&username=&db=${dbPathEncoded}`, '_blank');
    } catch(e) {
        showToast('Failed to install Adminer', true);
    }
}
