'use strict';

// The main-process half of the screen reader (desktop/bot/screen.js is the
// rest). The page captures the screen and decides what to read; this file
// does what a page can't:
//   - answers the page's screen capture request with the screen it asked
//     for, without a picker
//   - runs the operating system's own text recognition: Apple Vision on
//     macOS, Windows OCR on Windows, each in a helper process that stays warm
//   - shows the windows that sit on top of a game: the zone editor, the zone
//     outlines and reading highlight, and the lens (a magnifier that follows
//     what's being read instead of the mouse)
//   - notices which program is in front, so a game's profile can be picked
//     by itself when the game comes up
// All three windows are kept out of screen captures, so the reader never
// reads its own outlines or magnifies its own lens.

const { app, BrowserWindow, desktopCapturer, ipcMain, screen, session, shell, systemPreferences, webContents } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const SCREEN_DIR = path.join(__dirname, 'screen');
const PRELOAD = path.join(SCREEN_DIR, 'preload.js');
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;

let getWindow = () => null;

const displayKey = (d) => String(d.id);
function findDisplay(id) {
  const all = screen.getAllDisplays();
  return all.find((d) => displayKey(d) === String(id)) || screen.getPrimaryDisplay();
}

function displayList() {
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().map((d, i) => ({
    id: displayKey(d),
    label: d.label || `Screen ${i + 1}`,
    primary: d.id === primary.id,
    bounds: d.bounds,
    scaleFactor: d.scaleFactor,
    pixels: { width: Math.round(d.bounds.width * d.scaleFactor), height: Math.round(d.bounds.height * d.scaleFactor) },
  }));
}

// ---------------------------------------------------------------------------
// Screen capture: which screen each page asked for
// ---------------------------------------------------------------------------

const wanted = new Map();   // webContents id -> display id

function captureAccess() {
  if (!IS_MAC) return 'granted';
  try { return systemPreferences.getMediaAccessStatus('screen'); } catch { return 'unknown'; }
}

function installCaptureHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    let sender = null;
    try { sender = request.frame ? webContents.fromFrame(request.frame) : null; } catch { sender = null; }
    const displayId = (sender && wanted.get(sender.id)) || wanted.get('last') || displayKey(screen.getPrimaryDisplay());
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      const source = sources.find((s) => String(s.display_id) === String(displayId))
        || sources[screen.getAllDisplays().findIndex((d) => displayKey(d) === String(displayId))]
        || sources[0];
      if (!source) return callback({});
      callback({ video: source });
    } catch (err) {
      console.error('screen capture:', err.message);
      callback({});
    }
  }, { useSystemPicker: false });
}

// ---------------------------------------------------------------------------
// Text recognition helper
// ---------------------------------------------------------------------------

const ocr = {
  proc: null,
  starting: null,     // Promise while the helper starts
  engine: '',
  error: '',
  maxSide: 0,         // largest picture side the helper takes (Windows has a limit)
  pending: new Map(), // id -> { resolve, timer }
  seq: 0,
  jobs: 0,            // finished jobs, so the first one may take longer
  restarts: [],
};

