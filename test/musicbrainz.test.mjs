import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter, TransientError } from '../scripts/lib/deezer.mjs';
import { createMusicBrainz, queryTitle } from '../scripts/lib/musicbrainz.mjs';

const clockLimiter = () => {
  let t = 0;
  return createLimiter({ max: 1000, min: 1, now: () => t, sleep: async (ms) => { t += ms; } });
};
const response = (status, body) => ({ status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

test('queryTitle searches by the title without version suffixes', () => {
  assert.equal(queryTitle('Got You - Fuero Radio Edit'), 'Got You');
  assert.equal(queryTitle('Nothing Can Hold Us Down (feat. Haris)'), 'Nothing Can Hold Us Down');
  assert.equal(queryTitle("L'Amour Toujours"), "L'Amour Toujours");
  assert.equal(queryTitle('(Intro)'), '(Intro)', 'keeps titles that are only brackets');
});

test('searchRecordings sends a quoted artist and title query and returns recordings', async () => {
  let url;
  const mb = createMusicBrainz({ limiter: clockLimiter(), fetch: async (u) => { url = u; return response(200, { recordings: [{ id: 'r1' }] }); } });
  assert.deepEqual(await mb.searchRecordings('TJR', 'Bounce "Generation"'), [{ id: 'r1' }]);
  const q = decodeURIComponent(new URL(url).searchParams.get('query'));
  assert.equal(q, 'recording:"Bounce \\"Generation\\"" AND artist:"TJR"');
  assert.equal(mb.requests(), 1);
});

test('a busy answer (503) is retried after a short wait, without slowing the whole run', async () => {
  const limiter = clockLimiter();
  let slowed = 0;
  limiter.slowDown = () => { slowed++; };
  const waits = [];
  const answers = [response(503, 'busy'), response(503, 'busy'), response(200, { recordings: [] })];
  const mb = createMusicBrainz({ limiter, fetch: async () => answers.shift(), sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(await mb.searchRecordings('A', 'B'), []);
  assert.deepEqual(waits, [2000, 2000]);
  assert.equal(slowed, 0);
});

test('MusicBrainz asking to wait longer (Retry-After) is respected', async () => {
  const waits = [];
  const answers = [{ ...response(503, ''), headers: new Headers({ 'retry-after': '7' }) }, response(200, { recordings: [] })];
  const mb = createMusicBrainz({ limiter: clockLimiter(), fetch: async () => answers.shift(), sleep: async (ms) => { waits.push(ms); } });
  await mb.searchRecordings('A', 'B');
  assert.deepEqual(waits, [7000]);
});

test('repeated 503s, other errors and non-JSON answers are temporary failures', async () => {
  const noWait = async () => {};
  await assert.rejects(createMusicBrainz({ limiter: clockLimiter(), fetch: async () => response(503, ''), sleep: noWait }).searchRecordings('A', 'B'), TransientError);
  await assert.rejects(createMusicBrainz({ limiter: clockLimiter(), fetch: async () => response(400, '{}') }).searchRecordings('A', 'B'), TransientError);
  await assert.rejects(createMusicBrainz({ limiter: clockLimiter(), fetch: async () => response(200, '<html>') }).searchRecordings('A', 'B'), TransientError);
  await assert.rejects(createMusicBrainz({ limiter: clockLimiter(), fetch: async () => response(200, 'null') }).searchRecordings('A', 'B'), TransientError);
});

test('a request that times out is tried again in the same run', async () => {
  let calls = 0;
  const fetch = async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    return response(200, { recordings: [{ id: 'r1' }] });
  };
  const mb = createMusicBrainz({ limiter: clockLimiter(), fetch, sleep: async () => {} });
  assert.deepEqual(await mb.searchRecordings('A', 'B'), [{ id: 'r1' }]);
  assert.equal(calls, 2);
});
