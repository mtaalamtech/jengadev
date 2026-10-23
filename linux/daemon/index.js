const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec } = require('child_process');
const mysql = require('mysql2/promise');
const { Client: PgClient } = require('pg');
const forge = require('node-forge');

const DockerManager = require('./DockerManager');

const app = express();
const APP_VERSION = '0.1.0';

// appRoot is the project directory docker-compose.yml lives in. In dev
// mode (`node daemon/index.js`) that's one level up from this script. A
// pkg-compiled binary is a different story: __dirname resolves inside its
// read-only virtual snapshot, not wherever the binary actually sits on
// disk - and the compiled binary is meant to be dropped directly in the
// project root next to docker-compose.yml (not inside a daemon/
// subfolder), so appRoot there is just the binary's own directory, same
// fix as the Windows build uses for the same reason.
const appRoot = process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '..');
const wwwDir = path.join(appRoot, 'www');
const configDir = path.join(appRoot, 'config');
const logsDir = path.join(appRoot, 'logs');
const dashboardDir = path.join(appRoot, 'dashboard');
const caddyfilePath = path.join(configDir, 'Caddyfile');
const configPath = path.join(appRoot, 'jengadev.json');
const sslDir = path.join(configDir, 'ssl');
const sslStatePath = path.join(configDir, 'ssl_state.json');

for (const dir of [wwwDir, configDir, logsDir, path.join(logsDir, 'php'), dashboardDir, sslDir]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
// rebuildCaddyfile() (below) reads this to decide between Caddy's default
// automatic HTTPS and an explicit uploaded cert for a given domain, and
// runs once immediately at startup - these need to exist before that
// first call, not just before the /api/ssl/* routes further down.
function getSslState() {
  try { return JSON.parse(fs.readFileSync(sslStatePath, 'utf8')); } catch (e) { return {}; }
}
function saveSslState(state) { fs.writeFileSync(sslStatePath, JSON.stringify(state, null, 2)); }

// The PHP containers write here as www-data (uid 82 in the official
// php-fpm-alpine images), which almost never matches the host user's uid -
// Docker doesn't remap bind-mount ownership, so from the host filesystem's
// point of view that process is just "other" on a directory the host user
// owns. Default mkdir perms (755) give "other" no write bit, so every log
// write failed silently and PHP fell back to its own stderr instead. 777
// is the simplest fix for a local dev tool (not multi-tenant), and it's
// idempotent so it also self-heals installs that created this dir before
// this fix existed.
try { fs.chmodSync(path.join(logsDir, 'php'), 0o777); } catch (e) {}

const SERVICES = ['caddy', 'php82', 'php83', 'mariadb', 'postgres', 'mailpit', 'adminer', 'phpmyadmin'];
const docker = new DockerManager(appRoot);

// --- Config ---
const getConfig = () => {
  const defaults = { active_php: 'php83', update_repo: null, expose_lan: true };
  if (fs.existsSync(configPath)) {
    try { return { ...defaults, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) }; } catch (e) {}
  }
  return defaults;
};
const saveConfig = (c) => fs.writeFileSync(configPath, JSON.stringify(c, null, 2));

