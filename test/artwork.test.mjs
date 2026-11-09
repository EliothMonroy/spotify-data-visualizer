import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, normalizeAlbum, pickArtist, pickAlbum } from '../server/artwork.mjs';

test('normalize ignores case, accents, punctuation and a leading "The"', () => {
  assert.equal(normalize('Tiësto'), 'tiesto');
  assert.equal(normalize('The Weeknd'), 'weeknd');
  assert.equal(normalize('Dimitri Vegas & Like Mike'), 'dimitri vegas and like mike');
  assert.equal(normalize('W&W'), 'w and w');
});

test('normalizeAlbum drops edition and single suffixes', () => {
  assert.equal(normalizeAlbum('Stories (Deluxe Edition)'), 'stories');
  assert.equal(normalizeAlbum('Louder - Single'), 'louder');
  assert.equal(normalizeAlbum('True [Remastered Version]'), 'true');
  assert.equal(normalizeAlbum('Dominator (Remixes)'), 'dominator remixes');
});

test('pickArtist needs an exact (normalized) name, not the first search hit', () => {
  const results = [{ name: 'Hardwell & Blasterjaxx' }, { name: 'Hardwell' }];
  assert.equal(pickArtist(results, 'hardwell').name, 'Hardwell');
  assert.equal(pickArtist([{ name: 'Angus & Julia Stone' }], 'ANG'), null);
  assert.equal(pickArtist([{ name: 'ang', nb_fan: 44, id: 1 }, { name: 'ANG', nb_fan: 1247, id: 2 }], 'ANG').id, 2);
});

test('pickAlbum requires the same artist and a matching title', () => {
  const opts = { artistOf: (r) => r.artist, titleOf: (r) => r.title };
  const results = [
    { artist: 'Someone Else', title: 'Stories' },
    { artist: 'Avicii', title: 'Stories (Deluxe)' },
  ];
  assert.equal(pickAlbum(results, 'Avicii', 'Stories', opts).artist, 'Avicii');
  assert.equal(pickAlbum(results, 'Avicii', 'True', opts), null);
});

// ---- artwork stored in the database ----
import { createArtworkService } from '../server/artwork.mjs';
import { openDb } from '../scripts/lib/db.mjs';
import { importRows } from '../scripts/lib/import.mjs';
import { treasureBay } from './helpers.mjs';

const DAY = 24 * 3600 * 1000;
const NO_WAIT = { deezer: 0, audiodb: 0, itunes: 0 };

function artworkDb() {
  const db = openDb(':memory:');
  importRows(db, [treasureBay('2021-01-01T10:00:00Z')]);
  return db;
}

async function withFetch(fake, fn) {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (...a) => { calls++; return fake(...a); };
  try { await fn(); } finally { globalThis.fetch = real; }
  return calls;
}
const emptyAnswer = async () => new Response(JSON.stringify({ data: [], artists: null, results: [] }), { status: 200 });

test('a stored image is returned without contacting any service', async () => {
  const db = artworkDb();
  db.prepare("UPDATE artists SET image_status = 'found', image_thumb = 't.jpg', image_full = 'f.jpg', image_source = 'Deezer', image_link = 'l' WHERE name = 'Kevu'").run();
  const svc = createArtworkService({ db });
  let hit;
  const calls = await withFetch(emptyAnswer, async () => { hit = await svc.lookup('artist', 'Kevu'); });
  assert.equal(calls, 0);
  assert.deepEqual({ thumb: hit.thumb, full: hit.full, source: hit.source, link: hit.link }, { thumb: 't.jpg', full: 'f.jpg', source: 'Deezer', link: 'l' });
});

test('a recent "no image" answer is not looked up again', async () => {
  const db = artworkDb();
  const now = Date.now();
  db.prepare("UPDATE albums SET image_status = 'none', image_checked_at = ?").run(now - DAY);
  const svc = createArtworkService({ db, now: () => now, gaps: NO_WAIT });
  let hit;
  const calls = await withFetch(emptyAnswer, async () => { hit = await svc.lookup('album', 'Kevu', 'Treasure Bay'); });
  assert.equal(calls, 0);
  assert.equal(hit, null);
});

test('a "no image" answer older than 14 days is looked up again and saved', async () => {
  const db = artworkDb();
  const now = Date.now();
  db.prepare("UPDATE albums SET image_status = 'none', image_checked_at = ?").run(now - 15 * DAY);
  const svc = createArtworkService({ db, now: () => now, gaps: NO_WAIT });
  const calls = await withFetch(emptyAnswer, async () => { await svc.lookup('album', 'Kevu', 'Treasure Bay'); });
  assert.ok(calls > 0);
  assert.equal(db.prepare('SELECT image_checked_at FROM albums').get().image_checked_at, now);
});

test('a found image is saved on the artist row', async () => {
  const db = artworkDb();
  const pic = 'https://cdn-images.dzcdn.net/images/artist/abc/500x500.jpg';
  const answer = async () => new Response(JSON.stringify({ data: [{ id: 7, name: 'Kevu', nb_fan: 10, picture_medium: pic, picture_big: pic, picture_xl: pic, link: 'l' }] }), { status: 200 });
  const svc = createArtworkService({ db, gaps: NO_WAIT });
  await withFetch(answer, async () => { await svc.lookup('artist', 'Kevu'); });
  const row = db.prepare("SELECT image_status, image_full, image_source FROM artists WHERE name = 'Kevu'").get();
  assert.deepEqual({ ...row }, { image_status: 'found', image_full: pic, image_source: 'Deezer' });
});

test('Deezer lookups slow to 1 per second while the credits backfill is running', async () => {
  const { setKv } = await import('../scripts/lib/db.mjs');
  const db = artworkDb();
  const now = 1_000_000_000;
  const svc = createArtworkService({ db, now: () => now, gaps: { deezer: 120 } });
  assert.equal(svc.deezerGap(), 120);
  setKv(db, 'credits_heartbeat', now - 5000);
  assert.equal(svc.deezerGap(), 1000);
  setKv(db, 'credits_heartbeat', now - 60000);
  assert.equal(svc.deezerGap(), 120, 'a stale heartbeat (backfill stopped) does not slow lookups');
});
