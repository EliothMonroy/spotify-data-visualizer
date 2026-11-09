import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../scripts/lib/db.mjs';
import { playHash, importRows, ImportOverlapError } from '../scripts/lib/import.mjs';
import { IP, treasureBay, trackRow } from './helpers.mjs';

test('playHash ignores ip_addr but not other fields', () => {
  const a = treasureBay('2021-01-01T10:00:00Z');
  assert.equal(playHash(a), playHash({ ...a, ip_addr: '198.51.100.1' }));
  assert.notEqual(playHash(a), playHash({ ...a, ms_played: 1 }));
});

test('rows differing only in IP are one play', () => {
  const db = openDb(':memory:');
  const a = treasureBay('2021-01-01T10:00:00Z');
  const r = importRows(db, [a, { ...a, ip_addr: '198.51.100.1' }, treasureBay('2021-01-02T10:00:00Z')]);
  assert.equal(r.added, 2);
  assert.equal(r.duplicates, 1);
});

test('re-importing the same rows adds nothing, a newer export adds only new plays', () => {
  const db = openDb(':memory:');
  const old = [treasureBay('2021-01-01T10:00:00Z'), treasureBay('2021-01-02T10:00:00Z')];
  importRows(db, old);
  assert.equal(importRows(db, old).added, 0);
  assert.equal(importRows(db, [...old, treasureBay('2022-05-01T10:00:00Z')]).added, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM plays').get().n, 3);
});

test('an import that would duplicate the history stops unless forced', () => {
  const db = openDb(':memory:');
  const base = Date.parse('2021-01-01T00:00:00Z');
  const rows = Array.from({ length: 200 }, (_, i) => treasureBay(new Date(base + i * 3600e3).toISOString()));
  importRows(db, rows);
  const changed = rows.slice(0, 150).map((r) => ({ ...r, platform: 'renamed platform format' }));
  assert.throws(() => importRows(db, changed), ImportOverlapError);
  assert.equal(db.prepare('SELECT count(*) n FROM plays').get().n, 200, 'rolled back');
  assert.equal(importRows(db, changed, { force: true }).added, 150);
});

test('tracks get their Spotify artist as the first credit', () => {
  const db = openDb(':memory:');
  importRows(db, [treasureBay('2021-01-01T10:00:00Z'), treasureBay('2021-01-02T10:00:00Z')]);
  const tracks = db.prepare('SELECT * FROM tracks').all();
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].name, 'Treasure Bay');
  assert.equal(tracks[0].spotify_id, 'tb1');
  const credits = db.prepare('SELECT c.*, a.name FROM credits c JOIN artists a ON a.id = c.artist_id').all();
  assert.deepEqual(credits.map((c) => [c.name, c.source, c.position]), [['Kevu', 'spotify', 0]]);
});

test('the first name seen for a track wins, like the old dataset builder', () => {
  const db = openDb(':memory:');
  importRows(db, [
    trackRow('2021-01-02T10:00:00Z', 'New Name', 'Kevu', 'Treasure Bay', 'tb1'),
    trackRow('2021-01-01T10:00:00Z', 'Treasure Bay', 'Kevu', 'Treasure Bay', 'tb1'),
  ]);
  assert.equal(db.prepare('SELECT name FROM tracks').get().name, 'Treasure Bay');
  assert.equal(db.prepare('SELECT count(*) n FROM meta').get().n, 2, 'both raw spellings are kept');
});

test('the IP address is never written to the database', () => {
  const db = openDb(':memory:');
  importRows(db, [treasureBay('2021-01-01T10:00:00Z')]);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
  for (const t of tables) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    assert.ok(!cols.includes('ip_addr'), `${t} has no ip_addr column`);
    for (const row of db.prepare(`SELECT * FROM ${t}`).all()) {
      assert.ok(!JSON.stringify(row).includes(IP), `${t} holds no IP value`);
    }
  }
});

test('null fields stay null, so missing "skipped" data is not turned into false', () => {
  const db = openDb(':memory:');
  importRows(db, [treasureBay('2021-01-01T10:00:00Z')]);
  const p = db.prepare('SELECT skipped, shuffle FROM plays').get();
  assert.equal(p.skipped, null);
  assert.equal(p.shuffle, 0);
});

test('the old artwork cache moves into the database and the file is renamed', async () => {
  const { mkdtempSync, writeFileSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { migrateArtworkCache } = await import('../scripts/lib/import.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'sdv-'));
  const file = join(dir, 'artwork-cache.json');
  writeFileSync(file, JSON.stringify({
    'artist:kevu': { thumb: 'k.jpg', full: 'K.jpg', source: 'Deezer', link: 'l', t: 5 },
    'album:kevu|treasure bay': { miss: true, t: 7 },
  }));
  const db = openDb(':memory:');
  importRows(db, [treasureBay('2021-01-01T10:00:00Z')]);
  assert.equal(migrateArtworkCache(db, file), 2);
  assert.deepEqual({ ...db.prepare('SELECT image_status, image_thumb, image_full FROM artists').get() }, { image_status: 'found', image_thumb: 'k.jpg', image_full: 'K.jpg' });
  assert.deepEqual({ ...db.prepare('SELECT image_status, image_checked_at FROM albums').get() }, { image_status: 'none', image_checked_at: 7 });
  assert.ok(!existsSync(file) && existsSync(join(dir, 'artwork-cache.migrated.json')));
});
