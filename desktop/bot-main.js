'use strict';

// The main-process half of the bot (see docs/bot-plan.md). The bot itself runs
// in the page, next to the reader; this file does what a page can't:
//   - keeps the bot's files (setup, viewer database) under the user data folder
//   - keeps the Twitch tokens encrypted with the OS keychain (safeStorage)
//   - serves the OBS overlay and the HTTP API on 127.0.0.1
//   - makes HTTP requests without CORS, and writes text files for OBS
// Only the desktop app loads this; the website has no bot at all.

const { app, dialog, ipcMain, Notification, safeStorage, shell } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const OVERLAY_DIR = path.join(__dirname, 'overlay');
const DEFAULT_PORT = 7473;
const STORE_NAME_RE = /^[a-z0-9-]{1,40}$/;
const MAX_STORE_BYTES = 64 * 1024 * 1024;
const MAX_HTTP_BYTES = 1024 * 1024;

const MEDIA_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.apng': 'image/apng', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.flac': 'audio/flac', '.opus': 'audio/ogg',
};
const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const PICK_FILTERS = {
  sound: [{ name: 'Sounds', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus'] }],
  image: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'apng', 'avif'] }],
  video: [{ name: 'Videos', extensions: ['mp4', 'webm', 'mov', 'm4v'] }],
  media: [{ name: 'Images and videos', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'apng', 'avif', 'mp4', 'webm', 'mov', 'm4v'] }],
  text: [{ name: 'Text files', extensions: ['txt'] }],
  csv: [{ name: 'Spreadsheet (CSV)', extensions: ['csv'] }],
  json: [{ name: 'Bot setup', extensions: ['json'] }],
};

function botDir() {
  const dir = path.join(app.getPath('userData'), 'bot');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Written next to the target and renamed over it, so a crash mid-write
// leaves the old file rather than half a new one.
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// ---------------------------------------------------------------------------
// Secrets: the Twitch tokens and the OBS password
// ---------------------------------------------------------------------------

const secretsFile = () => path.join(botDir(), 'secrets.json');

function getSecret(name) {
  const all = readJson(secretsFile(), {});
  const item = all[name];
  if (!item) return null;
  try {
    if (item.enc) return safeStorage.decryptString(Buffer.from(item.value, 'base64'));
    return item.value;
  } catch {
    return null;
  }
}

function setSecret(name, value) {
  const all = readJson(secretsFile(), {});
  if (value === null || value === undefined || value === '') {
    delete all[name];
  } else if (safeStorage.isEncryptionAvailable()) {
    all[name] = { enc: true, value: safeStorage.encryptString(String(value)).toString('base64') };
  } else {
    // Linux without a keyring: there is nothing to encrypt with.
    all[name] = { enc: false, value: String(value) };
  }
  writeAtomic(secretsFile(), JSON.stringify(all));
  return true;
}

// ---------------------------------------------------------------------------
// Files the page may write to: only ones the streamer picked in a save dialog
// ---------------------------------------------------------------------------

const grantedFile = () => path.join(botDir(), 'granted.json');
const grantedPaths = () => new Set(readJson(grantedFile(), []));

function grantPath(file) {
  const all = grantedPaths();
  all.add(path.resolve(file));
  writeAtomic(grantedFile(), JSON.stringify([...all].slice(-200)));
}

// ---------------------------------------------------------------------------
// Overlay and API server
// ---------------------------------------------------------------------------

const overlay = {
  server: null,
  port: DEFAULT_PORT,
  apiKey: '',
  error: '',
  clients: new Set(),
  media: new Map(),        // id -> absolute path
  mediaIds: new Map(),     // absolute path -> id
  counters: new Map(),     // name -> last counter event, replayed to new overlays
  catalog: [],             // effect lists the API can run: [{ id, name }]
  secret: crypto.randomBytes(16).toString('hex'),
  heartbeat: null,
};

let getWindow = () => null;

function overlayStatus() {
  return {
    running: !!(overlay.server && overlay.server.listening),
    port: overlay.port,
    url: `http://127.0.0.1:${overlay.port}/`,
    clients: overlay.clients.size,
    error: overlay.error,
  };
}

function mediaUrl(file) {
  const abs = path.resolve(String(file));
  const ext = path.extname(abs).toLowerCase();
  if (!MEDIA_TYPES[ext]) return '';
  let id = overlay.mediaIds.get(abs);
  if (!id) {
    id = crypto.createHash('sha256').update(overlay.secret + abs).digest('hex').slice(0, 24);
    overlay.mediaIds.set(abs, id);
    overlay.media.set(id, abs);
  }
  return `/media/${id}/${encodeURIComponent(path.basename(abs))}`;
}

// File paths in an overlay event become URLs the overlay can load. Anything
// that isn't an image, video or sound is dropped.
function withMediaUrls(value) {
  if (Array.isArray(value)) return value.map(withMediaUrls);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if ((key === 'file' || key === 'soundFile') && typeof v === 'string') {
      if (/^https?:\/\//i.test(v)) out[key === 'file' ? 'src' : 'soundSrc'] = v;
      else if (v) out[key === 'file' ? 'src' : 'soundSrc'] = mediaUrl(v);
    } else {
      out[key] = withMediaUrls(v);
    }
  }
  return out;
}

function broadcast(event) {
  const data = withMediaUrls(event);
  if (data.type === 'counter' && data.name) overlay.counters.set(String(data.name).toLowerCase(), data);
  const line = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of overlay.clients) {
    // An instance only gets what's meant for it; '' is every overlay.
    if (data.instance && client.instance !== data.instance && data.type !== 'counter') continue;
    client.res.write(line);
  }
}

