const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('updater', {
  onStatus: (cb) => ipcRenderer.on('updater:status', (_e, s) => cb(s)),
  skip: () => ipcRenderer.send('updater:skip'),
});