function helperCommand() {
  if (IS_MAC) {
    const script = fs.readFileSync(path.join(SCREEN_DIR, 'ocr-mac.js'), 'utf8');
    return ['osascript', ['-l', 'JavaScript', '-e', script], {}];
  }
  if (IS_WIN) {
    const script = fs.readFileSync(path.join(SCREEN_DIR, 'ocr-win.ps1'), 'utf8');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    return ['powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true }];
  }
  return null;
}

function stopHelper() {
  const proc = ocr.proc;
  ocr.proc = null;
  ocr.starting = null;
  for (const [, job] of ocr.pending) { clearTimeout(job.timer); job.resolve({ error: 'Text recognition stopped' }); }
  ocr.pending.clear();
  if (proc) { proc.removeAllListeners(); try { proc.kill(); } catch {} }
}

function startHelper() {
  if (ocr.proc && !ocr.starting) return Promise.resolve(true);
  if (ocr.starting) return ocr.starting;
  const command = helperCommand();
  if (!command) {
    ocr.error = 'This system has no built-in text recognition the app can use';
    return Promise.resolve(false);
  }
  const now = Date.now();
  ocr.restarts = ocr.restarts.filter((t) => now - t < 60000);
  if (ocr.restarts.length >= 4) {
    ocr.error = ocr.error || 'Text recognition keeps stopping';
    return Promise.resolve(false);
  }
  ocr.restarts.push(now);

  ocr.starting = new Promise((resolve) => {
    const [cmd, args, options] = command;
    let proc;
    try {
      proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], ...options });
    } catch (err) {
      ocr.error = err.message;
      ocr.starting = null;
      resolve(false);
      return;
    }
    ocr.proc = proc;
    ocr.jobs = 0;
    let buffer = '';
    let stderr = '';
    let settled = false;
    const settle = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(startTimer);
      ocr.starting = null;
      resolve(ok);
    };
    const startTimer = setTimeout(() => {
      ocr.error = 'Text recognition took too long to start';
      stopHelper();
      settle(false);
    }, 30000);

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (!line.startsWith('{')) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.ready) {
          ocr.engine = msg.engine || '';
          ocr.maxSide = Number(msg.maxSide) || 0;
          ocr.error = '';
          settle(true);
        } else if (msg.id !== undefined && msg.id !== null && ocr.pending.has(msg.id)) {
          const job = ocr.pending.get(msg.id);
          ocr.pending.delete(msg.id);
          clearTimeout(job.timer);
          ocr.jobs++;
          job.resolve(msg.error ? { error: msg.error } : { lines: Array.isArray(msg.lines) ? msg.lines : (msg.lines ? [msg.lines] : []), ms: msg.ms || 0, engine: ocr.engine });
        } else if (msg.error && !settled) {
          ocr.error = msg.error;
          settle(false);
        }
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
    proc.on('error', (err) => {
      ocr.error = err.code === 'ENOENT' ? `${cmd} wasn’t found on this computer` : err.message;
      if (ocr.proc === proc) stopHelper();
      settle(false);
    });
    proc.on('exit', (code) => {
      if (ocr.proc !== proc) return;
      if (!ocr.error) ocr.error = stderr.trim().split('\n').pop() || `Text recognition stopped (code ${code})`;
      stopHelper();
      settle(false);
    });
    proc.stdin.on('error', () => {});
  });
  return ocr.starting;
}

async function recognize({ image, fast = false, digits = false, langs = [] } = {}) {
  if (!(image instanceof Uint8Array) || !image.length) return { error: 'No picture to read' };
  if (image.length > MAX_IMAGE_BYTES) return { error: 'The picture is too big to read' };
  const ok = await startHelper();
  if (!ok || !ocr.proc) return { error: ocr.error || 'Text recognition isn’t running' };
  const id = ++ocr.seq;
  return new Promise((resolve) => {
    // Vision loads its model on the first job, which can take several seconds.
    const timeout = ocr.jobs === 0 ? 30000 : 12000;
    const timer = setTimeout(() => {
      if (!ocr.pending.delete(id)) return;
      resolve({ error: 'Text recognition didn’t answer in time' });
      // A stuck helper would hold up every job after this one.
      stopHelper();
    }, timeout);
    ocr.pending.set(id, { resolve, timer });
    const job = { id, png: Buffer.from(image.buffer, image.byteOffset, image.byteLength).toString('base64'), fast: !!fast, digits: !!digits };
    if (Array.isArray(langs) && langs.length) job.langs = langs.filter((l) => /^[\w-]{2,20}$/.test(l)).slice(0, 8);
    ocr.proc.stdin.write(`${JSON.stringify(job)}\n`);
  });
}

// ---------------------------------------------------------------------------
// Windows on top of the game
// ---------------------------------------------------------------------------

function floatOnTop(win) {
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  // Keeps the outlines and the lens out of every capture, the reader's own included.
  win.setContentProtection(true);
}

function overlayWindow(role, bounds, { interactive = false } = {}) {
  const win = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    transparent: role !== 'lens',
    backgroundColor: role === 'lens' ? '#000000' : '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    // On Windows the editor goes full screen, the one way to get above the taskbar.
    fullscreenable: IS_WIN && role === 'editor',
    // Without the resizable frame Windows doesn't keep the window off the taskbar.
    thickFrame: false,
    skipTaskbar: true,
    focusable: interactive,
    roundedCorners: false,
    title: role === 'editor' ? 'Reading zones' : 'Chat Reader',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
      additionalArguments: [`--screen-role=${role}`],
    },
  });
  floatOnTop(win);
  if (!interactive) win.setIgnoreMouseEvents(true);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(SCREEN_DIR, role === 'lens' ? 'lens.html' : 'overlay.html'));
  return win;
}

function sendWhenReady(win, channel, payload) {
  if (!win || win.isDestroyed()) return;
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => { if (!win.isDestroyed()) win.webContents.send(channel, payload); });
  else win.webContents.send(channel, payload);
}

