# User Guide — MIDI Lyrics Reader

## Getting Started

Open the app in your browser. You'll see:
- A **toolbar** at the top (menu, sidebar collapse, theme, fullscreen, keep-screen-awake, Song Library, Firebase settings).
- A **sidebar** on the left (Role, Display settings, MIDI, Firebase Sync, Setlist).
- The **lyrics stage** in the center.
- A **bottom bar** with page dots, the current song/page, and Prev/Next buttons.

## Displaying Lyrics (Local Setlist)

1. Add `.txt` lyric files to the `songs/` folder in this repository.
2. Click **↻ Refresh Songs** in the sidebar.
3. Click a song to load it. Lyrics are automatically split into pages — either at `[PAGE]` markers you add yourself, or at blank lines.
4. Navigate with the **Prev/Next** buttons, arrow keys, spacebar, tap/click on the stage, or swipe on touch devices.

## MIDI Pedal / Footswitch Control

1. Connect a MIDI device (footswitch, controller) before opening the app, or reconnect while it's open.
2. In the sidebar, click **MIDI Learn: OFF** to start learning.
3. Press the button you want to use for **Next**, then the one for **Previous**. The app remembers these on this device.
4. Click **Clear** to reset the mapping.

## Font Size & Auto-fit

- Use the **−/+** buttons in the sidebar to change font size manually.
- Toggle **Auto-fit lyrics to screen** to have the app automatically size text to fill the display for any page length.

## Themes & Fullscreen

- Click the theme button (🌙/☀️/🎤) in the toolbar to cycle **Dark / Light / Stage** themes, or press `T`.
- Click the fullscreen button or press `F` for a distraction-free stage view — the sidebar automatically collapses and restores when you exit.
- Press `Escape` to exit fullscreen.
- Press `[` to manually collapse/expand the sidebar at any time.

## Leader / Follower Sync (Legacy, Firebase-based)

1. Configure Firebase (see `FIREBASE_SETUP.md`) and enable sync in the sidebar.
2. One device sets its **Role** to Leader; other devices set theirs to Follower.
3. As the Leader navigates songs/pages, all Followers update automatically.

## Song Library (Cloud)

Click the 📚 **Library** button in the toolbar (requires Firebase sync to be enabled):

- **Songs tab** — search your cloud library, ⭐ favorite songs, **Open** a song on stage, or **Edit** its lyrics.
- **Import .txt** — upload a `.txt` lyric file directly into your cloud library (separate from the local `songs/` folder).
- **Collections tab** — group songs together (e.g. "Christmas Songs") for easy browsing.
- **Playlists tab** — build an ordered song list for a specific service/event. Reorder with the ↑/↓ buttons, then click **▶ Play All** to start — a small queue bar appears at the bottom with Prev/Next controls to move through the playlist.
- **Recent tab** — quickly reopen songs you've viewed recently.

## Lyrics Editor & Auto-save

Click **Edit** on any cloud song to open the editor. Your changes save automatically about 1.2 seconds after you stop typing — watch the "Saving…/Saved" indicator at the bottom of the editor.

## Keyboard Shortcuts

| Key | Action |
|---|---|
| → / Space | Next page |
| ← | Previous page |
| `F` | Toggle fullscreen |
| `T` | Cycle theme |
| `[` | Toggle sidebar |
| `Escape` | Exit fullscreen |

## Keeping the Screen Awake

Click the wake-lock (circle) icon in the toolbar to prevent your device from dimming/locking during a service or rehearsal.

## Troubleshooting

- **MIDI button not responding** — make sure your controller is connected before opening the app, or use the browser's device permissions to allow MIDI access.
- **Library button shows an error toast** — you need to configure and enable Firebase sync first (see `FIREBASE_SETUP.md`).
- **Sync pill stays red/not connecting** — double-check your Firebase config values and that Realtime Database is enabled for your project.
