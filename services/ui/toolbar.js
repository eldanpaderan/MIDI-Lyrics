/**
 * services/ui/toolbar.js
 *
 * Toolbar & chrome controls — Theme, Fullscreen, Collapsible Sidebar,
 * Wake Lock, Mobile Drawer, and the generic status-pill widget.
 * Extracted from app.js during the repository restructuring; logic
 * unchanged from the original.
 *
 * NOTE ON CIRCULAR IMPORT: this file and services/ui/settings.js import
 * from each other (setTheme()/toggleFullscreen() publish via
 * publishDisplayIfLeader(); settings.js's handleIncomingDisplayState()
 * applies received Follower updates via applyThemeToDOM()/
 * applyFontSizeByLabel()/applyFullscreenState()). Safe under ES Module
 * semantics — see the same note in utils/storage.js.
 */
import { state } from './viewer.js';
import { getSyncedPref, setSyncedPref } from '../utils/storage.js';
import { showToast } from '../utils/helpers.js';
import { publishDisplayIfLeader } from './settings.js';

/* ---------------- Status Pills ---------------- */

export function setPillState(id, pillState, label) {
  const pill = document.getElementById(id);
  if (!pill) return;
  pill.className = 'status-pill' + (pillState ? ' ' + pillState : '');
  const labelEl = pill.querySelector('.label');
  if (labelEl) labelEl.textContent = label;
}

/* ----------------------------------------------------------
   THEME (dark / light / stage)
   ---------------------------------------------------------- */
export const THEME_ORDER = ['dark', 'light', 'stage'];
export const THEME_META = {
  dark:  { icon: '🌙', label: 'Dark'  },
  light: { icon: '☀️', label: 'Light' },
  stage: { icon: '🎤', label: 'Stage' },
};

export function initTheme() {
  const saved = getSyncedPref('theme', null);
  setTheme(THEME_ORDER.includes(saved) ? saved : 'dark', true);
}

/** Pure DOM update — no persistence, no publish. Shared by setTheme() (local user action) and the Follower display-mirroring handler. */
export function applyThemeToDOM(theme) {
  if (!THEME_ORDER.includes(theme)) return;
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.getElementById('theme-btn');
  if (btn) {
    const meta = THEME_META[theme];
    const icon = btn.querySelector('.theme-icon');
    const label = btn.querySelector('.theme-label');
    if (icon)  icon.textContent  = meta.icon;
    if (label) label.textContent = meta.label;
  }
}

export function setTheme(theme, silent = false) {
  if (!THEME_ORDER.includes(theme)) return;
  applyThemeToDOM(theme);
  setSyncedPref('theme', theme);           // this device's own personal preference
  publishDisplayIfLeader({ theme });        // mirror to Follower devices, if Leader
  if (!silent) {
    showToast(`${THEME_META[theme].label} theme`, 'info');
  }
}

export function cycleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = THEME_ORDER[(THEME_ORDER.indexOf(current) + 1) % THEME_ORDER.length];
  setTheme(next);
}

/* ----------------------------------------------------------
   FULLSCREEN
   ---------------------------------------------------------- */
