'use strict';

/* ----------------------------------------------------------
   COMPLETE MIGRATION (Firebase): this app now uses ONLY the modular
   services in services/firebase/ for all Firebase interaction —
   firebase.js (init), auth.js (anonymous auth), session.js (session
   lifecycle + roles), realtime.js (playback/display sync), and
   preference.js (personal settings sync). The legacy
   connectFirebase()/fbPublish()/fbStartListening()/handleFollowerUpdate()
   system and its DEFAULT_FIREBASE_CONFIG/FIREBASE_DB_PATH constants have
   been fully removed — see docs/IMPLEMENTATION_LOG.md for the full
   migration record.

   Since this app has no session-ID entry UI (Leader/Follower is a
   simple toggle), all devices share one well-known, fixed session ID.
   Whichever device is in "Leader" mode becomes/reclaims the Host of
   this session; "Follower" devices join it as read-only Viewers.
   ---------------------------------------------------------- */
const MAIN_SESSION_ID = 'mlr-main-session';

/* ----------------------------------------------------------
   STATE
   ---------------------------------------------------------- */
const state = {
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
  fbEnabled:    false,    // gates the modular Firebase services (same meaning as before, now backed by services/firebase/*)
  playing:      false,    // Play/Pause/Stop transport flag, synced via realtime.js
  wakeLock:     null,
  wakeLockOn:   false,
};

const FONT_SIZES = [
  { label:'XS', val:'1.1rem' },
  { label:'S',  val:'1.5rem' },
  { label:'M',  val:'2.2rem' },
  { label:'L',  val:'3rem'   },
  { label:'XL', val:'3.8rem' },
  { label:'XXL',val:'5rem'   },
];

/* ----------------------------------------------------------
   INIT
   ---------------------------------------------------------- */
document.addEventListener('DOMContentLoaded', () => {
  loadLocalPrefs();
  initMIDI();
  loadSongList();
  loadFirebaseConfigToModal();
  const fbToggle = document.getElementById('fb-toggle');
  if (state.fbEnabled && isFirebaseConfigured()) {
    fbToggle.checked = true;
    ensureFirebaseReady();
  }
  updateFontDisplay();
});

/* ----------------------------------------------------------
   PREFS (localStorage)
   ---------------------------------------------------------- */
function saveLocalPrefs() {
  localStorage.setItem('mlr_mode',         state.mode);
  localStorage.setItem('mlr_midiNext',     JSON.stringify(state.midiNextNote));
  localStorage.setItem('mlr_midiPrev',     JSON.stringify(state.midiPrevNote));
  localStorage.setItem('mlr_fbEnabled',    state.fbEnabled);
}

function loadLocalPrefs() {
  const mode = localStorage.getItem('mlr_mode');
  if (mode) setMode(mode, true);
  const mn = localStorage.getItem('mlr_midiNext');
  if (mn) state.midiNextNote = JSON.parse(mn);
  const mp = localStorage.getItem('mlr_midiPrev');
  if (mp) state.midiPrevNote = JSON.parse(mp);
  const fbe = localStorage.getItem('mlr_fbEnabled');
  if (fbe) state.fbEnabled = fbe === 'true';
  updateMidiMappingInfo();
  loadFontSizeFromPreferences();
}

/* ----------------------------------------------------------
   PREFERENCE SERVICE DELEGATION (audit fix H4)
   ----------------------------------------------------------
   Theme, sidebar-collapsed, font size, and auto-fit used to be saved
   under their own separate localStorage keys here (mlr_theme,
   mlr_sidebar_collapsed, mlr_fontSize, mlr_autofit), completely
   disconnected from services/firebase/preference.js's PreferenceService
   — meaning these settings could never actually sync across devices
   even when Firebase sync was enabled, and the two systems could
   silently drift out of sync with each other. These two functions
   route reads/writes through the single PreferenceService instead
   (which itself always persists to localStorage under one shared key,
   'mlr_preferences', regardless of whether Firebase is configured —
   see preference.js). If the services module hasn't loaded for some
   reason, these fall back to safe in-memory defaults rather than
   writing to a second localStorage key, to avoid reintroducing the
   same duplication this fix is meant to remove.
   ---------------------------------------------------------- */
function getSyncedPref(key, fallback) {
  if (window.MLFirebase && typeof window.MLFirebase.getPreferences === 'function') {
    const prefs = window.MLFirebase.getPreferences();
    return (prefs && prefs[key] !== undefined) ? prefs[key] : fallback;
  }
  return fallback;
}

function setSyncedPref(key, value) {
  if (window.MLFirebase && typeof window.MLFirebase.setPreference === 'function') {
    window.MLFirebase.setPreference(key, value);
  }
}

/* ----------------------------------------------------------
   SONG LOADING — GitHub Pages / local fetch
   ---------------------------------------------------------- */
async function loadSongList() {
  const container = document.getElementById('setlist-container');
  const placeholder = document.getElementById('setlist-placeholder');
  container.innerHTML = '<div style="padding:20px;"><div class="spinner"></div></div>';

  try {
    // Strategy 1: GitHub REST API (when hosted on GitHub Pages)
    const repoInfo = detectGitHubRepo();
    let files = [];

    if (repoInfo) {
      files = await fetchSongsFromGitHubAPI(repoInfo);
    }

    // Strategy 2: Fallback — fetch ./songs/index.json (manual manifest)
    if (!files.length) {
      files = await fetchSongsFromManifest();
    }

    // Strategy 3: Attempt directory listing (works on some servers)
    if (!files.length) {
      files = await fetchSongsFromDirectory();
    }

    state.songs = files;

    if (!files.length) {
      container.innerHTML = `
        <div class="setlist-empty">
          <div class="icon">📂</div>
          <p>No songs found. Add <code>.txt</code> files to <code>songs/</code> and refresh.<br><br>
          Tip: Create a <code>songs/index.json</code> with a list of filenames for guaranteed detection.</p>
        </div>`;
      return;
    }

    renderSetlist(files);
    showToast(`${files.length} song${files.length !== 1 ? 's' : ''} loaded`, 'success');

  } catch (err) {
    container.innerHTML = `
      <div class="setlist-empty">
        <div class="icon">⚠️</div>
        <p>Could not load songs.<br><small style="color:var(--text-muted)">${err.message}</small></p>
      </div>`;
    showToast('Song list load failed', 'error');
  }
}

function detectGitHubRepo() {
  // Detects if running on GitHub Pages: username.github.io/reponame
  const host = window.location.hostname;
  const path = window.location.pathname;
  if (!host.endsWith('.github.io')) return null;
  const owner = host.replace('.github.io', '');
  // path = /reponame/ or just /
  const parts = path.split('/').filter(Boolean);
  const repo  = parts.length ? parts[0] : owner + '.github.io';
  return { owner, repo };
}

