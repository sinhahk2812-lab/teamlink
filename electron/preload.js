'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  pickFiles: () => ipcRenderer.invoke('pickFiles'),
  pickFolder: () => ipcRenderer.invoke('pickFolder'),
  openPath: (p) => ipcRenderer.invoke('openPath', p),
  showItem: (p) => ipcRenderer.invoke('showItem', p),
  setUnread: (n) => ipcRenderer.invoke('setUnread', n),
  focus: () => ipcRenderer.invoke('focus'),
  getAutostart: () => ipcRenderer.invoke('getAutostart'),
  setAutostart: (on) => ipcRenderer.invoke('setAutostart', on),
  pathFor: (file) => { try { return webUtils.getPathForFile(file) || ''; } catch { return ''; } },
});