export function toggleFullscreen() {
  const el = document.getElementById('app') || document.documentElement;
  const isFull = document.fullscreenElement || document.webkitFullscreenElement;
  if (!isFull) {
    (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el);
  } else {
    (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
  }
}

/**
 * Follower-side mirroring only, best-effort: most browsers require an
 * actual user gesture (click/tap) to grant requestFullscreen(), so this
 * may silently fail on a Follower device that didn't itself click
 * anything — documented limitation, not a bug (see IMPLEMENTATION_LOG).
 */
export function applyFullscreenState(shouldBeFullscreen) {
  const isFull = !!(document.fullscreenElement || document.webkitFullscreenElement);
  if (shouldBeFullscreen === isFull) return;
  const el = document.getElementById('app') || document.documentElement;
  try {
    if (shouldBeFullscreen) {
      (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el);
    } else {
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    }
  } catch { /* likely blocked without a user gesture — ignore */ }
}

export function updateFullscreenBtn() {
  const btn = document.getElementById('fullscreen-btn');
  if (!btn) return;
  const isFull = !!(document.fullscreenElement || document.webkitFullscreenElement);
  btn.classList.toggle('active', isFull);
  btn.title = isFull ? 'Exit fullscreen' : 'Enter fullscreen';
}

document.addEventListener('fullscreenchange', updateFullscreenBtn);
document.addEventListener('webkitfullscreenchange', updateFullscreenBtn);

// Separate listener (does not modify the one above): publishes the
// resulting fullscreen state if this device is the Leader — covers
// both the toolbar button AND exiting via the Escape key.
document.addEventListener('fullscreenchange', () => {
  publishDisplayIfLeader({ fullscreen: !!(document.fullscreenElement || document.webkitFullscreenElement) });
});
document.addEventListener('webkitfullscreenchange', () => {
  publishDisplayIfLeader({ fullscreen: !!(document.fullscreenElement || document.webkitFullscreenElement) });
});

/* ----------------------------------------------------------
   COLLAPSIBLE SIDEBAR (desktop / tablet)
   Separate from the existing mobile drawer (toggleDrawer),
   which remains untouched.
   ---------------------------------------------------------- */
export function initSidebarCollapse() {
  const sidebarPref = getSyncedPref('sidebar', { collapsed: false });
  const collapsed = !!(sidebarPref && sidebarPref.collapsed);
  document.getElementById('app')?.classList.toggle('sidebar-collapsed', collapsed);
  updateSidebarCollapseBtn(collapsed);
}

export function toggleSidebarCollapse() {
  const app = document.getElementById('app');
  if (!app) return;
  const collapsed = !app.classList.contains('sidebar-collapsed');
  app.classList.toggle('sidebar-collapsed', collapsed);
  setSyncedPref('sidebar', { collapsed });
  updateSidebarCollapseBtn(collapsed);
}

export function updateSidebarCollapseBtn(collapsed) {
  const btn = document.getElementById('sidebar-collapse-btn');
  if (btn) btn.classList.toggle('active', collapsed);
}

/* ----------------------------------------------------------
   FULLSCREEN AUTO-COLLAPSE
   Auto-collapses the sidebar on entering fullscreen (maximizing the
   lyrics viewer) and restores its prior state on exit.
   ---------------------------------------------------------- */
let preFullscreenSidebarCollapsed = null;

export function initFullscreenAutoCollapse() {
  const handler = () => {
    const isFull = !!(document.fullscreenElement || document.webkitFullscreenElement);
    const app = document.getElementById('app');
    if (!app) return;

    if (isFull) {
      preFullscreenSidebarCollapsed = app.classList.contains('sidebar-collapsed');
      if (!preFullscreenSidebarCollapsed) {
        app.classList.add('sidebar-collapsed');
        updateSidebarCollapseBtn(true);
      }
    } else if (preFullscreenSidebarCollapsed !== null) {
      if (!preFullscreenSidebarCollapsed) {
        app.classList.remove('sidebar-collapsed');
        updateSidebarCollapseBtn(false);
      }
      preFullscreenSidebarCollapsed = null;
    }
  };
  document.addEventListener('fullscreenchange', handler);
  document.addEventListener('webkitfullscreenchange', handler);
}

/* ----------------------------------------------------------
   WAKE LOCK
   ---------------------------------------------------------- */
export async function toggleWakeLock() {
  if (state.wakeLockOn) {
    releaseWakeLock();
  } else {
    acquireWakeLock();
  }
}

export async function acquireWakeLock() {
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

export function releaseWakeLock() {
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
export function toggleDrawer() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('drawer-overlay');
  const isOpen  = sidebar.classList.contains('open');
  sidebar.classList.toggle('open', !isOpen);
  overlay.classList.toggle('open', !isOpen);
}

export function closeSidebarDrawer() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('drawer-overlay').classList.remove('open');
}

/* ----------------------------------------------------------
   KEYBOARD SHORTCUTS (toolbar-related: fullscreen/theme/sidebar)
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