async function fetchSongsFromGitHubAPI({ owner, repo }) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/songs`;
  const res  = await fetch(url, { headers: { 'Accept': 'application/vnd.github.v3+json' } });
  if (!res.ok) return [];
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data
    .filter(f => f.type === 'file' && f.name.endsWith('.txt'))
    .map(f => ({
      id:   f.name.replace(/\.txt$/i, ''),
      name: formatSongName(f.name.replace(/\.txt$/i, '')),
      url:  `./songs/${f.name}`,
    }));
}

async function fetchSongsFromManifest() {
  try {
    const res  = await fetch('./songs/index.json');
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data.map(name => {
      const base = name.replace(/\.txt$/i, '');
      return { id: base, name: formatSongName(base), url: `./songs/${name.endsWith('.txt') ? name : name + '.txt'}` };
    });
  } catch { return []; }
}

async function fetchSongsFromDirectory() {
  // Some dev servers serve directory listings as HTML
  try {
    const res  = await fetch('./songs/');
    if (!res.ok) return [];
    const text = await res.text();
    const matches = [...text.matchAll(/href="([^"]+\.txt)"/gi)];
    return matches.map(m => {
      const name = m[1].split('/').pop();
      const base = name.replace(/\.txt$/i, '');
      return { id: base, name: formatSongName(base), url: `./songs/${name}` };
    });
  } catch { return []; }
}

function formatSongName(raw) {
  return raw
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

function renderSetlist(songs) {
  const container = document.getElementById('setlist-container');
  container.innerHTML = '';
  songs.forEach((song, i) => {
    const el = document.createElement('div');
    el.className = 'song-item';
    el.dataset.id = song.id;
    el.innerHTML = `
      <span class="song-icon">♪</span>
      <span class="song-name">${song.name}</span>
      <span class="song-num">${String(i + 1).padStart(2,'0')}</span>`;
    el.addEventListener('click', () => selectSong(song));
    container.appendChild(el);
  });
}

async function selectSong(song) {
  if (state.mode === 'follower') {
    showToast('Follower mode: song is controlled by the leader', 'info');
    return;
  }
  // Close drawer on mobile
  closeSidebarDrawer();

  // Highlight active
  document.querySelectorAll('.song-item').forEach(el => el.classList.remove('active'));
  const el = document.querySelector(`.song-item[data-id="${song.id}"]`);
  if (el) el.classList.add('active');

  // Fetch lyrics
  try {
    const res  = await fetch(song.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    loadLyrics(song, text);
  } catch (err) {
    showToast(`Failed to load "${song.name}"`, 'error');
  }
}

/* ----------------------------------------------------------
   LYRICS ENGINE
   ---------------------------------------------------------- */
function loadLyrics(song, text) {
  applySongAndRender(song, text);
  publishCurrentSongIfLeader(song);
}

/**
 * Pure state-update + render step, shared by:
 *  - loadLyrics() (local user action — Leader/no-sync — publishes after)
 *  - handleIncomingPlaybackState() (Follower receiving a Leader update —
 *    renders the SAME way, but never publishes; see that function)
 */
function applySongAndRender(song, text) {
  state.activeSong  = song;
  state.currentPage = 0;

  // Split on [PAGE] tags OR double newlines (blank line = new page)
  let chunks;
  if (text.includes('[PAGE]')) {
    chunks = text.split(/\[PAGE\]/i);
  } else {
    // Split on 2+ blank lines
    chunks = text.split(/\n\s*\n\s*\n/);
    // Fallback: split on double blank line
    if (chunks.length < 2) chunks = text.split(/\n\n/);
  }

  state.pages = chunks
    .map(c => c.trim())
    .filter(c => c.length > 0);

  if (!state.pages.length) state.pages = [text.trim()];

  document.getElementById('song-title-display').textContent = song.name;
  document.getElementById('empty-state').style.display  = 'none';
  document.getElementById('lyric-display').style.display = 'flex';
  document.querySelectorAll('.song-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === song.id);
  });

  renderPage(0, 'instant');
  renderPips();
  updateNavButtons();
}

function renderPage(index, mode = 'fade') {
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

function navigate(dir) {
  if (!state.pages.length) return;
  const next = state.currentPage + dir;
  if (next < 0 || next >= state.pages.length) return;
  renderPage(next);
  publishPageIfLeader(next);
}

function updateNavButtons() {
  document.getElementById('prev-btn').disabled = !state.pages.length || state.currentPage <= 0;
  document.getElementById('next-btn').disabled = !state.pages.length || state.currentPage >= state.pages.length - 1;
}

function updatePageCounter() {
  const el = document.getElementById('page-counter');
  if (!state.pages.length) { el.textContent = '— / —'; return; }
  el.textContent = `${state.currentPage + 1} / ${state.pages.length}`;
}

function renderPips() {
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

function updatePips() {
  document.querySelectorAll('#pip-strip .pip').forEach((p, i) => {
    p.classList.toggle('active', i === state.currentPage);
  });
}

/* ----------------------------------------------------------
   FONT SIZE
   ---------------------------------------------------------- */
function changeFontSize(dir) {
  state.fontSize = Math.max(0, Math.min(FONT_SIZES.length - 1, state.fontSize + dir));
  updateFontDisplay();
  saveLocalPrefs();
  setSyncedPref('font', { size: FONT_SIZES[state.fontSize].label });
  publishDisplayIfLeader({ fontSize: FONT_SIZES[state.fontSize].label });
}

/**
 * Follower-side mirroring only: sets font size by label (matching what
 * realtime.js's displayState carries) WITHOUT persisting to this
 * device's own PreferenceService and WITHOUT publishing anywhere.
 */
function applyFontSizeByLabel(label) {
  const idx = FONT_SIZES.findIndex((f) => f.label === label);
  if (idx !== -1) {
    state.fontSize = idx;
    updateFontDisplay();
  }
}

function loadFontSizeFromPreferences() {
  const font = getSyncedPref('font', null);
  if (font && font.size) {
    const idx = FONT_SIZES.findIndex((f) => f.label === font.size);
    if (idx !== -1) state.fontSize = idx;
  }
}

function updateFontDisplay() {
  const entry = FONT_SIZES[state.fontSize];
  document.getElementById('lyric-text').style.fontSize = entry.val;
  document.getElementById('font-size-label').textContent = entry.label;
}

/* ----------------------------------------------------------
   MODE
   ---------------------------------------------------------- */
function setMode(mode, silent = false) {
  state.mode = mode;
  document.getElementById('mode-leader').classList.toggle('active',   mode === 'leader');
  document.getElementById('mode-follower').classList.toggle('active', mode === 'follower');
  document.getElementById('follower-banner').classList.toggle('visible', mode === 'follower');

  if (!silent) {
    saveLocalPrefs();
    showToast(mode === 'leader' ? '🎹 Leader mode active' : '📡 Follower mode — watching leader', 'info');
  }

  syncSessionForCurrentMode();
}

/* ----------------------------------------------------------
   WEB MIDI
   ---------------------------------------------------------- */
async function initMIDI() {
  if (!navigator.requestMIDIAccess) {
    setPillState('midi-pill', 'error', 'No MIDI');
    return;
  }
  try {
    state.midiAccess = await navigator.requestMIDIAccess({ sysex: false });
    setPillState('midi-pill', 'connected', 'MIDI');
    state.midiAccess.inputs.forEach(input => {
      input.onmidimessage = onMIDIMessage;
    });
    state.midiAccess.onstatechange = (e) => {
      if (e.port.type === 'input') {
        if (e.port.state === 'connected') {
          e.port.onmidimessage = onMIDIMessage;
          showToast(`MIDI: ${e.port.name} connected`, 'success');
        }
      }
    };
    showToast('MIDI connected', 'success');
  } catch (err) {
    setPillState('midi-pill', 'error', 'MIDI');
    showToast('MIDI access denied', 'error');
  }
}

function onMIDIMessage(event) {
  const [status, data1, data2] = event.data;
  const type    = status >> 4;
  const channel = status & 0x0f;
  // type 9 = Note On, type 11 = Control Change
  if (type !== 9 && type !== 11) return;
  if (type === 9 && data2 === 0) return; // Note off (velocity 0)

  const key = `${type}:${channel}:${data1}`;

  if (state.midiLearn) {
    // Assign based on learn step
    if (!state.midiNextNote) {
      state.midiNextNote = { type, channel, note: data1, key };
      showToast(`Next Page assigned: ${midiDesc(type, data1)}`, 'success');
      document.getElementById('midi-learn-label').textContent = 'Learning PREV… press a button';
    } else if (!state.midiPrevNote) {
      state.midiPrevNote = { type, channel, note: data1, key };
      showToast(`Prev Page assigned: ${midiDesc(type, data1)}`, 'success');
      state.midiLearn = false;
      document.getElementById('midi-learn-btn').classList.remove('learning');
      document.getElementById('midi-learn-label').textContent = 'MIDI Learn: OFF';
    }
    updateMidiMappingInfo();
    saveLocalPrefs();
    return;
  }

  // Check mappings
  if (state.midiNextNote && key === state.midiNextNote.key) {
    navigate(1);
  } else if (state.midiPrevNote && key === state.midiPrevNote.key) {
    navigate(-1);
  }
}

function midiDesc(type, note) {
  const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  if (type === 9) return `Note: ${names[note % 12]}${Math.floor(note/12)-1}`;
  if (type === 11) return `CC${note}`;
  return `#${note}`;
}

