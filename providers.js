// Provider orchestrator: detects Claude Code and Codex CLI local data and
// produces one normalized payload. When both exist, the PRIMARY provider is
// chosen by auto-follow (most recent activity, with hysteresis) unless pinned,
// and the other provider is summarized in a compact `secondary` strip.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { UsageScanner } = require('./usage');           // Claude
const { CodexScanner, available: codexAvailable } = require('./providers/codex');
const { ClaudeOfficialUsage } = require('./providers/claude'); // opt-in

const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');
// Don't flip the primary until the other provider has been the newer one by
// this margin — prevents flapping when both tools are in use at once.
const FOLLOW_HYSTERESIS_MS = 30000;

function claudeAvailable() {
  try { return fs.statSync(CLAUDE_PROJECTS).isDirectory(); } catch { return false; }
}

const fmtTok = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + 'B'
  : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M'
  : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(Math.round(n)));
const countdown = (ms) => {
  if (ms == null || ms <= 0) return '--:--';
  const m = Math.floor(ms / 60000);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
};
const countdownDays = (ms) => {
  if (ms == null || ms <= 0) return '--';
  const h = Math.floor(ms / 3600000);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h >= 1) return `${h}h ${Math.floor((ms % 3600000) / 60000)}m`;
  return `${Math.floor(ms / 60000)}m`;
};

function usableOfficialMeter(meter, now) {
  return !!(meter && meter.usedPct != null && (!meter.resetAt || meter.resetAt > now));
}
function compactModelLabel(label) {
  const v = String(label || '').toUpperCase();
  if (/FABLE/.test(v)) return 'FABLE·5';
  if (/MYTHOS/.test(v)) return 'MYTHOS';
  if (/OPUS/.test(v)) return 'OPUS';
  if (/SONNET/.test(v)) return 'SONNET';
  return v.slice(0, 12) || 'MODEL';
}

// Meters that represent a REAL limit (official server %, or a calibrated local
// limit) — the only ones threshold alerts fire on. Uncalibrated "share" bars
// and the historical-max session gauge are excluded so alerts never cry wolf.
function localAlertMeters(s) {
  const m = [];
  if (!s.limitIsAuto && s.active && s.sessionPct != null) {
    m.push({ label: 'Session', usedPct: s.sessionPct });
  }
  if (s.fableRemainingPct != null) m.push({ label: 'Fable weekly', usedPct: 100 - s.fableRemainingPct });
  if (s.weeklyRemainingPct != null) m.push({ label: 'Weekly', usedPct: 100 - s.weeklyRemainingPct });
  return m;
}

// Turn the real-limit meters into an alert level. Default 80% warn / 95% crit,
// echoing the tachometer's 80% redline. Configurable + disableable.
function computeAlert(meters, config) {
  const cfg = config || {};
  if (cfg.alerts === false || !Array.isArray(meters) || !meters.length) {
    return { level: 'none', reason: null, pct: 0 };
  }
  const warnAt = Number.isFinite(cfg.alertWarnPct) ? cfg.alertWarnPct : 80;
  const critAt = Number.isFinite(cfg.alertCritPct) ? cfg.alertCritPct : 95;
  let top = null;
  for (const m of meters) {
    if (m && m.usedPct != null && (!top || m.usedPct > top.usedPct)) top = m;
  }
  if (!top) return { level: 'none', reason: null, pct: 0 };
  const level = top.usedPct >= critAt ? 'crit' : top.usedPct >= warnAt ? 'warn' : 'none';
  return {
    level,
    reason: level === 'none' ? null : `${top.label} ${Math.round(top.usedPct)}%`,
    pct: top.usedPct,
  };
}

// Clean local view (opt-in official usage OFF). No SERVER/STALE/EST tags — the
// sub line shows tokens and countdown, exactly as the fully-local widget always
// has. This is the default.
function claudeLocalPayload(s) {
  const bar = (remainingPct, label, usedTokens, usedPct, shareTone, uncalSuffix) => {
    if (remainingPct != null) {
      return { label, wk: true, fillPct: remainingPct, tone: 'remaining',
        valText: `${Math.round(remainingPct)}% left` };
    }
    return { label, wk: true, fillPct: Math.max(2, usedPct), tone: shareTone,
      valText: `${fmtTok(usedTokens)} used${uncalSuffix}` };
  };
  const fableShare = s.weekTokens > 0 ? (s.fableWeekTokens / s.weekTokens) * 100 : 0;
  return {
    provider: 'claude',
    active: s.active,
    lastActivity: s.lastActivity || null,
    _sec: {
      sessionPct: s.active ? s.sessionPct : 0,
      weeklyPct: s.weeklyRemainingPct != null ? 100 - s.weeklyRemainingPct : null,
    },
    tach: {
      pct: s.sessionPct,
      text: s.active ? Math.round(s.sessionPct) + '%' : 'IDLE',
      sub: s.active ? `${fmtTok(s.sessionTokens)} · ${countdown(s.resetInMs)}` : '5h window',
      red: s.active && s.sessionPct >= 80,
      label: 'CLAUDE·5H',
      src: 'local',
    },
    bars: [
      bar(s.fableRemainingPct, 'FABLE·5', s.fableWeekTokens, fableShare, 'info-amber', ' · set limit'),
      bar(s.weeklyRemainingPct, 'ALL', s.weekTokens, s.weeklyPct, 'info-blue', ''),
    ],
    footer: {
      left: { val: '$' + s.dayCost.toFixed(2), label: 'today' },
      right: { val: countdownDays(s.weekResetInMs), label: 'wk reset' },
    },
    live: !!(s.lastActivity && Date.now() - s.lastActivity < 90000),
    dataStatus: { kind: 'local', source: 'local-transcript', error: null },
    alertMeters: localAlertMeters(s),
  };
}

