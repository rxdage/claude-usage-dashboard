// Codex usage scanner for ChatGPT Desktop (Codex mode), Codex Desktop, and CLI.
// All of these clients persist token_count events under ~/.codex/sessions. Older
// CLI clients usually report a 5-hour primary plus a 7-day secondary window;
// Desktop/plan clients may report just one plan window. Never infer a slot's
// meaning from "primary"/"secondary" -- use window_minutes instead.
const fs = require('fs');
const path = require('path');
const os = require('os');

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const SESSIONS_DIR = path.join(CODEX_HOME, 'sessions');

function available(sessionsDir = SESSIONS_DIR) {
  try { return fs.statSync(sessionsDir).isDirectory(); } catch { return false; }
}

function normalizeWindow(raw, snapshot, ts, slot) {
  if (!raw || typeof raw !== 'object') return null;
  const usedPct = Number(raw.used_percent);
  const windowMinutes = Number(raw.window_minutes);
  const reset = Number(raw.resets_at);
  if (!Number.isFinite(usedPct) || !Number.isFinite(windowMinutes) || windowMinutes <= 0) return null;
  return {
    ts,
    slot,
    usedPct: Math.max(0, Math.min(100, usedPct)),
    windowMinutes,
    resetsAt: Number.isFinite(reset) && reset > 0 ? reset : null,
    limitId: typeof snapshot.limit_id === 'string' ? snapshot.limit_id : null,
    limitName: typeof snapshot.limit_name === 'string' ? snapshot.limit_name : null,
  };
}

function formatWindowLabel(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return 'PLAN';
  if (minutes % 10080 === 0) return `${minutes / 10080 * 7}D`;
  if (minutes % 1440 === 0) return `${minutes / 1440}D`;
  if (minutes % 60 === 0) return `${minutes / 60}H`;
  return `${minutes}M`;
}

function meterAlertLabel(meter) {
  const label = formatWindowLabel(meter.windowMinutes);
  return label.endsWith('D') ? `${label.slice(0, -1)}-day`
    : label.endsWith('H') ? `${label.slice(0, -1)}-hour`
      : label;
}

function detectSurface(originator, source) {
  const text = `${originator || ''} ${typeof source === 'string' ? source : ''}`.toLowerCase();
  if (text.includes('desktop') || text.includes('vscode')) return 'desktop';
  if (text.includes('cli') || text.includes('tui')) return 'cli';
  return 'codex';
}

class CodexScanner {
  constructor(options = {}) {
    this.sessionsDir = options.sessionsDir || SESSIONS_DIR;
    this.now = options.now || Date.now;
    this.files = new Map(); // path -> { mtimeMs, entries, meters, plan }
  }

