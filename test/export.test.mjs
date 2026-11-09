import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../scripts/lib/db.mjs';
import { importRows } from '../scripts/lib/import.mjs';
import { buildDatasetFromDb, writeDataset } from '../scripts/lib/export.mjs';
import { treasureBay, episodeRow } from './helpers.mjs';

function seeded() {
  const db = openDb(':memory:');
  const a = treasureBay('2021-01-01T10:00:00Z');
  importRows(db, [a, { ...a, ip_addr: '198.51.100.9' }, treasureBay('2021-01-02T10:00:00Z'), treasureBay('2021-01-03T10:00:00Z'), episodeRow('2021-01-04T10:00:00Z')]);
  return db;
}

test('the dataset is built from the database in version 2 shape', () => {
  const d = buildDatasetFromDb(seeded());
  assert.equal(d.version, 2);
  assert.equal(d.plays.ts.length, 4);
  const tb = d.items.name.indexOf('Treasure Bay');
  assert.deepEqual(d.items.extra[tb], []);
  assert.equal(d.creators[d.items.creator[tb]], 'Kevu');
  assert.deepEqual(d.albums[d.items.album[tb]], { name: 'Treasure Bay', creator: d.items.creator[tb] });
  const ep = d.items.name.indexOf('Episode 1');
  assert.equal(d.creators[d.albums[d.items.album[ep]].creator], 'Some Show');
  assert.deepEqual(d.credits, { checked: 0, matched: 0, total: 1, playsCovered: 0, playsTotal: 3 });
});

test('Deezer credits appear as extra artists on the track', () => {
  const db = seeded();
  const ang = Number(db.prepare("INSERT INTO artists (name) VALUES ('ANG')").run().lastInsertRowid);
  db.prepare("INSERT INTO credits (track_id, artist_id, position, role, source) VALUES (1, ?, 1, 'Main', 'deezer')").run(ang);
  db.prepare("UPDATE tracks SET deezer_status = 'matched' WHERE id = 1").run();
  const d = buildDatasetFromDb(db);
  const tb = d.items.name.indexOf('Treasure Bay');
  assert.deepEqual(d.items.extra[tb].map((c) => d.creators[c]), ['ANG']);
  assert.deepEqual(d.credits, { checked: 1, matched: 1, total: 1, playsCovered: 3, playsTotal: 3 });
});

test('image links are included for artists and albums', () => {
  const db = seeded();
  db.prepare("UPDATE artists SET image_status = 'found', image_thumb = 't', image_full = 'f', image_source = 'Deezer', image_link = 'l' WHERE name = 'Kevu'").run();
  db.prepare("UPDATE albums SET image_status = 'none'").run();
  const d = buildDatasetFromDb(db);
  assert.deepEqual(d.creatorImages[d.creators.indexOf('Kevu')], ['t', 'f', 'Deezer', 'l']);
  assert.equal(d.creatorImages[d.creators.indexOf('Some Show')], null);
  assert.ok(d.albumImages.every((x) => x === null));
});

test('writeDataset replaces the file in one step and leaves no temp file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdv-'));
  const out = join(dir, 'plays.json');
  writeFileSync(out, '{"old":true}');
  await writeDataset(seeded(), out);
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).version, 2);
  assert.deepEqual(readdirSync(dir), ['plays.json']);
});
