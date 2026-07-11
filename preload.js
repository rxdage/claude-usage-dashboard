const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onStats: (cb) => ipcRenderer.on('stats', (_e, data) => cb(data)),
  onStatsError: (cb) => ipcRenderer.on('stats-error', (_e, msg) => cb(msg)),
  close: () => ipcRenderer.send('close-app'),
  hide: () => ipcRenderer.send('hide-app'),
  // calibration dialog
  calGetCurrent: () => ipcRenderer.invoke('cal:getCurrent'),
  calApply: (pct) => ipcRenderer.invoke('cal:apply', pct),
  calClose: () => ipcRenderer.send('cal:close'),
});
