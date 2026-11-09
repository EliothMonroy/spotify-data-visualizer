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

test('a contributor never merges into a podcast show with the same name', async () => {
  const { episodeRow } = await import('./helpers.mjs');
  const db = seeded();
  importRows(db, [{ ...episodeRow('2021-02-01T10:00:00Z'), episode_show_name: 'Nova', spotify_episode_uri: 'spotify:episode:nova1' }]);
  const deezer = fakeDeezer({
    search: [{ id: 5, title: 'Treasure Bay', artist: { name: 'KEVU' } }],
    tracks: { 5: deezerTrack(5, [contributor(1, 'KEVU'), contributor(2, 'Nova')]) },
  });
  assert.equal(await checkTrack(db, deezer, kevuTrack(db)), 'matched');
  assert.deepEqual(credits(db).map((c) => c.name), ['Kevu'], 'the show gets no music credit');
  assert.equal(db.prepare("SELECT image_status FROM artists WHERE name = 'Nova'").get().image_status, null);
});

test('an artist added after the lookup tables were built is reused, not inserted twice', async () => {
  const db = seeded();
  const search = [{ id: 5, title: 'Treasure Bay', artist: { name: 'KEVU' } }];
  await checkTrack(db, fakeDeezer({ search, tracks: { 5: deezerTrack(5, [contributor(1, 'KEVU')]) } }), kevuTrack(db));
  db.prepare("INSERT INTO artists (name) VALUES ('Late Artist')").run();
  const solo = tracksToCheck(db).find((t) => t.name === 'Solo');
  const deezer = fakeDeezer({
    search: [{ id: 6, title: 'Solo', artist: { name: 'ANG' } }],
    tracks: { 6: { ...deezerTrack(6, [contributor(4985806, 'ANG'), contributor(3, 'Late Artist')], 'Solo'), title: 'Solo' } },
  });
  assert.equal(await checkTrack(db, deezer, solo), 'matched');
  assert.equal(db.prepare("SELECT count(*) n FROM artists WHERE name = 'Late Artist'").get().n, 1);
});

test('a busy database counts as a temporary failure, other bugs do not', async () => {
  const { isTransient } = await import('../scripts/lib/credits.mjs');
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const file = join(mkdtempSync(join(tmpdir(), 'sdv-')), 'busy.db');
  const a = openDb(file);
  const b = new DatabaseSync(file);
  b.exec('PRAGMA busy_timeout = 0');
  a.exec('BEGIN IMMEDIATE');
  let busy;
  try { b.exec("INSERT INTO kv (key, value) VALUES ('x', '1')"); } catch (err) { busy = err; }
  a.exec('ROLLBACK');
  assert.ok(busy, 'the second connection was blocked');
  assert.equal(isTransient(busy), true);
  assert.equal(isTransient(new TransientError('quota')), true);
  assert.equal(isTransient(new TypeError('bug')), false);
});

// ---- MusicBrainz fallback ----
import { checkTrackMusicBrainz, checkTrackAllSources } from '../scripts/lib/credits.mjs';

const rec = (id, title, credits) => ({
  id, title, score: 100,
  'artist-credit': credits.map(([name, joinphrase = '']) => ({ name, joinphrase, artist: { id: `mb-${name}`, name } })),
});
function fakeMb(recordings = [], { fail = false } = {}) {
  const calls = [];
  return {
    calls,
    searchRecordings: async (artist, title) => {
      calls.push(`${artist} | ${title}`);
      if (fail) throw new TransientError('busy');
      return recordings;
    },
  };
}
const status = (db, name) => ({ ...db.prepare('SELECT deezer_status, mb_status, mb_id FROM tracks WHERE name = ?').get(name) });
const missedOnDeezer = () => {
  const db = seeded();
  db.prepare("UPDATE tracks SET deezer_status = 'not_found'").run();
  return db;
};
const mbTrack = (db) => tracksToCheck(db).find((t) => t.name === 'Treasure Bay');

test('a track Deezer missed gets its artists from MusicBrainz, featured artists marked', async () => {
  const db = missedOnDeezer();
  const mb = fakeMb([rec('r1', 'Treasure Bay', [['Kevu', ' & '], ['ANG', ' feat. '], ['Haris']])]);
  assert.equal(await checkTrackMusicBrainz(db, mb, mbTrack(db)), 'matched');
  assert.deepEqual(credits(db), [
    { name: 'Kevu', source: 'spotify', position: 0, role: null },
    { name: 'ANG', source: 'musicbrainz', position: 1, role: 'Main' },
    { name: 'Haris', source: 'musicbrainz', position: 2, role: 'Featured' },
  ]);
  assert.deepEqual(status(db, 'Treasure Bay'), { deezer_status: 'not_found', mb_status: 'matched', mb_id: 'r1' });
  assert.deepEqual(mb.calls, ['Kevu | Treasure Bay']);
});

