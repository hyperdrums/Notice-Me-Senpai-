const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onState: cb => ipcRenderer.on('state', (_e, s) => cb(s)),
  getState: () => ipcRenderer.invoke('get-state'),
  getVersion: () => ipcRenderer.invoke('get-version'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: c => ipcRenderer.invoke('save-config', c),
  refresh: () => ipcRenderer.invoke('refresh'),
  open: url => ipcRenderer.invoke('open', url),
  done: id => ipcRenderer.invoke('done', id),
  winMinimize: () => ipcRenderer.send('win-minimize'),
  winClose: () => ipcRenderer.send('win-close'),
  setBadge: b => ipcRenderer.send('badge', b),
});
