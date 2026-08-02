/**
 * services/library/metadata.js
 *
 * Song metadata display helpers — extracted from app.js during the
 * repository restructuring. Pure functions, no DOM/state dependencies.
 */

/** Turns a raw filename (e.g. "amazing-grace.txt" -> "amazing-grace") into a display name: "Amazing Grace". */
export function formatSongName(raw) {
  return raw
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

/** Formats a timestamp (number, ms since epoch) into a short display date, or an em-dash if absent/invalid. */
export function formatTimestamp(ts) {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch { return '—'; }
}
