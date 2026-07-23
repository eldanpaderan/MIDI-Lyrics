/**
 * services/firebase/session.js
 *
 * Session-based synchronization model — Phase 4 role upgrade.
 *
 * Host (e.g. Laptop running MainStage/Sunday Keys) creates a session and
 * gets a short shareable Session ID. Other devices join with one of four
 * roles:
 *
 *   host      - created the session; full control + can manage devices/roles
 *   admin     - elevated, cross-device management power equal to host
 *               (e.g. a media director who should always be able to take
 *               over), but does not "own" the session the way a host does
 *   presenter - can control playback (play/pause/next/prev/song/display
 *               settings) but cannot manage other devices or roles
 *   viewer    - read-only; watches playback/display state, publishes nothing
 *
 * A joining device can only self-request 'viewer' or 'presenter' — 'host'
 * and 'admin' can only be granted by an existing host/admin via
 * setDeviceRole(), never self-assigned. (Real enforcement of this still
 * belongs in your Realtime Database security rules; this module enforces
 * it in application code only.)
 *
 * All realtime data lives scoped under sessions/{sessionId}/...
 *
 * NOTE: this file does not touch or replace the existing fbPublish/
 * fbStartListening code in app.js — that remains a separate, working
 * system until a dedicated migration phase rewires the UI to use this
 * session model instead.
 */
import { getFirebaseApp, serverTimestamp } from './firebase.js';
import { getCurrentUser } from './auth.js';

export const ROLES = Object.freeze({
  HOST: 'host',
  ADMIN: 'admin',
  PRESENTER: 'presenter',
  VIEWER: 'viewer',
});

const SELF_ASSIGNABLE_ROLES = new Set([ROLES.VIEWER, ROLES.PRESENTER]);
const CONTROL_ROLES = new Set([ROLES.HOST, ROLES.ADMIN, ROLES.PRESENTER]);
const MANAGE_ROLES = new Set([ROLES.HOST, ROLES.ADMIN]);

let activeSessionId = null;
let deviceRef = null;
let role = null;
let kicked = false;

const roleChangeListeners = new Set();
const kickListeners = new Set();
const connectionListeners = new Set();
let connectionWatcherStarted = false;
let deviceRoleUnsub = null;

function db() {
  return getFirebaseApp().database();
}

function requireUser() {
  const user = getCurrentUser();
  if (!user) throw new Error('Must be signed in (see auth.js) before using sessions.');
  return user;
}

