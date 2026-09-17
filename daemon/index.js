const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const { exec, execSync } = require('child_process');
const crypto = require('crypto');

const ProcessManager = require('./ProcessManager');
const HostsManager = require('./HostsManager');
const mysql = require('mysql2/promise');
const { Client: PgClient } = require('pg');
const pidusage = require('pidusage');
const forge = require('node-forge');
const AdmZip = require('adm-zip');
const app = express();
const port = 4000;

// Bump this alongside JengaDev_Offline.iss's OutputBaseFilename on every
// release - it's what /api/update/check compares against the update feed.
const APP_VERSION = '1.0.25';

// Under pkg, __dirname resolves inside the read-only virtual snapshot, not the
// real install directory next to the exe. Resolve every on-disk path (config,
// data, www, bin, logs, dashboard, Caddyfile, companion scripts) from the
// exe's real location instead; __dirname is still fine for require() calls.
const appRoot = process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '..');

// Setup paths
const binDir = path.join(appRoot, 'bin');
const wwwDir = path.join(appRoot, 'www');
const dataDir = path.join(appRoot, 'data');
const mysqlDataDir = path.join(dataDir, 'mysql');
const configDir = path.join(appRoot, 'config');
const sslDir = path.join(configDir, 'ssl');
const logsDir = path.join(appRoot, 'logs');

if (!fs.existsSync(configDir)) fs.mkdirSync(configDir);
if (!fs.existsSync(sslDir)) fs.mkdirSync(sslDir);
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);
const sslStatePath = path.join(configDir, 'ssl_state.json');

// Utilities
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}

// Every /api/*/install endpoint fetches a third-party zip/binary over HTTPS
// and extracts it straight into bin/ with no integrity check - HTTPS protects
// the wire, not a compromised upstream host or a swapped release asset. This
// streams a download to disk while hashing it, and refuses to keep the file
// (deleting it) if the hash doesn't match what was expected.
async function downloadWithChecksum(url, destPath, expectedSha256, extraHeaders) {
  const res = await fetch(url, extraHeaders ? { headers: extraHeaders } : undefined);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
  const { Readable, Transform } = require('stream');
  const { pipeline } = require('stream/promises');
  const hash = crypto.createHash('sha256');
  const hasher = new Transform({
    transform(chunk, enc, cb) { hash.update(chunk); cb(null, chunk); }
  });
  await pipeline(Readable.fromWeb(res.body), hasher, fs.createWriteStream(destPath));
  const actual = hash.digest('hex');
  if (expectedSha256 && actual.toLowerCase() !== expectedSha256.toLowerCase()) {
    try { fs.unlinkSync(destPath); } catch (e) {}
    throw new Error(`Checksum mismatch downloading ${path.basename(destPath)}: expected ${expectedSha256}, got ${actual}. Refusing to install a file that doesn't match what was expected - the download may have been tampered with, or the upstream file changed.`);
  }
  return actual;
}

// Config Helpers
const configPath = path.join(appRoot, 'jengadev.json');
const getConfig = () => {
  const defaults = {
    active_php: 'php',
    update_repo: 'mtaalamtech/jengadev',
    ports: { daemon: 4000, caddy_http: 80, caddy_https: 443, php: 9000, mysql: 3306, postgres: 5432, mailpit_smtp: 1025, mailpit_web: 8025 }
  };
  if (fs.existsSync(configPath)) {
    try { 
        const c = JSON.parse(fs.readFileSync(configPath, 'utf8')); 
        return { ...defaults, ...c, ports: { ...defaults.ports, ...(c.ports || {}) } };
    } catch (e) {}
  }
  return defaults;
};
const saveConfig = (config) => fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

// No update feed is configured yet by default - there's no public release
// feed to point at until one actually exists. Set "update_repo" in
// jengadev.json to "owner/repo" (a GitHub repo whose releases publish a
// JengaDev_Setup_Full_*.exe asset) once one does; until then /api/update/check
// just reports itself as unconfigured rather than pointing at a fake repo.
const getUpdateRepo = () => getConfig().update_repo || null;

function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/).map(n => parseInt(n, 10) || 0);
  const pb = String(b).split(/[.-]/).map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

// Postgres used to be initialized with `-A trust` (no password check at all,
// permanently, for any local connection). Generate a real password once and
// reuse it for every future initdb/connection instead.
function ensurePostgresPassword() {
  const config = getConfig();
  if (config.postgres_root_password) return config.postgres_root_password;
  const fresh = crypto.randomBytes(18).toString('base64').replace(/[^a-zA-Z0-9]/g, '');
  config.postgres_root_password = fresh;
  saveConfig(config);
  return fresh;
}

// Runs initdb with a real password instead of `-A trust`. The password file
// is written next to the config (never inside the target data directory -
// initdb expects that directory empty or absent) and removed immediately after.
function initPostgresDataDir(initDbExe, targetDataDir) {
  const pgPassword = ensurePostgresPassword();
  const pwFile = path.join(configDir, 'pg_initdb_pw.tmp');
  fs.writeFileSync(pwFile, pgPassword + '\n');
  try {
    execSync(`"${initDbExe}" -D "${targetDataDir}" -U postgres -A scram-sha-256 --pwfile="${pwFile}"`, { stdio: 'ignore' });
  } finally {
    try { fs.unlinkSync(pwFile); } catch (e) {}
  }
}

// The daemon's HTTP API had no authentication at all: binding to 127.0.0.1
// only stops remote network attackers, not another already-running process
// or another OS account on the same shared machine (loopback sockets aren't
// isolated per Windows user). Require a per-install token on every /api/*
// request instead. Generated once and persisted; restricted (best-effort) to
// the current user so another local account can't just read it off disk.
const tokenPath = path.join(configDir, 'daemon_token.txt');
function loadOrCreateDaemonToken() {
  try {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim();
    if (existing) return existing;
  } catch (e) {}
  const fresh = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(tokenPath, fresh);
  try {
    execSync(`icacls "${tokenPath}" /inheritance:r /grant:r "%USERNAME%:R" /grant:r "*S-1-5-32-544:F"`, { stdio: 'ignore' });
  } catch (e) {}
  return fresh;
}
const DAEMON_TOKEN = loadOrCreateDaemonToken();

const pm = new ProcessManager();

// Create data directory if not exists
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const hostsManager = new HostsManager(wwwDir);

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true); // Allow non-browser requests
    try {
      const url = new URL(origin);
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname.endsWith('.test') || url.hostname.endsWith('.jengadev')) {
        return callback(null, true);
      }
      return callback(new Error('Origin not allowed by CORS (Security)'));
    } catch(e) {
      return callback(new Error('Invalid Origin'));
    }
  }
}));
app.use(bodyParser.json());

