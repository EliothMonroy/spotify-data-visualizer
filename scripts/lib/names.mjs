// Name matching shared by the importer, the Deezer backfill and the artwork server. Pure functions.

/** Lowercase, strip accents, punctuation and filler so "Beyoncé" ≈ "Beyonce", "The Weeknd" ≈ "Weeknd". */
export function normalize(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/^the /, '')
    .trim();
}

/** Album titles vary in suffixes: "Stories (Deluxe)", "Louder - Radio Edit", "X - EP". */
export function normalizeAlbum(s) {
  return normalize(
    String(s ?? '')
      .replace(/\s*[([][^)\]]*(edition|deluxe|remaster|version|expanded|anniversary|bonus|explicit|single|ep)[^)\]]*[)\]]/gi, '')
      .replace(/\s+-\s+(single|ep|radio edit|remastered.*|deluxe.*)$/i, ''),
  );
}

/** Track title without "(feat. X)", "[Remastered]" or a trailing " - Radio Edit". */
export function baseTitle(s) {
  return normalize(
    String(s ?? '')
      .replace(/\s*[([][^)\]]*[)\]]/g, '')
      .replace(/\s+-\s+.*$/, ''),
  );
}

/** Exact (normalized) name match; when several artists share the name, the one with most fans. */
export function pickArtist(results, name, nameOf = (r) => r.name) {
  const want = normalize(name);
  const same = (results ?? []).filter((r) => normalize(nameOf(r)) === want);
  return same.sort((a, b) => (b.nb_fan ?? 0) - (a.nb_fan ?? 0))[0] ?? null;
}

export function pickAlbum(results, artist, album, { artistOf, titleOf }) {
  const wantArtist = normalize(artist);
  const wantAlbum = normalizeAlbum(album);
  const sameArtist = (results ?? []).filter((r) => {
    const a = normalize(artistOf(r));
    return a === wantArtist || a.includes(wantArtist) || wantArtist.includes(a);
  });
  return (
    sameArtist.find((r) => normalizeAlbum(titleOf(r)) === wantAlbum) ??
    sameArtist.find((r) => {
      const t = normalizeAlbum(titleOf(r));
      return t && wantAlbum && (t.startsWith(wantAlbum) || wantAlbum.startsWith(t));
    }) ??
    null
  );
}

// Words that mark a different recording (a remix credits its remixer, a live version its guests).
const VERSION_WORDS = new Set(['remix', 'rework', 'bootleg', 'vip', 'flip', 'mashup', 'edit', 'mix', 'live', 'cover', 'acoustic', 'instrumental', 'remake', 'dub']);
// Version names that are the same recording, so they don't count.
const SAME_RECORDING = /\b(radio edit|radio mix|extended mix|extended version|extended|original mix|club mix|single version|album version|remastered|remaster|mono|stereo|\d{4})\b/g;

/** The version words in a title's brackets or " - ..." suffix, ignoring "feat." parts. */
export function versionWords(title) {
  const raw = String(title ?? '');
  const parts = [...raw.matchAll(/[([]([^)\]]*)[)\]]/g)].map((m) => m[1]);
  const dash = raw.replace(/\s*[([][^)\]]*[)\]]/g, '').match(/\s+-\s+(.*)$/);
  if (dash) parts.push(dash[1]);
  const words = new Set();
  for (const part of parts) {
    const text = normalize(part);
    if (/^(feat|ft|featuring|with)\b/.test(text)) continue;
    for (const w of text.replace(SAME_RECORDING, ' ').split(/\s+/)) if (VERSION_WORDS.has(w)) words.add(w);
  }
  return [...words].sort().join(' ');
}

/**
 * Deezer search results that could be the wanted track. A result must have the same lead artist
 * and the same version words (so a remix never stands in for the original). Exact titles come
 * first, then a plain title for a Spotify title with extras, then other matching versions.
 * At most two.
 */
export function pickTrackCandidates(results, artist, title) {
  const wantTitle = normalize(title);
  const wantBase = baseTitle(title);
  const wantArtist = normalize(artist);
  const wantVersion = versionWords(title);
  if (!wantTitle || !wantArtist) return [];
  const scored = [];
  for (const r of results ?? []) {
    if (normalize(r.artist?.name) !== wantArtist) continue;
    if (versionWords(r.title) !== wantVersion) continue;
    const t = normalize(r.title);
    const rank = t === wantTitle ? 0 : t === wantBase ? 1 : wantBase && baseTitle(r.title) === wantBase ? 2 : -1;
    if (rank >= 0) scored.push({ r, rank });
  }
  return scored.sort((a, b) => a.rank - b.rank).slice(0, 2).map((s) => s.r);
}

/** True when one of a Deezer track's contributors is the given artist. */
export function contributorsInclude(contributors, artist) {
  const want = normalize(artist);
  if (!want) return false;
  return (contributors ?? []).some((c) => normalize(c.name) === want);
}

/**
 * Local artist id for a Deezer contributor, or null when a new artist should be created.
 * ctx: { byDeezerId: Map<deezerId, id>, byExactName: Map<name, id>,
 *        byNorm: Map<normName, {id, plays}[]>, trackArtist: {id, name} }
 */
export function resolveContributor(c, ctx) {
  const linked = ctx.byDeezerId.get(c.id);
  if (linked !== undefined) return linked;
  const exact = ctx.byExactName.get(c.name);
  if (exact !== undefined) return exact;
  const norm = normalize(c.name);
  if (!norm) return null;
  if (ctx.trackArtist && normalize(ctx.trackArtist.name) === norm) return ctx.trackArtist.id;
  const same = ctx.byNorm.get(norm);
  if (!same?.length) return null;
  return same.reduce((best, a) => ((a.plays ?? 0) > (best.plays ?? 0) ? a : best)).id;
}
