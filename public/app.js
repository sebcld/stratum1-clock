'use strict';

const $ = (id) => document.getElementById(id);
const pad = (n, width = 2) => String(n).padStart(width, '0');

const SAMPLES_PER_MEASURE = 8;
const REMEASURE_MS = 30_000;
const CLOCK_JUMP_MS = 50;
const HISTORY_MAX = 120;

const state = {
  anchor: null,        // { perf, ntp }: NTP time at a performance.now() instant
  offset: null,        // NTP − local system clock (ms)
  rtt: null,           // browser ↔ server delay of the best sample (ms)
  base: null,          // Date.now() − performance.now() when measured
  serverSynced: false,
  status: null,        // last status from the server
  statusPerf: 0,       // performance.now() when that status arrived
  lastAgeMs: null,     // age of the last NTP sync when the status arrived
  nextInMs: null,      // time to the next automatic sync when the status arrived
  history: [],         // [{ t, offset }]
};

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const dateFmt = new Intl.DateTimeFormat('es', {
  weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
});
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

function fmtMs(v, digits = 3) {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v.toFixed(digits)} ms`;
}

function fmtSigned(v, digits = 1) {
  if (v == null || !Number.isFinite(v)) return '—';
  const sign = v > 0 ? '+' : v < 0 ? '−' : '±';
  const abs = Math.abs(v);
  return abs >= 1000 ? `${sign}${(abs / 1000).toFixed(3)} s` : `${sign}${abs.toFixed(digits)} ms`;
}

function fmtAbs(v) {
  return v >= 1000 ? `${(v / 1000).toFixed(3)} s` : `${v.toFixed(1)} ms`;
}

const hms = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const utcHms = (d) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;

function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${pad(s % 60)} s`;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Only touch the DOM when the text actually changes.
const textCache = new Map();
function setText(id, text) {
  if (textCache.get(id) === text) return;
  textCache.set(id, text);
  $(id).textContent = text;
}

// ---------------------------------------------------------------------------
// Browser ↔ server offset (same NTP algorithm over HTTP)
// ---------------------------------------------------------------------------

const ntpNow = () => (state.anchor ? state.anchor.ntp + (performance.now() - state.anchor.perf) : null);

async function sampleOnce(base) {
  const p1 = performance.now();
  const res = await fetch('/api/time', { cache: 'no-store' });
  const p4 = performance.now();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { synced, t2, t3 } = await res.json();
  const t1 = base + p1;
  const t4 = base + p4;
  const delay = (p4 - p1) - (t3 - t2);
  return {
    synced,
    delay,
    offset: ((t2 - t1) + (t3 - t4)) / 2,
    anchor: { perf: p4, ntp: t3 + delay / 2 },
  };
}

async function doMeasure() {
  // Date.now() has 1 ms resolution; +0.5 centres the truncation error.
  const base = Date.now() + 0.5 - performance.now();
  await fetch('/api/time', { cache: 'no-store' }); // warm up the connection
  let best = null;
  for (let i = 0; i < SAMPLES_PER_MEASURE; i++) {
    const s = await sampleOnce(base);
    if (!best || s.delay < best.delay) best = s;
  }
  Object.assign(state, {
    base, anchor: best.anchor, offset: best.offset, rtt: best.delay, serverSynced: best.synced,
  });
  if (best.synced) {
    state.history.push({ t: Date.now(), offset: best.offset });
    if (state.history.length > HISTORY_MAX) state.history.shift();
    renderChart();
  }
  renderOffset();
}

