'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  pickFiles: () => ipcRenderer.invoke('pickFiles'),
  pickFolder: () => ipcRenderer.invoke('pickFolder'),
  openPopupLog: () => ipcRenderer.invoke('openPopupLog'),
  testPopup: () => ipcRenderer.invoke('testPopup'),
  restart: () => ipcRenderer.invoke('restart'),
  copyText: (text) => ipcRenderer.invoke('copyText', text),
  pickSave: (name) => ipcRenderer.invoke('pickSave', name),
  pickSaveFolder: () => ipcRenderer.invoke('pickSaveFolder'),
  openPath: (p) => ipcRenderer.invoke('openPath', p),
  showItem: (p) => ipcRenderer.invoke('showItem', p),
  setUnread: (n) => ipcRenderer.invoke('setUnread', n),
  focus: () => ipcRenderer.invoke('focus'),
  getAutostart: () => ipcRenderer.invoke('getAutostart'),
  setAutostart: (on) => ipcRenderer.invoke('setAutostart', on),
  getUpdate: () => ipcRenderer.invoke('getUpdate'),
  seenWhatsNew: () => ipcRenderer.invoke('seenWhatsNew'),
  checkUpdate: () => ipcRenderer.invoke('checkUpdate'),
  installUpdate: () => ipcRenderer.invoke('installUpdate'),
  setActiveConv: (conv) => ipcRenderer.send('activeConv', conv),
  onOpenSend: (cb) => ipcRenderer.on('openSend', () => cb()),
  onOpenConv: (cb) => ipcRenderer.on('openConv', (e, conv) => cb(conv)),
  onUpdate: (cb) => ipcRenderer.on('update', (e, state) => cb(state)),
  pathFor: (file) => { try { return webUtils.getPathForFile(file) || ''; } catch { return ''; } },
});
