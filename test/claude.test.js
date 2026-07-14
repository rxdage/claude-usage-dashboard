// Tests for providers/claude.js — pure helpers, credential file IO, the
// refresh/write-back flow, and the ClaudeOfficialUsage fetch orchestration.
// Runs with node's built-in runner: `node --test test`.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  ClaudeOfficialUsage,
  normalizeUsageResponse,
  resolveClaudeTokens,
  refreshAccessToken,
  writeBackCredential,
  credentialStatus,
  clampPct,
  resetMs,
  constants,
} = require('../providers/claude');

// ---- helpers ----

let tmpDir = null;
let savedConfigDir;
let savedEnvToken;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cud-test-'));
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  savedEnvToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CONFIG_DIR = tmpDir;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
});

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  if (savedEnvToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedEnvToken;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeCredentialFile(oauth) {
  const file = path.join(tmpDir, '.credentials.json');
  fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: oauth }, null, 2));
  return file;
}

function jsonResponse(body, { status = 200, retryAfter = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: (k) => (retryAfter != null && /retry-after/i.test(k) ? String(retryAfter) : null) },
  };
}

const NOW = 1_800_000_000_000; // fixed "now" (ms epoch) for deterministic tests

// ---- clampPct / resetMs ----

test('clampPct clamps to 0..100 and rejects non-numbers', () => {
  assert.equal(clampPct(41), 41);
  assert.equal(clampPct(-5), 0);
  assert.equal(clampPct(250), 100);
  assert.equal(clampPct('63'), 63);
  assert.equal(clampPct('nope'), null);
  assert.equal(clampPct(undefined), null);
});

test('resetMs accepts seconds, milliseconds, and ISO strings', () => {
  assert.equal(resetMs(1_800_000_000), 1_800_000_000_000); // seconds -> ms
  assert.equal(resetMs(1_800_000_000_000), 1_800_000_000_000); // already ms
  assert.equal(resetMs('2026-07-14T00:00:00Z'), Date.parse('2026-07-14T00:00:00Z'));
  assert.equal(resetMs(null), null);
  assert.equal(resetMs(''), null);
  assert.equal(resetMs('garbage'), null);
});

// ---- normalizeUsageResponse ----

test('normalizeUsageResponse maps the limits[] shape', () => {
  const out = normalizeUsageResponse({
    limits: [
      { kind: 'session', percent: 41, resets_at: 1_800_000_000 },
      { kind: 'weekly_all', percent: 17 },
      { kind: 'weekly_scoped', percent: 22, scope: { model: { display_name: 'Fable 5' } } },
      { kind: 'weekly_scoped', percent: 9, scope: { model: { display_name: 'Sonnet 5' } } },
    ],
  });
  assert.equal(out.session.usedPct, 41);
  assert.equal(out.session.resetAt, 1_800_000_000_000);
  assert.equal(out.weekly.usedPct, 17);
  // scoped meter prefers the opus/fable-class model over sonnet
  assert.equal(out.modelWeekly.usedPct, 22);
  assert.equal(out.modelWeekly.label, 'Fable 5');
});

test('normalizeUsageResponse falls back to the legacy five_hour/seven_day shape', () => {
  const out = normalizeUsageResponse({
    five_hour: { utilization: 30 },
    seven_day: { utilization: 55 },
    seven_day_opus: { utilization: 12 },
  });
  assert.equal(out.session.usedPct, 30);
  assert.equal(out.session.label, '5H');
  assert.equal(out.weekly.usedPct, 55);
  assert.equal(out.modelWeekly.usedPct, 12);
  assert.equal(out.modelWeekly.label, 'OPUS');
});

test('normalizeUsageResponse rejects non-objects and meterless payloads', () => {
  assert.throws(() => normalizeUsageResponse(null));
  assert.throws(() => normalizeUsageResponse([]));
  assert.throws(() => normalizeUsageResponse({ limits: [] }));
  assert.throws(() => normalizeUsageResponse({ limits: [{ kind: 'session' }] })); // no percent
});

// ---- credentialStatus ----

test('credentialStatus reports a healthy full-login credential', () => {
  writeCredentialFile({
    accessToken: 'at-1', refreshToken: 'rt-1',
    expiresAt: NOW + 3_600_000, refreshTokenExpiresAt: NOW + 86_400_000,
    scopes: ['user:inference', 'user:profile'], subscriptionType: 'max',
  });
  const st = credentialStatus(NOW);
  assert.equal(st.loggedIn, true);
  assert.equal(st.hasProfileScope, true);
  assert.equal(st.accessExpired, false);
  assert.equal(st.hasRefreshToken, true);
  assert.equal(st.refreshExpired, false);
  assert.equal(st.subscriptionType, 'max');
});