// Where the screen is inside a window, in the window's own pixels. A window
// meant to cover a screen can end up smaller (Windows keeps windows off the
// taskbar, macOS off the menu bar); the zones are fractions of the screen, so
// the window draws them where they are on the screen, not stretched over
// itself.
function sendFrame(win, displayId) {
  if (!win || win.isDestroyed()) return;
  const d = findDisplay(displayId).bounds;
  const c = win.getContentBounds();
  sendWhenReady(win, 'screen-overlay:frame', { x: d.x - c.x, y: d.y - c.y, width: d.width, height: d.height });
}

function trackFrame(win, displayId) {
  const send = () => sendFrame(win, displayId);
  for (const type of ['show', 'resize', 'move', 'enter-full-screen']) win.on(type, send);
  win.webContents.on('did-finish-load', send);
}

// Puts a window over all of a screen, taskbar and menu bar included.
function coverDisplay(win, display) {
  if (!win || win.isDestroyed()) return;
  win.setBounds(display.bounds);
  floatOnTop(win);
  win.moveTop();
  sendFrame(win, displayKey(display));
}

// The outlines of the zones and the box around what's being read. Never takes
// the mouse or the keyboard.
const markers = { win: null, display: '', state: null };

function updateMarkers(state) {
  markers.state = state;
  const needed = state && ((state.showZones && state.zones && state.zones.length) || state.focus);
  if (!needed) {
    if (markers.win && !markers.win.isDestroyed()) markers.win.hide();
    return;
  }
  const display = findDisplay(state.display);
  if (!markers.win || markers.win.isDestroyed() || markers.display !== displayKey(display)) {
    if (markers.win && !markers.win.isDestroyed()) markers.win.destroy();
    markers.win = overlayWindow('markers', display.bounds);
    markers.display = displayKey(display);
    trackFrame(markers.win, markers.display);
  }
  markers.win.setBounds(display.bounds);
  sendWhenReady(markers.win, 'screen-overlay:state', state);
  if (!markers.win.isVisible()) { markers.win.showInactive(); coverDisplay(markers.win, display); }
}

// The zone editor: covers one screen and takes the mouse and keyboard until
// it's saved or cancelled.
const editor = { win: null, resolve: null, restoreMain: false };

function closeEditor(result) {
  const { win, resolve, restoreMain } = editor;
  editor.win = null;
  editor.resolve = null;
  editor.restoreMain = false;
  if (win && !win.isDestroyed()) win.destroy();
  if (markers.state) updateMarkers(markers.state);
  if (restoreMain) {
    const main = getWindow();
    if (main && !main.isDestroyed()) { main.show(); main.focus(); }
  }
  if (resolve) resolve(result);
}

function openEditor({ display: displayId, zones = [], modes = [], selected = '', hideMain = false } = {}) {
  if (editor.win) closeEditor({ canceled: true });
  const display = findDisplay(displayId);
  return new Promise((resolve) => {
    editor.resolve = resolve;
    const main = getWindow();
    if (hideMain && main && !main.isDestroyed() && main.isVisible()) {
      editor.restoreMain = true;
      main.hide();
    }
    // The outlines would sit under the editor's own; it draws them itself.
    if (markers.win && !markers.win.isDestroyed()) markers.win.hide();
    const win = overlayWindow('editor', display.bounds, { interactive: true });
    editor.win = win;
    trackFrame(win, displayKey(display));
    sendWhenReady(win, 'screen-overlay:state', {
      role: 'editor',
      display: displayKey(display),
      size: display.bounds,
      zones: Array.isArray(zones) ? zones.slice(0, 50) : [],
      modes: Array.isArray(modes) ? modes.slice(0, 20) : [],
      selected,
      platform: process.platform,
    });
    win.once('ready-to-show', () => {
      win.show();
      coverDisplay(win, display);
      // The taskbar stays above any window that isn't full screen.
      if (IS_WIN) win.setFullScreen(true);
      win.focus();
    });
    win.on('closed', () => { if (editor.win === win) closeEditor({ canceled: true }); });
  });
}

// The lens: a magnified view of what's being read, in a corner of any screen.
const lens = { win: null, state: null, source: '' };

const LENS_MARGIN = 24;

