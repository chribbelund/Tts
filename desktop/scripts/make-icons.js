'use strict';

// Renders favicon.svg into build/icon.png at 1024×1024, which electron-builder
// turns into .icns and .ico itself. Runs under Electron, not node: `npm run
// icons` after changing the SVG. The PNG is committed so builds don't need it.

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const SIZE = 1024;
const SVG = path.join(__dirname, '..', '..', 'favicon.svg');
const OUT = path.join(__dirname, '..', 'build', 'icon.png');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const svg = fs.readFileSync(SVG, 'utf8');
  const html = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:transparent}svg{display:block;width:${SIZE}px;height:${SIZE}px}</style>
${svg}`;

  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true },
  });

  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, image.toPNG());
  console.log(`icons: wrote ${path.relative(process.cwd(), OUT)} (${image.getSize().width}×${image.getSize().height})`);
  win.destroy();
  app.quit();
});
