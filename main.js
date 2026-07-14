const { app, BrowserWindow, ipcMain, Menu, Tray, screen, shell, safeStorage, net, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { Providers } = require('./providers');
const { credentialStatus } = require('./providers/claude');

// In a packaged build __dirname lives inside the read-only asar, so config must
// live in userData. In dev (npm start) keep it in the project dir so `npm run
// cal` and the app read/write the same file.
const CONFIG_PATH = app.isPackaged
  ? path.join(app.getPath('userData'), 'config.json')
  : path.join(__dirname, 'config.json');
const WIN_W = 300, WIN_H_SINGLE = 118, WIN_H_DUAL = 140;
let winH = WIN_H_SINGLE; // current height (grows when the secondary strip shows)
const SNAP = 26; // px: distance to a screen edge that triggers magnetic snap

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}
function saveConfig(cfg) {
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); } catch {}
}

let win = null;
let tray = null;
let calWin = null;
let setupWin = null;
let providers = null;
let pushStats = null;
let lastPrimaryName = null;

// Locate the Claude Code CLI: PATH, then the desktop app's bundled copy under
// %LOCALAPPDATA%\Packages\Claude_*\...\claude-code\<version>\claude.exe (newest).
function findClaudeCli() {
  const out = [];
  const bases = [];
  const LA = process.env.LOCALAPPDATA, AD = process.env.APPDATA;
  if (LA) {
    try {
      for (const d of fs.readdirSync(path.join(LA, 'Packages'), { withFileTypes: true })) {
        if (d.isDirectory() && /^Claude_/i.test(d.name)) {
          bases.push(path.join(LA, 'Packages', d.name, 'LocalCache', 'Roaming', 'Claude', 'claude-code'));
        }
      }
    } catch {}
  }
  if (AD) bases.push(path.join(AD, 'Claude', 'claude-code'));
  const cmp = (a, b) => b.localeCompare(a, undefined, { numeric: true }); // newest first
  for (const base of bases) {
    let vers = [];
    try { vers = fs.readdirSync(base).filter((v) => { try { return fs.existsSync(path.join(base, v, 'claude.exe')); } catch { return false; } }); } catch {}
    vers.sort(cmp);
    for (const v of vers) out.push(path.join(base, v, 'claude.exe'));
  }
  return out[0] || null;
}

// Resolve the system proxy for Anthropic (so the spawned CLI works behind Clash
// etc., the exact thing that 403'd the manual attempt).
async function systemProxy() {
  try {
    const r = await session.defaultSession.resolveProxy('https://api.anthropic.com');
    const m = /PROXY\s+([^;]+)/i.exec(r || '');
    if (m) return 'http://' + m[1].trim();
  } catch {}
  return null;
}

// Open a visible terminal that signs in via `claude auth login --claudeai`
// (opens the browser automatically — no /login typing), with the proxy injected.
async function launchClaudeLogin() {
  const cli = findClaudeCli();
  if (!cli) throw new Error('claude-cli-not-found');
  const proxy = await systemProxy();
  const bat = path.join(app.getPath('temp'), 'claude-usage-login.cmd');
  const lines = ['@echo off', 'title Claude sign-in'];
  if (proxy) { lines.push(`set HTTPS_PROXY=${proxy}`, `set HTTP_PROXY=${proxy}`); }
  lines.push(
    'echo Signing in to Claude - approve in the browser window that opens.',
    'echo.',
    'echo NOTE: if you are asked to paste a code, the paste will NOT appear on',
    'echo screen - it is read like a password. Right-click the window to paste,',
    'echo then press Enter. A blank line is normal.',
    'echo.',
    `"${cli}" auth login --claudeai`,
    'echo.',
    'echo Done. You can close this window.',
    'pause',
  );
  fs.writeFileSync(bat, lines.join('\r\n'));
  // spawn('cmd.exe') resolves the bare name via PATH only — a corrupted PATH
  // entry (e.g. "WINDOWS\system32" missing its drive letter, seen in the
  // field) makes that ENOENT. %ComSpec% is maintained by Windows itself and
  // is always an absolute path to cmd.exe.
  const shell = process.env.ComSpec
    || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  // windowsVerbatimArguments: node's default arg escaping turns the pre-quoted
  // title into \"Claude sign-in\", which cmd's quote-toggling parser mangles
  // into an attempt to run a file named 'sign-in\'. Verbatim mode passes the
  // exact line a human would type: start "Claude sign-in" "<bat>".
  await new Promise((resolve, reject) => {
    const child = spawn(shell, ['/c', `start "Claude sign-in" "${bat}"`], {
      detached: true, stdio: 'ignore', windowsVerbatimArguments: true,
    });
    // Without these handlers a spawn failure surfaces after this function has
    // already returned, as an uncaught exception dialog instead of an error
    // in the setup wizard.
    child.once('spawn', () => { child.unref(); resolve(); });
    child.once('error', reject);
  });
}

