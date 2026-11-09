// Artist credits from Deezer: find each track on Deezer, read its full list of contributors and
// credit every one of them, along with their pictures and (when it is the same album) the cover.
import { transaction } from './db.mjs';
import { normalize, pickAlbum, pickTrackCandidates, contributorsInclude, resolveContributor } from './names.mjs';
import { hasDeezerImage } from './deezer.mjs';

const MIN_PLAY_MS = 30000;

/**
 * Music tracks without a Deezer answer yet, most played first.
 * @returns {{id, name, artistId, artistName, albumId, albumName, plays, status}[]}
 */
export function tracksToCheck(db, { top = 0, retryMissing = false } = {}) {
  const status = retryMissing ? "(t.deezer_status IS NULL OR t.deezer_status = 'not_found')" : 't.deezer_status IS NULL';
  return db.prepare(`
    SELECT t.id, t.name, t.artist_id AS artistId, a.name AS artistName, t.album_id AS albumId, al.name AS albumName,
      coalesce(c.n, 0) AS plays, t.deezer_status AS status
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
  for (const a of db.prepare('SELECT id, name, deezer_id FROM artists').all()) remember(ctx, a, plays.get(a.id) ?? 0);
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

function saveMatch(db, track, full) {
  const ctx = contextFor(db);
  const now = Date.now();
  const q = {
    addArtist: db.prepare('INSERT INTO artists (name) VALUES (?)'),
    link: db.prepare('UPDATE artists SET deezer_id = ? WHERE id = ? AND deezer_id IS NULL'),
    linkedTo: db.prepare('SELECT deezer_id FROM artists WHERE id = ?'),
    picture: db.prepare(`UPDATE artists SET image_status = 'found', image_thumb = ?, image_full = ?, image_source = 'Deezer',
      image_link = ?, image_checked_at = ? WHERE id = ?`),
    credit: db.prepare("INSERT OR IGNORE INTO credits (track_id, artist_id, position, role, source) VALUES (?, ?, ?, ?, 'deezer')"),
  };

  let position = 1;
  for (const c of full.contributors ?? []) {
    let id = resolveContributor(c, { ...ctx, trackArtist: { id: track.artistId, name: track.artistName } });
    if (id === null) {
      id = Number(q.addArtist.run(c.name).lastInsertRowid);
      remember(ctx, { id, name: c.name, deezer_id: null });
    }
    if (!ctx.byDeezerId.has(c.id) && Number(q.link.run(c.id, id).changes)) ctx.byDeezerId.set(c.id, id);
    // A picture from the artist's own Deezer id is better than one found by name search.
    const picture = c.picture_xl ?? c.picture_big;
    if (q.linkedTo.get(id)?.deezer_id === c.id && hasDeezerImage(picture)) {
      q.picture.run(c.picture_medium ?? picture, picture, c.link ?? null, now, id);
    }
    if (id !== track.artistId && Number(q.credit.run(track.id, id, position, c.role ?? null).changes)) position++;
  }

  const album = full.album;
  if (album && hasDeezerImage(album.cover_big) && pickAlbum([album], track.artistName, track.albumName, { artistOf: () => track.artistName, titleOf: (r) => r.title })) {
    db.prepare(`UPDATE albums SET image_status = 'found', image_thumb = ?, image_full = ?, image_source = 'Deezer', image_link = ?,
      image_checked_at = ? WHERE id = ? AND (image_status IS NULL OR image_status <> 'found')`)
      .run(album.cover_medium ?? album.cover_big, album.cover_xl ?? album.cover_big, album.link ?? null, now, track.albumId);
  }
  db.prepare("UPDATE tracks SET deezer_status = 'matched', deezer_id = ?, deezer_checked_at = ? WHERE id = ?").run(full.id, now, track.id);
}
