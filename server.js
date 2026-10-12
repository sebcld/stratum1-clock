'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createClock, queryServer } = require('./ntp');
const systemClock = require('./system-clock');

// Optional local configuration; .env is git-ignored so secrets never reach the repository.
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* no .env file */ }

const PORT = Number(process.env.PORT) || 3000;

// Hidden owner access to the device clock feature: ?<CLOCK_ADMIN_PARAM>=<CLOCK_ADMIN_KEY>.
// When either is unset the feature is disabled for everyone.
const ADMIN_PARAM = process.env.CLOCK_ADMIN_PARAM || '';
const ADMIN_KEY = process.env.CLOCK_ADMIN_KEY || '';
const PUBLIC_DIR = path.join(__dirname, 'public');

// Public Stratum 1 servers (the actual stratum is read from every reply).
const NTP_SERVERS = [
  'time-a-g.nist.gov',
  'time-b-g.nist.gov',
  'time-a-wwv.nist.gov',
  'ptbtime1.ptb.de',
  'ptbtime2.ptb.de',
  'ptbtime3.ptb.de',
  'tick.usno.navy.mil',
  'tock.usno.navy.mil',
  'sth1.ntp.se',
  'gbg1.ntp.se',
  'ntp.shoa.cl',
  'c.st1.ntp.br',
];

const POLL_MS = 64_000;      // automatic resync interval (classic NTP minpoll)
const MIN_SYNC_GAP_MS = 8_000; // NIST asks clients not to query more than once every 4 s
const WARMUP_ROUNDS = 3;     // quick initial rounds so jitter is available early
const WARMUP_GAP_MS = 4_500;
const HISTORY_SIZE = 8;
const SYSTEM_SYNC_GAP_MS = 10_000;     // min gap between system clock adjustments
const MAX_OFFSET_AGE_MS = 10 * 60_000; // refuse to adjust the clock with a stale offset

// ---------------------------------------------------------------------------
// NTP state
// ---------------------------------------------------------------------------

let clock = createClock();
let offsetMs = 0;            // NTP time − system time
let synced = false;
let lastSync = null;
let lastSyncStart = 0;
let nextSync = null;
let lastError = null;
let currentHost = null;
let inFlight = null;
let autoTimer = null;

const servers = new Map(
  NTP_SERVERS.map((host) => [host, { host, ip: null, stratum: null, refid: null, offset: null,
    delay: null, jitter: null, precision: null, error: null, lastOk: null, history: [] }]),
);

const ntpNow = () => clock() + offsetMs;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** RMS of the differences between successive offsets (RFC 5905 peer jitter). */
function jitterOf(history) {
  if (history.length < 2) return null;
  let sum = 0;
  for (let i = 1; i < history.length; i++) sum += (history[i].offset - history[i - 1].offset) ** 2;
  return Math.sqrt(sum / (history.length - 1));
}

function publicServer(s) {
  const { history, ...rest } = s;
  return { ...rest, samples: history.length };
}

function getStatus() {
  const current = currentHost ? publicServer(servers.get(currentHost)) : null;
  return {
    synced,
    syncing: Boolean(inFlight),
    offset: synced ? offsetMs : null,
    current,
    lastSync,
    nextSync,
    pollSeconds: POLL_MS / 1000,
    error: lastError,
    servers: [...servers.values()].map(publicServer),
    serverTime: ntpNow(),
  };
}