function lensBounds(state) {
  const display = findDisplay(state.lensDisplay || state.display);
  const area = display.workArea;
  if (state.position === 'fill') return { ...display.bounds };
  const width = Math.min(area.width - LENS_MARGIN * 2, Math.max(160, Math.round(state.width || 640)));
  const height = Math.min(area.height - LENS_MARGIN * 2, Math.max(90, Math.round(state.height || 260)));
  const left = area.x + LENS_MARGIN;
  const right = area.x + area.width - width - LENS_MARGIN;
  const centreX = area.x + Math.round((area.width - width) / 2);
  const top = area.y + LENS_MARGIN;
  const bottom = area.y + area.height - height - LENS_MARGIN;
  const spots = {
    'top-left': [left, top], 'top-right': [right, top], 'bottom-left': [left, bottom], 'bottom-right': [right, bottom],
    top: [centreX, top], bottom: [centreX, bottom],
  };
  const [x, y] = spots[state.position] || spots['top-right'];
  return { x, y, width, height };
}

function updateLens(state) {
  lens.state = state;
  if (!state || !state.enabled) {
    if (lens.win && !lens.win.isDestroyed()) lens.win.destroy();
    lens.win = null;
    lens.source = '';
    return;
  }
  const source = displayKey(findDisplay(state.display));
  if (!lens.win || lens.win.isDestroyed()) {
    lens.win = overlayWindow('lens', lensBounds(state));
    lens.win.once('ready-to-show', () => lens.win && !lens.win.isDestroyed() && lens.win.showInactive());
    lens.win.on('closed', () => { lens.win = null; });
  }
  wanted.set(lens.win.webContents.id, source);
  lens.win.setBounds(lensBounds(state));
  const display = findDisplay(source);
  sendWhenReady(lens.win, 'screen-overlay:state', { ...state, role: 'lens', display: source, restart: lens.source !== source, sourceSize: display.bounds });
  lens.source = source;
}

// ---------------------------------------------------------------------------
// Which program is in front, so each game can have its own profile
// ---------------------------------------------------------------------------

const apps = {
  proc: null,
  wanted: false,
  front: null,       // the program in front now
  lastOther: null,   // the last program in front that wasn't this app
  restarts: [],
  retry: null,
};

function appsCommand(mode) {
  if (IS_MAC) {
    const script = `const MODE = ${JSON.stringify(mode)};\n${fs.readFileSync(path.join(SCREEN_DIR, 'apps-mac.js'), 'utf8')}`;
    return ['osascript', ['-l', 'JavaScript', '-e', script], {}];
  }
  if (IS_WIN) {
    const script = `$Mode = '${mode}'\n${fs.readFileSync(path.join(SCREEN_DIR, 'apps-win.ps1'), 'utf8')}`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    return ['powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true }];
  }
  return null;
}

function cleanApp(a) {
  if (!a || typeof a !== 'object') return null;
  const s = (v, n = 120) => String(v || '').trim().slice(0, n);
  const app = { pid: Number(a.pid) || 0, exe: s(a.exe), name: s(a.name), id: s(a.id), title: s(a.title, 200) };
  return app.exe || app.name || app.id ? app : null;
}

// Reads JSON lines from a helper and hands each to onMessage.
function readLines(proc, onMessage) {
  let buffer = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line.startsWith('{')) continue;
      try { onMessage(JSON.parse(line)); } catch {}
    }
  });
}

function stopAppWatch() {
  clearTimeout(apps.retry);
  apps.retry = null;
  const proc = apps.proc;
  apps.proc = null;
  if (proc) { proc.removeAllListeners(); try { proc.kill(); } catch {} }
}

function startAppWatch() {
  if (apps.proc || !apps.wanted) return;
  const command = appsCommand('watch');
  if (!command) return;
  const now = Date.now();
  apps.restarts = apps.restarts.filter((t) => now - t < 60000);
  if (apps.restarts.length >= 4) return;
  apps.restarts.push(now);
  const [cmd, args, options] = command;
  let proc;
  try { proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], ...options }); } catch { return; }
  apps.proc = proc;
  readLines(proc, (msg) => {
    if (msg.error) { notifyPage('app-error', String(msg.error).slice(0, 300)); return; }
    const app = cleanApp(msg.app);
    if (!app) return;
    apps.front = app;
    // This app coming to the front (to change a setting) says nothing about the game.
    if (app.pid === process.pid) return;
    apps.lastOther = app;
    notifyPage('app', app);
  });
  const restart = () => {
    if (apps.proc !== proc) return;
    apps.proc = null;
    if (apps.wanted) apps.retry = setTimeout(startAppWatch, 5000);
  };
  proc.on('error', restart);
  proc.on('exit', restart);
}

function watchApps(on) {
  apps.wanted = !!on;
  if (apps.wanted) startAppWatch();
  else stopAppWatch();
  return { supported: !!appsCommand('watch'), lastOther: apps.lastOther };
}

