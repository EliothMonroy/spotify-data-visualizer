// Artist images and album covers from free, key-less sources.
// Lookups send only an artist / album name. Answers (including "no image") are saved on the
// artist or album row in the database, so each one is looked up once.
//
// Artists: Deezer, then TheAudioDB (free shared key "123", ~30 requests/min)
// Albums:  Deezer, then the iTunes Search API (~20 requests/min)
import { normalize, normalizeAlbum, pickArtist, pickAlbum } from '../scripts/lib/names.mjs';
import { hasDeezerImage } from '../scripts/lib/deezer.mjs';
import { getKv } from '../scripts/lib/db.mjs';

export { normalize, normalizeAlbum, pickArtist, pickAlbum };

const MISS_RETRY_MS = 14 * 24 * 3600 * 1000; // try again for missing art after two weeks
const USER_AGENT = 'spotify-data-visualizer/1.0 (personal, local use)';
const BACKFILL_GAP_MS = 1000; // Deezer pace while `npm run credits` is running

// ---- polite per-host request queue ----

class HostQueue {
  constructor(minGapMs) {
    this.minGapMs = minGapMs;
    this.gap = () => this.minGapMs;
    this.chain = Promise.resolve();
    this.last = 0;
  }
  run(task) {
    const next = this.chain.then(async () => {
      const wait = this.last + this.gap() - Date.now();
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

// ---- database-backed lookups ----

/**
 * db: the open database. now: clock (for tests). gaps: optional per-service gaps in ms (for tests).
 * While a credits backfill is running (fresh heartbeat), Deezer lookups slow to 1 per second so the
 * two together stay under Deezer's limit.
 */
export function createArtworkService({ db, now = Date.now, gaps = {} }) {
  for (const [host, ms] of Object.entries(gaps)) queues[host].minGapMs = ms;
  queues.deezer.gap = () => {
    const beat = Number(getKv(db, 'credits_heartbeat') ?? 0);
    return now() - beat < 30000 ? Math.max(BACKFILL_GAP_MS, queues.deezer.minGapMs) : queues.deezer.minGapMs;
  };
  const inflight = new Map();
  const q = {
    artist: db.prepare('SELECT * FROM artists WHERE name = ?'),
    album: db.prepare('SELECT al.* FROM albums al JOIN artists ar ON ar.id = al.artist_id WHERE al.name = ? AND ar.name = ?'),
  };
  const save = (table, id, hit) => {
    if (hit) {
      db.prepare(`UPDATE ${table} SET image_status = 'found', image_thumb = ?, image_full = ?, image_source = ?, image_link = ?,
        image_checked_at = ? WHERE id = ?`).run(hit.thumb, hit.full, hit.source, hit.link ?? null, now(), id);
    } else {
      db.prepare(`UPDATE ${table} SET image_status = 'none', image_checked_at = ? WHERE id = ? AND (image_status IS NULL OR image_status = 'none')`).run(now(), id);
    }
  };

  async function lookup(type, artist, name, hint) {
    const table = type === 'artist' ? 'artists' : 'albums';
    const row = type === 'artist' ? q.artist.get(artist) : q.album.get(name, artist);
    if (row?.image_status === 'found' && row.image_thumb) {
      return { thumb: row.image_thumb, full: row.image_full ?? row.image_thumb, source: row.image_source, link: row.image_link };
    }
    if (row?.image_status === 'none' && now() - (row.image_checked_at ?? 0) < MISS_RETRY_MS) return null;

    const key = type === 'artist' ? `artist:${normalize(artist)}` : `album:${normalize(artist)}|${normalizeAlbum(name)}`;
    if (inflight.has(key)) return inflight.get(key);
    const providers = type === 'artist'
      ? [() => deezerArtist(artist, hint), () => audiodbArtist(artist)]
      : [() => deezerAlbum(artist, name), () => itunesAlbum(artist, name)];
    const p = (async () => {
      for (const provider of providers) {
        const hit = await provider();
        if (hit) return hit;
      }
      return null;
    })()
      .then((hit) => {
        if (row) save(table, row.id, hit);
        return hit;
      })
      .catch((err) => {
        // Network trouble: nothing is saved, so it is tried again next time.
        if (!(err instanceof TransientError)) console.warn('Artwork lookup failed:', err.message);
        return null;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  return { lookup, deezerGap: () => queues.deezer.gap() };
}
