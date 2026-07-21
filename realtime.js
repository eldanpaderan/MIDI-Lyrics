/**
 * services/firebase/realtime.js
 *
 * Realtime Database synchronization for the active session:
 * Play / Pause / Stop / Next / Previous, current song reference,
 * page/position, and now (Phase 4) Theme / Font Size / Fullscreen as
 * synced "display state" — plus performance and reliability work:
 * diffed writes, loop prevention, and reconnect-aware presence
 * (presence/reconnect itself lives in session.js).
 *
 * Lyrics storage lives in library.js (Phase 3): lyrics are persistent,
 * shared Song Library data, not session-scoped. This file only ever
 * stores a `currentSongId` reference; call library.js's getSong()/
 * watchLibrary() to resolve that ID to its name/text ("Current Lyric"
 * is therefore derived — currentSongId + pageIndex — rather than the
 * full lyric text being duplicated into every sync tick, which would
 * be wasteful bandwidth-wise and cut against "reduce unnecessary
 * Firebase updates").
 *
 * Reserved-only fields (beat / measure / tempo): these are written as
 * nullable placeholders for a future MIDI timing/sequencer engine. No
 * such engine exists yet, and this file does not attempt to build one —
 * the existing page-turner MIDI implementation in app.js is unchanged.
 */
import { getFirebaseApp, serverTimestamp } from './firebase.js';
import { getActiveSessionId, canControlPlayback } from './session.js';

function db() {
  return getFirebaseApp().database();
}

function requireSession() {
  const sid = getActiveSessionId();
  if (!sid) throw new Error('No active session. Call createSession() or joinSession() first.');
  return sid;
}

/* ================================================================
   LOOP PREVENTION
   ================================================================
   When a remote update is received (watchPlaybackState/watchDisplayState
   callback fires) and the UI reacts to it, that reaction can naturally
   call back into one of the publish functions below (e.g. an onChange
   handler that calls setPage() to "reflect" what it just received).
   Without a guard, that republishes the same value right back to
   Firebase — harmless in isolation, but on every device, every tick,
   this becomes an actual feedback loop. beginRemoteApply()/
   endRemoteApply() bracket every incoming update automatically (see the
   watch* functions), and every publish function checks isSuppressed()
   first and no-ops while a remote update is being applied.
   ---------------------------------------------------------------- */
let suppressDepth = 0;
function beginRemoteApply() { suppressDepth++; }
function endRemoteApply()   { suppressDepth = Math.max(0, suppressDepth - 1); }
function isSuppressed()     { return suppressDepth > 0; }

/* ================================================================
   DIFFED WRITES (reduce unnecessary Firebase updates)
   ================================================================
   Both caches are kept in sync with the *authoritative* remote value
   whenever a snapshot is received (see watch* functions), not just
   with what this device last wrote — so a device that reconnects after
   being offline still compares against the real current state instead
   of stale local memory.
   ---------------------------------------------------------------- */
let lastKnownPlaybackState = {};
let lastKnownDisplayState = {};

function diffPartial(partial, cache) {
  const changed = {};
  let any = false;
  for (const [key, value] of Object.entries(partial)) {
    if (cache[key] !== value) {
      changed[key] = value;
      any = true;
    }
  }
  return any ? changed : null;
}

/* ================================================================
   PLAYBACK STATE — Play/Pause/Stop/Next/Previous/Song/Page/Position
   ================================================================ */

function playbackStateRef() {
  return db().ref(`sessions/${requireSession()}/playbackState`);
}

/**
 * Host, Admin, and Presenter devices may publish playback state.
 * Viewer devices should only ever watch it (see watchPlaybackState).
 */
function publishPlaybackState(partial) {
  if (isSuppressed()) return Promise.resolve(); // came from a remote update being applied — not a real user action
  if (!canControlPlayback()) {
    console.warn('[realtime.js] Only host/admin/presenter devices may publish playback state — ignored.');
    return Promise.resolve();
  }
  const changed = diffPartial(partial, lastKnownPlaybackState);
  if (!changed) return Promise.resolve(); // no actual change — skip the write entirely

  Object.assign(lastKnownPlaybackState, changed);
  return playbackStateRef().update({ ...changed, updatedAt: serverTimestamp() });
}

