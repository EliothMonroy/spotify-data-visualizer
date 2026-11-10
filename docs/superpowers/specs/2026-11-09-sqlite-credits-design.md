# Local database and full artist credits — design

Date: 2026-11-09 · Status: built (PR #2), extended with a MusicBrainz fallback (PR #3, section 6).
Results of the real runs are in [Results](#results).

## Why

Spotify's export records **one artist per play** (`master_metadata_album_artist_name`). Collaborations
are credited only to the first artist. Example: *Treasure Bay* (437 plays, the owner's second most
played track) is credited to Kevu only; Deezer lists **KEVU** and **ang** as main artists. ANG's
totals are therefore too low, and the same is true for every collaboration in the history.

The owner wants:

1. **A local SQLite database as the source of truth** for all listening data, instead of the export
   files being re-read every time.
2. **Every track checked once against Deezer** for its full artist list, so plays are counted for
   every artist on a track.
3. **Image links stored in the same database**, so an artist, album or track image is never looked up
   twice.

## Decisions made with the owner

- **Full credit per artist.** One play of a track with two artists counts as one play for *each*
  artist. Example: Treasure Bay played once → Kevu +1, ANG +1.
- **Featured artists get full credit too**, the same as main artists (every Deezer contributor role).
- **Total plays, total hours, and track and album counts do not change** because of credits. A play
  is still one play. (One duplicate play is removed by the IP-blind dedupe below; that is the only
  change to totals.)
  Only per-artist numbers change, so artist totals can add up to more than total plays (this must
  be explained in the README's "How the numbers are computed").
- **The backfill runs in the terminal** with a progress line. The owner will leave the computer on
  for a few hours. No button in the app.
- **Only reduce requests by checking unique tracks** (38,190 music tracks, not 286,723 plays), most
  played first, and never check a track again once it has an answer.
- **Stay within Deezer's rate limit** (commonly reported as 50 requests per 5 seconds).
- **Store image URLs only**, never the image files.

## Calls I made (the owner has not confirmed these yet)

- Database file: `data/spotify.db` (git-ignored like the rest of `data/`). Built-in `node:sqlite`
  (Node 26.13 is installed; no new dependencies).
- Command names: `npm run import` and `npm run credits` (details below).
- **Spotify's artist is always kept.** Deezer can only add artists to a track, never remove or rename
  the Spotify one.
- **Prefer precision over recall.** Credits are added only on a confident match. When unsure, the track
  keeps its single Spotify artist.
- **Every credit records its source** (`spotify`, `deezer`, or `musicbrainz` since section 6). The app gets a switch to count only
  the Spotify artist, which must reproduce today's numbers exactly.
- **Artist identity stays as it is today:** one artist per exact Spotify name string, so "Beyoncé"
  and "Beyonce" remain separate if Spotify spells them both ways (needed for exact parity).
- **Attaching a Deezer contributor to an artist,** in order:
  1. the artist already linked to that Deezer artist id;
  2. an artist with the exact same name;
  3. the track's own Spotify artist, if the normalized names are equal (the existing `normalize()` in
     `server/artwork.mjs` ignores case, accents and punctuation, so Deezer's "KEVU" is Spotify's
     "Kevu");
  4. the single existing artist with that normalized name, if there is exactly one. With several
     candidates, the one with the most plays.
  5. Otherwise a new artist with Deezer's spelling.

  Normalized matching is skipped when the normalized name is empty (names with no letters or digits),
  and the first Deezer id linked to an artist sticks. Two different real artists with the same exact
  name stay merged, as they are today.
- **Discovery uses the credits.** If an artist was first heard on a collaboration, that play is their
  "first heard".
- **Albums do not change.** They are still grouped by album name plus Spotify's artist.

## Goals

### 1. Import: export → database

- `npm run import [-- --source <folder>]` reads `Streaming_History_(Audio|Video)_*.json`, the same
  files as today's `prepare-data`.
- **What is stored:** every field from the export **except `ip_addr`**, which is never stored. That
  means `ts`, `platform`, `ms_played`, `conn_country`, the track, episode and audiobook names and
  URIs, `reason_start`, `reason_end`, `shuffle`, `skipped`, `offline`, `offline_timestamp` and
  `incognito_mode`.
- **Normalized tables:** tracks (one per Spotify track URI; episodes and audiobook chapters likewise),
  artists, albums, plays, and track ↔ artist credits (with role, position and source).
- **Duplicates: today's rule minus the IP (my call).** A row is a duplicate only if every field
  except `ip_addr` is identical.
  - Each play stores a hash of a **fixed list** of the known export fields (all fields above except
    `ip_addr`, with keys in a fixed order and missing fields as null), with a unique constraint.
  - The IP never goes into the hash, so it can't be recovered from it by trying every address.
  - Measured on the real export (286,929 raw rows):
    - all fields: 206 duplicates (today's rule);
    - all fields minus IP: **207** (one play logged twice, differing only in IP);
    - `ts` + URI + `ms_played` + `platform`: 338, which would merge distinct plays;
    - `ts` + URI: 1,188.
  - So total plays become **286,722** (one fewer than today), and the README says why.
- **Re-importing is safe.**
  - Importing the same export again adds nothing. Spotify exports contain the full lifetime history,
    so a newer export overlaps almost entirely, and only its new plays and new tracks are added.
  - Because the hash uses a fixed field list, any field Spotify adds later is ignored rather than
    making every old play look new.
  - **Safety check:** if a re-import would add plays dated before the newest play already stored,
    beyond a small number (say more than 1% of the existing plays in those months), it stops and
    explains, unless `--force` is passed. This catches a format change that would otherwise double
    the history.
- **One-time migration.** Import moves the existing `data/artwork-cache.json` entries into the
  database. The JSON file is no longer used after that.
- **Summary:** import prints a short summary, as `prepare-data` does today (files, rows, duplicates
  removed, plays, tracks, artists).

### 2. Dashboard file built from the database

- The dashboards keep loading one compact file, `data/plays.json`, built **from the database** (not
  from the export). Speed and the zero-build client stay as they are.
- **Credits in the file.** The file gains per-item artist credits: an ordered list of artist ids per
  track, Spotify's artist first, plus a flag saying which credits came from Deezer. Bump `version` to 2.
- **When it's rebuilt:**
  - at the end of `npm run import`;
  - at the end of `npm run credits`, including when it is stopped with Ctrl+C;
  - by `npm start` if the file is missing.
- `npm run prepare-data` stays as an alias of `npm run import`, so the README and old habits keep working.

### 3. Artist credits backfill (`npm run credits`)

- **Which tracks:** music tracks with no Deezer answer yet, **ordered by play count, most played
  first**. `--top N` limits a run to the N most played unchecked tracks. Episodes and audiobooks are
  skipped.
- **Per track:**
  1. Search Deezer for the track. The strict query `artist:"A" track:"T"` returned nothing for Kevu –
     Treasure Bay while the loose query `A T` found it, so a loose search is required. The query
     order is the builder's choice.
  2. Pick the result whose normalized title matches (allowing version suffixes such as
     "- Radio Edit", "(feat. X)", "(Extended Mix)" only as a fallback, preferring the exact title)
     **and** whose artist or contributors include Spotify's artist (normalized).
  3. Fetch `GET https://api.deezer.com/track/{id}`. Its `contributors` array lists every credited
     artist with `id`, `name`, `role` ("Main" or "Featured") and `picture_*` URLs, and its `album`
     carries `cover_*` URLs. Search results do **not** include contributors, so this second request
     is required.
  4. Save the Deezer track id, the credits (source `deezer`, with role and position), the
     contributors' Deezer ids and pictures, and the album cover. If no confident match is found,
     save "not found".
- **Saved answers are final.**
  - Matched and not-found answers are written immediately, so Ctrl+C or a crash loses at most the
    requests in flight.
  - Rerunning resumes from where it stopped.
  - Not-found tracks are not retried unless `--retry-missing` is passed.
  - Network errors and rate-limit failures are **not** saved, so the track is tried again on the
    next run.
- **Rate limiting:**
  - Target about **8 requests per second**, with a few requests in flight. Deezer answers in about
    0.23 s, so one request at a time would manage only about 3 per second.
  - Never exceed 50 requests in any 5-second window.
  - On HTTP 429, a 5xx response, or Deezer's JSON error `code: 4` ("Quota limit exceeded"), back off
    and slow down. Recover gradually.
- **Sharing Deezer with the app:**
  - While a backfill runs, it writes a heartbeat row to the database (about every 10 s).
  - When the server sees a fresh heartbeat (under 30 s old), it limits its own Deezer lookups to
    about 1 per second, keeping the two together under the limit.
- **Progress line** (updated in place): tracks checked out of the total for this run, the share of
  all music plays now covered by checked tracks, found / not found / errors, requests per second,
  and estimated time left. Print a short summary at the end.
- **Expected duration** for all 38,190 tracks: about 76,400 requests, roughly 2 h 40 min at
  8 requests per second, about 3 h with retries. Stopping early still fixes most counts:

  | Tracks | Share of plays | Time |
  |---|---|---|
  | Top 16,225 | 90% | ~1 h 10 min |
  | 21,224 played at least twice | ~94% | ~1 h 30 min |
  | All 38,190 | 100% | ~2 h 40 min |
- **Keeping the Mac awake:** the README tells the owner to run `caffeinate -i npm run credits` so the
  Mac doesn't sleep.

### 4. Images in the database

- **Artists and albums** each store `image_thumb`, `image_full`, `image_source`, `image_link`,
  `image_status` (found / none) and `image_checked_at`. Tracks show their album's cover.
- **Images from the backfill:**
  - Contributor pictures and album covers from the track record are stored, so no separate artwork
    request is needed for anything the backfill has reached.
  - A contributor picture comes from an exact Deezer artist id, which is more reliable than a name
    search, so it **replaces** an artist image found by name search.
  - **Album covers (my call):** the matched Deezer track is often on a different release (the single,
    a compilation, a deluxe edition). Its `album.cover_*` is stored for the Spotify album only when
    the Deezer album title matches that album under the existing `normalizeAlbum`/`pickAlbum` rule.
    It never replaces a cover that is already found. Albums left without a cover still go through
    `/api/artwork`.
  - Deezer placeholder images, where the URL contains `/images/artist//` or `/images/cover//`, count
    as no image (existing rule).
- **The app's lookups use the database.** `/api/artwork` stays for anything not covered yet: it
  reads the database first, falls back to today's provider chain (Deezer → TheAudioDB or iTunes),
  and writes the answer back to the database. "None" answers are retried after 14 days (existing
  rule).
- **The dashboard file includes known image URLs**, so the app shows them without calling
  `/api/artwork` at all. Builder's choice: a per-artist and per-album thumb and full URL, or a
  separate file.
- Requests stay limited to the services already in use. No requests to Spotify.

### 5. Dashboards

- **Artist numbers count every credited artist:** plays, time, skips, streaks, days, first heard,
  loyalty, years, top lists, Explore pages, Discovery, and repeat stats per artist.
- **Track lines name every artist** ("Treasure Bay — Kevu, ANG"), and a track's Explore page links to
  each of them.
- **New filter, "Collaborations":** *All credited artists* (default) or *First artist only*. "First
  artist only" must reproduce today's numbers exactly. It is stored with the other filters and has
  no effect on track, album or overall totals.
- The **footer or Overview** shows how many tracks have been checked against Deezer (e.g. "Artist
  credits checked for 21,224 of 38,190 tracks (94% of plays)"), so the owner knows how complete the
  numbers are.
- **README:** document the database, `npm run import`, `npm run credits` (with `caffeinate`), the
  full-credit counting rule, and the Collaborations switch.

### 6. MusicBrainz fallback (added after the full Deezer run)

The full Deezer run left **6,227 tracks unmatched (17.7% of music plays)**. Those tracks still
counted for their Spotify artist only. [MusicBrainz](https://musicbrainz.org) became the second
source because it is free, needs no account or key, and is not a Spotify service. Each recording
there lists every credited artist, joined by phrases such as " & " or " feat. ".

**Decisions made with the owner:**

- **Only tracks played for 30 seconds or more** (the play rule the dashboards already use). Of the
  6,227 tracks, 4,356 qualify; the other 1,871 were only ever skipped quickly and aren't looked up.
- **No guessing from Spotify titles.** A track neither service has keeps its Spotify artist only.
  Artists named in a Spotify title ("Song (feat. X)") are not parsed into credits.

**Per track** (`checkTrackMusicBrainz` in `scripts/lib/credits.mjs`):

1. Search recordings with `recording:"T" AND artist:"A"` (`fmt=json&limit=10`). The title is
   searched without "(…)", "[…]" or a trailing " - Radio Edit" (`queryTitle`), because MusicBrainz
   stores those parts differently from Spotify.
2. Pick a result with the **same strict rules as Deezer** (`pickTrackCandidates`): same lead artist,
   same title, same version words (a remix never stands in for the original). The lead artist is
   compared by both its credited name and its MusicBrainz main name.
3. Credit every artist in the recording's artist credit. Artists after a "feat." join phrase are
   *Featured*, the rest *Main*. Contributors are attached to existing artists with the same rules
   as Deezer contributors (section "Calls I made"), using the name printed on the release first and
   MusicBrainz's main name as a backup. Example: the release says "Tomo Hirata", which matches
   Spotify, while MusicBrainz's main name is "平田知昌".
4. Save the answer in `tracks.mb_status`:
   - `matched`: new artists were added;
   - `solo`: MusicBrainz lists only Spotify's artist, so the track is **confirmed solo**;
   - `not_found`: no confident match.

   `mb_id` stores the MusicBrainz recording id. Rerunning skips tracks that already have an answer.
   `--retry-missing` tries again the tracks neither service found.

**Rate limit:** MusicBrainz asks for about one request per second and a descriptive User-Agent.

- One request at a time, at most one every **1.1 seconds**. Short bursts got "busy" (503) answers
  even when the average was under one per second.
- A "busy" answer (503 or 429) or a server error waits 2 seconds (or as long as `Retry-After` asks) and tries again, up to 5
  times. Timeouts (20 s) are retried the same way. These answers come now and then even at the
  allowed pace, so the run does not slow down because of them.
- About 1.4 s per track, so the 4,356 tracks take about 1 h 40 min. Deezer and MusicBrainz have
  separate limiters, so the Deezer part of a run is not slowed down.

**Problems found while building it:**

- The dashboard file read only Deezer credits; it now reads every credit whose source isn't
  `spotify`.
- Artists whose MusicBrainz main name is in another script (for example Japanese) were created as
  new artists instead of matching the Spotify artist. The fix is the credited-name-first rule in step 3. The 42 tracks matched
  before the fix were checked again.

## Results

### Deezer run (all 38,190 music tracks)

| | Tracks |
|---|---|
| Matched | 31,963 |
| Not found | 6,227 (17.7% of music plays) |

- **28,948 credits added:** 17,012 *Main* and 11,936 *Featured*.
- **Artists with plays went from 3,517 to 7,915.** Many artists were only ever heard as the second
  name on a collaboration.
- **Re-check after tightening the matching rules:** the first rules let a remix or a track with a
  different lead artist count as a match. After the fix, the 77 tracks checked under the old rules
  were checked again; 60 were found under the strict rules.
- **Spot checks looked right**, for example *Treasure Bay* → Kevu + ANG, the case that started this
  work.

Top 10 artists, before and after:

| Artist | Spotify's export | With all credits | Added | Rank before |
|---|---|---|---|---|
| ANG | 5,316 | 7,571 | +2,255 | 1 |
| Hardwell | 2,506 | 3,182 | +676 | 3 |
| KSHMR | 2,187 | 3,038 | +851 | 7 |
| Avicii | 2,774 | 3,004 | +230 | 2 |
| Yellow Claw | 2,133 | 2,981 | +848 | 8 |
| Bassjackers | 2,332 | 2,797 | +465 | 4 |
| Dimitri Vegas & Like Mike | 2,264 | 2,775 | +511 | 5 |
| Blasterjaxx | 2,108 | 2,674 | +566 | 9 |
| Tiësto | 2,193 | 2,628 | +435 | 6 |
| AFROJACK | 1,406 | 2,209 | +803 | 20 |

Skrillex gained the most outside the top 10 (+1,156, from #29 to #11), followed by Diplo (+1,007).

### MusicBrainz run (the 4,356 tracks Deezer missed)

In progress. Numbers will be added when the run finishes. Early spot checks look right, for example
*Wizard* → Martin Garrix + Jay Hardway and *Bounce Generation* → TJR + VINAI, both missing on
Deezer.

## Non-goals

- No requests to any Spotify service.
- Image files are not downloaded or stored, only their URLs.
- The browser doesn't query SQLite. The dashboards still load a compact file built from it.
- No button or page in the app to run the backfill.
- Podcasts and audiobooks are not enriched.
- Spotify's artist names, album grouping, and the play, skip and dedupe rules don't change.

## Anti-goals (failure even if it works)

- Total plays, total hours, track counts or album counts change.
- **Wrong artists get added.** One confidently wrong credit is worse than a missed one.
- Any field from the export is lost, except `ip_addr`, which must never be written.
- The database, the export or `plays.json` gets committed, or anything is installed globally.
- Deezer blocks or bans the owner for exceeding the limit.
- A long run can't be resumed, or a crash corrupts the database.

## Constraints

- Node built-ins only (`node:sqlite`, `node:http`); no new npm dependencies. Silence or explain any
  experimental-feature warning.
- Everything stays under the git-ignored `data/`. The server keeps listening on 127.0.0.1 only.
- The server and the backfill may use the database at the same time: use WAL mode and a busy timeout.
- Tests run with `node --test`.

## How to verify

- Unit tests:
  - title and artist matching, including the Kevu / ANG case, `(feat. X)` and version suffixes, and
    a same-name decoy that must be rejected;
  - merging credits into existing artists by normalized name;
  - re-importing the same rows adds nothing;
  - two rows differing only in `ip_addr` count as one play, and `ip_addr` changes neither the hash
    nor anything stored.
- **Parity check on the real export:** after import, 286,722 plays and 207 duplicates removed. With
  "First artist only", every dashboard number equals today's build, apart from that one duplicate
  play (compare the old `buildDataset` output, with the same IP-blind dedupe, against the new
  file's derived numbers).
- **Small live run:** `npm run credits -- --top 50` finishes in under a minute, credits ANG on
  Treasure Bay, and stores image URLs. Running it again makes zero requests for those tracks.
- Grep the database for any IP-shaped value from the export; there must be none.

## Left to the builder

- Exact schema, indexes, and the dataset file layout.
- Search query order and the exact title-similarity rule, within the precision-first rule above.
- How the client aggregates artist stats with several artists per play (today it keeps one artist per
  play in `D.creator`; `entityKeyFn('artist')` returns a single key).
- Progress line formatting, and the concurrency and backoff mechanism within the stated limits.
- Whether `npm run credits` also refreshes `plays.json` periodically during a long run, in addition to
  at the end.
