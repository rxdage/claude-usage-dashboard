// Local usage scanner: incrementally parses Claude Code transcript JSONL files
// under ~/.claude/projects and aggregates token usage into 5-hour billing blocks
// (same windowing approach as ccusage). No network, no credentials.
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const FIVE_HOURS = 5 * 60 * 60 * 1000;
const RETAIN_MS = 15 * 24 * 60 * 60 * 1000; // keep 15 days so weekly max has history

// USD per million tokens: [input, output, cacheWrite5m, cacheWrite1h, cacheRead]
const PRICING = [
  { match: /fable|mythos/, rates: [10, 50, 12.5, 20, 1] },
  { match: /opus-4-1|opus-4-0|opus-4-2025|claude-3-opus/, rates: [15, 75, 18.75, 30, 1.5] },
  { match: /opus/, rates: [5, 25, 6.25, 10, 0.5] },
  { match: /sonnet/, rates: [3, 15, 3.75, 6, 0.3] },
  { match: /haiku-4|haiku/, rates: [1, 5, 1.25, 2, 0.1] },
];

function ratesFor(model) {
  const m = (model || '').toLowerCase();
  for (const p of PRICING) if (p.match.test(m)) return p.rates;
  return [3, 15, 3.75, 6, 0.3]; // default to sonnet-tier
}

// Most recent occurrence of weekday `day` (0=Sun..6=Sat) at `hour`:00 local, <= now.
function weeklyResetStart(now, day, hour) {
  const d = new Date(now);
  const res = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, 0, 0, 0);
  const diff = (res.getDay() - day + 7) % 7;
  res.setDate(res.getDate() - diff);
  if (res.getTime() > now) res.setDate(res.getDate() - 7);
  return res.getTime();
}

function modelFamily(model) {
  const m = (model || '').toLowerCase();
  if (/fable|mythos/.test(m)) return 'FABLE';
  if (/opus/.test(m)) return 'OPUS';
  if (/sonnet/.test(m)) return 'SONNET';
  if (/haiku/.test(m)) return 'HAIKU';
  return 'OTHER';
}

class UsageScanner {
  constructor() {
    this.offsets = new Map(); // file -> bytes consumed
    this.partial = new Map(); // file -> trailing partial line
    this.seen = new Set();    // dedupe message.id:requestId
    this.entries = [];        // {ts, model, in, out, cw5m, cw1h, cr, cost}
    this.initialized = false;
  }

