#!/usr/bin/env node
// Reads the Spotify export folder into data/spotify.db, then rebuilds data/plays.json for the dashboard.
// Usage: node scripts/import.mjs [--source <folder>] [--if-missing] [--force]
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, setKv } from './lib/db.mjs';
import { importRows, migrateArtworkCache, ImportOverlapError } from './lib/import.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

export const DB_FILE = join(root, 'data', 'spotify.db');
const sourceDir = resolve(root, argValue('--source') ?? 'Spotify Extended Streaming History');

if (args.includes('--if-missing') && existsSync(DB_FILE)) {
  console.log(`Using existing ${DB_FILE} (run "npm run import" after downloading a newer export).`);
  process.exit(0);
}

let files;
try {
  files = (await readdir(sourceDir)).filter((f) => /^Streaming_History_(Audio|Video)_.*\.json$/i.test(f)).sort();
} catch {
  console.error(`Could not read "${sourceDir}". Put your Spotify export there or pass --source <folder>.`);
  process.exit(1);
}
if (files.length === 0) {
  console.error(`No Streaming_History_*.json files found in "${sourceDir}".`);
  process.exit(1);
}

const rows = [];
for (const f of files) {
  const data = JSON.parse(await readFile(join(sourceDir, f), 'utf8'));
  for (const r of data) rows.push(r);
  console.log(`  ${f}: ${data.length.toLocaleString()} rows`);
}

const db = openDb(DB_FILE);
let result;
try {
  result = importRows(db, rows, { force: args.includes('--force') });
} catch (err) {
  if (err instanceof ImportOverlapError) {
    console.error(`\n${err.message}`);
    process.exit(1);
  }
  throw err;
}
setKv(db, 'last_import', JSON.stringify({ at: new Date().toISOString(), files: files.length, ...result }));

const migrated = migrateArtworkCache(db, join(root, 'data', 'artwork-cache.json'));
const count = (sql) => db.prepare(sql).get().n.toLocaleString();
console.log(
  `\nImported into ${DB_FILE}` +
    `\n  ${result.raw.toLocaleString()} raw rows from ${files.length} files` +
    `\n  ${result.added.toLocaleString()} new plays, ${result.duplicates.toLocaleString()} already stored or exact duplicates` +
    `\n  ${count('SELECT count(*) n FROM plays')} plays, ${count('SELECT count(*) n FROM tracks')} tracks/episodes, ` +
    `${count('SELECT count(*) n FROM artists')} artists/shows` +
    (result.newTracks ? `\n  ${result.newTracks.toLocaleString()} new tracks (check their artists with: npm run credits)` : '') +
    (migrated ? `\n  ${migrated.toLocaleString()} saved images moved from artwork-cache.json` : ''),
);
db.close();
