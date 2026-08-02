/**
 * services/ui/settings.js
 *
 * Firebase config modal, sync toggle, and all session/realtime
 * orchestration — this is the "orchestration layer" described in the
 * Complete Migration phase, now living here since every piece of it is
 * triggered by (or supports) the Settings/Sync Toggle UI. Every actual
 * Firebase read/write still goes exclusively through
 * services/firebase/* (via window.MLFirebase) — this file contains no
 * direct Firebase SDK calls.
 *
 * NOTE ON CIRCULAR IMPORTS: this file imports from ui/viewer.js,
 * ui/toolbar.js, and ui/dialogs.js, each of which imports back from
 * this file (e.g. viewer.js's changeFontSize()/navigate() publish via
 * this file's publishDisplayIfLeader()/publishPageIfLeader(); this
 * file's handleIncomingPlaybackState()/handleIncomingDisplayState()
 * call back into viewer.js/toolbar.js to render/apply what a Follower
 * receives). This is safe under ES Module semantics — see the same
 * note in utils/storage.js — since none of these functions are called
 * at module-evaluation time, only later from user interaction or the
 * init sequence.
 */
import { state, applySongAndRender, renderPage } from './viewer.js';
import { applyThemeToDOM, applyFullscreenState, setPillState } from './toolbar.js';
import { applyFontSizeByLabel } from './viewer.js';
import { showToast, detectPlatform } from '../utils/helpers.js';
import { saveLocalPrefs } from '../utils/storage.js';
import { libraryCache } from './dialogs.js';

/**
 * Since this app has no session-ID entry UI (Leader/Follower is a
 * simple toggle), all devices share one well-known, fixed session ID.
 * Whichever device is in "Leader" mode becomes/reclaims the Host of
 * this session; "Follower" devices join it as read-only Viewers.
 */
export const MAIN_SESSION_ID = 'mlr-main-session';

/* ----------------------------------------------------------
   FIREBASE CONFIG MODAL
   ---------------------------------------------------------- */
export function isFirebaseConfigured() {
  const cfg = loadFirebaseConfig();
  return !!(cfg && cfg.apiKey && !cfg.apiKey.startsWith('YOUR_'));
}

export function loadFirebaseConfig() {
  const saved = localStorage.getItem('mlr_fb_config');
  return saved ? JSON.parse(saved) : null;
}

export function loadFirebaseConfigToModal() {
  const cfg = loadFirebaseConfig();
  if (!cfg) return;
  document.getElementById('cfg-apiKey').value      = cfg.apiKey      || '';
  document.getElementById('cfg-authDomain').value  = cfg.authDomain  || '';
  document.getElementById('cfg-databaseURL').value = cfg.databaseURL || '';
  document.getElementById('cfg-projectId').value   = cfg.projectId   || '';
  document.getElementById('cfg-appId').value       = cfg.appId       || '';
}

export function saveFirebaseConfig() {
  const cfg = {
    apiKey:            document.getElementById('cfg-apiKey').value.trim(),
    authDomain:        document.getElementById('cfg-authDomain').value.trim(),
    databaseURL:       document.getElementById('cfg-databaseURL').value.trim(),
    projectId:         document.getElementById('cfg-projectId').value.trim(),
    appId:             document.getElementById('cfg-appId').value.trim(),
    storageBucket:     document.getElementById('cfg-projectId').value.trim() + '.appspot.com',
    messagingSenderId: '',
  };
  localStorage.setItem('mlr_fb_config', JSON.stringify(cfg));
  closeModal();
  if (state.fbEnabled) {
    ensureFirebaseReady(cfg); // re-bootstrap with the freshly saved config if sync is already on
  }
  showToast('Firebase config saved!', 'success');
}

export function toggleFirebase(on) {
  state.fbEnabled = on;
  saveLocalPrefs();
  if (on) {
    if (!isFirebaseConfigured()) {
      showToast('Please configure Firebase first', 'error');
      document.getElementById('fb-toggle').checked = false;
      state.fbEnabled = false;
      openModal();
      return;
    }
    ensureFirebaseReady();
  } else {
    stopModularSync();
  }
}

export function openModal() {
  document.getElementById('modal-overlay').classList.add('open');
}
export function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
}
export function closeModalOutside(e) {
  if (e.target === document.getElementById('modal-overlay')) closeModal();
}

/* ----------------------------------------------------------
   FIREBASE READINESS / SESSION SYNC
   ---------------------------------------------------------- */

/**
 * Guarantees the modular Firebase services are initialized (idempotent —
 * see services/firebase/firebase.js's own singleton guard, so this can
 * never create a duplicate Firebase App instance), then starts session
 * sync for whichever mode (Leader/Follower) this device is currently in.
 */
