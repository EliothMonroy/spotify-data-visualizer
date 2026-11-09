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

/**
 * Deezer search results that could be the wanted track: exact title first, then the same title
 * without version suffixes; within each, results whose lead artist matches come first. At most two.
 */
export function pickTrackCandidates(results, artist, title) {
  const wantTitle = normalize(title);
  const wantBase = baseTitle(title);
  const wantArtist = normalize(artist);
  if (!wantTitle) return [];
  const scored = [];
  for (const r of results ?? []) {
    const tier = normalize(r.title) === wantTitle ? 0 : wantBase && baseTitle(r.title) === wantBase ? 1 : -1;
    if (tier < 0) continue;
    const lead = wantArtist && normalize(r.artist?.name) === wantArtist ? 0 : 1;
    scored.push({ r, rank: tier * 2 + lead });
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
