const { app, BrowserWindow, ipcMain, Menu, Tray, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { Providers } = require('./providers');

// In a packaged build __dirname lives inside the read-only asar, so config must
// live in userData. In dev (npm start) keep it in the project dir so `npm run
// cal` and the app read/write the same file.
const CONFIG_PATH = app.isPackaged
  ? path.join(app.getPath('userData'), 'config.json')
  : path.join(__dirname, 'config.json');
const WIN_W = 300, WIN_H = 118;
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
let providers = null;
let pushStats = null;

function createWindow() {
  const cfg = loadConfig();
  // default to the top-right corner of the primary display
  let dx = cfg.x, dy = cfg.y;
  if (typeof dx !== 'number' || typeof dy !== 'number') {
    const area = screen.getPrimaryDisplay().workArea;
    dx = area.x + area.width - WIN_W - 16;
    dy = area.y + 16;
  }
  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: dx, y: dy,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    frame: false,
    transparent: true,
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
      else if (Math.abs((y + WIN_H) - (area.y + area.height)) <= SNAP) ny = area.y + area.height - WIN_H;
      if (nx !== x || ny !== y) win.setPosition(nx, ny);
      const c = loadConfig();
      c.x = nx; c.y = ny;
      saveConfig(c);
    }, 260);
  });
}

// single instance: relaunching just reveals the existing widget
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { win.show(); win.focus(); }
  });
}

app.whenReady().then(() => {
  if (!gotLock) return;
  createWindow();

  providers = new Providers();

  try {
    tray = new Tray(path.join(__dirname, 'assets', 'icon.ico'));
    tray.setToolTip('Claude Usage Dashboard');
    buildTrayMenu();
  } catch {}

  const push = () => {
    if (!win || win.isDestroyed()) return;
    try {
      const payload = providers.getPayload(loadConfig());
      win.webContents.send('stats', payload);
    } catch (err) {
      win.webContents.send('stats-error', String(err));
    }
  };
  pushStats = push;
  win.webContents.on('did-finish-load', push);
  setInterval(push, 3000);

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

  // Debug: `electron . --shot=<path>` captures the rendered widget and exits
  const shotArg = process.argv.find((a) => a.startsWith('--shot='));
  if (shotArg) {
    const out = shotArg.slice('--shot='.length);
    setTimeout(async () => {
      try {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(out, img.toPNG());
      } catch (e) { console.error(e); }
      app.quit();
    }, 3500);
  }
});

function buildTrayMenu() {
  if (!tray) return;
  const have = providers.detect();
  const cfg = loadConfig();
  const active = providers.resolve(cfg);
  const items = [
    { label: 'Show / Hide', click: () => (win.isVisible() ? win.hide() : win.show()) },
  ];
  // provider switch only when both data sources exist
  if (have.claude && have.codex) {
    items.push({
      label: 'Data source',
      submenu: [
        { label: 'Claude Code', type: 'radio', checked: active === 'claude',
          click: () => setProvider('claude') },
        { label: 'Codex', type: 'radio', checked: active === 'codex',
          click: () => setProvider('codex') },
      ],
    });
  }
  if (active === 'claude') {
    items.push({ label: 'Calibrate…', click: () => openCalibrateWindow() });
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

function setProvider(name) {
  const c = loadConfig();
  c.provider = 'auto';       // keep auto-detect, but remember the chosen active one
  c.activeProvider = name;
  saveConfig(c);
  if (pushStats) pushStats();
  buildTrayMenu();
}

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

ipcMain.on('close-app', () => app.quit());
ipcMain.on('hide-app', () => win && win.hide());

// keep the app alive while only the widget is hidden; quit when the widget
// itself is closed (calibrate window closing must not quit the app)
app.on('window-all-closed', () => app.quit());