function generateSessionId() {
  // Short, human-shareable code, e.g. "K3F7QZ"
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

/* ================================================================
   PERMISSION HELPERS
   ================================================================ */

export function canControlPlayback(r = role) {
  return CONTROL_ROLES.has(r);
}

export function canManageSession(r = role) {
  return MANAGE_ROLES.has(r);
}

export function isHost()      { return role === ROLES.HOST; }
export function isAdmin()     { return role === ROLES.ADMIN; }
export function isPresenter() { return role === ROLES.PRESENTER; }
export function isViewer()    { return role === ROLES.VIEWER; }

/* ================================================================
   CREATE / JOIN / LEAVE
   ================================================================ */

/**
 * Host creates a new session.
 * @param {{platform?: string, label?: string}} deviceInfo
 * @returns {Promise<string>} the new session ID
 */
export async function createSession(deviceInfo = {}) {
  requireUser();
  const sessionId = generateSessionId();
  const ref = db().ref(`sessions/${sessionId}`);
  await ref.set({
    hostId: getCurrentUser().uid,
    createdAt: serverTimestamp(),
    playbackState: {
      status: 'stopped',
      currentSongId: null,
      currentSongName: null,
      pageIndex: 0,
      playbackPosition: 0,
      // Reserved placeholders only — no timing engine implemented yet.
      beat: null,
      measure: null,
      tempo: null,
      updatedAt: serverTimestamp(),
    },
    displayState: {
      theme: null,
      fontSize: null,
      fullscreen: null,
      updatedAt: serverTimestamp(),
    },
  });
  await registerDevice(sessionId, ROLES.HOST, deviceInfo);
  activeSessionId = sessionId;
  return sessionId;
}

/**
 * A device joins an existing session. Only 'viewer' or 'presenter' may be
 * self-requested; anything else is clamped down to 'viewer'. To actually
 * become host/admin, an existing host/admin must call setDeviceRole().
 * @param {string} sessionId
 * @param {{platform?: string, label?: string}} deviceInfo
 * @param {string} [requestedRole='viewer']
 */
export async function joinSession(sessionId, deviceInfo = {}, requestedRole = ROLES.VIEWER) {
  requireUser();
  const snap = await db().ref(`sessions/${sessionId}`).get();
  if (!snap.exists()) throw new Error(`Session "${sessionId}" was not found.`);

  const safeRole = SELF_ASSIGNABLE_ROLES.has(requestedRole) ? requestedRole : ROLES.VIEWER;
  await registerDevice(sessionId, safeRole, deviceInfo);
  activeSessionId = sessionId;
  return sessionId;
}

async function registerDevice(sessionId, deviceRole, deviceInfo) {
  const user = getCurrentUser();

  // Fix for audit finding H3: if this device is already attached to a
  // different session (joinSession()/createSession() called again without
  // leaveSession() first), the previous device ref's onDisconnect() must be
  // cancelled here — otherwise it stays armed against the OLD session and
  // can fire an unexpected device-removal there later.
  if (deviceRef) {
    deviceRef.onDisconnect().cancel();
  }

  const ref = db().ref(`sessions/${sessionId}/devices/${user.uid}`);
  await ref.set({
    role: deviceRole,
    platform: deviceInfo.platform || 'unknown',
    label: deviceInfo.label || defaultLabelFor(deviceRole),
    connectedAt: serverTimestamp(),
    lastSeen: serverTimestamp(),
  });
  // Realtime Database presence pattern: auto-remove this device entry the
  // moment its connection drops (closed tab, lost network, app killed).
  ref.onDisconnect().remove();

  deviceRef = ref;
  role = deviceRole;
  kicked = false;

  watchOwnDevice(ref);
  startConnectionWatcher();
}

function defaultLabelFor(deviceRole) {
  switch (deviceRole) {
    case ROLES.HOST: return 'Host';
    case ROLES.ADMIN: return 'Admin';
    case ROLES.PRESENTER: return 'Presenter';
    default: return 'Viewer';
  }
}

/**
 * Watches this device's own devices/{uid} node so that:
 *  - a role change made remotely by a host/admin (setDeviceRole) is
 *    picked up locally and listeners are notified, and
 *  - if the node disappears entirely (removed by a host/admin — a
 *    "kick"), we detect it and notify kick listeners instead of silently
 *    losing control permissions.
 */
function watchOwnDevice(ref) {
  if (deviceRoleUnsub) deviceRoleUnsub();
  const handler = (snap) => {
    if (!snap.exists()) {
      if (activeSessionId && !kicked) {
        kicked = true;
        kickListeners.forEach((cb) => cb());
        clearLocalSessionState();
      }
      return;
    }
    const data = snap.val();
    if (data.role && data.role !== role) {
      role = data.role;
      roleChangeListeners.forEach((cb) => cb(role));
    }
  };
  ref.on('value', handler);
  deviceRoleUnsub = () => ref.off('value', handler);
}

/** Leave the current session (removes this device from the devices list). */
export function leaveSession() {
  if (deviceRef) {
    deviceRef.onDisconnect().cancel();
    deviceRef.remove();
  }
  clearLocalSessionState();
}

function clearLocalSessionState() {
  if (deviceRoleUnsub) { deviceRoleUnsub(); deviceRoleUnsub = null; }
  activeSessionId = null;
  role = null;
  deviceRef = null;
}

export function getActiveSessionId() {
  return activeSessionId;
}

export function getRole() {
  return role;
}

/** Subscribe to this device's own role changing (e.g. promoted/demoted by a host/admin). */
export function onRoleChange(callback) {
  roleChangeListeners.add(callback);
  return () => roleChangeListeners.delete(callback);
}

/** Subscribe to being kicked from the session by a host/admin. */
export function onKicked(callback) {
  kickListeners.add(callback);
  return () => kickListeners.delete(callback);
}

/* ================================================================
   DEVICE / ROLE MANAGEMENT (host/admin only)
   ================================================================ */

/**
 * Promote/demote another connected device. Only callable by a device
 * whose own current role is host or admin.
 */
export function setDeviceRole(deviceId, newRole) {
  if (!canManageSession()) {
    return Promise.reject(new Error('Only host/admin devices may change roles.'));
  }
  if (!Object.values(ROLES).includes(newRole)) {
    return Promise.reject(new Error(`Unknown role "${newRole}".`));
  }
  if (!activeSessionId) return Promise.reject(new Error('No active session.'));
  return db().ref(`sessions/${activeSessionId}/devices/${deviceId}/role`).set(newRole);
}

/** Remove another device from the session entirely. Only host/admin. */
export function kickDevice(deviceId) {
  if (!canManageSession()) {
    return Promise.reject(new Error('Only host/admin devices may remove other devices.'));
  }
  if (!activeSessionId) return Promise.reject(new Error('No active session.'));
  return db().ref(`sessions/${activeSessionId}/devices/${deviceId}`).remove();
}

/**
 * Watch the list of connected devices for the active session.
 * @param {(devices: Record<string, object>) => void} callback
 * @returns {() => void} unsubscribe function
 */
export function watchConnectedDevices(callback) {
  if (!activeSessionId) return () => {};
  const ref = db().ref(`sessions/${activeSessionId}/devices`);
  const handler = (snap) => callback(snap.val() || {});
  ref.on('value', handler);
  return () => ref.off('value', handler);
}

/* ================================================================
   RECONNECT HANDLING
   ================================================================ */

/**
 * Starts (once) a listener on the Realtime Database's special
 * `.info/connected` path, which reports this client's own connection
 * state — flips to false on any drop (network loss, backgrounding) and
 * back to true on reconnect. Used to:
 *  - notify connection-state listeners (e.g. show a "Reconnecting…" pill)
 *  - refresh `lastSeen` and re-arm onDisconnect() defensively once
 *    reconnected, so presence data stays accurate even after a flaky
 *    connection.
 */
function startConnectionWatcher() {
  if (connectionWatcherStarted) return;
  connectionWatcherStarted = true;

  const ref = db().ref('.info/connected');
  ref.on('value', (snap) => {
    const connected = snap.val() === true;
    connectionListeners.forEach((cb) => cb(connected));

    if (connected && deviceRef) {
      deviceRef.update({ lastSeen: serverTimestamp() }).catch(() => {});
      deviceRef.onDisconnect().remove();
    }
  });
}

/** Subscribe to this device's own connection state (true = connected). */
export function watchConnectionState(callback) {
  startConnectionWatcher();
  connectionListeners.add(callback);
  return () => connectionListeners.delete(callback);
}
