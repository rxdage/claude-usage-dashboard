const { app, BrowserWindow, ipcMain, Menu, Tray, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { UsageScanner } = require('./usage');

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

  try {
    tray = new Tray(path.join(__dirname, 'assets', 'icon.ico'));
    tray.setToolTip('Claude Usage Dashboard');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show / Hide', click: () => (win.isVisible() ? win.hide() : win.show()) },
      { label: 'Open config folder', click: () => {
        if (fs.existsSync(CONFIG_PATH)) shell.showItemInFolder(CONFIG_PATH);
        else shell.openPath(path.dirname(CONFIG_PATH));
      } },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]));
  } catch {}

  const scanner = new UsageScanner();
  const push = () => {
    if (!win || win.isDestroyed()) return;
    try {
      const stats = scanner.getStats(loadConfig());
      win.webContents.send('stats', stats);
    } catch (err) {
      win.webContents.send('stats-error', String(err));
    }
  };
  win.webContents.on('did-finish-load', push);
  setInterval(push, 3000);

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

ipcMain.on('close-app', () => app.quit());
ipcMain.on('hide-app', () => win && win.hide());

app.on('window-all-closed', () => app.quit());