function toggleMidiLearn() {
  if (!state.midiAccess) {
    showToast('MIDI not connected', 'error'); return;
  }
  state.midiLearn = !state.midiLearn;
  const btn = document.getElementById('midi-learn-btn');
  const lbl = document.getElementById('midi-learn-label');
  if (state.midiLearn) {
    // Reset and start fresh
    state.midiNextNote = null;
    state.midiPrevNote = null;
    btn.classList.add('learning');
    lbl.textContent = 'Learning NEXT… press a button';
    showToast('Press the NEXT PAGE button on your controller', 'info');
  } else {
    btn.classList.remove('learning');
    lbl.textContent = 'MIDI Learn: OFF';
  }
  updateMidiMappingInfo();
}

function clearMidiMapping() {
  state.midiNextNote = null;
  state.midiPrevNote = null;
  state.midiLearn    = false;
  document.getElementById('midi-learn-btn').classList.remove('learning');
  document.getElementById('midi-learn-label').textContent = 'MIDI Learn: OFF';
  updateMidiMappingInfo();
  saveLocalPrefs();
  showToast('MIDI mappings cleared', 'info');
}

function updateMidiMappingInfo() {
  document.getElementById('midi-next-map').textContent =
    state.midiNextNote ? midiDesc(state.midiNextNote.type, state.midiNextNote.note) : 'Not assigned';
  document.getElementById('midi-prev-map').textContent =
    state.midiPrevNote ? midiDesc(state.midiPrevNote.type, state.midiPrevNote.note) : 'Not assigned';
}

/* ----------------------------------------------------------
   FIREBASE (modular — services/firebase/*, via window.MLFirebase)
   ----------------------------------------------------------
   app.js is the orchestration layer only: it never touches the
   Firebase SDK directly. Every read/write goes through
   session.js/realtime.js/preference.js, exposed on window.MLFirebase
   by services/firebase/browser-bridge.js.
   ---------------------------------------------------------- */
function isFirebaseConfigured() {
  const cfg = loadFirebaseConfig();
  return !!(cfg && cfg.apiKey && !cfg.apiKey.startsWith('YOUR_'));
}

function loadFirebaseConfig() {
  const saved = localStorage.getItem('mlr_fb_config');
  return saved ? JSON.parse(saved) : null;
}

function loadFirebaseConfigToModal() {
  const cfg = loadFirebaseConfig();
  if (!cfg) return;
  document.getElementById('cfg-apiKey').value      = cfg.apiKey      || '';
  document.getElementById('cfg-authDomain').value  = cfg.authDomain  || '';
  document.getElementById('cfg-databaseURL').value = cfg.databaseURL || '';
  document.getElementById('cfg-projectId').value   = cfg.projectId   || '';
  document.getElementById('cfg-appId').value       = cfg.appId       || '';
}

