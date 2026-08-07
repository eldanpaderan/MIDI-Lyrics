/**
 * services/ui/dialogs.js
 *
 * Cloud Song Library modal (Songs/Collections/Playlists/Recent tabs)
 * and the Lyrics Editor (with auto-save). Extracted from app.js during
 * the repository restructuring; logic unchanged from the original. This
 * is a NEW, parallel way to browse/edit songs stored in Firebase — it
 * coexists with, and does not replace, the existing GitHub-folder-based
 * setlist (see ui/sidebar.js).
 *
 * "Playlist" here is the UI-facing name for services/library/library.js's
 * Setlist functions (ordered song sequences) — the backend function
 * names were intentionally left unchanged.
 *
 * `libraryCache` is exported (a live `let` binding) because
 * ui/settings.js's handleIncomingPlaybackState() needs to resolve a
 * Follower-received Cloud Library song by ID without a local URL.
 */
import { state, loadLyrics } from './viewer.js';
import { showToast, escapeHtml } from '../utils/helpers.js';
import { formatTimestamp } from '../library/metadata.js';
import { debounce } from '../utils/debounce.js';

export let libraryCache = {};
let collectionsCache = {};
let playlistsCache = {};
let librarySearchQuery = '';
let currentEditingSongId = null;
let activeCollectionId = null;
let activePlaylistId = null;
let activePlaylistQueue = null; // { id, name, songIds, index }
let libraryWatchersStarted = false;

export function libraryServicesAvailable() {
  return !!(window.MLFirebase && window.MLFirebase.isFirebaseInitialized && window.MLFirebase.isFirebaseInitialized());
}

