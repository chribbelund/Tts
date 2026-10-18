'use strict';

// Reading other bots' data for the bot's importer (desktop/bot/importers.js).
// This side only finds and reads the files — JSON, NeDB lines, SQLite
// databases and zip backups — and hands their contents to the page, which
// turns them into commands, events and the rest.
//
//   Firebot:   a profile folder (…/Firebot/v5/profiles/<name>) or a .firebotsetup file
//   Mix It Up: a .miubackup (a zip), its .miu database, or a .miucommand file

const { app, dialog, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const MAX_FILE = 200 * 1024 * 1024;
const MAX_ROWS = 200000;

// What's read from a Firebot profile. A path ending in / is every .json in it.
const FIREBOT_FILES = [
  'chat/commands.json', 'events/events.json', 'timers.json', 'counters/counters.json',
  'effects/preset-effect-lists.json', 'currency/currency.json', 'hotkeys.json',
  'roles/', 'db/users.db', 'db/quotes.db',
];

function readText(file) {
  const { size } = fs.statSync(file);
  if (size > MAX_FILE) throw new Error(`${path.basename(file)} is too big`);
  return fs.readFileSync(file, 'utf8');
}

// Every table of an SQLite database, as plain rows. Blobs are left out.
function readSqlite(file) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = {};
    let total = 0;
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
      if (!/^[\w$ -]{1,80}$/.test(name)) continue;
      const rows = db.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}" LIMIT ${MAX_ROWS}`).all();
      tables[name] = rows.map((row) => {
        const out = {};
        for (const [k, v] of Object.entries(row)) {
          if (v instanceof Uint8Array) continue;
          out[k] = typeof v === 'bigint' ? Number(v) : v;
        }
        return out;
      });
      total += rows.length;
      if (total > MAX_ROWS * 2) break;
    }
    return tables;
  } finally {
    db.close();
  }
}

// A minimal zip reader: stored and deflated entries, which is what backups use.
function readZip(file) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('That isn’t a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count && at + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) break;
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataAt, dataAt + size);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else continue;
    entries.push({ name, data });
  }
  return entries;
}

// The profile inside whatever folder was picked: the folder itself, or the
// most recently used profile under it.
function findFirebotProfile(dir) {
  const isProfile = (d) => ['chat/commands.json', 'events/events.json', 'timers.json'].some((f) => fs.existsSync(path.join(d, f)));
  if (isProfile(dir)) return dir;
  const candidates = [];
  for (const base of [dir, path.join(dir, 'profiles'), path.join(dir, 'v5', 'profiles')]) {
    let names = [];
    try { names = fs.readdirSync(base); } catch { continue; }
    for (const name of names) {
      const d = path.join(base, name);
      if (!isProfile(d)) continue;
      const times = ['chat/commands.json', 'events/events.json', 'timers.json'].map((f) => {
        try { return fs.statSync(path.join(d, f)).mtimeMs; } catch { return 0; }
      });
      candidates.push({ d, at: Math.max(...times) });
    }
  }
  candidates.sort((a, b) => b.at - a.at);
  return candidates.length ? candidates[0].d : null;
}

function readFirebotProfile(dir) {
  const files = {};
  for (const rel of FIREBOT_FILES) {
    const full = path.join(dir, rel);
    try {
      if (rel.endsWith('/')) {
        for (const name of fs.readdirSync(full)) if (name.endsWith('.json')) files[rel + name] = readText(path.join(full, name));
      } else if (fs.existsSync(full)) {
        files[rel] = readText(full);
      }
    } catch {}
  }
  const databases = {};
  let names = [];
  try { names = fs.readdirSync(path.join(dir, 'databases')); } catch {}
  for (const name of names) {
    if (!name.endsWith('.db')) continue;
    try { databases[name] = readSqlite(path.join(dir, 'databases', name)); } catch {}
  }
  return { kind: 'firebot', name: path.basename(dir), files, databases };
}

function readMixItUp(file) {
  const ext = path.extname(file).toLowerCase();
  const name = path.basename(file);
  if (ext === '.miucommand' || ext === '.json') return { kind: 'mixitup', name, files: { [name]: readText(file) }, databases: {} };
  if (ext === '.miubackup' || ext === '.zip') {
    const files = {};
    const databases = {};
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-reader-import-'));
    try {
      for (const entry of readZip(file)) {
        const base = path.basename(entry.name);
        if (/\.(json|miucommand)$/i.test(base) && entry.data.length < MAX_FILE) files[entry.name] = entry.data.toString('utf8');
        // The settings database: an SQLite file, whatever it's called.
        if (entry.data.subarray(0, 15).toString('latin1') === 'SQLite format 3') {
          const out = path.join(tmp, base.replace(/[^\w.-]/g, '_') || 'settings.db');
          fs.writeFileSync(out, entry.data);
          try { databases[entry.name] = readSqlite(out); } catch {}
        }
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    return { kind: 'mixitup', name, files, databases };
  }
  return { kind: 'mixitup', name, files: {}, databases: { [name]: readSqlite(file) } };
}

function setup({ getWindow }) {
  ipcMain.handle('import:read', async (_event, { kind = '' } = {}) => {
    const win = getWindow();
    try {
      if (kind === 'firebot-folder') {
        const guess = path.join(app.getPath('appData'), 'Firebot', 'v5', 'profiles');
        const { canceled, filePaths } = await dialog.showOpenDialog(win, {
          title: 'Pick your Firebot profile folder',
          message: 'Firebot keeps it in Firebot/v5/profiles, in your app data folder.',
          defaultPath: fs.existsSync(guess) ? guess : app.getPath('home'),
          properties: ['openDirectory'],
        });
        if (canceled || !filePaths[0]) return { canceled: true };
        const profile = findFirebotProfile(filePaths[0]);
        if (!profile) return { error: 'There’s no Firebot profile in that folder. It’s the one with chat, events and effects folders in it, under Firebot/v5/profiles.' };
        return { bundle: readFirebotProfile(profile) };
      }
      if (kind === 'firebot-setup') {
        const { canceled, filePaths } = await dialog.showOpenDialog(win, {
          title: 'Pick a Firebot setup', properties: ['openFile'], filters: [{ name: 'Firebot setup', extensions: ['firebotsetup', 'json'] }],
        });
        if (canceled || !filePaths[0]) return { canceled: true };
        return { bundle: { kind: 'firebot-setup', name: path.basename(filePaths[0]), files: { setup: readText(filePaths[0]) }, databases: {} } };
      }
      if (kind === 'mixitup') {
        const guess = path.join(app.getPath('appData'), 'MixItUp');
        const { canceled, filePaths } = await dialog.showOpenDialog(win, {
          title: 'Pick a Mix It Up backup, settings file or exported command',
          defaultPath: fs.existsSync(guess) ? guess : app.getPath('documents'),
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: 'Mix It Up', extensions: ['miubackup', 'miu', 'mixitup', 'miucommand', 'zip', 'json', 'db', 'sqlite'] }],
        });
        if (canceled || !filePaths.length) return { canceled: true };
        const bundle = { kind: 'mixitup', name: filePaths.map((f) => path.basename(f)).join(', '), files: {}, databases: {} };
        for (const file of filePaths.slice(0, 50)) {
          const part = readMixItUp(file);
          Object.assign(bundle.files, part.files);
          Object.assign(bundle.databases, part.databases);
        }
        return { bundle };
      }
      return { error: 'Unknown import' };
    } catch (err) {
      return { error: err.message };
    }
  });
}

module.exports = { setup, readZip, readSqlite, findFirebotProfile, readFirebotProfile, readMixItUp };
