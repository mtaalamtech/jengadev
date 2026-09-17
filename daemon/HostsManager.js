const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const HOSTS_FILE = 'C:\\Windows\\System32\\drivers\\etc\\hosts';
const IP = '127.0.0.1';

class HostsManager {
  constructor(wwwDir) {
    this.wwwDir = wwwDir;
  }

  sync() {
    return new Promise((resolve, reject) => {
      try {
        if (!fs.existsSync(this.wwwDir)) {
          return resolve({ success: true, message: 'www directory does not exist yet.' });
        }
        
        // 1. Get all folders in www/
        const folders = fs.readdirSync(this.wwwDir).filter(f => fs.statSync(path.join(this.wwwDir, f)).isDirectory());
        
        // 2. Read hosts file
        const hostsContent = fs.readFileSync(HOSTS_FILE, 'utf-8');
        
        // 3. Find missing domains
        const missing = [];
        const coreDomains = ['adminer.jengadev', 'phpmyadmin.jengadev', 'mailpit.jengadev'];
        
        const allDomains = [];
        for (const folder of folders) {
          allDomains.push(folder.includes('.') ? folder : `${folder}.test`);
        }
        allDomains.push(...coreDomains);

        for (const domain of allDomains) {
          // Strict regex validation to prevent command injection
          if (!/^[a-zA-Z0-9.-]+$/.test(domain)) continue;
          
          // Check if it already exists
          // Escape dots for strict regex match
          const escIP = IP.replace(/\./g, '\\.');
          const escDomain = domain.replace(/\./g, '\\.');
          const regex = new RegExp(`^\\s*${escIP}\\s+${escDomain}\\s*$`, 'm');
          if (!regex.test(hostsContent)) {
            missing.push(domain);
          }
        }

        if (missing.length === 0) {
          return resolve({ success: true, message: 'Hosts file is already up to date.' });
        }

        // 4. Try updating via PowerShell directly or via UAC elevation.
        // Use EncodedCommand to completely avoid quoting bugs and temp file races.
        const appendLines = missing.map(d => `${IP} ${d}`).join('\r\n');
        const psContent = `$ErrorActionPreference = 'Stop'; $hostsPath = '${HOSTS_FILE}'; Add-Content -Path $hostsPath -Value ''; Add-Content -Path $hostsPath -Value '# Added by JengaDev'; Add-Content -Path $hostsPath -Value '${appendLines}';`;
        
        // Convert to UTF-16LE Base64 for PowerShell -EncodedCommand
        const base64Cmd = Buffer.from(psContent, 'utf16le').toString('base64');
        const runCmd = `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${base64Cmd}`;

        // First attempt: run without UAC prompt (works if already elevated)
        exec(runCmd, (err1) => {
          if (!err1) {
             return resolve({ success: true, message: `Added ${missing.length} domains directly.` });
          }

          // Fallback: request UAC elevation
          // We wrap the EncodedCommand inside Start-Process for UAC.
          const uacCmd = `powershell -Command "Start-Process powershell -ArgumentList '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ${base64Cmd}' -Verb RunAs -Wait"`;
          exec(uacCmd, (err2) => {
             // In Node.js, exec doesn't capture the exit code of the elevated process
             // properly since it's a detached GUI prompt, but if Start-Process itself fails (e.g. UAC cancelled), it returns an error.
             if (err2) {
                return resolve({ success: false, message: 'Failed to update hosts file. Did you decline the UAC prompt?' });
             }
             resolve({ success: true, message: `Added ${missing.length} domains to hosts file. UAC prompt was approved.` });
          });
        });
      } catch (err) {
        resolve({ success: false, message: 'Error syncing hosts: ' + err.message });
      }
    });
  }
}

module.exports = HostsManager;
