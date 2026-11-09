// Artist images and album covers from free, key-less sources.
// Lookups send only an artist / album name. Results (including misses) are cached on disk
// so each name is looked up once.
//
// Artists: Deezer, then TheAudioDB (free shared key "123", ~30 requests/min)
// Albums:  Deezer, then the iTunes Search API (~20 requests/min)
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const MISS_RETRY_MS = 14 * 24 * 3600 * 1000; // try again for missing art after two weeks
const USER_AGENT = 'spotify-data-visualizer/1.0 (personal, local use)';

import { normalize, normalizeAlbum, pickArtist, pickAlbum } from '../scripts/lib/names.mjs';

export { normalize, normalizeAlbum, pickArtist, pickAlbum };

// ---- polite per-host request queue ----

class HostQueue {
  constructor(minGapMs) {
    this.minGapMs = minGapMs;
    this.chain = Promise.resolve();
    this.last = 0;
  }
  run(task) {
    const next = this.chain.then(async () => {
      const wait = this.last + this.minGapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        return await task();
      } finally {
        this.last = Date.now();
      }
    });
    this.chain = next.catch(() => {});
    return next;
  }
}

const queues = {
  deezer: new HostQueue(120),
  audiodb: new HostQueue(2100),
  itunes: new HostQueue(3100),
};

class TransientError extends Error {}

async function getJSON(host, url) {
  return queues[host].run(async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      let res;
      try {
        res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
      } catch (err) {
        throw new TransientError(`${host}: ${err.message}`);
      }
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      if (!res.ok) throw new TransientError(`${host}: HTTP ${res.status}`);
      const text = await res.text();
      const json = text.trim() ? JSON.parse(text) : {};
      if (json?.error?.code === 4) { // Deezer quota exceeded
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      return json;
    }
    throw new TransientError(`${host}: rate limited`);
  });
}

const enc = encodeURIComponent;
const hasDeezerImage = (url) => url && !/\/images\/(artist|cover)\/\//.test(url);

// ---- providers ----

const deezerArtistArt = (a) => (a && hasDeezerImage(a.picture_big)
  ? { thumb: a.picture_medium, full: a.picture_xl ?? a.picture_big, source: 'Deezer', link: a.link ?? `https://www.deezer.com/artist/${a.id}` }
  : null);

/**
 * Names like "ANG" match several Deezer artists. Searching for one of the listener's own
 * tracks by that artist finds the right one; otherwise prefer the exact name with most fans.
 */
async function deezerArtist(name, hint) {
  if (hint) {
    const j = await getJSON('deezer', `https://api.deezer.com/search/track?q=${enc(`${name} ${hint}`)}&limit=15`);
    const track = (j.data ?? []).find((t) => normalize(t.artist?.name) === normalize(name));
    const art = deezerArtistArt(track?.artist);
    if (art) return art;
  }
  const j = await getJSON('deezer', `https://api.deezer.com/search/artist?q=${enc(name)}&limit=25`);
  return deezerArtistArt(pickArtist(j.data, name));
}

async function audiodbArtist(name) {
  const j = await getJSON('audiodb', `https://www.theaudiodb.com/api/v1/json/123/search.php?s=${enc(name)}`);
  const hit = pickArtist(j.artists, name, (r) => r.strArtist);
  if (!hit?.strArtistThumb) return null;
  return { thumb: `${hit.strArtistThumb}/preview`, full: hit.strArtistThumb, source: 'TheAudioDB', link: `https://www.theaudiodb.com/artist/${hit.idArtist}` };
}

async function deezerAlbum(artist, album) {
  const q = `artist:"${artist}" album:"${normalizeAlbum(album) || album}"`;
  let j = await getJSON('deezer', `https://api.deezer.com/search/album?q=${enc(q)}&limit=10`);
  let hit = pickAlbum(j.data, artist, album, { artistOf: (r) => r.artist?.name, titleOf: (r) => r.title });
  if (!hit) {
    j = await getJSON('deezer', `https://api.deezer.com/search/album?q=${enc(`${artist} ${album}`)}&limit=10`);
    hit = pickAlbum(j.data, artist, album, { artistOf: (r) => r.artist?.name, titleOf: (r) => r.title });
  }
  if (!hit || !hasDeezerImage(hit.cover_big)) return null;
  return { thumb: hit.cover_medium, full: hit.cover_xl ?? hit.cover_big, source: 'Deezer', link: hit.link };
}

async function itunesAlbum(artist, album) {
  const j = await getJSON('itunes', `https://itunes.apple.com/search?term=${enc(`${artist} ${album}`)}&entity=album&limit=10`);
  const hit = pickAlbum(j.results, artist, album, { artistOf: (r) => r.artistName, titleOf: (r) => r.collectionName });
  if (!hit?.artworkUrl100) return null;
  return {
    thumb: hit.artworkUrl100.replace('100x100bb', '200x200bb'),
    full: hit.artworkUrl100.replace('100x100bb', '600x600bb'),
    source: 'iTunes',
    link: hit.collectionViewUrl,
  };
}

// ---- cache + public API ----

export function createArtworkService({ cacheFile }) {
  let cache = new Map();
  const inflight = new Map();
  let saveTimer = null;

  const loaded = readFile(cacheFile, 'utf8')
    .then((txt) => { cache = new Map(Object.entries(JSON.parse(txt))); })
    .catch(() => {});

  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await mkdir(dirname(cacheFile), { recursive: true });
        await writeFile(cacheFile, JSON.stringify(Object.fromEntries(cache)));
      } catch (err) {
        console.warn('Could not save artwork cache:', err.message);
      }
    }, 2000);
  };

  async function resolve(key, providers) {
    for (const p of providers) {
      const hit = await p();
      if (hit) return hit;
    }
    return null;
  }

  async function lookup(type, artist, name, hint) {
    await loaded;
    const key = type === 'artist' ? `artist:${normalize(artist)}` : `album:${normalize(artist)}|${normalizeAlbum(name)}`;
    const cached = cache.get(key);
    if (cached && (!cached.miss || Date.now() - cached.t < MISS_RETRY_MS)) return cached.miss ? null : cached;
    if (inflight.has(key)) return inflight.get(key);

    const providers = type === 'artist'
      ? [() => deezerArtist(artist, hint), () => audiodbArtist(artist)]
      : [() => deezerAlbum(artist, name), () => itunesAlbum(artist, name)];

    const p = resolve(key, providers)
      .then((hit) => {
        cache.set(key, hit ? { ...hit, t: Date.now() } : { miss: true, t: Date.now() });
        save();
        return hit;
      })
      .catch((err) => {
        // Network trouble: don't cache, so it is retried next time.
        if (!(err instanceof TransientError)) console.warn('Artwork lookup failed:', err.message);
        return null;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  return { lookup, size: () => cache.size };
}
