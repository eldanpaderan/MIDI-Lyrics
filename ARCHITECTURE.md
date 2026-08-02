# Architecture — MIDI Lyrics Reader (v1.0)

## Overview

This is a **zero-build, vanilla JavaScript** web application, deployed as static files on GitHub Pages. There is no bundler, no framework, and no transpilation step — every file runs exactly as written in the browser.

The codebase is made of two systems that intentionally coexist in v1.0:

| | Legacy System (v0, original) | Cloud System (v1.0, new) |
|---|---|---|
| Location | `app.js` (classic `<script>`) | `services/firebase/*.js` (native ES modules) |
| Song source | `songs/` folder, read via the GitHub API | Firebase Realtime Database (`library/songs`) |
| Sync model | Single hardcoded path, Leader/Follower | Session ID–based, 4 roles (Host/Admin/Presenter/Viewer) |
| Reachable from UI? | Yes — the sidebar setlist, mode toggle, Firebase config modal | Partially — the Song Library modal (Songs/Collections/Playlists/Recent) is fully wired; session creation/joining/role management is service-layer only, not yet exposed in the UI |

Both systems are fully functional independently and do not interfere with each other. Retiring the legacy system is a deliberate, not-yet-taken step — see [Known Limitations](#known-limitations-summary) below and `IMPLEMENTATION_LOG.md` for the full reasoning.

## Folder Structure (as of the repository restructuring)

```
index.html                  — markup + all <script>/<link> tags
app.js                       — thin ES-module entry point/orchestrator only
                                (imports everything, exposes onclick=-referenced
                                functions on window, runs the init sequence)
styles.css                   — all styling (CSS custom properties for theming)
songs/                       — legacy .txt lyric files (GitHub-folder song source)
.nojekyll                    — bypasses GitHub Pages' default Jekyll build
services/
  firebase/
    firebase.js                — singleton Firebase App initializer
    auth.js                     — Firebase Authentication (anonymous sign-in)
    session.js                  — session lifecycle, roles, presence, heartbeat,
                                   expiration, host migration
    realtime.js                 — playback/display state sync, throttling,
                                   loop prevention, diffed writes
    preference.js               — PreferenceService (theme/font/sidebar/
                                   autofit/favorites/recent songs/last-opened)
    index.js                    — barrel export (`export * from ...`)
    browser-bridge.js            — attaches the barrel to `window.MLFirebase`
                                   and bootstraps it (opt-in, config-gated)
  library/
    library.js                  — Song Library, Collections, Setlists (Playlists)
                                   — Firebase Realtime Database–backed
    parser.js                   — lyric page-splitting (the ONE implementation,
                                   consolidating what was previously duplicated)
    metadata.js                 — song name/timestamp formatting helpers
  midi/
    midi.js                     — Web MIDI device connection + message routing
    learn.js                    — MIDI Learn mode
    bindings.js                 — pure note/CC naming + key-matching helpers
  ui/
    viewer.js                   — shared app state, page rendering/navigation,
                                   font size, auto-fit
    sidebar.js                  — local song loading, setlist rendering, Leader/
                                   Follower mode
    toolbar.js                  — theme, fullscreen, sidebar collapse, wake
                                   lock, drawer, status pills
    settings.js                 — Firebase config modal, sync toggle, session/
                                   realtime orchestration, Play/Pause/Stop
    dialogs.js                  — Cloud Song Library modal + Lyrics Editor
  utils/
    storage.js                  — localStorage persistence + PreferenceService
                                   delegation
    debounce.js                  — generic debounce utility
    helpers.js                   — showToast/escapeHtml/detectPlatform
docs/
  IMPLEMENTATION_LOG.md        — append-only, phase-by-phase engineering log
  ARCHITECTURE.md              — this file
  FIREBASE_SETUP.md            — how to configure your own Firebase project
  USER_GUIDE.md                — end-user instructions
  CHANGELOG.md                 — version history
```

Every file under `services/` is a native ES module. `app.js` is now also
`type="module"` (see the repository restructuring log entry) — the only
reason it still exists as a separate top-level file, rather than living
under `services/`, is to keep `index.html`'s `<script src="app.js">`
reference stable.

## Why Two Systems Coexist

`services/firebase/*` was built to eventually replace the legacy system's Firebase logic in `app.js` with a properly modular, role-aware, session-scoped design. Removing the legacy system before its replacement had a working UI would have deleted the app's only functioning sync feature. Each phase of development explicitly deferred that removal until UI-wiring caught up — as of v1.0, the Song Library UI is wired, but the *session* (create/join/role management) UI is not, so full retirement remains a v1.1+ item.

## The Cloud System's Design

### Native ES Modules, No Bundler
Every file under `services/firebase/` uses standard `import`/`export`, loaded via `<script type="module">`. Modern browsers (and GitHub Pages) run this with zero build tooling. `app.js` remains a classic (non-module) script specifically so its inline `onclick="..."` HTML attributes keep working — switching it to a module would silently break every button bound this way.

### Firebase Realtime Database Shape

```
sessions/{sessionId}/
  hostId                 — uid of the current host
  createdAt
  lastActivityAt         — bumped only by real playback/display changes (not presence)
  playbackState/
    status                — 'playing' | 'paused' | 'stopped'
    currentSongId, currentSongName
    pageIndex, playbackPosition
    beat, measure, tempo   — reserved, nullable placeholders (no MIDI timing engine yet)
    updatedAt
  displayState/
    theme, fontSize, fullscreen
    updatedAt
  devices/{uid}/
    role                   — 'host' | 'admin' | 'presenter' | 'viewer'
    platform, label
    connectedAt, lastSeen  — presence + heartbeat

library/
  songs/{songId}           — { name, text, addedBy, createdAt, updatedAt }
  collections/{id}         — { name, songIds: { [songId]: true }, ... }
  setlists/{id}            — { name, songIds: [ordered array], ... }  (UI label: "Playlist")

users/{uid}/
  preferences/              — theme, font, sidebar, windowLayout, playbackSpeed
  favorites/{songId}: true
  recentSongs               — array, most-recent-first
```

Only **Firebase Authentication** (anonymous) and **Realtime Database** are used. No Firestore, no Storage, no Cloud Functions — lyric text is always parsed client-side and written as plain text, never as a file upload.

### Session Roles
- **Host** — created the session; full control + device/role management.
- **Admin** — same power as Host, grantable without owning the session (e.g. a media director).
- **Presenter** — can control playback/display, cannot manage devices/roles.
- **Viewer** — read-only.

A device can only self-request Viewer or Presenter when joining; Host/Admin must be granted by an existing Host/Admin. If the Host disconnects, an eligible Admin/Presenter device automatically attempts to claim the role via a Firebase transaction (only one device can win).

### Synchronization Reliability
- **Diffed writes** — a value is only sent if it actually changed.
- **Loop prevention** — incoming remote updates are bracketed with a suppress-flag, so a UI reacting to a received update can't bounce the same value back.
- **Throttling** — high-frequency fields (playback position) are throttled (200ms); discrete actions (play/pause/next) are not delayed.
- **Heartbeat** — every 25s, a connected device refreshes its own presence.
- **Session expiration** — a session with no real playback/display activity for 12 hours becomes unjoinable (enforced client-side; no Cloud Functions are used, so expired data is not automatically deleted from the database).
- **Multi-path writes** — a state change and its session-activity timestamp are written in a single network round-trip.

## Security Model (Application-Level Only)

Role-based permission checks (`canControlPlayback()`, `canManageSession()`) are enforced in JavaScript, not in Firebase Realtime Database security rules. **This is the most important action item before any multi-user production deployment** — see `FIREBASE_SETUP.md` for a recommended starting rule set.

## Known Limitations Summary

- Two Firebase initialization paths exist (legacy named app + new singleton); both work independently, but are not unified.
- Session creation/joining/device-role-management has no UI yet — only reachable via `window.MLFirebase` in the browser console.
- No automated test suite.
- No Realtime Database security rules shipped in this repository (see `FIREBASE_SETUP.md`).

See `IMPLEMENTATION_LOG.md` for the complete, phase-by-phase history of every architectural decision behind this design.
