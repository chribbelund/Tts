'use strict';

const { app, BrowserWindow, Menu, Notification, Tray, globalShortcut, ipcMain, nativeImage, shell, systemPreferences } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { toAccelerator, isMediaKey } = require('./accelerator');

// Chromium won't play audio until the page has been clicked. A reader that is
// started or resumed by a hotkey has no click to wait for, so allow it up front.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const IS_MAC = process.platform === 'darwin';

// `web/` is the copy of the page that gets packaged (see scripts/sync-web.js).
// In a checkout the page itself is one level up, so run that instead and edits
// show up on reload.
function resolveWebRoot() {
  const packed = path.join(__dirname, 'web', 'index.html');
  if (app.isPackaged) return path.dirname(packed);
  const source = path.join(__dirname, '..', 'index.html');
  if (fs.existsSync(source)) return path.dirname(source);
  return path.dirname(packed);
}

const WEB_ROOT = resolveWebRoot();
const ICON = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png'));

let win = null;
let tray = null;
let quitting = false;
let toldAboutTray = false;
let readerState = { paused: false, channel: '', waiting: 0 };

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 840,
    minWidth: 700,
    minHeight: 520,
    title: 'Chat Reader',
    backgroundColor: '#0f0e13',
    icon: ICON.isEmpty() ? undefined : ICON,
    autoHideMenuBar: !IS_MAC,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      additionalArguments: [`--app-version=${app.getVersion()}`],
      // Keep speaking at full speed while the window is hidden or behind a game.
      backgroundThrottling: false,
    },
  });

  win.loadFile(path.join(WEB_ROOT, 'index.html'));

  // Links in the page (Hugging Face, kokoro-js, …) belong in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('file://')) return;
    event.preventDefault();
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });

  // Closing the window would kill the page, and the page is what reads chat.
  // Hide it instead and leave the reader running; the tray and the hotkeys
  // bring it back.
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
    if (IS_MAC) app.dock?.hide();
    notifyStillRunning();
  });

  win.on('closed', () => { win = null; });
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  if (IS_MAC) app.dock?.show();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function toggleWindow() {
  if (win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()) {
    win.hide();
    if (IS_MAC) app.dock?.hide();
    notifyStillRunning();
  } else {
    showWindow();
  }
}

function notifyStillRunning() {
  if (toldAboutTray || !Notification.isSupported()) return;
  toldAboutTray = true;
  new Notification({
    title: 'Chat Reader is still reading',
    body: 'It keeps going in the background. Use the tray icon or your hotkey to bring it back.',
    icon: ICON.isEmpty() ? undefined : ICON,
    silent: true,
  }).show();
}

function sendAction(action) {
  // The ⏯ key is registered under its own name so it can't be mistaken for the
  // ordinary binding of the same action.
  action = action.replace(/^media:/, '');
  if (action === 'toggleWindow') return toggleWindow();
  if (!win || win.isDestroyed()) {
    // Nothing is loaded to act on, so the only sensible response is to appear.
    showWindow();
    return;
  }
  win.webContents.send('hotkey-action', action);
}

// ---------------------------------------------------------------------------
// Global hotkeys
// ---------------------------------------------------------------------------

// The hardware media keys, offered as a second way to reach the two actions
// that are worth reaching mid-game.
const MEDIA_BINDINGS = {
  'media:pause': { code: 'MediaPlayPause' },
  'media:skip': { code: 'MediaTrackNext' },
};

let registered = {};

