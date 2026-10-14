'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const version = (process.argv.find((arg) => arg.startsWith('--app-version=')) || '').split('=')[1] || '';

// The page runs unchanged in a browser, where this object simply isn't there.
contextBridge.exposeInMainWorld('chatReaderDesktop', {
  version,
  platform: process.platform,

  // Hands the current bindings to the OS. Resolves with which ones took, and
  // why the others didn't, so the Keys section can say so.
  applyHotkeys: (payload) => ipcRenderer.invoke('hotkeys:apply', payload),

  // macOS hands the ⏯ key only to apps trusted for accessibility; this opens
  // that prompt.
  requestAccessibility: () => ipcRenderer.invoke('hotkeys:accessibility-prompt'),

  onAction: (handler) => {
    const listener = (_event, action) => handler(action);
    ipcRenderer.on('hotkey-action', listener);
    return () => ipcRenderer.off('hotkey-action', listener);
  },

  // Keeps the tray menu and tooltip in step with the reader.
  setState: (state) => ipcRenderer.send('state:update', state),

  toggleWindow: () => ipcRenderer.send('window:toggle'),
  hideWindow: () => ipcRenderer.send('window:hide'),
  openExternal: (url) => ipcRenderer.send('shell:open-external', url),
});
