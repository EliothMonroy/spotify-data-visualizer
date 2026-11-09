import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../scripts/lib/db.mjs';
import { importRows } from '../scripts/lib/import.mjs';
import { checkTrack, tracksToCheck } from '../scripts/lib/credits.mjs';
import { TransientError } from '../scripts/lib/deezer.mjs';
import { treasureBay, trackRow } from './helpers.mjs';

const PIC = (id) => `https://cdn-images.dzcdn.net/images/artist/${id}/500x500.jpg`;
const contributor = (id, name, role = 'Main', pic = PIC(id)) => ({
  id, name, role, link: `https://www.deezer.com/artist/${id}`,
  picture_medium: pic.replace('500x500', '250x250'), picture_big: pic, picture_xl: pic.replace('500x500', '1000x1000'),
});
const deezerTrack = (id, contributors, album = 'Treasure Bay') => ({
  id, title: 'Treasure Bay', contributors,
  album: { id: 77, title: album, cover_medium: 'https://cdn-images.dzcdn.net/images/cover/abc/250x250.jpg', cover_big: 'https://cdn-images.dzcdn.net/images/cover/abc/500x500.jpg', cover_xl: 'https://cdn-images.dzcdn.net/images/cover/abc/1000x1000.jpg', link: 'https://www.deezer.com/album/77' },
});

function seeded() {
  const db = openDb(':memory:');
  importRows(db, [
    treasureBay('2021-01-01T10:00:00Z'),
    treasureBay('2021-01-02T10:00:00Z'),
    trackRow('2021-01-03T10:00:00Z', 'Solo', 'ANG', 'Solo', 'ang1'),
  ]);
  return db;
}

function fakeDeezer({ search = [], tracks = {}, failTrack = false } = {}) {
  const calls = [];
  return {
    calls,
    searchTracks: async (q) => { calls.push(`search ${q}`); return search; },
    track: async (id) => {
      calls.push(`track ${id}`);
      if (failTrack) throw new TransientError('quota');
      return tracks[id];
    },
  };
}

const kevuTrack = (db) => tracksToCheck(db).find((t) => t.name === 'Treasure Bay');
const credits = (db) => db.prepare(`SELECT a.name, c.source, c.position, c.role FROM credits c JOIN artists a ON a.id = c.artist_id
  JOIN tracks t ON t.id = c.track_id WHERE t.name = 'Treasure Bay' ORDER BY c.position`).all().map((r) => ({ ...r }));

test('tracksToCheck lists unchecked music tracks, most played first', () => {
  const db = seeded();
  const list = tracksToCheck(db);
  assert.deepEqual(list.map((t) => [t.name, t.artistName, t.plays]), [['Treasure Bay', 'Kevu', 2], ['Solo', 'ANG', 1]]);
  assert.equal(tracksToCheck(db, { top: 1 }).length, 1);
});

test('a matched track credits every Deezer contributor and stores their pictures', async () => {
  const db = seeded();
  const deezer = fakeDeezer({
    search: [{ id: 1160927652, title: 'Treasure Bay', artist: { name: 'KEVU' } }],
    tracks: { 1160927652: deezerTrack(1160927652, [contributor(10044208, 'KEVU'), contributor(4985806, 'ang')]) },
  });
  assert.equal(await checkTrack(db, deezer, kevuTrack(db)), 'matched');
  assert.deepEqual(credits(db), [
    { name: 'Kevu', source: 'spotify', position: 0, role: null },
    { name: 'ANG', source: 'deezer', position: 1, role: 'Main' },
  ]);
  const ang = db.prepare("SELECT * FROM artists WHERE name = 'ANG'").get();
  assert.equal(ang.deezer_id, 4985806);
  assert.equal(ang.image_status, 'found');
  assert.equal(ang.image_full, PIC(4985806).replace('500x500', '1000x1000'));
  assert.equal(db.prepare("SELECT deezer_id FROM artists WHERE name = 'Kevu'").get().deezer_id, 10044208);
  const album = db.prepare("SELECT * FROM albums WHERE name = 'Treasure Bay'").get();
  assert.equal(album.image_status, 'found');
  const t = db.prepare("SELECT deezer_status, deezer_id FROM tracks WHERE name = 'Treasure Bay'").get();
  assert.deepEqual({ ...t }, { deezer_status: 'matched', deezer_id: 1160927652 });
  assert.equal(tracksToCheck(db).length, 1, 'checked tracks are not listed again');
});