// Official-usage view (opt-in ON). `official` is the ClaudeOfficialUsage state
// object (never null here). When its meters are usable they take over, tagged
// SERVER (fresh) or STALE (cached); when the fetch failed it falls back to the
// local estimate tagged EST. A leading ~ marks any non-SERVER number.
// `official === null` means opt-in is OFF -> clean local view above.
function claudePayload(s, official = null) {
  if (!official) return claudeLocalPayload(s);
  const now = Date.now();
  const od = official && official.data;
  const serverSession = od && usableOfficialMeter(od.session, now) ? od.session : null;
  const serverWeekly = od && usableOfficialMeter(od.weekly, now) ? od.weekly : null;
  const serverModel = od && usableOfficialMeter(od.modelWeekly, now) ? od.modelWeekly : null;
  const hasServer = !!serverSession;
  const stale = !!(official && official.stale);
  const exact = hasServer && !stale;
  const sourceTag = exact ? 'SERVER' : hasServer ? 'STALE' : 'EST';
  const sessionPct = hasServer ? serverSession.usedPct : s.sessionPct;

  const localBar = (remainingPct, label, usedTokens, usedPct, shareTone, uncalSuffix) => {
    if (remainingPct != null) {
      return { label, wk: true, fillPct: remainingPct, tone: 'remaining',
        valText: `${Math.round(remainingPct)}% left` };
    }
    return { label, wk: true, fillPct: Math.max(2, usedPct), tone: shareTone,
      valText: `${fmtTok(usedTokens)} used${uncalSuffix}` };
  };
  const officialBar = (meter, label) => meter ? {
    label, wk: true, fillPct: Math.max(0, 100 - meter.usedPct), tone: 'remaining',
    valText: `${stale ? '~' : ''}${Math.round(100 - meter.usedPct)}% left`,
  } : null;

  const fableShare = s.weekTokens > 0 ? (s.fableWeekTokens / s.weekTokens) * 100 : 0;
  const modelBar = officialBar(serverModel, compactModelLabel(serverModel && serverModel.label))
    || localBar(s.fableRemainingPct, 'FABLE·5', s.fableWeekTokens, fableShare, 'info-amber', ' · set limit');
  const weeklyBar = officialBar(serverWeekly, 'ALL')
    || localBar(s.weeklyRemainingPct, 'ALL', s.weekTokens, s.weeklyPct, 'info-blue', '');
  const sessionResetInMs = serverSession && serverSession.resetAt
    ? Math.max(0, serverSession.resetAt - now) : s.resetInMs;
  const weeklyResetInMs = serverWeekly && serverWeekly.resetAt
    ? Math.max(0, serverWeekly.resetAt - now) : s.weekResetInMs;
  const activeOrServer = hasServer || s.active;

  return {
    provider: 'claude',
    active: hasServer ? sessionPct > 0 : s.active,
    lastActivity: s.lastActivity || null,
    _sec: {
      sessionPct: hasServer ? sessionPct : (s.active ? s.sessionPct : 0),
      weeklyPct: serverWeekly ? serverWeekly.usedPct
        : (s.weeklyRemainingPct != null ? 100 - s.weeklyRemainingPct : null),
    },
    tach: {
      pct: sessionPct,
      text: activeOrServer ? `${exact ? '' : '~'}${Math.round(sessionPct)}%` : 'IDLE',
      sub: activeOrServer ? `${sourceTag} · ${countdown(sessionResetInMs)}` : '5h window',
      red: activeOrServer && sessionPct >= 80,
      label: 'CLAUDE·5H',
      src: exact ? 'server' : hasServer ? 'stale' : 'est',
    },
    bars: [modelBar, weeklyBar],
    footer: {
      left: { val: '$' + s.dayCost.toFixed(2), label: 'today' },
      right: { val: countdownDays(weeklyResetInMs), label: 'wk reset' },
    },
    live: !!(s.lastActivity && Date.now() - s.lastActivity < 90000),
    dataStatus: {
      kind: exact ? 'official' : hasServer ? 'stale' : 'estimate',
      source: official && official.source || 'local-transcript-estimate',
      error: official && official.error && official.error.message || null,
    },
    alertMeters: hasServer ? [
      serverSession && { label: 'Session', usedPct: serverSession.usedPct },
      serverModel && { label: compactModelLabel(serverModel.label), usedPct: serverModel.usedPct },
      serverWeekly && { label: 'Weekly', usedPct: serverWeekly.usedPct },
    ].filter(Boolean) : localAlertMeters(s),
  };
}