test('credentialStatus flags expired access and missing profile scope', () => {
  writeCredentialFile({
    accessToken: 'at-1', expiresAt: NOW - 1000, scopes: ['user:inference'],
  });
  const st = credentialStatus(NOW);
  assert.equal(st.loggedIn, true);
  assert.equal(st.hasProfileScope, false);
  assert.equal(st.accessExpired, true);
});

test('credentialStatus reports logged-out when the file is missing or tokenless', () => {
  assert.equal(credentialStatus(NOW).loggedIn, false);
  writeCredentialFile({ scopes: ['user:profile'] }); // no accessToken
  assert.equal(credentialStatus(NOW).loggedIn, false);
});

// ---- resolveClaudeTokens ----

test('resolveClaudeTokens returns the standard credential with file for write-back', () => {
  const file = writeCredentialFile({
    accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: NOW + 3_600_000,
  });
  const tokens = resolveClaudeTokens({ now: NOW });
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].token, 'at-1');
  assert.equal(tokens[0].refreshToken, 'rt-1');
  assert.equal(tokens[0].file, file);
});

test('resolveClaudeTokens keeps an expired credential that still has a refresh token', () => {
  writeCredentialFile({
    accessToken: 'at-old', refreshToken: 'rt-1', expiresAt: NOW - 1000,
  });
  const tokens = resolveClaudeTokens({ now: NOW });
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].refreshToken, 'rt-1');
});

test('resolveClaudeTokens includes the env-var token after the standard credential', () => {
  writeCredentialFile({ accessToken: 'at-1', expiresAt: NOW + 3_600_000 });
  process.env.CLAUDE_CODE_OAUTH_TOKEN = ' env-token ';
  const tokens = resolveClaudeTokens({ now: NOW });
  assert.equal(tokens.length, 2);
  assert.equal(tokens[0].token, 'at-1');
  assert.equal(tokens[1].token, 'env-token'); // trimmed
  assert.equal(tokens[1].source, 'environment');
});

// ---- refreshAccessToken ----

test('refreshAccessToken posts to platform.claude.com with a User-Agent', async () => {
  let captured = null;
  const fetchFn = async (url, opts) => { captured = { url, opts }; return jsonResponse({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600 }); };
  const out = await refreshAccessToken('rt-old', fetchFn);
  assert.equal(captured.url, 'https://platform.claude.com/v1/oauth/token');
  assert.equal(captured.opts.method, 'POST');
  assert.ok(captured.opts.headers['User-Agent'], 'must send a User-Agent (Cloudflare WAF)');
  const body = JSON.parse(captured.opts.body);
  assert.equal(body.grant_type, 'refresh_token');
  assert.equal(body.refresh_token, 'rt-old');
  assert.ok(body.client_id);
  assert.equal(out.accessToken, 'at-new');
  assert.equal(out.refreshToken, 'rt-new');
  assert.ok(out.expiresAt > Date.now());
});

test('refreshAccessToken keeps the old refresh token when the server does not rotate', async () => {
  const fetchFn = async () => jsonResponse({ access_token: 'at-new' });
  const out = await refreshAccessToken('rt-old', fetchFn);
  assert.equal(out.refreshToken, 'rt-old');
  assert.equal(out.expiresAt, null);
});

test('refreshAccessToken throws on HTTP error and on token-less responses', async () => {
  await assert.rejects(() => refreshAccessToken('rt', async () => jsonResponse({}, { status: 429 })), /refresh-http-429/);
  await assert.rejects(() => refreshAccessToken('rt', async () => jsonResponse({ nope: 1 })), /refresh-no-access-token/);
  await assert.rejects(() => refreshAccessToken(null, async () => jsonResponse({})), /refresh-token-missing/);
  await assert.rejects(() => refreshAccessToken('rt', null), /refresh-fetch-unavailable/);
});

// ---- writeBackCredential ----

test('writeBackCredential merges tokens without disturbing sibling fields', () => {
  const file = writeCredentialFile({
    accessToken: 'at-old', refreshToken: 'rt-old', expiresAt: 1,
    scopes: ['user:profile'], subscriptionType: 'max', rateLimitTier: 'x',
  });
  writeBackCredential(file, { accessToken: 'at-new', refreshToken: 'rt-new', expiresAt: NOW });
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(j.claudeAiOauth.accessToken, 'at-new');
  assert.equal(j.claudeAiOauth.refreshToken, 'rt-new');
  assert.equal(j.claudeAiOauth.expiresAt, NOW);
  assert.deepEqual(j.claudeAiOauth.scopes, ['user:profile']); // untouched
  assert.equal(j.claudeAiOauth.subscriptionType, 'max');
  assert.equal(j.claudeAiOauth.rateLimitTier, 'x');
});