let measuring = null;
let remeasure = false;
function measure() {
  if (measuring) {
    remeasure = true;
    return measuring;
  }
  measuring = doMeasure()
    .catch((err) => {
      console.error(err);
      setPill('error', 'Sin conexión con el servidor');
    })
    .finally(() => {
      measuring = null;
      if (remeasure) {
        remeasure = false;
        measure();
      }
    });
  return measuring;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

let lastNtpSecond = '';
let lastLocalSecond = '';

function frame() {
  const local = new Date();
  const localHms = hms(local);
  setText('localHms', localHms);
  setText('localMs', pad(local.getMilliseconds(), 3));
  if (localHms !== lastLocalSecond) {
    lastLocalSecond = localHms;
    setText('localDate', dateFmt.format(local));
  }

  const n = ntpNow();
  if (n != null) {
    const d = new Date(n);
    const ntpHms = hms(d);
    setText('ntpHms', ntpHms);
    setText('ntpMs', pad(d.getMilliseconds(), 3));
    if (ntpHms !== lastNtpSecond) {
      lastNtpSecond = ntpHms;
      setText('ntpDate', dateFmt.format(d));
      setText('ntpUtc', utcHms(d));
    }
  }
  requestAnimationFrame(frame);
}

function renderOffset() {
  const card = $('offsetCard');
  document.querySelector('.hero').classList.toggle('unsynced', !state.serverSynced);

  if (!state.serverSynced || state.offset == null) {
    card.dataset.level = 'pending';
    setText('offsetValue', '—');
    setText('offsetDesc', 'El servidor aún no se ha sincronizado con NTP');
    setText('precision', '—');
    setText('mRtt', fmtMs(state.rtt));
    return;
  }

  const off = state.offset;
  const abs = Math.abs(off);
  card.dataset.level = abs < 50 ? 'good' : abs < 500 ? 'warn' : 'bad';
  setText('offsetValue', fmtSigned(off));
  setText('offsetDesc',
    abs < 1 ? 'Tu reloj está prácticamente sincronizado'
      : `Tu reloj va ${fmtAbs(abs)} ${off > 0 ? 'atrasado' : 'adelantado'}`);

  // Browser leg (RTT / 2) plus the server leg's root distance.
  const serverError = state.status?.distance ?? (state.status?.current?.delay ?? 0) / 2;
  setText('precision', `±${(state.rtt / 2 + serverError).toFixed(1)} ms`);
  setText('mRtt', fmtMs(state.rtt));
}

function setPill(kind, text) {
  $('statusPill').dataset.state = kind;
  setText('statusText', text);
}

function applyStatus(s) {
  state.status = s;
  state.statusPerf = performance.now();
  const serverSystemNow = s.serverTime - (s.offset ?? 0);
  state.lastAgeMs = s.lastSync ? serverSystemNow - s.lastSync : null;
  state.nextInMs = s.nextSync ? s.nextSync - serverSystemNow : null;

  if (s.syncing) setPill('syncing', 'Sincronizando…');
  else if (!s.synced) setPill(s.error ? 'error' : 'pending', s.error || 'Esperando NTP…');
  else if (s.error) setPill('warn', s.error);
  else setPill('ok', `Sincronizado · Stratum ${s.current?.stratum ?? '?'}`);

  const c = s.current;
  setText('curHost', c?.host ?? '—');
  setText('curIp', c?.ip ? `(${c.ip})` : '');
  setText('mOffset', fmtSigned(s.offset, 3));
  setText('mDelay', fmtMs(c?.delay));
  setText('mJitter', c?.jitter == null ? (c ? 'calculando…' : '—') : fmtMs(c.jitter));
  setText('mStratum', c?.stratum != null ? String(c.stratum) : '—');
  setText('mRefid', c?.refid ?? '—');
  setText('mDistance', s.distance == null ? '—' : `±${fmtMs(s.distance)}`);
  setText('mAgree', s.agreement ? `${s.agreement.count} / ${s.agreement.total}` : '—');
  setText('combineLimit', String(s.combineLimit ?? 3));

  renderServers(s);
  renderTimes();
  renderOffset();
}

const SELECTION_STATE = {
  selected: ['', 'seleccionado'],
  combined: ['combined', 'combinado'],
  backup: ['backup', 'respaldo'],
  falseticker: ['err', 'descartado'],
};

function renderServers(s) {
  const rows = s.servers.map((srv) => {
    const current = srv.selection === 'selected';
    let stateCell;
    if (srv.error) stateCell = `<span class="state err">${escapeHtml(srv.error)}</span>`;
    else if (srv.stratum == null) stateCell = '<span class="muted">pendiente</span>';
    else if (srv.selection) {
      const [cls, label] = SELECTION_STATE[srv.selection];
      stateCell = `<span class="state ${cls}">${label}</span>`;
    } else if (srv.stratum !== 1) stateCell = `<span class="state warn">stratum ${srv.stratum} · no usado</span>`;
    else stateCell = '<span class="muted">no usado</span>';

    return `<tr class="${current ? 'current' : ''}${srv.selection === 'falseticker' ? ' falseticker' : ''}">
      <td class="host">${escapeHtml(srv.host)}<small>${escapeHtml(srv.ip ?? '')}</small></td>
      <td class="mono">${srv.stratum ?? '—'}</td>
      <td class="mono">${escapeHtml(srv.refid ?? '—')}</td>
      <td class="num">${fmtSigned(srv.offset, 3)}</td>
      <td class="num">${fmtMs(srv.delay)}</td>
      <td class="num">${fmtMs(srv.jitter)}</td>
      <td class="num">${srv.distance == null ? '—' : `±${fmtMs(srv.distance, 1)}`}</td>
      <td class="num">${srv.weight ? `${(srv.weight * 100).toFixed(1)} %` : '—'}</td>
      <td>${stateCell}</td>
    </tr>`;
  });
  $('serverRows').innerHTML = rows.join('');
}

function renderTimes() {
  const s = state.status;
  if (!s) return;
  const elapsed = performance.now() - state.statusPerf;

  if (s.lastSync) {
    const ntpAtSync = new Date(s.lastSync + (s.offset ?? 0));
    setText('lastSync', `${hms(ntpAtSync)} (hace ${fmtDuration(state.lastAgeMs + elapsed)})`);
  } else {
    setText('lastSync', '—');
  }

  if (s.syncing) setText('nextSync', 'en curso…');
  else if (state.nextInMs != null) setText('nextSync', `en ${fmtDuration(state.nextInMs - elapsed)}`);
  else setText('nextSync', '—');
}

// ---------------------------------------------------------------------------
// Offset history chart (inline SVG, single series)
// ---------------------------------------------------------------------------

let chartGeom = null;

function renderChart() {
  const el = $('chart');
  const pts = state.history;
  if (pts.length < 2) {
    chartGeom = null;
    el.innerHTML = `<div class="chart-empty">Recopilando mediciones… (${pts.length}/2)</div>`;
    return;
  }

  const W = el.clientWidth;
  const H = el.clientHeight;
  const m = { l: 76, r: 10, t: 10, b: 22 };

  let lo = Math.min(...pts.map((p) => p.offset));
  let hi = Math.max(...pts.map((p) => p.offset));
  const span = Math.max(hi - lo, 2);
  const mid = (hi + lo) / 2;
  lo = mid - span * 0.6;
  hi = mid + span * 0.6;

  const t0 = pts[0].t;
  const t1 = pts[pts.length - 1].t;
  const x = (t) => m.l + ((t - t0) / (t1 - t0 || 1)) * (W - m.l - m.r);
  const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);

  const ticks = [lo + span * 0.1, mid, hi - span * 0.1];
  const grid = ticks.map((v) =>
    `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>`).join('');
  const yLabels = ticks.map((v) =>
    `<text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${fmtSigned(v)}</text>`).join('');
  const firstLabel = hms(new Date(t0));
  const lastLabel = hms(new Date(t1));
  const xLabels = (firstLabel !== lastLabel ? `<text x="${m.l}" y="${H - 4}">${firstLabel}</text>` : '') +
    `<text x="${W - m.r}" y="${H - 4}" text-anchor="end">${lastLabel}</text>`;

  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.offset).toFixed(1)}`).join('');
  const last = pts[pts.length - 1];

  el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <g class="grid">${grid}</g>
    <g class="axis">${yLabels}${xLabels}</g>
    <path class="line" d="${d}"/>
    <circle class="last" cx="${x(last.t)}" cy="${y(last.offset)}" r="4"/>
    <line class="cross" id="chartCross" y1="${m.t}" y2="${H - m.b}" visibility="hidden"/>
    <circle class="hover-dot" id="chartDot" r="5" visibility="hidden"/>
  </svg>`;
  el.setAttribute('aria-label',
    `Historial del offset: ${pts.length} mediciones, última ${fmtSigned(last.offset)}`);
  chartGeom = { x, y, m, W };
}