function saveFirebaseConfig() {
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

function toggleFirebase(on) {
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

/**
 * Guarantees the modular Firebase services are initialized (idempotent —
 * see services/firebase/firebase.js's own singleton guard, so this can
 * never create a duplicate Firebase App instance), then starts session
 * sync for whichever mode (Leader/Follower) this device is currently in.
 */
function ensureFirebaseReady(explicitConfig = null) {
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
async function syncSessionForCurrentMode() {
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

function stopModularSync() {
  teardownSubscriptions();
  if (window.MLFirebase && window.MLFirebase.getActiveSessionId()) {
    window.MLFirebase.leaveSession();
  }
  setPillState('fb-pill', '', 'Sync');
}

function detectPlatform() {
  const ua = navigator.userAgent || '';
  if (/android/i.test(ua)) return 'Android';
  if (/ipad|iphone|ipod/i.test(ua)) return 'iOS';
  if (/mobile/i.test(ua)) return 'Mobile';
  return 'Desktop';
}

/* ---------------- Publish (Leader/Host only — realtime.js self-guards this too) ---------------- */

function publishCurrentSongIfLeader(song) {
  if (state.mode !== 'leader' || !state.fbEnabled) return;
  if (!window.MLFirebase || !window.MLFirebase.getActiveSessionId()) return;
  window.MLFirebase.setCurrentSong(song.id, song.name, song.url || null).catch(() => {});
}

function publishPageIfLeader(pageIndex) {
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
function publishDisplayIfLeader(partial) {
  if (state.mode !== 'leader' || !state.fbEnabled) return;
  if (!window.MLFirebase || !window.MLFirebase.getActiveSessionId()) return;
  if ('theme' in partial)      window.MLFirebase.setSyncedTheme(partial.theme).catch(() => {});
  if ('fontSize' in partial)   window.MLFirebase.setSyncedFontSize(partial.fontSize).catch(() => {});
  if ('fullscreen' in partial) window.MLFirebase.setSyncedFullscreen(partial.fullscreen).catch(() => {});
}

/* ---------------- Play / Pause / Stop (transport, Leader/Host only) ---------------- */

function playSession() {
  state.playing = true;
  updatePlayPauseStopUI();
  if (state.mode === 'leader' && state.fbEnabled && window.MLFirebase && window.MLFirebase.getActiveSessionId()) {
    window.MLFirebase.play().catch(() => {});
  }
}

function pauseSession() {
  state.playing = false;
  updatePlayPauseStopUI();
  if (state.mode === 'leader' && state.fbEnabled && window.MLFirebase && window.MLFirebase.getActiveSessionId()) {
    window.MLFirebase.pause().catch(() => {});
  }
}

function stopSession() {
  state.playing = false;
  updatePlayPauseStopUI();
  if (state.mode === 'leader' && state.fbEnabled && window.MLFirebase && window.MLFirebase.getActiveSessionId()) {
    window.MLFirebase.stop().catch(() => {});
  }
}

function updatePlayPauseStopUI() {
  const playBtn  = document.getElementById('play-btn');
  const pauseBtn = document.getElementById('pause-btn');
  if (playBtn)  playBtn.classList.toggle('active', state.playing);
  if (pauseBtn) pauseBtn.classList.toggle('active', !state.playing);
}

/* ---------------- Subscriptions (Follower + Leader both watch; see role-gating below) ---------------- */

let unsubPlayback = null;
let unsubDisplay  = null;

function ensurePlaybackSubscription() {
  if (unsubPlayback) return; // already subscribed — never register a second listener for the same session
  unsubPlayback = window.MLFirebase.watchPlaybackState(handleIncomingPlaybackState);
}

function ensureDisplaySubscription() {
  if (unsubDisplay) return;
  unsubDisplay = window.MLFirebase.watchDisplayState(handleIncomingDisplayState);
}

function teardownSubscriptions() {
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
async function handleIncomingPlaybackState(data) {
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
        // the Library cache (Phase 9) or fetch it directly.
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
function handleIncomingDisplayState(data) {
  if (!data) return;
  if (window.MLFirebase.canControlPlayback()) return; // ignore echo of our own publish

  if (data.theme) applyThemeToDOM(data.theme);
  if (data.fontSize) applyFontSizeByLabel(data.fontSize);
  if (typeof data.fullscreen === 'boolean') applyFullscreenState(data.fullscreen);
}

/* ----------------------------------------------------------
   SCREEN WAKE LOCK
   ---------------------------------------------------------- */
async function toggleWakeLock() {
  if (state.wakeLockOn) {
    releaseWakeLock();
  } else {
    acquireWakeLock();
  }
}

async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) {
    showToast('Wake Lock not supported on this browser', 'error'); return;
  }
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
    state.wakeLockOn = true;
    document.getElementById('wake-btn').classList.add('active');
    showToast('Screen will stay awake ☀️', 'success');
    state.wakeLock.addEventListener('release', () => {
      state.wakeLockOn = false;
      document.getElementById('wake-btn').classList.remove('active');
    });
  } catch (err) {
    showToast('Wake Lock failed: ' + err.message, 'error');
  }
}

function releaseWakeLock() {
  if (state.wakeLock) {
    state.wakeLock.release();
    state.wakeLock = null;
  }
  state.wakeLockOn = false;
  document.getElementById('wake-btn').classList.remove('active');
  showToast('Screen timeout restored', 'info');
}

// Re-acquire wake lock after visibility change (iOS/Android requirement)
document.addEventListener('visibilitychange', async () => {
  if (state.wakeLockOn && document.visibilityState === 'visible') {
    await acquireWakeLock();
  }
});

/* ----------------------------------------------------------
   DRAWER (MOBILE)
   ---------------------------------------------------------- */
function toggleDrawer() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('drawer-overlay');
  const isOpen  = sidebar.classList.contains('open');
  sidebar.classList.toggle('open', !isOpen);
  overlay.classList.toggle('open', !isOpen);
}

function closeSidebarDrawer() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('drawer-overlay').classList.remove('open');
}

/* ----------------------------------------------------------
   MODAL
   ---------------------------------------------------------- */
function openModal() {
  document.getElementById('modal-overlay').classList.add('open');
}
function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
}
function closeModalOutside(e) {
  if (e.target === document.getElementById('modal-overlay')) closeModal();
}

/* ----------------------------------------------------------
   STATUS PILLS
   ---------------------------------------------------------- */
function setPillState(id, state, label) {
  const pill = document.getElementById(id);
  if (!pill) return;
  pill.className = 'status-pill' + (state ? ' ' + state : '');
  const labelEl = pill.querySelector('.label');
  if (labelEl) labelEl.textContent = label;
}

/* ----------------------------------------------------------
   TOAST
   ---------------------------------------------------------- */
function showToast(msg, type = 'info', duration = 2800) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('out');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

/* ----------------------------------------------------------
   KEYBOARD SHORTCUTS (Desktop)
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

/* ============================================================
   PHASE: UI MODERNIZATION (added on top of the original playback/MIDI
   engine, which remains untouched — see applySongAndRender()/
   renderPage()/navigate()/onMIDIMessage() above. The legacy Firebase
   sync functions that used to be protected here (fbPublish/
   fbStartListening/handleFollowerUpdate) were intentionally removed as
   part of the Complete Migration phase — see docs/IMPLEMENTATION_LOG.md.
   ============================================================ */

/* ----------------------------------------------------------
   THEME (dark / light / stage)
   ---------------------------------------------------------- */
const THEME_ORDER = ['dark', 'light', 'stage'];
const THEME_META = {
  dark:  { icon: '🌙', label: 'Dark'  },
  light: { icon: '☀️', label: 'Light' },
  stage: { icon: '🎤', label: 'Stage' },
};

function initTheme() {
  const saved = getSyncedPref('theme', null);
  setTheme(THEME_ORDER.includes(saved) ? saved : 'dark', true);
}

/** Pure DOM update — no persistence, no publish. Shared by setTheme() (local user action) and the Follower display-mirroring handler. */
function applyThemeToDOM(theme) {
  if (!THEME_ORDER.includes(theme)) return;
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.getElementById('theme-btn');
  if (btn) {
    const meta = THEME_META[theme];
    const icon = btn.querySelector('.theme-icon');
    const label = btn.querySelector('.theme-label');
    if (icon)  icon.textContent  = meta.icon;
    if (label) label.textContent = meta.label;
  }
}

function setTheme(theme, silent = false) {
  if (!THEME_ORDER.includes(theme)) return;
  applyThemeToDOM(theme);
  setSyncedPref('theme', theme);           // this device's own personal preference
  publishDisplayIfLeader({ theme });        // mirror to Follower devices, if Leader
  if (!silent && typeof showToast === 'function') {
    showToast(`${THEME_META[theme].label} theme`, 'info');
  }
}

function cycleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = THEME_ORDER[(THEME_ORDER.indexOf(current) + 1) % THEME_ORDER.length];
  setTheme(next);
}

