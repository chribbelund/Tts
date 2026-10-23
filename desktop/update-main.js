// Updates from GitHub releases.
//
// Windows installer: downloads in the background and installs silently when
// the app quits, or straight away from the tray (it closes, updates and opens
// again on its own, with no installer window). macOS won't let an unsigned app
// replace itself, and the portable .exe has nowhere to install to, so those
// only say a new version is out and link to the release page.
//
// Beta versions are releases marked Pre-release on GitHub. They're only taken
// with "Get beta versions" on, which is kept in updates.json in the app's data
// folder rather than with the page's settings.

const { app, Notification, dialog, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const RELEASES = 'https://github.com/chribbelund/Tts/releases';
const CHECK_EVERY = 6 * 60 * 60 * 1000;
const FIRST_CHECK = 30 * 1000;

const PORTABLE = Boolean(process.env.PORTABLE_EXECUTABLE_DIR);
const CAN_INSTALL = process.platform === 'win32' && !PORTABLE;

let autoUpdater = null;
let onChange = () => {};
let getWindow = () => null;
let beforeInstall = () => {};

// idle | checking | available (macOS/portable) | downloading | ready | error
// `withBeta` says whether betas were on when `version` was found.
let state = { status: 'idle', version: null, percent: 0, withBeta: false };
let beta = false;
let manual = false;
let toldAbout = null;

function set(next) {
  state = { ...state, ...next };
  onChange();
}

function notify(title, body, click) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body });
  if (click) n.on('click', click);
  n.show();
}

function parent() {
  const w = getWindow();
  return w && !w.isDestroyed() ? w : null;
}

function prefsFile() {
  return path.join(app.getPath('userData'), 'updates.json');
}

function loadPrefs() {
  try {
    beta = JSON.parse(fs.readFileSync(prefsFile(), 'utf8')).beta === true;
  } catch {
    beta = false;
  }
}

function savePrefs() {
  try {
    fs.writeFileSync(prefsFile(), JSON.stringify({ beta }, null, 2));
  } catch {
    // Not fatal: the choice just won't outlast this run.
  }
}

// A version found while betas were on, after they've been turned off. It may be
// a beta, so it's dropped rather than offered or installed.
function unwanted() {
  return state.withBeta && !beta;
}

function releasePage(version) {
  return version ? `${RELEASES}/tag/v${version}` : `${RELEASES}/latest`;
}

function setup(options = {}) {
  onChange = options.onChange || onChange;
  getWindow = options.getWindow || getWindow;
  beforeInstall = options.beforeInstall || beforeInstall;
  loadPrefs();
  // A dev run (npm start) has no app-update.yml and nothing to update.
  if (!app.isPackaged) return;

  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.autoDownload = CAN_INSTALL;
  autoUpdater.autoInstallOnAppQuit = CAN_INSTALL;
  autoUpdater.logger = null;
  // Set after the rest: the updater turns this on by itself when the running
  // version has a -beta style suffix. Never set `channel`, which also allows
  // going back a version.
  autoUpdater.allowPrerelease = beta;

  autoUpdater.on('checking-for-update', () => set({ status: 'checking', withBeta: beta }));

  autoUpdater.on('update-not-available', () => {
    set({ status: 'idle' });
    if (manual) {
      manual = false;
      dialog.showMessageBox(parent(), {
        type: 'info',
        message: 'Chat Reader is up to date',
        detail: `You have version ${app.getVersion()}, the newest one.`,
      });
    }
  });

  autoUpdater.on('update-available', (info) => {
    manual = false;
    if (unwanted()) return recheck();
    if (CAN_INSTALL) return set({ status: 'downloading', version: info.version, percent: 0 });
    set({ status: 'available', version: info.version });
    if (toldAbout === info.version) return;
    toldAbout = info.version;
    notify('Chat Reader update', `Version ${info.version} is out. Click to open the download page.`, () => shell.openExternal(releasePage(info.version)));
  });

  autoUpdater.on('download-progress', (p) => {
    const percent = Math.round(p.percent || 0);
    if (percent !== state.percent) set({ percent });
  });

  autoUpdater.on('update-downloaded', (info) => {
    // Betas were turned off during the download: keep it from installing on quit.
    if (unwanted()) {
      autoUpdater.autoInstallOnAppQuit = false;
      return recheck();
    }
    autoUpdater.autoInstallOnAppQuit = CAN_INSTALL;
    set({ status: 'ready', version: info.version });
    if (toldAbout === info.version) return;
    toldAbout = info.version;
    notify('Chat Reader update ready', `Version ${info.version} installs when Chat Reader closes. Choose Restart to update in the tray menu to do it now.`);
  });

  autoUpdater.on('error', (err) => {
    // Offline, rate-limited or a release still uploading: try again next round.
    const wasManual = manual;
    manual = false;
    set({ status: state.status === 'ready' ? 'ready' : 'error' });
    if (wasManual) {
      dialog.showMessageBox(parent(), {
        type: 'warning',
        message: 'Couldn’t check for updates',
        detail: `${(err && err.message ? err.message : String(err)).split('\n')[0]}\n\nThe releases page always has the newest version.`,
        buttons: ['Open releases page', 'OK'],
        defaultId: 1,
      }).then(({ response }) => { if (response === 0) shell.openExternal(RELEASES); });
    }
  });

  setTimeout(check, FIRST_CHECK);
  setInterval(check, CHECK_EVERY).unref();
}

