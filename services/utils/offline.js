/**
 * services/utils/offline.js
 *
 * Offline Support (Feature 5): a small, self-contained module that
 * watches the browser's online/offline state and:
 *   - reflects it in the #net-pill status pill (same status-pill
 *     component already used for #midi-pill/#fb-pill — see toolbar.js's
 *     setPillState()), so the Leader/Follower always sees at a glance
 *     whether they're on cached data or live.
 *   - shows a toast on each transition.
 *   - restores the last-viewed song from the local cache (see
 *     ui/viewer.js's restoreOfflineSong() / utils/storage.js's
 *     cacheActiveSong()) if the app starts up offline with nothing
 *     loaded yet.
 * It does NOT touch Firebase/session/realtime sync directly — the
 * Firebase Realtime Database SDK already auto-reconnects and re-fires
 * every active .on('value') listener (services/library/library.js's
 * watchLibrary(), services/firebase/realtime.js's watchPlaybackState()/
 * watchDisplayState()) as soon as connectivity returns, so "synchronize
 * automatically when connection returns" already happens on its own;
 * this module only needs to react to the transition for UI feedback and
 * for seeding the offline song cache at startup.
 */
import { setPillState } from '../ui/toolbar.js';
import { showToast } from './helpers.js';
import { restoreOfflineSong } from '../ui/viewer.js';
import { getLibraryCacheMeta } from '../library/library.js';

function updateNetPill() {
  if (navigator.onLine) {
    setPillState('net-pill', 'connected', 'Online');
  } else {
    setPillState('net-pill', 'error', 'Offline');
  }
}

export function initOfflineSupport() {
  updateNetPill();

  // Startup while offline: pull the last song from cache so the person
  // can keep working immediately, without waiting on any network call.
  if (!navigator.onLine) {
    restoreOfflineSong();
    const meta = getLibraryCacheMeta();
    if (meta && meta.cachedAt) {
      const when = new Date(meta.cachedAt).toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' });
      showToast(`Offline — showing cached songs from ${when}`, 'info', 4000);
    } else {
      showToast('You\u2019re offline — connect once to build the offline song cache', 'info', 4000);
    }
  }

  window.addEventListener('online', () => {
    updateNetPill();
    showToast('Back online — syncing…', 'success');
  });

  window.addEventListener('offline', () => {
    updateNetPill();
    showToast('You\u2019re offline — continuing with cached songs', 'info', 4000);
  });
}
