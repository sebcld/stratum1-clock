'use strict';

// Source selection and combining in the style of chrony:
//   1. every source gets a correctness interval  offset ± root distance;
//   2. Marzullo's algorithm finds the interval agreed by the most sources and
//      sources that do not touch it are falsetickers;
//   3. the truechimer with the smallest distance is selected, and those whose
//      distance is within COMBINE_LIMIT × the best one are averaged with 1/distance weights
//      (chrony's `combinelimit`, default 3). The rest stay as backups.

const COMBINE_LIMIT = 3;

/**
 * Root distance (RFC 5905 §11.2.2): maximum error of a source's offset.
 * Half the total round trip (ours + the server's to its reference) plus the
 * server's dispersion, its clock precision and the measured jitter.
 */
function rootDistance(s) {
  return (s.delay + (s.rootDelay || 0)) / 2 + (s.rootDispersion || 0) + (s.precision || 0) + (s.jitter || 0);
}

/** Marzullo's algorithm: the [lo, hi] interval contained in the most source intervals. */
function marzullo(intervals) {
  const edges = [];
  for (const { lo, hi } of intervals) {
    edges.push({ v: lo, type: 1 });
    edges.push({ v: hi, type: -1 });
  }
  // On ties, starts go first so intervals that just touch count as overlapping.
  edges.sort((a, b) => a.v - b.v || b.type - a.type);

  let count = 0;
  let best = 0;
  let lo = 0;
  let hi = 0;
  edges.forEach((e, i) => {
    count += e.type;
    if (e.type === 1 && count > best) {
      best = count;
      lo = e.v;
      hi = edges[i + 1].v;
    }
  });
  return { count: best, lo, hi };
}

/**
 * @param {Array<{host, offset, delay, rootDelay, rootDispersion, precision, jitter}>} sources
 * @returns {{ ok: true, offset, distance, best, agreement, sources: Map } | { ok: false, error, sources: Map }}
 *   `sources` maps host → { distance, status, weight } with status one of
 *   'selected' | 'combined' | 'backup' | 'falseticker'.
 */
function selectAndCombine(sources) {
  const info = new Map();
  const intervals = sources.map((s) => {
    const distance = rootDistance(s);
    info.set(s.host, { distance, status: 'backup', weight: 0 });
    return { s, distance, lo: s.offset - distance, hi: s.offset + distance };
  });

  const agreement = marzullo(intervals);

  // Like NTP, require a majority of the sources to agree before trusting (or blaming) any of them.
  if (agreement.count <= sources.length / 2) {
    return { ok: false, error: `Sin mayoría entre servidores (${agreement.count}/${sources.length} coinciden)`, sources: info };
  }

  const truechimers = intervals.filter((iv) => iv.lo <= agreement.hi && iv.hi >= agreement.lo);
  for (const iv of intervals) {
    if (!truechimers.includes(iv)) info.get(iv.s.host).status = 'falseticker';
  }

  const best = truechimers.reduce((a, b) => (b.distance < a.distance ? b : a));
  const combined = truechimers.filter((iv) => iv.distance <= best.distance * COMBINE_LIMIT);

  let weightSum = 0;
  let offsetSum = 0;
  for (const iv of combined) {
    const w = 1 / iv.distance;
    weightSum += w;
    offsetSum += w * iv.s.offset;
  }
  for (const iv of combined) {
    const entry = info.get(iv.s.host);
    entry.status = iv === best ? 'selected' : 'combined';
    entry.weight = (1 / iv.distance) / weightSum;
  }

  return {
    ok: true,
    offset: offsetSum / weightSum,
    distance: best.distance,
    best: best.s,
    agreement: { count: agreement.count, total: sources.length, lo: agreement.lo, hi: agreement.hi },
    sources: info,
  };
}

module.exports = { selectAndCombine, rootDistance, COMBINE_LIMIT };