function createWindow() {
  const cfg = loadConfig();
  // Size once at creation from provider detection. Runtime resizes of a
  // transparent frameless window cause a visible rectangular outline on
  // Windows (the setResizable toggle briefly drops the transparent surface),
  // so we pick the height up front and never resize afterwards.
  const have = providers.detect();
  winH = have.claude && have.codex ? WIN_H_DUAL : WIN_H_SINGLE;
  // default to the top-right corner of the primary display
  let dx = cfg.x, dy = cfg.y;
  if (typeof dx !== 'number' || typeof dy !== 'number') {
    const area = screen.getPrimaryDisplay().workArea;
    dx = area.x + area.width - WIN_W - 16;
    dy = area.y + 16;
  }
  win = new BrowserWindow({
    width: WIN_W,
    height: winH,
    x: dx, y: dy,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  if (typeof cfg.opacity === 'number') win.setOpacity(Math.min(1, Math.max(0.3, cfg.opacity)));
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Magnetic edge snap: on Windows 'moved' fires continuously during a drag,
  // and calling setPosition mid-drag fights the OS drag loop. So snap only
  // after the position has been stable for a beat (i.e. the user let go).
  let settleTimer = null;
  win.on('moved', () => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      const [x, y] = win.getPosition();
      const area = screen.getDisplayMatching(win.getBounds()).workArea;
      let nx = x, ny = y;
      if (Math.abs(x - area.x) <= SNAP) nx = area.x;
      else if (Math.abs((x + WIN_W) - (area.x + area.width)) <= SNAP) nx = area.x + area.width - WIN_W;
      if (Math.abs(y - area.y) <= SNAP) ny = area.y;
      else if (Math.abs((y + winH) - (area.y + area.height)) <= SNAP) ny = area.y + area.height - winH;
      if (nx !== x || ny !== y) win.setPosition(nx, ny);
      const c = loadConfig();
      c.x = nx; c.y = ny;
      saveConfig(c);
    }, 260);
  });
}

// single instance: relaunching just reveals the existing widget. The usage
// probe is a headless diagnostic and must be allowed to run alongside it.
const probeUsage = process.argv.includes('--probe-usage');
const gotLock = probeUsage || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { win.show(); win.focus(); }
  });
}

function makeProviders() {
  const cfg = loadConfig();
  return new Providers({
    claudeOptions: {
      safeStorage,
      // Electron's net.fetch honors the system/Claude-Desktop proxy config,
      // unlike Node's global fetch. Only used when official usage is opted in.
      fetchFn: (url, options) => net.fetch(url, options),
      // default true; set config.officialUsageWriteBack=false for memory-only
      writeBackTokens: cfg.officialUsageWriteBack !== false,
    },
  });
}

