/**
 * services/firebase/sync-audit-log.js
 *
 * Pure console-formatting helpers for the 9-step synchronization
 * lifecycle audit:
 *   1. Firebase initialized
 *   2. Anonymous Authentication completed
 *   3. Database connection established
 *   4. Session created
 *   5. Presence written
 *   6. Listener attached
 *   7. Leader publish enabled
 *   8. Follower listener enabled
 *   9. Sync indicator updated
 *
 * No side effects other than console output — imported by firebase.js,
 * auth.js, session.js, realtime.js, and settings.js, each of which calls
 * syncAuditPass()/syncAuditFail() at the exact point that step actually
 * succeeds or fails, so the trail reflects real runtime outcomes rather
 * than a simulation.
 */

export const SYNC_AUDIT_STEPS = {
  1: 'Firebase initialized',
  2: 'Anonymous Authentication completed',
  3: 'Database connection established',
  4: 'Session created',
  5: 'Presence written',
  6: 'Listener attached',
  7: 'Leader publish enabled',
  8: 'Follower listener enabled',
  9: 'Sync indicator updated',
};

export function syncAuditPass(step, detail) {
  console.log(
    `%c[Sync Audit] Step ${step} (${SYNC_AUDIT_STEPS[step]}) — PASS`,
    'color:#2ecc71;font-weight:bold',
    detail !== undefined ? detail : ''
  );
}

/**
 * @param {number} step
 * @param {{fn: string, path: string, error?: any, reason: string}} info
 *   fn     - exact function where the failure occurred
 *   path   - exact database path involved (or '(n/a)' if not DB-related)
 *   error  - the actual thrown/rejected Firebase error object, if any
 *   reason - plain-English explanation of why this step failed
 */
export function syncAuditFail(step, { fn, path, error, reason }) {
  console.group(
    `%c[Sync Audit] Step ${step} (${SYNC_AUDIT_STEPS[step]}) — FAIL`,
    'color:#e74c3c;font-weight:bold'
  );
  console.log('• exact function:', fn || '(unknown)');
  console.log('• exact database path:', path || '(n/a)');
  console.log(
    '• exact Firebase error:',
    error ? `${error.code || '(no code)'}: ${error.message || error}` : '(none thrown — see reason)'
  );
  console.log('• exact reason:', reason || '(not determined)');
  console.groupEnd();
}
