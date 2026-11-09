// Loads data/plays.json and adds per-play local-time fields for fast filtering.

export const KIND_TRACK = 0;
export const KIND_EPISODE = 1;
export const KIND_AUDIOBOOK = 2;

const DAY_MS = 86400000;
const SKIP_REASONS = new Set(['fwdbtn', 'backbtn']);

export async function loadDataset() {
  const res = await fetch('data/plays.json');
  if (res.status === 404) throw new Error('missing-data');
  if (!res.ok) throw new Error(`Could not load data (HTTP ${res.status})`);
  return prepare(await res.json());
}

export function prepare(raw) {
  const p = raw.plays;
  const n = p.ts.length;
  const itemCount = raw.items.name.length;

  const ms = Uint32Array.from(p.ms);
  const item = Int32Array.from(p.item);
  const family = Uint8Array.from(p.family);
  const device = Uint16Array.from(p.device);
  const country = Uint8Array.from(p.country);
  const rs = Uint8Array.from(p.rs);
  const re = Uint8Array.from(p.re);
  const flags = Uint8Array.from(p.flags);

  const itemCreator = Int32Array.from(raw.items.creator);
  const itemKind = Uint8Array.from(raw.items.kind);

  // Albums are grouped by album name + artist, so "Greatest Hits" by two artists stay separate.
  // Version 2 files arrive grouped already.
  const v2 = raw.version >= 2;
  const albumGroups = v2 ? raw.albums : [];
  const albumIndex = new Map();
  const itemAlbum = v2 ? Int32Array.from(raw.items.album) : new Int32Array(itemCount);
  for (let it = 0; !v2 && it < itemCount; it++) {
    const key = `${raw.items.album[it]}|${itemCreator[it]}`;
    let a = albumIndex.get(key);
    if (a === undefined) {
      a = albumGroups.length;
      albumIndex.set(key, a);
      albumGroups.push({ name: raw.albums[raw.items.album[it]], creator: itemCreator[it] });
    }
    itemAlbum[it] = a;
  }

  const skipIds = new Set(raw.reasonsEnd.map((r, i) => (SKIP_REASONS.has(r) ? i : -1)).filter((i) => i >= 0));

  const start = new Float64Array(n); // local start time, epoch ms
  const day = new Int32Array(n); // local calendar day number (days since 1970-01-01)
  const year = new Int16Array(n);
  const month = new Uint8Array(n); // 0-11
  const hour = new Uint8Array(n);
  const weekday = new Uint8Array(n); // 0 = Monday
  const creator = new Int32Array(n);
  const kind = new Uint8Array(n);
  const skip = new Uint8Array(n);

  const itemFirst = new Int32Array(itemCount).fill(-1);
  const itemTotal = new Uint32Array(itemCount);
  const albumTotal = new Uint32Array(albumGroups.length);

  for (let i = 0; i < n; i++) {
    const s = p.ts[i] * 1000 - ms[i]; // ts is when the play ended
    const d = new Date(s);
    start[i] = s;
    day[i] = Math.floor((s - d.getTimezoneOffset() * 60000) / DAY_MS);
    year[i] = d.getFullYear();
    month[i] = d.getMonth();
    hour[i] = d.getHours();
    weekday[i] = (d.getDay() + 6) % 7;
    skip[i] = skipIds.has(re[i]) ? 1 : 0;
    const it = item[i];
    if (it >= 0) {
      const c = itemCreator[it];
      creator[i] = c;
      kind[i] = itemKind[it];
      if (itemFirst[it] < 0) itemFirst[it] = i;
      if (ms[i] >= 30000) {
        itemTotal[it]++;
        albumTotal[itemAlbum[it]]++;
      }
    } else {
      creator[i] = -1;
      kind[i] = 255;
    }
  }

  let minDay = Infinity;
  let maxDay = -Infinity;
  for (let i = 0; i < n; i++) {
    if (day[i] < minDay) minDay = day[i];
    if (day[i] > maxDay) maxDay = day[i];
  }

  const D = {
    n, raw, ms, item, family, device, country, rs, re, flags,
    start, day, year, month, hour, weekday, creator, kind, skip,
    minDay, maxDay,
    items: {
      count: itemCount,
      name: raw.items.name,
      creator: itemCreator,
      album: itemAlbum,
      kind: itemKind,
      uri: raw.items.uri,
    },
    creators: raw.creators,
    creatorKind: creatorKinds(raw.creators.length, itemCreator, itemKind),
    albums: albumGroups,
    families: raw.families,
    devices: raw.devices,
    countries: raw.countries,
    reasonsStart: raw.reasonsStart,
    reasonsEnd: raw.reasonsEnd,
    itemFirst, itemTotal, albumTotal,
    extra: raw.items.extra ?? Array.from({ length: itemCount }, () => []),
    creatorImages: raw.creatorImages ?? [],
    albumImages: raw.albumImages ?? [],
    creditsInfo: raw.credits ?? null,
    stats: raw.stats,
  };
  applyCreditMode(D, 'all');
  return D;
}

