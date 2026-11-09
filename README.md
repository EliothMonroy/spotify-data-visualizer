# Spotify Data Visualizer

Local dashboards for your **Spotify Extended Streaming History** export.
Everything runs on your machine — no Spotify API calls, no external requests.

## Quick start

1. Put your export folder in the project root, named `Spotify Extended Streaming History/`
   (it holds the `Streaming_History_Audio_*.json` files). It is git-ignored.
2. Install and run:

   ```sh
   npm install
   npm start
   ```

3. Open http://localhost:5173

`npm start` builds `data/plays.json` from your export the first time it runs.
After adding a new export, rebuild with `npm run prepare-data`.
