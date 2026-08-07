/**
 * services/library/parser.js
 *
 * Lyric page-parsing — extracted here as part of the repository
 * restructuring so there is exactly ONE implementation of this
 * heuristic, used by every code path that needs to turn raw lyric text
 * into displayable pages (local .txt songs, Cloud Library songs, and
 * Follower devices resolving a Leader-published song).
 *
 * ================================================================
 * BUG FIX (this revision) — repeated [Section] headers
 * ================================================================
 * The previous version split pages purely by counting blank lines
 * (2+ blank lines = new page, falling back to 1+ if that produced
 * fewer than 2 chunks). It never looked at `[Section]` header lines
 * at all.
 *
 * That heuristic breaks the instant a section's *internal* formatting
 * happens to contain a double-blank-line — which is extremely common
 * in real chord/lyric sheets, e.g. a blank-line gap between two
 * repeats of a Chorus, or between a riff cue and the sung line inside
 * a Bridge. The blank-line counter has no idea that content still
 * belongs to the same [Chorus]/[Bridge], so it tears that single
 * section into two pages — one of them a headerless orphan fragment.
 * This is exactly why "Jesus at the Center" and "You Are Good" (and,
 * more subtly, "Worthy") produced extra, broken, headerless pages:
 * NOT because repeated section names were colliding as object keys
 * (pages have always been a plain array here, never keyed by name),
 * but because blank-line counting is the wrong signal to split on in
 * the first place when the file already tells you exactly where each
 * section starts via its own `[Header]` line.
 *
 * THE FIX: when the text contains one or more standalone `[Header]`
 * lines (a line that, once trimmed, is nothing but "[Label]" — e.g.
 * [Intro], [Verse], [Verse 1], [Pre-Chorus], [Chorus], [Bridge],
 * [Instrumental], [Outro], [Ending], anything), those header lines
 * become the ONLY page boundaries. Each page runs from one header
 * line up to (but not including) the next header line, or end of
 * file. Every occurrence — including exact repeats like a second or
 * third [Bridge] — becomes its own page, in original document order,
 * with nothing merged, skipped, or overwritten. Pages are built into
 * a plain array (push, not `pages[sectionName] = ...`), so repeated
 * section names can never collide or overwrite each other by design.
 *
 * Songs with NO section headers at all (e.g. a plain lyric sheet using
 * manual [PAGE] markers, or just blank-line-separated verses) keep
 * working exactly as before — the header-based rule only activates
 * when at least one real header line is present; everything else
 * falls through to the original [PAGE] / blank-line logic unchanged.
 */

/** A line that, once trimmed, is ENTIRELY "[Label]" — a standalone section header, not an inline chord annotation embedded in a lyric line (those never occupy a whole line by themselves). */
const SECTION_HEADER_LINE_RE = /^\[([^[\]\r\n]{1,60})\]$/;

/**
 * @param {string} text - raw lyric text
 * @returns {string[]} an array of trimmed, non-empty page strings (always at least one element)
 */
export function parseLyricsIntoPages(text) {
  const headerPages = splitBySectionHeaders(text);
  if (headerPages) return headerPages;

  // No [Section] header lines found — fall back to the original heuristic.
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

/**
 * Splits `text` into one page per `[Section]` header line, preserving
 * document order and every repeated occurrence as its own separate
 * page. Returns `null` (not an array) when the text contains no such
 * header line at all, so the caller knows to fall back to the legacy
 * blank-line/[PAGE] heuristic instead.
 *
 * @param {string} text
 * @returns {string[] | null}
 */
function splitBySectionHeaders(text) {
  const lines = text.split(/\r\n|\r|\n/);

  const headerLineIndexes = [];
  for (let i = 0; i < lines.length; i++) {
    if (SECTION_HEADER_LINE_RE.test(lines[i].trim())) {
      headerLineIndexes.push(i);
    }
  }
  if (headerLineIndexes.length === 0) return null;

  const pages = [];

  // Preserve any content that appears before the very first header line
  // (uncommon, but nothing should be silently discarded).
  const leading = lines.slice(0, headerLineIndexes[0]).join('\n').trim();
  if (leading) pages.push(leading);

  for (let h = 0; h < headerLineIndexes.length; h++) {
    const start = headerLineIndexes[h];
    const end = h + 1 < headerLineIndexes.length ? headerLineIndexes[h + 1] : lines.length;
    const pageText = lines.slice(start, end).join('\n').trim();
    // A header with genuinely no body (rare) still becomes its own page —
    // it's still a real, distinct point in the song to navigate to.
    pages.push(pageText || lines[start].trim());
  }

  return pages;
}
