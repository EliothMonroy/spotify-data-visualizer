# Local database and full artist credits — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `data/spotify.db` (SQLite) the source of truth for the listening history, credit every artist on a
track (from Deezer) with full plays, and store image URLs so nothing is looked up twice.

**Architecture:**
- **Import:** reads the export into normalized tables.
- **Export:** builds the same compact `data/plays.json` the dashboards load (now version 2: per-track extra
  artists, album groups, image URLs, a credit-check summary).
- **Backfill:** a resumable terminal command, `npm run credits`, fills credits and images from Deezer through
  a rate limiter.
- **Server:** artwork lookups read and write the same database.
- **Client:** artist stats iterate each track's credited artists, with a "First artist only" switch.

**Tech stack:** Node 26 built-ins (`node:sqlite`, `node:http`, `node:test`), plain ES-module client, ECharts
6.1.0. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-09-sqlite-credits-design.md`

## Global constraints

- No requests to any Spotify service. Deezer, TheAudioDB and iTunes only.
- `ip_addr` is never written to disk, in any form (including inside a hash).
- Dedupe rule: rows identical in every field except `ip_addr`. Real export: 286,929 raw → 207 duplicates →
  286,722 plays.
- Credits and dedupe change no totals except for that one duplicate play. Plays, hours, track and album
  counts stay the same.
- Full credit: each credited artist (role Main or Featured) gets every play of the track.
- Spotify's artist always stays first, and Deezer only adds artists. Precision over recall.
- Deezer: never more than 50 requests in any 5 s window. The backfill targets 8/s; the server drops to
  1/s while a backfill heartbeat is under 30 s old.
- Store image URLs only, never files.
- No new npm dependencies, and nothing global. Everything under the git-ignored `data/`. Server stays on
  127.0.0.1.
- `node --test` for tests. Commit after each task.

## Review focus

1. **Ctrl+C, or a crash, mid-backfill:** the database stays valid, every finished track is kept, and the
   next run resumes. Task 5 tests that answers are saved per track, and the live run in Task 7 interrupts it.
2. **Names with no letters or digits** ("!!!", "...") or that normalize to "": they must never merge with
   each other or swallow Deezer contributors. Task 1 tests this.
3. **A newer export containing the whole old history plus new plays:** only the new plays are added. A format
   change that would double the history stops with a clear message. Task 2 tests this.
4. **Deezer answers that aren't real misses:** quota JSON `{error:{code:4}}`, HTTP 429 or 5xx, timeouts, or
   non-JSON bodies. These must never be saved as "not found". Task 5 tests this.
5. **The dashboard loading while `plays.json` is being rewritten** by import or credits: it must never read a
   half-written file. `writeDataset` writes a temp file and renames it (Task 3 tests this).

---

### Task 1: Shared name matching

Move the pure name helpers out of `server/artwork.mjs` so the importer, backfill and server share them, and
add track and contributor matching.

**Files:**
- Create: `scripts/lib/names.mjs`
- Modify: `server/artwork.mjs` (import `normalize`, `normalizeAlbum`, `pickArtist`, `pickAlbum` from
  `../scripts/lib/names.mjs`, and re-export them so `test/artwork.test.mjs` keeps passing unchanged)
- Test: `test/names.test.mjs`

**Interfaces (produces):**
- `normalize(s): string`, `normalizeAlbum(s): string`, `pickArtist(results, name, nameOf?)` and
  `pickAlbum(results, artist, album, {artistOf, titleOf})`, moved unchanged.
- `baseTitle(s): string`: `normalize` after removing `(…)`/`[…]` groups and a trailing ` - …` part.
- `pickTrackCandidates(results, artist, title): DeezerTrack[]`, for Deezer search results (`{id, title,
  artist:{name}}`).
  - Keeps only results whose `normalize(title)` equals the wanted title (tier 1) or whose `baseTitle` equals
    it (tier 2).
  - Order: tier 1 before tier 2, then lead artist matching `normalize(artist)` before others.
  - Returns at most 2.
- `contributorsInclude(contributors, artist): boolean`: whether any `normalize(c.name)` equals
  `normalize(artist)`, never true for an empty normalized name.
- `resolveContributor(c, ctx): number | null`: picks the local artist id for a Deezer contributor `{id, name}`.
  `ctx` is `{byDeezerId: Map, byExactName: Map, byNorm: Map<string, {id, plays}[]>, trackArtist: {id, name}}`.
  It tries, in order:
  1. the artist linked to that Deezer id;
  2. an exact name match;
  3. the track's Spotify artist, if the normalized names are equal;
  4. the most-played artist with that normalized name.

  If none matches, it returns `null`, meaning the caller creates a new artist. Normalized steps are skipped
  when the normalized name is `''`.

- [ ] **Step 1: Write failing tests** in `test/names.test.mjs`:
  - `pickTrackCandidates` with results `[{id:1,title:'Treasure Bay (Extended Mix)',artist:{name:'KEVU'}},
    {id:2,title:'Treasure Bay',artist:{name:'KEVU'}}]` for `('Kevu','Treasure Bay')` → ids `[2,1]`.
  - The decoy `{id:3,title:'Treasure Bay',artist:{name:'Someone Else'}}` sorts after an `id:2` lead-artist
    match.
  - The title `'Other Song'` is excluded.
  - `baseTitle('Song (feat. X) - Radio Edit') === 'song'`.
  - `contributorsInclude([{name:'ang'}], 'ANG') === true`, and `contributorsInclude([{name:'!!!'}], '...')
    === false`.
  - `resolveContributor`:
    - Deezer `{id:9,name:'KEVU'}` with `trackArtist {id:4,name:'Kevu'}` → `4`;
    - `{id:5,name:'ang'}` with `byNorm` `ang → [{id:7,plays:10},{id:8,plays:900}]` → `8`;
    - an unknown name → `null`;
    - `{id:1,name:'!!!'}` with `byExactName` lacking it and `byNorm` holding `'' → [{id:2}]` → `null`.
- [ ] **Step 2: Run `node --test test/names.test.mjs`.** Expect failures: module not found.
- [ ] **Step 3: Implement `scripts/lib/names.mjs`** and update `server/artwork.mjs` imports and re-exports.
- [ ] **Step 4: Run `npm test`.** Expect all tests to pass (the 9 existing plus the new ones).
- [ ] **Step 5: Commit** with the message "Share name matching and add track and contributor matching".

### Task 2: Database schema and import

**Files:**
- Create: `scripts/lib/db.mjs`, `scripts/lib/import.mjs`, `scripts/import.mjs`
- Delete: `scripts/prepare-data.mjs` (replaced; the `prepare-data` npm script points to the new one)
- Modify: `package.json` scripts:
  - `"import": "node scripts/import.mjs"`
  - `"prepare-data": "node scripts/import.mjs"`
  - `"credits": "node scripts/credits.mjs"`
  - `"start": "node scripts/import.mjs --if-missing && node server.mjs"`
  - `"engines": {"node": ">=22.13"}`
- Test: `test/import.test.mjs`

**Interfaces (produces):**
- `openDb(file: string): DatabaseSync` in `db.mjs`. It creates the schema if missing and sets
  `journal_mode=WAL`, `busy_timeout=5000` and `foreign_keys=ON`. `':memory:'` must work for tests. If
  `node:sqlite` emits an ExperimentalWarning, filter that one warning (`process.removeAllListeners('warning')`
  is too broad; use an `emitWarning` filter scoped to the SQLite message).
- Schema (column names are fixed, because later tasks query them):
  - `artists(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, deezer_id INTEGER UNIQUE, image_thumb TEXT,
    image_full TEXT, image_source TEXT, image_link TEXT, image_status TEXT, image_checked_at INTEGER)`. The
    artist means any creator: artist, show or audiobook, exactly like today's `creators`. `image_status` is
    NULL, `'found'` or `'none'`.
  - `albums(id INTEGER PRIMARY KEY, name TEXT NOT NULL, artist_id INTEGER NOT NULL REFERENCES artists,
    image_* (same six columns), UNIQUE(name, artist_id))`.
  - `tracks(id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, kind INTEGER NOT NULL, name TEXT NOT NULL,
    artist_id INTEGER NOT NULL, album_id INTEGER NOT NULL, spotify_id TEXT, deezer_status TEXT,
    deezer_id INTEGER, deezer_checked_at INTEGER)`.
    - `key` is today's item key: the URI, or `creator|name`.
    - `kind` uses today's constants: 0 track, 1 episode, 2 audiobook.
    - `deezer_status` is NULL, `'matched'` or `'not_found'`.
  - `credits(track_id INTEGER NOT NULL, artist_id INTEGER NOT NULL, position INTEGER NOT NULL, role TEXT,
    source TEXT NOT NULL, PRIMARY KEY(track_id, artist_id))`. Source `'spotify'` is position 0;
    `'deezer'` starts at 1.
  - `meta(id INTEGER PRIMARY KEY, track_id INTEGER, <the 11 raw metadata fields>, UNIQUE(<all 11>))`.
    - The fields: `master_metadata_track_name`, `master_metadata_album_artist_name`,
      `master_metadata_album_album_name`, `spotify_track_uri`, `episode_name`, `episode_show_name`,
      `spotify_episode_uri`, `audiobook_title`, `audiobook_uri`, `audiobook_chapter_uri`,
      `audiobook_chapter_title`.
    - NULLs are stored as `''` so UNIQUE works.
    - `track_id` is NULL for rows of unknown kind.
  - `plays(id INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE, ts TEXT NOT NULL, meta_id INTEGER NOT NULL,
    platform TEXT, ms_played INTEGER, conn_country TEXT, reason_start TEXT, reason_end TEXT,
    shuffle INTEGER, skipped INTEGER, offline INTEGER, offline_timestamp INTEGER, incognito_mode INTEGER)`.
    NULLs are kept as NULL, so `skipped` stays NULL for the years Spotify omitted it.
  - `kv(key TEXT PRIMARY KEY, value TEXT)`, for the heartbeat and import info.
- `PLAY_FIELDS: string[]`, in `import.mjs`: every known export field except `ip_addr`, in a fixed order.
- `playHash(row): string`: sha1 hex of `JSON.stringify(PLAY_FIELDS.map(f => row[f] ?? null))`. Rows missing
  `ts` are skipped by the caller.
- `importRows(db, rows, {force=false}): {raw, added, duplicates, skipped, newTracks}`.
  - Runs in one transaction.
  - Upserts artists, albums, tracks, Spotify credits and meta. Tracks are created in time order, so first
    seen wins for names, exactly like `buildDataset`.
  - Inserts plays with `INSERT OR IGNORE` on `hash`.
  - **Safety check:** if the database already had plays, count the new plays dated at or before the newest
    existing `ts`. If that count is greater than both 100 and 1% of the existing plays, roll back and throw
    `ImportOverlapError` with a message telling the user to pass `--force`.
- `migrateArtworkCache(db, jsonFile): number`.
  - Reads today's `{ 'artist:<norm>': {...}, 'album:<normArtist>|<normAlbum>': {...} }`.
  - Applies each entry to every artist or album whose normalized key matches and whose `image_status` is
    NULL: a hit sets `'found'` plus the URLs and source; `{miss:true,t}` sets `'none'` with
    `image_checked_at = t`.
  - Returns the count applied, then renames the file to `artwork-cache.migrated.json`.
- CLI `scripts/import.mjs`: `[--source <dir>] [--if-missing] [--force]`.
  - Reads the same file pattern as today. Imports, migrates the cache if present, then calls `writeDataset`
    (Task 3).
  - Prints files, raw rows, added, duplicates, plays, tracks and artists.
  - With `--if-missing`: if the db exists and `data/plays.json` exists, do nothing. If the db exists and the
    JSON doesn't, only export. Otherwise import.

- [ ] **Step 1: Write failing tests** in `test/import.test.mjs` (in-memory database, small fixture rows built
  in the test):
  - `playHash` ignores `ip_addr`: two rows differing only in it give the same hash, and the hash differs
    when `ms_played` differs.
  - Importing 3 rows where 2 differ only in IP gives `added === 2` and `duplicates === 1`.
  - Re-importing the same rows gives `added === 0`.
  - Importing old rows plus one newer row adds only that one.
  - With 200 existing plays, importing 150 rows of the same dates with a changed field throws
    `ImportOverlapError`; with `{force:true}` it doesn't.
  - Treasure Bay rows create one track with one credit (`source 'spotify'`, position 0).
  - `SELECT * FROM plays` contains no column named `ip_addr` and no value equal to the fixture IP. Scan all
    tables.
- [ ] **Step 2: Run `node --test test/import.test.mjs`.** Expect failures.
- [ ] **Step 3: Implement** `db.mjs`, `import.mjs` and the CLI. Remove `scripts/prepare-data.mjs` and update
  `package.json`.
- [ ] **Step 4: Run `npm test`.** Expect everything to pass.
- [ ] **Step 5: Commit** with the message "Add SQLite database and import from the Spotify export".

### Task 3: Dashboard file built from the database

**Files:**
- Create: `scripts/lib/export.mjs`
- Modify: `scripts/lib/normalize.mjs`: `buildDataset` uses the IP-blind dedupe (`dedupeExact` keys on
  `PLAY_FIELDS`), so the parity check compares like with like. `normalizePlatform` and `flagsOf` are reused
  by export.
- Modify: `public/js/data.js`: `prepare` accepts version 2 (albums come pre-grouped) and is exported for
  tests.
- Create: `scripts/check-parity.mjs`, a one-off check script, kept for future imports.
- Test: `test/export.test.mjs`

**Interfaces:**
- Consumes: `openDb`, `importRows` and the schema from Task 2.
- Produces: `buildDatasetFromDb(db): Dataset` and `writeDataset(db, outFile): Promise<void>`. The latter
  writes `outFile + '.tmp'` and then renames it.
- Dataset version 2 is the same as today's version 1 except:
  - `version: 2`;
  - `albums: [{name, creator}]`, already grouped by name plus Spotify artist. `items.album` indexes it.
  - `items.extra: number[][]`, aligned with items. Each entry lists the creator ids from Deezer credits in
    position order, and is usually `[]`.
  - `creatorImages` and `albumImages`: arrays aligned with `creators` and `albums`, each entry
    `[thumb, full, source, link]` or `null`.
  - `credits: {checked, matched, total, playsCovered, playsTotal}`, counting music tracks only. Plays count
    those with `ms_played >= 30000`.
  - Creators, families, devices, countries and reasons keep today's dictionary semantics and order, first
    seen in time order.
- `prepare(raw)` in `data.js`:
  - uses `raw.albums` directly when `raw.version >= 2`, and keeps today's grouping for version 1;
  - exposes `D.extra` (`raw.items.extra` or empty arrays), `D.creatorImages`, `D.albumImages` and
    `D.creditsInfo`.

- [ ] **Step 1: Write failing tests** in `test/export.test.mjs`:
  - Import fixture rows (Kevu "Treasure Bay" ×3, one podcast episode, one duplicate), then
    `buildDatasetFromDb`.
  - `plays.ts.length === 4`, `version === 2`, and `items.extra[treasureBay]` deep-equals `[]`.
  - After inserting a Deezer credit for ANG, it deep-equals `[angId]`.
  - The podcast's `albums` entry has `creator` equal to the show.
  - `writeDataset` leaves no `.tmp` file and produces valid JSON. While it runs, the target is either the old
    file or the new one.
- [ ] **Step 2: Run `node --test test/export.test.mjs`.** Expect failures.
- [ ] **Step 3: Implement** `export.mjs`, the `prepare` changes and the IP-blind `buildDataset`.
- [ ] **Step 4: Run `npm test`.** Expect everything to pass.
- [ ] **Step 5: Real import and parity.**
  - Run `npm run import`. Expect "286,929 raw rows … 207 duplicates … 286,722 plays".
  - Run `node scripts/check-parity.mjs`. It builds the version 1 dataset from the export with
    `buildDataset`, and version 2 from the db. It runs both through `prepare`, then compares:
    - per-item play and ms totals;
    - per-creator totals (with no extras);
    - per-album totals;
    - `summarize` over all plays;
    - device, country and reason counts.

    Expect "parity OK".
  - Load the dashboard and smoke-check every view.
- [ ] **Step 6: Commit** with the message "Build the dashboard file from the database".

### Task 4: Count every credited artist in the dashboards

**Files:**
- Modify: `public/js/data.js`: add `applyCreditMode(D, mode)`.
- Modify: `public/js/aggregate.js`, `public/js/views.js`, `public/js/app.js`, `public/index.html`,
  `public/styles.css` (if needed)
- Test: `test/credits.test.mjs`

**Interfaces:**
- `applyCreditMode(D, mode: 'all' | 'first'): void`.
  - Builds `D.credStart` (an `Int32Array(items.count + 1)`) and `D.credIds` (an `Int32Array`). The artists
    of item `it` are `D.credIds.subarray(D.credStart[it], D.credStart[it+1])`: the Spotify creator first,
    then `D.extra[it]` when mode is `'all'`.
  - Recomputes `creatorFirst`, `creatorTotal` and `creatorTopItem` from those credits.
  - `D.creator[i]` stays the Spotify artist, used for albums and podcasts.
  - `prepare` calls `applyCreditMode(D, 'all')`.
- `artistsOf(D, it): Int32Array`, exported from `data.js`.
- `artistNames(D, it): string`: the credited names joined with ", ", in `format.js` or `aggregate.js`.
- In `aggregate.js`, the artist path iterates `artistsOf` everywhere it used `D.creator[i]`: `summarize`
  (`artists`), `groupStats(…, 'artist')`, `loyalArtists`, `discoveries` (count every credited artist whose
  `creatorFirst === i`) and `entityTimelines(…, 'artist')`.
  - `entityKeyFn` stays for track and album only.
  - New: `playsOf(D, idx, by, id): Int32Array`, used by Explore.
- In `views.js`:
  - every track subtitle uses `artistNames` (`entityLabel('track')`, the lines that build
    `D.creators[D.items.creator[…]]` for tracks, the search index and the chips);
  - the Explore track meta links to each credited artist;
  - Discovery's "new artist time" counts a play once if any credited artist is new.
- Filters:
  - a `#f-credits` select in the filter row with the label "Collaborations" and options `all` ("All
    credited artists") and `first` ("First artist only");
  - stored as `sdv:credits`, default `'all'`;
  - on change, call `applyCreditMode` and then clear the selection cache.
