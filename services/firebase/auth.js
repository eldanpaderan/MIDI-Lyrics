/**
 * services/firebase/auth.js
 *
 * Firebase Authentication only (no Firestore/Storage/Functions).
 * Uses anonymous sign-in to give each device/browser a stable UID —
 * this is what Session/Preference services key data off of. If you later
 * want real user accounts (email/password, Google, etc.), extend
 * signIn... functions here; the rest of the app only depends on
 * getCurrentUser()/onAuthChange(), not on *how* the user signed in.
 */
import { getFirebaseApp } from './firebase.js';
import { syncAuditPass, syncAuditFail } from './sync-audit-log.js';

let currentUser = null;
const listeners = new Set();
let authStarted = false;

function auth() {
  return getFirebaseApp().auth();
}

/** Start listening to auth state. Call once during app bootstrap. */
export function initAuth() {
  if (authStarted) return;
  authStarted = true;
  auth().onAuthStateChanged((user) => {
    currentUser = user;
    listeners.forEach((cb) => cb(user));
  });
}

/** Anonymous sign-in — gives this device/browser a stable Firebase uid. */
export function signInAnonymously() {
  const result = auth().signInAnonymously();
  // Diagnostics only — side-effect `.then()`, does not replace/reassign
  // `result`, so callers still get the exact original Promise/value.
  // This is the single real implementation both `MLFirebase.signInAnonymously()`
  // (the bare namespace reference used internally by browser-bridge.js's
  // bootstrap) and `window.MLFirebase.signInAnonymously()` resolve to —
  // instrumenting here (rather than on the window.MLFirebase copy) is
  // what actually guarantees this fires for every real call path.
  result.then(
    (credential) => {
      const user = credential && credential.user;
      console.group('[Firebase Diagnostics] signInAnonymously() succeeded');
      console.log('User UID:', user && user.uid);
      console.log('Authentication status:', user ? `authenticated (anonymous: ${user.isAnonymous})` : 'unknown');
      console.groupEnd();
      syncAuditPass(2, { uid: user && user.uid });
    },
    (error) => {
      syncAuditFail(2, {
        fn: 'signInAnonymously() [services/firebase/auth.js]',
        path: '(n/a — Authentication, not Realtime Database)',
        error,
        reason:
          error && error.code === 'auth/operation-not-allowed'
            ? 'Anonymous sign-in is not enabled for this Firebase project. Enable it in Firebase Console → Authentication → Sign-in method → Anonymous. Every downstream step (session/presence/listeners) requires a signed-in user and cannot proceed without this.'
            : 'signInAnonymously() rejected. Every downstream step (session created, presence written, listeners attached) requires getCurrentUser() to be non-null and will silently wait forever (or throw "Must be signed in") without it.'
      });
      // Deliberately re-thrown as a rejection (not swallowed here) so
      // existing callers' own .catch() handlers still run exactly as
      // before — this diagnostic branch only observes.
    }
  );
  return result;
}

export function signOutUser() {
  return auth().signOut();
}

/** @returns {import('firebase').User|null} */
export function getCurrentUser() {
  return currentUser;
}

/**
 * Subscribe to auth state changes.
 * @param {(user: import('firebase').User|null) => void} callback
 * @returns {() => void} unsubscribe function
 */
export function onAuthChange(callback) {
  listeners.add(callback);
  if (authStarted) callback(currentUser);
  return () => listeners.delete(callback);
}
