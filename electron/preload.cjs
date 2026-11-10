// What the game page may ask of the desktop shell: Steam for online play
// (electron/steam.cjs) and a second game window for trying an online match alone.
const { contextBridge, ipcRenderer } = require('electron');

const handlers = [];
ipcRenderer.on('steam:event', (_e, event) => {
  for (const h of handlers) h(event);
});

contextBridge.exposeInMainWorld('plunderDesktop', {
  steam: {
    info: () => ipcRenderer.invoke('steam:info'),
    create: (max) => ipcRenderer.invoke('steam:create', max),
    join: (code) => ipcRenderer.invoke('steam:join', code),
    leave: () => ipcRenderer.invoke('steam:leave'),
    state: () => ipcRenderer.invoke('steam:state'),
    send: (to, reliable, data) => ipcRenderer.send('steam:send', to, reliable, data),
    invite: () => ipcRenderer.send('steam:invite'),
    on: (handler) => handlers.push(handler),
  },
  newWindow: () => ipcRenderer.send('plunder:new-window'),
});