function onChartMove(ev) {
  if (!chartGeom) return;
  const el = $('chart');
  const rect = el.getBoundingClientRect();
  const px = ev.clientX - rect.left;
  let best = state.history[0];
  for (const p of state.history) {
    if (Math.abs(chartGeom.x(p.t) - px) < Math.abs(chartGeom.x(best.t) - px)) best = p;
  }
  const cx = chartGeom.x(best.t);
  const cy = chartGeom.y(best.offset);
  const cross = $('chartCross');
  const dot = $('chartDot');
  cross.setAttribute('x1', cx);
  cross.setAttribute('x2', cx);
  cross.setAttribute('visibility', 'visible');
  dot.setAttribute('cx', cx);
  dot.setAttribute('cy', cy);
  dot.setAttribute('visibility', 'visible');

  const tip = $('chartTip');
  tip.innerHTML = `${fmtSigned(best.offset, 2)}<span class="muted">${hms(new Date(best.t))}</span>`;
  tip.style.left = `${el.offsetLeft + Math.min(Math.max(cx, 60), chartGeom.W - 60)}px`;
  tip.style.top = `${el.offsetTop + cy}px`;
  tip.hidden = false;
}

function onChartLeave() {
  $('chartTip').hidden = true;
  $('chartCross')?.setAttribute('visibility', 'hidden');
  $('chartDot')?.setAttribute('visibility', 'hidden');
}