app.whenReady().then(async () => {
  if (!gotLock) return;
  providers = makeProviders();

  // `electron . --probe-usage` — verify official-usage credentials/fetch
  // without opening a window. Prints status only, never the token.
  if (probeUsage) {
    try {
      const cfg = Object.assign({}, loadConfig(), { officialUsage: true });
      const payload = await providers.getPayload(cfg);
      console.log(JSON.stringify({
        provider: payload.provider,
        session: payload.tach && payload.tach.text,
        sessionSub: payload.tach && payload.tach.sub,
        bars: (payload.bars || []).map((b) => ({ label: b.label, value: b.valText })),
        dataStatus: payload.dataStatus || null,
      }, null, 2));
    } catch (e) { console.error(String(e)); process.exitCode = 1; }
    app.quit();
    return;
  }

  createWindow();

  try {
    tray = new Tray(path.join(__dirname, 'assets', 'icon.ico'));
    tray.setToolTip('Claude Usage Dashboard');
    buildTrayMenu();
  } catch {}

  // getPayload is async (official usage may await a network call). Guard against
  // overlapping ticks so a slow fetch never stacks up requests.
  let pushing = false, pushAgain = false;
  const push = async () => {
    if (!win || win.isDestroyed()) return;
    if (pushing) { pushAgain = true; return; }
    pushing = true;
    try {
      const payload = await providers.getPayload(loadConfig());
      if (!win || win.isDestroyed()) return;
      if (payload.primaryName !== lastPrimaryName) {
        lastPrimaryName = payload.primaryName;
        buildTrayMenu();
      }
      win.webContents.send('stats', payload);
    } catch (err) {
      if (win && !win.isDestroyed()) win.webContents.send('stats-error', String(err));
    } finally {
      pushing = false;
      if (pushAgain) { pushAgain = false; setImmediate(push); }
    }
  };
  pushStats = () => { void push(); };
  win.webContents.on('did-finish-load', pushStats);
  setInterval(pushStats, 3000);

  // Debug: `electron . --shot-setup=<path>` captures the setup wizard
  const setupShotArg = process.argv.find((a) => a.startsWith('--shot-setup='));
  if (setupShotArg) {
    const out = setupShotArg.slice('--shot-setup='.length);
    openSetupWindow();
    setTimeout(async () => {
      try {
        const img = await setupWin.webContents.capturePage();
        fs.writeFileSync(out, img.toPNG());
      } catch (e) { console.error(e); }
      app.quit();
    }, 2500);
  }

  // Debug: `electron . --shot-cal=<path>` captures the calibration dialog
  const calShotArg = process.argv.find((a) => a.startsWith('--shot-cal='));
  if (calShotArg) {
    const out = calShotArg.slice('--shot-cal='.length);
    openCalibrateWindow();
    setTimeout(async () => {
      try {
        const img = await calWin.webContents.capturePage();
        fs.writeFileSync(out, img.toPNG());
      } catch (e) { console.error(e); }
      app.quit();
    }, 2500);
  }

  // Debug: `electron . --shot=<path>` captures the rendered widget and exits.
  // Add --click-el=<domId> to click an element first (tests button wiring E2E).
  const shotArg = process.argv.find((a) => a.startsWith('--shot='));
  if (shotArg) {
    const out = shotArg.slice('--shot='.length);
    const clickArg = process.argv.find((a) => a.startsWith('--click-el='));
    setTimeout(async () => {
      try {
        if (clickArg) {
          const id = clickArg.slice('--click-el='.length);
          await win.webContents.executeJavaScript(
            `document.getElementById(${JSON.stringify(id)}).click(); 'clicked'`);
          await new Promise((r) => setTimeout(r, 1500)); // let IPC + repush land
        }
        const img = await win.webContents.capturePage();
        fs.writeFileSync(out, img.toPNG());
        console.log('SHOT_OK bounds=' + JSON.stringify(win.getBounds()));
      } catch (e) { console.error(e); }
      app.quit();
    }, 3500);
  }
});

