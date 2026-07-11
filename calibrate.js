// One-shot re-calibration. After running `/usage`, pass the weekly percentages:
//   node calibrate.js <fable%> <all%> [session%]
// It reads your CURRENT used tokens (same window as the widget) and writes the
// implied limits into config.json. No math on your side.
const fs = require('fs');
const path = require('path');
const { UsageScanner } = require('./usage');

const CONFIG = path.join(__dirname, 'config.json');
const [fablePct, allPct, sessionPct] = process.argv.slice(2).map(Number);

if (!fablePct && !allPct && !sessionPct) {
  console.log('Usage: node calibrate.js <fable%> <all%> [session%]');
  console.log('Example (from /usage showing Fable 17%, all 14%):  node calibrate.js 17 14');
  process.exit(1);
}

let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch {}

// Calibrate on the cost-weighted basis (matches /usage far better than raw
// tokens, since ~96% of tokens are cheap cache-reads). Limits are stored in
// the same cost units the widget meters in.
cfg.metric = 'cost';

// drop legacy raw-token limits so they don't shadow the new cost-based ones
delete cfg.fableWeeklyTokenLimit;
delete cfg.weeklyTokenLimit;
delete cfg.sessionTokenLimit;

const scanner = new UsageScanner();
scanner.poll(); scanner.poll();
const s = scanner.getStats(cfg);

function set(key, usedCost, pct, label) {
  if (!pct || pct <= 0) return;
  const limit = usedCost / (pct / 100);
  cfg[key] = Math.round(limit * 100) / 100;
  console.log(`${label}: used $${usedCost.toFixed(2)} @ ${pct}%  ->  limit $${cfg[key].toFixed(2)}`);
}

set('fableWeeklyLimit', s.fableWeekCost, fablePct, 'Fable weekly');
set('weeklyLimit', s.weekCost, allPct, 'All  weekly');
if (sessionPct) set('sessionLimit', s.sessionCost, sessionPct, 'Session 5h ');

if (!Number.isInteger(cfg.weeklyResetDay)) cfg.weeklyResetDay = 1;
if (!Number.isInteger(cfg.weeklyResetHour)) cfg.weeklyResetHour = 9;

fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
console.log('\nWritten to config.json (cost-weighted) — widget picks it up within ~3s.');
