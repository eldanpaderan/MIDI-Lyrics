/**
 * services/utils/debounce.js
 *
 * Generic debounce utility — extracted and generalized during the
 * repository restructuring from two previously ad-hoc
 * setTimeout/clearTimeout patterns (the Lyrics Editor's auto-save, and
 * the auto-fit resize handler), which now both use this single
 * implementation instead of duplicating the pattern.
 *
 * @param {Function} fn
 * @param {number} waitMs
 * @returns {Function} a debounced wrapper around fn — call it as many
 *   times as you like; fn only actually runs once, waitMs after the
 *   last call.
 */
export function debounce(fn, waitMs) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), waitMs);
  };
}