// docker-compose.yml reads CADDY_BIND_ADDR from a .env file in the same
// directory for its port bindings - this is the only way to change a
// container's published port without recreating it, and compose only
// picks up .env at that point, not from this process's own environment.
// expose_lan defaults to true (0.0.0.0, every interface) since testing
// from another LAN device is an intentional feature, not an oversight;
// setting it false restricts Caddy - and everything reachable through it,
// including PHP - to this machine only.
// install.sh also writes to this file (POSTGRES_PASSWORD, generated once
// on first run) - overwriting it outright would wipe that out and break
// Postgres on its next recreate, so this only ever touches the
// CADDY_BIND_ADDR line, preserving every other line as-is.
const envPath = path.join(appRoot, '.env');
function rebuildEnvFile() {
  const bindAddr = getConfig().expose_lan ? '0.0.0.0' : '127.0.0.1';
  const lines = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, 'utf8').split('\n').filter(l => l.trim() && !l.startsWith('CADDY_BIND_ADDR='))
    : [];
  lines.push(`CADDY_BIND_ADDR=${bindAddr}`);
  fs.writeFileSync(envPath, lines.join('\n') + '\n');
}

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
  // This used to allowlist only localhost/127.0.0.1/*.localhost, which
  // broke every POST once the dashboard became LAN-reachable: Chrome sends
  // an Origin header on same-origin POSTs too, and the dashboard's own
  // origin is now the server's LAN IP, which that allowlist never covered.
  // Rejecting it doesn't actually buy any security here - the real gate is
  // the token (checked on every /api request regardless of origin), and
  // the jd_token cookie is SameSite=Lax, so a third-party site can't ride
  // a victim's cookie into a POST here even if CORS allowed its origin.
  // CORS only controls whether that third party could *read* a response,
  // and it has no valid token to get one worth reading. So just reflect
  // whatever origin asked.
  origin: (origin, callback) => callback(null, true)
}));
app.use(bodyParser.json());

// Minimal cookie reader (no cookie-parser dependency needed - res.cookie()
// for writing is already built into Express, this is only for reading
// req.headers.cookie back out).
function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  }
  return out;
}
function hasValidToken(req) {
  if (req.query.token === DAEMON_TOKEN) return true;
  if (req.headers['x-jengadev-token'] === DAEMON_TOKEN) return true;
  return parseCookies(req).jd_token === DAEMON_TOKEN;
}

