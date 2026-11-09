// MusicBrainz client, the fallback for tracks Deezer doesn't have. MusicBrainz asks for at most
// about one request per second and a descriptive User-Agent; no account or key is needed.
import { TransientError } from './deezer.mjs';

const USER_AGENT = 'spotify-data-visualizer/1.0 (personal, local use)';
const luceneQuote = (s) => `"${String(s).replace(/(["\\])/g, '\\$1')}"`;

/** The title to search for: without "(feat. …)", "[…]" or a trailing " - Radio Edit". */
export function queryTitle(title) {
  const t = String(title ?? '').replace(/\s*[([][^)\]]*[)\]]/g, '').replace(/\s+-\s+.*$/, '').trim();
  return t || String(title ?? '').trim();
}

const BUSY_WAIT_MS = 2000;
const TRIES = 5;

/**
 * MusicBrainz answers "busy" (503) now and then even at the allowed pace, usually with
 * "Retry-After: 0". Those are retried after a short wait (or as long as it asks) rather than
 * slowing the whole run down.
 */
export function createMusicBrainz({
  limiter,
  fetch = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  base = 'https://musicbrainz.org/ws/2',
}) {
  let requests = 0;

  async function get(path) {
    for (let attempt = 0; attempt < TRIES; attempt++) {
      let res;
      try {
        res = await limiter.run(async () => {
          requests++;
          const r = await fetch(base + path, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
          return { status: r.status, text: await r.text(), retryAfter: Number(r.headers?.get?.('retry-after')) || 0 };
        });
      } catch (err) {
        // MusicBrainz is sometimes very slow to answer; try again rather than give up on the track.
        if (err?.name === 'TimeoutError' && attempt < TRIES - 1) { await sleep(BUSY_WAIT_MS); continue; }
        throw new TransientError(`MusicBrainz: ${err.message}`);
      }
      if (res.status === 503 || res.status === 429 || res.status >= 500) {
        await sleep(Math.max(BUSY_WAIT_MS, res.retryAfter * 1000));
        continue;
      }
      if (res.status !== 200) throw new TransientError(`MusicBrainz: HTTP ${res.status}`);
      let json;
      try {
        json = JSON.parse(res.text);
      } catch {
        throw new TransientError('MusicBrainz: answer was not JSON');
      }
      if (!json || typeof json !== 'object' || json.error) throw new TransientError(`MusicBrainz: ${json?.error ?? 'empty answer'}`);
      return json;
    }
    throw new TransientError(`MusicBrainz: still busy after ${TRIES} tries`);
  }

  return {
    async searchRecordings(artist, title) {
      const query = `recording:${luceneQuote(title)} AND artist:${luceneQuote(artist)}`;
      return (await get(`/recording?query=${encodeURIComponent(query)}&fmt=json&limit=10`)).recordings ?? [];
    },
    requests: () => requests,
  };
}