// ---------------------------------------------------------------------------
// Manual sync & toast
// ---------------------------------------------------------------------------

let toastTimer = null;
function showToast(message, kind = 'info') {
  const el = $('toast');
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4500);
}

async function manualSync() {
  const btn = $('syncBtn');
  btn.disabled = true;
  btn.classList.add('busy');
  setText('syncBtnText', 'Sincronizando…');
  try {
    const res = await fetch('/api/sync', { method: 'POST' });
    const data = await res.json();
    applyStatus(data.status);
    await measure();
    if (data.throttled) {
      showToast(`Enlace local re-medido. Los servidores NTP se consultaron hace un momento; ` +
        `nueva consulta posible en ${Math.ceil(data.retryInMs / 1000)} s.`);
    } else if (data.status.synced) {
      showToast(`Sincronizado con ${data.status.current?.host} · offset ${fmtSigned(state.offset)}`, 'ok');
    } else {
      showToast(data.status.error || 'No se pudo sincronizar', 'error');
    }
  } catch (err) {
    console.error(err);
    showToast('Error al contactar con el servidor', 'error');
  } finally {
    btn.disabled = false;
    btn.classList.remove('busy');
    setText('syncBtnText', 'Sincronización Manual');
  }
}

// ---------------------------------------------------------------------------
// Device clock sync: OS detection, native adjustment or per-OS instructions
// ---------------------------------------------------------------------------

const OS_LABELS = {
  windows: 'Windows', macos: 'macOS', linux: 'Linux', android: 'Android',
  ios: 'iOS', chromeos: 'ChromeOS', unknown: 'Sistema desconocido',
};

let clientOs = { kind: 'unknown', label: OS_LABELS.unknown };

