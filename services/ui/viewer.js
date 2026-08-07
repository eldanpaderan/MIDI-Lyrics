/**
 * services/ui/viewer.js
 *
 * The Lyrics Viewer — shared app state, page rendering/navigation, font
 * size, and auto-fit. Extracted from app.js during the repository
 * restructuring; logic unchanged from the original, except:
 *   - applySongAndRender() now calls the consolidated
 *     parseLyricsIntoPages() (services/library/parser.js) instead of
 *     inlining the [PAGE]/blank-line splitting heuristic directly —
 *     resolves the long-standing duplicated-parsing tech debt.
 *   - the auto-fit resize handler now uses the generic debounce()
 *     utility instead of an ad-hoc setTimeout/clearTimeout + module
 *     variable.
 *
 * `state` is exported from here and imported by nearly every other
 * module (midi/*, ui/sidebar.js, ui/toolbar.js, ui/settings.js,
 * ui/dialogs.js) — this is the shared single source of truth for the
 * app's current song/page/mode/MIDI/sync/wake-lock state.
 *
 * NOTE ON CIRCULAR IMPORTS: this file has safe, function-only circular
 * imports with utils/storage.js (loadFontSizeFromPreferences() is
 * called from storage.js's loadLocalPrefs(); getSyncedPref()/
 * setSyncedPref()/cacheActiveSong()/getCachedActiveSong() are called
 * from this file), with ui/settings.js (see that file's own note), and
 * with ui/song-nav.js (applySongAndRender() calls
 * updateSongNavButtons() after every song change; song-nav.js imports
 * `state` back from here — see song-nav.js's own note). Safe under ES
 * Module semantics — see the detailed explanation in utils/storage.js.
 */
import { parseLyricsIntoPages } from '../library/parser.js';
import { getSyncedPref, setSyncedPref, cacheActiveSong, getCachedActiveSong } from '../utils/storage.js';
import { debounce } from '../utils/debounce.js';
import { publishCurrentSongIfLeader, publishPageIfLeader, publishDisplayIfLeader } from './settings.js';
import { updateSongNavButtons } from './song-nav.js';

/* ----------------------------------------------------------
   STATE
   ---------------------------------------------------------- */
export const state = {
  songs:        [],       // [{id, name, url}]
  activeSong:   null,     // {id, name, url}
  pages:        [],       // string[]
  currentPage:  0,
  mode:         'leader', // 'leader' | 'follower'
  fontSize:     3,        // index into FONT_SIZES
  midiAccess:   null,
  midiLearn:    false,
  midiNextNote: null,     // {type, channel, note/cc}
  midiPrevNote: null,
  fbEnabled:    false,    // gates the modular Firebase services
  playing:      false,    // Play/Pause/Stop transport flag, synced via realtime.js
  wakeLock:     null,
  wakeLockOn:   false,
};

export const FONT_SIZES = [
  { label:'XS', val:'1.1rem' },
  { label:'S',  val:'1.5rem' },
  { label:'M',  val:'2.2rem' },
  { label:'L',  val:'3rem'   },
  { label:'XL', val:'3.8rem' },
  { label:'XXL',val:'5rem'   },
];

export function loadLyrics(song, text) {
  applySongAndRender(song, text);
  publishCurrentSongIfLeader(song);
}

/**
 * Pure state-update + render step, shared by:
 *  - loadLyrics() (local user action — Leader/no-sync — publishes after)
 *  - handleIncomingPlaybackState() (Follower receiving a Leader update —
 *    renders the SAME way, but never publishes; see settings.js)
 */
export function applySongAndRender(song, text) {
  state.activeSong  = song;
  state.currentPage = 0;
  state.pages = parseLyricsIntoPages(text);

  document.getElementById('song-title-display').textContent = song.name;
  document.getElementById('empty-state').style.display  = 'none';
  document.getElementById('lyric-display').style.display = 'flex';
  document.querySelectorAll('.song-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === song.id);
  });

  renderPage(0, 'instant');
  renderPips();
  updateNavButtons();
  updateSongNavButtons();
  cacheActiveSong(song, state.pages); // offline support — see utils/storage.js
}

