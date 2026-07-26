// Tests for the passive auto-hide decision logic (autohide.js).
// Runs with: `node --test test`.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { decideAutoHide, ACTIVE_WITHIN_MS, DEFAULT_IDLE_MIN } = require('../autohide');

const NOW = 1_800_000_000_000;
const MIN = 60000;

test('hides after the default 10 minutes of silence', () => {
  const d = decideAutoHide({
    enabled: true, idleMinutes: undefined,
    lastActivity: NOW - DEFAULT_IDLE_MIN * MIN, now: NOW, autoHidden: false,
  });
  assert.equal(d, 'hide');
});

test('stays visible while activity is recent', () => {
  const d = decideAutoHide({
    enabled: true, idleMinutes: undefined,
    lastActivity: NOW - 2 * MIN, now: NOW, autoHidden: false,
  });
  assert.equal(d, null);
});

test('shows again when hidden and fresh activity appears', () => {
  const d = decideAutoHide({
    enabled: true, idleMinutes: undefined,
    lastActivity: NOW - 5000, now: NOW, autoHidden: true,
  });
  assert.equal(d, 'show');
});

test('stays hidden while still idle', () => {
  const d = decideAutoHide({
    enabled: true, idleMinutes: undefined,
    lastActivity: NOW - 30 * MIN, now: NOW, autoHidden: true,
  });
  assert.equal(d, null);
});

test('hysteresis: activity older than the live window does not re-show', () => {
  const d = decideAutoHide({
    enabled: true, idleMinutes: undefined,
    lastActivity: NOW - (ACTIVE_WITHIN_MS + 1000), now: NOW, autoHidden: true,
  });
  assert.equal(d, null);
});

test('never hides with no activity history (fresh install)', () => {
  const d = decideAutoHide({
    enabled: true, idleMinutes: undefined,
    lastActivity: null, now: NOW, autoHidden: false,
  });
  assert.equal(d, null);
});

test('custom idle minutes are honored', () => {
  const args = { enabled: true, idleMinutes: 30, now: NOW, autoHidden: false };
  assert.equal(decideAutoHide({ ...args, lastActivity: NOW - 29 * MIN }), null);
  assert.equal(decideAutoHide({ ...args, lastActivity: NOW - 31 * MIN }), 'hide');
});

test('disabled: never hides, and restores a previously auto-hidden widget', () => {
  assert.equal(decideAutoHide({
    enabled: false, lastActivity: NOW - 120 * MIN, now: NOW, autoHidden: false,
  }), null);
  assert.equal(decideAutoHide({
    enabled: false, lastActivity: NOW - 120 * MIN, now: NOW, autoHidden: true,
  }), 'show');
});

test('no flapping: hide and show can never both fire, even with a tiny threshold', () => {
  // idleMinutes far below the 90s live window used to make ages in
  // [idleMs, 90s) satisfy BOTH conditions -> hide/show every tick.
  const mins = 0.05; // 3s
  for (let ageSec = 0; ageSec <= 120; ageSec += 1) {
    const args = {
      enabled: true, idleMinutes: mins,
      lastActivity: NOW - ageSec * 1000, now: NOW,
    };
    const hide = decideAutoHide({ ...args, autoHidden: false });
    const show = decideAutoHide({ ...args, autoHidden: true });
    assert.ok(!(hide === 'hide' && show === 'show'),
      `flap at age ${ageSec}s: hide+show both fire`);
  }
});

test('bad idleMinutes values fall back to the default', () => {
  for (const bad of [0, -5, NaN, 'soon']) {
    const d = decideAutoHide({
      enabled: true, idleMinutes: bad,
      lastActivity: NOW - DEFAULT_IDLE_MIN * MIN, now: NOW, autoHidden: false,
    });
    assert.equal(d, 'hide', `idleMinutes=${bad}`);
  }
});
