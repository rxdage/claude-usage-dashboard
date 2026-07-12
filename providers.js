// Provider orchestrator: detects Claude Code and Codex CLI local data and
// produces one normalized payload. When both exist, the PRIMARY provider is
// chosen by auto-follow (most recent activity, with hysteresis) unless pinned,
// and the other provider is summarized in a compact `secondary` strip.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { UsageScanner } = require('./usage');           // Claude
const { CodexScanner, available: codexAvailable } = require('./providers/codex');

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

// Map the Claude scanner's raw stats into the normalized payload.
function claudePayload(s) {
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
  };
}

// After a manual swap in auto mode, hold the choice this long before
// auto-follow may take over again (else the swap reverts within one tick).
const MANUAL_HOLD_MS = 5 * 60 * 1000;

class Providers {
  constructor() {
    this.claude = null;
    this.codex = null;
    this.lastPrimary = null;  // sticky auto-follow state
    this.holdUntil = 0;       // manual-swap hold deadline (auto mode only)
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

  getPayload(config) {
    const have = this.detect();
    const mode = Providers.modeFrom(config);
    const cl = have.claude ? claudePayload(this.claudeScanner().getStats(config)) : null;
    const cx = have.codex ? this.codexScanner().getStats() : null;

    const primaryName = this.pickPrimary(mode, have, cl, cx);
    let primary = primaryName === 'codex' ? cx : cl;
    if (!primary) primary = cl || cx || claudePayload(this.claudeScanner().getStats(config));

    const other = primaryName === 'codex' ? cl : cx;
    const secondary = (have.claude && have.codex && other) ? {
      provider: other.provider,
      label: other.provider === 'codex' ? 'CODEX' : 'CLAUDE',
      sessionPct: other._sec ? other._sec.sessionPct : null,
      weeklyPct: other._sec ? other._sec.weeklyPct : null,
      live: !!other.live,
    } : null;

    return { ...primary, mode, primaryName, secondary, available: have };
  }
}

module.exports = { Providers, claudePayload };
