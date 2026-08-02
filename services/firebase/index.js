/**
 * services/firebase/index.js
 *
 * Barrel export — import everything from one place:
 *   import * as MLFirebase from './services/firebase/index.js';
 *
 * Covers: singleton init, Authentication, Realtime Database sync
 * (session-based), and PreferenceService. Song Library (persistent
 * songs/collections/setlists) moved to ../library/library.js during
 * the repository restructuring, but is still re-exported from here so
 * window.MLFirebase continues to expose it exactly as before — nothing
 * that depends on window.MLFirebase.watchLibrary()/searchLibrary()/etc.
 * (services/ui/dialogs.js, services/ui/settings.js) needed to change.
 * Deliberately excludes Firestore, Storage, and Cloud Functions — this
 * project uses Authentication + Realtime Database only.
 */
export * from './firebase.js';
export * from './auth.js';
export * from './session.js';
export * from './realtime.js';
export * from '../library/library.js';
export * from './preference.js';
