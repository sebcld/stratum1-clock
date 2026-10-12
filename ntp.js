'use strict';

// Minimal SNTP client (RFC 4330 / RFC 5905 on-wire protocol) built on node:dgram.

const dgram = require('node:dgram');
const dns = require('node:dns').promises;
const crypto = require('node:crypto');

const NTP_PORT = 123;
const NTP_PACKET_SIZE = 48;
const NTP_EPOCH_OFFSET = 2208988800; // seconds between 1900-01-01 and 1970-01-01
const TWO_POW_32 = 4294967296;

/**
 * High resolution wall clock: a Date.now() anchor advanced by the monotonic
 * hrtime counter, so intervals are measured with sub-millisecond resolution.
 */
function createClock() {
  const anchorMs = Date.now();
  const anchorHr = process.hrtime.bigint();
  return () => anchorMs + Number(process.hrtime.bigint() - anchorHr) / 1e6;
}

/** Reads a 64-bit NTP timestamp and returns Unix epoch milliseconds (fractional). */
function readTimestamp(buf, offset) {
  let seconds = buf.readUInt32BE(offset);
  const fraction = buf.readUInt32BE(offset + 4);
  // NTP era 1 starts on 2036-02-07; small values mean the counter wrapped.
  if (seconds < 0x80000000) seconds += TWO_POW_32;
  return (seconds - NTP_EPOCH_OFFSET) * 1000 + (fraction * 1000) / TWO_POW_32;
}

/** Reads a 32-bit NTP short format value (16.16 fixed-point seconds) as milliseconds. */
function readShort(buf, offset) {
  return (buf.readUInt32BE(offset) / 65536) * 1000;
}

function parseRefId(buf, stratum) {
  const raw = buf.subarray(12, 16);
  if (stratum <= 1) return raw.toString('ascii').replace(/\0+$/, '').trim() || '—';
  return Array.from(raw).join('.'); // IPv4 of the upstream server
}

/**
 * Sends a single NTP request and resolves with the parsed sample.
 * Times T1/T4 come from `clock`, T2/T3 from the server.
 */
function querySample(ip, clock, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const packet = Buffer.alloc(NTP_PACKET_SIZE);
    packet[0] = (0 << 6) | (4 << 3) | 3; // LI = 0, VN = 4, Mode = 3 (client)

    // Random transmit timestamp: the server echoes it in "originate", which lets
    // us reject spoofed or stale replies without leaking our local clock.
    const nonce = crypto.randomBytes(8);
    nonce.copy(packet, 40);

    let t1 = 0;
    let done = false;
    const timer = setTimeout(() => finish(new Error('timeout')), timeoutMs);

    function finish(err, value) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.close();
      if (err) reject(err);
      else resolve(value);
    }

    socket.on('error', (err) => finish(err));
    socket.on('message', (msg) => {
      const t4 = clock();
      if (msg.length < NTP_PACKET_SIZE) return finish(new Error('respuesta truncada'));
      if (!msg.subarray(24, 32).equals(nonce)) return; // not our reply, keep waiting

      const li = msg[0] >> 6;
      const mode = msg[0] & 0x07;
      const stratum = msg[1];
      if (mode !== 4) return finish(new Error(`modo inesperado ${mode}`));
      if (stratum === 0) {
        const code = msg.subarray(12, 16).toString('ascii');
        return finish(new Error(`Kiss-o'-Death: ${code}`));
      }
      if (li === 3) return finish(new Error('servidor no sincronizado'));

      const t2 = readTimestamp(msg, 32);
      const t3 = readTimestamp(msg, 40);
      finish(null, {
        stratum,
        refid: parseRefId(msg, stratum),
        precision: Math.pow(2, msg.readInt8(3)) * 1000, // ms
        rootDelay: readShort(msg, 4),      // server's round trip to its reference (ms)
        rootDispersion: readShort(msg, 8), // server's error bound against its reference (ms)
        offset: ((t2 - t1) + (t3 - t4)) / 2,
        delay: (t4 - t1) - (t3 - t2),
        at: t4,
      });
    });

    t1 = clock();
    socket.send(packet, NTP_PORT, ip, (err) => {
      if (err) finish(err);
    });
  });
}

/** Resolves the host name and queries it once. */
async function queryServer(host, clock, { timeoutMs = 2000 } = {}) {
  const { address } = await dns.lookup(host, { family: 4 });
  const sample = await querySample(address, clock, timeoutMs);
  return { host, ip: address, ...sample };
}

module.exports = { createClock, queryServer };
