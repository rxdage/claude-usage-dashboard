// Server-authoritative Claude subscription usage (OPT-IN).
//
// Claude Code's /usage command reads GET /api/oauth/usage.  Local transcript
// token totals cannot reproduce that value: the server meter includes usage
// from other devices/surfaces and applies model/tool/cache-specific weights.
// This module treats the OAuth endpoint as primary and exposes the old
// transcript calculation only as an explicitly labelled fallback.
//
// DISABLED BY DEFAULT. Only used when config.officialUsage === true. It reads
// the logged-in Claude OAuth token (Claude Code .credentials.json, the
// CLAUDE_CODE_OAUTH_TOKEN env var, or — where decryptable — the Claude Desktop
// token cache) and sends it ONLY as a Bearer to the usage endpoint. The token
// is never displayed, logged, or persisted by this widget.
const fs = require('fs');
const path = require('path');
const os = require('os');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';
const ACTIVE_POLL_MS = 60 * 1000;
const IDLE_POLL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 12 * 1000;
const STALE_MS = 10 * 60 * 1000;

function clampPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
}

function resetMs(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    return value < 1e12 ? value * 1000 : value;
  }
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : null;
}

function normalizedLimit(raw, fallbackLabel = null) {
  if (!raw || typeof raw !== 'object') return null;
  const usedPct = clampPct(raw.percent != null ? raw.percent : raw.utilization);
  if (usedPct == null) return null;
  const scope = raw.scope && typeof raw.scope === 'object' ? raw.scope : {};
  const scoped = scope.model || scope.surface || {};
  const label = typeof scoped.display_name === 'string' && scoped.display_name.trim()
    ? scoped.display_name.trim()
    : fallbackLabel;
  return { usedPct, resetAt: resetMs(raw.resets_at), label };
}

function limitKind(limit) {
  return String(limit && limit.kind || '').toLowerCase();
}

function scopedLabel(limit) {
  const scope = limit && limit.scope;
  return scope && ((scope.model && scope.model.display_name)
    || (scope.surface && scope.surface.display_name)) || '';
}

function normalizeUsageResponse(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Claude usage response is not an object');
  }

  const limits = Array.isArray(raw.limits) ? raw.limits.filter(Boolean) : [];
  const sessionRaw = limits.find((x) => limitKind(x) === 'session');
  const weeklyRaw = limits.find((x) => limitKind(x) === 'weekly_all');
  const scoped = limits.filter((x) => {
    const k = limitKind(x);
    return k === 'weekly_scoped' || (String(x.group || '').toLowerCase() === 'weekly' && scopedLabel(x));
  });
  const modelRaw = scoped.find((x) => /fable|mythos|opus/i.test(scopedLabel(x)))
    || scoped.find((x) => /sonnet/i.test(scopedLabel(x)))
    || scoped[0];

  const session = normalizedLimit(sessionRaw) || normalizedLimit(raw.five_hour, '5H');
  const weekly = normalizedLimit(weeklyRaw) || normalizedLimit(raw.seven_day, 'ALL');
  const modelWeekly = normalizedLimit(modelRaw)
    || normalizedLimit(raw.seven_day_opus, 'OPUS')
    || normalizedLimit(raw.seven_day_sonnet, 'SONNET');

  if (!session && !weekly && !modelWeekly) {
    throw new Error('Claude usage response contains no recognized meters');
  }

  return { session, weekly, modelWeekly };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function standardCredentialFiles() {
  const root = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return [path.join(root, '.credentials.json')];
}

function tokenFromCredentialObject(value, source) {
  if (!value || typeof value !== 'object') return null;
  const oauth = value.claudeAiOauth || value.oauth || value;
  if (!oauth || typeof oauth !== 'object') return null;
  const token = oauth.accessToken || oauth.access_token || oauth.token;
  if (typeof token !== 'string' || !token.trim()) return null;
  const expiryRaw = oauth.expiresAt || oauth.expires_at || oauth.expiry;
  const expiresAt = expiryRaw == null ? null : resetMs(Number(expiryRaw) || expiryRaw);
  return { token: token.trim(), expiresAt, source };
}

