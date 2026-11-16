'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('popup', {
  onData: (cb) => { ipcRenderer.on('popupData', (e, d) => cb(d)); ipcRenderer.send('popupReady'); },
  open: () => ipcRenderer.send('popupOpen'),
  close: () => ipcRenderer.send('popupClose'),
});