// The programs with a window open right now, for picking one from a list.
function listApps() {
  const command = appsCommand('list');
  if (!command) return Promise.resolve({ apps: [], error: 'Not on this system' });
  return new Promise((resolve) => {
    const [cmd, args, options] = command;
    let proc;
    try { proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], ...options }); } catch (err) { resolve({ apps: [], error: err.message }); return; }
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { proc.kill(); } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => finish({ apps: [], error: 'It took too long to list the programs' }), 15000);
    readLines(proc, (msg) => {
      if (msg.error) finish({ apps: [], error: String(msg.error) });
      else if (Array.isArray(msg.apps)) {
        const seen = new Set();
        const list = msg.apps.map(cleanApp).filter((a) => {
          if (!a || a.pid === process.pid) return false;
          const key = (a.exe || a.name).toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        list.sort((a, b) => (a.name || a.exe).localeCompare(b.name || b.exe));
        finish({ apps: list });
      }
    });
    proc.on('error', (err) => finish({ apps: [], error: err.message }));
    proc.on('exit', () => setTimeout(() => finish({ apps: [], error: 'No programs came back' }), 200));
  });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function notifyPage(type, payload) {
  const win = getWindow();
  if (win && !win.isDestroyed()) win.webContents.send('screen:event', { type, payload });
}

function setup(options) {
  getWindow = options.getWindow;
  installCaptureHandler();

  ipcMain.handle('screen:displays', () => displayList());
  ipcMain.handle('screen:access', () => ({ status: captureAccess(), platform: process.platform }));
  ipcMain.handle('screen:ask-access', async () => {
    if (!IS_MAC) return { status: 'granted' };
    // Asking for the screens once is what puts the app in the Screen
    // Recording list; turning it on there is up to the person.
    try { await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }); } catch {}
    const status = captureAccess();
    if (status !== 'granted') shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    return { status };
  });
  ipcMain.handle('screen:want', (event, displayId) => {
    const id = displayKey(findDisplay(displayId));
    wanted.set(event.sender.id, id);
    wanted.set('last', id);
    return id;
  });
  // The older way to capture a screen, for when getDisplayMedia() is refused.
  ipcMain.handle('screen:source', async (_event, displayId) => {
    const id = displayKey(findDisplay(displayId));
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      const source = sources.find((s) => String(s.display_id) === id) || sources[0];
      return source ? source.id : '';
    } catch {
      return '';
    }
  });
  ipcMain.handle('screen:ocr', (_event, job) => recognize(job));
  ipcMain.handle('screen:ocr-status', async (_event, { start = false } = {}) => {
    if (start) await startHelper();
    return { running: !!ocr.proc && !ocr.starting, engine: ocr.engine, error: ocr.error, maxSide: ocr.maxSide, supported: !!helperCommand() };
  });
  ipcMain.handle('screen:edit', (_event, payload) => openEditor(payload || {}));
  ipcMain.handle('screen:watch-apps', (_event, on) => watchApps(on));
  ipcMain.handle('screen:apps', async () => ({ ...(await listApps()), lastOther: apps.lastOther }));
  ipcMain.on('screen:markers', (_event, state) => updateMarkers(state && typeof state === 'object' ? state : null));
  ipcMain.on('screen:lens', (_event, state) => updateLens(state && typeof state === 'object' ? state : null));

  // From the windows on top of the game.
  ipcMain.on('screen-editor:done', (event, result) => {
    if (!editor.win || event.sender !== editor.win.webContents) return;
    const zones = result && Array.isArray(result.zones) ? result.zones.slice(0, 50) : null;
    closeEditor(zones ? { zones, selected: String(result.selected || '') } : { canceled: true });
  });
  ipcMain.on('screen-overlay:say', (event, text) => {
    // The editor's own spoken hints go through the reader's voice.
    if (editor.win && event.sender === editor.win.webContents) notifyPage('say', String(text || '').slice(0, 300));
  });

  for (const type of ['display-added', 'display-removed', 'display-metrics-changed']) {
    screen.on(type, () => {
      notifyPage('displays', displayList());
      if (markers.win && !markers.win.isDestroyed()) sendFrame(markers.win, markers.display);
      if (markers.state) updateMarkers(markers.state);
      if (lens.state) updateLens(lens.state);
    });
  }

  app.on('will-quit', () => {
    stopHelper();
    apps.wanted = false;
    stopAppWatch();
    for (const win of [markers.win, editor.win, lens.win]) if (win && !win.isDestroyed()) win.destroy();
  });
}

module.exports = { setup };
