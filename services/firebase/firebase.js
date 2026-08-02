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

  // QA fix (production readiness review): window.firebase.app() fetches
  // specifically the DEFAULT (unnamed) app. The old check here
  // (`window.firebase.apps.length ? window.firebase.app() : ...`) assumed
  // ANY existing app meant the default one existed — but app.js's legacy
  // Firebase system (connectFirebase()) initializes a NAMED app
  // ('mlr-' + timestamp), not the default one. If that legacy system had
  // already connected, this would call window.firebase.app() for a
  // default app that doesn't exist yet, throwing
  // "No Firebase App '[DEFAULT]' has been created". Fixed by explicitly
  // looking for an app named '[DEFAULT]' instead of just checking length.
  const existingDefault = (window.firebase.apps || []).find((a) => a.name === '[DEFAULT]');
  app = existingDefault || window.firebase.initializeApp(config);

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
