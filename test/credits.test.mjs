import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepare, applyCreditMode, artistsOf, artistNames } from '../public/js/data.js';
import { groupStats, summarize, playsOf, loyalArtists, discoveries } from '../public/js/aggregate.js';

const KEVU = 0;
const ANG = 1;
const A = 0; // "Treasure Bay" by Kevu, with ANG credited on Deezer
const B = 1; // a track by ANG alone

function dataset() {
  const base = Date.parse('2021-01-01T12:00:00Z') / 1000;
  const n = 4;
  return prepare({
    version: 2,
    creators: ['Kevu', 'ANG'],
    albums: [{ name: 'Treasure Bay', creator: KEVU }, { name: 'Other', creator: ANG }],
    families: ['iOS'], devices: ['iPhone'], countries: ['MX'], reasonsStart: ['trackdone'], reasonsEnd: ['trackdone'],
    items: { name: ['Treasure Bay', 'Solo'], creator: [KEVU, ANG], album: [0, 1], kind: [0, 0], uri: ['', ''], extra: [[ANG], []] },
    plays: {
      ts: Array.from({ length: n }, (_, i) => base + i * 86400),
      ms: Array(n).fill(40000),
      item: [A, A, A, B],
      family: Array(n).fill(0), device: Array(n).fill(0), country: Array(n).fill(0),
      rs: Array(n).fill(0), re: Array(n).fill(0), flags: Array(n).fill(0),
    },
  });
}

const all = (D) => Int32Array.from({ length: D.n }, (_, i) => i);
const playsBy = (D) => Object.fromEntries(groupStats(D, all(D), 30000, 'artist').map((r) => [D.creators[r.id], r.plays]));

test('every credited artist gets full credit for each play', () => {
  const D = dataset();
  assert.deepEqual(playsBy(D), { Kevu: 3, ANG: 4 });
  const s = summarize(D, all(D), 30000);
  assert.equal(s.plays, 4, 'total plays do not change');
  assert.equal(s.artists, 2);
});

test('"first artist only" gives the Spotify artist alone', () => {
  const D = dataset();
  applyCreditMode(D, 'first');
  assert.deepEqual(playsBy(D), { Kevu: 3, ANG: 1 });
  applyCreditMode(D, 'all');
  assert.deepEqual(playsBy(D), { Kevu: 3, ANG: 4 });
});

test('an artist first heard on a collaboration counts from that play', () => {
  const D = dataset();
  assert.equal(D.creatorFirst[ANG], 0);
  assert.equal(discoveries(D, all(D), 'year').artists[0], 2);
  applyCreditMode(D, 'first');
  assert.equal(D.creatorFirst[ANG], 3);
});

test('explore and loyalty use every credit', () => {
  const D = dataset();
  assert.equal(playsOf(D, all(D), 'artist', ANG).length, 4);
  assert.equal(playsOf(D, all(D), 'track', A).length, 3);
  assert.equal(loyalArtists(D, all(D), 30000).find((r) => r.id === ANG).plays, 4);
});

test('tracks list every artist by name', () => {
  const D = dataset();
  assert.deepEqual(Array.from(artistsOf(D, A)), [KEVU, ANG]);
  assert.equal(artistNames(D, A), 'Kevu, ANG');
  applyCreditMode(D, 'first');
  assert.equal(artistNames(D, A), 'Kevu, ANG', 'names still show every artist');
});
