// The small window shown while the app looks for an update at startup
// (update-main.js decides what it says). splash/ holds its page.

const { BrowserWindow, ipcMain, nativeTheme } = require('electron');
const path = require('node:path');

let win = null;
let last = { text: 'Starting…', percent: null, detail: '', canSkip: false };
let onSkip = () => {};

ipcMain.on('splash:skip', () => onSkip());

function open({ icon, skip } = {}) {
  if (win && !win.isDestroyed()) return;
  onSkip = skip || (() => {});
  win = new BrowserWindow({
    width: 320,
    height: 360,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    center: true,
    show: false,
    title: 'Chat Reader',
    icon,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f0e13' : '#f4f3f7',
    webPreferences: {
      preload: path.join(__dirname, 'splash', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, 'splash', 'splash.html'));
  win.webContents.on('did-finish-load', () => send());
  win.once('ready-to-show', () => win && !win.isDestroyed() && win.show());
  win.on('closed', () => { win = null; });
}

function send() {
  if (win && !win.isDestroyed()) win.webContents.send('splash:status', last);
}

// { text, percent (0–100, or null while there's no number), detail, canSkip }
function update(info) {
  last = { ...last, ...info };
  send();
}

function close() {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}

function focus() {
  if (!win || win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return true;
}

module.exports = { open, update, close, focus, isOpen: () => Boolean(win && !win.isDestroyed()) };
