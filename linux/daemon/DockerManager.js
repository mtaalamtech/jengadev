const { exec } = require('child_process');
const path = require('path');

// Wraps `docker compose` the same way ProcessManager.js (Windows) wraps
// native child_process.spawn calls - same start/stop/status/logs shape, so
// the rest of the daemon barely needs to know containers are involved.
class DockerManager {
  constructor(composeDir) {
    this.composeDir = composeDir;
    this.composeFile = path.join(composeDir, 'docker-compose.yml');
  }

  _run(args, timeoutMs = 120000) {
    return new Promise((resolve) => {
      exec(`docker compose -f "${this.composeFile}" ${args}`, {
        cwd: this.composeDir,
        maxBuffer: 10 * 1024 * 1024,
        timeout: timeoutMs
      }, (err, stdout, stderr) => {
        resolve({ success: !err, stdout: stdout || '', stderr: stderr || '', error: err ? err.message : null });
      });
    });
  }

  // "up -d" both creates (first run) and starts (later runs) a service,
  // building its image first if one isn't already built (php81/82/83).
  // PHP images are prebuilt and pulled from ghcr.io now (see
  // docker-compose.yml), not built locally, so this almost never needs
  // more than a few seconds in practice. The generous ceiling is left in
  // place for a slow first pull, or for anyone who points docker-
  // compose.yml back at a local `build:` - a first-time build from source
  // measured over 4 minutes on a real server, well past the default
  // 2-minute timeout, which used to silently kill it mid-way with a
  // confusing partial error.
  async start(service) {
    const result = await this._run(`up -d --build ${service}`, 600000);
    return { success: result.success, message: result.success ? `${service} started` : `Failed to start ${service}: ${result.stderr || result.error}` };
  }

  async stop(service) {
    const result = await this._run(`stop ${service}`);
    return { success: result.success, message: result.success ? `${service} stopped` : `Failed to stop ${service}: ${result.stderr || result.error}` };
  }

  async restart(service) {
    const result = await this._run(`restart ${service}`);
    return { success: result.success, message: result.success ? `${service} restarted` : `Failed to restart ${service}: ${result.stderr || result.error}` };
  }

  async logs(service, tail = 200) {
    const result = await this._run(`logs --no-color --tail ${tail} ${service}`);
    return result.success ? result.stdout : (result.stderr || result.error || '');
  }

  // Returns { serviceName: 'running' | 'stopped' } for every service
  // defined in the compose file, not just ones currently up - `docker
  // compose ps` alone only lists running/stopped containers that exist, so
  // a service never started at all needs to be reported 'stopped' too.
  async status(knownServices) {
    const statuses = {};
    for (const name of knownServices) statuses[name] = 'stopped';

    const result = await this._run('ps --format json --all');
    if (!result.success) return statuses;

    try {
      const lines = result.stdout.trim().split('\n').filter(Boolean);
      for (const line of lines) {
        const obj = JSON.parse(line);
        if (obj.Service) {
          statuses[obj.Service] = (obj.State === 'running') ? 'running' : 'stopped';
        }
      }
    } catch (e) {}
    return statuses;
  }
}

module.exports = DockerManager;
