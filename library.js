/**
 * services/firebase/library.js
 *
 * Song Library — a persistent, shared collection of Song Metadata + Lyrics
 * text, independent of any single sync Session (see session.js/realtime.js).
 * Sessions reference songs from this library by ID (`currentSongId`); they
 * no longer store their own copy of lyrics text, so a song survives after
 * the session that was playing it ends.
 *
 * Also covers:
 *  - Search        — simple client-side filter over a locally cached snapshot
 *  - Collections   — unordered named groups of songs (e.g. "Christmas Songs")
 *  - Setlists      — ordered song sequences for a specific service/event
 *
 * Realtime Database shape:
 *   library/songs/{songId}        -> { name, text, addedBy, createdAt, updatedAt }
 *   library/collections/{id}      -> { name, songIds: { [songId]: true }, createdAt, updatedAt }
 *   library/setlists/{id}         -> { name, songIds: [ ...ordered... ], createdAt, updatedAt }
 *
 * Do NOT use Firebase Storage: only text (never files) is ever written here.
 */
import { getFirebaseApp, serverTimestamp } from './firebase.js';
import { getCurrentUser } from './auth.js';

function db() {
  return getFirebaseApp().database();
}

/** Local cache kept fresh by watchLibrary(); used for instant client-side search. */
let librarySnapshot = {};

function slugify(name) {
  return (name || 'song')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'song';
}

function uniqueId(base) {
  return `${base}-${Date.now().toString(36)}`;
}

/* ================================================================
   SONGS
   ================================================================ */

/**
 * Create or update a song's metadata + text. Preserves the original
 * `createdAt`/`addedBy` on updates.
 * @param {string} songId
 * @param {string} name
 * @param {string} text
 */
export async function addOrUpdateSong(songId, name, text) {
  const ref = db().ref(`library/songs/${songId}`);
  const snap = await ref.get();
  const existing = snap.exists() ? snap.val() : null;
  const user = getCurrentUser();

  await ref.set({
    name,
    text,
    addedBy: (existing && existing.addedBy) || (user && user.uid) || null,
    createdAt: (existing && existing.createdAt) || serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return songId;
}

/** Update only the lyrics text of an existing song (editing flow). */
export function updateLyricsText(songId, newText) {
  return db().ref(`library/songs/${songId}`).update({
    text: newText,
    updatedAt: serverTimestamp(),
  });
}

export function deleteSong(songId) {
  return db().ref(`library/songs/${songId}`).remove();
}

export async function getSong(songId) {
  const snap = await db().ref(`library/songs/${songId}`).get();
  return snap.exists() ? { id: songId, ...snap.val() } : null;
}

/**
 * Watch the entire library (keeps the local search cache warm).
 * @param {(songs: Record<string, object>) => void} callback
 * @returns {() => void} unsubscribe function
 */
export function watchLibrary(callback) {
  const ref = db().ref('library/songs');
  const handler = (snap) => {
    librarySnapshot = snap.val() || {};
    callback(librarySnapshot);
  };
  ref.on('value', handler);
  return () => ref.off('value', handler);
}

export function getCachedLibrary() {
  return librarySnapshot;
}

/**
 * Client-side search over the cached library snapshot — matches song name
 * or lyrics text, case-insensitive substring match.
 * @param {string} query
 * @returns {Array<{id: string, name: string, text: string}>}
 */
export function searchLibrary(query) {
  const q = (query || '').trim().toLowerCase();
  const entries = Object.entries(librarySnapshot);
  const toResult = ([id, song]) => ({ id, ...song });
  if (!q) return entries.map(toResult);
  return entries
    .filter(([, song]) =>
      (song.name || '').toLowerCase().includes(q) ||
      (song.text || '').toLowerCase().includes(q)
    )
    .map(toResult);
}

/**
 * Import workflow: user selects a .txt file -> read locally -> parse name
 * -> save as TEXT into the library. The File/Blob itself is discarded
 * after reading; only the resulting string is ever written to the
 * database (no Firebase Storage is used anywhere in this project).
 * @param {File} file
 * @param {string} [existingSongId] - pass to overwrite an existing library song instead of creating a new one
 * @returns {Promise<{songId: string, songName: string, text: string}>}
 */
export function importLyricsFile(file, existingSongId) {
  if (!file || !file.name.toLowerCase().endsWith('.txt')) {
    return Promise.reject(new Error('Only .txt files are supported.'));
  }
  const songName = file.name.replace(/\.txt$/i, '');
  const songId = existingSongId || uniqueId(slugify(songName));

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '');
      addOrUpdateSong(songId, songName, text)
        .then(() => resolve({ songId, songName, text }))
        .catch(reject);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/* ================================================================
   COLLECTIONS (unordered groups, e.g. "Christmas Songs")
   ================================================================ */

export async function createCollection(name) {
  const id = uniqueId(slugify(name));
  await db().ref(`library/collections/${id}`).set({
    name,
    songIds: {},
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return id;
}

export function addSongToCollection(collectionId, songId) {
  return db().ref(`library/collections/${collectionId}/songIds/${songId}`).set(true)
    .then(() => db().ref(`library/collections/${collectionId}/updatedAt`).set(serverTimestamp()));
}

export function removeSongFromCollection(collectionId, songId) {
  return db().ref(`library/collections/${collectionId}/songIds/${songId}`).remove();
}

export function renameCollection(collectionId, name) {
  return db().ref(`library/collections/${collectionId}`).update({ name, updatedAt: serverTimestamp() });
}

export function deleteCollection(collectionId) {
  return db().ref(`library/collections/${collectionId}`).remove();
}

/** @param {(collections: Record<string, object>) => void} callback */
export function watchCollections(callback) {
  const ref = db().ref('library/collections');
  const handler = (snap) => callback(snap.val() || {});
  ref.on('value', handler);
  return () => ref.off('value', handler);
}

/* ================================================================
   SETLISTS (ordered sequences for a specific service/event)
   ================================================================ */

export async function createSetlist(name, songIds = []) {
  const id = uniqueId(slugify(name));
  await db().ref(`library/setlists/${id}`).set({
    name,
    songIds,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return id;
}

/** Replace a setlist's ordered song list (e.g. after drag-reordering). */
export function setSetlistSongs(setlistId, songIds) {
  return db().ref(`library/setlists/${setlistId}`).update({ songIds, updatedAt: serverTimestamp() });
}

export function renameSetlist(setlistId, name) {
  return db().ref(`library/setlists/${setlistId}`).update({ name, updatedAt: serverTimestamp() });
}

export function deleteSetlist(setlistId) {
  return db().ref(`library/setlists/${setlistId}`).remove();
}

export async function getSetlist(setlistId) {
  const snap = await db().ref(`library/setlists/${setlistId}`).get();
  return snap.exists() ? { id: setlistId, ...snap.val() } : null;
}

/** @param {(setlists: Record<string, object>) => void} callback */
export function watchSetlists(callback) {
  const ref = db().ref('library/setlists');
  const handler = (snap) => callback(snap.val() || {});
  ref.on('value', handler);
  return () => ref.off('value', handler);
}