function sendFile(req, res, file, type) {
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); res.end(); return; }
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
    if (range) {
      const start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
      if (start > end || start >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return; }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': stat.size });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function handleRequest(req, res) {
  let url;
  try { url = new URL(req.url, 'http://127.0.0.1'); } catch { res.writeHead(400); res.end(); return; }
  const parts = url.pathname.split('/').filter(Boolean);

  if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    const client = { res, instance: (url.searchParams.get('instance') || '').slice(0, 40) };
    overlay.clients.add(client);
    for (const counter of overlay.counters.values()) res.write(`data: ${JSON.stringify(counter)}\n\n`);
    req.on('close', () => { overlay.clients.delete(client); notifyPage('overlay', overlayStatus()); });
    notifyPage('overlay', overlayStatus());
    return;
  }

  if (parts[0] === 'media' && parts[1]) {
    const file = overlay.media.get(parts[1]);
    if (!file) { res.writeHead(404); res.end(); return; }
    sendFile(req, res, file, MEDIA_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
    return;
  }

  // The API is for Stream Deck and the like. A web page in the streamer's own
  // browser can reach 127.0.0.1 too, so every call needs the key.
  if (parts[0] === 'api') {
    const key = url.searchParams.get('key') || req.headers['x-api-key'] || '';
    const okKey = overlay.apiKey && key.length === overlay.apiKey.length
      && crypto.timingSafeEqual(Buffer.from(String(key)), Buffer.from(overlay.apiKey));
    if (!okKey) return json(res, 401, { error: 'Missing or wrong key. Find it in the app under Shortcuts & API.' });
    if (parts[1] === 'lists' && req.method === 'GET') return json(res, 200, { lists: overlay.catalog });
    if (parts[1] === 'run' && parts[2] && (req.method === 'POST' || req.method === 'GET')) {
      const id = decodeURIComponent(parts[2]);
      const item = overlay.catalog.find((l) => l.id === id || l.name.toLowerCase() === id.toLowerCase());
      if (!item) return json(res, 404, { error: 'No effect list with that id or name' });
      const args = url.searchParams.getAll('arg').map((a) => a.slice(0, 500)).slice(0, 10);
      notifyPage('api', { action: 'run', id: item.id, args });
      return json(res, 200, { ok: true, ran: item.name });
    }
    return json(res, 404, { error: 'Unknown API call' });
  }

  const name = parts.length ? parts.join('/') : 'index.html';
  const ext = path.extname(name);
  if (!/^[\w.-]+$/.test(name) || !STATIC_TYPES[ext]) { res.writeHead(404); res.end(); return; }
  sendFile(req, res, path.join(OVERLAY_DIR, name), STATIC_TYPES[ext]);
}

function stopServer() {
  for (const client of overlay.clients) client.res.end();
  overlay.clients.clear();
  if (overlay.server) overlay.server.close();
  overlay.server = null;
}

function startServer(port) {
  stopServer();
  overlay.port = port;
  overlay.error = '';
  return new Promise((resolve) => {
    const server = http.createServer(handleRequest);
    server.on('error', (err) => {
      overlay.error = err.code === 'EADDRINUSE' ? `Port ${port} is already in use by another program` : err.message;
      if (overlay.server === server) overlay.server = null;
      resolve(overlayStatus());
    });
    server.listen(port, '127.0.0.1', () => resolve(overlayStatus()));
    overlay.server = server;
  });
}