function buildTrayMenu() {
  if (!tray) return;
  const have = providers.detect();
  const cfg = loadConfig();
  const mode = require('./providers').Providers.modeFrom(cfg);
  const items = [
    { label: 'Show / Hide', click: () => (win.isVisible() ? win.hide() : win.show()) },
  ];
  // provider selection only matters when both data sources exist
  if (have.claude && have.codex) {
    const followLabel = lastPrimaryName
      ? `Auto-follow (now: ${lastPrimaryName === 'codex' ? 'Codex' : 'Claude'})`
      : 'Auto-follow';
    items.push({
      label: 'Data source',
      submenu: [
        { label: followLabel, type: 'radio', checked: mode === 'auto',
          click: () => setProviderMode('auto') },
        { label: 'Pin Claude Code', type: 'radio', checked: mode === 'claude',
          click: () => setProviderMode('claude') },
        { label: 'Pin Codex', type: 'radio', checked: mode === 'codex',
          click: () => setProviderMode('codex') },
      ],
    });
  }
  if (have.claude) {
    items.push({ label: 'Calibrate…', click: () => openCalibrateWindow() });
    items.push({ label: 'Set up official usage…', click: () => openSetupWindow() });
  }
  items.push(
    { label: 'Open config folder', click: () => {
      if (fs.existsSync(CONFIG_PATH)) shell.showItemInFolder(CONFIG_PATH);
      else shell.openPath(path.dirname(CONFIG_PATH));
    } },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  );
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function setProviderMode(mode) {
  const c = loadConfig();
  c.providerMode = mode;
  delete c.provider; delete c.activeProvider; // legacy keys
  saveConfig(c);
  providers.clearHold(); // explicit mode change overrides any manual-swap hold
  if (pushStats) pushStats();
  buildTrayMenu();
}

// ---- Official-usage setup wizard ----
function openSetupWindow() {
  if (setupWin && !setupWin.isDestroyed()) { setupWin.focus(); return; }
  setupWin = new BrowserWindow({
    width: 400, height: 430,
    resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    title: 'Official usage setup',
    alwaysOnTop: true,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  setupWin.setMenuBarVisibility(false);
  setupWin.loadFile(path.join(__dirname, 'renderer', 'setup.html'));
  setupWin.on('closed', () => { setupWin = null; });
}

// non-secret status snapshot for the wizard
ipcMain.handle('setup:state', async () => {
  const cred = credentialStatus();
  const cfg = loadConfig();
  let server = false;
  if (cfg.officialUsage && cred.loggedIn && cred.hasProfileScope) {
    try {
      const p = await providers.getPayload(Object.assign({}, cfg, { officialUsage: true }));
      server = p.dataStatus && p.dataStatus.kind === 'official';
    } catch {}
  }
  return {
    cliFound: !!findClaudeCli(),
    proxy: await systemProxy(),
    officialUsage: !!cfg.officialUsage,
    loggedIn: !!cred.loggedIn,
    hasProfileScope: !!cred.hasProfileScope,
    accessExpired: !!cred.accessExpired,
    refreshExpired: !!cred.refreshExpired,
    subscriptionType: cred.subscriptionType || null,
    server,
  };
});

ipcMain.handle('setup:login', async () => {
  try { await launchClaudeLogin(); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});

// enable official usage in config and force one refresh, returns the resulting kind
ipcMain.handle('setup:enable', async () => {
  const c = loadConfig();
  c.officialUsage = true;
  saveConfig(c);
  try {
    const p = await providers.getPayload(Object.assign({}, c, { officialUsage: true }));
    if (pushStats) pushStats();
    return { kind: p.dataStatus ? p.dataStatus.kind : 'estimate' };
  } catch (e) { return { kind: 'estimate', error: String(e) }; }
});

ipcMain.on('setup:close', () => { if (setupWin && !setupWin.isDestroyed()) setupWin.close(); });

// ---- Calibration dialog ----
function openCalibrateWindow() {
  if (calWin && !calWin.isDestroyed()) { calWin.focus(); return; }
  calWin = new BrowserWindow({
    width: 340, height: 340,
    resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    title: 'Calibrate — Claude Usage Dashboard',
    alwaysOnTop: true,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  calWin.setMenuBarVisibility(false);
  calWin.loadFile(path.join(__dirname, 'renderer', 'calibrate.html'));
  calWin.on('closed', () => { calWin = null; });
}

// current cost-weighted usage, so the dialog can show reference numbers
ipcMain.handle('cal:getCurrent', () => {
  try {
    const st = providers.claudeScanner().getStats(loadConfig());
    return { fableCost: st.fableWeekCost, allCost: st.weekCost, sessionCost: st.sessionCost };
  } catch { return { fableCost: 0, allCost: 0, sessionCost: 0 }; }
});

// apply: back-solve cost-weighted limits from the entered official percentages
ipcMain.handle('cal:apply', (_e, pct) => {
  const st = providers.claudeScanner().getStats(loadConfig());
  const c = loadConfig();
  c.metric = 'cost';
  delete c.fableWeeklyTokenLimit; delete c.weeklyTokenLimit; delete c.sessionTokenLimit;
  const set = (key, usedCost, p) => {
    const v = Number(p);
    if (v > 0) c[key] = Math.round((usedCost / (v / 100)) * 100) / 100;
  };
  set('fableWeeklyLimit', st.fableWeekCost, pct.fable);
  set('weeklyLimit', st.weekCost, pct.all);
  set('sessionLimit', st.sessionCost, pct.session);
  if (!Number.isInteger(c.weeklyResetDay)) c.weeklyResetDay = 1;
  if (!Number.isInteger(c.weeklyResetHour)) c.weeklyResetHour = 9;
  saveConfig(c);
  if (pushStats) pushStats(); // refresh the widget immediately
  return { ok: true };
});

ipcMain.on('cal:close', () => { if (calWin && !calWin.isDestroyed()) calWin.close(); });

// ⇄ swap: ALWAYS switches the primary and NEVER touches the pin state.
// - auto mode: flip the in-memory choice with a temporary hold (config stays
//   auto; auto-follow resumes after the hold or on the next pin/tray action)
// - pinned mode: re-pin to the other provider
ipcMain.on('swap-provider', () => {
  const { Providers } = require('./providers');
  const mode = Providers.modeFrom(loadConfig());
  const other = lastPrimaryName === 'codex' ? 'claude' : 'codex';
  if (mode === 'auto') {
    providers.forcePrimary(other);
    if (pushStats) pushStats();
  } else {
    setProviderMode(other);
  }
});

// PIN: independent toggle — pin the CURRENT primary, or back to auto-follow.
ipcMain.on('toggle-pin', () => {
  const { Providers } = require('./providers');
  const mode = Providers.modeFrom(loadConfig());
  if (mode === 'auto') setProviderMode(lastPrimaryName || 'claude');
  else setProviderMode('auto');
});

ipcMain.on('close-app', () => app.quit());
ipcMain.on('hide-app', () => win && win.hide());

// keep the app alive while only the widget is hidden; quit when the widget
// itself is closed (calibrate window closing must not quit the app)
app.on('window-all-closed', () => app.quit());
