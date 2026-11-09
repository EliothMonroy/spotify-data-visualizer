#!/usr/bin/env node
// Reads the Spotify export folder and writes data/plays.json for the dashboard.
// Usage: node scripts/prepare-data.mjs [--source <folder>] [--if-missing]
import { readdir, readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDataset } from './lib/normalize.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const sourceDir = resolve(root, argValue('--source') ?? 'Spotify Extended Streaming History');
const outFile = join(root, 'data', 'plays.json');

if (args.includes('--if-missing')) {
  try {
    await access(outFile);
    console.log(`Using existing ${outFile} (run "npm run prepare-data" to rebuild).`);
    process.exit(0);
  } catch {
    // not built yet; continue
  }
}

let files;
try {
  files = (await readdir(sourceDir))
    .filter((f) => /^Streaming_History_(Audio|Video)_.*\.json$/i.test(f))
    .sort();
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

const dataset = buildDataset(rows);
dataset.stats.files = files.length;

await mkdir(dirname(outFile), { recursive: true });
await writeFile(outFile, JSON.stringify(dataset));

const { stats } = dataset;
console.log(
  `\nWrote ${outFile}\n  ${stats.plays.toLocaleString()} plays from ${files.length} files` +
    ` (${stats.duplicatesRemoved} exact duplicate rows removed)` +
    `\n  ${dataset.items.name.length.toLocaleString()} tracks/episodes, ${dataset.creators.length.toLocaleString()} artists/shows`,
);
