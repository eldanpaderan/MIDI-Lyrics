/**
 * services/utils/storage.js
 *
 * Local persistence — extracted from app.js during the repository
 * restructuring. Two concerns, kept together since they were originally
 * adjacent and closely related:
 *   1. saveLocalPrefs()/loadLocalPrefs() — mode/MIDI-mapping/fbEnabled,
 *      which are session-mode/hardware-mapping/feature-flag state, not
 *      "preferences" in PreferenceService's sense (see note below).
 *   2. getSyncedPref()/setSyncedPref() — thin delegation into
 *      services/firebase/preference.js's PreferenceService (via
 *      window.MLFirebase) for theme/sidebar/font/autofit, which IS
 *      "preferences" in that sense (fixed in an earlier audit, H4).
 *
 * NOTE ON CIRCULAR IMPORT: this file and services/ui/sidebar.js import
 * from each other (saveLocalPrefs()/loadLocalPrefs() call setMode();
 * setMode() calls saveLocalPrefs()). This is safe under ES Module
 * semantics — neither function is invoked at module-evaluation time,
 * only later from user interaction or the init sequence, by which point
 * both modules have fully evaluated and their exports are live bindings.
 */
import { state } from '../ui/viewer.js';
import { setMode } from '../ui/sidebar.js';
import { updateMidiMappingInfo } from '../midi/learn.js';
import { loadFontSizeFromPreferences } from '../ui/viewer.js';

export function saveLocalPrefs() {
  localStorage.setItem('mlr_mode',         state.mode);
  localStorage.setItem('mlr_midiNext',     JSON.stringify(state.midiNextNote));
  localStorage.setItem('mlr_midiPrev',     JSON.stringify(state.midiPrevNote));
  localStorage.setItem('mlr_fbEnabled',    state.fbEnabled);
}

export function loadLocalPrefs() {
  const mode = localStorage.getItem('mlr_mode');
  if (mode) setMode(mode, true);
  const mn = localStorage.getItem('mlr_midiNext');
  if (mn) state.midiNextNote = JSON.parse(mn);
  const mp = localStorage.getItem('mlr_midiPrev');
  if (mp) state.midiPrevNote = JSON.parse(mp);
  const fbe = localStorage.getItem('mlr_fbEnabled');
  if (fbe) state.fbEnabled = fbe === 'true';
  updateMidiMappingInfo();
  loadFontSizeFromPreferences();
}

/**
 * PreferenceService delegation (audit fix H4) — routes reads/writes
 * through the single PreferenceService (services/firebase/preference.js,
 * via window.MLFirebase) instead of a second, disconnected localStorage
 * key, so theme/sidebar/font/autofit settings actually sync across
 * devices. Falls back to safe in-memory defaults (never a second
 * localStorage key) if the services bridge isn't loaded.
 */
/* ----------------------------------------------------------
   OFFLINE SONG CACHE
   Caches the currently displayed song's rendered pages to localStorage
   so that if the device goes offline (or the app is reloaded while
   offline), the last song being worked on is still available instead of
   showing an empty stage. Deliberately separate from the Firebase
   Library's own on-disk cache (services/library/library.js) — this one
   works even for local GitHub-folder songs (which aren't in the Library
   at all) and needs no Firebase involvement whatsoever.
   ---------------------------------------------------------- */
const ACTIVE_SONG_CACHE_KEY = 'mlr_active_song_cache';

/** @param {{id:string,name:string,url?:string}} song  @param {string[]} pages */
export function cacheActiveSong(song, pages) {
  if (!song) return;
  try {
    localStorage.setItem(ACTIVE_SONG_CACHE_KEY, JSON.stringify({ song, pages, cachedAt: Date.now() }));
  } catch {
    // localStorage full/unavailable — not fatal, just no offline restore this session.
  }
}

/** @returns {{song:{id:string,name:string,url?:string}, pages:string[], cachedAt:number} | null} */
export function getCachedActiveSong() {
  try {
    const raw = localStorage.getItem(ACTIVE_SONG_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function getSyncedPref(key, fallback) {
  if (window.MLFirebase && typeof window.MLFirebase.getPreferences === 'function') {
    const prefs = window.MLFirebase.getPreferences();
    return (prefs && prefs[key] !== undefined) ? prefs[key] : fallback;
  }
  return fallback;
}

export function setSyncedPref(key, value) {
  if (window.MLFirebase && typeof window.MLFirebase.setPreference === 'function') {
    window.MLFirebase.setPreference(key, value);
  }
}
