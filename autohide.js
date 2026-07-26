// Passive auto-hide: fade the widget away when both providers have been idle
// for a while (you're watching a movie, not coding), and bring it back the
// moment new usage is detected. Pure decision logic — the window/fade side
// lives in main.js; this part is unit-tested.
//
// Hysteresis by design: hiding needs `idleMinutes` of silence (default 10
// SECONDS — the widget is meant to react like a dashboard lamp), showing
// needs activity within min(90s, the idle threshold), so hide and show can
// never both be true and the widget can't flap around the threshold.
const ACTIVE_WITHIN_MS = 90 * 1000;
const DEFAULT_IDLE_MIN = 10 / 60; // 10 seconds, expressed in minutes

// -> 'hide' | 'show' | null (no change)
function decideAutoHide({ enabled, idleMinutes, lastActivity, now, autoHidden }) {
  if (!enabled) return autoHidden ? 'show' : null; // turning it off restores the widget
  const mins = Number.isFinite(idleMinutes) && idleMinutes > 0 ? idleMinutes : DEFAULT_IDLE_MIN;
  if (autoHidden) {
    // The show window must never reach the hide threshold, or a config with
    // idleMinutes <= 1.5min would satisfy BOTH conditions and flap every tick.
    const showWithin = Math.min(ACTIVE_WITHIN_MS, mins * 60000);
    return lastActivity && now - lastActivity < showWithin ? 'show' : null;
  }
  // Never auto-hide with no activity history at all (fresh install / setup
  // phase) — only after known usage has gone quiet.
  return lastActivity && now - lastActivity >= mins * 60000 ? 'hide' : null;
}

module.exports = { decideAutoHide, ACTIVE_WITHIN_MS, DEFAULT_IDLE_MIN };