// The daemon listens on every interface (not just loopback) below, because
// unlike the Windows build this runs on headless servers too, with no local
// browser to hand a 127.0.0.1 link to. Every /api call already requires the
// token, but the dashboard's own HTML was served with no check at all - fine
// when only reachable from the same machine, not once it's reachable from
// anyone on the LAN. This gates the page load itself: visiting without a
// valid token gets a 401 instead of the dashboard shell.
app.get('/', (req, res, next) => {
  if (!hasValidToken(req)) {
    return res.status(401).type('text/plain').send(
      'Missing or invalid token. Use the link printed in the daemon log ' +
      '(journalctl --user -u jengadev) or read it from config/daemon_token.txt.'
    );
  }
  // A token presented once (via ?token=... the first time, or an already-set
  // cookie after that) gets remembered in a long-lived cookie. Without this,
  // every plain reload 401'd: the token only ever arrived in the URL query
  // string on the very first request, and nothing carried it to the server
  // on later ones - sessionStorage is client-only and never travels with a
  // fresh request for '/' itself, only with the API calls app.js adds a
  // header to after the page has already loaded. A year is deliberately
  // generous - the daemon_token.txt value this cookie carries doesn't
  // rotate on its own (loadOrCreateDaemonToken reuses whatever's already on
  // disk), so there's nothing server-side forcing re-auth on a schedule;
  // the actual goal is "a browser that's already been given the token
  // essentially never has to ask again," including across the server
  // rebooting - that was never actually the trigger (the token is read
  // from a file that survives reboots fine), but it's worth being generous
  // here anyway since every machine/browser still has to be handed the
  // token at least once no matter what this value is.
  res.cookie('jd_token', DAEMON_TOKEN, { maxAge: 365 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' });
  next();
});

app.use('/', express.static(dashboardDir, {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));

app.use('/api', (req, res, next) => {
  if (hasValidToken(req)) return next();
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
    const sslState = getSslState();
    const folders = fs.readdirSync(wwwDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
    for (const folder of folders) {
      const domain = domainFor(folder);
      const ssl = sslState[domain];
      const hasCustomCert = ssl && ssl.status === 'active' && ssl.cert_path && ssl.key_path && fs.existsSync(ssl.cert_path) && fs.existsSync(ssl.key_path);
      // cert_path/key_path in ssl_state.json are host-absolute paths (the
      // daemon writes/reads them directly), but Caddy runs in a container
      // with its own filesystem view - ./config/ssl is mounted there at
      // /etc/caddy/ssl, so the Caddyfile needs that container-side path,
      // not the host one. Found this the hard way: Caddy's reload just
      // failed outright ("no such file or directory") and silently kept
      // serving the OLD auto-issued cert instead of the uploaded one.
      const tlsLine = hasCustomCert ? `\ttls /etc/caddy/ssl/${path.basename(ssl.cert_path)} /etc/caddy/ssl/${path.basename(ssl.key_path)}\n` : '';
      content += `${domain} {
${tlsLine}\troot * /var/www/${folder}
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
rebuildEnvFile();

// --- Network exposure (Caddy bind address) ---
app.get('/api/network/lan-exposure', (req, res) => {
  res.json({ success: true, expose_lan: getConfig().expose_lan });
});

app.post('/api/network/lan-exposure', async (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ success: false, message: 'enabled must be true or false' });
  }
  const config = getConfig();
  config.expose_lan = enabled;
  saveConfig(config);
  rebuildEnvFile();

  const status = await docker.status(SERVICES);
  if (status.caddy === 'running') await docker.recreate('caddy');
  res.json({ success: true, expose_lan: enabled });
});

// --- Per-host PHP error logs ---
// All hosts on a given PHP version share one php-fpm pool, so there's no
// per-vhost error_log out of the box. Same trick as the Windows build:
// an auto_prepend_file script that redirects error_log to a file named
// after the request's Host header, with simple size-based rotation so no
// single host's errors can grow unbounded. The script and the ini snippet
// that activates it are bind-mounted read-only into every php81/82/83
// container (see docker-compose.yml) at fixed container-side paths, so the
// logic here only has to write the two files - no docker exec needed,
// since php-fpm reads conf.d on container start and this only changes
// behavior that already takes effect the next time those containers are
// (re)created, which docker compose does automatically when a bind-mounted
// file's content changes the service's config.
const phpErrorRouterPath = path.join(configDir, 'php_error_router.php');
const phpCustomIniPath = path.join(configDir, 'php-error-router.ini');
const MAX_PHP_LOG_BYTES = 5 * 1024 * 1024; // 5MB per host before rotating
function writePhpErrorRouterScript() {
  const script = `<?php
$__jd_dir = '/var/log/jengadev-php';
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
ini_set('log_errors', '1');
`;
  fs.writeFileSync(phpErrorRouterPath, script);
}
writePhpErrorRouterScript();

// --- Editable PHP settings ---
// The same bind-mounted ini file that activates the per-host error router
// above also carries the handful of php.ini directives the Windows
// dashboard lets you edit. All three php81/82/83 images are built from one
// Dockerfile, so this one file applies the same settings to whichever
// version is actually running - there's no per-version state to track,
// matching the Windows UI which only ever shows one "PHP.ini
// Configuration" section for the active install.
const PHP_INI_KEYS = ['memory_limit', 'max_execution_time', 'upload_max_filesize', 'post_max_size'];
const PHP_INI_DEFAULTS = { memory_limit: '256M', max_execution_time: '60', upload_max_filesize: '64M', post_max_size: '64M' };
// Extensions compiled into php/Dockerfile at image-build time (see
// docker-php-ext-install there). Unlike Windows' native PHP installs,
// where an extension is just a .dll toggled on/off in php.ini, these are
// baked into the image itself for every version - there's no equivalent
// "disable" switch without rebuilding the image, so this list is only
// ever shown as what's available, not a set of checkboxes to flip.
const PHP_EXTENSIONS = ['mysqli', 'pdo_mysql', 'pgsql', 'pdo_pgsql', 'pdo_sqlite', 'mbstring', 'gd', 'zip', 'curl', 'opcache'];
function getPhpIniConfig() {
  const values = { ...PHP_INI_DEFAULTS };
  try {
    const content = fs.readFileSync(phpCustomIniPath, 'utf8');
    for (const key of PHP_INI_KEYS) {
      const m = content.match(new RegExp(`^${key}[ \\t]*=[ \\t]*(.*)$`, 'm'));
      if (m) values[key] = m[1].trim();
    }
  } catch (e) {}
  return values;
}
function writePhpCustomIni(values) {
  let content = 'auto_prepend_file = /etc/jengadev/php_error_router.php\n';
  for (const key of PHP_INI_KEYS) content += `${key} = ${values[key]}\n`;
  fs.writeFileSync(phpCustomIniPath, content);
}
writePhpCustomIni(getPhpIniConfig());

// --- Editable MySQL (MariaDB) settings ---
// Same bind-mount pattern as the PHP ini above, but mounted into the
// mariadb container's conf.d instead (see docker-compose.yml). "port"
// isn't exposed here the way Windows exposes it: that's a native install
// with one instance to configure, but here the external port is already
// fixed by docker-compose's own port mapping, and changing the internal
// listen port without also changing that mapping would just break access
// without any way for this form to know to update the other half.
const mysqlCustomCnfPath = path.join(configDir, 'mysql-custom.cnf');
const MYSQL_CNF_KEYS = ['max_allowed_packet', 'innodb_buffer_pool_size'];
const MYSQL_CNF_DEFAULTS = { max_allowed_packet: '16M', innodb_buffer_pool_size: '256M' };
function getMysqlCnfConfig() {
  const values = { ...MYSQL_CNF_DEFAULTS };
  try {
    const content = fs.readFileSync(mysqlCustomCnfPath, 'utf8');
    for (const key of MYSQL_CNF_KEYS) {
      const m = content.match(new RegExp(`^${key}[ \\t]*=[ \\t]*(.*)$`, 'm'));
      if (m) values[key] = m[1].trim();
    }
  } catch (e) {}
  return values;
}
function writeMysqlCustomCnf(values) {
  let content = '[mysqld]\n';
  for (const key of MYSQL_CNF_KEYS) content += `${key} = ${values[key]}\n`;
  fs.writeFileSync(mysqlCustomCnfPath, content);
}
writeMysqlCustomCnf(getMysqlCnfConfig());

// --- Mailpit configuration ---
// Ports are controlled via .env + docker-compose's own ${VAR:-default}
// substitution (same mechanism already used for MYSQL_ROOT_PASSWORD/
// POSTGRES_PASSWORD) rather than rewriting docker-compose.yml itself -
// that changes the container's published port mapping, which needs a
// recreate (docker.start() below does `up -d --build`, which recreates on
// a detected config change; a plain restart would keep the OLD mapping).
// SMTP auth binds to Mailpit's own MP_SMTP_AUTH_FILE/MP_SMTP_AUTH_ALLOW_
// INSECURE env vars (confirmed directly against the real image - these
// aren't documented in `--help` the way CLI flags are, since there's no
// entrypoint script translating them, just the Go binary's own viper env
// binding). An empty auth file is tolerated as "no auth required" rather
// than locking everyone out, confirmed the same way, so leaving username/
// password blank keeps today's open-relay behavior by default.
const mailpitAuthPath = path.join(configDir, 'mailpit_auth.txt');
const MAILPIT_DEFAULTS = { smtp_port: 1025, web_port: 8025, auth_user: '', auth_pass: '' };
function getMailpitConfig() {
  return { ...MAILPIT_DEFAULTS, ...(getConfig().mailpit || {}) };
}
function writeMailpitAuthFile(cfg) {
  const content = (cfg.auth_user && cfg.auth_pass) ? `${cfg.auth_user}:${cfg.auth_pass}\n` : '';
  fs.writeFileSync(mailpitAuthPath, content);
}
writeMailpitAuthFile(getMailpitConfig());

app.get('/api/mailpit/config', (req, res) => {
  res.json({ success: true, config: getMailpitConfig() });
});

app.post('/api/mailpit/config', async (req, res) => {
  const body = req.body || {};
  const config = getConfig();
  config.mailpit = {
    smtp_port: parseInt(body.smtp_port, 10) || MAILPIT_DEFAULTS.smtp_port,
    web_port: parseInt(body.web_port, 10) || MAILPIT_DEFAULTS.web_port,
    auth_user: String(body.auth_user || '').replace(/[\r\n:]/g, ''),
    auth_pass: String(body.auth_pass || '').replace(/[\r\n]/g, '')
  };
  saveConfig(config);
  writeMailpitAuthFile(config.mailpit);
  writeEnvFile({ MAILPIT_SMTP_PORT: config.mailpit.smtp_port, MAILPIT_WEB_PORT: config.mailpit.web_port });
  const status = await docker.status(['mailpit']);
  // Port changes need the container recreated, not just restarted -
  // docker.start() runs `up -d --build`, which compose will turn into a
  // recreate on its own once it notices the resolved port mapping changed.
  if (status.mailpit === 'running') await docker.start('mailpit');
  res.json({ success: true, message: `Mailpit configuration saved${status.mailpit === 'running' ? ' - Mailpit restarted' : ''}` });
});

// --- SSL tools ---
// Caddy already auto-provisions HTTPS for every *.localhost host with no
// setup at all (see rebuildCaddyfile), using its own internal CA - this
// exists for the case Windows' SSL Tools exists for too: a real domain
// that needs a cert from an actual CA (internal corporate CA, or anywhere
// automatic ACME isn't viable), not local dev domains. A domain with an
// uploaded cert gets an explicit `tls cert key` block instead of Caddy's
// automatic handling; everything else keeps using automatic local HTTPS
// same as before - stricter than Windows, which disables Caddy's
// automatic certs globally and requires this flow for every domain.
// (sslDir/sslStatePath/getSslState/saveSslState are declared up near the
// other path constants - rebuildCaddyfile needs them at startup, before
// this section of the file even runs.)

app.get('/api/ssl/list', (req, res) => {
  const sslState = getSslState();
  const hosts = [];
  if (fs.existsSync(wwwDir)) {
    const folders = fs.readdirSync(wwwDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
    for (const folder of folders) {
      const domain = domainFor(folder);
      const state = sslState[domain] || { status: 'none', type: 'RSA 2048' };
      hosts.push({ domain, name: folder, ...state });
    }
  }
  res.json({ success: true, ssls: hosts });
});

app.post('/api/ssl/generate-csr', (req, res) => {
  try {
    const { domain, organization, country, state, locality, email } = req.body || {};
    if (!domain || !/^[a-zA-Z0-9_.-]+$/.test(domain)) return res.status(400).json({ success: false, message: 'Invalid domain' });

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

    const sslState = getSslState();
    sslState[domain] = { status: 'csr pending', type: 'RSA 2048', expires: null, key_path: keyPath, csr_path: csrPath, organization, country, state, locality, email };
    saveSslState(sslState);

    res.json({ success: true, message: 'CSR generated successfully', csr: csrPem });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/ssl/upload', (req, res) => {
  try {
    const { domain, certificate } = req.body || {};
    if (!domain || !/^[a-zA-Z0-9_.-]+$/.test(domain)) return res.status(400).json({ success: false, message: 'Invalid domain' });
    if (!certificate) return res.status(400).json({ success: false, message: 'Certificate required' });

    const sslState = getSslState();
    if (!sslState[domain] || !sslState[domain].key_path) {
      return res.status(400).json({ success: false, message: 'Generate a CSR for this domain first - there is no matching private key to pair it with.' });
    }

    const certPath = path.join(sslDir, `${domain}.crt`);
    fs.writeFileSync(certPath, certificate);

    let expires = null;
    try { expires = forge.pki.certificateFromPem(certificate).validity.notAfter; } catch (e) {
      return res.status(400).json({ success: false, message: 'Could not parse certificate - make sure it is valid PEM.' });
    }

    sslState[domain].status = 'active';
    sslState[domain].expires = expires;
    sslState[domain].cert_path = certPath;
    saveSslState(sslState);
    rebuildCaddyfile();

    res.json({ success: true, message: `Certificate activated for ${domain}` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Lets an already-authenticated browser pull the raw token to build a
// shareable dashboard link for onboarding another device/browser, without
// needing SSH access to read config/daemon_token.txt directly - the
// request calling this already proved it has the token (cookie or
// header), so this isn't handing it to anyone new.
app.get('/api/token', (req, res) => {
  res.json({ success: true, token: DAEMON_TOKEN });
});

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
  const { version } = req.body; // 'php82' | 'php83'
  if (!['php82', 'php83'].includes(version)) {
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

app.get('/api/php/config', (req, res) => {
  res.json({ success: true, config: getPhpIniConfig(), extensions: PHP_EXTENSIONS });
});

app.post('/api/php/config', async (req, res) => {
  const { config } = req.body || {};
  const current = getPhpIniConfig();
  for (const key of PHP_INI_KEYS) {
    if (config && config[key]) current[key] = String(config[key]).replace(/[\r\n]/g, '');
  }
  writePhpCustomIni(current);
  const active = getConfig().active_php || 'php83';
  const status = await docker.status([active]);
  if (status[active] === 'running') await docker.restart(active);
  res.json({ success: true, message: `PHP configuration saved${status[active] === 'running' ? ` - ${active} restarted` : ''}` });
});

app.get('/api/mysql/config', (req, res) => {
  res.json({ success: true, config: getMysqlCnfConfig() });
});

app.post('/api/mysql/config', async (req, res) => {
  const { config } = req.body || {};
  const current = getMysqlCnfConfig();
  for (const key of MYSQL_CNF_KEYS) {
    if (config && config[key]) current[key] = String(config[key]).replace(/[\r\n]/g, '');
  }
  writeMysqlCustomCnf(current);
  const status = await docker.status(['mariadb']);
  if (status.mariadb === 'running') await docker.restart('mariadb');
  res.json({ success: true, message: `MySQL configuration saved${status.mariadb === 'running' ? ' - MariaDB restarted' : ''}` });
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

function resolveHostPath(name) {
  if (!name || !/^[a-zA-Z0-9_.-]+$/.test(name)) return null;
  const hostPath = path.join(wwwDir, name);
  const resolved = path.resolve(hostPath);
  if (!resolved.startsWith(path.resolve(wwwDir) + path.sep)) return null;
  if (!fs.existsSync(resolved)) return null;
  return resolved;
}

function getDirSize(dir) {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return 0; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += getDirSize(full);
    else {
      try { total += fs.statSync(full).size; } catch (e) {}
    }
  }
  return total;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// Walks the host's folder once for both the tech-stack tags and the list of
// existing SQLite files, instead of three separate directory walks.
function scanHostFolder(dir) {
  const stack = new Set();
  const sqliteFiles = [];
  function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const ext = path.extname(entry.name).toLowerCase();
      if (ext === '.php') stack.add('PHP');
      else if (ext === '.html' || ext === '.css') stack.add('HTML/CSS');
      else if (ext === '.js') stack.add('JS');
      else if (ext === '.sqlite' || ext === '.db' || ext === '.sqlite3') sqliteFiles.push(path.relative(dir, full));
    }
  }
  walk(dir);
  return { stack: [...stack], sqliteFiles };
}

app.get('/api/hosts/detail', (req, res) => {
  const hostPath = resolveHostPath(req.query.name);
  if (!hostPath) return res.status(400).json({ success: false, message: 'Invalid host name' });
  const sizeBytes = getDirSize(hostPath);
  const { stack, sqliteFiles } = scanHostFolder(hostPath);
  res.json({ success: true, path: hostPath, size: sizeBytes, sizeFormatted: formatBytes(sizeBytes), stack, sqliteFiles });
});

app.post('/api/hosts/sqlite/create', (req, res) => {
  const hostPath = resolveHostPath(req.body && req.body.name);
  if (!hostPath) return res.status(400).json({ success: false, message: 'Invalid host name' });
  let filename = String((req.body && req.body.filename) || '').trim();
  if (!filename) return res.status(400).json({ success: false, message: 'Filename is required' });
  if (!/\.(sqlite3?|db)$/i.test(filename)) filename += '.sqlite';
  if (!/^[a-zA-Z0-9_.-]+$/.test(filename)) return res.status(400).json({ success: false, message: 'Invalid filename' });
  const filePath = path.join(hostPath, filename);
  if (!path.resolve(filePath).startsWith(hostPath + path.sep)) return res.status(403).json({ success: false, message: 'Path traversal detected' });
  if (fs.existsSync(filePath)) return res.status(400).json({ success: false, message: `${filename} already exists` });
  // An empty file is a valid starting point - SQLite writes its own header
  // the first time anything (PHP's pdo_sqlite included) actually creates a
  // table in it, same as Windows does for this same feature.
  fs.writeFileSync(filePath, '');
  res.json({ success: true, message: `${filename} created` });
});

app.post('/api/hosts/sqlite/delete', (req, res) => {
  const hostPath = resolveHostPath(req.body && req.body.name);
  if (!hostPath) return res.status(400).json({ success: false, message: 'Invalid host name' });
  const filename = String((req.body && req.body.filename) || '');
  if (!/^[a-zA-Z0-9_.-]+$/.test(filename)) return res.status(400).json({ success: false, message: 'Invalid filename' });
  const filePath = path.join(hostPath, filename);
  if (!path.resolve(filePath).startsWith(hostPath + path.sep)) return res.status(403).json({ success: false, message: 'Path traversal detected' });
  if (fs.existsSync(filePath)) fs.rmSync(filePath);
  res.json({ success: true, message: `${filename} deleted` });
});

// --- Database user management ---
// The daemon runs on the host, not in a container, so it reaches MariaDB/
// Postgres the same way any other host-side tool would: over the ports
// docker-compose publishes to 127.0.0.1 (deliberately left loopback-only -
// see docker-compose.yml). Root credentials come from .env, the same file
// docker-compose itself reads them from, so there's no separate place
// these can drift out of sync.
function readEnvFile() {
  const out = {};
  try {
    const content = fs.readFileSync(path.join(appRoot, '.env'), 'utf8');
    for (const line of content.split('\n')) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch (e) {}
  return out;
}
function writeEnvFile(updates) {
  const current = readEnvFile();
  Object.assign(current, updates);
  const content = Object.entries(current).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  fs.writeFileSync(path.join(appRoot, '.env'), content);
}
async function getDbConnection() {
  const env = readEnvFile();
  return mysql.createConnection({ host: '127.0.0.1', port: 3306, user: 'root', password: env.MYSQL_ROOT_PASSWORD || 'root' });
}
async function getPgConnection() {
  const env = readEnvFile();
  const client = new PgClient({ host: '127.0.0.1', port: 5432, user: 'postgres', database: 'postgres', password: env.POSTGRES_PASSWORD || '' });
  await client.connect();
  return client;
}

app.get('/api/mysql/users/list', async (req, res) => {
  try {
    const conn = await getDbConnection();
    const [rows] = await conn.query("SELECT DISTINCT User FROM mysql.user WHERE User NOT IN ('mysql.sys', 'mysql.session', 'mysql.infoschema', 'mariadb.sys')");
    await conn.end();
    res.json({ success: true, users: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/mysql/databases/list', async (req, res) => {
  try {
    const conn = await getDbConnection();
    const [rows] = await conn.query('SHOW DATABASES');
    await conn.end();
    res.json({ success: true, databases: rows.map(r => r.Database).filter(db => !['information_schema', 'mysql', 'performance_schema', 'sys'].includes(db)) });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/mysql/users/create', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ success: false, message: 'Invalid username' });
    const conn = await getDbConnection();
    // '%' rather than 'localhost' - this user needs to be reachable from
    // the PHP containers too, which connect over the Docker network, not
    // actually from MariaDB's point of view as "localhost".
    await conn.query(`CREATE USER '${username}'@'%' IDENTIFIED BY ?`, [password || '']);
    await conn.end();
    res.json({ success: true, message: `User ${username} created` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/mysql/users/delete', async (req, res) => {
  try {
    const { username } = req.body;
    if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ success: false, message: 'Invalid username' });
    if (username === 'root') return res.status(400).json({ success: false, message: 'Cannot delete the default root user' });
    const conn = await getDbConnection();
    await conn.query(`DROP USER '${username}'@'%'`);
    await conn.end();
    res.json({ success: true, message: `User ${username} deleted` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/mysql/users/password', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ success: false, message: 'Invalid username' });
    const conn = await getDbConnection();
    await conn.query(`ALTER USER '${username}'@'%' IDENTIFIED BY ?`, [password || '']);
    await conn.end();
    res.json({ success: true, message: `Password updated for ${username}` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/mysql/users/grant', async (req, res) => {
  try {
    const { username, dbName } = req.body;
    if (!/^[a-zA-Z0-9_]+$/.test(username) || !/^[a-zA-Z0-9_]+$/.test(dbName)) return res.status(400).json({ success: false, message: 'Invalid input' });
    const conn = await getDbConnection();
    await conn.query(`GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${username}'@'%'`);
    await conn.query('FLUSH PRIVILEGES');
    await conn.end();
    res.json({ success: true, message: `Granted access to ${dbName} for ${username}` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/postgres/databases/list', async (req, res) => {
  try {
    const client = await getPgConnection();
    const result = await client.query('SELECT datname FROM pg_database WHERE datistemplate = false');
    await client.end();
    res.json({ success: true, databases: result.rows.map(r => r.datname) });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/postgres/users/list', async (req, res) => {
  try {
    const client = await getPgConnection();
    const result = await client.query("SELECT usename FROM pg_user WHERE usename NOT IN ('pg_signal_backend')");
    await client.end();
    res.json({ success: true, users: result.rows.map(r => ({ User: r.usename })) });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/postgres/users/create', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ success: false, message: 'Invalid username' });
    const client = await getPgConnection();
    await client.query(`CREATE USER "${username}" WITH PASSWORD '${(password || '').replace(/'/g, "''")}'`);
    await client.end();
    res.json({ success: true, message: `User ${username} created` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
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
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/postgres/users/password', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ success: false, message: 'Invalid username' });
    const client = await getPgConnection();
    await client.query(`ALTER USER "${username}" WITH PASSWORD '${(password || '').replace(/'/g, "''")}'`);
    await client.end();
    res.json({ success: true, message: `Password updated for ${username}` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/postgres/users/grant', async (req, res) => {
  try {
    const { username, dbName } = req.body;
    if (!/^[a-zA-Z0-9_]+$/.test(username) || !/^[a-zA-Z0-9_]+$/.test(dbName)) return res.status(400).json({ success: false, message: 'Invalid input' });
    const client = await getPgConnection();
    await client.query(`GRANT ALL PRIVILEGES ON DATABASE "${dbName}" TO "${username}"`);
    await client.end();
    res.json({ success: true, message: `Granted access to ${dbName} for ${username}` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
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

function getLanIp() {
  const nets = require('os').networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

const daemonPort = 4000;
app.listen(daemonPort, '0.0.0.0', () => {
  const lanIp = getLanIp();
  const localUrl = `http://127.0.0.1:${daemonPort}/?token=${DAEMON_TOKEN}`;
  console.log(`JengaDev Daemon running on port ${daemonPort}`);
  console.log(`  Local:  ${localUrl}`);
  if (lanIp) console.log(`  LAN:    http://${lanIp}:${daemonPort}/?token=${DAEMON_TOKEN}`);
  // No DISPLAY means there's no local desktop session to open a browser in
  // (the common case on a headless server) - xdg-open would just fail, so
  // skip it and rely on the URLs just printed above instead.
  if (process.env.DISPLAY) exec(`xdg-open "${localUrl}"`, () => {});
});
