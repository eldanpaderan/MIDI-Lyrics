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
 *   library/songs/{songId}        -> {
 *                                       name, text,              // canonical fields (read everywhere in the app)
 *                                       title, lyrics, pages,    // Song Database schema aliases (title=name, lyrics=text, pages=computed)
 *                                       artist, category,
 *                                       addedBy, createdAt, updatedAt
 *                                     }
 *   library/collections/{id}      -> { name, songIds: { [songId]: true }, createdAt, updatedAt }
 *   library/setlists/{id}         -> { name, songIds: [ ...ordered... ], createdAt, updatedAt }
 *
 * Do NOT use Firebase Storage: only text (never files) is ever written here.
 */
import { getFirebaseApp, serverTimestamp } from '../firebase/firebase.js';
import { getCurrentUser } from '../firebase/auth.js';
import { parseLyricsIntoPages } from './parser.js';

function db() {
  return getFirebaseApp().database();
}

/* ================================================================
   OFFLINE CACHE (localStorage)
   ================================================================
   The Firebase Realtime Database JS SDK does not persist data to disk
   across page reloads on its own (that's a Firestore-only feature) — it
   only keeps synced data in memory for as long as the page/tab stays
   open. To satisfy "cache songs locally / keep working offline / sync
   automatically when the connection returns", every snapshot received
   from watchLibrary() below is also mirrored into localStorage. On the
   next page load — even fully offline — the Library starts from that
   cached snapshot instead of an empty list, and transparently upgrades
   to live data the moment watchLibrary()'s 'value' listener fires again
   (Firebase's own SDK already auto-reconnects and re-fires listeners
   when connectivity returns — no extra reconnect logic needed here). */
const LIBRARY_CACHE_KEY      = 'mlr_library_cache';
const LIBRARY_CACHE_META_KEY = 'mlr_library_cache_meta';

function persistLibraryCache(songs) {
  try {
    localStorage.setItem(LIBRARY_CACHE_KEY, JSON.stringify(songs));
    localStorage.setItem(LIBRARY_CACHE_META_KEY, JSON.stringify({ cachedAt: Date.now() }));
  } catch {
    // localStorage full/unavailable (private browsing, quota, etc.) —
    // not fatal, offline cache just won't survive a reload this time.
  }
}

/** @returns {Record<string, object>} the last snapshot saved to disk, or {} if none. */
export function loadLibraryCacheFromDisk() {
  try {
    const raw = localStorage.getItem(LIBRARY_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch {
    return {};
  }
}

/** @returns {{cachedAt: number} | null} when the on-disk cache was last written. */
export function getLibraryCacheMeta() {
  try {
    const raw = localStorage.getItem(LIBRARY_CACHE_META_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Local cache kept fresh by watchLibrary(); used for instant client-side
 * search. Seeded synchronously from the on-disk cache at module load —
 * so getCachedLibrary()/searchLibrary() return the last-known song list
 * immediately, even before Firebase's first 'value' event arrives (e.g.
 * app opened while offline).
 */
let librarySnapshot = loadLibraryCacheFromDisk();

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
 *
 * Stores the full Song Database schema:
 *   id (the ref key), title, artist, category, lyrics, pages,
 *   createdAt, updatedAt
 * `name`/`text` are kept as well (aliases of title/lyrics) — every
 * existing call site across the app (ui/dialogs.js, ui/settings.js,
 * ui/sidebar.js's song-nav) reads song.name/song.text, so those fields
 * must keep working unchanged; title/lyrics are additive, not a
 * replacement.
 *
 * @param {string} songId
 * @param {string} name          - song title
 * @param {string} text          - full lyrics text
 * @param {{artist?: string, category?: string}} [meta]
 */
export async function addOrUpdateSong(songId, name, text, meta = {}) {
  const ref = db().ref(`library/songs/${songId}`);
  const user = getCurrentUser();
  const pages = parseLyricsIntoPages(text);
  const artist   = (meta.artist   || '').trim();
  const category = (meta.category || '').trim();

  // Atomic transaction (not a read-then-set) so two devices importing or
  // editing the same songId concurrently can't clobber each other's write —
  // the transaction function may be re-run by the SDK if the server value
  // changed between read and write, using the freshest `existing` each time.
  const result = await ref.transaction((existing) => {
    return {
      // Canonical fields used throughout the app:
      name,
      text,
      // Song Database schema fields (id is the Firebase ref key itself):
      title:    name,
      lyrics:   text,
      pages,
      artist:   artist   || (existing && existing.artist)   || '',
      category: category || (existing && existing.category) || '',
      addedBy:   (existing && existing.addedBy)   || (user && user.uid) || null,
      createdAt: (existing && existing.createdAt) || serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
  });

  if (!result.committed) {
    throw new Error(`Failed to save song "${songId}" — the write was not committed.`);
  }
  return songId;
}

/** Update only the lyrics text of an existing song (editing flow). Keeps text/lyrics and the derived pages array in sync. */
export function updateLyricsText(songId, newText) {
  return db().ref(`library/songs/${songId}`).update({
    text: newText,
    lyrics: newText,
    pages: parseLyricsIntoPages(newText),
    updatedAt: serverTimestamp(),
  });
}

/** Update a song's artist/category metadata without touching its lyrics. */
export function updateSongMeta(songId, { artist, category } = {}) {
  const updates = { updatedAt: serverTimestamp() };
  if (artist   !== undefined) updates.artist   = (artist   || '').trim();
  if (category !== undefined) updates.category = (category || '').trim();
  return db().ref(`library/songs/${songId}`).update(updates);
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
    persistLibraryCache(librarySnapshot); // mirror every fresh snapshot to disk for offline use
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
      (song.text || '').toLowerCase().includes(q) ||
      (song.artist || '').toLowerCase().includes(q) ||
      (song.category || '').toLowerCase().includes(q)
    )
    .map(toResult);
}

/**
 * Import workflow: user selects a .txt file -> read locally -> parse name
 * -> save as TEXT into the library. The File/Blob itself is discarded
 * after reading; only the resulting string is ever written to the
 * database (no Firebase Storage is used anywhere in this project) — no
 * GitHub commit or repository update is involved or required.
 * @param {File} file
 * @param {string} [existingSongId] - pass to overwrite an existing library song instead of creating a new one
 * @param {{artist?: string, category?: string}} [meta]
 * @returns {Promise<{songId: string, songName: string, text: string}>}
 */
export function importLyricsFile(file, existingSongId, meta = {}) {
  if (!file || !file.name.toLowerCase().endsWith('.txt')) {
    return Promise.reject(new Error('Only .txt files are supported.'));
  }
  const songName = file.name.replace(/\.txt$/i, '');
  const songId = existingSongId || uniqueId(slugify(songName));

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '');
      addOrUpdateSong(songId, songName, text, meta)
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
