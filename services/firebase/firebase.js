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

import { syncAuditPass, syncAuditFail } from './sync-audit-log.js';

let app = null;
let initialized = false;

/* ------------------------------------------------------------------
   DIAGNOSTICS (added — no behavioral/architecture change)
   --------------------------------------------------------------------
   1. Wraps window.firebase.initializeApp itself (not just this module's
      own `initialized` guard) so a call count is tracked at the actual
      SDK boundary — this verifies "initializeApp() is called exactly
      once" for real, rather than only trusting our own singleton flag.
   2. Immediately after the app is created, prints App Name / Project ID
      / Database URL / Auth Domain to the console.
   3. Patches Reference.prototype's write methods (set/update/remove/
      push/transaction) once, so every database write anywhere in the
      app — realtime.js, session.js, preference.js, library.js — logs
      its path + JSON payload right before the call, and success/failure
      (with Firebase error code/message on failure) right after.
   ------------------------------------------------------------------ */
let initializeAppCallCount = 0;
let initializeAppWrapped = false;

function installInitializeAppCallCounter() {
  if (initializeAppWrapped || !window.firebase || typeof window.firebase.initializeApp !== 'function') return;
  initializeAppWrapped = true;
  const originalInitializeApp = window.firebase.initializeApp.bind(window.firebase);
  window.firebase.initializeApp = function (...args) {
    initializeAppCallCount++;
    if (initializeAppCallCount > 1) {
      console.error(
        `[Firebase Diagnostics] initializeApp() was called ${initializeAppCallCount} times — ` +
        `expected exactly once. This can create duplicate app instances / connections.`
      );
    }
    return originalInitializeApp(...args);
  };
}

function logAppDiagnostics(firebaseApp) {
  console.group('[Firebase Diagnostics] initializeApp() completed');
  console.log('App Name:', firebaseApp.name);
  console.log('Project ID:', firebaseApp.options && firebaseApp.options.projectId);
  console.log('Database URL:', firebaseApp.options && firebaseApp.options.databaseURL);
  console.log('Auth Domain:', firebaseApp.options && firebaseApp.options.authDomain);
  console.groupEnd();
}

const DB_CONNECTION_TIMEOUT_MS = 10000;
let dbConnectionWatchStarted = false;

/**
 * Step 3 (Database connection established) — Realtime Database's
 * special `.info/connected` path reports this client's actual websocket
 * connection state, independent of any application data. This is the
 * only reliable way to distinguish "initializeApp() succeeded" (a
 * config object was accepted locally) from "we actually have a live
 * connection to the database" (a real websocket handshake completed) —
 * they are NOT the same thing, which is exactly the gap this audit is
 * about.
 */
function watchDatabaseConnectionDiagnostic(firebaseApp) {
  if (dbConnectionWatchStarted) return;
  dbConnectionWatchStarted = true;

  let reported = false;
  const ref = firebaseApp.database().ref('.info/connected');

  const timeoutId = setTimeout(() => {
    if (reported) return;
    reported = true;
    syncAuditFail(3, {
      fn: 'watchDatabaseConnectionDiagnostic() [services/firebase/firebase.js] watching .info/connected',
      path: '.info/connected',
      error: null,
      reason:
        `No connection to the Realtime Database within ${DB_CONNECTION_TIMEOUT_MS / 1000}s of initializeApp() ` +
        'succeeding. initializeApp() only validates the config shape locally — it does NOT verify the ' +
        'databaseURL actually points at a real, reachable database. Most likely cause: the saved ' +
        'databaseURL does not match this project\'s real Realtime Database instance (wrong region suffix, ' +
        'e.g. "...firebaseio.com" vs the newer "...<region>.firebasedatabase.app" form, or a typo\'d project ' +
        'ID), or the request is blocked by the network/firewall.'
    });
  }, DB_CONNECTION_TIMEOUT_MS);

  ref.on('value', (snap) => {
    const connected = snap.val() === true;
    if (connected && !reported) {
      reported = true;
      clearTimeout(timeoutId);
      syncAuditPass(3, { databaseURL: firebaseApp.options && firebaseApp.options.databaseURL });
    }
  }, (error) => {
    if (reported) return;
    reported = true;
    clearTimeout(timeoutId);
    syncAuditFail(3, {
      fn: 'watchDatabaseConnectionDiagnostic() [services/firebase/firebase.js] watching .info/connected',
      path: '.info/connected',
      error,
      reason: 'The .info/connected listener itself was rejected — check Realtime Database rules allow reading ".info/connected" (this path is normally exempt from rules, so this usually means the databaseURL is malformed/unreachable rather than a rules issue).'
    });
  });
}

