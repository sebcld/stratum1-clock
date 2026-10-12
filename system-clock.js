'use strict';

// Adjusts the clock of the machine running this server, using each OS's native tool.
// Commands are fixed; the only interpolated values are numbers computed here and
// host names from the server's own list, always passed as argv (never through a shell).

const os = require('node:os');
const { execFile } = require('node:child_process');

function run(cmd, args, timeout = 15_000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        err.output = `${stderr || stdout || ''}`.trim();
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

function describeOs() {
  const release = os.release();
  switch (process.platform) {
    case 'win32': {
      const build = Number(release.split('.')[2]) || 0;
      return { kind: 'windows', label: build >= 22000 ? 'Windows 11' : 'Windows 10', release };
    }
    case 'darwin': return { kind: 'macos', label: 'macOS', release };
    case 'linux': return { kind: 'linux', label: 'Linux', release };
    case 'android': return { kind: 'android', label: 'Android', release };
    default: return { kind: process.platform, label: process.platform, release };
  }
}

/** Whether this process can change the system clock. Privileges never change at runtime, so cache it. */
let adminPromise = null;
function isAdmin() {
  if (!adminPromise) {
    adminPromise = process.platform === 'win32'
      ? run('net', ['session'], 5000).then(() => true, () => false) // only succeeds when elevated
      : Promise.resolve(typeof process.getuid === 'function' && process.getuid() === 0);
  }
  return adminPromise;
}

const SUPPORTED = new Set(['win32', 'linux', 'darwin']);

/**
 * Steps the system clock to NTP time.
 * @param {() => number} ntpNow  NTP time in Unix ms
 * @param {string} host          current Stratum 1 server (used by macOS sntp)
 */
async function applyNtpTime(ntpNow, host) {
  const before = ntpNow() - Date.now();

  switch (process.platform) {
    case 'win32': {
      // Relative adjustment: PowerShell start-up latency does not affect the result.
      const ticks = Math.round((ntpNow() - Date.now()) * 10_000);
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Set-Date -Adjust ([TimeSpan]::FromTicks(${ticks})) | Out-Null`]);
      break;
    }
    case 'linux':
      // Absolute time computed right before the (fast) spawn.
      await run('date', ['-u', '-s', `@${(ntpNow() / 1000).toFixed(3)}`]);
      break;
    case 'darwin':
      await run('sntp', ['-sS', host], 30_000);
      break;
    default:
      throw new Error(`Sistema no soportado: ${process.platform}`);
  }

  const after = ntpNow() - Date.now();
  return { before, after };
}

module.exports = { describeOs, isAdmin, applyNtpTime, SUPPORTED };