export function play()  { return publishPlaybackState({ status: 'playing' }); }
export function pause() { return publishPlaybackState({ status: 'paused' }); }
export function stop()  { return publishPlaybackState({ status: 'stopped', pageIndex: 0, playbackPosition: 0 }); }

export function setCurrentSong(songId, songName) {
  return publishPlaybackState({ currentSongId: songId, currentSongName: songName, pageIndex: 0, playbackPosition: 0 });
}

export function setPage(pageIndex) {
  return publishPlaybackState({ pageIndex });
}

export function next(currentPageIndex) {
  return setPage(currentPageIndex + 1);
}

export function previous(currentPageIndex) {
  return setPage(Math.max(0, currentPageIndex - 1));
}

export function setPlaybackPosition(position) {
  return publishPlaybackState({ playbackPosition: position });
}

/**
 * Reserved placeholders only — writes null unless explicit values are
 * passed in by a *future* timing engine. Not called anywhere yet.
 */
export function setTimingPlaceholders({ beat = null, measure = null, tempo = null } = {}) {
  return publishPlaybackState({ beat, measure, tempo });
}

/**
 * Watch playback state changes. Automatically brackets the callback with
 * the loop-prevention guard, so any publish* call made synchronously
 * inside `callback` (e.g. a UI reacting to the update) is safely
 * absorbed instead of bouncing back to Firebase.
 * @param {(state: object) => void} callback
 * @returns {() => void} unsubscribe function
 */
export function watchPlaybackState(callback) {
  let sid;
  try { sid = requireSession(); } catch { return () => {}; }
  const ref = db().ref(`sessions/${sid}/playbackState`);
  const handler = (snap) => {
    const data = snap.val() || {};
    Object.assign(lastKnownPlaybackState, data);
    beginRemoteApply();
    try { callback(data); } finally { endRemoteApply(); }
  };
  ref.on('value', handler);
  return () => ref.off('value', handler);
}

/* ================================================================
   DISPLAY STATE — Theme / Font Size / Fullscreen
   ================================================================
   Kept in a separate `displayState` node (not merged into
   playbackState) so that, say, a font-size tweak doesn't touch
   playbackState's updatedAt / trigger playback-state listeners for an
   unrelated concern — smaller, more targeted writes and re-renders.
   ================================================================ */

function displayStateRef() {
  return db().ref(`sessions/${requireSession()}/displayState`);
}

function publishDisplayState(partial) {
  if (isSuppressed()) return Promise.resolve();
  if (!canControlPlayback()) {
    console.warn('[realtime.js] Only host/admin/presenter devices may publish display state — ignored.');
    return Promise.resolve();
  }
  const changed = diffPartial(partial, lastKnownDisplayState);
  if (!changed) return Promise.resolve();

  Object.assign(lastKnownDisplayState, changed);
  return displayStateRef().update({ ...changed, updatedAt: serverTimestamp() });
}

export function setSyncedTheme(theme)          { return publishDisplayState({ theme }); }
export function setSyncedFontSize(fontSize)    { return publishDisplayState({ fontSize }); }
export function setSyncedFullscreen(fullscreen){ return publishDisplayState({ fullscreen }); }

/**
 * Watch display state (theme/fontSize/fullscreen) changes. Same
 * loop-prevention bracketing as watchPlaybackState.
 * @param {(state: object) => void} callback
 * @returns {() => void} unsubscribe function
 */
export function watchDisplayState(callback) {
  let sid;
  try { sid = requireSession(); } catch { return () => {}; }
  const ref = db().ref(`sessions/${sid}/displayState`);
  const handler = (snap) => {
    const data = snap.val() || {};
    Object.assign(lastKnownDisplayState, data);
    beginRemoteApply();
    try { callback(data); } finally { endRemoteApply(); }
  };
  ref.on('value', handler);
  return () => ref.off('value', handler);
}

/* ----------------------------------------------------------------
   Lyrics storage was here in Phase 2 (session-scoped) — superseded in
   Phase 3 by services/firebase/library.js (persistent, not tied to a
   session's lifecycle). Nothing in the codebase called the old
   saveLyricsText/watchLyrics/importLyricsFile functions (confirmed
   during the Phase 2 validation pass), so removing them here is a
   zero-behavioral-impact cleanup, not a breaking change.
   ---------------------------------------------------------------- */