function applyHotkeys({ enabled = true, bindings = {}, media = false } = {}) {
  globalShortcut.unregisterAll();
  registered = {};
  const problems = {};

  const wanted = [];
  // `enabled` is the page's "let these work while another app is focused"
  // switch. The media keys are global by nature, so they ignore it.
  if (enabled) {
    for (const [action, binding] of Object.entries(bindings)) {
      if (!binding || !binding.code) continue;
      wanted.push([action, binding]);
    }
  }
  if (media) {
    for (const [action, binding] of Object.entries(MEDIA_BINDINGS)) wanted.push([action, binding]);
  }

  const taken = new Map();
  for (const [action, binding] of wanted) {
    const result = toAccelerator(binding);
    if (result.error) {
      problems[action] = result.error;
      continue;
    }
    const { accelerator } = result;
    if (taken.has(accelerator)) {
      problems[action] = `same keys as “${taken.get(accelerator)}”`;
      continue;
    }
    let ok = false;
    try {
      ok = globalShortcut.register(accelerator, () => sendAction(action));
    } catch (err) {
      problems[action] = err.message;
      continue;
    }
    if (!ok || !globalShortcut.isRegistered(accelerator)) {
      problems[action] = isMediaKey(binding.code) && IS_MAC
        ? 'macOS only sends media keys to apps allowed under Accessibility'
        : 'another app is already using these keys';
      continue;
    }
    taken.set(accelerator, action);
    registered[action] = accelerator;
  }

  // macOS only delivers the ⏯ key to apps trusted for accessibility.
  const mediaAccess = !media || !IS_MAC || systemPreferences.isTrustedAccessibilityClient(false);
  return { registered, problems, mediaAccess };
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

function trayImage() {
  if (ICON.isEmpty()) return nativeImage.createEmpty();
  const small = ICON.resize({ width: IS_MAC ? 18 : 24, height: IS_MAC ? 18 : 24 });
  if (IS_MAC) small.setTemplateImage(false);
  return small;
}

function buildTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('Chat Reader');
  renderTray();
  tray.on('click', () => (IS_MAC ? tray.popUpContextMenu() : toggleWindow()));
  tray.on('double-click', showWindow);
}

function renderTray() {
  if (!tray) return;
  const where = readerState.channel ? `#${readerState.channel}` : 'Not connected';
  const waiting = readerState.waiting ? ` (${readerState.waiting} waiting)` : '';
  tray.setToolTip(`Chat Reader — ${where}${waiting}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `${where}${waiting}`, enabled: false },
    { type: 'separator' },
    { label: readerState.paused ? 'Resume reading' : 'Pause reading', accelerator: registered.pause, registerAccelerator: false, click: () => sendAction('pause') },
    { label: 'Skip message', accelerator: registered.skip, registerAccelerator: false, click: () => sendAction('skip') },
    { label: 'Clear waiting messages', click: () => sendAction('clear') },
    { type: 'separator' },
    { label: win && win.isVisible() ? 'Hide window' : 'Show window', click: toggleWindow },
    { label: 'Quit Chat Reader', click: () => { quitting = true; app.quit(); } },
  ]));
}

// ---------------------------------------------------------------------------
// Menu (macOS needs one for copy/paste and ⌘Q to work in text fields)
// ---------------------------------------------------------------------------

function buildMenu() {
  if (!IS_MAC) return Menu.setApplicationMenu(null);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: 'Reading',
      submenu: [
        { label: 'Pause / resume', click: () => sendAction('pause') },
        { label: 'Skip message', click: () => sendAction('skip') },
        { label: 'Clear waiting messages', click: () => sendAction('clear') },
      ],
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [{ label: 'Project page', click: () => shell.openExternal('https://github.com/chribbelund/Tts') }],
    },
  ]));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    buildMenu();
    buildTray();
    createWindow();
    app.on('activate', showWindow);
  });

  // The tray keeps the app alive on purpose: the reader is meant to run while
  // you're looking at something else.
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => globalShortcut.unregisterAll());
}

ipcMain.handle('hotkeys:apply', (_event, payload) => {
  const result = applyHotkeys(payload);
  renderTray();
  return result;
});

ipcMain.handle('hotkeys:accessibility-prompt', () => (IS_MAC ? systemPreferences.isTrustedAccessibilityClient(true) : true));

ipcMain.on('state:update', (_event, state) => {
  readerState = { ...readerState, ...state };
  renderTray();
});

ipcMain.on('window:toggle', toggleWindow);
ipcMain.on('window:hide', () => { if (win && !win.isDestroyed()) { win.hide(); if (IS_MAC) app.dock?.hide(); notifyStillRunning(); } });
ipcMain.on('shell:open-external', (_event, url) => { if (/^https?:\/\//.test(String(url))) shell.openExternal(String(url)); });