export function ensureFirebaseReady(explicitConfig = null) {
  if (window.MLFirebase && window.MLFirebase.ensureFirebaseServices) {
    proceedWithFirebaseReady(explicitConfig);
    return;
  }

  // The modular services module (services/firebase/browser-bridge.js)
  // hasn't finished loading/evaluating yet. Rather than failing outright
  // and asking the person to manually retry, actually WAIT for it using
  // the MLFirebaseReady event that browser-bridge.js dispatches once
  // window.MLFirebase is fully attached. A timeout safety net still
  // surfaces a real error if the module genuinely never loads (network
  // failure, blocked request, etc.), instead of waiting forever with no
  // feedback.
  setPillState('fb-pill', 'syncing', 'Sync');

  const onReady = () => {
    window.removeEventListener('MLFirebaseReady', onReady);
    clearTimeout(timeoutId);
    proceedWithFirebaseReady(explicitConfig);
  };
  window.addEventListener('MLFirebaseReady', onReady);

  const timeoutId = setTimeout(() => {
    window.removeEventListener('MLFirebaseReady', onReady);
    setPillState('fb-pill', 'error', 'Sync');
    showToast('Firebase services failed to load — check your connection and refresh the page', 'error');
  }, 8000);
}

function proceedWithFirebaseReady(explicitConfig) {
  const ready = window.MLFirebase.ensureFirebaseServices(explicitConfig);
  if (!ready) {
    setPillState('fb-pill', 'error', 'Sync');
    return;
  }
  showToast('Firebase connected', 'success');
  syncSessionForCurrentMode();
}

/**
 * Creates (Leader) or joins (Follower) the app's one shared session —
 * see MAIN_SESSION_ID above. Waits for anonymous auth to resolve if it
 * hasn't yet (sign-in itself is handled by browser-bridge.js).
 */
export async function syncSessionForCurrentMode() {
  if (!state.fbEnabled) return;
  if (!window.MLFirebase || !window.MLFirebase.isFirebaseInitialized()) return;

  const user = window.MLFirebase.getCurrentUser();
  if (!user) {
    const unsub = window.MLFirebase.onAuthChange((u) => {
      if (u) { unsub(); syncSessionForCurrentMode(); }
    });
    return;
  }

  try {
    setPillState('fb-pill', 'syncing', 'Sync');
    if (state.mode === 'leader') {
      await window.MLFirebase.createSession({ platform: detectPlatform(), label: 'Leader' }, MAIN_SESSION_ID);
      // Immediately (re-)publish whatever is currently on stage, in case
      // Follower devices were already connected and waiting.
      if (state.activeSong) publishCurrentSongIfLeader(state.activeSong);
      publishPageIfLeader(state.currentPage);
    } else {
      await window.MLFirebase.joinSession(MAIN_SESSION_ID, { platform: detectPlatform(), label: 'Follower' }, window.MLFirebase.ROLES.VIEWER);
    }
    setPillState('fb-pill', 'connected', 'Sync');
    ensurePlaybackSubscription();
    ensureDisplaySubscription();
  } catch (err) {
    setPillState('fb-pill', 'error', 'Sync');
    showToast('Sync error: ' + err.message, 'error');
  }
}

export function stopModularSync() {
  teardownSubscriptions();
  if (window.MLFirebase && window.MLFirebase.getActiveSessionId()) {
    window.MLFirebase.leaveSession();
  }
  setPillState('fb-pill', '', 'Sync');
}

/* ---------------- Publish (Leader/Host only — realtime.js self-guards this too) ---------------- */

export function publishCurrentSongIfLeader(song) {
  if (state.mode !== 'leader' || !state.fbEnabled) return;
  if (!window.MLFirebase || !window.MLFirebase.getActiveSessionId()) return;
  window.MLFirebase.setCurrentSong(song.id, song.name, song.url || null).catch(() => {});
}

export function publishPageIfLeader(pageIndex) {
  if (state.mode !== 'leader' || !state.fbEnabled) return;
  if (!window.MLFirebase || !window.MLFirebase.getActiveSessionId()) return;
  window.MLFirebase.setPage(pageIndex).catch(() => {});
}

/**
 * Publishes Theme/Font Size/Fullscreen to the shared session's
 * displayState — used so Follower devices can mirror the Leader's
 * stage display. Distinct from setSyncedPref() (this device's own
 * personal PreferenceService) — both fire from the same user action,
 * but serve different purposes (see the Complete Migration log entry).
 */
