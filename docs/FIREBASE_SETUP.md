# Firebase Setup Guide

This app uses **only** Firebase Authentication and Realtime Database. It does not use Firestore, Storage, or Cloud Functions.

## 1. Create a Firebase Project

1. Go to the [Firebase Console](https://console.firebase.google.com/) and create a new project (or use an existing one).
2. You do not need Google Analytics for this app.

## 2. Enable Authentication

1. In the Firebase Console, go to **Build → Authentication → Sign-in method**.
2. Enable the **Anonymous** provider.
   - The app uses anonymous sign-in to give each device a stable identity for presence, roles, and per-device Favorites/Recent Songs/Preferences sync. No email/password or social login is required for v1.0.

## 3. Enable Realtime Database

1. Go to **Build → Realtime Database → Create Database**.
2. Choose a location close to your users.
3. Start in **locked mode** — you will apply the recommended rules below before going live with more than one device.

## 4. Get Your Config Values

1. In **Project Settings → General**, scroll to "Your apps" and add a **Web app** (if you haven't already).
2. Copy the config object shown — you'll need: `apiKey`, `authDomain`, `databaseURL`, `projectId`, `appId`.

## 5. Enter Your Config in the App

1. Open the app in your browser.
2. Click the ⚙ (settings) icon in the toolbar.
3. Paste in your `apiKey`, `authDomain`, `databaseURL`, `projectId`, and `appId`.
4. Click **Save & Connect**.
5. Toggle **Enable real-time sync** in the sidebar to activate the Firebase-backed features (Song Library, Favorites, Collections, Playlists, and the legacy Leader/Follower sync).

Your config is stored in your browser's `localStorage` only — it is never sent anywhere except directly to Firebase.

## 6. Recommended Security Rules

**This repository does not ship Realtime Database security rules.** All role-based access control (Host/Admin/Presenter/Viewer permissions) is currently enforced in the app's JavaScript only — anyone who can reach your database URL directly (e.g. via the REST API) could bypass those checks unless you apply rules like the ones below in **Realtime Database → Rules**.

This is a starting point, not a guarantee — review it against your own security needs before a public/multi-user deployment:

```json
{
  "rules": {
    "sessions": {
      "$sessionId": {
        ".read": "auth != null",
        "devices": {
          "$uid": {
            ".write": "auth != null && (auth.uid === $uid || root.child('sessions/' + $sessionId + '/devices/' + auth.uid + '/role').val() === 'host' || root.child('sessions/' + $sessionId + '/devices/' + auth.uid + '/role').val() === 'admin')"
          }
        },
        "playbackState": {
          ".write": "auth != null && root.child('sessions/' + $sessionId + '/devices/' + auth.uid + '/role').val() !== 'viewer' && root.child('sessions/' + $sessionId + '/devices/' + auth.uid).exists()"
        },
        "displayState": {
          ".write": "auth != null && root.child('sessions/' + $sessionId + '/devices/' + auth.uid + '/role').val() !== 'viewer' && root.child('sessions/' + $sessionId + '/devices/' + auth.uid).exists()"
        },
        "hostId": {
          ".write": "auth != null"
        }
      }
    },
    "library": {
      ".read": "auth != null",
      ".write": "auth != null"
    },
    "users": {
      "$uid": {
        ".read": "auth != null && auth.uid === $uid",
        ".write": "auth != null && auth.uid === $uid"
      }
    }
  }
}
```

**Notes on this starting rule set:**
- `hostId` is deliberately left writable by any authenticated device — this is required for the automatic host-migration feature (a transaction claims host status only if the current host's device entry is gone). If you want to restrict this further, you'll need rules that can inspect transaction intent, which Realtime Database rules cannot fully express — consider this an accepted trade-off of the current design.
- `library` is shared/collaborative by design (any signed-in device can add/edit songs, collections, and playlists) — tighten this if you need per-user song ownership.
- There is no rule-level session expiration or cleanup — expired sessions become unjoinable in the app's own logic (see `ARCHITECTURE.md`), but their data remains in the database until manually removed, since this project does not use Cloud Functions.

## 7. Verifying Your Setup

- Open the app, enable sync, and check the **Sync** status pill in the bottom bar — it should turn green ("connected").
- Open the Song Library (toolbar), and try importing a `.txt` file — it should appear in the Songs tab within a second or two.
- Open the app in a second browser/device with the same config to confirm real-time updates propagate.
