/**
 * services/ui/sidebar.js
 *
 * Local (GitHub-folder-based) song loading, setlist rendering, song
 * selection, and Leader/Follower mode switching. Extracted from app.js
 * during the repository restructuring; logic unchanged from the
 * original. This remains the app's primary, zero-setup song source —
 * it coexists with, and is independent of, the Cloud Song Library
 * (see ui/dialogs.js / services/library/library.js).
 */
import { state, loadLyrics } from './viewer.js';
import { formatSongName } from '../library/metadata.js';
import { showToast } from '../utils/helpers.js';
import { saveLocalPrefs } from '../utils/storage.js';
import { syncSessionForCurrentMode } from './settings.js';

/* ----------------------------------------------------------
   SONG LOADING — GitHub Pages / local fetch
   ---------------------------------------------------------- */
export async function loadSongList() {
  const container = document.getElementById('setlist-container');
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

export function detectGitHubRepo() {
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

export async function fetchSongsFromGitHubAPI({ owner, repo }) {
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

export async function fetchSongsFromManifest() {
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

export async function fetchSongsFromDirectory() {
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

export function renderSetlist(songs) {
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

export async function selectSong(song) {
  document.querySelectorAll('.song-item').forEach(el => el.classList.remove('active'));
  const el = document.querySelector(`.song-item[data-id="${song.id}"]`);
  if (el) el.classList.add('active');

  try {
    const res  = await fetch(song.url);
    if (!res.ok) throw new Error('Failed to load lyrics');
    const text = await res.text();
    loadLyrics(song, text);
  } catch (err) {
    showToast(`Failed to load "${song.name}"`, 'error');
  }
}

/* ----------------------------------------------------------
   MODE (Leader / Follower)
   ---------------------------------------------------------- */
export function setMode(mode, silent = false) {
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