// Serve the dashboard statically
app.use('/', express.static(path.join(appRoot, 'dashboard'), {
    setHeaders: (res, path) => {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
}));

// The static dashboard shell itself needs no auth (it's inert markup/JS with
// nothing sensitive in it), but every actual API call does - this is the
// control plane for spawning processes, databases and the filesystem.
app.use('/api', (req, res, next) => {
  const supplied = req.headers['x-jengadev-token'] || req.query.token;
  if (supplied === DAEMON_TOKEN) return next();
  res.status(401).json({ success: false, message: 'Missing or invalid daemon token. Reopen JengaDev from its app icon to get an authenticated session.' });
});

// Background Host Scanner
let hostMetaCache = {};

const scanHostMeta = async () => {
  if (!fs.existsSync(wwwDir)) return;
  const folders = fs.readdirSync(wwwDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
  
  for (const folder of folders) {
    const dir = path.join(wwwDir, folder);
    
    // 1. Get Stack
    const stack = [];
    const sqliteDbs = [];
    try {
      const files = await fs.promises.readdir(dir);
      const hasFile = (name) => files.includes(name);
      
      files.forEach(f => {
        if (f.endsWith('.sqlite') || f.endsWith('.sqlite3') || f.endsWith('.db')) sqliteDbs.push(f);
      });
      
      if (hasFile('artisan')) stack.push('Laravel');
      if (hasFile('wp-config.php') || hasFile('wp-config-sample.php') || hasFile('wp-includes')) stack.push('WordPress');
      
      let packageJsonPath = path.join(dir, 'package.json');
      if (!fs.existsSync(packageJsonPath)) {
          // Check one level deep
          const subdirs = files.filter(f => {
              try { return fs.statSync(path.join(dir, f)).isDirectory(); } catch(e) { return false; }
          });
          for (const sub of subdirs) {
              if (fs.existsSync(path.join(dir, sub, 'package.json'))) {
                  packageJsonPath = path.join(dir, sub, 'package.json');
                  break;
              }
          }
      }
      
      if (fs.existsSync(packageJsonPath)) {
        try {
          const pkg = JSON.parse(await fs.promises.readFile(packageJsonPath, 'utf8'));
          if (pkg.dependencies?.react || pkg.devDependencies?.react) stack.push('React');
          if (pkg.dependencies?.vue || pkg.devDependencies?.vue) stack.push('Vue');
          if (pkg.dependencies?.next || pkg.devDependencies?.next) stack.push('Next.js');
          if (pkg.dependencies?.nuxt || pkg.devDependencies?.nuxt) stack.push('Nuxt');
          if (pkg.dependencies?.svelte || pkg.devDependencies?.svelte) stack.push('Svelte');
          if (pkg.devDependencies?.tailwindcss || hasFile('tailwind.config.js')) stack.push('Tailwind');
          if (!stack.includes('React') && !stack.includes('Vue') && !stack.includes('Next.js') && !stack.includes('Nuxt') && !stack.includes('Svelte')) stack.push('Node.js');
        } catch(e) {}
      }
      
      if (!stack.includes('Laravel') && !stack.includes('WordPress') && files.some(f => f.endsWith('.php'))) {
        stack.push('PHP');
      }
      
      if (files.some(f => f.endsWith('.html') || f.endsWith('.css'))) {
        if (!stack.includes('React') && !stack.includes('Vue') && !stack.includes('Next.js')) {
            stack.push('HTML/CSS');
        }
      }
    } catch(e) {}

    // 2. Get Size (Sequential async to prevent descriptor exhaustion)
    const getDirSize = async (d) => {
      let size = 0;
      try {
        const items = await fs.promises.readdir(d, { withFileTypes: true });
        for (const item of items) {
          const p = path.join(d, item.name);
          if (item.isDirectory()) size += await getDirSize(p);
          else {
            const stat = await fs.promises.stat(p);
            size += stat.size;
          }
        }
      } catch(e) {}
      return size;
    };
    
    const sizeBytes = await getDirSize(dir);
    hostMetaCache[folder] = { size: sizeBytes, stack, sqliteDbs };
  }
};

// Initial scan and then every 30s
scanHostMeta();
setInterval(scanHostMeta, 30000);

// Hosts Sync endpoint
app.post('/api/hosts/sync', async (req, res) => {
  try {
    const result = await hostsManager.sync();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Hosts List endpoint
app.get('/api/hosts/list', (req, res) => {
  try {
    if (!fs.existsSync(wwwDir)) return res.json({ success: true, hosts: [] });
    const folders = fs.readdirSync(wwwDir).filter(f => fs.statSync(path.join(wwwDir, f)).isDirectory());
    res.json({ 
      success: true, 
      hosts: folders.map(f => ({ 
        name: f, 
        domain: f.includes('.') ? f : `${f}.test`, 
        path: path.join(wwwDir, f),
        meta: hostMetaCache[f] || { size: 0, stack: [] }
      })) 
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// SQLite Create endpoint
app.post('/api/hosts/sqlite/create', async (req, res) => {
  try {
    const { host, dbName } = req.body;
    if (!host || !dbName) return res.status(400).json({ success: false, message: 'Host and database name required' });
    if (!dbName.endsWith('.sqlite') && !dbName.endsWith('.db') && !dbName.endsWith('.sqlite3')) {
      return res.status(400).json({ success: false, message: 'Must end with .sqlite, .sqlite3, or .db' });
    }
    
    const dbPath = path.join(wwwDir, host, dbName);
    if (fs.existsSync(dbPath)) return res.status(400).json({ success: false, message: 'Database already exists' });
    
    fs.writeFileSync(dbPath, '');
    scanHostMeta(); // force quick update
    
    res.json({ success: true, message: 'Database created' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Host Delete endpoint
app.post('/api/hosts/delete', async (req, res) => {
  try {
    const { name, confirm } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Invalid host name' });
    // This is an irreversible recursive delete of a whole hosted project.
    // A single POST with just the name is too easy to trigger by accident
    // (a retried request, a naive script that found the endpoint, a stray
    // replay) - require the caller to also echo the exact host name back as
    // "confirm", the same way GitHub/AWS make you type a resource's name
    // before deleting it, instead of trusting a client-side confirm() alone.
    if (confirm !== name) {
      return res.status(400).json({ success: false, message: `Deleting '${name}' is permanent. Resend this request with "confirm": "${name}" to proceed.` });
    }

    const targetPath = path.resolve(path.join(wwwDir, name));
    if (!targetPath.startsWith(path.resolve(wwwDir)) || targetPath === path.resolve(wwwDir)) {
      return res.status(403).json({ success: false, message: 'Path Traversal detected' });
    }
    
    if (fs.existsSync(targetPath)) {
      fs.rmSync(targetPath, { recursive: true, force: true });
      await hostsManager.sync();
      delete hostMetaCache[name];
      res.json({ success: true, message: `Host ${name} deleted successfully` });
      
      setTimeout(() => {
        rebuildCaddyfile();
        if (pm.processes['caddy']) {
          pm.stop('caddy');
          setTimeout(() => {
            pm.start('caddy', path.join(binDir, 'caddy.exe'), ['run', '--config', path.join(appRoot, 'Caddyfile')], binDir);
          }, 1000);
        }
      }, 100);
    } else {
      res.status(404).json({ success: false, message: 'Host not found' });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Host Create endpoint
app.post('/api/hosts/create', async (req, res) => {
  try {
    let { name } = req.body;
    if (!name || typeof name !== 'string') return res.status(400).json({ success: false, message: 'Name is required' });
    if (!/^[a-zA-Z0-9_\-\.]+$/.test(name)) return res.status(400).json({ success: false, message: 'Invalid host name format' });
    
    let domain = name;
    if (!name.includes('.')) {
      domain = `${name}.test`;
    }
    
    const hostPath = path.join(wwwDir, name);
    
    // Create directory
    if (!fs.existsSync(hostPath)) {
      fs.mkdirSync(hostPath, { recursive: true });
      fs.writeFileSync(path.join(hostPath, 'index.php'), `<?php\n\n// Welcome to ${domain}\nphpinfo();\n`);
    }
    
    // Write to hosts manager
    await hostsManager.sync();
    scanHostMeta(); // force quick update so size/stack show up immediately

    res.json({ success: true, message: `Host ${domain} created` });
    
    setTimeout(() => {
      rebuildCaddyfile();
      if (pm.processes['caddy']) {
        pm.stop('caddy');
        setTimeout(() => {
          pm.start('caddy', path.join(binDir, 'caddy.exe'), ['run', '--config', path.join(appRoot, 'Caddyfile')], binDir);
        }, 1000);
      }
    }, 100);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Host Open Explorer
app.post('/api/hosts/open-explorer', (req, res) => {
  try {
    const { hostPath } = req.body;
    if (hostPath) {
      const normalizedPath = path.resolve(hostPath);
      if (!normalizedPath.startsWith(path.resolve(wwwDir))) return res.status(403).json({ success: false, message: 'Path Traversal detected' });
      
      require('child_process').spawn('explorer.exe', [normalizedPath], { detached: true, stdio: 'ignore', shell: false }).unref();
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Host Open With Editor
app.post('/api/hosts/open-editor', (req, res) => {
  try {
    const { hostPath, editor } = req.body; // editor could be 'code', 'cursor', 'phpstorm', 'other'
    if (hostPath && editor) {
      const normalizedPath = path.resolve(hostPath);
      if (!normalizedPath.startsWith(path.resolve(wwwDir))) return res.status(403).json({ success: false, message: 'Path Traversal detected' });
      
      const allowedEditors = ['code', 'code.cmd', 'cursor', 'phpstorm', 'subl', 'other'];
      if (!allowedEditors.includes(editor)) return res.status(400).json({ success: false, message: 'Invalid editor' });
      
      if (editor === 'other') {
          // Open Windows "Open With" dialog
          require('child_process').spawn('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', normalizedPath], { detached: true, stdio: 'ignore', shell: false }).unref();
      } else {
          // Launch specific editor in background
          const spawn = require('child_process').spawn;
          // For Windows, commands like 'code' are usually 'code.cmd'. shell: false might fail to find them without .cmd.
          // Using shell: false means we must resolve the executable. It's safer to use shell: true ONLY IF arguments are strictly sanitized, OR just use shell: false.
          // Actually, 'code' can be resolved if shell: true, but since we validated the editor to the whitelist and normalizedPath is sanitized, shell: true is OK here, but we will use shell: false and append .cmd if it fails.
          // Let's use shell: true but strictly sanitize normalizedPath to not contain '&' or '|' or '"'.
          if (/[&|";<>]/.test(normalizedPath)) return res.status(400).json({ success: false, message: 'Invalid characters in path' });
          spawn(editor, [`"${normalizedPath}"`], { detached: true, stdio: 'ignore', windowsHide: true, shell: true }).unref();
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Status endpoint
app.get('/api/status', (req, res) => {
  const status = {
    caddy: pm.statuses['caddy'] === 'running' ? 'running' : 'stopped',
    php: pm.statuses['php'] === 'running' ? 'running' : 'stopped',
    mysql: pm.statuses['mysql'] === 'running' ? 'running' : 'stopped',
    mailpit: pm.statuses['mailpit'] === 'running' ? 'running' : 'stopped',
    postgres: pm.statuses['postgres'] === 'running' ? 'running' : 'stopped',
    installed: {
        mysql: fs.existsSync(path.join(binDir, 'mysql', 'bin', 'mysqld.exe')),
        postgres: fs.existsSync(path.join(binDir, 'pgsql', 'bin', 'postgres.exe')),
        mailpit: fs.existsSync(path.join(binDir, 'mailpit', 'mailpit.exe'))
    },
    active_php: getConfig().active_php
  };
  res.json(status);
});

// Performance endpoint
app.get('/api/performance', async (req, res) => {
  try {
    const pids = pm.getPids();
    const activePids = Object.values(pids);
    if (activePids.length === 0) {
      return res.json({ success: true, stats: {} });
    }
    const stats = await pidusage(activePids);
    const result = {};
    for (const [name, pid] of Object.entries(pids)) {
      if (stats[pid]) {
        result[name] = {
          cpu: stats[pid].cpu, // percentage
          memory: stats[pid].memory // bytes
        };
      }
    }
    res.json({ success: true, stats: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// === PHP VERSION MANAGEMENT ===
let phpDownloadStatus = { isDownloading: false, progress: '' };

app.get('/api/php/versions', (req, res) => {
  try {
    const folders = fs.readdirSync(binDir).filter(f => f.startsWith('php'));
    const versions = folders.map(f => {
      const exePath = path.join(binDir, f, 'php-cgi.exe');
      if (!fs.existsSync(exePath)) return null;
      return { folder: f };
    }).filter(v => v !== null);
    res.json({ success: true, versions, active: getConfig().active_php });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/php/switch', (req, res) => {
  const { folder } = req.body;
  if (!fs.existsSync(path.join(binDir, folder, 'php-cgi.exe'))) {
    return res.status(400).json({ success: false, message: 'Invalid PHP version folder' });
  }
  const config = getConfig();
  config.active_php = folder;
  saveConfig(config);

  try { configurePhpLogging(path.join(binDir, folder, 'php.ini')); } catch (e) {}

  if (pm.processes['php']) {
    pm.stop('php');
    setTimeout(() => {
      const phpExe = path.join(binDir, folder, 'php-cgi.exe');
      const phpIni = path.join(binDir, folder, 'php.ini');
      const args = ['-b', '127.0.0.1:9000'];
      if (fs.existsSync(phpIni)) args.push('-c', phpIni);
      pm.start('php', phpExe, args, path.join(binDir, folder));
    }, 1000);
  }
  res.json({ success: true, message: `Switched to ${folder}` });
});

// The dashboard's PHP-version picker only ever offers these four - but the
// server was trusting whatever "url" the client sent back with no
// validation at all, so a direct API call (with a valid daemon token) could
// hand it ANY url, downloaded straight into bin/ and later run as php-cgi.exe
// via /api/php/switch. Pin the exact known-good URLs, each to the exact file
// it points at right now (sha256), and refuse anything that isn't one of them.
const KNOWN_PHP_BUILDS = {
  'https://windows.php.net/downloads/releases/archives/php-8.3.4-nts-Win32-vs16-x64.zip':
    { versionFolder: 'php-8.3.4', sha256: '79408281569f4c7faba23f415a281e0ae0bfbbfc16e72206e084ba2ef26e397a' },
  'https://windows.php.net/downloads/releases/archives/php-8.2.16-nts-Win32-vs16-x64.zip':
    { versionFolder: 'php-8.2.16', sha256: '251bd85ae5f753f35dfbe72ddd40d003b84387bd11f1c91b5f3c50d64132a715' },
  'https://windows.php.net/downloads/releases/archives/php-8.1.27-nts-Win32-vs16-x64.zip':
    { versionFolder: 'php-8.1.27', sha256: 'beda45964e30568f4f114c394c0bff7b7b16354b7be75ddfec506e0866c736fc' },
  'https://windows.php.net/downloads/releases/archives/php-7.4.33-nts-Win32-vc15-x64.zip':
    { versionFolder: 'php-7.4.33', sha256: '14ae3250d4447c8ccfc4c45a70d90adfbcd61e728d85f0be56a7ddf8f9c8aace' }
};

app.post('/api/php/download', (req, res) => {
  if (phpDownloadStatus.isDownloading) return res.status(400).json({ success: false, message: 'Download already in progress' });

  const { url, versionFolder } = req.body;
  const known = url && KNOWN_PHP_BUILDS[url];
  if (!known || known.versionFolder !== versionFolder) {
    return res.status(400).json({ success: false, message: 'Unknown PHP build - not one of the versions this dashboard offers' });
  }

  phpDownloadStatus = { isDownloading: true, progress: 'Starting download...' };
  res.json({ success: true, message: 'Download started' });

  const targetDir = path.join(binDir, versionFolder);
  const scriptPath = path.join(appRoot, 'daemon', 'install-php.ps1');
  const zipPath = path.join(binDir, `${versionFolder}_download.zip`);

  (async () => {
    try {
      phpDownloadStatus.progress = 'Downloading and verifying...';
      await downloadWithChecksum(url, zipPath, known.sha256);

      phpDownloadStatus.progress = 'Extracting...';
      const { spawn } = require('child_process');
      const ps = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-ZipPath', zipPath, '-TargetFolder', targetDir]);

      let output = '';
      ps.stdout.on('data', d => output += d.toString());
      ps.stderr.on('data', d => output += d.toString());

      ps.on('close', (code) => {
        try { fs.unlinkSync(zipPath); } catch (e) {}
        phpDownloadStatus.isDownloading = false;
        phpDownloadStatus.progress = code !== 0 ? `Error: ${output}` : 'Complete';
      });

      ps.on('error', (err) => {
        phpDownloadStatus.isDownloading = false;
        phpDownloadStatus.progress = `Error: ${err.message}`;
      });
    } catch (err) {
      phpDownloadStatus.isDownloading = false;
      phpDownloadStatus.progress = `Error: ${err.message}`;
    }
  })();
});

app.get('/api/php/download/status', (req, res) => {
  res.json(phpDownloadStatus);
});

// PHP Configuration API
app.get('/api/php/config', (req, res) => {
  try {
    const config = getConfig();
    const phpFolder = config.active_php || 'php';
    const phpIni = path.join(binDir, phpFolder, 'php.ini');
    if (!fs.existsSync(phpIni)) return res.json({ success: true, config: {}, extensions: {} });
    
    const content = fs.readFileSync(phpIni, 'utf-8');
    
    // Parse basic values
    const getValue = (key) => {
      const match = content.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`, 'm'));
      return match ? match[1] : '';
    };
    
    const settings = {
      memory_limit: getValue('memory_limit'),
      max_execution_time: getValue('max_execution_time'),
      upload_max_filesize: getValue('upload_max_filesize'),
      post_max_size: getValue('post_max_size')
    };
    
    // Parse extensions by reading the ext folder dynamically
    const extDir = path.join(binDir, phpFolder, 'ext');
    const extensions = {};
    if (fs.existsSync(extDir)) {
      const files = fs.readdirSync(extDir);
      files.forEach(file => {
        if (file.endsWith('.dll')) {
          let extName = file.replace('.dll', '');
          if (extName.startsWith('php_')) extName = extName.substring(4);
          const safeExt = escapeRegExp(extName);
          extensions[extName] = new RegExp(`^\\s*extension\\s*=\\s*${safeExt}\\s*$`, 'm').test(content) || new RegExp(`^\\s*zend_extension\\s*=\\s*${safeExt}\\s*$`, 'm').test(content);
        }
      });
    }
    
    res.json({ success: true, config: settings, extensions });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Install PHP Extension via PECL
app.post('/api/php/install-extension', async (req, res) => {
  try {
    const { extension } = req.body;
    if (!extension || !/^[a-zA-Z0-9_]+$/.test(extension)) return res.status(400).json({ success: false, message: 'Invalid extension name' });
    
    const sysConfig = getConfig();
    const phpFolder = sysConfig.active_php || 'php';
    const phpExtDir = path.join(binDir, phpFolder, 'ext');
    if (!fs.existsSync(phpExtDir)) fs.mkdirSync(phpExtDir, { recursive: true });
    
    const match = phpFolder.match(/php-(\d+\.\d+)\.\d+-(nts|ts)-Win32-(vs\d+)-(x64|x86)/i);
    if (!match) return res.status(400).json({ success: false, message: 'Could not parse active PHP version for PECL' });
    const [, phpVer, ts, vs, arch] = match;
    
    const fetchHtml = async (url) => {
        const r = await fetch(url);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.text();
    };

    const html = await fetchHtml(`https://windows.php.net/downloads/pecl/releases/${extension}/`);
    const versions = [...html.matchAll(/<a href="([0-9\.]+(?:RC\d+)?)\/">/ig)].map(m => m[1]);
    if (versions.length === 0) return res.status(404).json({ success: false, message: 'No versions found for extension' });
    versions.sort((a, b) => b.localeCompare(a, undefined, {numeric: true}));
    
    let targetZipUrl = null;
    for (const v of versions) {
        try {
            const vHtml = await fetchHtml(`https://windows.php.net/downloads/pecl/releases/${extension}/${v}/`);
            const zipRegex = new RegExp(`href="([^"]+-${phpVer}-${ts}-${vs}-${arch}\\.zip)"`, 'i');
            const zipMatch = vHtml.match(zipRegex);
            if (zipMatch) {
                targetZipUrl = `https://windows.php.net/downloads/pecl/releases/${extension}/${v}/${zipMatch[1]}`;
                break;
            }
        } catch (e) {}
    }
    
    if (!targetZipUrl) return res.status(404).json({ success: false, message: 'No compatible PECL zip found for this PHP version' });
    
    // Download zip to memory
    const rZip = await fetch(targetZipUrl);
    if (!rZip.ok) return res.status(500).json({ success: false, message: 'Failed to download zip' });
    const zipBuffer = Buffer.from(await rZip.arrayBuffer());
    const zip = new AdmZip(zipBuffer);
    const zipEntries = zip.getEntries();
    
    let dllFound = false;
    for (const entry of zipEntries) {
        if (entry.entryName.toLowerCase() === `php_${extension}.dll`) {
            fs.writeFileSync(path.join(phpExtDir, `php_${extension}.dll`), entry.getData());
            dllFound = true;
            break;
        }
    }
    
    if (!dllFound) return res.status(500).json({ success: false, message: 'Downloaded zip did not contain the DLL' });
    
    res.json({ success: true, message: `Extension ${extension} installed successfully` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/php/config', (req, res) => {
  try {
    const { config, extensions } = req.body;
    const sysConfig = getConfig();
    const phpFolder = sysConfig.active_php || 'php';
    const phpIni = path.join(binDir, phpFolder, 'php.ini');
    if (!fs.existsSync(phpIni)) return res.status(400).json({ success: false, message: 'php.ini not found' });
    
    let content = fs.readFileSync(phpIni, 'utf-8');
    
    // Update basic values
    // Keys and values are written into php.ini as raw, unquoted lines, so an
    // unvalidated key lets a caller set ANY directive, not just the four this
    // form exposes - e.g. "disable_functions" or "auto_prepend_file". A
    // charset-only check doesn't help: "disable_functions" is a perfectly
    // normal-looking key. Only accept the exact settings this endpoint is
    // meant to change, and strip any newline out of the value so it can
    // never smuggle in a second directive on its own line.
    const PHP_ALLOWED_KEYS = new Set(['memory_limit', 'max_execution_time', 'upload_max_filesize', 'post_max_size']);
    if (config) {
      for (const [key, val] of Object.entries(config)) {
        if (!val || !PHP_ALLOWED_KEYS.has(key)) continue;
        const safeVal = String(val).replace(/[\r\n]/g, '');
        const safeKey = escapeRegExp(key);
        // Leading whitespace must stop at space/tab, not \s (which includes \r
        // and \n) - JS treats \r and \n as independent line terminators in
        // multiline mode, so a leading \s* can anchor mid-CRLF and swallow the
        // previous line's newline, merging two lines together on write.
        const regex = new RegExp(`^[ \\t]*;?[ \\t]*${safeKey}[ \\t]*=.*$`, 'm');
        if (regex.test(content)) {
          content = content.replace(regex, `${key} = ${safeVal}`);
        } else {
          content += `\r\n${key} = ${safeVal}`;
        }
      }
    }

    // Update extensions
    // The extension name doubles as the value of "extension=" / "zend_extension=",
    // which PHP will load as a native DLL path if given one - so this same
    // allowlist also blocks an absolute path like "C:\Users\Public\evil.dll"
    // (it contains characters the regex rejects).
    const PHP_EXT_RE = /^[a-zA-Z0-9_.-]+$/;
    if (extensions) {
      for (const [ext, enabled] of Object.entries(extensions)) {
        if (!PHP_EXT_RE.test(ext)) continue;
        const safeExt = escapeRegExp(ext);
        // Same leading-whitespace fix as the config loop above - [ \t]*, never \s*.
        const regexExt = new RegExp(`^[ \\t]*;?[ \\t]*extension[ \\t]*=[ \\t]*${safeExt}[ \\t]*$`, 'm');
        const regexZend = new RegExp(`^[ \\t]*;?[ \\t]*zend_extension[ \\t]*=[ \\t]*${safeExt}[ \\t]*$`, 'm');
        
        let found = false;
        if (regexExt.test(content)) {
          content = content.replace(regexExt, enabled ? `extension=${ext}` : `;extension=${ext}`);
          found = true;
        }
        if (regexZend.test(content)) {
          content = content.replace(regexZend, enabled ? `zend_extension=${ext}` : `;zend_extension=${ext}`);
          found = true;
        }
        
        if (!found && enabled) {
          // Default to regular extension if not found
          content += `\r\nextension=${ext}`;
        }
      }
    }
    
    fs.writeFileSync(phpIni, content);
    
    // Restart PHP if running
    if (pm.processes['php']) {
      pm.stop('php');
      setTimeout(() => {
        const phpExe = path.join(binDir, phpFolder, 'php-cgi.exe');
        const args = ['-b', '127.0.0.1:9000', '-c', phpIni];
        const env = Object.assign({}, process.env, { PHP_FCGI_MAX_REQUESTS: '0' });
        pm.start('php', phpExe, args, path.join(binDir, phpFolder), env);
      }, 1000);
    }
    
    res.json({ success: true, message: 'PHP Configuration saved' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
// ==============================

// Mailpit Integration
app.get('/api/mailpit/config', (req, res) => {
    const config = getConfig();
    res.json(config.mailpit || { smtp_port: 1025, web_port: 8025, auth_user: '', auth_pass: '' });
});

app.post('/api/mailpit/config', (req, res) => {
    const config = getConfig();
    config.mailpit = req.body;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
    
    if (pm.processes['mailpit']) {
        pm.stop('mailpit');
        setTimeout(() => {
            const mailpitExe = path.join(binDir, 'mailpit', 'mailpit.exe');
            const smtpPort = config.mailpit.smtp_port || 1025;
            const webPort = config.mailpit.web_port || 8025;
            const args = ['--smtp', `127.0.0.1:${smtpPort}`, '--listen', `127.0.0.1:${webPort}`];
            if (config.mailpit.auth_user && config.mailpit.auth_pass) {
                const authFile = path.join(appRoot, 'config', 'mailpit_auth.txt');
                fs.writeFileSync(authFile, `${config.mailpit.auth_user}:${config.mailpit.auth_pass}\n`);
                args.push('--smtp-auth-file', authFile);
                args.push('--smtp-auth-allow-insecure');
            }
            pm.start('mailpit', mailpitExe, args, path.join(binDir, 'mailpit'));
        }, 1000);
    }
    
    // Rebuild Caddyfile so mailpit.jengadev reflects the new port
    rebuildCaddyfile();
    if (pm.processes['caddy']) {
        pm.stop('caddy');
        setTimeout(() => {
            pm.start('caddy', path.join(binDir, 'caddy', 'caddy.exe'), ['run', '--config', path.join(appRoot, 'Caddyfile')], path.join(binDir, 'caddy'));
        }, 1000);
    }
    
    res.json({ success: true, message: 'Mailpit configuration saved' });
});

// Pinned to the exact file each fixed URl below currently serves - computed
// once (sha256) and checked on every download. If that upstream file ever
// legitimately changes, this hash needs updating alongside the URL/version.
const PINNED_DOWNLOAD_HASHES = {
    'postgresql-16.2-1-windows-x64-binaries.zip': 'c510b3058c161479bfbe0aeac878ca682b344fd9385c58a359690147a4ca1a6c',
    'mariadb-11.2.2-winx64.zip': '7d40de0c468cf33b5e8283e6f67d315aeae6ffa8df052b8d20a9b5943598d35e',
    'phpMyAdmin-5.2.1-english.zip': '6cdc52d0b42ecdecfef702e004a1695334ded7c730cd14f37f6804063014bac9'
};

app.post('/api/postgres/install', async (req, res) => {
    try {
        const pgDir = path.join(binDir, 'pgsql');

        const zipUrl = 'https://get.enterprisedb.com/postgresql/postgresql-16.2-1-windows-x64-binaries.zip';
        const zipPath = path.join(binDir, 'pgsql.zip');
        await downloadWithChecksum(zipUrl, zipPath, PINNED_DOWNLOAD_HASHES['postgresql-16.2-1-windows-x64-binaries.zip']);

        const zip = new AdmZip(zipPath);
        zip.extractAllTo(binDir, true);
        
        fs.unlinkSync(zipPath);
        
        const dataDir = path.join(appRoot, 'data', 'postgres');
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        
        const initDb = path.join(pgDir, 'bin', 'initdb.exe');
        if (fs.existsSync(initDb)) {
            initPostgresDataDir(initDb, dataDir);
        }
        
        res.json({ success: true, message: 'PostgreSQL installed successfully' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/mysql/install', async (req, res) => {
    try {
        const mysqlDir = path.join(binDir, 'mysql');
        if (fs.existsSync(mysqlDir)) return res.json({ success: true, message: 'MySQL is already installed' });

        const zipUrl = 'https://archive.mariadb.org/mariadb-11.2.2/winx64-packages/mariadb-11.2.2-winx64.zip';
        const zipPath = path.join(binDir, 'mariadb.zip');
        await downloadWithChecksum(zipUrl, zipPath, PINNED_DOWNLOAD_HASHES['mariadb-11.2.2-winx64.zip']);

        const zip = new AdmZip(zipPath);
        zip.extractAllTo(binDir, true);
        fs.unlinkSync(zipPath);

        const extractedDir = path.join(binDir, 'mariadb-11.2.2-winx64');
        if (fs.existsSync(extractedDir)) {
            fs.renameSync(extractedDir, mysqlDir);
        }

        // Download phpMyAdmin
        const pmaUrl = 'https://files.phpmyadmin.net/phpMyAdmin/5.2.1/phpMyAdmin-5.2.1-english.zip';
        const pmaZipPath = path.join(binDir, 'phpmyadmin.zip');
        try {
            await downloadWithChecksum(pmaUrl, pmaZipPath, PINNED_DOWNLOAD_HASHES['phpMyAdmin-5.2.1-english.zip']);

            const pmaZip = new AdmZip(pmaZipPath);
            pmaZip.extractAllTo(binDir, true);
            fs.unlinkSync(pmaZipPath);
            
            const pmaExtractedDir = path.join(binDir, 'phpMyAdmin-5.2.1-english');
            if (fs.existsSync(pmaExtractedDir)) {
                const finalPmaDir = path.join(binDir, 'phpmyadmin');
                fs.renameSync(pmaExtractedDir, finalPmaDir);
                
                const pmaConfig = `<?php
$cfg['blowfish_secret'] = '${require('crypto').randomBytes(16).toString('hex')}';
$i = 1;
$cfg['Servers'][$i]['auth_type'] = 'cookie';
$cfg['Servers'][$i]['host'] = '127.0.0.1';
$cfg['Servers'][$i]['compress'] = false;
$cfg['Servers'][$i]['AllowNoPassword'] = true;
$cfg['UploadDir'] = '';
$cfg['SaveDir'] = '';
`;
                fs.writeFileSync(path.join(finalPmaDir, 'config.inc.php'), pmaConfig);
            }
        } catch (pmaErr) {
            // phpMyAdmin is a bonus add-on here, not the point of this endpoint -
            // MariaDB itself already installed successfully above, so a failed
            // (or checksum-rejected) phpMyAdmin download shouldn't fail the whole call.
            console.error('phpMyAdmin install skipped:', pmaErr.message);
        }

        res.json({ success: true, message: 'MariaDB and phpMyAdmin installed successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/adminer/install', async (req, res) => {
    try {
        const adminerDir = path.join(binDir, 'adminer');
        if (!fs.existsSync(adminerDir)) fs.mkdirSync(adminerDir, { recursive: true });
        
        const ghRes = await fetch('https://api.github.com/repos/vrana/adminer/releases/latest', {
            headers: { 'User-Agent': 'JengaDev' }
        });
        if (!ghRes.ok) return res.status(500).json({ success: false, message: 'Failed to fetch Adminer from GitHub' });
        
        const ghJson = await ghRes.json();
        const asset = ghJson.assets.find(a => a.name.endsWith('.php') && !a.name.includes('-')); // get plain adminer-x.x.x.php
        // wait, the asset name is adminer-5.5.1.php. Let's just find the one that ends with .php and has no other hyphens, or just the first .php
        const phpAsset = ghJson.assets.find(a => a.name.match(/^adminer-\d+\.\d+\.\d+\.php$/));
        if (!phpAsset) return res.status(404).json({ success: false, message: 'Adminer PHP file not found in latest release' });

        // Unlike the fixed-URL downloads above, "latest release" is a moving
        // target - there's no fixed file to pin a hash for ahead of time. GitHub
        // itself computes and returns a sha256 digest for each release asset in
        // this same API response, so verify against that instead.
        const expectedHash = (phpAsset.digest || '').replace(/^sha256:/, '') || null;
        await downloadWithChecksum(phpAsset.browser_download_url, path.join(adminerDir, 'index.php'), expectedHash);

        res.json({ success: true, message: 'Adminer installed successfully' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/mailpit/install', async (req, res) => {
    try {
        const mailpitDir = path.join(binDir, 'mailpit');
        if (!fs.existsSync(mailpitDir)) fs.mkdirSync(mailpitDir, { recursive: true });
        
        const ghRes = await fetch('https://api.github.com/repos/axllent/mailpit/releases/latest', {
            headers: { 'User-Agent': 'JengaDev' }
        });
        if (!ghRes.ok) return res.status(500).json({ success: false, message: 'Failed to fetch GitHub releases' });
        
        const ghJson = await ghRes.json();
        const asset = ghJson.assets.find(a => a.name.includes('windows_amd64') || a.name.includes('windows-amd64'));
        if (!asset) return res.status(404).json({ success: false, message: 'Could not find Windows amd64 build for Mailpit' });

        // Same reasoning as Adminer above: verify against GitHub's own digest
        // for this specific asset rather than a hash pinned ahead of time.
        const expectedHash = (asset.digest || '').replace(/^sha256:/, '') || null;
        const zipPath = path.join(binDir, 'mailpit_download.zip');
        await downloadWithChecksum(asset.browser_download_url, zipPath, expectedHash);

        const zip = new AdmZip(zipPath);
        zip.extractAllTo(mailpitDir, true);
        fs.unlinkSync(zipPath);

        res.json({ success: true, message: 'Mailpit installed successfully' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Auto-updater. Checks a GitHub Releases feed (configured via update_repo in
// jengadev.json, e.g. "someuser/jengadev") for a newer JengaDev_Setup_Full_*.exe
// asset. Never applies anything without an explicit call to /api/update/apply -
// there's no silent unattended self-update path, and that endpoint's own
// installer launch still shows the normal UAC prompt + wizard.
app.get('/api/update/check', async (req, res) => {
    const repo = getUpdateRepo();
    if (!repo) return res.json({ success: true, configured: false, currentVersion: APP_VERSION, updateAvailable: false });
    try {
        const ghRes = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
            headers: { 'User-Agent': 'JengaDev' }
        });
        if (!ghRes.ok) {
            return res.json({ success: true, configured: true, currentVersion: APP_VERSION, updateAvailable: false, message: `Update feed returned HTTP ${ghRes.status}` });
        }
        const rel = await ghRes.json();
        const latestVersion = (rel.tag_name || '').replace(/^v/i, '');
        const asset = (rel.assets || []).find(a => /\.exe$/i.test(a.name));
        res.json({
            success: true,
            configured: true,
            currentVersion: APP_VERSION,
            latestVersion,
            updateAvailable: latestVersion ? compareVersions(latestVersion, APP_VERSION) > 0 : false,
            releaseNotesUrl: rel.html_url,
            assetName: asset ? asset.name : null
        });
    } catch (err) {
        res.json({ success: true, configured: true, currentVersion: APP_VERSION, updateAvailable: false, message: 'Update check failed: ' + err.message });
    }
});

app.post('/api/update/apply', async (req, res) => {
    try {
        const repo = getUpdateRepo();
        if (!repo) return res.status(400).json({ success: false, message: 'No update feed configured' });

        const ghRes = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
            headers: { 'User-Agent': 'JengaDev' }
        });
        if (!ghRes.ok) return res.status(500).json({ success: false, message: 'Could not reach the update feed' });

        const rel = await ghRes.json();
        const asset = (rel.assets || []).find(a => /\.exe$/i.test(a.name));
        if (!asset) return res.status(404).json({ success: false, message: 'No installer asset found in the latest release' });

        const expectedHash = (asset.digest || '').replace(/^sha256:/, '') || null;
        const installerPath = path.join(require('os').tmpdir(), asset.name);
        await downloadWithChecksum(asset.browser_download_url, installerPath, expectedHash);

        res.json({ success: true, message: 'Update verified. Launching the installer - JengaDev will restart shortly.' });

        // Hand off to the new installer - same UAC prompt + wizard as a manual
        // download, never a silent replace - then gracefully stop everything on
        // our side so its own upgrade flow can overwrite files cleanly.
        exec(`"${installerPath}"`);
        setTimeout(() => {
            fetch(`http://127.0.0.1:${daemonPort}/api/quit`, { method: 'POST', headers: { 'X-JengaDev-Token': DAEMON_TOKEN } }).catch(() => {});
        }, 1500);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Start service
app.post('/api/start', async (req, res) => {
  const { service } = req.body;
  if (!service) return res.status(400).json({ error: 'Service name required' });

  if (service === 'caddy') {
    const caddyExe = path.join(binDir, 'caddy.exe');
    const caddyfile = path.join(appRoot, 'Caddyfile');
    if (!fs.existsSync(caddyExe)) {
      return res.status(400).json({ success: false, message: 'Caddy executable not found in bin/' });
    }
    const result = pm.start('caddy', caddyExe, ['run', '--config', caddyfile], binDir);
    // When starting Caddy, sync hosts automatically
    hostsManager.sync().catch(console.error);
    return res.json(result);
  }

  if (service === 'mailpit') {
    const mailpitExe = path.join(binDir, 'mailpit', 'mailpit.exe');
    if (!fs.existsSync(mailpitExe)) {
        return res.status(400).json({ success: false, message: 'Mailpit not installed' });
    }
    const config = getConfig().mailpit || {};
    const smtpPort = config.smtp_port || 1025;
    const webPort = config.web_port || 8025;
    const args = ['--smtp', `127.0.0.1:${smtpPort}`, '--listen', `127.0.0.1:${webPort}`];
    
    if (config.auth_user && config.auth_pass) {
        const authFile = path.join(appRoot, 'config', 'mailpit_auth.txt');
        fs.writeFileSync(authFile, `${config.auth_user}:${config.auth_pass}\n`);
        args.push('--smtp-auth-file', authFile);
        args.push('--smtp-auth-allow-insecure');
    }
    return res.json(pm.start('mailpit', mailpitExe, args, path.join(binDir, 'mailpit')));
  }

  if (service === 'postgres') {
    const pgExe = path.join(binDir, 'pgsql', 'bin', 'pg_ctl.exe');
    if (!fs.existsSync(pgExe)) {
        return res.status(400).json({ success: false, message: 'Postgres not installed' });
    }
    
    const pgDataDir = path.join(appRoot, 'data', 'postgres');
    if (!fs.existsSync(pgDataDir)) fs.mkdirSync(pgDataDir, { recursive: true });

    // A postmaster.pid left behind by an unclean stop blocks pg_ctl start with
    // "lock file already exists" even when the real process is long gone. Check
    // whether the PID it names is actually a live postgres.exe before trusting it.
    const pgLockFile = path.join(pgDataDir, 'postmaster.pid');
    if (fs.existsSync(pgLockFile)) {
        let recordedPid = null;
        try { recordedPid = parseInt(fs.readFileSync(pgLockFile, 'utf8').split('\n')[0].trim(), 10); } catch (e) {}
        let alive = false;
        if (recordedPid) {
            try {
                const out = execSync(`tasklist /FI "PID eq ${recordedPid}" /FI "IMAGENAME eq postgres.exe"`, { encoding: 'utf8' });
                alive = out.toLowerCase().includes('postgres.exe');
            } catch (e) {}
        }
        if (!alive) {
            try {
                fs.unlinkSync(pgLockFile);
                pm.addLog('postgres', '[SYSTEM] Removed stale postmaster.pid left by an unclean stop');
            } catch (e) {}
        } else {
            // Genuinely already running (e.g. our own tracking lost track of it) - don't
            // error out, just resync status so the dashboard reflects reality.
            pm.statuses['postgres'] = 'running';
            pm.addLog('postgres', '[SYSTEM] postgres already running outside daemon tracking; status resynced');
            return res.json({ success: true, message: 'postgres was already running' });
        }
    }

    const isEmpty = fs.readdirSync(pgDataDir).length === 0;
    if (isEmpty) {
        pm.addLog('postgres', '[SYSTEM] Initializing PostgreSQL data directory...');
        const initDbExe = path.join(binDir, 'pgsql', 'bin', 'initdb.exe');
        if (fs.existsSync(initDbExe)) {
            try {
                initPostgresDataDir(initDbExe, pgDataDir);
            } catch(e) {
                pm.addLog('postgres', '[SYSTEM] Failed to initialize: ' + e.message);
                return res.status(500).json({ success: false, message: 'Failed to initialize postgres datadir' });
            }
        }
    }

    const wrapperScript = path.join(appRoot, 'daemon', 'postgres-wrapper.js');
    const env = Object.assign({}, process.env, { PGPORT: getConfig().ports.postgres.toString() });
    // process.execPath is JengaDev.exe itself under pkg, not a generic node binary,
    // so it can't be handed an arbitrary script to run. Use the bundled real node.exe.
    const nodeExe = process.pkg ? path.join(appRoot, 'bin', 'node', 'node.exe') : process.execPath;
    return res.json(pm.start('postgres', nodeExe, [wrapperScript], path.join(appRoot, 'daemon'), env));
  }

  if (service === 'php') {
    const config = getConfig();
    const phpFolder = config.active_php || 'php';
    const phpExe = path.join(binDir, phpFolder, 'php-cgi.exe');
    const phpIni = path.join(binDir, phpFolder, 'php.ini');
    if (!fs.existsSync(phpExe)) return res.status(400).json({ success: false, message: 'php-cgi.exe not found' });
    
    const args = ['-b', `127.0.0.1:${config.ports.php}`];
    if (fs.existsSync(phpIni)) {
      args.push('-c', phpIni);
    }
    
    // Set PHP_FCGI_MAX_REQUESTS for stability
    const env = Object.assign({}, process.env, { PHP_FCGI_MAX_REQUESTS: '0' });
    
    return res.json(pm.start('php', phpExe, args, path.join(binDir, phpFolder), env));
  }

  if (service === 'mysql') {
    let mysqlBin = path.join(binDir, 'mysql', 'bin');
    if (!fs.existsSync(path.join(mysqlBin, 'mysqld.exe'))) {
        mysqlBin = path.join(binDir, 'mysql'); // Fallback if flat extraction
    }
    const mysqldExe = path.join(mysqlBin, 'mysqld.exe');
    const mysqlInstallDbExe = path.join(mysqlBin, 'mysql_install_db.exe');
    
    if (!fs.existsSync(mysqldExe)) {
      return res.status(400).json({ success: false, message: `MariaDB not found at ${mysqldExe}` });
    }

    // Initialize datadir if empty
    if (!fs.existsSync(mysqlDataDir)) fs.mkdirSync(mysqlDataDir, { recursive: true });
    const isEmpty = fs.readdirSync(mysqlDataDir).length === 0;
    if (isEmpty) {
      try {
        pm.addLog('mysql', '[SYSTEM] Initializing MariaDB data directory...');
        const { exec } = require('child_process');
        const util = require('util');
        const execPromise = util.promisify(exec);
        await execPromise(`"${mysqlInstallDbExe}" --datadir="${mysqlDataDir}"`);
      } catch (err) {
        return res.status(500).json({ success: false, message: 'Failed to initialize database datadir' });
      }
    }

    const config = getConfig();
    const args = ['--datadir=' + mysqlDataDir, '--console', `--port=${config.ports.mysql}`];
    const myIni = path.join(mysqlBin, 'my.ini');
    if (fs.existsSync(myIni)) {
        args.unshift(`--defaults-file=${myIni}`);
    }

    const result = pm.start('mysql', mysqldExe, args, mysqlBin);
    return res.json(result);
  }

  res.status(400).json({ success: false, message: 'Unknown service' });
});

// Stop service
app.post('/api/stop', (req, res) => {
  const { service } = req.body;
  if (!service) return res.status(400).json({ error: 'Service name required' });
  
  if (service === 'mysql') {
     // MySQL shutdown
     let mysqlBin = path.join(binDir, 'mysql', 'bin');
     if (!fs.existsSync(path.join(mysqlBin, 'mysqladmin.exe'))) {
         mysqlBin = path.join(binDir, 'mysql');
     }
     const mysqlAdminExe = path.join(mysqlBin, 'mysqladmin.exe');
     if (fs.existsSync(mysqlAdminExe) && pm.getStatus()['mysql'] === 'running') {
         try {
            execSync(`"${mysqlAdminExe}" -u root shutdown`, { stdio: 'ignore' });
            pm.addLog('mysql', '[SYSTEM] Sent graceful shutdown to MySQL');
            return res.json({ success: true, message: 'MySQL stopped gracefully' });
         } catch(e) {}
     }
  }

  const result = pm.stop(service);
  res.json(result);
});

// Quit Daemon
app.post('/api/quit', (req, res) => {
  // Graceful MySQL shutdown
  let mysqlBin = path.join(binDir, 'mysql', 'bin');
  if (!fs.existsSync(path.join(mysqlBin, 'mysqladmin.exe'))) {
      mysqlBin = path.join(binDir, 'mysql');
  }
  const mysqlAdminExe = path.join(mysqlBin, 'mysqladmin.exe');
  if (fs.existsSync(mysqlAdminExe) && pm.processes['mysql']) {
      try { execSync(`"${mysqlAdminExe}" -u root shutdown`, { stdio: 'ignore', timeout: 3000 }); } catch(e) {}
  }

  // Try graceful stops first
  const active = ['caddy', 'php', 'mysql', 'postgres', 'mailpit'];
  for (const svc of active) {
      try { pm.stop(svc); } catch(e) {}
  }

  // Absolutely guarantee everything is dead
  const exes = ['caddy.exe', 'php-cgi.exe', 'mysqld.exe', 'postgres.exe', 'mailpit.exe'];
  for (const exe of exes) {
      try {
          const { execSync } = require('child_process');
          execSync(`taskkill /IM ${exe} /F /T`, { stdio: 'ignore' });
      } catch(e) {}
  }
  
  res.json({ success: true, message: 'Shut down complete.' });
  
  setTimeout(() => {
    process.exit(0);
  }, 500);
});

// Get logs
app.get('/api/logs/:service', (req, res) => {
  const { service } = req.params;
  res.json(pm.getLogs(service));
});


// Database Manager API
const getDbConnection = async () => {
    const config = getConfig();
    return await mysql.createConnection({
        host: '127.0.0.1',
        user: 'root',
        password: config.mysql_root_password || ''
    });
};

const getPgConnection = async () => {
    const config = getConfig();
    const client = new PgClient({
        user: 'postgres',
        host: '127.0.0.1',
        database: 'postgres',
        password: config.postgres_root_password || '',
        port: 5432
    });
    await client.connect();
    return client;
};

// --- MySQL User Management APIs ---
app.get('/api/mysql/users/list', async (req, res) => {
    try {
        const conn = await getDbConnection();
        const [rows] = await conn.query("SELECT DISTINCT User FROM mysql.user WHERE User NOT IN ('mysql.sys', 'mysql.session', 'mysql.infoschema', 'mariadb.sys')");
        await conn.end();
        res.json({ success: true, users: rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/mysql/databases/list', async (req, res) => {
    try {
        const conn = await getDbConnection();
        const [rows] = await conn.query("SHOW DATABASES");
        await conn.end();
        const dbs = rows.map(r => r.Database).filter(db => !['information_schema', 'mysql', 'performance_schema', 'sys'].includes(db));
        res.json({ success: true, databases: dbs });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/mysql/users/create', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ success: false, message: 'Invalid username' });
        
        const conn = await getDbConnection();
        await conn.query(`CREATE USER '${username}'@'localhost' IDENTIFIED BY ?`, [password || '']);
        await conn.end();
        res.json({ success: true, message: `User ${username} created` });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/mysql/users/delete', async (req, res) => {
    try {
        const { username } = req.body;
        if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ success: false, message: 'Invalid username' });
        if (username === 'root') return res.status(400).json({ success: false, message: 'Cannot delete the default root user' });
        
        const conn = await getDbConnection();
        await conn.query(`DROP USER '${username}'@'localhost'`);
        await conn.end();
        res.json({ success: true, message: `User ${username} deleted` });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/mysql/users/password', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ success: false, message: 'Invalid username' });
        
        const conn = await getDbConnection();
        await conn.query(`ALTER USER '${username}'@'localhost' IDENTIFIED BY ?`, [password || '']);
        await conn.end();
        
        if (username === 'root') {
            const config = getConfig();
            config.mysql_root_password = password || '';
            saveConfig(config);
        }
        
        res.json({ success: true, message: `Password updated for ${username}` });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/mysql/users/grant', async (req, res) => {
    try {
        const { username, dbName } = req.body;
        if (!/^[a-zA-Z0-9_]+$/.test(username) || !/^[a-zA-Z0-9_]+$/.test(dbName)) return res.status(400).json({ success: false, message: 'Invalid input' });
        
        const conn = await getDbConnection();
        await conn.query(`GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${username}'@'localhost'`);
        await conn.query("FLUSH PRIVILEGES");
        await conn.end();
        res.json({ success: true, message: `Granted access to ${dbName} for ${username}` });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// --- Postgres User Management APIs ---

app.get('/api/postgres/databases/list', async (req, res) => {
    try {
        const client = await getPgConnection();
        const result = await client.query("SELECT datname FROM pg_database WHERE datistemplate = false");
        await client.end();
        res.json({ success: true, databases: result.rows.map(r => r.datname) });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/postgres/users/list', async (req, res) => {
    try {
        const client = await getPgConnection();
        const result = await client.query("SELECT usename FROM pg_user WHERE usename NOT IN ('pg_signal_backend')");
        await client.end();
        res.json({ success: true, users: result.rows.map(r => ({ User: r.usename })) });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/postgres/users/create', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ success: false, message: 'Invalid username' });
        
        const client = await getPgConnection();
        // parameterizing identifiers is not supported in pg, so we strictly validate with regex
        await client.query(`CREATE USER "${username}" WITH PASSWORD '${password.replace(/'/g, "''")}'`);
        await client.end();
        res.json({ success: true, message: `User ${username} created` });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/postgres/users/delete', async (req, res) => {
    try {
        const { username } = req.body;
        if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ success: false, message: 'Invalid username' });
        if (username === 'postgres') return res.status(400).json({ success: false, message: 'Cannot delete the default postgres user' });
        
        const client = await getPgConnection();
        await client.query(`DROP USER "${username}"`);
        await client.end();
        res.json({ success: true, message: `User ${username} deleted` });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/postgres/users/password', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ success: false, message: 'Invalid username' });
        
        const client = await getPgConnection();
        await client.query(`ALTER USER "${username}" WITH PASSWORD '${password.replace(/'/g, "''")}'`);
        await client.end();
        
        if (username === 'postgres') {
            const config = getConfig();
            config.postgres_root_password = password || '';
            saveConfig(config);
        }
        
        res.json({ success: true, message: `Password updated for ${username}` });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/postgres/users/grant', async (req, res) => {
    try {
        const { username, dbName } = req.body;
        if (!/^[a-zA-Z0-9_]+$/.test(username) || !/^[a-zA-Z0-9_]+$/.test(dbName)) return res.status(400).json({ success: false, message: 'Invalid input' });
        
        const client = await getPgConnection();
        await client.query(`GRANT ALL PRIVILEGES ON DATABASE "${dbName}" TO "${username}"`);
        await client.end();
        res.json({ success: true, message: `Granted access to ${dbName} for ${username}` });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// MySQL Configuration API
app.get('/api/mysql/config', (req, res) => {
  try {
    let mysqlBin = path.join(binDir, 'mysql', 'bin');
    if (!fs.existsSync(path.join(mysqlBin, 'mysqld.exe'))) mysqlBin = path.join(binDir, 'mysql');
    const myIni = path.join(mysqlBin, 'my.ini');
    
    if (!fs.existsSync(myIni)) {
       return res.json({ success: true, config: { port: '3306', max_allowed_packet: '4M', innodb_buffer_pool_size: '128M' } });
    }
    
    const content = fs.readFileSync(myIni, 'utf-8');
    const getValue = (key) => {
      const match = content.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`, 'm'));
      return match ? match[1] : '';
    };
    
    res.json({ success: true, config: {
      port: getValue('port') || '3306',
      max_allowed_packet: getValue('max_allowed_packet') || '4M',
      innodb_buffer_pool_size: getValue('innodb_buffer_pool_size') || '128M'
    }});
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/mysql/config', (req, res) => {
  try {
    const { config } = req.body;
    let mysqlBin = path.join(binDir, 'mysql', 'bin');
    if (!fs.existsSync(path.join(mysqlBin, 'mysqld.exe'))) mysqlBin = path.join(binDir, 'mysql');
    const myIni = path.join(mysqlBin, 'my.ini');
    
    let content = '[mysqld]\r\n';
    if (fs.existsSync(myIni)) {
       content = fs.readFileSync(myIni, 'utf-8');
    }
    
    // Same injection shape as /api/php/config: an unvalidated key lets a
    // caller set ANY my.ini directive, not just the three this form exposes -
    // "init-file" is a perfectly normal-looking key that also happens to run
    // arbitrary SQL as DB root on every mysqld startup. Only accept the exact
    // settings this endpoint is meant to change.
    const MYSQL_ALLOWED_KEYS = new Set(['port', 'max_allowed_packet', 'innodb_buffer_pool_size']);
    if (config) {
      for (const [key, val] of Object.entries(config)) {
        if (!val || !MYSQL_ALLOWED_KEYS.has(key)) continue;
        const safeVal = String(val).replace(/[\r\n]/g, '');
        const safeKey = escapeRegExp(key);
        // [ \t]*, never \s* - see the matching comment in /api/php/config above.
        const regex = new RegExp(`^[ \\t]*${safeKey}[ \\t]*=.*$`, 'm');
        if (regex.test(content)) {
          content = content.replace(regex, `${key}=${safeVal}`);
        } else {
          content += `${key}=${safeVal}\r\n`;
        }
      }
    }

    fs.writeFileSync(myIni, content);
    
    // Restart MySQL if running
    if (pm.processes['mysql']) {
       const mysqlAdminExe = path.join(mysqlBin, 'mysqladmin.exe');
       if (fs.existsSync(mysqlAdminExe)) {
           try { execSync(`"${mysqlAdminExe}" -u root shutdown`, { stdio: 'ignore' }); } catch(e) {}
       }
       pm.stop('mysql');
       
       setTimeout(() => {
          const mysqldExe = path.join(mysqlBin, 'mysqld.exe');
          const args = [`--defaults-file=${myIni}`, '--datadir=' + mysqlDataDir, '--console'];
          pm.start('mysql', mysqldExe, args, mysqlBin);
       }, 1500);
    }
    
    res.json({ success: true, message: 'MySQL Configuration saved' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/db/list', async (req, res) => {
    try {
        const conn = await getDbConnection();
        const [rows] = await conn.execute('SHOW DATABASES');
        await conn.end();
        const dbs = rows.map(r => r.Database).filter(db => db !== 'information_schema' && db !== 'performance_schema');
        res.json({ success: true, databases: dbs });
    } catch(err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/db/create', async (req, res) => {
    const { name } = req.body;
    if(!name || !/^[a-zA-Z0-9_]+$/.test(name)) return res.status(400).json({ success: false, message: 'Invalid DB name' });
    
    try {
        const conn = await getDbConnection();
        await conn.execute(`CREATE DATABASE IF NOT EXISTS ${name}`);        await conn.end();
        res.json({ success: true, message: `Database ${name} created` });
    } catch(err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/db/delete', async (req, res) => {
    const { name } = req.body;
    if(!name || !/^[a-zA-Z0-9_]+$/.test(name)) return res.status(400).json({ success: false, message: 'Invalid DB name' });
    
    try {
        const conn = await getDbConnection();
        await conn.execute(`DROP DATABASE IF EXISTS ${name}`);
        await conn.end();
        res.json({ success: true, message: `Database ${name} deleted` });
    } catch(err) {
        res.status(500).json({ success: false, message: err.message });
    }
});


// Caddy config generator
function rebuildCaddyfile() {
  const caddyfilePath = path.join(appRoot, 'Caddyfile');
  const ports = getConfig().ports;
  let sslState = {};
  if (fs.existsSync(sslStatePath)) {
    try { sslState = JSON.parse(fs.readFileSync(sslStatePath, 'utf8')); } catch(e) {}
  }
  
  let caddyConfig = `{
  skip_install_trust
  auto_https disable_certs
  local_certs
  http_port ${ports.caddy_http}
  https_port ${ports.caddy_https}
}

http://localhost, http://127.0.0.1 {
  root * "${wwwDir.replace(/\\/g, '/')}"
  php_fastcgi 127.0.0.1:${ports.php}
  file_server
  log {
    output file "${path.join(logsDir, 'access.log').replace(/\\/g, '/')}"
  }
}

http://adminer.jengadev {
  root * "${path.join(binDir, 'adminer').replace(/\\/g, '/')}"
  php_fastcgi 127.0.0.1:${ports.php}
  file_server
  log {
    output file "${path.join(logsDir, 'access.log').replace(/\\/g, '/')}"
  }
}

http://phpmyadmin.jengadev {
  root * "${path.join(binDir, 'phpmyadmin').replace(/\\/g, '/')}"
  php_fastcgi 127.0.0.1:${ports.php}
  file_server
  log {
    output file "${path.join(logsDir, 'access.log').replace(/\\/g, '/')}"
  }
}

http://mailpit.jengadev {
  reverse_proxy 127.0.0.1:${ports.mailpit_web}
}
`;

  // Custom SSL blocks
  const customDomains = [];
  for (const [domain, state] of Object.entries(sslState)) {
    if (state.status === 'active' && fs.existsSync(state.cert_path) && fs.existsSync(state.key_path)) {
      customDomains.push(domain);
      caddyConfig += `\nhttps://${domain} {
  tls "${state.cert_path.replace(/\\/g, '/')}" "${state.key_path.replace(/\\/g, '/')}"
  root * "${path.join(wwwDir, domain.replace('.test', '')).replace(/\\/g, '/')}"
  php_fastcgi 127.0.0.1:${ports.php}
  file_server
  log {
    output file "${path.join(logsDir, 'access.log').replace(/\\/g, '/')}"
  }
}
`;
    }
  }
  
  // Generate explicit blocks for all folders to prevent wildcard parsing errors
  const folders = fs.existsSync(wwwDir) ? fs.readdirSync(wwwDir).filter(f => fs.statSync(path.join(wwwDir, f)).isDirectory()) : [];
  for (const folder of folders) {
      const domain = folder.includes('.') ? folder : `${folder}.test`;
      if (!customDomains.includes(domain)) {
          caddyConfig += `\nhttp://${domain} {
  root * "${path.join(wwwDir, folder).replace(/\\/g, '/')}"
  php_fastcgi 127.0.0.1:${ports.php}
  file_server
  log {
    output file "${path.join(logsDir, 'access.log').replace(/\\/g, '/')}"
  }
}\n`;
      }
  }
  
  fs.writeFileSync(caddyfilePath, caddyConfig.trim());
};

// Generates a small PHP script that redirects error_log to a per-host file based on
// the request's Host header (the standard trick for giving each vhost its own error
// log when they all share one php-cgi pool), with simple size-based rotation so no
// single log can grow unbounded as more hosts accumulate errors over time.
const phpLogRouterPath = path.join(configDir, 'php_error_router.php');
const phpPerHostLogsDir = path.join(logsDir, 'php');
const MAX_PHP_LOG_BYTES = 5 * 1024 * 1024; // 5MB per host before rotating
function writePhpLogRouter() {
    const fallbackLog = path.join(logsDir, 'php_errors.log').replace(/\\/g, '/');
    const perHostDir = phpPerHostLogsDir.replace(/\\/g, '/');
    const script = `<?php
$__jd_dir = '${perHostDir}';
if (!is_dir($__jd_dir)) { @mkdir($__jd_dir, 0777, true); }
$__jd_host = isset($_SERVER['HTTP_HOST']) ? $_SERVER['HTTP_HOST'] : 'default';
$__jd_host = explode(':', $__jd_host)[0];
$__jd_host = preg_replace('/[^a-zA-Z0-9_.-]/', '_', $__jd_host);
if ($__jd_host === '') { $__jd_host = 'default'; }
$__jd_log = $__jd_dir . '/' . $__jd_host . '.log';
if (@file_exists($__jd_log) && @filesize($__jd_log) > ${MAX_PHP_LOG_BYTES}) {
    @rename($__jd_log, $__jd_log . '.old');
}
ini_set('error_log', $__jd_log);
`;
    try {
        if (!fs.existsSync(phpPerHostLogsDir)) fs.mkdirSync(phpPerHostLogsDir, { recursive: true });
        fs.writeFileSync(phpLogRouterPath, script);
    } catch (e) {
        console.error('Failed to write PHP log router:', e);
    }
    return fallbackLog;
}

function configurePhpLogging(phpIniPath) {
    if (!fs.existsSync(phpIniPath)) return;
    const fallbackLog = writePhpLogRouter();
    let content = fs.readFileSync(phpIniPath, 'utf8');
    let changed = false;

    const expectedErrorLog = `error_log = "${fallbackLog}"`;
    if (!content.includes(expectedErrorLog)) {
        content = content.replace(/^(;?)error_log\s*=\s*(?:".*php_errors\.log"|php_errors\.log)/gm, expectedErrorLog);
        changed = true;
    }

    const expectedPrepend = `auto_prepend_file = "${phpLogRouterPath.replace(/\\/g, '/')}"`;
    if (!content.includes(expectedPrepend)) {
        if (/^[ \t]*;?[ \t]*auto_prepend_file[ \t]*=.*$/m.test(content)) {
            content = content.replace(/^[ \t]*;?[ \t]*auto_prepend_file[ \t]*=.*$/m, expectedPrepend);
        } else {
            content += `\r\n${expectedPrepend}\r\n`;
        }
        changed = true;
    }

    if (changed) fs.writeFileSync(phpIniPath, content);
}

// Replace setupInitialConfig with rebuildCaddyfile and PHP ini setup
const setupInitialConfig = () => {
    rebuildCaddyfile();

    try {
        const phpFolder = getConfig().active_php || 'php';
        configurePhpLogging(path.join(binDir, phpFolder, 'php.ini'));
    } catch(e) {
        console.error("Failed to update php.ini logs:", e);
    }

    try {
        const pmaConfigPath = path.join(binDir, 'phpmyadmin', 'config.inc.php');
        if (fs.existsSync(pmaConfigPath)) {
            let content = fs.readFileSync(pmaConfigPath, 'utf8');
            const port = getConfig().ports.mysql || 3306;
            if (!content.includes("['port']")) {
                content = content.replace(/(\$cfg\['Servers'\]\[\$i\]\['host'\].*)/, `$1\n$cfg['Servers'][$i]['port'] = '${port}';`);
            } else {
                content = content.replace(/\$cfg\['Servers'\]\[\$i\]\['port'\]\s*=\s*'.*';/, `$cfg['Servers'][$i]['port'] = '${port}';`);
            }
            fs.writeFileSync(pmaConfigPath, content);
        }
    } catch(e) {
        console.error("Failed to update phpMyAdmin config:", e);
    }
};

// SSL Management API
app.get('/api/ssl/list', (req, res) => {
  try {
    let sslState = {};
    if (fs.existsSync(sslStatePath)) {
      try { sslState = JSON.parse(fs.readFileSync(sslStatePath, 'utf8')); } catch(e) {}
    }
    
    // Get all hosts
    const hosts = [];
    if (fs.existsSync(wwwDir)) {
      const folders = fs.readdirSync(wwwDir).filter(f => fs.statSync(path.join(wwwDir, f)).isDirectory());
      for (const f of folders) {
        // Fallback domain logic (to match hosts manager logic where dot dictates domain)
        const domain = f.includes('.') ? f : `${f}.test`;
        const state = sslState[domain] || { status: 'none', type: 'RSA 2048' };
        hosts.push({ domain, name: f, ...state });
      }
    }
    res.json({ success: true, ssls: hosts });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/ssl/generate-csr', (req, res) => {
  try {
    const { domain, organization, country, state, locality, email } = req.body;
    if (!domain) return res.status(400).json({ success: false, message: 'Domain is required' });
    
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const csr = forge.pki.createCertificationRequest();
    csr.publicKey = keys.publicKey;
    
    const attrs = [
      { name: 'commonName', value: domain },
      { name: 'countryName', value: country || 'US' },
      { name: 'stateOrProvinceName', value: state || 'State' },
      { name: 'localityName', value: locality || 'City' },
      { name: 'organizationName', value: organization || 'My Company' }
    ];
    if (email) attrs.push({ name: 'emailAddress', value: email });
    csr.setSubject(attrs);
    
    csr.sign(keys.privateKey);
    
    const privateKeyPem = forge.pki.privateKeyToPem(keys.privateKey);
    const csrPem = forge.pki.certificationRequestToPem(csr);
    
    const keyPath = path.join(sslDir, `${domain}.key`);
    const csrPath = path.join(sslDir, `${domain}.csr`);
    
    fs.writeFileSync(keyPath, privateKeyPem);
    fs.writeFileSync(csrPath, csrPem);
    
    // Update State
    let sslState = {};
    if (fs.existsSync(sslStatePath)) {
      try { sslState = JSON.parse(fs.readFileSync(sslStatePath, 'utf8')); } catch(e) {}
    }
    sslState[domain] = {
      status: 'csr pending',
      type: 'RSA 2048',
      expires: null,
      key_path: keyPath,
      csr_path: csrPath
    };
    fs.writeFileSync(sslStatePath, JSON.stringify(sslState, null, 2));
    
    res.json({ success: true, message: 'CSR generated successfully', csr: csrPem });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/ssl/upload', (req, res) => {
  try {
    const { domain, certificate } = req.body;
    if (!domain || !certificate) return res.status(400).json({ success: false, message: 'Domain and certificate required' });
    
    const certPath = path.join(sslDir, `${domain}.crt`);
    fs.writeFileSync(certPath, certificate);
    
    // Parse expiry date using node-forge
    let expires = null;
    try {
      const certObj = forge.pki.certificateFromPem(certificate);
      expires = certObj.validity.notAfter;
    } catch(e) {}
    
    // Update State
    let sslState = {};
    if (fs.existsSync(sslStatePath)) {
      try { sslState = JSON.parse(fs.readFileSync(sslStatePath, 'utf8')); } catch(e) {}
    }
    if (!sslState[domain]) sslState[domain] = {};
    sslState[domain].status = 'active';
    sslState[domain].expires = expires;
    sslState[domain].cert_path = certPath;
    fs.writeFileSync(sslStatePath, JSON.stringify(sslState, null, 2));
    
    // Rebuild Caddy and restart if running
    rebuildCaddyfile();
    if (pm.processes['caddy']) {
      pm.stop('caddy');
      setTimeout(() => {
        const caddyExe = path.join(binDir, 'caddy.exe');
        const caddyfile = path.join(appRoot, 'Caddyfile');
        pm.start('caddy', caddyExe, ['run', '--config', caddyfile], binDir);
      }, 1000);
    }
    
    res.json({ success: true, message: 'Certificate uploaded and activated' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// MySQL Backup & Restore
app.post('/api/mysql/backup', async (req, res) => {
  try {
    const { dbName } = req.body;
    if (dbName && !/^[a-zA-Z0-9_]+$/.test(dbName)) return res.status(400).json({ success: false, message: 'Invalid database name' });
    
    let mysqlBin = path.join(binDir, 'mysql', 'bin');
    if (!fs.existsSync(path.join(mysqlBin, 'mysqldump.exe'))) mysqlBin = path.join(binDir, 'mysql');
    
    const backupsDir = path.join(appRoot, 'backups');
    if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir);
    
    const fileName = `${dbName || 'all_databases'}_${Date.now()}.sql`;
    const targetFile = path.join(backupsDir, fileName);
    
    const dumpExe = path.join(mysqlBin, 'mysqldump.exe');
    const args = dbName ? ['-u', 'root', dbName] : ['-u', 'root', '--all-databases'];
    
    const fd = fs.openSync(targetFile, 'w');
    require('child_process').spawnSync(dumpExe, args, { stdio: ['ignore', fd, 'ignore'] });
    fs.closeSync(fd);
    
    res.json({ success: true, message: `Backup saved to ${fileName}` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Backup failed: ' + err.message });
  }
});

app.post('/api/mysql/restore', async (req, res) => {
  try {
    const { dbName, filePath } = req.body;
    if (dbName && !/^[a-zA-Z0-9_]+$/.test(dbName)) return res.status(400).json({ success: false, message: 'Invalid database name' });
    if (!filePath || !fs.existsSync(filePath)) return res.status(400).json({ success: false, message: 'Invalid file path' });
    
    let mysqlBin = path.join(binDir, 'mysql', 'bin');
    if (!fs.existsSync(path.join(mysqlBin, 'mysql.exe'))) mysqlBin = path.join(binDir, 'mysql');
    
    const mysqlExe = path.join(mysqlBin, 'mysql.exe');
    const args = dbName ? ['-u', 'root', dbName] : ['-u', 'root'];
    
    const fd = fs.openSync(filePath, 'r');
    require('child_process').spawnSync(mysqlExe, args, { stdio: [fd, 'ignore', 'ignore'] });
    fs.closeSync(fd);
    
    res.json({ success: true, message: 'Database restored successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Restore failed: ' + err.message });
  }
});

app.get('/api/dialog/open-file', (req, res) => {
    const script = `
        Add-Type -AssemblyName System.Windows.Forms
        $f = New-Object System.Windows.Forms.OpenFileDialog
        $f.Filter = "SQL Files (*.sql)|*.sql|All Files (*.*)|*.*"
        $f.ShowHelp = $true
        $res = $f.ShowDialog()
        if ($res -eq "OK") { Write-Output $f.FileName }
    `;
    exec(`powershell -NoProfile -Command "${script.replace(/\n/g, ' ')}"`, (err, stdout) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        const filePath = stdout.trim();
        if (filePath) res.json({ success: true, file: filePath });
        else res.json({ success: false, message: 'No file selected' });
    });
});



const daemonPort = getConfig().ports.daemon || 4000;
app.listen(daemonPort, '127.0.0.1', () => {
  setupInitialConfig();
  console.log(`JengaDev Daemon running at http://127.0.0.1:${daemonPort}`);

  // Open the dashboard with a valid token so a fresh tab works immediately
  // instead of hitting 401s from the /api auth middleware above. Skipped when
  // launched with --silent (the Windows-startup/login shortcut uses this so
  // logging in doesn't pop a browser window every time).
  if (!process.argv.includes('--silent')) {
    try {
      exec(`start "" "http://127.0.0.1:${daemonPort}/?token=${DAEMON_TOKEN}"`);
    } catch (e) {}
  }

  // Post-install auto-start
  const autostartFile = path.join(configDir, 'first_run_autostart.json');
  if (fs.existsSync(autostartFile)) {
    try {
      const services = JSON.parse(fs.readFileSync(autostartFile, 'utf8'));
      fs.unlinkSync(autostartFile);
      
      const startService = async (service) => {
        try {
          await fetch(`http://127.0.0.1:${daemonPort}/api/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-JengaDev-Token': DAEMON_TOKEN },
            body: JSON.stringify({ service })
          });
        } catch (e) {
          console.error(`Auto-start failed for ${service}:`, e.message);
        }
      };
      
      // Always start Caddy first
      startService('caddy').then(() => {
        services.forEach(startService);
      });
    } catch(e) {}
  }
});