- Footer: "Artist credits checked for {checked} of {total} tracks ({pct} of plays)", from `D.creditsInfo`.
  Hidden when `checked === 0`.

- [ ] **Step 1: Write failing tests** in `test/credits.test.mjs`. Build a raw version 2 dataset by hand:
  - Items: track A (creator Kevu, extra `[ANG]`) and track B (creator ANG). Plays: A ×3 and B ×1, all
    40 s.
  - Then `prepare` and `applyCreditMode`:
    - with mode `'all'`: `groupStats(D, all, 30000, 'artist')` gives Kevu 3 and ANG 4;
      `summarize(...).plays === 4`; `summarize(...).artists === 2`;
    - ANG's `creatorFirst` is A's first play;
    - with mode `'first'`: Kevu 3 and ANG 1;
    - `playsOf(D, all, 'artist', ANG).length === 4` in `'all'`;
    - `artistNames(D, A) === 'Kevu, ANG'`.
- [ ] **Step 2: Run `node --test test/credits.test.mjs`.** Expect failures.
- [ ] **Step 3: Implement** the data, aggregate, views and app changes, and the filter markup.
- [ ] **Step 4: Run `npm test`, then the smoke test.** Run every view × kind × both credit modes in Node with
  browser stubs, using the existing smoke approach. Expect 0 failures. Then screenshot Explore → Treasure Bay
  (once credits exist; until then, a hand-added credit in a scratch database).
