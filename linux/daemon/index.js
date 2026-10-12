const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec } = require('child_process');

const DockerManager = require('./DockerManager');

const app = express();
const APP_VERSION = '0.1.0';

// appRoot is the linux/ project directory - the same directory
// docker-compose.yml lives in, so every relative bind-mount path in it
// (./www, ./config, ./logs) resolves the same way whether this is run
// directly via `node daemon/index.js` or as a packaged binary dropped
// next to docker-compose.yml.
const appRoot = path.join(__dirname, '..');
const wwwDir = path.join(appRoot, 'www');
const configDir = path.join(appRoot, 'config');
const logsDir = path.join(appRoot, 'logs');
const dashboardDir = path.join(appRoot, 'dashboard');
const caddyfilePath = path.join(configDir, 'Caddyfile');
const configPath = path.join(appRoot, 'jengadev.json');

for (const dir of [wwwDir, configDir, logsDir, path.join(logsDir, 'php'), dashboardDir]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const SERVICES = ['caddy', 'php81', 'php82', 'php83', 'mariadb', 'postgres', 'mailpit', 'adminer'];
const docker = new DockerManager(appRoot);

// --- Config ---
const getConfig = () => {
  const defaults = { active_php: 'php83', update_repo: null };
  if (fs.existsSync(configPath)) {
    try { return { ...defaults, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) }; } catch (e) {}
  }
  return defaults;
};
const saveConfig = (c) => fs.writeFileSync(configPath, JSON.stringify(c, null, 2));

// --- Auth token (same model as Windows: per-install token, file-permission
// restricted instead of icacls - chmod 600 is the Linux equivalent) ---
const tokenPath = path.join(configDir, 'daemon_token.txt');
function loadOrCreateDaemonToken() {
  try {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim();
    if (existing) return existing;
  } catch (e) {}
  const fresh = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(tokenPath, fresh, { mode: 0o600 });
  try { fs.chmodSync(tokenPath, 0o600); } catch (e) {}
  return fresh;
}
const DAEMON_TOKEN = loadOrCreateDaemonToken();

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    try {
      const url = new URL(origin);
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname.endsWith('.localhost')) {
        return callback(null, true);
      }
      return callback(new Error('Origin not allowed by CORS'));
    } catch (e) { return callback(new Error('Invalid Origin')); }
  }
}));
app.use(bodyParser.json());