function desktopDataDirs() {
  const out = new Set();
  if (process.env.APPDATA) out.add(path.join(process.env.APPDATA, 'Claude'));
  const packages = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Packages');
  if (packages) {
    let dirs = [];
    try { dirs = fs.readdirSync(packages, { withFileTypes: true }); } catch {}
    for (const dir of dirs) {
      if (dir.isDirectory() && /^Claude_/i.test(dir.name)) {
        out.add(path.join(packages, dir.name, 'LocalCache', 'Roaming', 'Claude'));
      }
    }
  }
  return [...out];
}

function desktopConfigFiles() {
  return desktopDataDirs().map((dir) => path.join(dir, 'config.json'));
}

function decryptCache(value, safeStorage) {
  if (typeof value !== 'string' || !value || !safeStorage) return null;
  try {
    if (typeof safeStorage.isEncryptionAvailable === 'function'
        && !safeStorage.isEncryptionAvailable()) return null;
    const plain = safeStorage.decryptString(Buffer.from(value, 'base64'));
    const parsed = JSON.parse(plain);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function entriesFromDesktopConfig(config, safeStorage, file) {
  if (!config || typeof config !== 'object') return [];
  const out = [];
  for (const key of ['oauth:tokenCacheV2', 'oauth:tokenCache']) {
    const cache = decryptCache(config[key], safeStorage);
    if (!cache) continue;
    const entries = Array.isArray(cache) ? cache : Object.values(cache);
    for (const value of entries) {
      const found = tokenFromCredentialObject(value, `claude-desktop:${path.basename(path.dirname(file))}`);
      if (found) out.push(found);
    }
  }
  return out;
}

function chooseToken(tokens, now = Date.now()) {
  return tokens
    .filter(Boolean)
    .filter((x) => x.expiresAt == null || x.expiresAt > now + 5000)
    .sort((a, b) => (b.expiresAt || Number.MAX_SAFE_INTEGER) - (a.expiresAt || Number.MAX_SAFE_INTEGER))[0]
    || null;
}

// All viable credentials, best-first. Multiple sources exist because tokens
// differ in SCOPE, not just freshness: a `claude setup-token` token (often in
// the env var) lacks the user:profile scope the usage endpoint requires, while
// a full-login credential (.credentials.json) has it. The fetcher walks this
// list and skips scope-rejected tokens.
function resolveClaudeTokens({ safeStorage = null, now = Date.now() } = {}) {
  const out = [];
  // full-login credentials first: they carry user:profile
  const standard = [];
  for (const file of standardCredentialFiles()) {
    const found = tokenFromCredentialObject(readJson(file), `claude-code:${file}`);
    if (found) standard.push(found);
  }
  const standardToken = chooseToken(standard, now);
  if (standardToken) out.push(standardToken);

  const explicit = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (typeof explicit === 'string' && explicit.trim()) {
    out.push({ token: explicit.trim(), expiresAt: null, source: 'environment' });
  }

  const desktop = [];
  for (const file of desktopConfigFiles()) {
    desktop.push(...entriesFromDesktopConfig(readJson(file), safeStorage, file));
  }
  const desktopToken = chooseToken(desktop, now);
  if (desktopToken) out.push(desktopToken);
  return out;
}

// kept for compatibility (probe/tests): best single candidate
function resolveClaudeToken(opts = {}) {
  return resolveClaudeTokens(opts)[0] || null;
}

function retryAfterMs(response) {
  const raw = response && response.headers && response.headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

class ClaudeOfficialUsage {
  constructor(options = {}) {
    this.safeStorage = options.safeStorage || null;
    this.fetchFn = options.fetchFn || null;
    this.now = options.now || (() => Date.now());
    this.resolveTokens = options.resolveTokens || ((now) => resolveClaudeTokens({
      safeStorage: this.safeStorage,
      now,
    }));
    this.cache = options.initialCache || null;
    this.lastAttemptAt = 0;
    this.nextPollAt = 0;
    this.failures = 0;
    this.lastError = null;
    this.inFlight = null;
  }

  state() {
    const now = this.now();
    const ageMs = this.cache ? Math.max(0, now - this.cache.fetchedAt) : null;
    return {
      data: this.cache && this.cache.data || null,
      fetchedAt: this.cache && this.cache.fetchedAt || null,
      source: this.cache && this.cache.source || null,
      ageMs,
      stale: ageMs == null || ageMs > STALE_MS,
      error: this.lastError,
      nextPollAt: this.nextPollAt || null,
    };
  }

  async getUsage({ active = false, force = false } = {}) {
    const now = this.now();
    const normalInterval = active ? ACTIVE_POLL_MS : IDLE_POLL_MS;
    const dueAt = Math.max(this.nextPollAt || 0, this.lastAttemptAt + normalInterval);
    if (!force && this.lastAttemptAt && now < dueAt) return this.state();
    if (this.inFlight) {
      if (!this.cache) await this.inFlight;
      return this.state();
    }
    this.inFlight = this.refresh().finally(() => { this.inFlight = null; });
    if (!this.cache || force) await this.inFlight;
    return this.state();
  }

  async doFetch(token) {
    if (!this.fetchFn) throw new Error('official-fetch-unavailable');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await this.fetchFn(USAGE_URL, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'anthropic-beta': OAUTH_BETA,
          'anthropic-version': '2023-06-01',
        },
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async refresh() {
    const now = this.now();
    this.lastAttemptAt = now;
    try {
      const candidates = this.resolveTokens(now);
      if (!candidates.length) throw new Error('claude-oauth-credentials-not-found');

      // Try each credential in order; skip tokens rejected for auth/scope
      // reasons (401, or 403 permission_error like a setup-token lacking
      // user:profile) and remember the last rejection for diagnostics.
      let response = null, credential = null, lastAuthErr = null;
      for (const cand of candidates) {
        const res = await this.doFetch(cand.token);
        if (res.status === 401 || res.status === 403) {
          lastAuthErr = `claude-usage-http-${res.status} (${cand.source})`;
          continue;
        }
        response = res; credential = cand;
        break;
      }
      if (!response) throw new Error(lastAuthErr || 'claude-usage-auth-rejected');
      if (response.status === 429) {
        const err = new Error('claude-usage-rate-limited');
        err.retryAfterMs = retryAfterMs(response);
        throw err;
      }
      if (!response.ok) throw new Error(`claude-usage-http-${response.status}`);

      const data = normalizeUsageResponse(await response.json());
      const fetchedAt = this.now();
      this.cache = { data, fetchedAt, source: `anthropic:${credential.source}` };
      this.failures = 0;
      this.lastError = null;
      this.nextPollAt = 0;
    } catch (error) {
      this.failures += 1;
      const message = error && error.name === 'AbortError'
        ? 'claude-usage-timeout'
        : String(error && error.message || error);
      this.lastError = { message, at: this.now() };
      const retry = error && error.retryAfterMs;
      const exponential = Math.min(15 * 60 * 1000, 30 * 1000 * (2 ** Math.min(this.failures, 5)));
      this.nextPollAt = this.now() + Math.max(retry || 0, exponential);
    }
  }
}

module.exports = {
  ClaudeOfficialUsage,
  normalizeUsageResponse,
  resolveClaudeToken,
  resolveClaudeTokens,
  desktopConfigFiles,
  clampPct,
  resetMs,
  constants: { USAGE_URL, OAUTH_BETA, ACTIVE_POLL_MS, IDLE_POLL_MS, STALE_MS },
};
