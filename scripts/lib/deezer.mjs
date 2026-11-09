// Deezer API client for the artist credits backfill, with a rate limiter that keeps well under
// Deezer's limit (commonly reported as 50 requests per 5 seconds).

const USER_AGENT = 'spotify-data-visualizer/1.0 (personal, local use)';
const enc = encodeURIComponent;

/** Network trouble or rate limiting: the answer is unknown, so nothing should be saved. */
export class TransientError extends Error {}

/** False for Deezer's grey placeholder images (".../images/artist//..."). */
export const hasDeezerImage = (url) => Boolean(url) && !/\/images\/(artist|cover)\/\//.test(url);

/**
 * Sliding-window limiter: at most `max` task starts in any `windowMs`, and at most `concurrency`
 * tasks running at once. slowDown() halves the rate and pauses for 10 s; the rate then recovers by
 * 5 per minute without errors.
 */
export function createLimiter({
  max = 40,
  windowMs = 5000,
  concurrency = 4,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const fullMax = max;
  let current = max;
  let pausedUntil = 0;
  let lastChange = now();
  let active = 0;
  let pumping = false;
  let started = 0;
  const starts = [];
  const queue = [];

  function recover() {
    if (current < fullMax && now() - lastChange >= 60000) {
      current = Math.min(fullMax, current + 5);
      lastChange = now();
    }
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length && active < concurrency) {
        recover();
        const t = now();
        if (pausedUntil > t) { await sleep(pausedUntil - t); continue; }
        while (starts.length && starts[0] <= t - windowMs) starts.shift();
        if (starts.length >= current) { await sleep(starts[0] + windowMs - t); continue; }
        starts.push(t);
        active++;
        started++;
        const { task, resolve, reject } = queue.shift();
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => { active--; pump(); });
      }
    } finally {
      pumping = false;
    }
  }

  return {
    run(task) {
      return new Promise((resolve, reject) => {
        queue.push({ task, resolve, reject });
        pump();
      });
    },
    slowDown() {
      current = Math.max(10, Math.floor(current / 2));
      pausedUntil = now() + 10000;
      lastChange = now();
    },
    stats: () => ({ max: current, started, active, waiting: queue.length }),
  };
}

export function createDeezer({ limiter, fetch = globalThis.fetch, base = 'https://api.deezer.com' }) {
  let requests = 0;

  async function get(path) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let res;
      try {
        res = await limiter.run(async () => {
          requests++;
          const r = await fetch(base + path, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
          return { status: r.status, text: await r.text() };
        });
      } catch (err) {
        throw new TransientError(`Deezer: ${err.message}`);
      }
      if (res.status === 429 || res.status >= 500) { limiter.slowDown(); continue; }
      if (res.status !== 200) throw new TransientError(`Deezer: HTTP ${res.status}`);
      let json;
      try {
        json = JSON.parse(res.text);
      } catch {
        throw new TransientError('Deezer: answer was not JSON');
      }
      if (json?.error) {
        if (json.error.code === 4) { limiter.slowDown(); continue; } // quota exceeded
        throw new TransientError(`Deezer: ${json.error.message ?? 'error'} (code ${json.error.code})`);
      }
      return json;
    }
    throw new TransientError('Deezer: still rate limited after 3 tries');
  }

  return {
    searchTracks: async (q) => (await get(`/search/track?q=${enc(q)}&limit=10`)).data ?? [],
    track: (id) => get(`/track/${Number(id)}`),
    requests: () => requests,
  };
}