  listFiles() {
    const out = [];
    let dirs;
    try { dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }); }
    catch { return out; }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dir = path.join(PROJECTS_DIR, d.name);
      let files;
      try { files = fs.readdirSync(dir); } catch { continue; }
      for (const f of files) if (f.endsWith('.jsonl')) out.push(path.join(dir, f));
    }
    return out;
  }

  poll() {
    const cutoff = Date.now() - RETAIN_MS;
    for (const file of this.listFiles()) {
      let stat;
      try { stat = fs.statSync(file); } catch { continue; }
      // Skip files last modified before our retention window on first scan
      if (!this.offsets.has(file) && stat.mtimeMs < cutoff) {
        this.offsets.set(file, stat.size);
        continue;
      }
      const offset = this.offsets.get(file) || 0;
      if (stat.size < offset) { // truncated/rotated: re-read
        this.offsets.set(file, 0);
        this.partial.set(file, '');
      }
      if (stat.size <= (this.offsets.get(file) || 0)) continue;
      this.readAppended(file, this.offsets.get(file) || 0, stat.size);
    }
    // prune old entries
    if (this.entries.length && this.entries[0].ts < cutoff) {
      this.entries = this.entries.filter(e => e.ts >= cutoff);
    }
    // bound dedupe-set memory for long-running processes
    if (this.seen.size > 200000) this.seen.clear();
    this.initialized = true;
  }

  readAppended(file, from, to) {
    let fd;
    try { fd = fs.openSync(file, 'r'); } catch { return; }
    try {
      const len = to - from;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, from);
      this.offsets.set(file, to);
      let text = (this.partial.get(file) || '') + buf.toString('utf8');
      const lastNl = text.lastIndexOf('\n');
      if (lastNl === -1) { this.partial.set(file, text); return; }
      this.partial.set(file, text.slice(lastNl + 1));
      for (const line of text.slice(0, lastNl).split('\n')) {
        if (line.trim()) this.ingestLine(line);
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  ingestLine(line) {
    let j;
    try { j = JSON.parse(line); } catch { return; }
    if (j.type !== 'assistant' || !j.message || !j.message.usage) return;
    const u = j.message.usage;
    const model = j.message.model || '';
    if (model === '<synthetic>') return;
    const key = `${j.message.id || ''}:${j.requestId || j.uuid || ''}`;
    if (key !== ':' && this.seen.has(key)) return;
    if (key !== ':') this.seen.add(key);
    const ts = Date.parse(j.timestamp);
    if (!ts || ts < Date.now() - RETAIN_MS) return;
    const cc = u.cache_creation || {};
    const cw1h = cc.ephemeral_1h_input_tokens || 0;
    const cwTotal = u.cache_creation_input_tokens || 0;
    const cw5m = cc.ephemeral_5m_input_tokens != null ? cc.ephemeral_5m_input_tokens : Math.max(0, cwTotal - cw1h);
    const entry = {
      ts,
      model,
      family: modelFamily(model),
      in: u.input_tokens || 0,
      out: u.output_tokens || 0,
      cw5m,
      cw1h,
      cr: u.cache_read_input_tokens || 0,
    };
    const [ri, ro, rw5, rw1, rr] = ratesFor(model);
    entry.cost = (entry.in * ri + entry.out * ro + entry.cw5m * rw5 + entry.cw1h * rw1 + entry.cr * rr) / 1e6;
    entry.tokens = entry.in + entry.out + entry.cw5m + entry.cw1h + entry.cr;
    // insert keeping array roughly sorted (appends are usually in order)
    this.entries.push(entry);
    if (this.entries.length > 1 && entry.ts < this.entries[this.entries.length - 2].ts) {
      this.entries.sort((a, b) => a.ts - b.ts);
    }
  }

  // ccusage-style 5h blocks: a block starts at the entry's timestamp floored to
  // the hour; a new block begins when an entry falls past block end or after a
  // >=5h gap since the previous entry.
  computeBlocks() {
    const blocks = [];
    let cur = null;
    for (const e of this.entries) {
      if (!cur || e.ts >= cur.start + FIVE_HOURS || e.ts - cur.lastTs >= FIVE_HOURS) {
        const start = Math.floor(e.ts / 3600000) * 3600000;
        cur = { start, end: start + FIVE_HOURS, lastTs: e.ts, tokens: 0, cost: 0,
                in: 0, out: 0, cw: 0, cr: 0, families: new Set(), entries: [] };
        blocks.push(cur);
      }
      cur.lastTs = e.ts;
      cur.tokens += e.tokens;
      cur.cost += e.cost;
      cur.in += e.in;
      cur.out += e.out;
      cur.cw += e.cw5m + e.cw1h;
      cur.cr += e.cr;
      cur.families.add(e.family);
      cur.entries.push(e);
    }
    return blocks;
  }

  getStats(config) {
    this.poll();
    config = config || {};
    const now = Date.now();
    const blocks = this.computeBlocks();
    const last = blocks[blocks.length - 1];
    const active = last && now < last.end ? last : null;

    // Metering basis. Anthropic's limits scale with compute, not raw token
    // count — and raw counts are ~96% cheap cache-reads, which drags the % off.
    // So default to cost-weighted (input 1x, output 5x, cache-read 0.1x, ...),
    // which tracks /usage far better. Set metric:"tokens" for the old behavior.
    const metric = config.metric === 'tokens' ? 'tokens' : 'cost';
    const U = (o) => (metric === 'tokens' ? o.tokens : o.cost); // works on entries and blocks
    // config limit keys: prefer generic ones; fall back to legacy *TokenLimit
    const cfgLimit = (generic, legacy) =>
      typeof config[generic] === 'number' ? config[generic]
      : (metric === 'tokens' && typeof config[legacy] === 'number' ? config[legacy] : null);

    // ---- session (5h block) ----
    const activeVal = active ? U(active) : 0;
    let maxBlock = 0;
    for (const b of blocks) if (b !== active && U(b) > maxBlock) maxBlock = U(b);
    const sessionCfg = cfgLimit('sessionLimit', 'sessionTokenLimit');
    const sessionLimit = sessionCfg != null ? sessionCfg : Math.max(maxBlock, activeVal, 1e-6);

    // ---- weekly window anchored to the plan's fixed reset (default Mon 09:00) ----
    const resetDay = Number.isInteger(config.weeklyResetDay) ? config.weeklyResetDay : 1;
    const resetHour = Number.isInteger(config.weeklyResetHour) ? config.weeklyResetHour : 9;
    const weekStart = weeklyResetStart(now, resetDay, resetHour);
    const nextReset = weekStart + 7 * 86400000;
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    let weekTokens = 0, weekCost = 0, dayTokens = 0, dayCost = 0;
    const weekByFamily = {};
    for (const e of this.entries) {
      if (e.ts >= weekStart) {
        weekTokens += e.tokens; weekCost += e.cost;
        const f = weekByFamily[e.family] || (weekByFamily[e.family] = { tokens: 0, cost: 0 });
        f.tokens += e.tokens; f.cost += e.cost;
      }
      if (e.ts >= dayStart.getTime()) { dayTokens += e.tokens; dayCost += e.cost; }
    }
    const fableWeek = weekByFamily.FABLE || { tokens: 0, cost: 0 };
    const weekVal = U({ tokens: weekTokens, cost: weekCost });
    const fableVal = U(fableWeek);

    // all-model weekly limit: configured, or auto = heaviest rolling-7-day in history
    const weeklyCfg = cfgLimit('weeklyLimit', 'weeklyTokenLimit');
    let weeklyLimit;
    const weeklyIsAuto = weeklyCfg == null;
    if (!weeklyIsAuto) {
      weeklyLimit = weeklyCfg;
    } else {
      const days = new Map();
      for (const e of this.entries) {
        const d = Math.floor(e.ts / 86400000);
        days.set(d, (days.get(d) || 0) + U(e));
      }
      const idx = [...days.keys()].sort((a, b) => a - b);
      let maxWeek = 0;
      for (const startDay of idx) {
        let sum = 0;
        for (let d = startDay; d < startDay + 7; d++) sum += days.get(d) || 0;
        if (sum > maxWeek) maxWeek = sum;
      }
      weeklyLimit = Math.max(maxWeek, weekVal, 1e-6);
    }

    // Fable-5 weekly: "remaining" only meaningful with a configured limit.
    const fableLimit = cfgLimit('fableWeeklyLimit', 'fableWeeklyTokenLimit');
    const fableUsedPct = fableLimit != null ? Math.min(100, (fableVal / fableLimit) * 100) : null;

    const lastEntry = this.entries[this.entries.length - 1];
    return {
      now, metric,
      active: !!active,
      sessionPct: active ? Math.min(100, (activeVal / sessionLimit) * 100) : 0,
      sessionTokens: active ? active.tokens : 0,
      sessionCost: active ? active.cost : 0,
      sessionLimit,
      limitIsAuto: sessionCfg == null,
      blockStart: active ? active.start : null,
      blockEnd: active ? active.end : null,
      resetInMs: active ? active.end - now : 0,
      families: active ? [...active.families] : [],

      weekTokens, weekCost,
      weekResetInMs: nextReset - now,
      weeklyPct: Math.min(100, (weekVal / weeklyLimit) * 100),
      weeklyRemainingPct: weeklyIsAuto ? null : Math.max(0, 100 - (weekVal / weeklyLimit) * 100),
      weeklyIsAuto,

      fableWeekTokens: fableWeek.tokens,
      fableWeekCost: fableWeek.cost,
      fableLimit,
      fableUsedPct,
      fableRemainingPct: fableUsedPct == null ? null : Math.max(0, 100 - fableUsedPct),

      dayTokens, dayCost,
      lastActivity: lastEntry ? lastEntry.ts : null,
    };
  }
}

module.exports = { UsageScanner };