// The owner's hidden access parameter travels in the page URL; the server validates it,
// so neither its name nor its value appear in this file.
const systemApi = (apiPath) => apiPath + location.search;

async function detectClientOs() {
  const ua = navigator.userAgent;
  const uaData = navigator.userAgentData;
  const platform = uaData?.platform || '';

  let kind = 'unknown';
  if (/android/i.test(platform) || /Android/.test(ua)) kind = 'android';
  else if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) kind = 'ios';
  else if (/chrome ?os/i.test(platform) || /CrOS/.test(ua)) kind = 'chromeos';
  else if (/win/i.test(platform) || /Windows/.test(ua)) kind = 'windows';
  else if (/mac/i.test(platform) || /Mac OS X/.test(ua)) kind = 'macos';
  else if (/linux/i.test(platform) || /Linux|X11/.test(ua)) kind = 'linux';

  let label = OS_LABELS[kind];
  if (kind === 'android') {
    const v = ua.match(/Android (\d+)/);
    if (v) label = `Android ${v[1]}`;
  } else if (kind === 'ios') {
    const v = ua.match(/OS (\d+)_/);
    label = `${/iPad|Macintosh/.test(ua) ? 'iPadOS' : 'iOS'}${v ? ` ${v[1]}` : ''}`;
  } else if (kind === 'windows' && uaData?.getHighEntropyValues) {
    // The UA string says "Windows NT 10.0" on both 10 and 11; client hints tell them apart.
    try {
      const { platformVersion } = await uaData.getHighEntropyValues(['platformVersion']);
      label = parseInt(platformVersion, 10) >= 13 ? 'Windows 11' : 'Windows 10';
    } catch { /* keep the generic label */ }
  }
  return { kind, label, mobile: kind === 'android' || kind === 'ios' };
}

function deviceGuide(kind, host) {
  const server = host || 'ntp.shoa.cl';
  switch (kind) {
    case 'windows':
      return {
        steps: ['Abre <strong>Configuración → Hora e idioma → Fecha y hora</strong>.',
          'Activa <strong>Establecer la hora automáticamente</strong>.',
          'Pulsa <strong>Sincronizar ahora</strong>.'],
        commandsTitle: 'O en PowerShell <strong>como administrador</strong>, usando el servidor Stratum 1 actual:',
        commands: [`w32tm /config /manualpeerlist:"${server},0x8" /syncfromflags:manual /update`, 'w32tm /resync /force'],
      };
    case 'macos':
      return {
        steps: ['Abre <strong>Ajustes del Sistema → General → Fecha y hora</strong>.',
          'Activa <strong>Ajustar fecha y hora automáticamente</strong>.'],
        commandsTitle: 'O en Terminal, usando el servidor Stratum 1 actual:',
        commands: [`sudo sntp -sS ${server}`],
      };
    case 'linux':
      return {
        steps: ['Activa la sincronización automática del sistema (systemd-timesyncd o chrony).'],
        commandsTitle: 'En una terminal:',
        commands: ['sudo timedatectl set-ntp true', 'sudo chronyc -a makestep'],
        note: 'El segundo comando solo aplica si usas chrony; fuerza un salto inmediato a la hora correcta.',
      };
    case 'android':
      return {
        steps: ['Abre <strong>Ajustes → Sistema → Fecha y hora</strong>.',
          'Activa <strong>Fecha y hora automáticas</strong> y <strong>Zona horaria automática</strong>.',
          'Si ya estaban activas, desactívalas y vuelve a activarlas para forzar la actualización.'],
        note: 'Android no permite elegir el servidor NTP ni cambiar la hora desde una web sin root; usa la hora de la red móvil o de Google.',
      };
    case 'ios':
      return {
        steps: ['Abre <strong>Ajustes → General → Fecha y hora</strong>.',
          'Activa <strong>Ajuste automático</strong>.'],
        note: 'iOS/iPadOS usa los servidores de Apple y no permite elegir otro servidor NTP.',
      };
    case 'chromeos':
      return {
        steps: ['ChromeOS sincroniza la hora automáticamente por NTP.',
          'Si la hora es incorrecta, revisa <strong>Configuración → Opciones avanzadas → Fecha y hora</strong> y reinicia el equipo.'],
      };
    default:
      return {
        steps: ['Activa la opción de hora automática / sincronización por red en los ajustes de fecha y hora del sistema.'],
      };
  }
}

