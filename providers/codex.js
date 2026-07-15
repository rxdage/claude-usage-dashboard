// Codex (OpenAI Codex CLI) usage scanner.
// Reads ~/.codex/sessions/**/rollout-*.jsonl. Each `token_count` event carries
//   - info.last_token_usage : per-turn tokens (input/cached_input/output/reasoning)
//   - rate_limits.primary    : 5-hour window (used_percent, window_minutes 300, resets_at)
//   - rate_limits.secondary  : weekly window (used_percent, window_minutes 10080, resets_at)
// The official percentages are right here — no calibration needed.
const fs = require('fs');
const path = require('path');
const os = require('os');

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const SESSIONS_DIR = path.join(CODEX_HOME, 'sessions');

function available() {
  try { return fs.statSync(SESSIONS_DIR).isDirectory(); } catch { return false; }
}

class CodexScanner {
  constructor() {
    this.files = new Map(); // path -> { mtimeMs, entries, latest }
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
    walk(SESSIONS_DIR);
    return out;
  }

  parseFile(file) {
    // Full re-parse (rollout files are small). Returns { entries, latest }.
    const entries = [];
    let latest = null; // { ts, rate_limits }
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return { entries, latest }; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      const p = j.payload;
      if (!p || p.type !== 'token_count') continue;
      const ts = Date.parse(j.timestamp);
      const lu = p.info && p.info.last_token_usage;
      if (lu && ts) {
        const cached = lu.cached_input_tokens || 0;
        entries.push({
          ts,
          in: Math.max(0, (lu.input_tokens || 0) - cached), // uncached input
          cached,
          out: (lu.output_tokens || 0) + (lu.reasoning_output_tokens || 0),
          total: lu.total_tokens || 0,
        });
      }
      if (p.rate_limits && ts && (!latest || ts > latest.ts)) {
        latest = { ts, rate_limits: p.rate_limits };
      }
    }
    return { entries, latest };
  }

  poll() {
    for (const file of this.listFiles()) {
      let stat;
      try { stat = fs.statSync(file); } catch { continue; }
      const cached = this.files.get(file);
      if (!cached || cached.mtimeMs !== stat.mtimeMs) {
        this.files.set(file, { mtimeMs: stat.mtimeMs, ...this.parseFile(file) });
      }
    }
  }

  // advance a unix-seconds reset time forward by the window until it's > now
  static nextReset(resetsAtSec, windowMin, now) {
    if (!resetsAtSec) return null;
    let t = resetsAtSec * 1000;
    const win = windowMin * 60000;
    if (win > 0) while (t <= now) t += win;
    return t;
  }

  getStats() {
    this.poll();
    const now = Date.now();

    // most recent rate_limits snapshot across all sessions
    let latest = null;
    const allEntries = [];
    for (const f of this.files.values()) {
      for (const e of f.entries) allEntries.push(e);
      if (f.latest && (!latest || f.latest.ts > latest.ts)) latest = f.latest;
    }
    allEntries.sort((a, b) => a.ts - b.ts);

    const rl = latest && latest.rate_limits ? latest.rate_limits : {};
    const prim = rl.primary || {};
    const sec = rl.secondary || {};

    // A snapshot's used_percent is valid until its window resets. If the window
    // has already rolled over since the last activity, show 0.
    const primResetAt = (prim.resets_at || 0) * 1000;
    const secResetAt = (sec.resets_at || 0) * 1000;
    const primUsed = primResetAt && now > primResetAt ? 0 : (prim.used_percent || 0);
    const secUsed = secResetAt && now > secResetAt ? 0 : (sec.used_percent || 0);
    const primNextReset = CodexScanner.nextReset(prim.resets_at, prim.window_minutes || 300, now);
    const secNextReset = CodexScanner.nextReset(sec.resets_at, sec.window_minutes || 10080, now);

    // today's tokens + weekly cache-hit ratio
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const weekStart = now - 7 * 86400000;
    let dayTokens = 0, wkIn = 0, wkCached = 0;
    for (const e of allEntries) {
      if (e.ts >= dayStart.getTime()) dayTokens += e.total;
      if (e.ts >= weekStart) { wkIn += e.in + e.cached; wkCached += e.cached; }
    }
    const cacheHit = wkIn > 0 ? (wkCached / wkIn) * 100 : 0;
    const last = allEntries[allEntries.length - 1];
    const lastActivity = last ? last.ts : null;
    const hasData = !!latest;

    const fmtTok = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + 'B'
      : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M'
      : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(Math.round(n)));

    return {
      provider: 'codex',
      active: hasData,
      lastActivity,
      _sec: { sessionPct: hasData ? primUsed : null, weeklyPct: hasData ? secUsed : null },
      tach: {
        pct: primUsed,
        text: hasData ? Math.round(primUsed) + '%' : 'IDLE',
        sub: hasData ? `${fmtTok(dayTokens)} · ${countdown(primNextReset - now)}` : 'no data',
        red: primUsed >= 80,
        label: 'CODEX·5H',
        src: hasData ? 'server' : 'local', // Codex rate_limits are official
      },
      bars: [
        { label: 'WEEKLY', wk: true, fillPct: Math.max(0, 100 - secUsed), tone: 'remaining',
          valText: `${Math.round(100 - secUsed)}% left` },
        { label: 'CACHED', wk: false, fillPct: cacheHit, tone: 'info-blue',
          valText: `${Math.round(cacheHit)}% hit` },
      ],
      footer: {
        left: { val: fmtTok(dayTokens), label: 'today tok' },
        right: { val: countdownDays(secNextReset - now), label: 'wk reset' },
      },
      live: lastActivity && now - lastActivity < 90000,
      // Codex rate_limits are official server percentages -> real alert meters.
      alertMeters: hasData
        ? [{ label: '5-hour', usedPct: primUsed }, { label: 'Weekly', usedPct: secUsed }]
        : [],
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

module.exports = { CodexScanner, available };