async function runSync() {
  lastSyncStart = Date.now();
  const roundClock = createClock();
  const results = await Promise.allSettled(NTP_SERVERS.map((h) => queryServer(h, roundClock)));

  const fresh = [];
  results.forEach((r, i) => {
    const entry = servers.get(NTP_SERVERS[i]);
    if (r.status === 'fulfilled') {
      const s = r.value;
      entry.history.push({ offset: s.offset, delay: s.delay });
      if (entry.history.length > HISTORY_SIZE) entry.history.shift();
      Object.assign(entry, {
        ip: s.ip, stratum: s.stratum, refid: s.refid, offset: s.offset, delay: s.delay,
        precision: s.precision, jitter: jitterOf(entry.history), error: null, lastOk: Date.now(),
      });
      fresh.push(entry);
    } else {
      entry.error = r.reason?.code || r.reason?.message || 'error';
    }
  });

  // Prefer genuine Stratum 1 replies; fall back to anything that answered.
  let candidates = fresh.filter((s) => s.stratum === 1);
  if (!candidates.length) candidates = fresh;

  if (!candidates.length) {
    lastError = 'Ningún servidor NTP respondió (¿UDP 123 bloqueado por el firewall?)';
    console.warn(`[ntp] ${lastError}`);
    return;
  }

  const best = candidates.reduce((a, b) => (b.delay < a.delay ? b : a));
  // Swap clock and offset together so /api/time never mixes anchors.
  clock = roundClock;
  offsetMs = median(candidates.map((s) => s.offset));
  currentHost = best.host;
  synced = true;
  lastSync = Date.now();
  lastError = candidates[0].stratum === 1 ? null : 'Sin respuesta Stratum 1; usando estratos superiores';

  console.log(`[ntp] ${new Date(lastSync).toISOString()} offset=${offsetMs.toFixed(3)} ms ` +
    `actual=${best.host} delay=${best.delay.toFixed(3)} ms (${candidates.length}/${NTP_SERVERS.length} válidos)`);
  for (const s of servers.values()) {
    const info = s.error ? `ERROR ${s.error}` :
      `stratum=${s.stratum} refid=${s.refid} offset=${s.offset.toFixed(3)} delay=${s.delay.toFixed(3)}`;
    console.log(`       ${s.host.padEnd(22)} ${info}`);
  }
}

function sync() {
  if (!inFlight) {
    inFlight = runSync()
      .catch((err) => { lastError = err.message; console.error('[ntp]', err); })
      .finally(() => { inFlight = null; broadcast(); });
    broadcast(); // let clients show the "syncing" state
  }
  return inFlight;
}

function scheduleNext(delay) {
  clearTimeout(autoTimer);
  nextSync = Date.now() + delay;
  autoTimer = setTimeout(async () => {
    await sync();
    scheduleNext(POLL_MS);
  }, delay);
}

async function startup() {
  for (let round = 1; round <= WARMUP_ROUNDS; round++) {
    await sync();
    if (round < WARMUP_ROUNDS) await new Promise((r) => setTimeout(r, WARMUP_GAP_MS));
  }
  scheduleNext(POLL_MS);
}

// ---------------------------------------------------------------------------
// System clock adjustment (only for the machine running this server)
// ---------------------------------------------------------------------------

let lastSystemSync = 0;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