// After a manual swap in auto mode, hold the choice this long before
// auto-follow may take over again (else the swap reverts within one tick).
const MANUAL_HOLD_MS = 5 * 60 * 1000;

class Providers {
  constructor(options = {}) {
    this.claude = null;
    this.codex = null;
    this.claudeOptions = options.claudeOptions || {};
    this._official = options.claudeOfficial || null; // lazily created when opted in
    this.lastPrimary = null;  // sticky auto-follow state
    this.holdUntil = 0;       // manual-swap hold deadline (auto mode only)
  }

  // Created only when the user opts into official usage, so the default build
  // never constructs the credential-reading / network client.
  officialUsage() {
    if (!this._official) this._official = new ClaudeOfficialUsage(this.claudeOptions);
    return this._official;
  }

  // Manual swap while in auto mode: flip the sticky primary in memory (no
  // config write — the mode stays auto) and hold it for a while.
  forcePrimary(name) {
    this.lastPrimary = name;
    this.holdUntil = Date.now() + MANUAL_HOLD_MS;
  }
  clearHold() { this.holdUntil = 0; }

  detect() {
    return { claude: claudeAvailable(), codex: codexAvailable() };
  }

  claudeScanner() {
    if (!this.claude) this.claude = new UsageScanner();
    return this.claude;
  }
  codexScanner() {
    if (!this.codex) this.codex = new CodexScanner();
    return this.codex;
  }

  // Clear the official-usage failure backoff and fetch once right now. Used on
  // wake-from-sleep and after a re-login so SERVER recovers immediately instead
  // of waiting out a backoff left by a transient network failure. No-op if
  // official usage was never used (no instance to reconnect).
  async forceOfficialRefresh() {
    if (!this._official || typeof this._official.resetBackoff !== 'function') return;
    this._official.resetBackoff();
    try { await this._official.getUsage({ active: true, force: true }); } catch {}
  }

  // mode: 'auto' (follow activity) | 'claude' | 'codex' (pinned)
  static modeFrom(config) {
    const m = config && (config.providerMode || config.activeProvider);
    return m === 'claude' || m === 'codex' ? m : 'auto';
  }

  // Decide the primary among available providers, honoring pin + hysteresis.
  pickPrimary(mode, have, clPayload, cxPayload) {
    if (have.claude && !have.codex) return 'claude';
    if (have.codex && !have.claude) return 'codex';
    if (!have.claude && !have.codex) return 'claude'; // idle default view
    if (mode === 'claude' || mode === 'codex') return mode;
    // manual-swap hold: keep the user's choice for a while before following again
    if (this.lastPrimary && Date.now() < this.holdUntil) return this.lastPrimary;
    // auto-follow with hysteresis
    const a = (clPayload && clPayload.lastActivity) || 0;
    const b = (cxPayload && cxPayload.lastActivity) || 0;
    if (!this.lastPrimary) {
      this.lastPrimary = b > a ? 'codex' : 'claude';
    } else if (this.lastPrimary === 'claude' && b > a + FOLLOW_HYSTERESIS_MS) {
      this.lastPrimary = 'codex';
    } else if (this.lastPrimary === 'codex' && a > b + FOLLOW_HYSTERESIS_MS) {
      this.lastPrimary = 'claude';
    }
    return this.lastPrimary;
  }

  async getPayload(config) {
    const have = this.detect();
    const mode = Providers.modeFrom(config);
    let cl = null;
    if (have.claude) {
      const local = this.claudeScanner().getStats(config);
      let official = null;
      // Opt-in only. Default builds never touch credentials or the network.
      if (config && config.officialUsage) {
        const active = !!(local.lastActivity && Date.now() - local.lastActivity < 90000);
        try { official = await this.officialUsage().getUsage({ active }); } catch {}
      }
      cl = claudePayload(local, official);
    }
    const cx = have.codex ? this.codexScanner().getStats() : null;

    const primaryName = this.pickPrimary(mode, have, cl, cx);
    let primary = primaryName === 'codex' ? cx : cl;
    if (!primary) primary = cl || cx || claudePayload(this.claudeScanner().getStats(config), null);

    const other = primaryName === 'codex' ? cl : cx;
    const secondary = (have.claude && have.codex && other) ? {
      provider: other.provider,
      label: other.provider === 'codex' ? 'CODEX' : 'CLAUDE',
      sessionPct: other._sec ? other._sec.sessionPct : null,
      weeklyPct: other._sec ? other._sec.weeklyPct : null,
      live: !!other.live,
    } : null;

    // Threshold alert reflects the primary provider (what the cluster shows).
    const alert = computeAlert(primary.alertMeters || [], config);

    return { ...primary, mode, primaryName, secondary, available: have, alert };
  }
}

module.exports = { Providers, claudePayload, usableOfficialMeter, computeAlert, localAlertMeters };