/* ----------------------------------------------------------
   FULLSCREEN
   ---------------------------------------------------------- */
function toggleFullscreen() {
  const el = document.getElementById('app') || document.documentElement;
  const isFull = document.fullscreenElement || document.webkitFullscreenElement;
  if (!isFull) {
    (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el);
  } else {
    (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
  }
}

/**
 * Follower-side mirroring only, best-effort: most browsers require an
 * actual user gesture (click/tap) to grant requestFullscreen(), so this
 * may silently fail on a Follower device that didn't itself click
 * anything — documented limitation, not a bug (see IMPLEMENTATION_LOG).
 */
function applyFullscreenState(shouldBeFullscreen) {
  const isFull = !!(document.fullscreenElement || document.webkitFullscreenElement);
  if (shouldBeFullscreen === isFull) return;
  const el = document.getElementById('app') || document.documentElement;
  try {
    if (shouldBeFullscreen) {
      (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el);
    } else {
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    }
  } catch { /* likely blocked without a user gesture — ignore */ }
}

function updateFullscreenBtn() {
  const btn = document.getElementById('fullscreen-btn');
  if (!btn) return;
  const isFull = !!(document.fullscreenElement || document.webkitFullscreenElement);
  btn.classList.toggle('active', isFull);
  btn.title = isFull ? 'Exit fullscreen' : 'Enter fullscreen';
}

document.addEventListener('fullscreenchange', updateFullscreenBtn);
document.addEventListener('webkitfullscreenchange', updateFullscreenBtn);

// Separate listener (does not modify the one above): publishes the
// resulting fullscreen state if this device is the Leader — covers
// both the toolbar button AND exiting via the Escape key.
document.addEventListener('fullscreenchange', () => {
  publishDisplayIfLeader({ fullscreen: !!(document.fullscreenElement || document.webkitFullscreenElement) });
});
document.addEventListener('webkitfullscreenchange', () => {
  publishDisplayIfLeader({ fullscreen: !!(document.fullscreenElement || document.webkitFullscreenElement) });
});

/* ----------------------------------------------------------
   COLLAPSIBLE SIDEBAR (desktop / tablet)
   Separate from the existing mobile drawer (toggleDrawer),
   which remains untouched.
   ---------------------------------------------------------- */
function initSidebarCollapse() {
  const sidebarPref = getSyncedPref('sidebar', { collapsed: false });
  const collapsed = !!(sidebarPref && sidebarPref.collapsed);
  document.getElementById('app')?.classList.toggle('sidebar-collapsed', collapsed);
  updateSidebarCollapseBtn(collapsed);
}

function toggleSidebarCollapse() {
  const app = document.getElementById('app');
  if (!app) return;
  const collapsed = !app.classList.contains('sidebar-collapsed');
  app.classList.toggle('sidebar-collapsed', collapsed);
  setSyncedPref('sidebar', { collapsed });
  updateSidebarCollapseBtn(collapsed);
}

function updateSidebarCollapseBtn(collapsed) {
  const btn = document.getElementById('sidebar-collapse-btn');
  if (btn) btn.classList.toggle('active', collapsed);
}

/* ----------------------------------------------------------
   AUTO-FIT LYRICS
   Watches #lyric-text for content changes and resizes it to
   fit its container. Does not call into, or get called by,
   any paging/sync function — purely observational.
   ---------------------------------------------------------- */
let autoFitEnabled = false;
let autoFitRAF = null;
let autoFitResizeDebounce = null;

function initAutoFit() {
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
  window.addEventListener('resize', () => {
    clearTimeout(autoFitResizeDebounce);
    autoFitResizeDebounce = setTimeout(scheduleFit, 120);
  });
}

function toggleAutoFit(on) {
  autoFitEnabled = on;
  setSyncedPref('autoFit', on);
  if (on) {
    fitLyricText();
  } else {
    // Restore manual font size selection
    updateFontDisplay();
  }
}

function fitLyricText() {
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
   ADDITIONAL KEYBOARD SHORTCUTS
   Registered as a separate listener; the original navigation/
   font-size shortcut listener above is untouched.
   ---------------------------------------------------------- */
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'f' || e.key === 'F') { toggleFullscreen(); }
  if (e.key === 't' || e.key === 'T') { cycleTheme(); }
  if (e.key === '[' ) { toggleSidebarCollapse(); }
  if (e.key === 'Escape') {
    const isFull = document.fullscreenElement || document.webkitFullscreenElement;
    if (isFull) toggleFullscreen();
  }
});

/* ----------------------------------------------------------
   INIT (separate DOMContentLoaded listener — additive only)
   ---------------------------------------------------------- */
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initSidebarCollapse();
  initAutoFit();
  updateFullscreenBtn();
  initLibraryUI();
  initFullscreenAutoCollapse();
});

/* ============================================================
   PHASE 9: CLOUD SONG LIBRARY UI
   (Song Library, Favorites, Collections, Playlists, Recent Songs,
   Search, Song Metadata, Auto-save, Lyrics Editor, Import .txt,
   Cloud Lyrics, Better Fullscreen)

   Everything below is additive — it reuses services/firebase/* via
   window.MLFirebase (see services/firebase/browser-bridge.js) and
   reuses the EXISTING loadLyrics(song, text) function unchanged for
   actually displaying a song on stage, so MIDI playback and the
   existing Leader/Follower synchronization are not touched by any of
   this. This is a NEW, parallel way to browse/edit songs stored in
   Firebase — it coexists with, and does not replace, the existing
   GitHub-folder-based setlist (loadSongList/renderSetlist).

   "Playlist" here is the UI-facing name for services/firebase/
   library.js's Setlist functions (ordered song sequences) — the
   backend function names were intentionally left unchanged.
   ============================================================ */

/**
 * QA fix (production readiness review): song/collection/playlist/recent
 * names are user-controlled (typed by any signed-in device, or derived
 * from an imported .txt filename) and were being interpolated directly
 * into innerHTML unescaped below — a maliciously-named entry (e.g. a
 * file literally named "<img src=x onerror=...>.txt") could execute
 * arbitrary script for every device that opens the Library. All
 * dynamic name fields rendered via innerHTML in this section now pass
 * through this escape function first.
 */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str == null ? '' : str);
  return div.innerHTML;
}

let libraryCache = {};
let collectionsCache = {};
let playlistsCache = {};
let librarySearchQuery = '';
let currentEditingSongId = null;
let editorAutosaveTimer = null;
let activeCollectionId = null;
let activePlaylistId = null;
let activePlaylistQueue = null; // { id, name, songIds, index }
let libraryWatchersStarted = false;

function libraryServicesAvailable() {
  return !!(window.MLFirebase && window.MLFirebase.isFirebaseInitialized && window.MLFirebase.isFirebaseInitialized());
}

