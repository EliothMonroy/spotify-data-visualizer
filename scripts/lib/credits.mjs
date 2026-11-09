// Artist credits: find each track on Deezer (or, when Deezer doesn't have it, on MusicBrainz),
// read its full list of artists and credit every one of them. Deezer also gives their pictures
// and (when it is the same album) the cover.
import { transaction } from './db.mjs';
import { queryTitle } from './musicbrainz.mjs';
import { normalize, pickAlbum, pickTrackCandidates, contributorsInclude, resolveContributor } from './names.mjs';
import { hasDeezerImage, TransientError } from './deezer.mjs';

const MIN_PLAY_MS = 30000;

/** Failures worth trying again later: service trouble, or the database busy with another process. */
export function isTransient(err) {
  return err instanceof TransientError || err?.errcode === 5 || err?.errcode === 6 || /database is (locked|busy)/i.test(err?.message ?? '');
}

/**
 * Music tracks still waiting for an answer, most played first: never checked on Deezer, or missed
 * by Deezer and not yet checked on MusicBrainz (only tracks played for 30 seconds or more go to
 * MusicBrainz). With retryMissing, "not found" answers are tried again too.
 * @returns {{id, name, artistId, artistName, albumId, albumName, plays, deezerStatus, mbStatus}[]}
 */
export function tracksToCheck(db, { top = 0, retryMissing = false } = {}) {
  const status = retryMissing
    ? "(t.deezer_status IS NULL OR (t.deezer_status = 'not_found' AND (t.mb_status IS NULL OR t.mb_status = 'not_found')))"
    : "(t.deezer_status IS NULL OR (t.deezer_status = 'not_found' AND t.mb_status IS NULL AND coalesce(c.n, 0) > 0))";
  return db.prepare(`
    SELECT t.id, t.name, t.artist_id AS artistId, a.name AS artistName, t.album_id AS albumId, al.name AS albumName,
      coalesce(c.n, 0) AS plays, t.deezer_status AS deezerStatus, t.mb_status AS mbStatus
    FROM tracks t
    JOIN artists a ON a.id = t.artist_id
    JOIN albums al ON al.id = t.album_id
    LEFT JOIN (SELECT m.track_id, count(*) AS n FROM plays p JOIN meta m ON m.id = p.meta_id
               WHERE p.ms_played >= ${MIN_PLAY_MS} GROUP BY m.track_id) c ON c.track_id = t.id
    WHERE t.kind = 0 AND ${status}
      AND t.name <> 'Unknown track' AND a.name <> 'Unknown artist'
    ORDER BY plays DESC, t.id
    ${top > 0 ? `LIMIT ${Math.floor(top)}` : ''}`).all().map((r) => ({ ...r }));
}

// Lookup tables for matching contributors to local artists, built once per database.
const contexts = new WeakMap();
function contextFor(db) {
  let ctx = contexts.get(db);
  if (ctx) return ctx;
  const plays = new Map(db.prepare(`SELECT t.artist_id AS id, count(*) AS n FROM plays p JOIN meta m ON m.id = p.meta_id
    JOIN tracks t ON t.id = m.track_id GROUP BY t.artist_id`).all().map((r) => [r.id, r.n]));
  ctx = { byDeezerId: new Map(), byExactName: new Map(), byNorm: new Map() };
  // Podcast shows and audiobooks share the artists table; they must never receive music credits.
  for (const a of db.prepare(`SELECT id, name, deezer_id FROM artists a WHERE NOT ${NON_MUSIC}`).all()) remember(ctx, a, plays.get(a.id) ?? 0);
  contexts.set(db, ctx);
  return ctx;
}
function remember(ctx, a, plays = 0) {
  ctx.byExactName.set(a.name, a.id);
  if (a.deezer_id !== null && a.deezer_id !== undefined) ctx.byDeezerId.set(a.deezer_id, a.id);
  const norm = normalize(a.name);
  if (!norm) return;
  let list = ctx.byNorm.get(norm);
  if (!list) ctx.byNorm.set(norm, (list = []));
  list.push({ id: a.id, plays });
}

