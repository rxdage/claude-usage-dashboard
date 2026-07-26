// ECO mode ("省流"): one per-provider switch that flips each tool's own
// built-in saver knob. Claude Code: settings.json `model: "opusplan"` (Opus
// plans, Sonnet codes — the CLI's Opus Plan Mode). Codex: config.toml
// `model_reasoning_effort` dropped to a cheaper tier. Applies to NEW CLI
// sessions; already-running sessions keep whatever they started with.
//
// The transforms are pure (text/object in, text/object out) so they're
// unit-testable; the thin fs wrappers at the bottom are what main.js uses.
// The previous value is always returned so the caller can stash it and
// restore EXACTLY what was there when the switch goes off.
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_ECO_MODEL = 'opusplan';
const CODEX_ECO_EFFORT = 'medium'; // vs the xhigh/high people usually run

function claudeSettingsPath() {
  return path.join(os.homedir(), '.claude', 'settings.json');
}
function codexConfigPath() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(home, 'config.toml');
}

// ---- pure transforms ----

// settings: parsed settings.json object (mutated copy returned).
// Returns { settings, prev } — prev is the model value that was replaced
// (null if the key wasn't set), only meaningful when turning ON.
function applyClaudeEco(settings, on, prevModel) {
  const s = { ...settings };
  if (on) {
    const prev = typeof s.model === 'string' ? s.model : null;
    s.model = CLAUDE_ECO_MODEL;
    return { settings: s, prev };
  }
  if (prevModel) s.model = prevModel;
  else delete s.model;
  return { settings: s, prev: null };
}

// toml: config.toml text. Only touches the top-level model_reasoning_effort
// line (before any [section]); everything else is preserved byte-for-byte.
function applyCodexEco(toml, on, prevEffort, ecoEffort = CODEX_ECO_EFFORT) {
  const lines = toml.split(/\r?\n/);
  const eol = toml.includes('\r\n') ? '\r\n' : '\n';
  let sectionStart = lines.findIndex((l) => /^\s*\[/.test(l));
  if (sectionStart === -1) sectionStart = lines.length;
  const keyRe = /^\s*model_reasoning_effort\s*=\s*["']?([^"'\s#]*)["']?/;
  let idx = -1, cur = null;
  for (let i = 0; i < sectionStart; i++) {
    const m = lines[i].match(keyRe);
    if (m) { idx = i; cur = m[1]; break; }
  }
  if (on) {
    const line = `model_reasoning_effort = "${ecoEffort}"`;
    if (idx >= 0) lines[idx] = line;
    else lines.splice(sectionStart, 0, line);
    return { toml: lines.join(eol), prev: cur };
  }
  if (idx >= 0) {
    if (prevEffort) lines[idx] = `model_reasoning_effort = "${prevEffort}"`;
    else lines.splice(idx, 1); // the key didn't exist before ECO — remove it
  }
  return { toml: lines.join(eol), prev: null };
}

// ---- status + fs wrappers ----

function ecoStatus() {
  const st = { claude: false, codex: false };
  try {
    const s = JSON.parse(fs.readFileSync(claudeSettingsPath(), 'utf8'));
    st.claude = s.model === CLAUDE_ECO_MODEL;
  } catch {}
  try {
    const t = fs.readFileSync(codexConfigPath(), 'utf8');
    const head = t.split(/\r?\n/);
    for (const l of head) {
      if (/^\s*\[/.test(l)) break;
      const m = l.match(/^\s*model_reasoning_effort\s*=\s*["']?([^"'\s#]*)/);
      if (m) { st.codex = m[1] === CODEX_ECO_EFFORT; break; }
    }
  } catch {}
  return st;
}

// Both writers return the pre-toggle value (or null) for the caller to keep.
function setClaudeEco(on, prevModel) {
  const p = claudeSettingsPath();
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
  const r = applyClaudeEco(settings, on, prevModel);
  fs.writeFileSync(p, JSON.stringify(r.settings, null, 2) + '\n');
  return r.prev;
}
function setCodexEco(on, prevEffort, ecoEffort) {
  const p = codexConfigPath();
  let toml = '';
  try { toml = fs.readFileSync(p, 'utf8'); } catch {}
  const r = applyCodexEco(toml, on, prevEffort, ecoEffort);
  fs.writeFileSync(p, r.toml);
  return r.prev;
}

module.exports = {
  applyClaudeEco, applyCodexEco, ecoStatus, setClaudeEco, setCodexEco,
  CLAUDE_ECO_MODEL, CODEX_ECO_EFFORT,
};
