// Aggregations over a selection of play indices. All functions are pure.
import { dayToDate } from './data.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function summarize(D, idx, minMs) {
  let ms = 0, plays = 0, skips = 0, tracks = 0, artists = 0;
  const seenItem = new Uint8Array(D.items.count);
  const seenCreator = new Uint8Array(D.creators.length);
  const days = new Set();
  for (let j = 0; j < idx.length; j++) {
    const i = idx[j];
    ms += D.ms[i];
    days.add(D.day[i]);
    if (D.skip[i]) skips++;
    if (D.ms[i] < minMs) continue;
    plays++;
    const it = D.item[i];
    if (it >= 0 && !seenItem[it]) { seenItem[it] = 1; tracks++; }
    const c = D.creator[i];
    if (c >= 0 && !seenCreator[c]) { seenCreator[c] = 1; artists++; }
  }
  return {
    ms, plays, skips, tracks, artists,
    rows: idx.length,
    activeDays: days.size,
    firstDay: idx.length ? D.day[idx[0]] : null,
    lastDay: idx.length ? D.day[idx[idx.length - 1]] : null,
  };
}

/** Pick a time bucket that keeps charts readable for the selected span. */
export function pickUnit(fromDay, toDay) {
  return toDay - fromDay > 120 ? 'month' : 'day';
}

function bucketKey(D, i, unit) {
  if (unit === 'year') return D.year[i];
  if (unit === 'month') return D.year[i] * 12 + D.month[i];
  return D.day[i];
}

