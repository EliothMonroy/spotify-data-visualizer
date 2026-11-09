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
