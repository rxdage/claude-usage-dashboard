const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onStats: (cb) => ipcRenderer.on('stats', (_e, data) => cb(data)),
  onStatsError: (cb) => ipcRenderer.on('stats-error', (_e, msg) => cb(msg)),
  close: () => ipcRenderer.send('close-app'),
  hide: () => ipcRenderer.send('hide-app'),
});
