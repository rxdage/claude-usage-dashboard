// Tests for the ECO mode transforms (eco.js) — the round-trip guarantee
// matters most: toggling off must restore the user's tool config EXACTLY.
// Runs with: `node --test test`.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { applyClaudeEco, applyCodexEco, CLAUDE_ECO_MODEL } = require('../eco');

// ---- Claude (settings.json object) ----

test('claude on: sets opusplan, remembers the previous model', () => {
  const r = applyClaudeEco({ theme: 'dark', model: 'opus' }, true);
  assert.equal(r.settings.model, CLAUDE_ECO_MODEL);
  assert.equal(r.settings.theme, 'dark'); // untouched
  assert.equal(r.prev, 'opus');
});

test('claude on with no model key: prev is null', () => {
  const r = applyClaudeEco({ theme: 'dark' }, true);
  assert.equal(r.settings.model, CLAUDE_ECO_MODEL);
  assert.equal(r.prev, null);
});

test('claude off: restores the stashed model', () => {
  const r = applyClaudeEco({ theme: 'dark', model: CLAUDE_ECO_MODEL }, false, 'opus');
  assert.equal(r.settings.model, 'opus');
});

test('claude off with null prev: removes the key entirely', () => {
  const r = applyClaudeEco({ theme: 'dark', model: CLAUDE_ECO_MODEL }, false, null);
  assert.ok(!('model' in r.settings));
  assert.deepEqual(r.settings, { theme: 'dark' });
});

test('claude round-trip is exact', () => {
  const orig = { theme: 'dark', agentPushNotifEnabled: true };
  const on = applyClaudeEco(orig, true);
  const off = applyClaudeEco(on.settings, false, on.prev);
  assert.deepEqual(off.settings, orig);
});

// ---- Codex (config.toml text) ----

const TOML = [
  'model = "gpt-5.5"',
  'model_reasoning_effort = "xhigh"',
  '',
  "[projects.'c:\\users\\woshi']",
  'trust_level = "trusted"',
  '',
  '[tui.model_availability_nux]',
  '"gpt-5.5" = 1',
].join('\n');

test('codex on: replaces the effort line, remembers previous', () => {
  const r = applyCodexEco(TOML, true);
  assert.match(r.toml, /^model_reasoning_effort = "medium"$/m);
  assert.equal(r.prev, 'xhigh');
  assert.match(r.toml, /trust_level = "trusted"/); // rest untouched
});

test('codex on without an existing effort line: inserts before first section', () => {
  const noEffort = 'model = "gpt-5.5"\n\n[windows]\nsandbox = "unelevated"';
  const r = applyCodexEco(noEffort, true);
  assert.equal(r.prev, null);
  const lines = r.toml.split('\n');
  assert.ok(lines.indexOf('model_reasoning_effort = "medium"') < lines.findIndex((l) => l.startsWith('[')));
});

test('codex on never touches an effort key inside a [section]', () => {
  const nested = '[profiles.fast]\nmodel_reasoning_effort = "low"\n';
  const r = applyCodexEco(nested, true);
  assert.match(r.toml, /\[profiles\.fast\]\nmodel_reasoning_effort = "low"/); // untouched
  assert.match(r.toml, /^model_reasoning_effort = "medium"/); // inserted top-level
});

test('codex off: restores the stashed effort', () => {
  const on = applyCodexEco(TOML, true);
  const off = applyCodexEco(on.toml, false, on.prev);
  assert.equal(off.toml, TOML); // byte-for-byte round trip
});

test('codex off with null prev: removes the line it added', () => {
  const noEffort = 'model = "gpt-5.5"\n\n[windows]\nsandbox = "unelevated"';
  const on = applyCodexEco(noEffort, true);
  const off = applyCodexEco(on.toml, false, null);
  assert.equal(off.toml, noEffort);
});

test('codex custom eco effort is honored', () => {
  const r = applyCodexEco(TOML, true, null, 'low');
  assert.match(r.toml, /^model_reasoning_effort = "low"$/m);
});

test('codex CRLF files keep CRLF', () => {
  const crlf = TOML.replace(/\n/g, '\r\n');
  const r = applyCodexEco(crlf, true);
  assert.ok(r.toml.includes('\r\n'));
  assert.ok(!/[^\r]\n/.test(r.toml.replace(/\r\n/g, '')));
});