function check() {
  if (!autoUpdater || ['checking', 'downloading', 'ready'].includes(state.status)) return;
  autoUpdater.checkForUpdates().catch(() => {}); // reported through 'error'
}

// Forgets what was found and looks again with the current beta choice.
function recheck() {
  set({ status: 'idle', version: null, percent: 0 });
  check();
}

function setBeta(on) {
  on = !!on;
  if (on === beta) return;
  beta = on;
  savePrefs();
  if (!autoUpdater) return onChange();
  autoUpdater.allowPrerelease = beta;
  // A check or download under way is sorted out when it finishes.
  if (state.status === 'checking' || state.status === 'downloading') return onChange();
  if (unwanted()) {
    // Off: drop what was found with betas on, since it may be a beta.
    if (state.status === 'ready') autoUpdater.autoInstallOnAppQuit = false;
    return recheck();
  }
  // On: look for a beta straight away, unless an update is already waiting to install.
  if (beta && state.status !== 'ready') return recheck();
  onChange();
}

// What the page shows in the Keys section.
function getInfo() {
  return {
    status: state.status,
    version: state.version,
    percent: state.percent,
    beta,
    enabled: Boolean(autoUpdater),
    current: app.getVersion(),
  };
}

function checkNow() {
  if (!autoUpdater) {
    shell.openExternal(RELEASES);
    return;
  }
  if (state.status === 'available') return shell.openExternal(releasePage(state.version));
  if (state.status === 'ready') return installNow();
  if (state.status === 'checking' || state.status === 'downloading') return;
  manual = true;
  check();
}

function installNow() {
  if (!autoUpdater || state.status !== 'ready') return;
  // Tell main.js we're quitting so closing the window doesn't offer the tray instead.
  beforeInstall();
  // Silent: no installer window. Then open the new version.
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
}

// Tray/menu entry describing where the update stands.
function menuItem() {
  switch (state.status) {
    case 'checking':
      return { label: 'Checking for updates…', enabled: false };
    case 'downloading':
      return { label: `Downloading version ${state.version}… ${state.percent}%`, enabled: false };
    case 'ready':
      return { label: `Restart to update to ${state.version}`, click: installNow };
    case 'available':
      return { label: `Download version ${state.version}…`, click: () => shell.openExternal(releasePage(state.version)) };
    default:
      return { label: 'Check for updates…', click: checkNow };
  }
}

module.exports = { setup, checkNow, installNow, setBeta, getInfo, menuItem, getState: () => state };
