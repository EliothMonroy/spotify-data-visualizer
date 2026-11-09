// Database -> data/plays.json, the compact column-oriented file the dashboards load.
// Version 2 adds: pre-grouped albums, extra (Deezer) artists per track, image links and a
// summary of how many tracks have had their artists checked.
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { dictionary, normalizePlatform, flagsOf, KIND_TRACK } from './normalize.mjs';
import { getKv } from './db.mjs';

const MIN_PLAY_MS = 30000;
// A track's artists are known once Deezer matched it or MusicBrainz answered (including "solo").
const FOUND = "(t.deezer_status = 'matched' OR t.mb_status IN ('matched', 'solo'))";

const imageOf = (row) => (row?.image_status === 'found' && row.image_thumb
  ? [row.image_thumb, row.image_full ?? row.image_thumb, row.image_source ?? '', row.image_link ?? '']
  : null);

export function buildDatasetFromDb(db) {
  // One read transaction, so every query sees the same moment even while a backfill is writing.
  db.exec('BEGIN');
  try {
    return readDataset(db);
  } finally {
    db.exec('COMMIT');
  }
}

function readDataset(db) {
  const creators = dictionary();
  const families = dictionary();
  const devices = dictionary();
  const countries = dictionary();
  const reasonsStart = dictionary();
  const reasonsEnd = dictionary();

  const albumRows = new Map(db.prepare('SELECT * FROM albums').all().map((a) => [a.id, a]));
  const artistRows = new Map(db.prepare('SELECT * FROM artists').all().map((a) => [a.id, a]));
  const trackRows = new Map(db.prepare('SELECT * FROM tracks').all().map((t) => [t.id, t]));

  const albums = [];
  const albumIndex = new Map(); // db album id -> dataset album index
  const items = { name: [], creator: [], album: [], kind: [], uri: [], extra: [] };
  const itemIndex = new Map(); // db track id -> dataset item index
  const itemTrack = [];
  const plays = { ts: [], ms: [], item: [], family: [], device: [], country: [], rs: [], re: [], flags: [] };

  const platformCache = new Map();
  const stmt = db.prepare(`SELECT p.ts, p.ms_played, p.platform, p.conn_country, p.reason_start, p.reason_end,
      p.shuffle, p.skipped, p.offline, p.incognito_mode, m.track_id
    FROM plays p JOIN meta m ON m.id = p.meta_id ORDER BY p.ts, p.id`);

  for (const r of stmt.iterate()) {
    let item = -1;
    if (r.track_id !== null) {
      item = itemIndex.get(r.track_id);
      if (item === undefined) {
        const t = trackRows.get(r.track_id);
        item = items.name.length;
        itemIndex.set(r.track_id, item);
        itemTrack.push(t.id);
        const creator = creators.id(artistRows.get(t.artist_id).name);
        let album = albumIndex.get(t.album_id);
        if (album === undefined) {
          album = albums.length;
          albumIndex.set(t.album_id, album);
          albums.push({ name: albumRows.get(t.album_id).name, creator });
        }
        items.name.push(t.name);
        items.creator.push(creator);
        items.album.push(album);
        items.kind.push(t.kind);
        items.uri.push(t.spotify_id ?? '');
      }
    }
    let p = platformCache.get(r.platform);
    if (!p) platformCache.set(r.platform, (p = normalizePlatform(r.platform)));
    plays.ts.push(Math.round(Date.parse(r.ts) / 1000));
    plays.ms.push(Math.max(0, r.ms_played | 0));
    plays.item.push(item);
    plays.family.push(families.id(p.family));
    plays.device.push(devices.id(p.device));
    plays.country.push(countries.id(r.conn_country || 'ZZ'));
    plays.rs.push(reasonsStart.id(r.reason_start || 'unknown'));
    plays.re.push(reasonsEnd.id(r.reason_end || 'unknown'));
    plays.flags.push(flagsOf(r));
  }

  // Extra artists from Deezer and MusicBrainz (Spotify's own artist is always position 0 and already in items.creator).
  const extraByTrack = new Map();
  for (const c of db.prepare("SELECT track_id, artist_id FROM credits WHERE source <> 'spotify' ORDER BY track_id, position").all()) {
    let list = extraByTrack.get(c.track_id);
    if (!list) extraByTrack.set(c.track_id, (list = []));
    list.push(c.artist_id);
  }
  for (const trackId of itemTrack) {
    items.extra.push((extraByTrack.get(trackId) ?? []).map((a) => creators.id(artistRows.get(a).name)));
  }

  const artistByName = new Map([...artistRows.values()].map((a) => [a.name, a]));
  const albumImages = [...albumIndex.keys()].map((id) => imageOf(albumRows.get(id)));

  const credits = db.prepare(`SELECT
      count(*) AS total,
      sum(t.deezer_status IS NOT NULL) AS checked,
      sum(t.deezer_status = 'matched') AS matched,
      sum(${FOUND}) AS found,
      sum(CASE WHEN ${FOUND} THEN coalesce(n, 0) ELSE 0 END) AS playsFound,
      sum(CASE WHEN t.deezer_status IS NOT NULL THEN coalesce(n, 0) ELSE 0 END) AS playsCovered,
      sum(coalesce(n, 0)) AS playsTotal
    FROM tracks t LEFT JOIN (
      SELECT m.track_id, count(*) AS n FROM plays p JOIN meta m ON m.id = p.meta_id
      WHERE p.ms_played >= ${MIN_PLAY_MS} GROUP BY m.track_id
    ) c ON c.track_id = t.id
    WHERE t.kind = ${KIND_TRACK}`).get();

  const lastImport = JSON.parse(getKv(db, 'last_import') ?? 'null');
  return {
    version: 2,
    generatedAt: new Date().toISOString(),
    stats: {
      plays: plays.ts.length,
      rawRows: lastImport?.raw ?? plays.ts.length,
      duplicatesRemoved: lastImport ? lastImport.raw - lastImport.skipped - plays.ts.length : 0,
      files: lastImport?.files ?? 0,
    },
    creators: creators.values,
    albums,
    families: families.values,
    devices: devices.values,
    countries: countries.values,
    reasonsStart: reasonsStart.values,
    reasonsEnd: reasonsEnd.values,
    items,
    plays,
    creatorImages: creators.values.map((name) => imageOf(artistByName.get(name))),
    albumImages,
    credits: {
      checked: credits.checked ?? 0,
      matched: credits.matched ?? 0,
      found: credits.found ?? 0,
      playsFound: credits.playsFound ?? 0,
      total: credits.total ?? 0,
      playsCovered: credits.playsCovered ?? 0,
      playsTotal: credits.playsTotal ?? 0,
    },
  };
}

/** Write the dataset to a temp file and rename it, so the dashboard never reads a half-written file. */
export async function writeDataset(db, outFile) {
  const dataset = buildDatasetFromDb(db);
  await mkdir(dirname(outFile), { recursive: true });
  const tmp = `${outFile}.${process.pid}.${randomUUID()}.tmp`; // unique, so two writers never share one
  await writeFile(tmp, JSON.stringify(dataset));
  await rename(tmp, outFile);
  return dataset;
}
