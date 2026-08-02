/**
 * services/library/parser.js
 *
 * Lyric page-parsing — extracted here as part of the repository
 * restructuring so there is exactly ONE implementation of this
 * heuristic, used by every code path that needs to turn raw lyric text
 * into displayable pages (local .txt songs, Cloud Library songs, and
 * Follower devices resolving a Leader-published song). This consolidates
 * logic that was duplicated across multiple functions since the
 * original architecture — flagged repeatedly in earlier audits.
 *
 * Splitting rule (unchanged from the original behavior):
 *   1. If the text contains an explicit [PAGE] marker, split on that.
 *   2. Otherwise, split on 2+ blank lines.
 *   3. If that produces fewer than 2 chunks, fall back to a single
 *      blank line as the separator.
 *   4. If nothing produced more than one page, treat the whole text as
 *      one page.
 */

/**
 * @param {string} text - raw lyric text
 * @returns {string[]} an array of trimmed, non-empty page strings (always at least one element)
 */
export function parseLyricsIntoPages(text) {
  let chunks;
  if (text.includes('[PAGE]')) {
    chunks = text.split(/\[PAGE\]/i);
  } else {
    chunks = text.split(/\n\s*\n\s*\n/);
    if (chunks.length < 2) chunks = text.split(/\n\n/);
  }

  const pages = chunks.map((c) => c.trim()).filter((c) => c.length > 0);
  return pages.length ? pages : [text.trim()];
}