  listFiles() {
    const out = [];
    const walk = (dir) => {
      let items;
      try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const it of items) {
        const p = path.join(dir, it.name);
        if (it.isDirectory()) walk(p);
        else if (it.isFile() && it.name.startsWith('rollout-') && it.name.endsWith('.jsonl')) out.push(p);
      }
    };
    walk(this.sessionsDir);
    return out;
  }

  parseFile(file) {
    // Full re-parse (rollout files are normally small). Keep the newest meter
    // for each duration so a single-window Desktop snapshot can coexist with a
    // dual-window CLI snapshot without either slot being mislabelled.
    const entries = [];
    const meters = new Map();
    let plan = null;
    let meta = null;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return { entries, meters: [], plan }; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      if (j.type === 'session_meta' && j.payload) meta = j.payload;
      const p = j.payload;
      if (!p || p.type !== 'token_count') continue;
      const ts = Date.parse(j.timestamp);
      if (!Number.isFinite(ts)) continue;
      const lu = p.info && p.info.last_token_usage;
      if (lu) {
        const cached = lu.cached_input_tokens || 0;
        entries.push({
          ts,
          in: Math.max(0, (lu.input_tokens || 0) - cached), // uncached input
          cached,
          out: (lu.output_tokens || 0) + (lu.reasoning_output_tokens || 0),
          total: lu.total_tokens || 0,
        });
      }
      const snapshot = p.rate_limits;
      if (!snapshot || typeof snapshot !== 'object') continue;
      for (const slot of ['primary', 'secondary']) {
        const meter = normalizeWindow(snapshot[slot], snapshot, ts, slot);
        if (!meter) continue;
        const previous = meters.get(meter.windowMinutes);
        if (!previous || meter.ts > previous.ts) meters.set(meter.windowMinutes, meter);
      }
      if (!plan || ts > plan.ts) {
        plan = {
          ts,
          limitId: typeof snapshot.limit_id === 'string' ? snapshot.limit_id : null,
          limitName: typeof snapshot.limit_name === 'string' ? snapshot.limit_name : null,
          planType: typeof snapshot.plan_type === 'string' ? snapshot.plan_type : null,
          credits: snapshot.credits && typeof snapshot.credits === 'object' ? snapshot.credits : null,
        };
      }
    }
    if (plan) {
      plan.originator = meta && meta.originator || null;
      plan.surface = detectSurface(plan.originator, meta && meta.source);
    }
    return { entries, meters: [...meters.values()], plan };
  }

  poll() {
    const seen = new Set();
    for (const file of this.listFiles()) {
      seen.add(file);
      let stat;
      try { stat = fs.statSync(file); } catch { continue; }
      const cached = this.files.get(file);
      if (!cached || cached.mtimeMs !== stat.mtimeMs) {
        this.files.set(file, { mtimeMs: stat.mtimeMs, ...this.parseFile(file) });
      }
    }
    for (const file of this.files.keys()) {
      if (!seen.has(file)) this.files.delete(file);
    }
  }

  getStats() {
    this.poll();
    const now = this.now();

    // Merge by actual duration, not by the server's primary/secondary slot.
    const metersByWindow = new Map();
    const allEntries = [];
    let plan = null;
    for (const f of this.files.values()) {
      for (const e of f.entries) allEntries.push(e);
      for (const meter of f.meters) {
        const previous = metersByWindow.get(meter.windowMinutes);
        if (!previous || meter.ts > previous.ts) metersByWindow.set(meter.windowMinutes, meter);
      }
      if (f.plan && (!plan || f.plan.ts > plan.ts)) plan = f.plan;
    }
    allEntries.sort((a, b) => a.ts - b.ts);

    // An expired snapshot must not make an old CLI 5-hour meter override a
    // current Desktop weekly plan meter. A new event will repopulate it.
    const currentMeters = [...metersByWindow.values()]
      .filter((m) => !m.resetsAt || m.resetsAt * 1000 > now)
      .sort((a, b) => a.windowMinutes - b.windowMinutes);
    const mainMeter = currentMeters[0] || null;
    const weeklyMeter = currentMeters[currentMeters.length - 1] || null;

    // Today's tokens + trailing-7-day cache-hit ratio include every local Codex
    // surface because Desktop and CLI share the same session store and account.
    const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
    const weekStart = now - 7 * 86400000;
    let dayTokens = 0, wkIn = 0, wkCached = 0;
    for (const e of allEntries) {
      if (e.ts >= dayStart.getTime()) dayTokens += e.total;
      if (e.ts >= weekStart) { wkIn += e.in + e.cached; wkCached += e.cached; }
    }
    const cacheHit = wkIn > 0 ? (wkCached / wkIn) * 100 : 0;
    const last = allEntries[allEntries.length - 1];
    const lastActivity = last ? last.ts : null;
    const hasData = !!mainMeter;
    const mainUsed = mainMeter ? mainMeter.usedPct : 0;
    const weeklyUsed = weeklyMeter ? weeklyMeter.usedPct : 0;
    const mainReset = mainMeter && mainMeter.resetsAt ? mainMeter.resetsAt * 1000 : null;
    const weeklyReset = weeklyMeter && weeklyMeter.resetsAt ? weeklyMeter.resetsAt * 1000 : null;
    const mainWindow = mainMeter ? formatWindowLabel(mainMeter.windowMinutes) : 'PLAN';
    const samePlanMeter = mainMeter && weeklyMeter && mainMeter.windowMinutes === weeklyMeter.windowMinutes;

    const fmtTok = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + 'B'
      : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M'
        : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(Math.round(n)));

    return {
      provider: 'codex',
      active: hasData,
      lastActivity,
      _sec: { sessionPct: hasData ? mainUsed : null, weeklyPct: hasData ? weeklyUsed : null },
      tach: {
        pct: mainUsed,
        text: hasData ? Math.round(mainUsed) + '%' : 'IDLE',
        sub: hasData ? `${fmtTok(dayTokens)} · ${countdown(mainReset && mainReset - now)}` : 'no plan data',
        red: mainUsed >= 80,
        label: `CODEX·${mainWindow}`,
        src: hasData ? 'server' : 'local', // rate_limits are server-authoritative
      },
      bars: [
        { label: samePlanMeter ? `PLAN·${mainWindow}` : 'WEEKLY', wk: true,
          fillPct: Math.max(0, 100 - weeklyUsed), tone: 'remaining',
          valText: `${Math.round(100 - weeklyUsed)}% left` },
        { label: 'CACHED', wk: false, fillPct: cacheHit, tone: 'info-blue',
          valText: `${Math.round(cacheHit)}% hit` },
      ],
      footer: {
        left: { val: fmtTok(dayTokens), label: 'today tok' },
        right: { val: countdownDays(weeklyReset && weeklyReset - now),
          label: samePlanMeter ? 'plan reset' : 'wk reset' },
      },
      live: !!(lastActivity && now - lastActivity < 90000),
      dataStatus: {
        kind: hasData ? 'official' : 'local',
        source: plan && plan.surface === 'desktop' ? 'codex-desktop-rollout' : 'codex-rollout',
        error: null,
      },
      plan: plan ? {
        type: plan.planType,
        limitId: plan.limitId,
        limitName: plan.limitName,
        surface: plan.surface,
        credits: plan.credits,
      } : null,
      // Every current server window represents a real plan limit.
      alertMeters: currentMeters.map((m) => ({
        label: meterAlertLabel(m), usedPct: m.usedPct,
      })),
    };
  }
}

function countdown(ms) {
  if (ms == null || ms <= 0) return '--:--';
  const m = Math.floor(ms / 60000);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}
function countdownDays(ms) {
  if (ms == null || ms <= 0) return '--';
  const h = Math.floor(ms / 3600000);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h >= 1) return `${h}h ${Math.floor((ms % 3600000) / 60000)}m`;
  return `${Math.floor(ms / 60000)}m`;
}

module.exports = { CodexScanner, available, formatWindowLabel, normalizeWindow };