/**
 * Which artists get credit for each track's plays: 'all' (Spotify's artist plus every artist found
 * on Deezer) or 'first' (Spotify's artist only, the numbers before Deezer credits existed).
 * Rebuilds the credit lists and every per-artist total that depends on them.
 */
export function applyCreditMode(D, mode) {
  const count = D.items.count;
  const credStart = new Int32Array(count + 1);
  const ids = [];
  for (let it = 0; it < count; it++) {
    credStart[it] = ids.length;
    const own = D.items.creator[it];
    ids.push(own);
    if (mode === 'all') for (const c of D.extra[it]) if (c !== own) ids.push(c);
  }
  credStart[count] = ids.length;
  D.creditMode = mode;
  D.credStart = credStart;
  D.credIds = Int32Array.from(ids);

  const creators = D.creators.length;
  const creatorFirst = new Int32Array(creators).fill(-1);
  const creatorTotal = new Uint32Array(creators);
  for (let i = 0; i < D.n; i++) {
    const it = D.item[i];
    if (it < 0) continue;
    for (let k = credStart[it]; k < credStart[it + 1]; k++) {
      const c = D.credIds[k];
      if (creatorFirst[c] < 0) creatorFirst[c] = i;
      if (D.ms[i] >= 30000) creatorTotal[c]++;
    }
  }
  // Each artist's most played track, used to identify the right artist when looking up photos
  const creatorTopItem = new Int32Array(creators).fill(-1);
  for (let it = 0; it < count; it++) {
    for (let k = credStart[it]; k < credStart[it + 1]; k++) {
      const c = D.credIds[k];
      const best = creatorTopItem[c];
      if (best < 0 || D.itemTotal[it] > D.itemTotal[best]) creatorTopItem[c] = it;
    }
  }
  D.creatorFirst = creatorFirst;
  D.creatorTotal = creatorTotal;
  D.creatorTopItem = creatorTopItem;
}

/** Artists credited with a track's plays under the current credit mode (Spotify's artist first). */
export const artistsOf = (D, it) => D.credIds.subarray(D.credStart[it], D.credStart[it + 1]);

/** Every artist on a track, for display ("Treasure Bay — Kevu, ANG"), whatever the credit mode. */
export function artistNames(D, it) {
  const own = D.items.creator[it];
  const names = [D.creators[own]];
  for (const c of D.extra[it]) if (c !== own) names.push(D.creators[c]);
  return names.join(', ');
}

function creatorKinds(count, itemCreator, itemKind) {
  const out = new Uint8Array(count);
  for (let it = 0; it < itemCreator.length; it++) out[itemCreator[it]] = itemKind[it];
  return out;
}

export function matchesKind(k, filter) {
  if (filter === 'all') return true;
  if (filter === 'music') return k === KIND_TRACK;
  return k === KIND_EPISODE || k === KIND_AUDIOBOOK;
}

/** Indices of plays inside the day range and content filter, in time order. */
export function selectPlays(D, { fromDay, toDay, kind }) {
  const out = new Int32Array(D.n);
  let k = 0;
  for (let i = 0; i < D.n; i++) {
    const d = D.day[i];
    if (d < fromDay || d > toDay) continue;
    if (!matchesKind(D.kind[i], kind)) continue;
    out[k++] = i;
  }
  return out.subarray(0, k);
}

// ---- date helpers (day numbers are local calendar days) ----
export const dayToDate = (d) => new Date(d * DAY_MS);
export const dayToISO = (d) => dayToDate(d).toISOString().slice(0, 10);
export const isoToDay = (iso) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
export const dayOfYMD = (y, m, dd) => Math.floor(Date.UTC(y, m, dd) / DAY_MS);
