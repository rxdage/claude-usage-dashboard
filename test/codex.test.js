const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CodexScanner, formatWindowLabel } = require('../providers/codex');

const NOW = Date.parse('2026-07-20T10:00:00.000Z');

function withSessions(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeRollout(dir, name, { originator, source, timestamp, rateLimits }) {
  const lines = [
    { timestamp, type: 'session_meta', payload: { originator, source } },
    {
      timestamp,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: {
          input_tokens: 1000, cached_input_tokens: 400,
          output_tokens: 200, reasoning_output_tokens: 50, total_tokens: 1250,
        } },
        rate_limits: rateLimits,
      },
    },
  ];
  fs.writeFileSync(path.join(dir, `rollout-${name}.jsonl`), lines.map(JSON.stringify).join('\n'));
}

test('formats plan windows from their actual duration', () => {
  assert.equal(formatWindowLabel(300), '5H');
  assert.equal(formatWindowLabel(10080), '7D');
  assert.equal(formatWindowLabel(1440), '1D');
});

test('keeps the legacy CLI 5-hour plus weekly layout', (t) => {
  const dir = withSessions(t);
  writeRollout(dir, 'cli', {
    originator: 'codex-tui', source: 'cli', timestamp: '2026-07-20T09:59:00.000Z',
    rateLimits: {
      limit_id: 'codex',
      primary: { used_percent: 21, window_minutes: 300, resets_at: NOW / 1000 + 3600 },
      secondary: { used_percent: 34, window_minutes: 10080, resets_at: NOW / 1000 + 86400 },
    },
  });

  const stats = new CodexScanner({ sessionsDir: dir, now: () => NOW }).getStats();
  assert.equal(stats.tach.label, 'CODEX·5H');
  assert.equal(stats.tach.pct, 21);
  assert.equal(stats.bars[0].label, 'WEEKLY');
  assert.equal(stats.bars[0].valText, '66% left');
  assert.equal(stats.plan.surface, 'cli');
  assert.deepEqual(stats._sec, { sessionPct: 21, weeklyPct: 34 });
});

test('maps a Desktop single weekly window to the ChatGPT plan gauge', (t) => {
  const dir = withSessions(t);
  writeRollout(dir, 'desktop', {
    originator: 'Codex Desktop', source: 'vscode', timestamp: '2026-07-20T09:59:00.000Z',
    rateLimits: {
      limit_id: 'codex',
      primary: { used_percent: 7, window_minutes: 10080, resets_at: NOW / 1000 + 86400 },
      secondary: null,
      credits: { has_credits: true, unlimited: false, balance: null },
    },
  });

  const stats = new CodexScanner({ sessionsDir: dir, now: () => NOW }).getStats();
  assert.equal(stats.tach.label, 'CODEX·7D');
  assert.equal(stats.tach.pct, 7);
  assert.equal(stats.bars[0].label, 'PLAN·7D');
  assert.equal(stats.bars[0].valText, '93% left');
  assert.equal(stats.footer.right.label, 'plan reset');
  assert.equal(stats.plan.surface, 'desktop');
  assert.equal(stats.plan.credits.has_credits, true);
  assert.deepEqual(stats._sec, { sessionPct: 7, weeklyPct: 7 });
});

test('does not let an expired CLI short window override current Desktop plan data', (t) => {
  const dir = withSessions(t);
  writeRollout(dir, 'old-cli', {
    originator: 'codex-tui', source: 'cli', timestamp: '2026-07-20T08:00:00.000Z',
    rateLimits: {
      primary: { used_percent: 80, window_minutes: 300, resets_at: NOW / 1000 - 1 },
      secondary: { used_percent: 5, window_minutes: 10080, resets_at: NOW / 1000 + 7200 },
    },
  });
  writeRollout(dir, 'desktop', {
    originator: 'codex_work_desktop', source: 'vscode', timestamp: '2026-07-20T09:59:00.000Z',
    rateLimits: {
      primary: { used_percent: 9, window_minutes: 10080, resets_at: NOW / 1000 + 7200 },
    },
  });

  const stats = new CodexScanner({ sessionsDir: dir, now: () => NOW }).getStats();
  assert.equal(stats.tach.label, 'CODEX·7D');
  assert.equal(stats.tach.pct, 9);
  assert.deepEqual(stats.alertMeters, [{ label: '7-day', usedPct: 9 }]);
});