- [ ] **Step 5: Commit** with the message "Count plays for every credited artist".

### Task 5: Deezer backfill command

**Files:**
- Create: `scripts/lib/deezer.mjs`, `scripts/lib/credits.mjs`, `scripts/credits.mjs`
- Test: `test/deezer.test.mjs`, `test/credits-backfill.test.mjs`

**Interfaces:**
- `createLimiter({max = 40, windowMs = 5000, concurrency = 4, now, sleep}): {run(task), slowDown(),
  stats()}`. It is a sliding window, so at most `max` starts in any `windowMs`.
  - `slowDown()` halves `max` (minimum 10) and pauses new starts for 10 s.
  - The limit recovers by 5 per minute without errors, up to the original `max`.
- `createDeezer({limiter, fetch = globalThis.fetch}): {searchTracks(q), track(id)}`.
  - Retries up to 3 times on HTTP 429, 5xx or `json.error.code === 4`, calling `limiter.slowDown()` each time.
  - Throws `TransientError` on timeout (10 s), on non-JSON responses or once retries run out.
  - Any other `json.error` also throws `TransientError`.
- `checkTrack(db, deezer, track: {id, name, artistId, artistName, albumId, albumName}): Promise<'matched' |
  'not_found'>`.
  1. Search loose `"<artist> <title>"` with `limit=10`. If `pickTrackCandidates` returns nothing, search
     strict `artist:"<artist>" track:"<title>"`.
  2. For up to 2 candidates, call `deezer.track(id)` and accept the first whose `contributorsInclude` holds
     the Spotify artist.
  3. On a match, in one transaction:
     - Insert a `credits` row for each contributor (`resolveContributor`, or create an artist; skip it if it
       resolves to the Spotify artist) with `source 'deezer'`, `role` and `position` 1…
     - Link `artists.deezer_id` if it's empty and the id isn't taken.
     - Set the artist image from `picture_medium` / `picture_xl` (unless it's a placeholder), with
       `image_source 'Deezer'`. This replaces an image found by name search.
     - Set the album cover only when `pickAlbum([track.album], …)` matches the Spotify album name and the
       album's `image_status` isn't `'found'`.
     - Set `tracks.deezer_status`, `deezer_id` and `deezer_checked_at`.
  4. With no accepted candidate, set `'not_found'`.

  `TransientError` propagates and nothing is saved.
- CLI `scripts/credits.mjs [--top N] [--retry-missing]`.
  - Selects music tracks (`kind = 0`) with `deezer_status IS NULL` (plus `'not_found'` when
    `--retry-missing` is passed), ordered by plays with `ms_played >= 30000` descending, and limits to N.
  - Runs `checkTrack` through the limiter with up to 4 in flight.
  - Writes `kv('credits_heartbeat', Date.now())` every 10 s.
  - Redraws one progress line every 500 ms with `\r`:
    `1,234 / 16,000 · 72.4% of plays covered · 1,180 found · 50 not found · 4 errors · 7.9 req/s · ~1h 02m left`.
  - On SIGINT, stops scheduling, waits for in-flight requests (up to 15 s), then writes the dataset and
    prints a summary. A second Ctrl+C exits immediately.
  - When finished, also writes the dataset and summary.

- [ ] **Step 1: Write failing tests** for the limiter and Deezer client (`test/deezer.test.mjs`), using a fake
  clock and a fake fetch:
  - 100 tasks with `max 40/5000ms` never start more than 40 within any 5000 ms;
  - `{error:{code:4}}` causes a retry and `slowDown`;
  - three quota errors in a row throw `TransientError`;
  - an HTML body throws `TransientError`.
- [ ] **Step 2: Write failing tests** for `checkTrack` (`test/credits-backfill.test.mjs`), using an in-memory
  database seeded via `importRows` with Kevu "Treasure Bay" and an existing artist "ANG", plus a fake Deezer:
  - **Match:**
    - the result is `'matched'`;
    - the credits are Kevu (spotify, 0) and ANG (deezer, 1, role 'Main');
    - ANG's `deezer_id` is 4985806 and ANG's image is the contributor picture;
    - the album cover is set because the album "Treasure Bay" matches.
  - **Decoy:** the only search result is "Treasure Bay" by "Someone", and that track's contributors don't
    include Kevu, so the result is `'not_found'` with no new credits.
  - **Placeholder:** a contributor `picture_xl` containing `/images/artist//` sets no image.
  - **Transient error:** the fake throws `TransientError` on `track()`, so `deezer_status` stays NULL.
- [ ] **Step 3: Run `node --test test/deezer.test.mjs test/credits-backfill.test.mjs`.** Expect failures.
- [ ] **Step 4: Implement** `deezer.mjs`, `credits.mjs` and the CLI.
- [ ] **Step 5: Run `npm test`.** Expect everything to pass.
- [ ] **Step 6: Commit** with the message "Add resumable Deezer artist credits backfill".

### Task 6: Images from the database in the server and the app

**Files:**
- Modify: `server/artwork.mjs`: `createArtworkService({db})` replaces the JSON cache.
- Modify: `server.mjs`: opens the db; artwork is off when there is no database.
- Modify: `public/js/art.js`: use direct URLs from the dataset first.
- Test: extend `test/artwork.test.mjs`

**Interfaces:**
- `createArtworkService({db, now = Date.now})` → `{lookup(type, artist, name, hint)}`. Same HTTP contract as
  today.
  - Finds the row by exact artist name (and album name for albums).
  - Returns the stored image when `image_status = 'found'`, or `null` when it's `'none'` and less than 14 days
    old.
  - Otherwise runs today's provider chain and writes the answer to that row. If no row is found, it looks up
    without storing.
  - Before each Deezer request it reads `kv.credits_heartbeat`. If the heartbeat is under 30 s old, the
    Deezer gap is 1000 ms instead of 120 ms.
- `art.js`:
  - `artistArt` and `albumArt` include `direct: {thumb, full, source}` when `D.creatorImages[c]` or
    `D.albumImages[a]` exists.
  - `load` uses `direct` without calling `fetchArt`.
  - When the artwork toggle is off, still nothing loads.

- [ ] **Step 1: Write failing tests** in `test/artwork.test.mjs`:
  - With an in-memory database whose artist row has `image_status 'found'`, `lookup('artist','ANG')` returns
    the stored URL and the fake fetch is never called.
  - A `'none'` answer 1 day old returns `null` without fetching.
  - A `'none'` answer 15 days old fetches again.
- [ ] **Step 2: Run `node --test test/artwork.test.mjs`.** Expect failures.
- [ ] **Step 3: Implement** the service, the server wiring and the `art.js` direct URLs.
- [ ] **Step 4: Run `npm test`, then restart the server.** Check that Overview images appear and that the
  server log shows no lookups for cached artists.
- [ ] **Step 5: Commit** with the message "Store artwork in the database".

### Task 7: Docs and live verification

**Files:**
- Modify: `README.md`, covering:
  - the database;
  - `npm run import` (`prepare-data` still works);
  - `caffeinate -i npm run credits` with `--top N` and `--retry-missing`, plus the time estimates table from
    the spec;
  - the full-credit rule, with the note that artist totals can exceed total plays;
  - the Collaborations filter;
  - the 286,722 plays and the IP-blind dedupe;
  - images stored as URLs in the database;
  - the project layout.

- [ ] **Step 1: Run the live small check.** Run `npm run credits -- --top 50`. Expect it to finish in under a
  minute, with Treasure Bay matched and credited to ANG (query the db).
- [ ] **Step 2: Run it again.** Expect "0 tracks to check" for that top 50: run `--top 50` again and check
  zero Deezer requests in the summary.
- [ ] **Step 3: Interrupt a run.** Run `--top 120` and press Ctrl+C after about 5 s. Expect a clean summary
  and an updated `plays.json`; the rerun resumes.
- [ ] **Step 4: Scan for IPs.** Take the distinct `ip_addr` values from the export and grep the
  `sqlite3`-free dump (`node -e` with `SELECT` over every text column). Expect 0 hits.
- [ ] **Step 5: Final checks.** Update the README, run `npm test`, and check screenshots: Explore → ANG shows
  Treasure Bay, and the Collaborations switch changes ANG's plays.
- [ ] **Step 6: Commit** with the message "Document the database and artist credits".
