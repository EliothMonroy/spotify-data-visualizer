#!/usr/bin/env node
// Checks that the database-built dashboard file, with the Collaborations switch on "First artist
// only", gives the same numbers as building straight from the export (the pre-database way).
// Usage: node scripts/check-parity.mjs [--source <folder>]
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDataset } from './lib/normalize.mjs';
import { buildDatasetFromDb } from './lib/export.mjs';
import { openDb } from './lib/db.mjs';
import { prepare, applyCreditMode } from '../public/js/data.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const i = process.argv.indexOf('--source');
const sourceDir = resolve(root, i > 0 ? process.argv[i + 1] : 'Spotify Extended Streaming History');

const rows = [];
for (const f of (await readdir(sourceDir)).filter((f) => /^Streaming_History_(Audio|Video)_.*\.json$/i.test(f)).sort()) {
  for (const r of JSON.parse(await readFile(join(sourceDir, f), 'utf8'))) rows.push(r);
}

const before = prepare(buildDataset(rows));
const after = prepare(buildDatasetFromDb(openDb(join(root, 'data', 'spotify.db'))));
applyCreditMode(after, 'first');
const credits = after.extra.reduce((n, list) => n + list.length, 0);

const problems = [];
const same = (label, a, b) => {
  const x = JSON.stringify(Array.from(a ?? []));
  const y = JSON.stringify(Array.from(b ?? []));
  if (x !== y) problems.push(`${label} differs (${(a ?? []).length} vs ${(b ?? []).length} entries)`);
};

same('plays', [before.n], [after.n]);
for (const col of ['ms', 'item', 'family', 'device', 'country', 'rs', 're', 'flags', 'start', 'creator', 'kind', 'skip']) {
  same(`play column "${col}"`, before[col], after[col]);
}
same('track names', before.items.name, after.items.name);
same('track artists', before.items.creator, after.items.creator);
same('track albums', before.items.album, after.items.album);
same('track kinds', before.items.kind, after.items.kind);
same('album groups', before.albums.map((a) => `${a.name}|${a.creator}`), after.albums.map((a) => `${a.name}|${a.creator}`));
same('artists', before.creators, after.creators.slice(0, before.creators.length));
for (const k of ['families', 'devices', 'countries', 'reasonsStart', 'reasonsEnd']) same(k, before[k], after[k]);
for (const k of ['itemTotal', 'albumTotal', 'itemFirst']) same(k, before[k], after[k]);
for (const k of ['creatorTotal', 'creatorFirst', 'creatorTopItem']) same(k, before[k], after[k].slice(0, before[k].length));

if (problems.length) {
  console.error(`parity FAILED:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`parity OK ("First artist only", ${credits.toLocaleString()} Deezer credits ignored): ${after.n.toLocaleString()} plays, ${after.items.count.toLocaleString()} tracks, ${before.creators.length.toLocaleString()} artists, ${after.albums.length.toLocaleString()} albums`);