function initLibraryUI() {
  // Watchers are started lazily, the first time the Library modal is
  // opened (see openLibraryModal) rather than at page load — Firebase
  // may not be configured/enabled yet at DOMContentLoaded time, and
  // there is no reason to hold open Realtime Database listeners for a
  // panel the person hasn't opened.
}

function startLibraryWatchersIfNeeded() {
  if (libraryWatchersStarted || !libraryServicesAvailable()) return;
  libraryWatchersStarted = true;

  window.MLFirebase.watchLibrary((songs) => {
    libraryCache = songs || {};
    renderLibrarySongsList();
    renderRecentList();       // recent-song names may need the library for display
    renderCollectionsList();  // collection song names depend on the library too
    renderPlaylistsList();
  });
  window.MLFirebase.watchCollections((collections) => {
    collectionsCache = collections || {};
    renderCollectionsList();
    if (activeCollectionId) renderCollectionDetail(activeCollectionId);
  });
  window.MLFirebase.watchSetlists((playlists) => {
    playlistsCache = playlists || {};
    renderPlaylistsList();
    if (activePlaylistId) renderPlaylistDetail(activePlaylistId);
  });
}

/* ---------------- Modal open/close ---------------- */

function openLibraryModal() {
  if (!libraryServicesAvailable()) {
    showToast('Configure & enable Firebase sync first to use the Cloud Library', 'error');
    return;
  }
  startLibraryWatchersIfNeeded();
  document.getElementById('library-modal-overlay').classList.add('open');
  switchLibraryTab('songs');
}

function closeLibraryModal() {
  document.getElementById('library-modal-overlay').classList.remove('open');
}

function closeLibraryModalOutside(e) {
  if (e.target.id === 'library-modal-overlay') closeLibraryModal();
}

function switchLibraryTab(tab) {
  document.querySelectorAll('.library-tab').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
  document.querySelectorAll('.library-panel').forEach(el => el.classList.toggle('active', el.id === `library-panel-${tab}`));
  if (tab === 'songs')       renderLibrarySongsList();
  if (tab === 'collections') renderCollectionsList();
  if (tab === 'playlists')   renderPlaylistsList();
  if (tab === 'recent')      renderRecentList();
}

/* ---------------- Songs tab: list, search, favorite, import ---------------- */

function formatTimestamp(ts) {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch { return '—'; }
}

function renderLibrarySongsList() {
  const container = document.getElementById('library-songs-list');
  if (!container) return;

  const results = libraryServicesAvailable()
    ? window.MLFirebase.searchLibrary(librarySearchQuery)
    : [];

  if (!results.length) {
    container.innerHTML = `<div class="library-empty">${librarySearchQuery ? 'No songs match your search.' : 'No songs yet. Import a .txt file to add your first cloud song.'}</div>`;
    return;
  }

  container.innerHTML = '';
  results
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    .forEach((song) => {
      const isFav = libraryServicesAvailable() && window.MLFirebase.isFavorite(song.id);
      const row = document.createElement('div');
      row.className = 'library-row';
      row.innerHTML = `
        <button class="library-fav-btn ${isFav ? 'active' : ''}" title="Toggle favorite">${isFav ? '★' : '☆'}</button>
        <span class="library-row-name" tabindex="0" role="button" aria-label="Open ${escapeHtml(song.name)}">${escapeHtml(song.name)}</span>
        <span class="library-row-meta">${formatTimestamp(song.updatedAt)}</span>
        <div class="library-row-actions">
          <button class="edit-btn">Edit</button>
          <button class="open-btn">Open</button>
        </div>`;
      row.querySelector('.library-fav-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleLibraryFavorite(song.id);
      });
      row.querySelector('.library-row-name').addEventListener('click', () => openSongFromLibrary(song.id));
      row.querySelector('.library-row-name').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSongFromLibrary(song.id); }
      });
      row.querySelector('.open-btn').addEventListener('click', () => openSongFromLibrary(song.id));
      row.querySelector('.edit-btn').addEventListener('click', () => openEditorForSong(song.id));
      container.appendChild(row);
    });
}

function handleLibrarySearch(query) {
  librarySearchQuery = query;
  renderLibrarySongsList();
}

function toggleLibraryFavorite(songId) {
  if (!libraryServicesAvailable()) return;
  window.MLFirebase.toggleFavorite(songId);
  renderLibrarySongsList(); // re-render immediately; PreferenceService already persisted the change
}

function handleImportTxt(inputEl) {
  const file = inputEl.files && inputEl.files[0];
  if (!file) return;
  if (!libraryServicesAvailable()) {
    showToast('Configure & enable Firebase sync first', 'error');
    inputEl.value = '';
    return;
  }
  window.MLFirebase.importLyricsFile(file)
    .then(({ songName }) => {
      showToast(`Imported "${songName}"`, 'success');
      inputEl.value = '';
    })
    .catch((err) => {
      showToast(`Import failed: ${err.message}`, 'error');
      inputEl.value = '';
    });
}

/* ---------------- Opening a cloud song on the main stage ---------------- */

function openSongFromLibrary(songId) {
  const song = libraryCache[songId];
  if (!song) { showToast('Song not found in library', 'error'); return; }

  // Reuses the EXISTING loadLyrics() unchanged — same page-parsing,
  // same rendering, and (as of the Complete Migration phase) the same
  // publishCurrentSongIfLeader() call at the end, via the modular
  // realtime.js — fires exactly as it already does for any other song.
  loadLyrics({ id: songId, name: song.name }, song.text || '');

  if (libraryServicesAvailable()) {
    window.MLFirebase.addRecentSong(songId, song.name);
    window.MLFirebase.setLastSong(songId);
  }
  closeLibraryModal();
}

/* ---------------- Lyrics Editor (with auto-save) ---------------- */

function openEditorForSong(songId) {
  const song = libraryCache[songId];
  if (!song) { showToast('Song not found in library', 'error'); return; }

  currentEditingSongId = songId;
  document.getElementById('editor-song-title').textContent = `Edit — ${song.name}`;
  document.getElementById('editor-textarea').value = song.text || '';
  document.getElementById('editor-meta').textContent =
    `Created: ${formatTimestamp(song.createdAt)}  •  Last updated: ${formatTimestamp(song.updatedAt)}`;
  setEditorSaveStatus('saved', 'Saved');
  document.getElementById('editor-modal-overlay').classList.add('open');
}

function closeEditorModal() {
  document.getElementById('editor-modal-overlay').classList.remove('open');
  currentEditingSongId = null;
  clearTimeout(editorAutosaveTimer);
}

function closeEditorModalOutside(e) {
  if (e.target.id === 'editor-modal-overlay') closeEditorModal();
}

function setEditorSaveStatus(state, label) {
  const el = document.getElementById('editor-save-status');
  if (!el) return;
  el.className = `editor-save-status ${state}`;
  el.textContent = label;
}

