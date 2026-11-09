# Spotify Data Visualizer

Local dashboards for your **Spotify Extended Streaming History** export.
Your listening data never leaves your machine, and nothing talks to Spotify.
The only outside requests are optional artwork lookups (see [Artwork](#artwork)).

## Quick start

1. Put your export folder in the project root, named `Spotify Extended Streaming History/`
   (it holds the `Streaming_History_Audio_*.json` files). It is git-ignored.
2. Install and run (Node 20+; dependencies install into the local `node_modules/` only):

   ```sh
   npm install
   npm start
   ```

3. Open http://localhost:5173

`npm start` builds `data/plays.json` from your export the first time it runs.
After downloading a newer export, rebuild with `npm run prepare-data`
(or `npm run prepare-data -- --source /path/to/export`).

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
- Lookups go through the local server, which rate-limits each service and caches every answer
  in `data/artwork-cache.json` (ignored by version control), so each name is looked up once.
- Images load only as they scroll into view. Podcasts are skipped.
- Turn artwork off in the browser with the image button in the header, or for everything with
  `ARTWORK=off npm start`.

## How the numbers are computed

- **Plays** count listens of at least 30 seconds by default (the same rule Spotify uses for a
  stream). Change this with *Count a play after*. Listening time always includes every second.
- **Repeat listens are kept.** Only rows that are exact copies of another row in every field are
  removed (about 200 in a typical export; Spotify sometimes logs the same play twice).
- **Skipped** means the play ended with the next or back button. Spotify's own `skipped` field
  is missing for several years of history, so it isn't used.
- **Times** are shown in your browser's time zone, based on when each play started.
- **Albums** are grouped by album name *and* artist, so two "Greatest Hits" stay separate.
- **Privacy:** `data/plays.json` keeps only what the dashboards need. IP addresses are dropped.

## Project layout

```
scripts/prepare-data.mjs   Reads the export, writes data/plays.json
scripts/lib/normalize.mjs  Dedupe, device grouping, compact column format
server.mjs                 Zero-dependency static server (127.0.0.1 only)
server/artwork.mjs         Artwork lookups, name matching, rate limits and cache
public/                    The dashboard (plain HTML, CSS and ES modules, no build step)
  js/data.js               Loads the dataset, adds local-time fields
  js/aggregate.js          All statistics
  js/charts.js             ECharts option builders and table rendering
  js/views.js              The seven dashboards
  js/art.js                Lazy-loaded artist and album images
test/                      node --test unit tests (npm test)
```
