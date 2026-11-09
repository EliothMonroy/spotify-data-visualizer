// Spotify export rows -> database. Safe to run again: plays already stored are skipped.
import { createHash } from 'node:crypto';
import { readFileSync, renameSync, existsSync } from 'node:fs';
import { META_FIELDS, transaction } from './db.mjs';
import { kindOf, KIND_TRACK, KIND_EPISODE, KIND_UNKNOWN } from './normalize.mjs';
import { normalize, normalizeAlbum } from './names.mjs';

/** Every known export field except ip_addr, in a fixed order. Fields Spotify adds later are ignored. */
export const PLAY_FIELDS = [
  'ts', 'platform', 'ms_played', 'conn_country',
  ...META_FIELDS,
  'reason_start', 'reason_end', 'shuffle', 'skipped', 'offline', 'offline_timestamp', 'incognito_mode',
];

/** Identifies a play. Two rows with the same hash are the same play logged twice. */
export function playHash(row) {
  return createHash('sha1').update(JSON.stringify(PLAY_FIELDS.map((f) => row[f] ?? null))).digest('hex');
}

export class ImportOverlapError extends Error {}

// More "new" plays than this (and more than 1% of that month) inside the stored history stops an import.
const OVERLAP_MIN = 25;

const bool = (v) => (v === null || v === undefined ? null : v ? 1 : 0);

/** The track (or episode / chapter) a row refers to, derived exactly like the old dataset builder. */
export function itemOf(r) {
  const kind = kindOf(r);
  if (kind === KIND_UNKNOWN) return null;
  let name, creator, album, uri;
  if (kind === KIND_TRACK) {
    name = r.master_metadata_track_name ?? 'Unknown track';
    creator = r.master_metadata_album_artist_name ?? 'Unknown artist';
    album = r.master_metadata_album_album_name ?? 'Unknown album';
    uri = r.spotify_track_uri ?? `${creator}|${name}`;
  } else if (kind === KIND_EPISODE) {
    name = r.episode_name ?? 'Unknown episode';
    creator = r.episode_show_name ?? 'Unknown show';
    album = creator;
    uri = r.spotify_episode_uri ?? `${creator}|${name}`;
  } else {
    name = r.audiobook_chapter_title ?? r.audiobook_title ?? 'Unknown chapter';
    creator = r.audiobook_title ?? 'Unknown audiobook';
    album = creator;
    uri = r.audiobook_chapter_uri ?? r.audiobook_uri ?? `${creator}|${name}`;
  }
  return { kind, name, creator, album, key: uri, spotifyId: uri.startsWith('spotify:') ? uri.split(':').pop() : null };
}

/**
 * Add export rows to the database in one transaction.
 * Throws ImportOverlapError (and changes nothing) when many "new" plays fall inside the history
 * already stored, which means the export format changed rather than new listening.
 */
