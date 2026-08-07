/**
 * app.js — application entry point / orchestrator.
 *
 * As of the repository restructuring, this file no longer contains any
 * application logic itself — every function has been moved into
 * services/{library,midi,ui,utils}/*.js (and services/firebase/* from
 * an earlier phase). This file's only two jobs are:
 *
 *   1. Import everything and expose the functions referenced by
 *      inline HTML event handlers (onclick=/onchange=/oninput=) onto
 *      `window` — necessary because this file is now loaded as
 *      type="module" (ES modules are NOT global by default), and the
 *      HTML markup itself was intentionally left unchanged.
 *   2. Run the DOMContentLoaded init sequence, in the same order the
 *      original two separate listeners used, now consolidated into one.
 *
 * See docs/IMPLEMENTATION_LOG.md for the full restructuring record.
 */

// --- MIDI ---
import { initMIDI } from './services/midi/midi.js';
import { toggleMidiLearn, clearMidiMapping } from './services/midi/learn.js';

// --- Viewer (state, page rendering/navigation, font size, auto-fit) ---
import {
  navigate, changeFontSize, toggleAutoFit, updateFontDisplay, initAutoFit, state,
} from './services/ui/viewer.js';

// --- Song navigation (Previous Song / Next Song — bottom toolbar) ---
import { navigateSong } from './services/ui/song-nav.js';

// --- Sidebar (song loading, setlist, mode) ---
import { loadSongList, setMode } from './services/ui/sidebar.js';

// --- Toolbar (theme, fullscreen, sidebar collapse, wake lock, drawer) ---
import {
  initTheme, cycleTheme, toggleFullscreen, initSidebarCollapse,
  toggleSidebarCollapse, updateFullscreenBtn, initFullscreenAutoCollapse,
  toggleWakeLock, toggleDrawer,
} from './services/ui/toolbar.js';

// --- Settings (Firebase config modal, sync toggle, session orchestration) ---
import {
  isFirebaseConfigured, loadFirebaseConfigToModal, saveFirebaseConfig,
  toggleFirebase, ensureFirebaseReady, openModal, closeModal, closeModalOutside,
} from './services/ui/settings.js';

// --- Dialogs (Cloud Song Library modal + Lyrics Editor) ---
import {
  initLibraryUI, openLibraryModal, closeLibraryModal, closeLibraryModalOutside,
  switchLibraryTab, handleLibrarySearch, handleImportTxt, openSongFromLibrary,
  closeEditorModal, closeEditorModalOutside, handleEditorInput,
  openEditingSongOnStage, createNewCollection, closeCollectionDetail,
  createNewPlaylist, closePlaylistDetail, playCurrentPlaylist,
} from './services/ui/dialogs.js';

// --- Utils ---
import { loadLocalPrefs } from './services/utils/storage.js';
import { initOfflineSupport } from './services/utils/offline.js';

/* ----------------------------------------------------------
   Expose every function referenced by an inline HTML event handler
   (onclick=/onchange=/oninput=) onto window — index.html's markup was
   intentionally left unchanged during this restructuring.
   ---------------------------------------------------------- */
Object.assign(window, {
  // MIDI
  toggleMidiLearn, clearMidiMapping,
  // Viewer
  navigate, changeFontSize, toggleAutoFit,
  // Song navigation (Previous Song / Next Song)
  navigateSong,
  // Sidebar
  loadSongList, setMode,
  // Toolbar
  cycleTheme, toggleFullscreen, toggleSidebarCollapse, toggleWakeLock, toggleDrawer,
  // Settings
  saveFirebaseConfig, toggleFirebase, openModal, closeModal, closeModalOutside,
  // Dialogs
  openLibraryModal, closeLibraryModal, closeLibraryModalOutside, switchLibraryTab,
  handleLibrarySearch, handleImportTxt, openSongFromLibrary, closeEditorModal,
  closeEditorModalOutside, handleEditorInput, openEditingSongOnStage,
  createNewCollection, closeCollectionDetail, createNewPlaylist, closePlaylistDetail,
  playCurrentPlaylist,
});

/* ----------------------------------------------------------
   INIT — consolidated from the original two separate DOMContentLoaded
   listeners (Phase 1's additive pattern) into one, same order.
   ---------------------------------------------------------- */
document.addEventListener('DOMContentLoaded', () => {
  loadLocalPrefs();
  initMIDI();
  loadSongList();
  loadFirebaseConfigToModal();
  initOfflineSupport();
  const fbToggle = document.getElementById('fb-toggle');
  if (fbToggle && state.fbEnabled && isFirebaseConfigured()) {
    fbToggle.checked = true;
    ensureFirebaseReady();
  }
  updateFontDisplay();

  initTheme();
  initSidebarCollapse();
  initAutoFit();
  updateFullscreenBtn();
  initLibraryUI();
  initFullscreenAutoCollapse();
});