/**
 * Offline support: restores the last song that was on stage from the
 * localStorage cache written by cacheActiveSong() (see utils/storage.js),
 * without needing any network request — used at startup when the device
 * is offline so the person can keep working from wherever they left off
 * instead of seeing an empty stage. No-ops if a song is already loaded
 * (e.g. Firebase reconnected and a Follower snapshot arrived first) or
 * if nothing was ever cached.
 */
export function restoreOfflineSong() {
  if (state.activeSong) return;
  const cached = getCachedActiveSong();
  if (!cached || !cached.song || !Array.isArray(cached.pages) || !cached.pages.length) return;

  state.activeSong  = cached.song;
  state.currentPage = 0;
  state.pages       = cached.pages;

  document.getElementById('song-title-display').textContent = cached.song.name;
  document.getElementById('empty-state').style.display   = 'none';
  document.getElementById('lyric-display').style.display = 'flex';
  document.querySelectorAll('.song-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.id === cached.song.id);
  });

  renderPage(0, 'instant');
  renderPips();
  updateNavButtons();
  updateSongNavButtons();
}

export function renderPage(index, mode = 'fade') {
  const text = document.getElementById('lyric-text');

  const doRender = () => {
    state.currentPage = index;
    text.textContent = state.pages[index] || '';
    text.classList.remove('fade-out');
    text.classList.add('fade-in');
    updateNavButtons();
    updatePips();
    updatePageCounter();
  };

  if (mode === 'instant') {
    doRender();
    return;
  }

  text.classList.add('fade-out');
  setTimeout(doRender, 160);
}

export function navigate(dir) {
  if (!state.pages.length) return;
  const next = state.currentPage + dir;
  if (next < 0 || next >= state.pages.length) return;
  renderPage(next);
  publishPageIfLeader(next);
}

export function updateNavButtons() {
  document.getElementById('prev-btn').disabled = !state.pages.length || state.currentPage <= 0;
  document.getElementById('next-btn').disabled = !state.pages.length || state.currentPage >= state.pages.length - 1;
}

export function updatePageCounter() {
  const el = document.getElementById('page-counter');
  if (!state.pages.length) { el.textContent = '— / —'; return; }
  el.textContent = `${state.currentPage + 1} / ${state.pages.length}`;
}

export function renderPips() {
  const strip = document.getElementById('pip-strip');
  strip.innerHTML = '';
  const max = Math.min(state.pages.length, 40);
  for (let i = 0; i < max; i++) {
    const pip = document.createElement('div');
    pip.className = 'pip' + (i === state.currentPage ? ' active' : '');
    pip.dataset.i = i;
    pip.addEventListener('click', () => { if (state.mode !== 'follower') { renderPage(i); publishPageIfLeader(i); } });
    strip.appendChild(pip);
  }
  if (state.pages.length > 40) {
    strip.insertAdjacentHTML('beforeend', `<span style="font-size:0.65rem;color:var(--text-muted);margin-left:4px;">+${state.pages.length - 40}</span>`);
  }
}

export function updatePips() {
  document.querySelectorAll('#pip-strip .pip').forEach((p, i) => {
    p.classList.toggle('active', i === state.currentPage);
  });
}

/* ----------------------------------------------------------
   FONT SIZE
   ---------------------------------------------------------- */
export function changeFontSize(dir) {
  state.fontSize = Math.max(0, Math.min(FONT_SIZES.length - 1, state.fontSize + dir));
  updateFontDisplay();
  setSyncedPref('font', { size: FONT_SIZES[state.fontSize].label });
  publishDisplayIfLeader({ fontSize: FONT_SIZES[state.fontSize].label });
}

/**
 * Follower-side mirroring only: sets font size by label (matching what
 * realtime.js's displayState carries) WITHOUT persisting to this
 * device's own PreferenceService and WITHOUT publishing anywhere.
 */
export function applyFontSizeByLabel(label) {
  const idx = FONT_SIZES.findIndex((f) => f.label === label);
  if (idx !== -1) {
    state.fontSize = idx;
    updateFontDisplay();
  }
}

export function loadFontSizeFromPreferences() {
  const font = getSyncedPref('font', null);
  if (font && font.size) {
    const idx = FONT_SIZES.findIndex((f) => f.label === font.size);
    if (idx !== -1) state.fontSize = idx;
  }
}

export function updateFontDisplay() {
  const entry = FONT_SIZES[state.fontSize];
  document.getElementById('lyric-text').style.fontSize = entry.val;
  document.getElementById('font-size-label').textContent = entry.label;
}

