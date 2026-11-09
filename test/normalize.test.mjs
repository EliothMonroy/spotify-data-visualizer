import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDataset, dedupeExact, normalizePlatform, kindOf,
  KIND_TRACK, KIND_EPISODE, FLAG_SKIPPED, FLAG_SHUFFLE,
} from '../scripts/lib/normalize.mjs';

const row = (over = {}) => ({
  ts: '2020-01-01T10:00:00Z',
  platform: 'osx',
  ms_played: 200000,
  conn_country: 'MX',
  ip_addr: '1.2.3.4',
  master_metadata_track_name: 'Song A',
  master_metadata_album_artist_name: 'Artist A',
  master_metadata_album_album_name: 'Album A',
  spotify_track_uri: 'spotify:track:aaa',
  episode_name: null,
  episode_show_name: null,
  spotify_episode_uri: null,
  reason_start: 'clickrow',
  reason_end: 'trackdone',
  shuffle: false,
  skipped: false,
  offline: false,
  incognito_mode: false,
  ...over,
});

test('exact copies are removed, repeat plays at other times are kept', () => {
  const a = row();
  const rows = [a, { ...a }, row({ ts: '2020-01-01T10:04:00Z' })];
  assert.equal(dedupeExact(rows).length, 2);
});

test('rows that differ in any field are not treated as duplicates', () => {
  const rows = [row(), row({ reason_end: 'fwdbtn' })];
  assert.equal(dedupeExact(rows).length, 2);
});

test('platform strings are grouped into families', () => {
  assert.deepEqual(normalizePlatform('Android OS 9 API 28 (Xiaomi, Mi 9T)'), { family: 'Android', device: 'Xiaomi Mi 9T' });
  assert.equal(normalizePlatform('Windows 10 (10.0.19041; x64)').family, 'Windows');
  assert.equal(normalizePlatform('OS X 12.0.1 [arm 2]').device, 'Mac (Apple silicon)');
  assert.equal(normalizePlatform('osx').family, 'macOS');
  assert.equal(normalizePlatform('Partner windows_tv microsoft;xbox_one_s_;;').device, 'Xbox');
  assert.equal(normalizePlatform('Partner webos_tv lg;43un7300aud;;').family, 'Smart TV');
  assert.equal(normalizePlatform('ios').family, 'iOS');
  assert.deepEqual(normalizePlatform('Partner android_sdk SONY;e2306;965a75;5.0_arm64-v8a'), { family: 'Android', device: 'Sony E2306' });
});

test('content kind detection', () => {
  assert.equal(kindOf(row()), KIND_TRACK);
  assert.equal(kindOf(row({
    master_metadata_track_name: null, spotify_track_uri: null,
    episode_name: 'Ep 1', episode_show_name: 'Show', spotify_episode_uri: 'spotify:episode:x',
  })), KIND_EPISODE);
});

test('dataset is column-oriented, sorted, and drops IP addresses', () => {
  const ds = buildDataset([
    row({ ts: '2020-01-02T00:00:00Z', skipped: true, shuffle: true }),
    row(),
    row(),
  ]);
  assert.equal(ds.stats.duplicatesRemoved, 1);
  assert.equal(ds.plays.ts.length, 2);
  assert.ok(ds.plays.ts[0] < ds.plays.ts[1]);
  assert.equal(ds.items.name.length, 1, 'same track uri shares one item');
  assert.equal(ds.plays.flags[1], FLAG_SKIPPED | FLAG_SHUFFLE);
  assert.ok(!JSON.stringify(ds).includes('1.2.3.4'));
});

test('rows that differ only in IP address are the same play', () => {
  assert.equal(dedupeExact([row(), row({ ip_addr: '5.6.7.8' })]).length, 1);
});
