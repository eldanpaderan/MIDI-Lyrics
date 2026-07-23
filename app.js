'use strict';

/* ----------------------------------------------------------
   CONFIG PLACEHOLDER — replace with your Firebase credentials
   or use the UI modal to set them at runtime.
   ---------------------------------------------------------- */
const DEFAULT_FIREBASE_CONFIG = {
  apiKey:            "YOUR_API_KEY",
  authDomain:        "YOUR_PROJECT.firebaseapp.com",
  databaseURL:       "https://YOUR_PROJECT-default-rtdb.firebaseio.com",
  projectId:         "YOUR_PROJECT_ID",
  storageBucket:     "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId:             "YOUR_APP_ID"
};

const FIREBASE_DB_PATH = "session/currentStatus";

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
  fbEnabled:    false,
  fbApp:        null,
  fbDb:         null,
  fbListener:   null,
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
    connectFirebase();
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

  renderPage(0, 'instant');
  renderPips();
  updateNavButtons();
  fbPublish();
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
  fbPublish();
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
    pip.addEventListener('click', () => { if (state.mode !== 'follower') { renderPage(i); fbPublish(); } });
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

  if (mode === 'follower' && state.fbEnabled) {
    fbStartListening();
  } else {
    fbStopListening();
  }
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
   FIREBASE
   ---------------------------------------------------------- */
function isFirebaseConfigured() {
  const cfg = loadFirebaseConfig();
  return cfg && cfg.apiKey && !cfg.apiKey.startsWith('YOUR_');
}

function loadFirebaseConfig() {
  const saved = localStorage.getItem('mlr_fb_config');
  if (saved) return JSON.parse(saved);
  return DEFAULT_FIREBASE_CONFIG;
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
  // Reconnect if toggle is on
  if (state.fbEnabled) {
    disconnectFirebase();
    connectFirebase();
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
    connectFirebase();
  } else {
    disconnectFirebase();
  }
}

function connectFirebase() {
  try {
    const cfg = loadFirebaseConfig();
    // Destroy existing app if any
    if (state.fbApp) {
      state.fbApp.delete().catch(() => {});
    }
    state.fbApp = firebase.initializeApp(cfg, 'mlr-' + Date.now());
    state.fbDb  = firebase.database(state.fbApp);
    setPillState('fb-pill', 'connected', 'Sync');
    showToast('Firebase connected', 'success');
    if (state.mode === 'follower') fbStartListening();
  } catch (err) {
    setPillState('fb-pill', 'error', 'Sync');
    showToast('Firebase error: ' + err.message, 'error');
    console.error('Firebase:', err);
  }
}

function disconnectFirebase() {
  fbStopListening();
  if (state.fbApp) {
    state.fbApp.delete().catch(() => {});
    state.fbApp = null;
    state.fbDb  = null;
  }
  setPillState('fb-pill', '', 'Sync');
}

function fbPublish() {
  if (!state.fbEnabled || !state.fbDb || state.mode !== 'leader') return;
  if (!state.activeSong) return;
  const ref = state.fbDb.ref(FIREBASE_DB_PATH);
  ref.set({
    songId:    state.activeSong.id,
    songName:  state.activeSong.name,
    songUrl:   state.activeSong.url,
    pageIndex: state.currentPage,
    ts:        Date.now(),
  });
}

function fbStartListening() {
  if (!state.fbDb) return;
  fbStopListening();
  const ref = state.fbDb.ref(FIREBASE_DB_PATH);
  state.fbListener = ref.on('value', (snapshot) => {
    const data = snapshot.val();
    if (!data) return;
    setPillState('fb-pill', 'syncing', 'Sync');
    handleFollowerUpdate(data);
    setTimeout(() => setPillState('fb-pill', 'connected', 'Sync'), 800);
  });
}

function fbStopListening() {
  if (state.fbDb && state.fbListener) {
    state.fbDb.ref(FIREBASE_DB_PATH).off('value', state.fbListener);
    state.fbListener = null;
  }
}

async function handleFollowerUpdate(data) {
  const { songId, songName, songUrl, pageIndex } = data;

  // If different song, load it
  if (!state.activeSong || state.activeSong.id !== songId) {
    const song = { id: songId, name: songName, url: songUrl };
    try {
      const res  = await fetch(song.url);
      if (!res.ok) throw new Error('Fetch failed');
      const text = await res.text();
      // Load without publishing back
      state.activeSong  = song;
      state.currentPage = 0;
      if (text.includes('[PAGE]')) {
        state.pages = text.split(/\[PAGE\]/i).map(c=>c.trim()).filter(Boolean);
      } else {
        let chunks = text.split(/\n\s*\n\s*\n/);
        if (chunks.length < 2) chunks = text.split(/\n\n/);
        state.pages = chunks.map(c=>c.trim()).filter(Boolean);
      }
      if (!state.pages.length) state.pages = [text.trim()];
      document.getElementById('song-title-display').textContent = song.name;
      document.getElementById('empty-state').style.display   = 'none';
      document.getElementById('lyric-display').style.display = 'flex';
      document.querySelectorAll('.song-item').forEach(el => {
        el.classList.toggle('active', el.dataset.id === songId);
      });
      renderPips();
    } catch {}
  }

  // Navigate to page
  if (typeof pageIndex === 'number' && state.pages.length > pageIndex && state.currentPage !== pageIndex) {
    renderPage(pageIndex);
  }
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
   PHASE: UI MODERNIZATION (added — does not modify any logic
   above this line: playback, MIDI, and Firebase sync functions
   are untouched byte-for-byte).
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

function setTheme(theme, silent = false) {
  if (!THEME_ORDER.includes(theme)) return;
  document.documentElement.setAttribute('data-theme', theme);
  setSyncedPref('theme', theme);
  const btn = document.getElementById('theme-btn');
  if (btn) {
    const meta = THEME_META[theme];
    const icon = btn.querySelector('.theme-icon');
    const label = btn.querySelector('.theme-label');
    if (icon)  icon.textContent  = meta.icon;
    if (label) label.textContent = meta.label;
  }
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

function updateFullscreenBtn() {
  const btn = document.getElementById('fullscreen-btn');
  if (!btn) return;
  const isFull = !!(document.fullscreenElement || document.webkitFullscreenElement);
  btn.classList.toggle('active', isFull);
  btn.title = isFull ? 'Exit fullscreen' : 'Enter fullscreen';
}

document.addEventListener('fullscreenchange', updateFullscreenBtn);
document.addEventListener('webkitfullscreenchange', updateFullscreenBtn);

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
});