app.use('/', express.static(dashboardDir, {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));

app.use('/api', (req, res, next) => {
  const supplied = req.headers['x-jengadev-token'] || req.query.token;
  if (supplied === DAEMON_TOKEN) return next();
  res.status(401).json({ success: false, message: 'Missing or invalid daemon token.' });
});

// --- Caddyfile generation ---
// *.localhost always resolves to 127.0.0.1 without touching /etc/hosts at
// all (RFC 6761, synthesized by systemd-resolved on most modern desktop
// Linux) - so that's the default convention instead of Windows' .test,
// which needs an explicit, sudo-gated hosts-file write every time. A name
// containing a dot is treated as a real custom domain instead, same as
// Windows, and still needs /etc/hosts handled separately (not yet wired
// up in this first pass - see hostsManager TODO below).
function domainFor(folderName) {
  return folderName.includes('.') ? folderName : `${folderName}.localhost`;
}

function rebuildCaddyfile() {
  const phpService = getConfig().active_php || 'php83';
  let content = `{
\temail internal
}

`;
  if (fs.existsSync(wwwDir)) {
    const folders = fs.readdirSync(wwwDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
    for (const folder of folders) {
      const domain = domainFor(folder);
      content += `${domain} {
\troot * /var/www/${folder}
\tphp_fastcgi ${phpService}:9000
\tfile_server
\tlog {
\t\toutput file /var/log/jengadev-caddy/${domain}.log
\t}
}

`;
    }
  }
  fs.writeFileSync(caddyfilePath, content);

  // Caddy doesn't watch its own config file for changes - writing a new
  // Caddyfile alone does nothing until something tells the running
  // container to reload it. `caddy reload` re-reads from disk without
  // dropping connections to domains that didn't change, so every new/
  // deleted host (and every PHP version switch) needs this, not just a
  // container restart on the rare occasions that's actually warranted.
  exec('docker exec jengadev_caddy caddy reload --config /etc/caddy/Caddyfile', (err, stdout, stderr) => {
    if (err && !/no such container/i.test(stderr || '')) {
      console.error('Caddy reload failed:', stderr || err.message);
    }
  });
}
rebuildCaddyfile();

// --- Status / start / stop / restart / logs ---
app.get('/api/status', async (req, res) => {
  const statuses = await docker.status(SERVICES);
  res.json({ ...statuses, active_php: getConfig().active_php });
});

app.post('/api/start', async (req, res) => {
  const { service } = req.body;
  if (!SERVICES.includes(service)) return res.status(400).json({ success: false, message: 'Unknown service' });
  res.json(await docker.start(service));
});

app.post('/api/stop', async (req, res) => {
  const { service } = req.body;
  if (!SERVICES.includes(service)) return res.status(400).json({ success: false, message: 'Unknown service' });
  res.json(await docker.stop(service));
});

app.get('/api/logs/:service', async (req, res) => {
  const { service } = req.params;
  if (!SERVICES.includes(service)) return res.status(400).json({ success: false, message: 'Unknown service' });
  res.json({ success: true, logs: await docker.logs(service) });
});

// --- PHP version switching ---
app.post('/api/php/switch', async (req, res) => {
  const { version } = req.body; // 'php81' | 'php82' | 'php83'
  if (!['php81', 'php82', 'php83'].includes(version)) {
    return res.status(400).json({ success: false, message: 'Invalid PHP version' });
  }
  const config = getConfig();
  const previous = config.active_php;
  config.active_php = version;
  saveConfig(config);
  rebuildCaddyfile();

  await docker.start(version);
  if (previous && previous !== version) await docker.stop(previous);
  const caddyStatus = await docker.status(['caddy']);
  if (caddyStatus.caddy === 'running') await docker.restart('caddy');

  res.json({ success: true, message: `Switched to ${version}` });
});

// --- Hosts ---
app.get('/api/hosts/list', (req, res) => {
  if (!fs.existsSync(wwwDir)) return res.json({ success: true, hosts: [] });
  const hosts = fs.readdirSync(wwwDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => ({ name: d.name, domain: domainFor(d.name), path: path.join(wwwDir, d.name) }));
  res.json({ success: true, hosts });
});

app.post('/api/hosts/create', (req, res) => {
  const { name } = req.body;
  if (!name || !/^[a-zA-Z0-9_.-]+$/.test(name)) {
    return res.status(400).json({ success: false, message: 'Invalid host name' });
  }
  const hostPath = path.join(wwwDir, name);
  const resolved = path.resolve(hostPath);
  if (!resolved.startsWith(path.resolve(wwwDir) + path.sep)) {
    return res.status(403).json({ success: false, message: 'Path traversal detected' });
  }
  if (!fs.existsSync(hostPath)) {
    fs.mkdirSync(hostPath, { recursive: true });
    fs.writeFileSync(path.join(hostPath, 'index.php'), `<?php\n\n// Welcome to ${domainFor(name)}\nphpinfo();\n`);
  }
  rebuildCaddyfile();
  res.json({ success: true, message: `Host ${domainFor(name)} created`, domain: domainFor(name) });
});

app.post('/api/hosts/delete', (req, res) => {
  const { name, confirm } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'Invalid host name' });
  if (confirm !== name) {
    return res.status(400).json({ success: false, message: `Deleting '${name}' is permanent. Resend with "confirm": "${name}" to proceed.` });
  }
  const hostPath = path.join(wwwDir, name);
  const resolved = path.resolve(hostPath);
  if (!resolved.startsWith(path.resolve(wwwDir) + path.sep)) {
    return res.status(403).json({ success: false, message: 'Path traversal detected' });
  }
  if (fs.existsSync(hostPath)) fs.rmSync(hostPath, { recursive: true, force: true });
  rebuildCaddyfile();
  res.json({ success: true, message: `Host ${name} deleted` });
});

// --- Update check (same GitHub-releases model as Windows, different asset
// naming convention for the Linux tarball/installer) ---
app.get('/api/update/check', async (req, res) => {
  const repo = getConfig().update_repo;
  if (!repo) return res.json({ success: true, configured: false, currentVersion: APP_VERSION, updateAvailable: false });
  try {
    const ghRes = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { 'User-Agent': 'JengaDev' } });
    if (!ghRes.ok) return res.json({ success: true, configured: true, currentVersion: APP_VERSION, updateAvailable: false });
    const rel = await ghRes.json();
    const latestVersion = (rel.tag_name || '').replace(/^v/i, '');
    res.json({ success: true, configured: true, currentVersion: APP_VERSION, latestVersion, updateAvailable: latestVersion > APP_VERSION, releaseNotesUrl: rel.html_url });
  } catch (e) {
    res.json({ success: true, configured: true, currentVersion: APP_VERSION, updateAvailable: false });
  }
});

const daemonPort = 4000;
app.listen(daemonPort, '127.0.0.1', () => {
  console.log(`JengaDev Daemon running at http://127.0.0.1:${daemonPort}`);
  exec(`xdg-open "http://127.0.0.1:${daemonPort}/?token=${DAEMON_TOKEN}"`, () => {});
});
