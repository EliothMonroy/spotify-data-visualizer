import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter, createDeezer, TransientError } from '../scripts/lib/deezer.mjs';

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; }, advance: (ms) => { t += ms; } };
}

test('the limiter never starts more than max requests in any window', async () => {
  const clock = fakeClock();
  const limiter = createLimiter({ max: 40, windowMs: 5000, concurrency: 4, now: clock.now, sleep: clock.sleep });
  const starts = [];
  await Promise.all(Array.from({ length: 100 }, () => limiter.run(async () => { starts.push(clock.now()); clock.advance(10); })));
  assert.equal(starts.length, 100);
  for (let i = 0; i < starts.length; i++) {
    const inWindow = starts.filter((s) => s >= starts[i] && s < starts[i] + 5000).length;
    assert.ok(inWindow <= 40, `${inWindow} starts within 5 s of ${starts[i]}`);
  }
});

test('the limiter keeps at most `concurrency` tasks running', async () => {
  const limiter = createLimiter({ max: 1000, concurrency: 3 });
  let running = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: 12 }, () => limiter.run(async () => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 2));
    running--;
  })));
  assert.equal(peak, 3);
});

test('slowDown halves the rate (never below 10) and pauses new requests', async () => {
  const clock = fakeClock();
  const limiter = createLimiter({ max: 40, now: clock.now, sleep: clock.sleep });
  limiter.slowDown();
  assert.equal(limiter.stats().max, 20);
  let startedAt = -1;
  await limiter.run(async () => { startedAt = clock.now(); });
  assert.ok(startedAt >= 10000, 'waits out the pause');
  limiter.slowDown();
  limiter.slowDown();
  assert.equal(limiter.stats().max, 10);
});

const response = (status, body) => ({ status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const quickLimiter = () => {
  const clock = fakeClock();
  return createLimiter({ max: 1000, now: clock.now, sleep: clock.sleep });
};

test('a Deezer quota error is retried after slowing down', async () => {
  const limiter = quickLimiter();
  let slowed = 0;
  const slowDown = limiter.slowDown;
  limiter.slowDown = () => { slowed++; slowDown(); };
  const answers = [response(200, { error: { type: 'Exception', message: 'Quota limit exceeded', code: 4 } }), response(200, { data: [{ id: 1 }] })];
  const deezer = createDeezer({ limiter, fetch: async () => answers.shift() });
  assert.deepEqual(await deezer.searchTracks('x'), [{ id: 1 }]);
  assert.equal(slowed, 1);
  assert.equal(deezer.requests(), 2);
});

test('repeated quota errors, HTTP errors and non-JSON answers are transient, never "not found"', async () => {
  const quota = response(200, { error: { code: 4 } });
  await assert.rejects(createDeezer({ limiter: quickLimiter(), fetch: async () => quota }).searchTracks('x'), TransientError);
  await assert.rejects(createDeezer({ limiter: quickLimiter(), fetch: async () => response(429, '') }).track(1), TransientError);
  await assert.rejects(createDeezer({ limiter: quickLimiter(), fetch: async () => response(200, '<html>busy</html>') }).track(1), TransientError);
  await assert.rejects(createDeezer({ limiter: quickLimiter(), fetch: async () => { throw new Error('ECONNRESET'); } }).track(1), TransientError);
});
