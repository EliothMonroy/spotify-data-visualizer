# Spotify Data Visualizer

Local dashboards for your **Spotify Extended Streaming History** export.
Your listening data never leaves your machine, and nothing talks to Spotify.
The only outside requests are optional artwork lookups (see [Artwork](#artwork)).

## Quick start

1. Put your export folder in the project root, named `Spotify Extended Streaming History/`
   (it holds the `Streaming_History_Audio_*.json` files). It is git-ignored.
2. Install and run (Node 22.13+, which includes SQLite; dependencies install into the local `node_modules/` only):

   ```sh
   npm install
   npm start
   ```

3. Open http://localhost:5173

The first `npm start` imports your export into a local database, `data/spotify.db`, which is
the source of truth from then on. It also builds `data/plays.json`, the compact file the
dashboards load.

After downloading a newer export, run `npm run import`
(or `npm run import -- --source /path/to/export`). Spotify sends your whole history every time,
so plays already in the database are skipped and only new ones are added. If a changed export
format would make old plays look new, the import stops and explains instead of counting them
twice (`--force` overrides this). `npm run prepare-data` still works as another name for
`npm run import`.

## Artist credits

Spotify's export names only **one artist per play**, so collaborations count for the first
artist only. *Treasure Bay*, for example, is credited to Kevu, but Deezer lists **Kevu and ANG**.
`npm run credits` checks each track on Deezer for every credited artist, including featured
ones. Tracks Deezer doesn't have are then looked up on [MusicBrainz](https://musicbrainz.org),
the free, community-run music database (only tracks you played for 30 seconds or more). Each
artist then gets **full credit** for every play: one play of Treasure Bay counts as 1 play for
Kevu and 1 for ANG.

```sh
caffeinate -i npm run credits          # every track; caffeinate keeps a Mac awake
npm run credits -- --top 16000         # only your 16,000 most played unchecked tracks
npm run credits -- --retry-missing     # try again the tracks neither service had
```

- **Most-played tracks go first**, so stopping early still fixes most counts. With about 38,000
  tracks in a typical history:

  | Tracks checked | Share of plays | Time |
  |---|---|---|
  | Top 16,000 | ~90% | ~1 h 10 min |
  | Played at least twice | ~94% | ~1 h 30 min |
  | All | 100% | ~2 h 40 min (~3 h with retries) |
- **Each track is looked up once**, and every answer is saved straight away. **Ctrl+C** stops
  safely, and running it again continues where it left off.
- **It stays under each service's limit.** Deezer: about 8 requests a second (it allows 50 per 5
  seconds), slowing down if Deezer pushes back. While it runs, the dashboard's own image lookups
  slow to one per second. MusicBrainz: one request every 1.1 seconds, as it asks; its occasional
  "busy" answers are retried after a short wait. Checking the ~6,000 tracks Deezer misses in a
  typical history takes about 1 h 40 min.
- **Credits are only added on a confident match.** The track must have the same title, the same
  lead artist, and the same version (a remix never stands in for the original). Spotify's artist
  is always kept, and the services can only add artists. When MusicBrainz lists only Spotify's
  artist, the track is saved as *confirmed solo*. Tracks neither service has keep just their
  Spotify artist.
- **Every credit records where it came from** (`spotify`, `deezer` or `musicbrainz`).
- **When it finishes or stops,** `data/plays.json` is rebuilt. Reload the dashboard to see the
  new numbers. The footer shows for how many tracks all artists are known.

The **Collaborations** filter switches between *All credited artists* (the default) and
*First artist only*, which gives the numbers as Spotify's export has them.

## Dashboards

All dashboards share one filter row: **period** (all time, last 12 months, a year, or a
custom range), **content** (music, podcasts, or everything) and **what counts as a play**.

| View | What it shows |
|---|---|
| Overview | Total hours, plays, unique tracks/artists, listening over time, hours per year, year-by-year top artist & track |
| Top charts | Top artists, tracks and albums by plays or listening time, plus a full sortable, filterable table |
| On repeat | Play-count distribution, longest back-to-back runs, most plays in one day, most played albums, artists you replay most, artists across the most years |
| Habits | Weekday × hour heatmap, hour of day, day of week, month of year, a calendar of every day you listened |
| Discovery | New artists and tracks over time, your top 5 artists over time, best new finds, your #1 artist each year |
| Devices | Device types over time, how plays start and end, shuffle/offline/private-session rates, devices and countries |
| Explore | Search any artist, track, album or podcast for its own stats, timeline and play log |

Every chart has a **Table** button with the same numbers. Click a bar or a table row to open that
artist, track or album in Explore. The theme follows your system; the button in the top right switches it.

## Artwork

Artist photos and album covers come from free services that need no account or API key:

| Image | First try | Fallback |
|---|---|---|
| Artist photo | [Deezer API](https://developers.deezer.com/api) | [TheAudioDB](https://www.theaudiodb.com/free_music_api) (free shared key, ~30 requests/min) |
| Album cover (also used for tracks) | Deezer API | [iTunes Search API](https://performance-partners.apple.com/search-api) (~20 requests/min) |

- Only an artist or album name is sent (plus one of your track titles to pick the right artist
  when several share a name). Images then load from those services' image servers.
- **Image links are saved in the database** (never the images themselves), including "no
  image" answers, so nothing is looked up twice. "No image" answers are retried after 14 days.
- `npm run credits` also saves the photo of every credited artist and, when the album matches,
  the cover. Those come from Deezer's exact artist, so they're more reliable than a name search.
- Anything not saved yet is looked up through the local server, which rate-limits each service.
- Images load only as they scroll into view. Podcasts are skipped.
- Turn artwork off in the browser with the image button in the header, or for everything with
  `ARTWORK=off npm start`.

## How the numbers are computed

- **Plays** count listens of at least 30 seconds by default (the same rule Spotify uses for a
  stream). Change this with *Count a play after*. Listening time always includes every second.
- **Repeat listens are kept.** Only rows identical to another row in every field except the IP
  address are removed (about 200 in a typical export; Spotify sometimes logs the same play twice).
- **Collaborations count for every artist** once `npm run credits` has checked them (see
  [Artist credits](#artist-credits)). So artist totals can add up to more than your total plays.
  Total plays, hours, tracks and albums are unaffected.
- **Skipped** means the play ended with the next or back button. Spotify's own `skipped` field
  is missing for several years of history, so it isn't used.
- **Times** are shown in your browser's time zone, based on when each play started.
- **Albums** are grouped by album name *and* artist, so two "Greatest Hits" stay separate.
- **Privacy:** IP addresses are never stored, in the database or anywhere else. Everything in
  `data/` stays on your computer and is ignored by version control.

## Project layout

```
scripts/import.mjs         Export -> data/spotify.db, then writes data/plays.json
scripts/credits.mjs        Deezer artist credits backfill (npm run credits)
scripts/check-parity.mjs   Checks the database gives the same numbers as the raw export
scripts/lib/db.mjs         Database schema (built-in node:sqlite)
scripts/lib/import.mjs     Import, duplicate detection, artwork cache migration
scripts/lib/export.mjs     Database -> compact dashboard file
scripts/lib/credits.mjs    Matching a track on Deezer and saving its credits and images
scripts/lib/deezer.mjs     Deezer client and rate limiter
scripts/lib/musicbrainz.mjs  MusicBrainz client (fallback for artist credits)
scripts/lib/names.mjs      Name and title matching
scripts/lib/normalize.mjs  Device grouping and play flags
server.mjs                 Zero-dependency static server (127.0.0.1 only)
server/artwork.mjs         Artwork lookups for images not saved yet
public/                    The dashboard (plain HTML, CSS and ES modules, no build step)
  js/data.js               Loads the dataset, adds local-time fields
  js/aggregate.js          All statistics
  js/charts.js             ECharts option builders and table rendering
  js/views.js              The seven dashboards
  js/art.js                Lazy-loaded artist and album images
test/                      node --test unit tests (npm test)
```
