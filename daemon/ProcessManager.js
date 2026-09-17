const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Under pkg, __dirname resolves inside the read-only virtual snapshot, not the
// real install directory next to the exe. Resolve on-disk paths from there instead.
const appRoot = process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '..');
const logsDir = path.join(appRoot, 'logs');
try { if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true }); } catch (e) {}
const MAX_LOG_FILE_BYTES = 5 * 1024 * 1024; // rotate a service's log once it passes 5MB

class ProcessManager {
  constructor() {
    this.processes = {};
    this.logs = {};
    this.statuses = {};
  }

  start(name, command, args, cwd, env = process.env) {
    if (this.statuses[name] === 'running') {
      return { success: false, message: `${name} is already running` };
    }

    try {
      this.logs[name] = this.logs[name] || [];
      const proc = spawn(command, args, { cwd, env, windowsHide: true });
      this.processes[name] = proc;
      this.statuses[name] = 'running';
      
      this.addLog(name, `[SYSTEM] Started ${name}`);

      proc.stdout.on('data', (data) => {
        this.addLog(name, data.toString());
      });

      proc.stderr.on('data', (data) => {
        this.addLog(name, data.toString(), 'error');
      });

      proc.on('close', (code) => {
        this.statuses[name] = 'stopped';
        this.addLog(name, `[SYSTEM] ${name} exited with code ${code}`);
      });
      
      proc.on('error', (err) => {
        this.statuses[name] = 'error';
        this.addLog(name, `[SYSTEM] Error: ${err.message}`, 'error');
      });

      return { success: true, message: `${name} started` };
    } catch (err) {
      this.statuses[name] = 'error';
      return { success: false, message: `Failed to start ${name}: ${err.message}` };
    }
  }

  stop(name) {
    const proc = this.processes[name];
    
    if (name === 'postgres') {
      const { execSync } = require('child_process');
      try {
        const pgExe = path.join(appRoot, 'bin', 'pgsql', 'bin', 'pg_ctl.exe');
        const dataDir = path.join(appRoot, 'data', 'postgres');
        execSync(`"${pgExe}" stop -D "${dataDir}" -m fast`, { stdio: 'ignore', timeout: 5000 });
        this.addLog(name, `[SYSTEM] Executed pg_ctl stop -m fast`);
      } catch (e) {
        this.addLog(name, `[SYSTEM] pg_ctl stop failed or timed out: ${e.message}`, 'error');
      }
      // pg_ctl stop is not always reliable (times out, stale state, etc.) and the wrapper
      // node process is a separate process from the actual postgres.exe postmaster it
      // launched, so killing the wrapper alone can leave postgres.exe orphaned holding
      // the data directory lock. Force it down regardless of what pg_ctl reported.
      try {
        execSync(`taskkill /IM postgres.exe /F /T`, { stdio: 'ignore' });
        this.addLog(name, `[SYSTEM] Forced postgres.exe to stop`);
      } catch (e) {}
    }

    if (proc && this.statuses[name] === 'running') {
      // In windows, forcefully kill process tree
      try {
        const { execSync } = require('child_process');
        execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' });
      } catch(e) {}
      this.statuses[name] = 'stopped';
      this.addLog(name, `[SYSTEM] Sent stop signal to ${name}`);
      return { success: true, message: `${name} stopped` };
    }
    // For postgres, the cleanup above already ran (pg_ctl stop + forced taskkill)
    // even if our own status tracking had already drifted to "not running" - make
    // sure that work is reflected instead of reporting a misleading failure.
    if (name === 'postgres') {
      this.statuses[name] = 'stopped';
      return { success: true, message: 'postgres stopped' };
    }
    return { success: false, message: `${name} is not running` };
  }

  getStatus() {
    return this.statuses;
  }

  getPids() {
    const pids = {};
    for (const [name, proc] of Object.entries(this.processes)) {
      if (this.statuses[name] === 'running') {
        pids[name] = proc.pid;
      }
    }
    return pids;
  }

  getLogs(name) {
    return this.logs[name] || [];
  }

  addLog(name, message, type = 'info') {
    if (!this.logs[name]) this.logs[name] = [];
    const timestamp = new Date().toISOString();
    // keep only last 200 logs to prevent memory leak
    if (this.logs[name].length > 200) {
      this.logs[name].shift();
    }
    const cleanMsg = message.trim();
    if (cleanMsg) {
       this.logs[name].push({ timestamp, message: cleanMsg, type });
       try {
         const logFile = path.join(logsDir, `${name}.log`);
         const stat = fs.existsSync(logFile) ? fs.statSync(logFile) : null;
         if (stat && stat.size > MAX_LOG_FILE_BYTES) {
           fs.renameSync(logFile, logFile + '.old');
         }
         fs.appendFileSync(logFile, `[${timestamp}] ${cleanMsg}\n`);
       } catch (e) {}
    }
  }
}

module.exports = ProcessManager;