export function importRows(db, rawRows, { force = false } = {}) {
  const rows = rawRows.filter((r) => r.ts).sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const before = db.prepare('SELECT count(*) AS n, max(ts) AS maxTs FROM plays').get();
  // Plays already stored per month ("2021-03"), for the safety check below.
  const storedByMonth = new Map(db.prepare('SELECT substr(ts, 1, 7) AS m, count(*) AS n FROM plays GROUP BY m').all().map((r) => [r.m, r.n]));

  const q = {
    artistId: db.prepare('SELECT id FROM artists WHERE name = ?'),
    addArtist: db.prepare('INSERT INTO artists (name) VALUES (?)'),
    albumId: db.prepare('SELECT id FROM albums WHERE name = ? AND artist_id = ?'),
    addAlbum: db.prepare('INSERT INTO albums (name, artist_id) VALUES (?, ?)'),
    trackId: db.prepare('SELECT id FROM tracks WHERE key = ?'),
    addTrack: db.prepare('INSERT INTO tracks (key, kind, name, artist_id, album_id, spotify_id) VALUES (?, ?, ?, ?, ?, ?)'),
    addCredit: db.prepare("INSERT OR IGNORE INTO credits (track_id, artist_id, position, source) VALUES (?, ?, 0, 'spotify')"),
    metaId: db.prepare(`SELECT id FROM meta WHERE ${META_FIELDS.map((f) => `${f} = ?`).join(' AND ')}`),
    addMeta: db.prepare(`INSERT INTO meta (track_id, ${META_FIELDS.join(', ')}) VALUES (?, ${META_FIELDS.map(() => '?').join(', ')})`),
    addPlay: db.prepare(`INSERT OR IGNORE INTO plays (hash, ts, meta_id, platform, ms_played, conn_country, reason_start,
      reason_end, shuffle, skipped, offline, offline_timestamp, incognito_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  };

  const artists = new Map();
  const albums = new Map();
  const tracks = new Map();
  const metas = new Map();
  let newTracks = 0;

  const artistId = (name) => {
    let id = artists.get(name);
    if (id === undefined) {
      id = q.artistId.get(name)?.id ?? Number(q.addArtist.run(name).lastInsertRowid);
      artists.set(name, id);
    }
    return id;
  };
  const albumId = (name, artist) => {
    const k = `${artist}\u0000${name}`;
    let id = albums.get(k);
    if (id === undefined) {
      id = q.albumId.get(name, artist)?.id ?? Number(q.addAlbum.run(name, artist).lastInsertRowid);
      albums.set(k, id);
    }
    return id;
  };
  const trackId = (item) => {
    let id = tracks.get(item.key);
    if (id === undefined) {
      id = q.trackId.get(item.key)?.id;
      if (id === undefined) {
        const a = artistId(item.creator);
        id = Number(q.addTrack.run(item.key, item.kind, item.name, a, albumId(item.album, a), item.spotifyId).lastInsertRowid);
        q.addCredit.run(id, a);
        newTracks++;
      }
      tracks.set(item.key, id);
    }
    return id;
  };
  const metaId = (r, track) => {
    const values = META_FIELDS.map((f) => (r[f] === null || r[f] === undefined ? '' : String(r[f])));
    const k = values.join('\u0000');
    let id = metas.get(k);
    if (id === undefined) {
      id = q.metaId.get(...values)?.id ?? Number(q.addMeta.run(track, ...values).lastInsertRowid);
      metas.set(k, id);
    }
    return id;
  };

  let added = 0;
  const overlapByMonth = new Map();
  transaction(db, () => {
    for (const r of rows) {
      const item = itemOf(r);
      const track = item ? trackId(item) : null;
      const res = q.addPlay.run(
        playHash(r), r.ts, metaId(r, track), r.platform ?? null, r.ms_played ?? null, r.conn_country ?? null,
        r.reason_start ?? null, r.reason_end ?? null, bool(r.shuffle), bool(r.skipped), bool(r.offline),
        r.offline_timestamp ?? null, bool(r.incognito_mode),
      );
      if (res.changes) {
        added++;
        if (before.n && r.ts <= before.maxTs) {
          const m = r.ts.slice(0, 7);
          overlapByMonth.set(m, (overlapByMonth.get(m) ?? 0) + 1);
        }
      }
    }
    // A few late-synced plays inside the old history are normal. Many in one month mean the export
    // format changed and old plays no longer look like the stored ones.
    const suspicious = [...overlapByMonth].filter(([m, n]) => n > Math.max(OVERLAP_MIN, (storedByMonth.get(m) ?? 0) * 0.01));
    if (!force && suspicious.length) {
      const total = suspicious.reduce((sum, [, n]) => sum + n, 0);
      throw new ImportOverlapError(
        `${total.toLocaleString()} "new" plays fall inside the history already imported ` +
          `(${suspicious.map(([m, n]) => `${m}: ${n.toLocaleString()}`).slice(0, 5).join(', ')}${suspicious.length > 5 ? ', …' : ''}). ` +
          'The export format probably changed, which would count old plays twice. Nothing was imported. ' +
          'If these really are new plays, run again with --force.',
      );
    }
  });

  return { raw: rawRows.length, added, duplicates: rows.length - added, skipped: rawRows.length - rows.length, newTracks };
}

/** Move answers from the old data/artwork-cache.json into the database, then rename the file. */
export function migrateArtworkCache(db, jsonFile) {
  if (!existsSync(jsonFile)) return 0;
  const cache = JSON.parse(readFileSync(jsonFile, 'utf8'));
  const apply = (table, id, entry) => {
    if (!entry) return 0;
    const res = entry.miss
      ? db.prepare(`UPDATE ${table} SET image_status = 'none', image_checked_at = ? WHERE id = ? AND image_status IS NULL`).run(entry.t ?? Date.now(), id)
      : db.prepare(`UPDATE ${table} SET image_status = 'found', image_thumb = ?, image_full = ?, image_source = ?, image_link = ?,
          image_checked_at = ? WHERE id = ? AND image_status IS NULL`).run(entry.thumb, entry.full, entry.source, entry.link ?? null, entry.t ?? Date.now(), id);
    return Number(res.changes);
  };
  let applied = 0;
  transaction(db, () => {
    for (const a of db.prepare('SELECT id, name FROM artists').all()) applied += apply('artists', a.id, cache[`artist:${normalize(a.name)}`]);
    const albums = db.prepare('SELECT al.id, al.name, ar.name AS artist FROM albums al JOIN artists ar ON ar.id = al.artist_id').all();
    for (const al of albums) applied += apply('albums', al.id, cache[`album:${normalize(al.artist)}|${normalizeAlbum(al.name)}`]);
  });
  renameSync(jsonFile, jsonFile.replace(/\.json$/, '.migrated.json'));
  return applied;
}