export function bucketLabel(key, unit) {
  if (unit === 'year') return String(key);
  if (unit === 'month') return `${MONTHS[key % 12]} ${Math.floor(key / 12)}`;
  return dayToDate(key).toLocaleDateString(undefined, { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
}

function bucketRange(D, idx, unit) {
  if (!idx.length) return [];
  const a = bucketKey(D, idx[0], unit);
  const b = bucketKey(D, idx[idx.length - 1], unit);
  const keys = [];
  for (let k = Math.min(a, b); k <= Math.max(a, b); k++) keys.push(k);
  return keys;
}

/** Listening time and play count per time bucket, with empty buckets filled in. */
export function timeline(D, idx, minMs, unit) {
  const keys = bucketRange(D, idx, unit);
  const base = keys[0] ?? 0;
  const ms = new Float64Array(keys.length);
  const plays = new Uint32Array(keys.length);
  for (let j = 0; j < idx.length; j++) {
    const i = idx[j];
    const k = bucketKey(D, i, unit) - base;
    ms[k] += D.ms[i];
    if (D.ms[i] >= minMs) plays[k]++;
  }
  return { keys, labels: keys.map((k) => bucketLabel(k, unit)), ms: Array.from(ms), plays: Array.from(plays) };
}

// ---- grouping by track / artist / album ----

export function entityKeyFn(D, by) {
  if (by === 'track') return (i) => D.item[i];
  if (by === 'artist') return (i) => D.creator[i];
  return (i) => (D.item[i] >= 0 ? D.items.album[D.item[i]] : -1);
}

export function entityCount(D, by) {
  if (by === 'track') return D.items.count;
  if (by === 'artist') return D.creators.length;
  return D.albums.length;
}

export function entityLabel(D, by, id) {
  if (by === 'track') return { name: D.items.name[id], sub: D.creators[D.items.creator[id]] };
  if (by === 'artist') return { name: D.creators[id], sub: '' };
  const a = D.albums[id];
  return { name: a.name, sub: D.creators[a.creator] };
}

/**
 * Per-entity stats: plays (>= minMs), listening time, skips, first/last day,
 * distinct days, and (for artists/albums) distinct tracks.
 */
export function groupStats(D, idx, minMs, by) {
  const size = entityCount(D, by);
  const key = entityKeyFn(D, by);
  const plays = new Uint32Array(size);
  const ms = new Float64Array(size);
  const skips = new Uint32Array(size);
  const rows = new Uint32Array(size);
  const first = new Int32Array(size).fill(-1);
  const last = new Int32Array(size);
  const days = new Uint32Array(size);
  const lastSeenDay = new Int32Array(size).fill(-1);
  const trackSets = by === 'track' ? null : new Map();

  for (let j = 0; j < idx.length; j++) {
    const i = idx[j];
    const id = key(i);
    if (id < 0) continue;
    rows[id]++;
    ms[id] += D.ms[i];
    if (D.skip[i]) skips[id]++;
    const d = D.day[i];
    if (first[id] < 0) first[id] = d;
    last[id] = d;
    if (lastSeenDay[id] !== d) { lastSeenDay[id] = d; days[id]++; }
    if (D.ms[i] >= minMs) {
      plays[id]++;
      if (trackSets) {
        let s = trackSets.get(id);
        if (!s) trackSets.set(id, (s = new Set()));
        s.add(D.item[i]);
      }
    }
  }

  const out = [];
  for (let id = 0; id < size; id++) {
    if (!rows[id]) continue;
    out.push({
      id, plays: plays[id], ms: ms[id], skips: skips[id], rows: rows[id],
      first: first[id], last: last[id], days: days[id],
      tracks: trackSets ? (trackSets.get(id)?.size ?? 0) : 1,
    });
  }
  out.sort((a, b) => b.plays - a.plays || b.ms - a.ms);
  return out;
}

// ---- repeat behaviour ----

/** Longest run of the same track played back to back (short plays are ignored). */
export function longestStreaks(D, idx, minMs, limit = 15) {
  const best = new Map(); // item -> { len, day }
  let prev = -1, len = 0, startDay = 0;
  const flush = () => {
    if (prev < 0 || len < 2) return;
    const b = best.get(prev);
    if (!b || len > b.len) best.set(prev, { len, day: startDay });
  };
  for (let j = 0; j < idx.length; j++) {
    const i = idx[j];
    if (D.ms[i] < minMs) continue;
    const it = D.item[i];
    if (it === prev) { len++; continue; }
    flush();
    prev = it; len = 1; startDay = D.day[i];
  }
  flush();
  return [...best.entries()]
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.len - a.len || a.day - b.day)
    .slice(0, limit);
}

/** Most plays of a single track within one day. */
export function mostPlaysInADay(D, idx, minMs, limit = 15) {
  const counts = new Map();
  const SPAN = 1 << 15;
  for (let j = 0; j < idx.length; j++) {
    const i = idx[j];
    if (D.ms[i] < minMs || D.item[i] < 0) continue;
    const k = D.item[i] * SPAN + (D.day[i] - D.minDay);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const best = new Map();
  for (const [k, c] of counts) {
    const id = Math.floor(k / SPAN);
    const day = (k % SPAN) + D.minDay;
    const b = best.get(id);
    if (!b || c > b.count) best.set(id, { count: c, day });
  }
  return [...best.entries()]
    .map(([id, v]) => ({ id, ...v }))
    .filter((r) => r.count > 1)
    .sort((a, b) => b.count - a.count || a.day - b.day)
    .slice(0, limit);
}

export const PLAY_BUCKETS = [
  [1, 1, '1'], [2, 5, '2–5'], [6, 10, '6–10'], [11, 25, '11–25'],
  [26, 50, '26–50'], [51, 100, '51–100'], [101, 250, '101–250'], [251, Infinity, '251+'],
];

/** How many tracks were played N times. */
export function playCountDistribution(trackStats) {
  const counts = PLAY_BUCKETS.map(() => 0);
  for (const t of trackStats) {
    if (!t.plays) continue;
    const b = PLAY_BUCKETS.findIndex(([lo, hi]) => t.plays >= lo && t.plays <= hi);
    counts[b]++;
  }
  return PLAY_BUCKETS.map(([, , label], i) => ({ label, count: counts[i] }));
}

/** Artists that show up in the most distinct years. */
export function loyalArtists(D, idx, minMs, limit = 15) {
  const years = new Map(); // creator -> Set(year)
  const plays = new Map();
  for (let j = 0; j < idx.length; j++) {
    const i = idx[j];
    const c = D.creator[i];
    if (c < 0 || D.ms[i] < minMs) continue;
    let s = years.get(c);
    if (!s) years.set(c, (s = new Set()));
    s.add(D.year[i]);
    plays.set(c, (plays.get(c) ?? 0) + 1);
  }
  return [...years.entries()]
    .map(([id, s]) => ({ id, years: s.size, plays: plays.get(id), span: [Math.min(...s), Math.max(...s)] }))
    .sort((a, b) => b.years - a.years || b.plays - a.plays)
    .slice(0, limit);
}

// ---- habits ----

export function weekHourMatrix(D, idx) {
  const m = Array.from({ length: 7 }, () => new Float64Array(24));
  for (let j = 0; j < idx.length; j++) {
    const i = idx[j];
    m[D.weekday[i]][D.hour[i]] += D.ms[i];
  }
  return m;
}

export function msByDay(D, idx) {
  const out = new Map();
  for (let j = 0; j < idx.length; j++) {
    const i = idx[j];
    out.set(D.day[i], (out.get(D.day[i]) ?? 0) + D.ms[i]);
  }
  return out;
}

export function msByMonthOfYear(D, idx) {
  const out = new Float64Array(12);
  const years = new Set();
  for (let j = 0; j < idx.length; j++) {
    const i = idx[j];
    out[D.month[i]] += D.ms[i];
    years.add(D.year[i]);
  }
  return { ms: Array.from(out), years: years.size };
}

// ---- discovery ----

/** New artists and tracks (first time ever played) per time bucket. */
export function discoveries(D, idx, unit) {
  const keys = bucketRange(D, idx, unit);
  const base = keys[0] ?? 0;
  const artists = new Uint32Array(keys.length);
  const tracks = new Uint32Array(keys.length);
  for (let j = 0; j < idx.length; j++) {
    const i = idx[j];
    const it = D.item[i];
    if (it < 0) continue;
    const k = bucketKey(D, i, unit) - base;
    if (D.itemFirst[it] === i) tracks[k]++;
    if (D.creatorFirst[D.creator[i]] === i) artists[k]++;
  }
  return { keys, labels: keys.map((k) => bucketLabel(k, unit)), artists: Array.from(artists), tracks: Array.from(tracks) };
}

/** Listening time per bucket for a fixed set of entity ids. */
export function entityTimelines(D, idx, by, ids, unit) {
  return timelinesBy(D, idx, entityKeyFn(D, by), ids, unit);
}

/** Listening time per bucket for each id returned by key(i); other ids are ignored. */
export function timelinesBy(D, idx, key, ids, unit) {
  const keys = bucketRange(D, idx, unit);
  const base = keys[0] ?? 0;
  const pos = new Map(ids.map((id, n) => [id, n]));
  const series = ids.map(() => new Float64Array(keys.length));
  for (let j = 0; j < idx.length; j++) {
    const i = idx[j];
    const n = pos.get(key(i));
    if (n === undefined) continue;
    series[n][bucketKey(D, i, unit) - base] += D.ms[i];
  }
  return { keys, labels: keys.map((k) => bucketLabel(k, unit)), series: series.map((s) => Array.from(s)) };
}

/** Split a selection into per-year selections. */
export function splitByYear(D, idx) {
  const out = new Map();
  for (let j = 0; j < idx.length; j++) {
    const i = idx[j];
    const y = D.year[i];
    let arr = out.get(y);
    if (!arr) out.set(y, (arr = []));
    arr.push(i);
  }
  return [...out.entries()].sort((a, b) => a[0] - b[0]).map(([y, a]) => [y, Int32Array.from(a)]);
}

/** Count plays and time per value of a per-play column (device, country, reason...). */
export function countBy(D, idx, column, minMs) {
  const col = D[column];
  const ms = new Map();
  const plays = new Map();
  for (let j = 0; j < idx.length; j++) {
    const i = idx[j];
    const v = col[i];
    ms.set(v, (ms.get(v) ?? 0) + D.ms[i]);
    if (D.ms[i] >= minMs) plays.set(v, (plays.get(v) ?? 0) + 1);
  }
  return [...ms.entries()]
    .map(([id, m]) => ({ id, ms: m, plays: plays.get(id) ?? 0, rows: 0 }))
    .sort((a, b) => b.ms - a.ms);
}

/** Count raw rows per value (used for how plays start and end). */
export function countRows(D, idx, column) {
  const col = D[column];
  const c = new Map();
  for (let j = 0; j < idx.length; j++) c.set(col[idx[j]], (c.get(col[idx[j]]) ?? 0) + 1);
  return [...c.entries()].map(([id, rows]) => ({ id, rows })).sort((a, b) => b.rows - a.rows);
}

export function flagShares(D, idx) {
  let shuffle = 0, offline = 0, incognito = 0;
  for (let j = 0; j < idx.length; j++) {
    const f = D.flags[idx[j]];
    if (f & 1) shuffle++;
    if (f & 4) offline++;
    if (f & 8) incognito++;
  }
  const n = idx.length || 1;
  return { shuffle: shuffle / n, offline: offline / n, incognito: incognito / n };
}