/* ----------------------------------------------------------
   AUTO-FIT LYRICS
   Watches #lyric-text for content changes and resizes it to
   fit its container. Does not call into, or get called by,
   any paging/sync function — purely observational.
   ---------------------------------------------------------- */
let autoFitEnabled = false;
let autoFitRAF = null;

export function initAutoFit() {
  autoFitEnabled = getSyncedPref('autoFit', false);
  const toggle = document.getElementById('autofit-toggle');
  if (toggle) toggle.checked = autoFitEnabled;

  const lyricText = document.getElementById('lyric-text');
  const lyricDisplay = document.getElementById('lyric-display');
  if (!lyricText || !lyricDisplay) return;

  const scheduleFit = () => {
    if (!autoFitEnabled) return;
    if (autoFitRAF) cancelAnimationFrame(autoFitRAF);
    autoFitRAF = requestAnimationFrame(fitLyricText);
  };

  // Content changes (new page rendered) and container-size changes (sidebar
  // collapse, fullscreen toggle) refit immediately via rAF.
  new MutationObserver(scheduleFit).observe(lyricText, { childList: true, characterData: true, subtree: true });
  new ResizeObserver(scheduleFit).observe(lyricDisplay);

  // Plain viewport resize (window drag / device rotation) is debounced —
  // this event can fire dozens of times per second while dragging, and
  // the container-based ResizeObserver above already catches the common
  // case, so this is just a safety net for edge cases (e.g. some mobile
  // browsers delaying the container resize by a frame or two).
  window.addEventListener('resize', debounce(scheduleFit, 120));
}

export function toggleAutoFit(on) {
  autoFitEnabled = on;
  setSyncedPref('autoFit', on);
  if (on) {
    fitLyricText();
  } else {
    // Restore manual font size selection
    updateFontDisplay();
  }
}

export function fitLyricText() {
  const text = document.getElementById('lyric-text');
  const container = document.getElementById('lyric-display');
  if (!text || !container || !text.textContent.trim()) return;

  const minPx = 16;   // ~1.1rem
  const maxPx = 90;    // ~6.2rem, generous ceiling for stage displays
  const containerRect = container.getBoundingClientRect();
  const maxWidth  = containerRect.width  - 16;
  const maxHeight = containerRect.height - 16;
  if (maxWidth <= 0 || maxHeight <= 0) return;

  let lo = minPx, hi = maxPx, best = minPx;
  // Binary search for the largest font size that still fits
  for (let i = 0; i < 10; i++) {
    const mid = Math.floor((lo + hi) / 2);
    text.style.fontSize = mid + 'px';
    const fits = text.scrollWidth <= maxWidth && text.scrollHeight <= maxHeight;
    if (fits) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
    if (lo > hi) break;
  }
  text.style.fontSize = best + 'px';
}

/* ----------------------------------------------------------
   KEYBOARD SHORTCUTS (Desktop) — page/font navigation
   ---------------------------------------------------------- */
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowRight' || e.key === ' ')  { e.preventDefault(); navigate(1); }
  if (e.key === 'ArrowLeft')                     { e.preventDefault(); navigate(-1); }
  if (e.key === 'ArrowUp')                       { e.preventDefault(); changeFontSize(1); }
  if (e.key === 'ArrowDown')                     { e.preventDefault(); changeFontSize(-1); }
});

/* ----------------------------------------------------------
   TOUCH / SWIPE (Mobile)
   ---------------------------------------------------------- */
let touchStartX = 0;
let touchStartY = 0;
const lyricStage = document.getElementById('lyric-stage');

lyricStage.addEventListener('touchstart', (e) => {
  touchStartX = e.changedTouches[0].clientX;
  touchStartY = e.changedTouches[0].clientY;
}, { passive: true });

lyricStage.addEventListener('touchend', (e) => {
  const dx = e.changedTouches[0].clientX - touchStartX;
  const dy = e.changedTouches[0].clientY - touchStartY;
  if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 50) {
    if (dx < 0) navigate(1);
    else        navigate(-1);
  }
}, { passive: true });

// Tap center to advance (single tap on lyric area)
lyricStage.addEventListener('click', (e) => {
  const w = lyricStage.offsetWidth;
  if (e.clientX > w * 0.2 && e.clientX < w * 0.8) {
    navigate(1);
  }
});
