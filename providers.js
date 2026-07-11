// Provider orchestrator: detects Claude Code and Codex CLI local data, produces
// a single normalized payload the renderer consumes regardless of source.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { UsageScanner } = require('./usage');           // Claude
const { CodexScanner, available: codexAvailable } = require('./providers/codex');

const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');
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

// Map the Claude scanner's stats into the normalized payload.
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

class Providers {
  constructor() {
    this.claude = null;
    this.codex = null;
  }
  detect() {
    return { claude: claudeAvailable(), codex: codexAvailable() };
  }
  // decide which provider to render given config + availability
  resolve(config) {
    const have = this.detect();
    const pref = (config && config.provider) || 'auto';
    if (pref === 'claude' && have.claude) return 'claude';
    if (pref === 'codex' && have.codex) return 'codex';
    // auto (or preferred one unavailable)
    if (have.claude && have.codex) {
      return (config && config.activeProvider === 'codex') ? 'codex' : 'claude';
    }
    if (have.codex && !have.claude) return 'codex';
    return 'claude'; // default / nothing detected -> Claude idle view
  }
  getPayload(config) {
    const which = this.resolve(config);
    if (which === 'codex') {
      if (!this.codex) this.codex = new CodexScanner();
      const p = this.codex.getStats();
      p.available = this.detect();
      return p;
    }
    if (!this.claude) this.claude = new UsageScanner();
    const p = claudePayload(this.claude.getStats(config));
    p.available = this.detect();
    return p;
  }
  // expose the raw Claude scanner for the calibration dialog
  claudeScanner() {
    if (!this.claude) this.claude = new UsageScanner();
    return this.claude;
  }
}

module.exports = { Providers };