function pathFromRef(ref) {
  try {
    const full = ref.toString();
    const dbURL = (app && app.options && app.options.databaseURL) || '';
    if (dbURL && full.startsWith(dbURL)) {
      const rest = full.slice(dbURL.length);
      return rest === '' ? '/' : rest;
    }
    return full;
  } catch {
    return '(unknown path)';
  }
}

let writeDiagnosticsInstalled = false;

function installWriteDiagnostics() {
  if (writeDiagnosticsInstalled) return;
  if (!window.firebase || !window.firebase.database || !window.firebase.database.Reference) return;
  writeDiagnosticsInstalled = true;

  const RefProto = window.firebase.database.Reference.prototype;

  ['set', 'update', 'remove', 'push', 'transaction'].forEach((methodName) => {
    const original = RefProto[methodName];
    if (typeof original !== 'function') return;

    RefProto[methodName] = function (...args) {
      const path = pathFromRef(this);
      const payload =
        methodName === 'remove' ? null :
        methodName === 'transaction' ? '[transaction updateFunction — resulting value logged on success]' :
        args.length ? args[0] : undefined;

      console.group(`[Firebase Write] → ${methodName.toUpperCase()} ${path}`);
      console.log('Database path:', path);
      console.log('JSON payload:', payload);
      console.groupEnd();

      const result = original.apply(this, args);

      if (result && typeof result.then === 'function') {
        // Side-effect only — does NOT replace/reassign `result`, so the
        // original Promise identity/timing returned to the caller is
        // completely unchanged.
        result.then(
          (res) => {
            console.log(`[Firebase Write] ✓ SUCCESS ${methodName.toUpperCase()} ${path}`);
            return res;
          },
          (err) => {
            console.error(
              `[Firebase Write] ✗ FAILED ${methodName.toUpperCase()} ${path}`,
              'code:', err && err.code,
              'message:', err && err.message
            );
          }
        );
      }

      return result;
    };
  });
}

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

  installInitializeAppCallCounter();

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
  const wasAlreadyPresent = !!existingDefault;

  if (wasAlreadyPresent) {
    app = existingDefault;
    console.log('[Firebase Diagnostics] Reused existing [DEFAULT] app — initializeApp() not called again.');
    syncAuditPass(1, { note: 'reused existing [DEFAULT] app', appName: app.name });
  } else {
    try {
      app = window.firebase.initializeApp(config);
    } catch (error) {
      syncAuditFail(1, {
        fn: 'initFirebase() [services/firebase/firebase.js] → window.firebase.initializeApp(config)',
        path: '(n/a — app initialization, not a database path)',
        error,
        reason: 'window.firebase.initializeApp(config) threw synchronously — check that the config object saved by "Configure Firebase" has all required fields (apiKey, authDomain, databaseURL, projectId, appId) and that none are still the placeholder "YOUR_..." values.'
      });
      throw error;
    }
    logAppDiagnostics(app);
    syncAuditPass(1, { appName: app.name, projectId: app.options && app.options.projectId });
  }

  installWriteDiagnostics();
  watchDatabaseConnectionDiagnostic(app);

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
