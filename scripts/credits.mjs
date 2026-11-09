#!/usr/bin/env node
// Checks each track on Deezer for every artist credited on it (e.g. Treasure Bay: Kevu *and* ANG),
// most played tracks first. Safe to stop with Ctrl+C and run again: checked tracks are skipped.
// Usage: node scripts/credits.mjs [--top N] [--retry-missing]
// Tip (macOS): caffeinate -i npm run credits   keeps the Mac awake while it runs.
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, setKv } from './lib/db.mjs';
import { writeDataset } from './lib/export.mjs';
import { createLimiter, createDeezer, TransientError } from './lib/deezer.mjs';
import { checkTrack, tracksToCheck } from './lib/credits.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB_FILE = join(root, 'data', 'spotify.db');
const DATA_FILE = join(root, 'data', 'plays.json');
const args = process.argv.slice(2);
const topIndex = args.indexOf('--top');
const top = topIndex >= 0 ? Number(args[topIndex + 1]) : 0;
if (topIndex >= 0 && !(top > 0)) {
  console.error('--top needs a number, e.g. --top 16000');
  process.exit(1);
}
const WORKERS = 4;
const MAX_ERRORS_IN_A_ROW = 25;

const db = openDb(DB_FILE);
const queue = tracksToCheck(db, { top, retryMissing: args.includes('--retry-missing') });
const totals = db.prepare(`SELECT sum(c.n) AS all_plays, sum(CASE WHEN t.deezer_status IS NOT NULL THEN c.n ELSE 0 END) AS covered
  FROM tracks t JOIN (SELECT m.track_id, count(*) AS n FROM plays p JOIN meta m ON m.id = p.meta_id
  WHERE p.ms_played >= 30000 GROUP BY m.track_id) c ON c.track_id = t.id WHERE t.kind = 0`).get();

if (!queue.length) {
  console.log('All tracks have been checked already (use --retry-missing to try the ones Deezer did not have again).');
  process.exit(0);
}

const limiter = createLimiter({ max: 40, windowMs: 5000, concurrency: WORKERS });
const deezer = createDeezer({ limiter });
const started = Date.now();
const counts = { done: 0, found: 0, missing: 0, errors: 0 };
let covered = totals.covered ?? 0;
let errorsInARow = 0;
let stopping = false;
let next = 0;

const fmtDuration = (ms) => {
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
};
const pct = (x) => `${(100 * x).toFixed(1)}%`;

function progressLine() {
  const elapsed = Date.now() - started;
  const rate = deezer.requests() / Math.max(1, elapsed / 1000);
  const left = counts.done ? ((queue.length - counts.done) * elapsed) / counts.done : 0;
  return `${counts.done.toLocaleString()} / ${queue.length.toLocaleString()} tracks · ` +
    `${pct(covered / Math.max(1, totals.all_plays))} of plays covered · ${counts.found.toLocaleString()} found · ` +
    `${counts.missing.toLocaleString()} not found · ${counts.errors.toLocaleString()} errors · ` +
    `${rate.toFixed(1)} req/s · ${counts.done ? `~${fmtDuration(left)} left` : 'starting…'}`;
}

const tty = process.stdout.isTTY;
const draw = () => (tty ? process.stdout.write(`\r${progressLine()}\x1b[K`) : console.log(progressLine()));
const progressTimer = setInterval(draw, tty ? 500 : 30000);
const heartbeat = () => setKv(db, 'credits_heartbeat', Date.now());
heartbeat();
const heartbeatTimer = setInterval(heartbeat, 10000);

async function worker() {
  while (!stopping && next < queue.length) {
    const track = queue[next++];
    try {
      const result = await checkTrack(db, deezer, track);
      if (result === 'matched') counts.found++;
      else counts.missing++;
      if (track.status === null) covered += track.plays; // retried tracks were already counted
      errorsInARow = 0;
    } catch (err) {
      if (!(err instanceof TransientError)) throw err;
      counts.errors++;
      if (++errorsInARow >= MAX_ERRORS_IN_A_ROW && !stopping) {
        stopping = true;
        process.stdout.write('\n');
        console.error(`Stopping: ${MAX_ERRORS_IN_A_ROW} lookups in a row failed (last: ${err.message}). Check your connection and run again.`);
      }
    }
    counts.done++;
  }
}

let interrupted = false;
process.on('SIGINT', () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  stopping = true;
  process.stdout.write('\nStopping after the lookups in progress… (Ctrl+C again to quit right away)\n');
});

const workers = Promise.all(Array.from({ length: WORKERS }, worker));
await (interrupted ? Promise.race([workers, new Promise((r) => setTimeout(r, 15000))]) : workers);

clearInterval(progressTimer);
clearInterval(heartbeatTimer);
draw();
if (tty) process.stdout.write('\n');
setKv(db, 'credits_heartbeat', 0);
const dataset = await writeDataset(db, DATA_FILE);
const c = dataset.credits;
console.log(
  `\n${counts.done.toLocaleString()} tracks checked in ${fmtDuration(Date.now() - started)} with ${deezer.requests().toLocaleString()} Deezer requests` +
    `\n  ${counts.found.toLocaleString()} found, ${counts.missing.toLocaleString()} not on Deezer, ${counts.errors.toLocaleString()} failed (tried again next run)` +
    `\n  Overall: ${c.checked.toLocaleString()} of ${c.total.toLocaleString()} tracks checked, covering ${pct(c.playsCovered / Math.max(1, c.playsTotal))} of your plays` +
    `\nUpdated ${DATA_FILE} (reload the dashboard to see the new artist counts).`,
);
db.close();
process.exit(0);
