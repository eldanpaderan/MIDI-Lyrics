/**
 * services/firebase/firebase.js
 *
 * Singleton Firebase (compat SDK) initializer.
 * Relies on the Firebase compat SDK scripts already loaded via <script> tags
 * in index.html (firebase-app-compat.js, firebase-auth-compat.js,
 * firebase-database-compat.js) — this module does not load the SDK itself,
 * it only wraps window.firebase with a singleton init guard.
 *
 * Plain ES module — no bundler required. Modern browsers (and GitHub Pages
 * static hosting) support <script type="module"> and import/export natively.
 */

let app = null;
let initialized = false;

/**
 * Initialize Firebase exactly once. Safe to call multiple times —
 * subsequent calls return the existing app instance without re-initializing.
 * @param {object} config - Firebase project config (apiKey, authDomain, databaseURL, projectId, appId, ...)
 */
export function initFirebase(config) {
  if (initialized) return app;

  if (!window.firebase) {
    throw new Error(
      'Firebase compat SDK not found on window. Make sure firebase-app-compat.js ' +
      'is loaded via <script> before this module runs.'
    );
  }

  // Guard against duplicate-app errors if something else already initialized it.
  app = window.firebase.apps && window.firebase.apps.length
    ? window.firebase.app()
    : window.firebase.initializeApp(config);

  initialized = true;
  return app;
}

/** @returns {import('firebase').app.App} the initialized Firebase app instance */
export function getFirebaseApp() {
  if (!initialized) {
    throw new Error('Firebase has not been initialized yet. Call initFirebase(config) first.');
  }
  return app;
}

export function isFirebaseInitialized() {
  return initialized;
}

/** Server timestamp helper (Realtime Database). */
export function serverTimestamp() {
  return window.firebase.database.ServerValue.TIMESTAMP;
}
