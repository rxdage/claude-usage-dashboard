// Tests for the usage-threshold alert logic in providers.js — computeAlert
// (thresholds, disable, top-meter selection) and localAlertMeters (only real
// limits become alert meters). Runs with: `node --test test`.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { computeAlert, localAlertMeters } = require('../providers');

test('computeAlert: below warn threshold is none', () => {
  const a = computeAlert([{ label: 'Weekly', usedPct: 42 }], {});
  assert.equal(a.level, 'none');
  assert.equal(a.reason, null);
});

test('computeAlert: >=80% warns, >=95% is critical', () => {
  assert.equal(computeAlert([{ label: 'Session', usedPct: 80 }], {}).level, 'warn');
  assert.equal(computeAlert([{ label: 'Session', usedPct: 94 }], {}).level, 'warn');
  assert.equal(computeAlert([{ label: 'Session', usedPct: 95 }], {}).level, 'crit');
  assert.equal(computeAlert([{ label: 'Session', usedPct: 100 }], {}).level, 'crit');
});

test('computeAlert: picks the single most-used meter for the reason', () => {
  const a = computeAlert([
    { label: 'Session', usedPct: 40 },
    { label: 'Weekly', usedPct: 91 },
    { label: 'Fable weekly', usedPct: 88 },
  ], {});
  assert.equal(a.level, 'warn');
  assert.equal(a.reason, 'Weekly 91%');
  assert.equal(Math.round(a.pct), 91);
});

test('computeAlert: custom thresholds are honored', () => {
  const cfg = { alertWarnPct: 50, alertCritPct: 70 };
  assert.equal(computeAlert([{ label: 'X', usedPct: 55 }], cfg).level, 'warn');
  assert.equal(computeAlert([{ label: 'X', usedPct: 72 }], cfg).level, 'crit');
});

test('computeAlert: alerts:false disables entirely', () => {
  const a = computeAlert([{ label: 'X', usedPct: 99 }], { alerts: false });
  assert.equal(a.level, 'none');
});

test('computeAlert: no meters -> none (never cries wolf)', () => {
  assert.equal(computeAlert([], {}).level, 'none');
  assert.equal(computeAlert(null, {}).level, 'none');
});

test('localAlertMeters: excludes the uncalibrated (auto) session limit', () => {
  const meters = localAlertMeters({
    limitIsAuto: true, active: true, sessionPct: 99,
    fableRemainingPct: null, weeklyRemainingPct: null,
  });
  assert.deepEqual(meters, []);
});

test('localAlertMeters: real limits become used% meters', () => {
  const meters = localAlertMeters({
    limitIsAuto: false, active: true, sessionPct: 30,
    fableRemainingPct: 20, weeklyRemainingPct: 5,
  });
  assert.deepEqual(meters, [
    { label: 'Session', usedPct: 30 },
    { label: 'Fable weekly', usedPct: 80 },
    { label: 'Weekly', usedPct: 95 },
  ]);
});
