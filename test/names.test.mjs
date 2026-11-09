import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseTitle, pickTrackCandidates, contributorsInclude, resolveContributor } from '../scripts/lib/names.mjs';

const ext = { id: 1, title: 'Treasure Bay (Extended Mix)', artist: { name: 'KEVU' } };
const orig = { id: 2, title: 'Treasure Bay', artist: { name: 'KEVU' } };
const decoy = { id: 3, title: 'Treasure Bay', artist: { name: 'Someone Else' } };

test('pickTrackCandidates prefers the exact title over a version of it', () => {
  assert.deepEqual(pickTrackCandidates([ext, orig], 'Kevu', 'Treasure Bay').map((r) => r.id), [2, 1]);
});

test('pickTrackCandidates rejects results whose lead artist is someone else', () => {
  assert.deepEqual(pickTrackCandidates([decoy, orig], 'Kevu', 'Treasure Bay').map((r) => r.id), [2]);
  assert.deepEqual(pickTrackCandidates([{ id: 8, title: 'Intro', artist: { name: 'B' } }], 'A', 'Intro'), []);
});

test('pickTrackCandidates never picks a remix or other version for the original', () => {
  const remix = { id: 1, title: 'Levitating (The Blessed Madonna Remix)', artist: { name: 'Dua Lipa' } };
  const plain = { id: 2, title: 'Levitating', artist: { name: 'Dua Lipa' } };
  assert.deepEqual(pickTrackCandidates([remix, plain], 'Dua Lipa', 'Levitating (feat. DaBaby)').map((r) => r.id), [2]);
  const djRemix = { id: 3, title: 'Song (DJ X Remix)', artist: { name: 'A' } };
  assert.deepEqual(pickTrackCandidates([djRemix], 'A', 'Song - Live'), []);
  const tiesto = { id: 4, title: "L'Amour Toujours (Tiësto Edit)", artist: { name: 'Dzeko' } };
  assert.deepEqual(pickTrackCandidates([{ ...tiesto, title: "L'Amour Toujours" }, tiesto], 'Dzeko', "L'Amour Toujours - Tiësto Edit").map((r) => r.id), [4]);
});

test('pickTrackCandidates allows harmless version names and prefers the plain title', () => {
  const radio = { id: 5, title: 'Song - Radio Edit', artist: { name: 'A' } };
  const plain = { id: 6, title: 'Song', artist: { name: 'A' } };
  assert.deepEqual(pickTrackCandidates([radio, plain], 'A', 'Song (feat. B)').map((r) => r.id), [6, 5]);
});

test('pickTrackCandidates drops other titles and returns at most two', () => {
  assert.deepEqual(pickTrackCandidates([{ id: 4, title: 'Other Song', artist: { name: 'KEVU' } }], 'Kevu', 'Treasure Bay'), []);
  assert.equal(pickTrackCandidates([decoy, orig, ext], 'Kevu', 'Treasure Bay').length, 2);
});

test('baseTitle drops featured artists and version suffixes', () => {
  assert.equal(baseTitle('Song (feat. X) - Radio Edit'), 'song');
  assert.equal(baseTitle('Song [Remastered]'), 'song');
});

test('contributorsInclude compares normalized names and never matches empty names', () => {
  assert.equal(contributorsInclude([{ name: 'ang' }], 'ANG'), true);
  assert.equal(contributorsInclude([{ name: 'KEVU' }], 'ANG'), false);
  assert.equal(contributorsInclude([{ name: '!!!' }], '...'), false);
});

function ctx(overrides = {}) {
  return {
    byDeezerId: new Map(),
    byExactName: new Map(),
    byNorm: new Map(),
    trackArtist: { id: 4, name: 'Kevu' },
    ...overrides,
  };
}

test('resolveContributor maps Deezer "KEVU" to the track\'s Spotify artist "Kevu"', () => {
  assert.equal(resolveContributor({ id: 9, name: 'KEVU' }, ctx()), 4);
});

test('resolveContributor prefers a linked Deezer id, then an exact name', () => {
  assert.equal(resolveContributor({ id: 5, name: 'ang' }, ctx({ byDeezerId: new Map([[5, 11]]) })), 11);
  assert.equal(resolveContributor({ id: 5, name: 'ang' }, ctx({ byExactName: new Map([['ang', 12]]) })), 12);
});

test('resolveContributor picks the most played artist among normalized matches', () => {
  const byNorm = new Map([['ang', [{ id: 7, plays: 10 }, { id: 8, plays: 900 }]]]);
  assert.equal(resolveContributor({ id: 5, name: 'ang' }, ctx({ byNorm })), 8);
});

test('resolveContributor returns null for unknown names and never matches empty normalized names', () => {
  assert.equal(resolveContributor({ id: 6, name: 'Nobody Known' }, ctx()), null);
  const byNorm = new Map([['', [{ id: 2, plays: 50 }]]]);
  assert.equal(resolveContributor({ id: 1, name: '!!!' }, ctx({ byNorm, trackArtist: { id: 3, name: '...' } })), null);
});
