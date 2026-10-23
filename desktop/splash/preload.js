'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('splash', {
  onStatus: (handler) => ipcRenderer.on('splash:status', (_event, info) => handler(info)),
  skip: () => ipcRenderer.send('splash:skip'),
});
