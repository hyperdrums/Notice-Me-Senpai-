const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onState: cb => ipcRenderer.on('state', (_e, s) => cb(s)),
  getState: () => ipcRenderer.invoke('get-state'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: c => ipcRenderer.invoke('save-config', c),
  refresh: () => ipcRenderer.invoke('refresh'),
  open: url => ipcRenderer.invoke('open', url),
  done: id => ipcRenderer.invoke('done', id),
  setBadge: b => ipcRenderer.send('badge', b),
});