test('a contributor unknown locally becomes a new artist', async () => {
  const db = seeded();
  const deezer = fakeDeezer({
    search: [{ id: 5, title: 'Treasure Bay', artist: { name: 'KEVU' } }],
    tracks: { 5: deezerTrack(5, [contributor(1, 'KEVU'), contributor(2, 'New Singer', 'Featured')]) },
  });
  await checkTrack(db, deezer, kevuTrack(db));
  assert.deepEqual(credits(db).map((c) => [c.name, c.role]), [['Kevu', null], ['New Singer', 'Featured']]);
});

test('a same-title track whose contributors do not include the Spotify artist is rejected', async () => {
  const db = seeded();
  const deezer = fakeDeezer({
    search: [{ id: 9, title: 'Treasure Bay', artist: { name: 'Someone' } }],
    tracks: { 9: deezerTrack(9, [contributor(3, 'Someone'), contributor(4, 'Other')]) },
  });
  assert.equal(await checkTrack(db, deezer, kevuTrack(db)), 'not_found');
  assert.equal(credits(db).length, 1);
  assert.equal(db.prepare("SELECT deezer_status FROM tracks WHERE name = 'Treasure Bay'").get().deezer_status, 'not_found');
});

test('no search results tries the strict query, then saves "not found"', async () => {
  const db = seeded();
  const deezer = fakeDeezer();
  assert.equal(await checkTrack(db, deezer, kevuTrack(db)), 'not_found');
  assert.deepEqual(deezer.calls, ['search Kevu Treasure Bay', 'search artist:"Kevu" track:"Treasure Bay"']);
});

test('Deezer placeholder pictures are not stored', async () => {
  const db = seeded();
  const deezer = fakeDeezer({
    search: [{ id: 5, title: 'Treasure Bay', artist: { name: 'KEVU' } }],
    tracks: { 5: deezerTrack(5, [contributor(1, 'KEVU'), contributor(2, 'ang', 'Main', 'https://cdn-images.dzcdn.net/images/artist//500x500-000000-80-0-0.jpg')]) },
  });
  await checkTrack(db, deezer, kevuTrack(db));
  assert.equal(db.prepare("SELECT image_status FROM artists WHERE name = 'ANG'").get().image_status, null);
});

test('an album cover from a different release is not used', async () => {
  const db = seeded();
  const deezer = fakeDeezer({
    search: [{ id: 5, title: 'Treasure Bay', artist: { name: 'KEVU' } }],
    tracks: { 5: deezerTrack(5, [contributor(1, 'KEVU')], 'Rave Culture Best Of 2021') },
  });
  await checkTrack(db, deezer, kevuTrack(db));
  assert.equal(db.prepare("SELECT image_status FROM albums WHERE name = 'Treasure Bay'").get().image_status, null);
});

test('a temporary Deezer failure saves nothing, so the track is tried again', async () => {
  const db = seeded();
  const deezer = fakeDeezer({ search: [{ id: 5, title: 'Treasure Bay', artist: { name: 'KEVU' } }], failTrack: true });
  await assert.rejects(checkTrack(db, deezer, kevuTrack(db)), TransientError);
  assert.equal(db.prepare("SELECT deezer_status FROM tracks WHERE name = 'Treasure Bay'").get().deezer_status, null);
  assert.equal(tracksToCheck(db).length, 2);
});
