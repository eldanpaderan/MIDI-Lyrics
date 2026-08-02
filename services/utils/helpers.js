/**
 * services/utils/helpers.js
 *
 * Small, generic helper functions used across multiple modules —
 * extracted from app.js during the repository restructuring, logic
 * unchanged from the original.
 */

/** Toast notification — generic UI feedback used by every module. */
export function showToast(msg, type = 'info', duration = 2800) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('out');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

/**
 * Escapes a string for safe interpolation into innerHTML. Song/
 * collection/playlist names are user-controlled (typed by any
 * signed-in device, or derived from an imported .txt filename) — see
 * the stored-XSS fix in an earlier QA pass for why this exists.
 */
export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str == null ? '' : str);
  return div.innerHTML;
}

/** Coarse platform label used for session device presence (Host/Follower device list). */
export function detectPlatform() {
  const ua = navigator.userAgent || '';
  if (/android/i.test(ua)) return 'Android';
  if (/ipad|iphone|ipod/i.test(ua)) return 'iOS';
  if (/mobile/i.test(ua)) return 'Mobile';
  return 'Desktop';
}