test('writeBackCredential creates a valid file even from nothing', () => {
  const file = path.join(tmpDir, '.credentials.json');
  writeBackCredential(file, { accessToken: 'at', refreshToken: 'rt', expiresAt: null });
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(j.claudeAiOauth.accessToken, 'at');
  assert.equal(j.claudeAiOauth.expiresAt, undefined); // null expiry not written
});

// ---- ClaudeOfficialUsage orchestration ----

const USAGE_BODY = { limits: [{ kind: 'session', percent: 41 }, { kind: 'weekly_all', percent: 17 }] };

function makeUsage({ tokens, responses, nowRef = { t: NOW }, writeBackTokens = false }) {
  const calls = [];
  const u = new ClaudeOfficialUsage({
    now: () => nowRef.t,
    resolveTokens: () => tokens,
    writeBackTokens,
    fetchFn: async (url, opts) => {
      calls.push({ url, opts });
      const r = responses.shift();
      if (!r) throw new Error('test: unexpected extra fetch');
      return r;
    },
  });
  return { u, calls };
}

test('refresh caches official data on success and sends the OAuth headers', async () => {
  const { u, calls } = makeUsage({
    tokens: [{ token: 'at-1', expiresAt: NOW + 3_600_000, source: 's' }],
    responses: [jsonResponse(USAGE_BODY)],
  });
  await u.getUsage({ force: true });
  const st = u.state();
  assert.equal(st.error, null);
  assert.equal(st.stale, false);
  assert.equal(st.data.session.usedPct, 41);
  assert.equal(st.source, 'anthropic:s');
  assert.equal(calls[0].url, constants.USAGE_URL);
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer at-1');
  assert.ok(calls[0].opts.headers['anthropic-beta']);
});

test('refresh skips a 401-rejected token and succeeds with the next candidate', async () => {
  const { u, calls } = makeUsage({
    tokens: [
      { token: 'bad', expiresAt: NOW + 3_600_000, source: 'first' },
      { token: 'good', expiresAt: NOW + 3_600_000, source: 'second' },
    ],
    responses: [jsonResponse({}, { status: 401 }), jsonResponse(USAGE_BODY)],
  });
  await u.getUsage({ force: true });
  assert.equal(u.state().error, null);
  assert.equal(u.state().source, 'anthropic:second');
  assert.equal(calls.length, 2);
});

test('refresh exchanges an expired credential and writes it back', async () => {
  const file = writeCredentialFile({ accessToken: 'at-old', refreshToken: 'rt-old', expiresAt: NOW - 1000 });
  const { u, calls } = makeUsage({
    tokens: [{ token: 'at-old', expiresAt: NOW - 1000, refreshToken: 'rt-old', file, source: 's' }],
    responses: [
      jsonResponse({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600 }), // token refresh
      jsonResponse(USAGE_BODY), // usage fetch
    ],
    writeBackTokens: true,
  });
  await u.getUsage({ force: true });
  assert.equal(u.state().error, null);
  assert.equal(calls[0].url, 'https://platform.claude.com/v1/oauth/token');
  assert.equal(calls[1].opts.headers.Authorization, 'Bearer at-new');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(j.claudeAiOauth.accessToken, 'at-new'); // rotated tokens persisted
  assert.equal(j.claudeAiOauth.refreshToken, 'rt-new');
});

test('refresh reports an error and backs off when no credentials exist', async () => {
  const { u } = makeUsage({ tokens: [], responses: [] });
  await u.getUsage({ force: true });
  const st = u.state();
  assert.match(st.error.message, /claude-oauth-credentials-not-found/);
  assert.ok(st.nextPollAt > NOW);
});

test('refresh honors Retry-After on 429', async () => {
  const { u } = makeUsage({
    tokens: [{ token: 'at', expiresAt: NOW + 3_600_000, source: 's' }],
    responses: [jsonResponse({}, { status: 429, retryAfter: 3600 })],
  });
  await u.getUsage({ force: true });
  const st = u.state();
  assert.match(st.error.message, /rate-limited/);
  assert.ok(st.nextPollAt >= NOW + 3_600_000, 'backoff must respect retry-after');
});

test('getUsage does not re-fetch before the poll interval without force', async () => {
  const nowRef = { t: NOW };
  const { u, calls } = makeUsage({
    tokens: [{ token: 'at', expiresAt: NOW + 3_600_000, source: 's' }],
    responses: [jsonResponse(USAGE_BODY), jsonResponse(USAGE_BODY)],
    nowRef,
  });
  await u.getUsage({ force: true });
  nowRef.t += 1000; // 1s later — inside every interval
  await u.getUsage({ active: true });
  assert.equal(calls.length, 1, 'second call must be served from cache');
  nowRef.t += constants.ACTIVE_POLL_MS; // past the active interval
  await u.getUsage({ active: true, force: true });
  assert.equal(calls.length, 2);
});