function guideHtml(guide) {
  let html = `<ol>${guide.steps.map((s) => `<li>${s}</li>`).join('')}</ol>`;
  if (guide.commands) {
    html += `<p>${guide.commandsTitle}</p>`;
    html += guide.commands.map((c) =>
      `<div class="cmd"><code>${escapeHtml(c)}</code><button class="ghost-btn" type="button" data-copy="${escapeHtml(c)}">Copiar</button></div>`,
    ).join('');
  }
  if (guide.note) html += `<p class="muted">${guide.note}</p>`;
  return html;
}

const APPLY_METHOD = {
  windows: 'PowerShell <code>Set-Date -Adjust</code>',
  linux: '<code>date -s</code>',
  macos: '<code>sntp -sS</code>',
};

function renderDeviceDialog(sys, notice) {
  const local = sys.isLocal;
  const osInfo = local ? sys.os : clientOs;
  const offset = local ? sys.offset : state.offset;
  const offsetText = offset == null ? 'desconocida'
    : Math.abs(offset) < 1 ? 'menos de 1 ms'
      : `${fmtAbs(Math.abs(offset))} ${offset > 0 ? 'atrasado' : 'adelantado'}`;

  let html = `<div class="dialog-facts">
      <span class="fact">Sistema: <span class="mono">${escapeHtml(osInfo.label)}</span></span>
      <span class="fact">Desfase: <span class="mono">${offsetText}</span></span>
      <span class="fact">${local ? 'Mismo equipo que el servidor' : 'Dispositivo remoto'}</span>
    </div>`;
  if (notice) html += `<div class="notice ${notice.kind}">${notice.html}</div>`;

  const actions = $('deviceActions');
  actions.innerHTML = '';

  if (sys.canApply) {
    html += `<p>El servidor corre en este equipo con permisos de administrador. Se ajustará el reloj de
      <strong>${escapeHtml(sys.os.label)}</strong> en <strong class="mono">${fmtSigned(sys.offset, 1)}</strong>
      mediante ${APPLY_METHOD[sys.os.kind] ?? 'la herramienta del sistema'}.</p>
      <p class="muted">El servicio de hora del sistema puede volver a ajustarla más tarde según su propia configuración.</p>`;
    actions.innerHTML = `<button class="ghost-btn" type="button" data-close>Cancelar</button>
      <button class="primary-btn" type="button" id="applyBtn">Ajustar reloj ahora</button>`;
    $('applyBtn').addEventListener('click', () => applySystemSync(sys));
  } else if (local && sys.supported && !sys.admin) {
    html += `<div class="notice">El servidor no tiene permisos de administrador, así que no puede cambiar la hora.
      Reinícialo con <strong>npm start</strong> desde una terminal ${sys.os.kind === 'windows'
        ? 'abierta <strong>como administrador</strong>' : 'con <strong>sudo</strong>'} y vuelve a pulsar el botón,
      o hazlo manualmente:</div>`;
    html += guideHtml(deviceGuide(sys.os.kind, sys.host));
  } else {
    html += `<p>${local ? 'Este sistema no admite el ajuste automático desde el servidor.'
      : 'Por seguridad, una página web no puede cambiar la hora de este dispositivo.'}
      Sigue estos pasos en <strong>${escapeHtml(osInfo.label)}</strong>:</p>`;
    html += guideHtml(deviceGuide(osInfo.kind, sys.host));
  }

  $('deviceBody').innerHTML = html;
}