export function initLibraryUI() {
  // Watchers are started lazily, the first time the Library modal is
  // opened (see openLibraryModal) rather than at page load — Firebase
  // may not be configured/enabled yet at DOMContentLoaded time, and
  // there is no reason to hold open Realtime Database listeners for a
  // panel the person hasn't opened.

  // Keep the Songs tab's offline note in sync if the connection drops
  // (or returns) while the Library modal happens to be open.
  window.addEventListener('online',  () => renderLibrarySongsList());
  window.addEventListener('offline', () => renderLibrarySongsList());
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

export function openLibraryModal() {
  if (!libraryServicesAvailable()) {
    showToast('Configure & enable Firebase sync first to use the Cloud Library', 'error');
    return;
  }
  startLibraryWatchersIfNeeded();
  document.getElementById('library-modal-overlay').classList.add('open');
  switchLibraryTab('songs');
}

export function closeLibraryModal() {
  document.getElementById('library-modal-overlay').classList.remove('open');
}

export function closeLibraryModalOutside(e) {
  if (e.target.id === 'library-modal-overlay') closeLibraryModal();
}

export function switchLibraryTab(tab) {
  document.querySelectorAll('.library-tab').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
  document.querySelectorAll('.library-panel').forEach(el => el.classList.toggle('active', el.id === `library-panel-${tab}`));
  if (tab === 'songs')       renderLibrarySongsList();
  if (tab === 'collections') renderCollectionsList();
  if (tab === 'playlists')   renderPlaylistsList();
  if (tab === 'recent')      renderRecentList();
}

/* ---------------- Songs tab: list, search, favorite, import ---------------- */

/**
 * Shows/hides the "you're offline, import is disabled, browsing cached
 * songs still works" note above the Songs list. Uploading a new song
 * needs to reach Firebase (see library.js's addOrUpdateSong()), so
 * importing is disabled while offline — but the already-cached song list
 * (services/library/library.js's on-disk cache) still renders normally,
 * satisfying "continue working normally" while offline.
 */
function updateLibraryOfflineNote() {
  const note = document.getElementById('library-import-status');
  const importRow = document.getElementById('library-import-row');
  if (!note || !importRow) return;
  const offline = !navigator.onLine;
  importRow.querySelectorAll('input, label').forEach((el) => el.classList.toggle('disabled-offline', offline));
  if (offline) {
    note.textContent = 'You\u2019re offline — showing cached songs. Importing new songs needs a connection.';
    note.style.display = 'block';
  } else {
    note.style.display = 'none';
  }
}

export function renderLibrarySongsList() {
  const container = document.getElementById('library-songs-list');
  if (!container) return;
  updateLibraryOfflineNote();

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
      const subParts = [song.artist, song.category].filter(Boolean).map(escapeHtml);
      const row = document.createElement('div');
      row.className = 'library-row';
      row.innerHTML = `
        <button class="library-fav-btn ${isFav ? 'active' : ''}" title="Toggle favorite">${isFav ? '★' : '☆'}</button>
        <span class="library-row-name" tabindex="0" role="button" aria-label="Open ${escapeHtml(song.name)}">
          <span class="library-row-title">${escapeHtml(song.name)}</span>
          ${subParts.length ? `<span class="library-row-sub">${subParts.join(' · ')}</span>` : ''}
        </span>
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

export function handleLibrarySearch(query) {
  librarySearchQuery = query;
  renderLibrarySongsList();
}

export function toggleLibraryFavorite(songId) {
  if (!libraryServicesAvailable()) return;
  window.MLFirebase.toggleFavorite(songId);
  renderLibrarySongsList(); // re-render immediately; PreferenceService already persisted the change
}

export function handleImportTxt(inputEl) {
  const file = inputEl.files && inputEl.files[0];
  if (!file) return;
  if (!libraryServicesAvailable()) {
    showToast('Configure & enable Firebase sync first', 'error');
    inputEl.value = '';
    return;
  }

  const artistEl   = document.getElementById('library-import-artist');
  const categoryEl = document.getElementById('library-import-category');
  const meta = {
    artist:   artistEl   ? artistEl.value.trim()   : '',
    category: categoryEl ? categoryEl.value.trim() : '',
  };

  window.MLFirebase.importLyricsFile(file, undefined, meta)
    .then(({ songName }) => {
      showToast(`Imported "${songName}" — synced to the cloud library`, 'success');
      inputEl.value = '';
      if (artistEl)   artistEl.value   = '';
      if (categoryEl) categoryEl.value = '';
    })
    .catch((err) => {
      showToast(`Import failed: ${err.message}`, 'error');
      inputEl.value = '';
    });
}

/* ---------------- Opening a cloud song on the main stage ---------------- */

export function openSongFromLibrary(songId) {
  const song = libraryCache[songId];
  if (!song) { showToast('Song not found in library', 'error'); return; }

  // Reuses the EXISTING loadLyrics() unchanged — same page-parsing,
  // same rendering, and the same publishCurrentSongIfLeader() call at
  // the end, via the modular realtime.js — fires exactly as it already
  // does for any other song.
  loadLyrics({ id: songId, name: song.name }, song.text || '');

  if (libraryServicesAvailable()) {
    window.MLFirebase.addRecentSong(songId, song.name);
    window.MLFirebase.setLastSong(songId);
  }
  closeLibraryModal();
}

/* ---------------- Lyrics Editor (with auto-save) ---------------- */

export function openEditorForSong(songId) {
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

export function closeEditorModal() {
  document.getElementById('editor-modal-overlay').classList.remove('open');
  currentEditingSongId = null;
}

/** Used by the Editor's "Open on Stage" button — avoids needing the
 * inline HTML handler to reference the internal currentEditingSongId
 * variable directly (which is module-scoped, not global, now that this
 * code lives in an ES module). */
export function openEditingSongOnStage() {
  if (currentEditingSongId) openSongFromLibrary(currentEditingSongId);
  closeEditorModal();
}

export function closeEditorModalOutside(e) {
  if (e.target.id === 'editor-modal-overlay') closeEditorModal();
}

function setEditorSaveStatus(saveState, label) {
  const el = document.getElementById('editor-save-status');
  if (!el) return;
  el.className = `editor-save-status ${saveState}`;
  el.textContent = label;
}

// Debounced auto-save (1.2s after the last keystroke), using the
// generic debounce() utility instead of an ad-hoc setTimeout/clearTimeout
// + module variable.
const debouncedSaveEditorText = debounce(() => {
  const text = document.getElementById('editor-textarea').value;
  window.MLFirebase.updateLyricsText(currentEditingSongId, text)
    .then(() => setEditorSaveStatus('saved', 'Saved'))
    .catch(() => setEditorSaveStatus('', 'Save failed — will retry on next edit'));
}, 1200);

export function handleEditorInput() {
  if (!currentEditingSongId || !libraryServicesAvailable()) return;
  setEditorSaveStatus('saving', 'Saving…');
  debouncedSaveEditorText();
}

/* ---------------- Collections ---------------- */

export function renderCollectionsList() {
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

export function createNewCollection() {
  const input = document.getElementById('new-collection-name');
  const name = input.value.trim();
  if (!name || !libraryServicesAvailable()) return;
  window.MLFirebase.createCollection(name).then(() => { input.value = ''; });
}

export function openCollectionDetail(collectionId) {
  activeCollectionId = collectionId;
  document.querySelector('#library-panel-collections .library-toolbar-row').style.display = 'none';
  document.getElementById('library-collections-list').style.display = 'none';
  document.getElementById('collection-detail-view').style.display = 'block';
  renderCollectionDetail(collectionId);
}

export function closeCollectionDetail() {
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

export function renderPlaylistsList() {
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

export function createNewPlaylist() {
  const input = document.getElementById('new-playlist-name');
  const name = input.value.trim();
  if (!name || !libraryServicesAvailable()) return;
  window.MLFirebase.createSetlist(name, []).then(() => { input.value = ''; });
}

export function openPlaylistDetail(playlistId) {
  activePlaylistId = playlistId;
  document.querySelector('#library-panel-playlists .library-toolbar-row').style.display = 'none';
  document.getElementById('library-playlists-list').style.display = 'none';
  document.getElementById('playlist-detail-view').style.display = 'block';
  renderPlaylistDetail(playlistId);
}

export function closePlaylistDetail() {
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
 * This is entirely separate logic — it does NOT hook into or modify
 * viewer.js's navigate()/renderPage() page-turning functions, which
 * remain page-within-a-song only, exactly as before.
 */
export function playCurrentPlaylist() {
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

export function playlistQueueNext() { if (activePlaylistQueue) playQueueIndex(activePlaylistQueue.index + 1); }
export function playlistQueuePrev() { if (activePlaylistQueue) playQueueIndex(activePlaylistQueue.index - 1); }

/** Read-only accessor for the active Playlist queue ({id, name, songIds, index}) or null — used by ui/song-nav.js's Prev/Next Song toolbar buttons to walk a playing playlist instead of the general setlist/library list. */
export function getActivePlaylistQueue() { return activePlaylistQueue; }

export function stopPlaylistQueue() {
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

export function renderRecentList() {
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