function notifyPage(type, payload) {
  const win = getWindow();
  if (win && !win.isDestroyed()) win.webContents.send('bot:main-event', { type, payload });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function setup(options) {
  getWindow = options.getWindow;
  require('./multistream-main').setup({ getSecret });
  require('./import-main').setup({ getWindow });

  overlay.heartbeat = setInterval(() => {
    for (const client of overlay.clients) client.res.write(': ping\n\n');
  }, 20000);

  ipcMain.handle('bot:store-read', (_event, name) => {
    if (!STORE_NAME_RE.test(String(name))) return null;
    try { return fs.readFileSync(path.join(botDir(), `${name}.json`), 'utf8'); } catch { return null; }
  });

  ipcMain.on('bot:store-write', (_event, name, text) => {
    if (!STORE_NAME_RE.test(String(name)) || typeof text !== 'string' || text.length > MAX_STORE_BYTES) return;
    try { writeAtomic(path.join(botDir(), `${name}.json`), text); } catch (err) { console.error('bot store:', err.message); }
  });

  ipcMain.handle('bot:secret-get', (_event, name) => (/^[\w-]{1,40}$/.test(String(name)) ? getSecret(name) : null));
  ipcMain.handle('bot:secret-set', (_event, name, value) => (/^[\w-]{1,40}$/.test(String(name)) ? setSecret(name, value) : false));
  ipcMain.handle('bot:secure-storage', () => safeStorage.isEncryptionAvailable());

  ipcMain.handle('bot:pick-file', async (_event, { kind = 'media', save = false, defaultName = '' } = {}) => {
    const win = getWindow();
    const filters = PICK_FILTERS[kind] || [];
    if (save) {
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        defaultPath: path.join(app.getPath('documents'), path.basename(String(defaultName || 'chat-reader.txt'))),
        filters,
      });
      if (canceled || !filePath) return { canceled: true };
      if (kind === 'text' || kind === 'json' || kind === 'csv') grantPath(filePath);
      return { path: filePath };
    }
    const { canceled, filePaths } = await dialog.showOpenDialog(win, { properties: ['openFile'], filters });
    if (canceled || !filePaths || !filePaths[0]) return { canceled: true };
    return { path: filePaths[0], name: path.basename(filePaths[0]) };
  });

  ipcMain.handle('bot:read-file', async (_event, file) => {
    // Only for loading a setup the streamer just picked in the open dialog.
    try {
      const abs = path.resolve(String(file));
      if (path.extname(abs).toLowerCase() !== '.json') return { error: 'not a .json file' };
      const { size } = await fs.promises.stat(abs);
      if (size > MAX_STORE_BYTES) return { error: 'that file is too big' };
      return { text: await fs.promises.readFile(abs, 'utf8') };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('bot:write-file', async (_event, { file, text = '', append = false } = {}) => {
    const abs = path.resolve(String(file || ''));
    // Only files the streamer picked in a save dialog: a text file for OBS,
    // or where a backup of the setup goes.
    if (!grantedPaths().has(abs)) {
      return { error: 'Pick the file again with “Choose…”, so the app may write to it' };
    }
    try {
      if (append) await fs.promises.appendFile(abs, `${String(text)}\n`, 'utf8');
      else await fs.promises.writeFile(abs, String(text), 'utf8');
      return { ok: true };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('bot:http', async (_event, req = {}) => {
    const method = String(req.method || 'GET').toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return { error: 'unsupported method' };
    let url;
    try { url = new URL(String(req.url)); } catch { return { error: 'not a valid URL' }; }
    if (!/^https?:$/.test(url.protocol)) return { error: 'only http and https URLs' };
    const headers = {};
    for (const [k, v] of Object.entries(req.headers || {})) if (/^[\w-]{1,60}$/.test(k)) headers[k] = String(v).slice(0, 2000);
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: method === 'GET' || req.body === undefined || req.body === '' ? undefined : String(req.body).slice(0, MAX_HTTP_BYTES),
        signal: AbortSignal.timeout(Math.min(30000, Math.max(1000, Number(req.timeout) || 10000))),
      });
      const text = (await res.text()).slice(0, MAX_HTTP_BYTES);
      return { status: res.status, ok: res.ok, text };
    } catch (err) {
      return { error: err.name === 'TimeoutError' ? 'timed out' : err.message };
    }
  });

  ipcMain.on('bot:notify', (_event, { title = '', body = '' } = {}) => {
    if (!Notification.isSupported()) return;
    new Notification({ title: String(title).slice(0, 120) || 'Chat Reader', body: String(body).slice(0, 400), silent: false }).show();
  });

  ipcMain.handle('overlay:configure', async (_event, { port = DEFAULT_PORT, apiKey = '', enabled = true } = {}) => {
    overlay.apiKey = /^[\w-]{16,80}$/.test(String(apiKey)) ? String(apiKey) : '';
    const wanted = Math.round(Number(port));
    if (!enabled) { stopServer(); return overlayStatus(); }
    if (!(wanted >= 1024 && wanted <= 65535)) { overlay.error = 'Pick a port between 1024 and 65535'; return overlayStatus(); }
    if (overlay.server && overlay.server.listening && overlay.port === wanted) return overlayStatus();
    return startServer(wanted);
  });

  ipcMain.handle('overlay:status', () => overlayStatus());
  ipcMain.on('overlay:send', (_event, payload) => { if (payload && typeof payload === 'object') broadcast(payload); });
  ipcMain.on('overlay:catalog', (_event, list) => {
    overlay.catalog = Array.isArray(list)
      ? list.filter((l) => l && typeof l.id === 'string' && typeof l.name === 'string').slice(0, 500).map((l) => ({ id: l.id, name: l.name }))
      : [];
  });
  ipcMain.on('overlay:open', () => shell.openExternal(overlayStatus().url));

  app.on('will-quit', () => { clearInterval(overlay.heartbeat); stopServer(); });
}

module.exports = { setup };
