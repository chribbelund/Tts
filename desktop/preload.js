'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const argValue = (name) => {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : '';
};
const version = argValue('app-version');

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

  // A real save / open dialog, which the page can't put up on its own.
  saveFile: (name, text) => ipcRenderer.invoke('settings:save', { name, text }),
  openFile: () => ipcRenderer.invoke('settings:open'),

  // YouTube and TikTok chat, which only the app can reach. `id` is the page's
  // name for one chat, since several can run on the same platform. Each event
  // is { id, type: 'status' | 'message' | 'delete' | 'clear', … }.
  connectSource: (id, platform, target) => ipcRenderer.invoke('source:connect', { id, platform, target }),
  disconnectSource: (id) => ipcRenderer.invoke('source:disconnect', { id }),
  onSourceEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('source:event', listener);
    return () => ipcRenderer.off('source:event', listener);
  },

  // The bot (desktop/bot/, docs/bot-plan.md). The page loads its scripts from
  // `base`; everything else is what only the main process can do.
  bot: {
    base: argValue('bot-base'),
    readStore: (name) => ipcRenderer.invoke('bot:store-read', name),
    writeStore: (name, text) => ipcRenderer.send('bot:store-write', name, text),
    getSecret: (name) => ipcRenderer.invoke('bot:secret-get', name),
    setSecret: (name, value) => ipcRenderer.invoke('bot:secret-set', name, value),
    secureStorage: () => ipcRenderer.invoke('bot:secure-storage'),
    pickFile: (options) => ipcRenderer.invoke('bot:pick-file', options),
    readFile: (file) => ipcRenderer.invoke('bot:read-file', file),
    writeFile: (options) => ipcRenderer.invoke('bot:write-file', options),
    http: (request) => ipcRenderer.invoke('bot:http', request),
    notify: (title, body) => ipcRenderer.send('bot:notify', { title, body }),
    configureOverlay: (options) => ipcRenderer.invoke('overlay:configure', options),
    overlayStatus: () => ipcRenderer.invoke('overlay:status'),
    sendOverlay: (event) => ipcRenderer.send('overlay:send', event),
    setCatalog: (lists) => ipcRenderer.send('overlay:catalog', lists),
    openOverlay: () => ipcRenderer.send('overlay:open'),
    // Multistream: signing in to YouTube, posting to TikTok.
    youtubeLogin: (clientId) => ipcRenderer.invoke('youtube:login', { clientId }),
    cancelYoutubeLogin: () => ipcRenderer.invoke('youtube:cancel-login'),
    tiktokSend: (handle, text) => ipcRenderer.invoke('tiktok:send', { handle, text }),
    // Reading another bot's data to import: 'firebot-folder', 'firebot-setup' or 'mixitup'.
    readImport: (kind) => ipcRenderer.invoke('import:read', { kind }),
    onMainEvent: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('bot:main-event', listener);
      return () => ipcRenderer.off('bot:main-event', listener);
    },
  },

  toggleWindow: () => ipcRenderer.send('window:toggle'),
  hideWindow: () => ipcRenderer.send('window:hide'),
  openExternal: (url) => ipcRenderer.send('shell:open-external', url),
});