const clean = (s) => String(s).replace(/"/g, '');

// True for creators that only have podcast episodes or audiobook chapters (`a` is the artists row).
const NON_MUSIC = `(EXISTS (SELECT 1 FROM tracks t WHERE t.artist_id = a.id AND t.kind <> 0)
  AND NOT EXISTS (SELECT 1 FROM tracks t WHERE t.artist_id = a.id AND t.kind = 0))`;

/**
 * Look a track up on Deezer and save the answer.
 * Returns 'matched' or 'not_found'. Throws TransientError (saving nothing) when Deezer can't answer.
 */
export async function checkTrack(db, deezer, track) {
  let candidates = pickTrackCandidates(await deezer.searchTracks(`${track.artistName} ${track.name}`), track.artistName, track.name);
  if (!candidates.length) {
    const strict = await deezer.searchTracks(`artist:"${clean(track.artistName)}" track:"${clean(track.name)}"`);
    candidates = pickTrackCandidates(strict, track.artistName, track.name);
  }
  let found = null;
  for (const c of candidates) {
    const full = await deezer.track(c.id);
    if (contributorsInclude(full?.contributors, track.artistName)) { found = full; break; }
  }
  if (!found) {
    db.prepare("UPDATE tracks SET deezer_status = 'not_found', deezer_checked_at = ? WHERE id = ?").run(Date.now(), track.id);
    return 'not_found';
  }
  transaction(db, () => saveMatch(db, track, found));
  return 'matched';
}

/**
 * Credit each contributor ({name, role, id?, altName?}) on the track, matching them to local
 * artists (by name, then by altName) or creating new ones under `name`.
 * onArtist(contributor, artistId) runs for every matched contributor.
 * Returns how many artists were added besides Spotify's own.
 */
function addCredits(db, track, contributors, source, onArtist = () => {}) {
  const ctx = contextFor(db);
  const q = {
    addArtist: db.prepare('INSERT OR IGNORE INTO artists (name) VALUES (?)'),
    byName: db.prepare(`SELECT a.id, a.deezer_id, ${NON_MUSIC} AS nonMusic FROM artists a WHERE a.name = ?`),
    credit: db.prepare('INSERT OR IGNORE INTO credits (track_id, artist_id, position, role, source) VALUES (?, ?, ?, ?, ?)'),
  };
  let position = db.prepare('SELECT coalesce(max(position), 0) + 1 AS p FROM credits WHERE track_id = ?').get(track.id).p;
  let added = 0;
  for (const c of contributors) {
    const resolveCtx = { ...ctx, trackArtist: { id: track.artistId, name: track.artistName } };
    let id = resolveContributor(c, resolveCtx);
    if (id === null && c.altName && c.altName !== c.name) id = resolveContributor({ ...c, name: c.altName }, resolveCtx);
    if (id === null) {
      // New to this run. The name may still exist: a show, or an artist added by another process.
      q.addArtist.run(c.name);
      const row = q.byName.get(c.name);
      if (row.nonMusic) continue;
      id = row.id;
      remember(ctx, { id, name: c.name, deezer_id: row.deezer_id });
    }
    onArtist(c, id, ctx);
    if (id !== track.artistId && Number(q.credit.run(track.id, id, position, c.role ?? null, source).changes)) {
      position++;
      added++;
    }
  }
  return added;
}

function saveMatch(db, track, full) {
  const now = Date.now();
  const q = {
    link: db.prepare('UPDATE artists SET deezer_id = ? WHERE id = ? AND deezer_id IS NULL'),
    linkedTo: db.prepare('SELECT deezer_id FROM artists WHERE id = ?'),
    picture: db.prepare(`UPDATE artists SET image_status = 'found', image_thumb = ?, image_full = ?, image_source = 'Deezer',
      image_link = ?, image_checked_at = ? WHERE id = ?`),
  };
  addCredits(db, track, full.contributors ?? [], 'deezer', (c, id, ctx) => {
    if (!ctx.byDeezerId.has(c.id) && Number(q.link.run(c.id, id).changes)) ctx.byDeezerId.set(c.id, id);
    // A picture from the artist's own Deezer id is better than one found by name search.
    const picture = c.picture_xl ?? c.picture_big;
    if (q.linkedTo.get(id)?.deezer_id === c.id && hasDeezerImage(picture)) {
      q.picture.run(c.picture_medium ?? picture, picture, c.link ?? null, now, id);
    }
  });

  const album = full.album;
  if (album && hasDeezerImage(album.cover_big) && pickAlbum([album], track.artistName, track.albumName, { artistOf: () => track.artistName, titleOf: (r) => r.title })) {
    db.prepare(`UPDATE albums SET image_status = 'found', image_thumb = ?, image_full = ?, image_source = 'Deezer', image_link = ?,
      image_checked_at = ? WHERE id = ? AND (image_status IS NULL OR image_status <> 'found')`)
      .run(album.cover_medium ?? album.cover_big, album.cover_xl ?? album.cover_big, album.link ?? null, now, track.albumId);
  }
  db.prepare("UPDATE tracks SET deezer_status = 'matched', deezer_id = ?, deezer_checked_at = ? WHERE id = ?").run(full.id, now, track.id);
}

// ---- MusicBrainz fallback ----

const FEATURING = /\b(feat|ft|featuring)\b\.?/i;

/**
 * Look a track Deezer missed up on MusicBrainz and save the answer.
 * Returns 'matched' (artists added), 'solo' (MusicBrainz lists only Spotify's artist) or 'not_found'.
 * Throws TransientError (saving nothing) when MusicBrainz can't answer.
 */
export async function checkTrackMusicBrainz(db, mb, track) {
  const recordings = await mb.searchRecordings(track.artistName, queryTitle(track.name));
  // Shape recordings like Deezer results so the same strict matching applies. The lead artist is
  // compared by both the credited and the canonical name.
  const shaped = recordings.flatMap((r) => {
    const credit = r['artist-credit'] ?? [];
    if (!credit.length) return [];
    const names = [...new Set([credit[0].name, credit[0].artist?.name].filter(Boolean))];
    return names.map((name) => ({ id: r.id, title: r.title, artist: { name }, credit }));
  });
  const [best] = pickTrackCandidates(shaped, track.artistName, track.name);
  const now = Date.now();
  if (!best) {
    db.prepare("UPDATE tracks SET mb_status = 'not_found', mb_checked_at = ? WHERE id = ?").run(now, track.id);
    return 'not_found';
  }
  // Everyone after a "feat." join phrase is a featured artist.
  let featured = false;
  const contributors = best.credit.map((c, i) => {
    if (i > 0 && FEATURING.test(best.credit[i - 1].joinphrase ?? '')) featured = true;
    // The name printed on the release ("Tomo Hirata") reads like Spotify's; MusicBrainz's main
    // name for the artist ("平田知昌") is kept as a backup for matching.
    return { name: c.name ?? c.artist?.name, altName: c.artist?.name, role: featured ? 'Featured' : 'Main' };
  });
  return transaction(db, () => {
    const added = addCredits(db, track, contributors, 'musicbrainz');
    const result = added ? 'matched' : 'solo';
    db.prepare('UPDATE tracks SET mb_status = ?, mb_id = ?, mb_checked_at = ? WHERE id = ?').run(result, best.id, now, track.id);
    return result;
  });
}

/**
 * Check a track wherever it still needs an answer: Deezer first, then MusicBrainz if Deezer has
 * nothing and the track was played for 30 seconds or more.
 */
export async function checkTrackAllSources(db, { deezer, mb }, track, { retryMissing = false } = {}) {
  let result = track.deezerStatus ?? null;
  if (result === null || (retryMissing && result === 'not_found')) result = await checkTrack(db, deezer, track);
  if (result !== 'not_found') return result;
  const mbWanted = track.mbStatus == null || (retryMissing && track.mbStatus === 'not_found');
  if (mb && track.plays > 0 && mbWanted) return checkTrackMusicBrainz(db, mb, track);
  return 'not_found';
}