async function openDeviceDialog() {
  const btn = $('deviceBtn');
  btn.disabled = true;
  try {
    const sys = await (await fetch(systemApi('/api/system'), { cache: 'no-store' })).json();
    renderDeviceDialog(sys);
    $('deviceDialog').showModal();
  } catch (err) {
    console.error(err);
    showToast('No se pudo consultar el servidor', 'error');
  } finally {
    btn.disabled = false;
  }
}

async function applySystemSync(sys) {
  const btn = $('applyBtn');
  btn.disabled = true;
  btn.textContent = 'Ajustando…';
  try {
    const res = await fetch(systemApi('/api/system/sync'), { method: 'POST', headers: { 'X-Clock-Sync': '1' } });
    const data = await res.json();
    if (data.ok) {
      $('deviceDialog').close();
      showToast(`Reloj de ${data.os.label} ajustado ${fmtSigned(data.before)} · desfase residual ${fmtSigned(data.after, 2)}`, 'ok');
      measure();
      return;
    }
    const fresh = await (await fetch(systemApi('/api/system'), { cache: 'no-store' })).json();
    renderDeviceDialog(fresh, { kind: 'error', html: escapeHtml(data.error || 'No se pudo ajustar el reloj') });
  } catch (err) {
    console.error(err);
    renderDeviceDialog(sys, { kind: 'error', html: 'Error al contactar con el servidor' });
  }
}

async function copyText(button) {
  const text = button.dataset.copy;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API needs a secure context (e.g. http://192.168.x.x is not): select the text instead.
    const range = document.createRange();
    range.selectNodeContents(button.previousElementSibling);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    button.textContent = 'Selecciona y copia';
    return;
  }
  button.textContent = 'Copiado';
  setTimeout(() => { button.textContent = 'Copiar'; }, 1500);
}

async function setupDeviceSync() {
  // Hidden feature: only shown when the server accepts the access parameter in the URL.
  if (!location.search) return;
  try {
    const res = await fetch(systemApi('/api/system'), { cache: 'no-store' });
    if (!res.ok) return;
  } catch {
    return;
  }
  $('deviceRow').hidden = false;

  const dialog = $('deviceDialog');
  $('deviceBtn').addEventListener('click', openDeviceDialog);
  $('deviceClose').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (ev) => {
    if (ev.target === dialog || ev.target.closest('[data-close]')) dialog.close(); // backdrop or Cancel
    const copy = ev.target.closest('[data-copy]');
    if (copy) copyText(copy);
  });

  detectClientOs().then((info) => {
    clientOs = info;
    setText('osLabel', `${info.label} detectado`);
    if (info.mobile) {
      $('osChip').querySelector('svg').innerHTML = '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>';
    }
  });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function connectEvents() {
  const events = new EventSource('/api/events');
  events.addEventListener('status', (ev) => {
    const s = JSON.parse(ev.data);
    // The first status is covered by the measurement started in init().
    const changed = state.status && s.lastSync !== state.status.lastSync;
    applyStatus(s);
    if (changed) measure();
  });
  events.onerror = () => setPill('error', 'Conexión perdida, reintentando…');
}

function init() {
  setText('ntpZone', timeZone);
  $('syncBtn').addEventListener('click', manualSync);
  setupDeviceSync();

  const chart = $('chart');
  chart.addEventListener('pointermove', onChartMove);
  chart.addEventListener('pointerleave', onChartLeave);
  new ResizeObserver(() => renderChart()).observe(chart);

  connectEvents();
  measure();
  requestAnimationFrame(frame);

  setInterval(measure, REMEASURE_MS);
  setInterval(() => {
    renderTimes();
    // Detect a change of the system clock (or a suspended monotonic clock).
    if (state.base != null && !measuring &&
        Math.abs(Date.now() - performance.now() - state.base) > CLOCK_JUMP_MS) {
      measure();
    }
  }, 500);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') measure();
  });
}

init();