function handleEditorInput() {
  if (!currentEditingSongId || !libraryServicesAvailable()) return;
  setEditorSaveStatus('saving', 'Saving…');
  clearTimeout(editorAutosaveTimer);
  editorAutosaveTimer = setTimeout(() => {
    const text = document.getElementById('editor-textarea').value;
    window.MLFirebase.updateLyricsText(currentEditingSongId, text)
      .then(() => setEditorSaveStatus('saved', 'Saved'))
      .catch(() => setEditorSaveStatus('', 'Save failed — will retry on next edit'));
  }, 1200); // debounced auto-save, 1.2s after the last keystroke
}

/* ---------------- Collections ---------------- */

function renderCollectionsList() {
  const container = document.getElementById('library-collections-list');
  if (!container) return;
  const entries = Object.entries(collectionsCache);
  if (!entries.length) {
    container.innerHTML = '<div class="library-empty">No collections yet.</div>';
    return;
  }
  container.innerHTML = '';
  entries.forEach(([id, col]) => {
    const count = col.songIds ? Object.keys(col.songIds).length : 0;
    const row = document.createElement('div');
    row.className = 'library-row';
    row.innerHTML = `
      <span class="library-row-name" style="cursor:pointer;" tabindex="0" role="button" aria-label="Open ${escapeHtml(col.name)}">${escapeHtml(col.name)}</span>
      <span class="library-row-meta">${count} song${count === 1 ? '' : 's'}</span>
      <div class="library-row-actions"><button class="del-btn">Delete</button></div>`;
    row.querySelector('.library-row-name').addEventListener('click', () => openCollectionDetail(id));
    row.querySelector('.library-row-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCollectionDetail(id); }
    });
    row.querySelector('.del-btn').addEventListener('click', () => {
      if (libraryServicesAvailable()) window.MLFirebase.deleteCollection(id);
    });
    container.appendChild(row);
  });
}

function createNewCollection() {
  const input = document.getElementById('new-collection-name');
  const name = input.value.trim();
  if (!name || !libraryServicesAvailable()) return;
  window.MLFirebase.createCollection(name).then(() => { input.value = ''; });
}

function openCollectionDetail(collectionId) {
  activeCollectionId = collectionId;
  document.querySelector('#library-panel-collections .library-toolbar-row').style.display = 'none';
  document.getElementById('library-collections-list').style.display = 'none';
  document.getElementById('collection-detail-view').style.display = 'block';
  renderCollectionDetail(collectionId);
}

function closeCollectionDetail() {
  activeCollectionId = null;
  document.querySelector('#library-panel-collections .library-toolbar-row').style.display = 'flex';
  document.getElementById('library-collections-list').style.display = 'flex';
  document.getElementById('collection-detail-view').style.display = 'none';
}

function renderCollectionDetail(collectionId) {
  const col = collectionsCache[collectionId];
  if (!col) return;
  document.getElementById('collection-detail-title').textContent = col.name;
  const container = document.getElementById('collection-detail-songs');
  const songIds = col.songIds ? Object.keys(col.songIds) : [];

  let html = '';
  songIds.forEach((sid) => {
    const song = libraryCache[sid];
    html += `<div class="library-row"><span class="library-row-name">${escapeHtml(song ? song.name : sid)}</span>
      <div class="library-row-actions"><button data-remove="${sid}">Remove</button></div></div>`;
  });

  const remaining = Object.entries(libraryCache).filter(([sid]) => !songIds.includes(sid));
  html += `<div class="library-toolbar-row" style="margin-top:10px;">
      <select id="collection-add-select" class="library-search">
        <option value="">Add a song…</option>
        ${remaining.map(([sid, s]) => `<option value="${sid}">${escapeHtml(s.name)}</option>`).join('')}
      </select>
      <button class="btn-primary" style="margin:0;" id="collection-add-btn">Add</button>
    </div>`;

  container.innerHTML = html || '<div class="library-empty">No songs in this collection yet.</div>' + html;

  container.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', () => window.MLFirebase.removeSongFromCollection(collectionId, btn.dataset.remove));
  });
  const addBtn = document.getElementById('collection-add-btn');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      const sel = document.getElementById('collection-add-select');
      if (sel.value) window.MLFirebase.addSongToCollection(collectionId, sel.value);
    });
  }
}

/* ---------------- Playlists (UI name for library.js's Setlists) ---------------- */

function renderPlaylistsList() {
  const container = document.getElementById('library-playlists-list');
  if (!container) return;
  const entries = Object.entries(playlistsCache);
  if (!entries.length) {
    container.innerHTML = '<div class="library-empty">No playlists yet.</div>';
    return;
  }
  container.innerHTML = '';
  entries.forEach(([id, pl]) => {
    const count = Array.isArray(pl.songIds) ? pl.songIds.length : 0;
    const row = document.createElement('div');
    row.className = 'library-row';
    row.innerHTML = `
      <span class="library-row-name" style="cursor:pointer;" tabindex="0" role="button" aria-label="Open ${escapeHtml(pl.name)}">${escapeHtml(pl.name)}</span>
      <span class="library-row-meta">${count} song${count === 1 ? '' : 's'}</span>
      <div class="library-row-actions"><button class="del-btn">Delete</button></div>`;
    row.querySelector('.library-row-name').addEventListener('click', () => openPlaylistDetail(id));
    row.querySelector('.library-row-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPlaylistDetail(id); }
    });
    row.querySelector('.del-btn').addEventListener('click', () => {
      if (libraryServicesAvailable()) window.MLFirebase.deleteSetlist(id);
    });
    container.appendChild(row);
  });
}

function createNewPlaylist() {
  const input = document.getElementById('new-playlist-name');
  const name = input.value.trim();
  if (!name || !libraryServicesAvailable()) return;
  window.MLFirebase.createSetlist(name, []).then(() => { input.value = ''; });
}

function openPlaylistDetail(playlistId) {
  activePlaylistId = playlistId;
  document.querySelector('#library-panel-playlists .library-toolbar-row').style.display = 'none';
  document.getElementById('library-playlists-list').style.display = 'none';
  document.getElementById('playlist-detail-view').style.display = 'block';
  renderPlaylistDetail(playlistId);
}

function closePlaylistDetail() {
  activePlaylistId = null;
  document.querySelector('#library-panel-playlists .library-toolbar-row').style.display = 'flex';
  document.getElementById('library-playlists-list').style.display = 'flex';
  document.getElementById('playlist-detail-view').style.display = 'none';
}

