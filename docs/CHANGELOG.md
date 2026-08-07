# Changelog

All notable changes to this project are documented here. For detailed, phase-by-phase engineering rationale, see `IMPLEMENTATION_LOG.md`.

## [1.1.0] — 2026-08-07

### Added
- **Song-level transport** — the bottom toolbar's Play/Pause/Stop buttons (session-status only; they never actually played audio) are replaced with **Previous Song** / **Next Song**, positioned around the existing Prev/Next Page buttons: `[Prev Song][Prev Page][Next Page][Next Song]`. Implemented in the new `services/ui/song-nav.js`, which walks the active Playlist queue if one is playing, otherwise the local GitHub-folder setlist or the Cloud Library (A→Z) — whichever the current song belongs to. Reuses the existing song-loading entry points (`selectSong()`, `openSongFromLibrary()`), so a Leader's song change is picked up by Followers exactly the way it already was for any other song change; no new sync code was needed.
- **Song Database schema** — Cloud Library songs now also store `title`, `artist`, `category`, `lyrics`, and a pre-computed `pages` array (in addition to the existing `name`/`text`, which remain the fields read throughout the app). The `.txt` import dialog gained optional Artist/Category fields; both are shown under the song title in the Songs tab and are searchable.
- **Offline Support** — the Cloud Library's Firebase snapshot is now mirrored to `localStorage` on every update and re-seeded from disk on load, so the Songs list still renders while offline (including right after a page reload). The currently displayed song is separately cached and auto-restored at startup if the device is offline. A new **Online/Offline** status pill in the bottom bar and toast notifications reflect connectivity changes; the `.txt` import control disables itself (with an inline note) while offline, since writing a new song still requires reaching Firebase. Reconnection sync is automatic — the Firebase Realtime Database SDK already re-fires its `.on('value')` listeners once connectivity returns, so no manual re-sync logic was required.

### Unchanged (by design)
Firebase Authentication, the existing Leader/Follower Realtime Database sync protocol, session/presence handling, the overall modular architecture, and the visual theme were left exactly as they were.

## [1.0.0] — 2026-07-25

### Added
- **UI Modernization** — responsive layout for Android/iPad/Laptop/Desktop, modern toolbar, Dark/Light/Stage themes, fullscreen mode, collapsible sidebar, bottom playback status bar, resizable and auto-fit lyrics, refined page-transition animation.
- **Firebase Services Layer** — a modular `services/firebase/` system (native ES modules, no build step) covering:
  - Singleton Firebase initialization
  - Anonymous Authentication
  - Session-based realtime sync with 4 roles (Host, Admin, Presenter, Viewer)
  - PreferenceService (theme, font, sidebar, layout, playback speed, favorites, recent songs, last-opened song/setlist)
  - Song Library (persistent songs, Collections, Playlists)
- **Song Library UI** — Songs/Collections/Playlists/Recent tabs, live search, favorites, `.txt` import, an in-app Lyrics Editor with auto-save, and a Playlist queue bar for sequential playback.
- **Synchronization reliability** — heartbeat-based presence, session expiration (12h of inactivity), automatic host migration on disconnect, write throttling, loop prevention, diffed writes, and multi-path updates to reduce Firebase read/write volume and latency.
- **Documentation** — `ARCHITECTURE.md`, `FIREBASE_SETUP.md`, `USER_GUIDE.md`, and this changelog.

### Fixed
- Firebase initialization no longer crashes if the legacy sync system has already connected a named app.
- Synchronization diff caches now reset correctly when switching sessions, preventing stale state from suppressing genuine updates.
- Favorites and Recent Songs now correctly sync across signed-in devices (previously write-only).
- Fixed a stored-XSS vulnerability in the Song Library UI: song/collection/playlist names are now HTML-escaped before rendering.
- Song Library rows are now keyboard-accessible (tab/Enter/Space), not mouse-only.
- Removed a race condition in cloud song saves by switching to an atomic Firebase transaction.
- Removed an orphaned presence cleanup that could fire against the wrong session when switching sessions without explicitly leaving the previous one.

### Known Limitations
See the Release Report and `ARCHITECTURE.md` for the full list — most notably: the legacy (v0) Firebase/session system and the new Firebase services layer currently coexist rather than being fully unified, and Realtime Database security rules are not yet shipped in this repository (see `FIREBASE_SETUP.md` for a recommended starting rule set).

## [0.x] — Pre-1.0 (Original)

The original single-file MIDI Lyrics Reader: Web MIDI–based page-turning ("MIDI Learn"), a GitHub-folder-based local setlist, basic Leader/Follower sync over a single fixed Firebase Realtime Database path, wake lock, and responsive touch/keyboard navigation.
