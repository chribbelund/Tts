'use strict';

// Copies the page into desktop/web/ so electron-builder can pack it. The
// packaged app loads that copy; a checkout runs the files one level up
// directly, so this only has to be right at build time.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, '..', 'web');

const ENTRIES = ['index.html', 'style.css', 'js', 'favicon.svg', 'favicon.ico', 'apple-touch-icon.png'];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let copied = 0;
for (const entry of ENTRIES) {
  const from = path.join(ROOT, entry);
  if (!fs.existsSync(from)) {
    console.error(`sync-web: missing ${entry}`);
    process.exit(1);
  }
  fs.cpSync(from, path.join(OUT, entry), { recursive: true });
  copied++;
}

console.log(`sync-web: copied ${copied} entries into ${path.relative(process.cwd(), OUT)}`);
