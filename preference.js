/**
 * services/firebase/preference.js
 *
 * PreferenceService — stores:
 *   Theme, Font, Sidebar (collapsed state), Window Layout,
 *   Playback Speed, Favorites, Recent Songs.
 *
 * Offline-first: always reads/writes localStorage immediately so the app
 * keeps working with zero network. When a Firebase user is signed in
 * (see auth.js), preferences additionally sync to
 * `users/{uid}/preferences` (and favorites/recentSongs) in Realtime
 * Database, so they follow the person across devices — this is
 * per-user data, not per-session, so it persists after a session ends.
 */
import { getFirebaseApp, serverTimestamp } from './firebase.js';
import { getCurrentUser, onAuthChange } from './auth.js';

const LOCAL_KEY = 'mlr_preferences';

const DEFAULTS = {
  theme: 'dark',
  font: { size: 'M' },
  sidebar: { collapsed: false },
  autoFit: false,
  windowLayout: {},
  playbackSpeed: 1.0,
  favorites: {},
  recentSongs: [],
  lastSongId: null,
  lastSetlistId: null,
};

function db() {
  return getFirebaseApp().database();
}

function readLocal() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

function writeLocal(prefs) {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(prefs)); } catch { /* storage unavailable, ignore */ }
}

let cached = readLocal();
let remoteUnsub = null;

/** @returns {object} the full current preferences object (local cache). */
export function getPreferences() {
  return cached;
}

/**
 * Update a single top-level preference key (theme, font, sidebar,
 * windowLayout, or playbackSpeed). Writes to localStorage immediately,
 * and mirrors to Firebase if a user is signed in.
 */
export function setPreference(key, value) {
  cached = { ...cached, [key]: value };
  writeLocal(cached);
  const user = getCurrentUser();
  if (user) {
    db().ref(`users/${user.uid}/preferences/${key}`).set(value).catch((err) => {
      console.warn('[preference.js] Failed to sync preference to Firebase:', err);
    });
  }
  return cached;
}

/**
 * Start syncing preferences with Firebase for whichever user is
 * currently signed in. Call once during app bootstrap (after initAuth()).
 * On first sign-in with no remote data yet, seeds Firebase with the
 * current local preferences.
 */
export function initPreferenceSync() {
  onAuthChange((user) => {
    if (remoteUnsub) { remoteUnsub(); remoteUnsub = null; }
    if (!user) return;

    const ref = db().ref(`users/${user.uid}/preferences`);
    const handler = (snap) => {
      const remote = snap.val();
      if (remote) {
        cached = { ...DEFAULTS, ...cached, ...remote };
        writeLocal(cached);
      } else {
        ref.set(cached).catch(() => {});
      }
    };
    ref.on('value', handler);
    remoteUnsub = () => ref.off('value', handler);
  });
}

/* ---------------- Favorites ---------------- */

export function isFavorite(songId) {
  return !!(cached.favorites || {})[songId];
}

export function toggleFavorite(songId) {
  const favorites = { ...(cached.favorites || {}) };
  const nowFavorite = !favorites[songId];
  if (nowFavorite) favorites[songId] = true; else delete favorites[songId];

  cached = { ...cached, favorites };
  writeLocal(cached);

  const user = getCurrentUser();
  if (user) {
    db().ref(`users/${user.uid}/favorites/${songId}`).set(nowFavorite || null).catch(() => {});
  }
  return nowFavorite;
}

export function getFavorites() {
  return cached.favorites || {};
}

/* ---------------- Recent songs ---------------- */

/**
 * Record a song as recently opened. Keeps the list deduplicated and
 * capped, most-recent first.
 */
export function addRecentSong(songId, name, maxItems = 20) {
  const withoutDup = (cached.recentSongs || []).filter((s) => s.songId !== songId);
  const recentSongs = [{ songId, name, openedAt: Date.now() }, ...withoutDup].slice(0, maxItems);

  cached = { ...cached, recentSongs };
  writeLocal(cached);

  const user = getCurrentUser();
  if (user) {
    db().ref(`users/${user.uid}/recentSongs`).set(recentSongs).catch(() => {});
  }
  return recentSongs;
}

export function getRecentSongs() {
  return cached.recentSongs || [];
}

/* ---------------- Remember last opened song / setlist ---------------- */

/**
 * Call whenever the person opens a song, so the app can reopen it on
 * next launch. Distinct from addRecentSong() (which builds a history
 * list) — this is just "what should load automatically next time."
 */
export function setLastSong(songId) {
  return setPreference('lastSongId', songId);
}

export function getLastSong() {
  return cached.lastSongId || null;
}

/** Call whenever the person opens/activates a setlist. */
export function setLastSetlist(setlistId) {
  return setPreference('lastSetlistId', setlistId);
}

export function getLastSetlist() {
  return cached.lastSetlistId || null;
}
