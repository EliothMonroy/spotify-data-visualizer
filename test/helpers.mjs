// Fixture rows shaped like the Spotify export.
export const IP = '203.0.113.77';

export function trackRow(ts, track, artist, album, uri, extra = {}) {
  return {
    ts,
    platform: 'iOS 17.1 (iPhone15,2)',
    ms_played: 150000,
    conn_country: 'MX',
    ip_addr: IP,
    master_metadata_track_name: track,
    master_metadata_album_artist_name: artist,
    master_metadata_album_album_name: album,
    spotify_track_uri: `spotify:track:${uri}`,
    episode_name: null,
    episode_show_name: null,
    spotify_episode_uri: null,
    audiobook_title: null,
    audiobook_uri: null,
    audiobook_chapter_uri: null,
    audiobook_chapter_title: null,
    reason_start: 'trackdone',
    reason_end: 'trackdone',
    shuffle: false,
    skipped: null,
    offline: false,
    offline_timestamp: null,
    incognito_mode: false,
    ...extra,
  };
}

export const treasureBay = (ts, extra) => trackRow(ts, 'Treasure Bay', 'Kevu', 'Treasure Bay', 'tb1', extra);

export function episodeRow(ts) {
  return {
    ...trackRow(ts, null, null, null, 'x'),
    spotify_track_uri: null,
    episode_name: 'Episode 1',
    episode_show_name: 'Some Show',
    spotify_episode_uri: 'spotify:episode:ep1',
  };
}
