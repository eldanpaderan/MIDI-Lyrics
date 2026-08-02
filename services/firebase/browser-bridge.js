/**
 * services/firebase/browser-bridge.js
 *
 * The existing app.js is loaded as a classic (non-module) script, on
 * purpose, so its inline onclick="..." handlers keep working (see the
 * Phase 1 implementation log). ES modules do not expose their exports
 * globally, so this tiny bridge — itself a module — imports the new
 * Firebase services and attaches them to `window.MLFirebase`, letting
 * classic scripts (app.js, or your browser console) call into them:
 *
 *   window.MLFirebase.createSession({ platform: 'laptop' })
 *   window.MLFirebase.watchPlaybackState(state => console.log(state))
 *
 * As of the Complete Migration phase, app.js's Leader/Follower UI now
 * exclusively uses this modular system (session.js/realtime.js) for
 * synchronization — the legacy fbPublish/fbStartListening path has been
 * removed from app.js entirely. See docs/IMPLEMENTATION_LOG.md.
 */
import * as MLFirebase from './index.js';

// `import * as MLFirebase` yields an ES Module namespace object, which the
// language spec makes non-extensible — attempting to add a NEW property to
// it later (e.g. `window.MLFirebase.ensureFirebaseServices = ...` below)
// throws `TypeError: Cannot add property ..., object is not extensible` and
// silently aborts the rest of this file's top-level code (including the
// MLFirebaseReady dispatch), which is exactly why Enable Realtime Sync /
// Leader / Follower stopped working after the ES Module migration. Spread
// the namespace's exports into a plain, extensible object instead — every
// existing `window.MLFirebase.xyz()` call site keeps working identically,
// this object just happens to also allow new properties.
window.MLFirebase = { ...MLFirebase };

/**
 * --- Bootstrap (added during validation pass) ---------------------
 *
 * Previously this file only attached window.MLFirebase without ever
 * calling initFirebase()/initAuth()/initPreferenceSync() — meaning the
 * whole services layer was dormant (Realtime Database never connected,
 * no signed-in user, session sync impossible). This block fixes that.
 *
 * Reuses the SAME config the existing "Configure Firebase" modal
 * already saves to localStorage under 'mlr_fb_config' — no second
 * config UI is introduced. Also reuses the existing 'mlr_fbEnabled'
 * flag so the new layer stays opt-in exactly like the old one (no
 * anonymous-auth users get created for people who never enabled sync).
 * ------------------------------------------------------------------ */
const CONFIG_KEY  = 'mlr_fb_config';
const ENABLED_KEY = 'mlr_fbEnabled';

function readSavedConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return null;
    const cfg = JSON.parse(raw);
    if (!cfg || !cfg.apiKey || cfg.apiKey.startsWith('YOUR_')) return null; // still placeholder
    return cfg;
  } catch {
    return null;
  }
}

/**
 * Guarded Firebase services bootstrap — safe to call as many times as
 * needed (e.g. once automatically at page load if sync was already
 * enabled, and again from app.js right after the person saves/enables
 * Firebase config in the UI). initFirebase() itself is idempotent
 * (services/firebase/firebase.js), so calling this repeatedly never
 * creates a second Firebase App instance — "Firebase must initialize
 * only once" is enforced there, not by guessing here whether it's safe
 * to call.
 * @param {object} [explicitConfig] - pass the just-saved config directly to avoid a redundant localStorage read-after-write
 * @returns {boolean} true if the services are (now) initialized, false if not configured/enabled
 */
function bootstrapFirebaseServices(explicitConfig = null) {
  const syncEnabled = localStorage.getItem(ENABLED_KEY) === 'true';
  const cfg = explicitConfig || readSavedConfig();
  if (!syncEnabled || !cfg) {
    // Nothing to do yet — stays dormant until the person configures AND
    // enables Firebase sync via the existing sidebar toggle/modal.
    return false;
  }
  if (MLFirebase.isFirebaseInitialized()) return true;

  try {
    MLFirebase.initFirebase(cfg);
    MLFirebase.initAuth();
    MLFirebase.initPreferenceSync();
    MLFirebase.onAuthChange((user) => {
      if (!user) {
        MLFirebase.signInAnonymously().catch((err) => {
          console.warn(
            '[services/firebase] Anonymous sign-in failed — make sure ' +
            'Anonymous auth is enabled in your Firebase project console.',
            err
          );
        });
      }
    });
    return true;
  } catch (err) {
    console.error('[services/firebase] Bootstrap failed:', err);
    return false;
  }
}

bootstrapFirebaseServices();

// Exposed so app.js (the orchestration layer) can (re-)run this guarded
// bootstrap after the person saves/enables Firebase config at runtime,
// without ever calling the Firebase SDK directly itself.
window.MLFirebase.ensureFirebaseServices = bootstrapFirebaseServices;

/**
 * --- Fix for audit finding H2 (script execution order) ------------
 *
 * This file is loaded as <script type="module">, which executes
 * deferred (after the document is parsed) — but app.js is a classic,
 * non-deferred <script>, which executes immediately when the parser
 * reaches it. Even though this file's <script> tag appears earlier in
 * index.html, app.js can actually run BEFORE this file does. Nothing
 * in app.js currently reads window.MLFirebase synchronously at the
 * top level, so this has not caused a visible bug yet — but any future
 * code must not assume window.MLFirebase is ready simply because it
 * appears later in the DOM/script order.
 *
 * Fix: dispatch a dedicated ready event once MLFirebase is attached and
 * bootstrap has been attempted, so future code can listen for it
 * instead of relying on script order:
 *
 *   window.addEventListener('MLFirebaseReady', () => { ... });
 *
 * If window.MLFirebase is already needed synchronously somewhere by
 * the time this runs, checking `window.MLFirebaseReadyFired === true`
 * (set below) also works as a synchronous readiness check.
 * ------------------------------------------------------------------ */
window.MLFirebaseReadyFired = true;
window.dispatchEvent(new CustomEvent('MLFirebaseReady', { detail: MLFirebase }));
