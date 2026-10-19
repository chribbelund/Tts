'use strict';

// The bot's own storage: one SQLite file (bot.db) under the user data folder,
// using the SQLite that ships inside Electron's Node (node:sqlite), so there is
// no native module to build. It holds:
//   - stores:  whole documents the page saves by name (the bot setup)
//   - viewers: one row per viewer, so a chat message rewrites one row instead
//              of the whole viewer list
//   - secrets: the Twitch tokens and OBS password (encrypted by bot-main.js)
//   - granted: files the streamer picked in a save dialog
// The JSON files older versions wrote are read in once, then renamed to
// *.json.migrated so they're still there if something goes wrong.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const MAX_GRANTED = 200;

let db = null;
let stmts = null;

function open(dir) {
  if (db) return db;
  db = new DatabaseSync(path.join(dir, 'bot.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS stores  (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS viewers (key  TEXT PRIMARY KEY, data  TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, enc INTEGER NOT NULL, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS granted (path TEXT PRIMARY KEY, at INTEGER NOT NULL);
  `);
  stmts = {
    storeGet: db.prepare('SELECT value FROM stores WHERE name = ?'),
    storeSet: db.prepare('INSERT INTO stores (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value'),
    viewersAll: db.prepare('SELECT key, data FROM viewers'),
    viewerSet: db.prepare('INSERT INTO viewers (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data'),
    viewerDelete: db.prepare('DELETE FROM viewers WHERE key = ?'),
    viewersClear: db.prepare('DELETE FROM viewers'),
    secretGet: db.prepare('SELECT enc, value FROM secrets WHERE name = ?'),
    secretSet: db.prepare('INSERT INTO secrets (name, enc, value) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET enc = excluded.enc, value = excluded.value'),
    secretDelete: db.prepare('DELETE FROM secrets WHERE name = ?'),
    grantedHas: db.prepare('SELECT 1 FROM granted WHERE path = ?'),
    grantedAdd: db.prepare('INSERT INTO granted (path, at) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET at = excluded.at'),
    grantedTrim: db.prepare(`DELETE FROM granted WHERE path NOT IN (SELECT path FROM granted ORDER BY at DESC LIMIT ${MAX_GRANTED})`),
  };
  migrate(dir);
  return db;
}

function transaction(fn) {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The JSON files from before
// ---------------------------------------------------------------------------

function migrate(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  if (!files.length) return;
  const read = (file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  const done = [];
  for (const file of files) {
    const name = file.slice(0, -5);
    try {
      transaction(() => {
        if (name === 'bot-viewers') {
          const users = (read(file) || {}).users || {};
          for (const [key, v] of Object.entries(users)) stmts.viewerSet.run(key, JSON.stringify(v));
        } else if (name === 'secrets') {
          for (const [key, item] of Object.entries(read(file) || {})) {
            if (item && typeof item.value === 'string') stmts.secretSet.run(key, item.enc ? 1 : 0, item.value);
          }
        } else if (name === 'granted') {
          const list = read(file);
          (Array.isArray(list) ? list : []).forEach((p, i) => stmts.grantedAdd.run(String(p), i));
        } else {
          stmts.storeSet.run(name, fs.readFileSync(path.join(dir, file), 'utf8'));
        }
      });
      done.push(file);
    } catch (err) {
      // Left where it is, so the next start tries again.
      console.error(`bot db: couldn’t move ${file} into bot.db:`, err.message);
    }
  }
  for (const file of done) {
    try { fs.renameSync(path.join(dir, file), path.join(dir, `${file}.migrated`)); } catch { /* read again next time; rows are upserts */ }
  }
}

// ---------------------------------------------------------------------------
// Named documents
// ---------------------------------------------------------------------------

// The viewer list is put back together into the shape the page has always had.
function readStore(name) {
  if (name === 'bot-viewers') {
    const users = {};
    for (const row of stmts.viewersAll.all()) {
      try { users[row.key] = JSON.parse(row.data); } catch { /* skip a broken row */ }
    }
    return JSON.stringify({ users });
  }
  const row = stmts.storeGet.get(name);
  return row ? row.value : null;
}

function writeStore(name, text) {
  if (name === 'bot-viewers') {
    let users = {};
    try { users = (JSON.parse(text) || {}).users || {}; } catch { return; }
    writeViewers({ replace: true, upsert: Object.entries(users).map(([key, v]) => [key, JSON.stringify(v)]) });
    return;
  }
  stmts.storeSet.run(name, text);
}

// `upsert` is [[key, json], …], `remove` is [key, …]. With `replace`, every
// viewer not in `upsert` is dropped (a backup was loaded).
function writeViewers({ upsert = [], remove = [], replace = false } = {}) {
  transaction(() => {
    if (replace) stmts.viewersClear.run();
    for (const [key, data] of upsert) stmts.viewerSet.run(String(key), String(data));
    for (const key of remove) stmts.viewerDelete.run(String(key));
  });
}

// ---------------------------------------------------------------------------
// Secrets and granted files
// ---------------------------------------------------------------------------

function getSecretRow(name) {
  const row = stmts.secretGet.get(name);
  return row ? { enc: !!row.enc, value: row.value } : null;
}

function setSecretRow(name, row) {
  if (!row) stmts.secretDelete.run(name);
  else stmts.secretSet.run(name, row.enc ? 1 : 0, row.value);
}

function isGranted(file) {
  return !!stmts.grantedHas.get(file);
}

function grant(file) {
  stmts.grantedAdd.run(file, Date.now());
  stmts.grantedTrim.run();
}

function close() {
  if (!db) return;
  try { db.close(); } catch { /* already closed */ }
  db = null;
  stmts = null;
}

module.exports = { open, close, readStore, writeStore, writeViewers, getSecretRow, setSecretRow, isGranted, grant };