/** Constant-time check of the hidden owner parameter (hashing equalises the lengths). */
function hasOwnerKey(searchParams) {
  if (!ADMIN_PARAM || !ADMIN_KEY) return false;
  const given = searchParams.get(ADMIN_PARAM);
  return given != null && crypto.timingSafeEqual(sha256(given), sha256(ADMIN_KEY));
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const isLoopback = (req) => LOOPBACK.has(req.socket.remoteAddress);

/**
 * Loopback address + exact Host header (blocks DNS rebinding) + custom header
 * (a cross-site page cannot send it without a CORS preflight, which we never answer).
 */
function isTrustedLocalRequest(req) {
  const hosts = [`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`];
  const { origin, host } = req.headers;
  return isLoopback(req) && hosts.includes(host) && req.headers['x-clock-sync'] === '1' &&
    (!origin || hosts.some((h) => origin === `http://${h}`));
}

async function getSystemInfo(req) {
  const admin = await systemClock.isAdmin();
  const supported = systemClock.SUPPORTED.has(process.platform);
  return {
    os: systemClock.describeOs(),
    isLocal: isLoopback(req),
    admin,
    supported,
    canApply: isLoopback(req) && admin && supported,
    host: currentHost,
    offset: synced ? ntpNow() - Date.now() : null,
  };
}

async function syncSystemClock(req, res) {
  if (!isTrustedLocalRequest(req)) {
    return sendJson(res, 403, { ok: false, error: 'Solo se permite desde el propio equipo (localhost).' });
  }
  if (!systemClock.SUPPORTED.has(process.platform)) {
    return sendJson(res, 501, { ok: false, error: `Sistema no soportado: ${process.platform}` });
  }
  if (!(await systemClock.isAdmin())) {
    return sendJson(res, 403, { ok: false, needsAdmin: true,
      error: 'El servidor no tiene permisos de administrador para cambiar la hora.' });
  }
  if (!synced || Date.now() - lastSync > MAX_OFFSET_AGE_MS || inFlight) {
    return sendJson(res, 409, { ok: false, error: 'Espera a que termine una sincronización NTP reciente.' });
  }
  const wait = lastSystemSync + SYSTEM_SYNC_GAP_MS - Date.now();
  if (wait > 0) {
    return sendJson(res, 429, { ok: false, error: `Espera ${Math.ceil(wait / 1000)} s antes de reintentar.` });
  }

  lastSystemSync = Date.now();
  try {
    const { before, after } = await systemClock.applyNtpTime(ntpNow, currentHost);
    // Re-anchor so offsetMs describes the adjusted system clock; ntpNow() stays continuous.
    const now = ntpNow();
    clock = createClock();
    offsetMs = now - clock();
    console.log(`[sistema] reloj ajustado ${before.toFixed(3)} ms → residual ${after.toFixed(3)} ms`);
    broadcast();
    // Refresh the per-server table against the corrected clock as soon as NIST etiquette allows.
    scheduleNext(Math.max(lastSyncStart + MIN_SYNC_GAP_MS - Date.now(), 1000));
    return sendJson(res, 200, { ok: true, before, after, os: systemClock.describeOs() });
  } catch (err) {
    console.error('[sistema] error al ajustar el reloj:', err.output || err.message);
    return sendJson(res, 500, { ok: false, error: err.output || err.message });
  }
}

// ---------------------------------------------------------------------------
// Server-Sent Events
// ---------------------------------------------------------------------------

const sseClients = new Set();

function broadcast() {
  const payload = `event: status\ndata: ${JSON.stringify(getStatus())}\n\n`;
  for (const res of sseClients) res.write(payload);
}

setInterval(() => {
  for (const res of sseClients) res.write(': ping\n\n');
}, 25_000).unref();

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'forbidden' });

  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url, 'http://localhost');

  // Hot path: keep the work between t2 and t3 as small as possible.
  if (pathname === '/api/time' && req.method === 'GET') {
    const t2 = ntpNow();
    const body = `{"synced":${synced},"t2":${t2},"t3":`;
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    res.end(`${body}${ntpNow()}}`);
    return;
  }

  if (pathname === '/api/status' && req.method === 'GET') return sendJson(res, 200, getStatus());

  if (pathname === '/api/sync' && req.method === 'POST') {
    const wait = lastSyncStart + MIN_SYNC_GAP_MS - Date.now();
    if (wait > 0 && !inFlight) {
      return sendJson(res, 200, { throttled: true, retryInMs: wait, status: getStatus() });
    }
    await sync();
    scheduleNext(POLL_MS);
    return sendJson(res, 200, { throttled: false, status: getStatus() });
  }

  // Without the owner key the device clock endpoints do not exist.
  if (pathname.startsWith('/api/system') && !hasOwnerKey(searchParams)) {
    return sendJson(res, 404, { error: 'not found' });
  }
  if (pathname === '/api/system' && req.method === 'GET') return sendJson(res, 200, await getSystemInfo(req));
  if (pathname === '/api/system/sync' && req.method === 'POST') return syncSystemClock(req, res);

  if (pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write(`retry: 3000\nevent: status\ndata: ${JSON.stringify(getStatus())}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (req.method === 'GET') return serveStatic(req, res, pathname);
  sendJson(res, 405, { error: 'method not allowed' });
});

server.listen(PORT, () => {
  console.log(`Reloj NTP disponible en http://localhost:${PORT}`);
  if (ADMIN_PARAM && ADMIN_KEY) {
    systemClock.isAdmin().then((admin) => console.log(
      `[sistema] ajuste del reloj habilitado con acceso oculto · ${systemClock.describeOs().label} · ` +
      `permisos de administrador: ${admin ? 'sí' : 'no'}`));
  } else {
    console.log('[sistema] ajuste del reloj desactivado (define CLOCK_ADMIN_PARAM y CLOCK_ADMIN_KEY en .env)');
  }
  startup();
});