function renderPlaylistDetail(playlistId) {
  const pl = playlistsCache[playlistId];
  if (!pl) return;
  document.getElementById('playlist-detail-title').textContent = pl.name;
  const container = document.getElementById('playlist-detail-songs');
  const songIds = Array.isArray(pl.songIds) ? pl.songIds : [];

  let html = '';
  songIds.forEach((sid, i) => {
    const song = libraryCache[sid];
    html += `<div class="library-row">
      <span class="library-row-name">${escapeHtml(song ? song.name : sid)}</span>
      <div class="library-row-actions">
        <button class="reorder-btn" data-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="reorder-btn" data-down="${i}" ${i === songIds.length - 1 ? 'disabled' : ''}>↓</button>
        <button data-remove="${i}">Remove</button>
      </div></div>`;
  });

  const remaining = Object.entries(libraryCache).filter(([sid]) => !songIds.includes(sid));
  html += `<div class="library-toolbar-row" style="margin-top:10px;">
      <select id="playlist-add-select" class="library-search">
        <option value="">Add a song…</option>
        ${remaining.map(([sid, s]) => `<option value="${sid}">${escapeHtml(s.name)}</option>`).join('')}
      </select>
      <button class="btn-primary" style="margin:0;" id="playlist-add-btn">Add</button>
    </div>`;

  container.innerHTML = html || '<div class="library-empty">No songs in this playlist yet.</div>' + html;

  container.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.remove, 10);
      const next = songIds.slice(); next.splice(idx, 1);
      window.MLFirebase.setSetlistSongs(playlistId, next);
    });
  });
  container.querySelectorAll('[data-up]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.up, 10);
      const next = songIds.slice(); [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
      window.MLFirebase.setSetlistSongs(playlistId, next);
    });
  });
  container.querySelectorAll('[data-down]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.down, 10);
      const next = songIds.slice(); [next[idx + 1], next[idx]] = [next[idx], next[idx + 1]];
      window.MLFirebase.setSetlistSongs(playlistId, next);
    });
  });
  const addBtn = document.getElementById('playlist-add-btn');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      const sel = document.getElementById('playlist-add-select');
      if (sel.value) window.MLFirebase.setSetlistSongs(playlistId, [...songIds, sel.value]);
    });
  }
}

/**
 * Starts playing a playlist: opens its first song on stage and shows a
 * small queue bar (Prev/Next within the playlist) in the bottom bar.
 * This is entirely new, separate logic — it does NOT hook into or
 * modify the existing navigate()/renderPage() page-turning functions,
 * which remain page-within-a-song only, exactly as before.
 */
function playCurrentPlaylist() {
  const pl = playlistsCache[activePlaylistId];
  if (!pl || !Array.isArray(pl.songIds) || !pl.songIds.length) {
    showToast('This playlist has no songs yet', 'error');
    return;
  }
  activePlaylistQueue = { id: activePlaylistId, name: pl.name, songIds: pl.songIds, index: 0 };
  closeLibraryModal();
  playQueueIndex(0);
  showPlaylistQueueBar();
}

function playQueueIndex(index) {
  if (!activePlaylistQueue) return;
  const songIds = activePlaylistQueue.songIds;
  if (index < 0 || index >= songIds.length) return;
  activePlaylistQueue.index = index;
  const songId = songIds[index];
  const song = libraryCache[songId];
  if (song) loadLyrics({ id: songId, name: song.name }, song.text || '');
  updatePlaylistQueueBar();
}

function playlistQueueNext() { if (activePlaylistQueue) playQueueIndex(activePlaylistQueue.index + 1); }
function playlistQueuePrev() { if (activePlaylistQueue) playQueueIndex(activePlaylistQueue.index - 1); }

function stopPlaylistQueue() {
  activePlaylistQueue = null;
  const bar = document.getElementById('playlist-queue-bar');
  if (bar) bar.remove();
}

function showPlaylistQueueBar() {
  let bar = document.getElementById('playlist-queue-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'playlist-queue-bar';
    bar.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 24px;border-top:1px solid var(--border);font-size:0.78rem;color:var(--text-secondary);';
    bar.innerHTML = `
      <button class="sm-btn" id="pq-prev" style="width:auto;padding:0 10px;">‹ Prev</button>
      <span id="pq-label" style="flex:1;"></span>
      <button class="sm-btn" id="pq-next" style="width:auto;padding:0 10px;">Next ›</button>
      <button class="sm-btn" id="pq-close" style="width:auto;padding:0 10px;">✕</button>`;
    document.getElementById('bottom-bar').appendChild(bar);
    bar.querySelector('#pq-prev').addEventListener('click', playlistQueuePrev);
    bar.querySelector('#pq-next').addEventListener('click', playlistQueueNext);
    bar.querySelector('#pq-close').addEventListener('click', stopPlaylistQueue);
  }
  updatePlaylistQueueBar();
}

function updatePlaylistQueueBar() {
  const label = document.getElementById('pq-label');
  if (!label || !activePlaylistQueue) return;
  label.textContent = `Playlist: ${activePlaylistQueue.name} (${activePlaylistQueue.index + 1}/${activePlaylistQueue.songIds.length})`;
  const prevBtn = document.getElementById('pq-prev');
  const nextBtn = document.getElementById('pq-next');
  if (prevBtn) prevBtn.disabled = activePlaylistQueue.index === 0;
  if (nextBtn) nextBtn.disabled = activePlaylistQueue.index === activePlaylistQueue.songIds.length - 1;
}

/* ---------------- Recent Songs tab ---------------- */

function renderRecentList() {
  const container = document.getElementById('library-recent-list');
  if (!container) return;
  const recents = libraryServicesAvailable() ? window.MLFirebase.getRecentSongs() : [];
  if (!recents.length) {
    container.innerHTML = '<div class="library-empty">No recently opened songs yet.</div>';
    return;
  }
  container.innerHTML = '';
  recents.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'library-row';
    row.innerHTML = `<span class="library-row-name" style="cursor:pointer;" tabindex="0" role="button" aria-label="Open ${escapeHtml(r.name)}">${escapeHtml(r.name)}</span>
      <span class="library-row-meta">${formatTimestamp(r.openedAt)}</span>`;
    row.querySelector('.library-row-name').addEventListener('click', () => openSongFromLibrary(r.songId));
    row.querySelector('.library-row-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSongFromLibrary(r.songId); }
    });
    container.appendChild(row);
  });
}

/* ---------------- Better Fullscreen ----------------
   Auto-collapses the sidebar on entering fullscreen (maximizing the
   lyrics viewer for stage use) and restores its prior state on exit.
   Registered as a SEPARATE fullscreenchange listener from the existing
   updateFullscreenBtn one — does not modify that listener or function.
   ---------------------------------------------------------------- */
let preFullscreenSidebarCollapsed = null;

function initFullscreenAutoCollapse() {
  const handler = () => {
    const isFull = !!(document.fullscreenElement || document.webkitFullscreenElement);
    const app = document.getElementById('app');
    if (!app) return;

    if (isFull) {
      preFullscreenSidebarCollapsed = app.classList.contains('sidebar-collapsed');
      if (!preFullscreenSidebarCollapsed) {
        app.classList.add('sidebar-collapsed');
        updateSidebarCollapseBtn(true);
      }
    } else if (preFullscreenSidebarCollapsed !== null) {
      if (!preFullscreenSidebarCollapsed) {
        app.classList.remove('sidebar-collapsed');
        updateSidebarCollapseBtn(false);
      }
      preFullscreenSidebarCollapsed = null;
    }
  };
  document.addEventListener('fullscreenchange', handler);
  document.addEventListener('webkitfullscreenchange', handler);
}
