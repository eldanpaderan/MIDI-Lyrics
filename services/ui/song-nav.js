/**
 * services/ui/song-nav.js
 *
 * Previous Song / Next Song — bottom toolbar transport for moving
 * between whole songs (as opposed to viewer.js's navigate(), which pages
 * within the CURRENT song). Added to replace the removed Play/Pause/Stop
 * buttons.
 *
 * Deliberately reuses the app's EXISTING song-loading entry points
 * instead of introducing a new one:
 *   - sidebar.js's selectSong()        for the GitHub-folder setlist
 *   - dialogs.js's openSongFromLibrary() for the Cloud Song Library
 *   - dialogs.js's playlistQueueNext()/Prev() when a Playlist is queued
 * Every one of those already ends in loadLyrics()/applySongAndRender(),
 * which already calls publishCurrentSongIfLeader() — so "Leader changes
 * song -> Followers automatically load the same song" requires no new
 * sync code here at all; it already exists (services/ui/settings.js's
 * handleIncomingPlaybackState()).
 *
 * NOTE ON CIRCULAR IMPORTS: this file, viewer.js, sidebar.js and
 * dialogs.js form a import cycle (viewer.js calls updateSongNavButtons()
 * from applySongAndRender() so the Prev/Next Song buttons' disabled
 * state stays correct after EVERY song change, from whatever source).
 * Safe under ES Module semantics for the same reason documented in
 * utils/storage.js and ui/settings.js: every one of these imports is
 * only ever invoked from inside a function body, never at module
 * top-level evaluation time.
 */
import { state } from './viewer.js';
import { selectSong } from './sidebar.js';
import { libraryCache, openSongFromLibrary, playlistQueueNext, playlistQueuePrev, getActivePlaylistQueue } from './dialogs.js';
import { showToast } from '../utils/helpers.js';

/**
 * Figures out which ordered list of songs "Previous/Next Song" should
 * move through, based on where the currently active song came from:
 *   - if it's one of the local GitHub-folder setlist songs -> that list
 *   - else if it's a Cloud Library song -> the full library, A→Z
 *   - if nothing is loaded yet -> prefer the local setlist, then Library
 */
function getActiveSongList() {
  if (state.activeSong && state.songs.some((s) => s.id === state.activeSong.id)) {
    return { list: state.songs, type: 'local' };
  }
  if (state.activeSong && libraryCache[state.activeSong.id]) {
    return { list: sortedLibraryList(), type: 'library' };
  }
  if (state.songs.length) return { list: state.songs, type: 'local' };
  const libList = sortedLibraryList();
  if (libList.length) return { list: libList, type: 'library' };
  return { list: [], type: null };
}

function sortedLibraryList() {
  return Object.entries(libraryCache)
    .map(([id, song]) => ({ id, name: song.name }))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

/**
 * @param {1 | -1} dir
 */
export function navigateSong(dir) {
  if (state.mode === 'follower') {
    showToast('Follower mode — song is controlled by the Leader', 'info');
    return;
  }

  // A Playlist queue (dialogs.js) takes priority when active — Prev/Next
  // Song then walks the playlist's ordered songIds instead of the
  // general setlist/library list.
  if (getActivePlaylistQueue()) {
    if (dir > 0) playlistQueueNext(); else playlistQueuePrev();
    updateSongNavButtons();
    return;
  }

  const { list, type } = getActiveSongList();
  if (!list.length) {
    showToast('No songs available to navigate', 'error');
    return;
  }

  const index = state.activeSong ? list.findIndex((s) => s.id === state.activeSong.id) : -1;
  const next = index === -1 ? (dir > 0 ? 0 : -1) : index + dir;
  if (next < 0 || next >= list.length) return; // already at the first/last song

  if (type === 'local') {
    selectSong(list[next]);
  } else {
    openSongFromLibrary(list[next].id);
  }
  // selectSong()/openSongFromLibrary() both end in applySongAndRender(),
  // which already calls updateSongNavButtons() — no need to call it again here.
}

/** Keeps the Prev/Next Song buttons' disabled state in sync with the current song + mode. Called from viewer.js's applySongAndRender() after every song change (local, Cloud Library, or Follower-received). */
export function updateSongNavButtons() {
  const prevBtn = document.getElementById('prev-song-btn');
  const nextBtn = document.getElementById('next-song-btn');
  if (!prevBtn || !nextBtn) return;

  const disabledForFollower = state.mode === 'follower';

  const queue = getActivePlaylistQueue();
  if (queue) {
    prevBtn.disabled = disabledForFollower || queue.index <= 0;
    nextBtn.disabled = disabledForFollower || queue.index >= queue.songIds.length - 1;
    return;
  }

  const { list } = getActiveSongList();
  const index = state.activeSong ? list.findIndex((s) => s.id === state.activeSong.id) : -1;
  prevBtn.disabled = disabledForFollower || index <= 0;
  nextBtn.disabled = disabledForFollower || !list.length || (index !== -1 && index >= list.length - 1);
}
