# 🎵 MIDI-Controlled Live Lyrics Reader

A lightweight, fully responsive web application designed for live musicians, worship teams, and theater performances. This tool allows a **Leader** device to control lyrics using a physical MIDI controller, while instantly syncing the display across all team devices (iPads, Android phones, tablets, and laptops) in real-time.

Built to be hosted entirely for free on **GitHub Pages**, utilizing **Firebase** for instantaneous ultra-low latency wireless syncing.

---

## ✨ Key Features

*   **🎛️ Web MIDI API Integration:** Connect any standard MIDI keyboard, pad, or foot controller directly to your browser—no extra software or drivers required. Includes a built-in "MIDI Learn" mode for easy button mapping.
*   **🔄 Real-Time Device Syncing:** Powered by Firebase. One device acts as the "Leader" (connected to the MIDI controller) and pushes page turns to the cloud. All other devices act as "Followers" and update instantly.
*   **📱 Universal Compatibility:** Fully responsive layout optimized for iPads, Android tablets, smartphones, and laptops. 
*   **🕶️ Stage-Ready UI:** High-contrast dark mode interface with dynamic font-sizing (+ / -) to ensure crystal-clear visibility under stage lights or in dim environments.
*   **🚫 Screen Wake Lock:** Automatically prevents mobile screens and tablets from dimming or falling asleep mid-song.
*   **📂 GitHub-Powered Setlist:** Automatically generates your song catalog by reading `.txt` files directly from this repository's `songs/` folder.

---

## 🚀 How to Add New Songs (For the Team)

You don't need to touch any code to add lyrics! To upload a new song to the setlist:

1.  Prepare a standard text file (`.txt`) containing the lyrics.
    *   *Tip: Use a double line break (or custom page breaks) to separate lyric chunks into different pages.*
2.  Go to the `songs/` folder inside this GitHub repository.
3.  Click on **Add file** ➡️ **Upload files** in the top right corner.
4.  Drag and drop your `.txt` file into the browser.
5.  Scroll down and click **Commit changes**.
6.  The website will automatically update with the new song within 1–2 minutes!

---

## 🛠️ Setup Instructions (For the Administrator)

### 1. Firebase Configuration
To enable the wireless sync feature, you must link your own free Firebase Realtime Database:
1. Go to the [Firebase Console](https://console.firebase.google.com/) and create a new project.
2. Add a **Web App** to your project and copy the configuration snippet.
3. Paste your credentials into the `firebaseConfig` object located inside `app.js`.
4. Enable **Realtime Database** and ensure your Security Rules allow reading and writing.

### 2. GitHub Pages Deployment
1. Navigate to your repository settings on GitHub.
2. Scroll down to the **Pages** menu on the left sidebar.
3. Under *Build and deployment*, set the Source to **Deploy from a branch**.
4. Choose the `main` (or `master`) branch and click **Save**.
5. Your live URL will appear at the top of the page shortly!

---

## 🎤 How to Use on Stage

1.  **Open the Link:** Have all band members open the live GitHub Pages URL on their respective devices.
2.  **Set Up the Leader:** The musician with the MIDI controller plugs their hardware into their device, clicks **Connect MIDI**, maps their foot pedal/button via MIDI Learn, and toggles the switch to **"Act as Leader"**.
3.  **Set Up the Followers:** All other band members simply toggle their app switch to **"Act as Follower"**.
4.  **Perform:** When the Leader selects a song or hits the MIDI pedal to turn the page, every screen on stage will change simultaneously!

---
*Built for musicians, by musicians. Fully customizable and completely open source.*
