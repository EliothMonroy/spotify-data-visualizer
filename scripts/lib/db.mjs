// The local SQLite database (data/spotify.db): the source of truth for listening history,
// artist credits and image links. Uses Node's built-in SQLite, so there is nothing to install.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const META_FIELDS = [
  'master_metadata_track_name',
  'master_metadata_album_artist_name',
  'master_metadata_album_album_name',
  'spotify_track_uri',
  'episode_name',
  'episode_show_name',
  'spotify_episode_uri',
  'audiobook_title',
  'audiobook_uri',
  'audiobook_chapter_uri',
  'audiobook_chapter_title',
];

const IMAGE_COLUMNS = `
  image_thumb TEXT,
  image_full TEXT,
  image_source TEXT,
  image_link TEXT,
  image_status TEXT,          -- NULL (not looked up), 'found' or 'none'
  image_checked_at INTEGER`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS artists (   -- artists, podcast shows and audiobooks ("creators")
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  deezer_id INTEGER UNIQUE,${IMAGE_COLUMNS}
);
CREATE TABLE IF NOT EXISTS albums (    -- grouped by album name + Spotify artist
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  artist_id INTEGER NOT NULL REFERENCES artists(id),${IMAGE_COLUMNS},
  UNIQUE (name, artist_id)
);
CREATE TABLE IF NOT EXISTS tracks (    -- tracks, podcast episodes and audiobook chapters
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,            -- Spotify URI, or "artist|name" when there is none
  kind INTEGER NOT NULL,               -- 0 track, 1 episode, 2 audiobook
  name TEXT NOT NULL,
  artist_id INTEGER NOT NULL REFERENCES artists(id),
  album_id INTEGER NOT NULL REFERENCES albums(id),
  spotify_id TEXT,
  deezer_status TEXT,                  -- NULL (not checked), 'matched' or 'not_found'
  deezer_id INTEGER,
  deezer_checked_at INTEGER,
  mb_status TEXT,                      -- MusicBrainz fallback: NULL, 'matched', 'solo' or 'not_found'
  mb_id TEXT,
  mb_checked_at INTEGER
);
CREATE TABLE IF NOT EXISTS credits (   -- every artist on a track; Spotify's artist is position 0
  track_id INTEGER NOT NULL REFERENCES tracks(id),
  artist_id INTEGER NOT NULL REFERENCES artists(id),
  position INTEGER NOT NULL,
  role TEXT,                           -- Deezer role: 'Main' or 'Featured'
  source TEXT NOT NULL,                -- 'spotify' or 'deezer'
  PRIMARY KEY (track_id, artist_id)
);
CREATE INDEX IF NOT EXISTS credits_artist ON credits(artist_id);
CREATE TABLE IF NOT EXISTS meta (      -- each distinct set of name/URI fields from the export
  id INTEGER PRIMARY KEY,
  track_id INTEGER REFERENCES tracks(id),
  ${META_FIELDS.map((f) => `${f} TEXT NOT NULL DEFAULT ''`).join(',\n  ')},
  UNIQUE (${META_FIELDS.join(', ')})
);
CREATE TABLE IF NOT EXISTS plays (     -- one row per play; every export field except ip_addr
  id INTEGER PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,           -- identifies exact duplicates (computed without the IP)
  ts TEXT NOT NULL,
  meta_id INTEGER NOT NULL REFERENCES meta(id),
  platform TEXT,
  ms_played INTEGER,
  conn_country TEXT,
  reason_start TEXT,
  reason_end TEXT,
  shuffle INTEGER,
  skipped INTEGER,
  offline INTEGER,
  offline_timestamp INTEGER,
  incognito_mode INTEGER
);
CREATE INDEX IF NOT EXISTS plays_ts ON plays(ts);
CREATE INDEX IF NOT EXISTS plays_meta ON plays(meta_id);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
`;

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 60000; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Columns added after the first release, for databases created before them.
const ADDED_COLUMNS = { tracks: { mb_status: 'TEXT', mb_id: 'TEXT', mb_checked_at: 'INTEGER' } };

function migrate(db) {
  for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [name, type] of Object.entries(columns)) {
      if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }
}

/** Run fn inside a transaction; roll back if it throws. */
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getKv(db, key) {
  return db.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value ?? null;
}

export function setKv(db, key, value) {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}
