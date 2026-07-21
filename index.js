/**
 * services/firebase/index.js
 *
 * Barrel export — import everything from one place:
 *   import * as MLFirebase from './services/firebase/index.js';
 *
 * Covers: singleton init, Authentication, Realtime Database sync
 * (session-based), Song Library (persistent songs/collections/setlists),
 * and PreferenceService. Deliberately excludes Firestore, Storage, and
 * Cloud Functions — this project uses Authentication + Realtime
 * Database only.
 */
export * from './firebase.js';
export * from './auth.js';
export * from './session.js';
export * from './realtime.js';
export * from './library.js';
export * from './preference.js';
