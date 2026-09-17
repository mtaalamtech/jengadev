const { execSync } = require('child_process');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data', 'postgres');
const pgExe = path.join(__dirname, '..', 'bin', 'pgsql', 'bin', 'pg_ctl.exe');

const port = process.env.PGPORT || 5432;
// Start Postgres in the background using pg_ctl
try {
    execSync(`"${pgExe}" start -D "${dataDir}" -o "-p ${port}"`, { stdio: 'inherit' });
} catch (e) {
    console.error('Failed to start postgres:', e.message);
    process.exit(1);
}

// Keep the wrapper running and periodically check status
const interval = setInterval(() => {
    try {
        execSync(`"${pgExe}" status -D "${dataDir}"`, { stdio: 'ignore' });
    } catch (e) {
        // pg_ctl status returns non-zero if not running
        console.log('Postgres is no longer running. Exiting wrapper.');
        process.exit(1);
    }
}, 3000);

// Cleanup on exit
const stopPostgres = () => {
    try {
        execSync(`"${pgExe}" stop -D "${dataDir}"`, { stdio: 'inherit' });
    } catch (e) {}
    process.exit(0);
};

process.on('SIGINT', stopPostgres);
process.on('SIGTERM', stopPostgres);
process.on('exit', stopPostgres);
