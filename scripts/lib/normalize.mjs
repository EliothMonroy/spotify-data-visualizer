// Pure helpers that turn raw Spotify export rows into a compact dataset.

export const FLAG_SHUFFLE = 1;
export const FLAG_SKIPPED = 2;
export const FLAG_OFFLINE = 4;
export const FLAG_INCOGNITO = 8;

export const KIND_TRACK = 0;
export const KIND_EPISODE = 1;
export const KIND_AUDIOBOOK = 2;
export const KIND_UNKNOWN = 3;

/** Group a raw platform string into a device family plus a readable device name. */
export function normalizePlatform(raw) {
  const p = String(raw ?? '').trim();
  const lower = p.toLowerCase();

  const android = p.match(/^Android OS [\d.]+ API \d+ \(([^,]+),\s*([^)]+)\)/);
  if (android) return { family: 'Android', device: `${android[1]} ${android[2]}`.trim() };
  const sdk = p.match(/android_sdk\s+([^;]+);([^;]+);/i);
  if (sdk) return { family: 'Android', device: `${sdk[1][0]}${sdk[1].slice(1).toLowerCase()} ${sdk[2].toUpperCase()}` };
  if (lower === 'android' || lower.startsWith('android')) return { family: 'Android', device: 'Android' };

  if (lower.startsWith('ios') || lower.includes('iphone') || lower.includes('ipad')) {
    const model = p.match(/\(([^)]+)\)/);
    return { family: 'iOS', device: model ? model[1] : 'iOS' };
  }
  if (lower.startsWith('windows')) return { family: 'Windows', device: 'Windows PC' };
  if (lower.startsWith('os x') || lower === 'osx' || lower.startsWith('macos')) {
    return { family: 'macOS', device: lower.includes('arm') ? 'Mac (Apple silicon)' : 'Mac' };
  }
  if (lower.startsWith('linux')) return { family: 'Linux', device: 'Linux PC' };
  if (lower.includes('xbox')) return { family: 'Console', device: 'Xbox' };
  if (lower.includes('ps4') || lower.includes('ps5') || lower.includes('sony_tv')) return { family: 'Console', device: 'PlayStation' };
  if (lower.includes('_tv') || lower.includes('webos')) return { family: 'Smart TV', device: 'Smart TV' };
  if (lower.includes('web_player') || lower.startsWith('webplayer')) return { family: 'Web', device: 'Web player' };
  if (lower === 'cast' || lower.includes('cast')) return { family: 'Cast', device: 'Cast device' };
  return { family: 'Other', device: p || 'Unknown' };
}

/** What a row represents: a song, a podcast episode, an audiobook chapter, or unknown. */
export function kindOf(row) {
  if (row.spotify_track_uri || row.master_metadata_track_name) return KIND_TRACK;
  if (row.spotify_episode_uri || row.episode_name) return KIND_EPISODE;
  if (row.audiobook_uri || row.audiobook_title) return KIND_AUDIOBOOK;
  return KIND_UNKNOWN;
}

export function flagsOf(row) {
  return (row.shuffle ? FLAG_SHUFFLE : 0)
    | (row.skipped ? FLAG_SKIPPED : 0)
    | (row.offline ? FLAG_OFFLINE : 0)
    | (row.incognito_mode ? FLAG_INCOGNITO : 0);
}

/**
 * Drop rows that are exact copies of another row (every field identical).
 * Repeat listens of the same track happen at different times, so they are kept.
 */
export function dedupeExact(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = JSON.stringify(row, Object.keys(row).sort());
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/** Index strings into a dictionary array; returns the lookup function and the array. */
export function dictionary() {
  const values = [];
  const index = new Map();
  return {
    values,
    id(value) {
      const key = value ?? '';
      let i = index.get(key);
      if (i === undefined) {
        i = values.length;
        values.push(key);
        index.set(key, i);
      }
      return i;
    },
  };
}

/**
 * Build the compact, column-oriented dataset the dashboard loads.
 * IP addresses and other identifiers are intentionally not copied.
 */
export function buildDataset(rawRows) {
  const rows = dedupeExact(rawRows)
    .filter((r) => r.ts)
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  const creators = dictionary(); // artists, podcast shows, audiobook titles
  const albums = dictionary();
  const families = dictionary();
  const devices = dictionary();
  const countries = dictionary();
  const reasonsStart = dictionary();
  const reasonsEnd = dictionary();

  const items = { name: [], creator: [], album: [], kind: [], uri: [] };
  const itemIndex = new Map();

  const plays = { ts: [], ms: [], item: [], family: [], device: [], country: [], rs: [], re: [], flags: [] };

  for (const r of rows) {
    const kind = kindOf(r);
    let item = -1;
    if (kind !== KIND_UNKNOWN) {
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
      item = itemIndex.get(uri);
      if (item === undefined) {
        item = items.name.length;
        itemIndex.set(uri, item);
        items.name.push(name);
        items.creator.push(creators.id(creator));
        items.album.push(albums.id(album));
        items.kind.push(kind);
        items.uri.push(uri.startsWith('spotify:') ? uri.split(':').pop() : '');
      }
    }

    const { family, device } = normalizePlatform(r.platform);
    plays.ts.push(Math.round(Date.parse(r.ts) / 1000));
    plays.ms.push(Math.max(0, r.ms_played | 0));
    plays.item.push(item);
    plays.family.push(families.id(family));
    plays.device.push(devices.id(device));
    plays.country.push(countries.id(r.conn_country || 'ZZ'));
    plays.rs.push(reasonsStart.id(r.reason_start || 'unknown'));
    plays.re.push(reasonsEnd.id(r.reason_end || 'unknown'));
    plays.flags.push(flagsOf(r));
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    stats: { rawRows: rawRows.length, duplicatesRemoved: rawRows.length - rows.length, plays: rows.length },
    creators: creators.values,
    albums: albums.values,
    families: families.values,
    devices: devices.values,
    countries: countries.values,
    reasonsStart: reasonsStart.values,
    reasonsEnd: reasonsEnd.values,
    items,
    plays,
  };
}