test('a solo recording on MusicBrainz is saved as confirmed solo', async () => {
  const db = missedOnDeezer();
  assert.equal(await checkTrackMusicBrainz(db, fakeMb([rec('r1', 'Treasure Bay', [['Kevu']])]), mbTrack(db)), 'solo');
  assert.equal(credits(db).length, 1);
  assert.equal(status(db, 'Treasure Bay').mb_status, 'solo');
});

test('remixes and recordings led by someone else are not used', async () => {
  const db = missedOnDeezer();
  const mb = fakeMb([rec('r2', 'Treasure Bay (X Remix)', [['Kevu', ' & '], ['X']]), rec('r3', 'Treasure Bay', [['Someone', ' & '], ['Kevu']])]);
  assert.equal(await checkTrackMusicBrainz(db, mb, mbTrack(db)), 'not_found');
  assert.equal(credits(db).length, 1);
  assert.equal(status(db, 'Treasure Bay').mb_status, 'not_found');
});

test('a temporary MusicBrainz failure saves nothing', async () => {
  const db = missedOnDeezer();
  await assert.rejects(checkTrackMusicBrainz(db, fakeMb([], { fail: true }), mbTrack(db)), TransientError);
  assert.equal(status(db, 'Treasure Bay').mb_status, null);
});

test('tracks Deezer missed are listed for MusicBrainz only if played for 30 seconds or more', () => {
  const db = missedOnDeezer();
  importRows(db, [trackRow('2021-03-01T10:00:00Z', 'Short', 'ANG', 'Short', 'short1', { ms_played: 10000 })]);
  db.prepare("UPDATE tracks SET deezer_status = 'not_found' WHERE name = 'Short'").run();
  assert.deepEqual(tracksToCheck(db).map((t) => t.name).sort(), ['Solo', 'Treasure Bay']);
  db.prepare("UPDATE tracks SET mb_status = 'not_found' WHERE name = 'Solo'").run();
  assert.deepEqual(tracksToCheck(db).map((t) => t.name), ['Treasure Bay'], 'answered tracks are not listed again');
  assert.deepEqual(tracksToCheck(db, { retryMissing: true }).map((t) => t.name).sort(), ['Short', 'Solo', 'Treasure Bay']);
});

test('checking a new track tries Deezer, then MusicBrainz when Deezer has nothing', async () => {
  const db = seeded();
  const mb = fakeMb([rec('r1', 'Treasure Bay', [['Kevu', ' & '], ['ANG']])]);
  const deezer = fakeDeezer();
  assert.equal(await checkTrackAllSources(db, { deezer, mb }, kevuTrack(db)), 'matched');
  assert.deepEqual(status(db, 'Treasure Bay'), { deezer_status: 'not_found', mb_status: 'matched', mb_id: 'r1' });
  assert.equal(deezer.calls.length, 2);
});

test('a track found on Deezer is not sent to MusicBrainz', async () => {
  const db = seeded();
  const mb = fakeMb();
  const deezer = fakeDeezer({
    search: [{ id: 5, title: 'Treasure Bay', artist: { name: 'KEVU' } }],
    tracks: { 5: deezerTrack(5, [contributor(1, 'KEVU'), contributor(2, 'ang')]) },
  });
  assert.equal(await checkTrackAllSources(db, { deezer, mb }, kevuTrack(db)), 'matched');
  assert.equal(mb.calls.length, 0);
});

test('a short-only track Deezer misses is not sent to MusicBrainz', async () => {
  const db = seeded();
  importRows(db, [trackRow('2021-03-01T10:00:00Z', 'Short', 'ANG', 'Short', 'short1', { ms_played: 10000 })]);
  const mb = fakeMb();
  const short = tracksToCheck(db).find((t) => t.name === 'Short');
  assert.equal(await checkTrackAllSources(db, { deezer: fakeDeezer(), mb }, short), 'not_found');
  assert.equal(mb.calls.length, 0);
  assert.equal(status(db, 'Short').mb_status, null);
});

test('MusicBrainz artists use the name printed on the release, with the main name as a backup match', async () => {
  const db = missedOnDeezer();
  db.prepare("INSERT INTO artists (name) VALUES ('Jonathan Mendelsohn')").run();
  const recording = {
    id: 'r9', title: 'Treasure Bay',
    'artist-credit': [
      { name: 'Kevu', joinphrase: ' & ', artist: { id: 'a1', name: 'Kevu' } },
      { name: 'Tomo Hirata', joinphrase: ' feat. ', artist: { id: 'a2', name: '平田知昌' } },
      { name: 'J. Mendelsohn', joinphrase: '', artist: { id: 'a3', name: 'Jonathan Mendelsohn' } },
    ],
  };
  assert.equal(await checkTrackMusicBrainz(db, fakeMb([recording]), mbTrack(db)), 'matched');
  assert.deepEqual(credits(db).map((c) => c.name), ['Kevu', 'Tomo Hirata', 'Jonathan Mendelsohn']);
  assert.equal(db.prepare("SELECT count(*) n FROM artists WHERE name IN ('平田知昌', 'J. Mendelsohn')").get().n, 0);
});