export function publishDisplayIfLeader(partial) {
  if (state.mode !== 'leader' || !state.fbEnabled) return;
  if (!window.MLFirebase || !window.MLFirebase.getActiveSessionId()) return;
  if ('theme' in partial)      window.MLFirebase.setSyncedTheme(partial.theme).catch(() => {});
  if ('fontSize' in partial)   window.MLFirebase.setSyncedFontSize(partial.fontSize).catch(() => {});
  if ('fullscreen' in partial) window.MLFirebase.setSyncedFullscreen(partial.fullscreen).catch(() => {});
}

/* ---------------- Play / Pause / Stop (transport, Leader/Host only) ---------------- */

export function playSession() {
  state.playing = true;
  updatePlayPauseStopUI();
  if (state.mode === 'leader' && state.fbEnabled && window.MLFirebase && window.MLFirebase.getActiveSessionId()) {
    window.MLFirebase.play().catch(() => {});
  }
}

export function pauseSession() {
  state.playing = false;
  updatePlayPauseStopUI();
  if (state.mode === 'leader' && state.fbEnabled && window.MLFirebase && window.MLFirebase.getActiveSessionId()) {
    window.MLFirebase.pause().catch(() => {});
  }
}

export function stopSession() {
  state.playing = false;
  updatePlayPauseStopUI();
  if (state.mode === 'leader' && state.fbEnabled && window.MLFirebase && window.MLFirebase.getActiveSessionId()) {
    window.MLFirebase.stop().catch(() => {});
  }
}

export function updatePlayPauseStopUI() {
  const playBtn  = document.getElementById('play-btn');
  const pauseBtn = document.getElementById('pause-btn');
  if (playBtn)  playBtn.classList.toggle('active', state.playing);
  if (pauseBtn) pauseBtn.classList.toggle('active', !state.playing);
}

/* ---------------- Subscriptions (Follower + Leader both watch; see role-gating below) ---------------- */

let unsubPlayback = null;
let unsubDisplay  = null;

export function ensurePlaybackSubscription() {
  if (unsubPlayback) return; // already subscribed — never register a second listener for the same session
  unsubPlayback = window.MLFirebase.watchPlaybackState(handleIncomingPlaybackState);
}

export function ensureDisplaySubscription() {
  if (unsubDisplay) return;
  unsubDisplay = window.MLFirebase.watchDisplayState(handleIncomingDisplayState);
}

export function teardownSubscriptions() {
  if (unsubPlayback) { unsubPlayback(); unsubPlayback = null; }
  if (unsubDisplay)  { unsubDisplay();  unsubDisplay  = null; }
}

/**
 * Follower-side: receives Leader-published playback state, updates
 * local state, and immediately re-renders — and NEVER calls a publish
 * function in response (no echo). Also fires for the Leader's own
 * device (Realtime Database delivers every write back to all listeners,
 * including the writer), which is deliberately ignored below via
 * canControlPlayback() — the Leader already rendered its own change
 * instantly and locally; it doesn't need to react to its own echo.
 */
export async function handleIncomingPlaybackState(data) {
  if (!data) return;
  if (window.MLFirebase.canControlPlayback()) return; // this device published it — ignore the echo

  state.playing = data.status === 'playing';
  updatePlayPauseStopUI();

  const { currentSongId, currentSongName, songUrl, pageIndex } = data;

  if (currentSongId && (!state.activeSong || state.activeSong.id !== currentSongId)) {
    try {
      let text;
      if (songUrl) {
        const res = await fetch(songUrl);
        if (!res.ok) throw new Error('Fetch failed');
        text = await res.text();
      } else {
        // No local URL — this is a Cloud Library song; resolve it from
        // the Library cache (see ui/dialogs.js) or fetch it directly.
        const cached = libraryCache[currentSongId];
        text = cached ? cached.text : (await window.MLFirebase.getSong(currentSongId))?.text;
      }
      if (typeof text === 'string') {
        applySongAndRender({ id: currentSongId, name: currentSongName, url: songUrl || null }, text);
      }
    } catch {
      // Could not resolve the song text — leave the current display as-is.
    }
  }

  if (typeof pageIndex === 'number' && state.pages.length > pageIndex && state.currentPage !== pageIndex) {
    renderPage(pageIndex);
  }
}

/**
 * Follower-side: mirrors the Leader's Theme/Font Size/Fullscreen
 * locally (visual only — does NOT persist to this device's own
 * PreferenceService, and does NOT call a publish function, so it can
 * never echo or permanently override this device's personal settings).
 */
export function handleIncomingDisplayState(data) {
  if (!data) return;
  if (window.MLFirebase.canControlPlayback()) return; // ignore echo of our own publish

  if (data.theme) applyThemeToDOM(data.theme);
  if (data.fontSize) applyFontSizeByLabel(data.fontSize);
  if (typeof data.fullscreen === 'boolean') applyFullscreenState(data.fullscreen);
}
