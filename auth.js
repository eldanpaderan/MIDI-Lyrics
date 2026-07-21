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
  return auth().signInAnonymously();
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
