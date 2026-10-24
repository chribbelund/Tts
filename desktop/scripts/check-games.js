'use strict';

// Checks the ready-made games in screen/games before they ship:
//   npm run check-games
// The app quietly fixes or skips what's wrong in a game file; this says what
// it is, so a new game doesn't lose a zone without anyone noticing. A game
// file is what "Save as a game file" writes (desktop/bot/screen.js).

const fs = require('node:fs');
const path = require('node:path');
const L = require('../bot/screen-layout.js');

const DIR = path.join(__dirname, '..', 'screen', 'games');
const MODES = new Set(['changes', 'new-lines', 'menu', 'cooldown', 'count', 'manual']);
const INTERRUPTS = new Set(['self', 'all', 'none']);
const FITS = new Set(['number', 'any', 'text']);

const inUnit = (v) => typeof v === 'number' && v >= 0 && v <= 1;
function rectProblem(r) {
  if (!r || typeof r !== 'object') return 'has no rect';
  if (![r.x, r.y, r.w, r.h].every(inUnit)) return 'has a rect outside 0…1 (rects are fractions of the screen)';
  if (r.w <= 0 || r.h <= 0) return 'has a rect with no size';
  if (r.x + r.w > 1.0001 || r.y + r.h > 1.0001) return 'goes off the edge of the screen';
  return '';
}

let bad = 0;
const ids = new Map();
const apps = new Map();
for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort()) {
  const problems = [];
  const say = (text) => problems.push(text);
  let g;
  try { g = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')); } catch (err) { say(`isn't JSON: ${err.message}`); }
  if (g) {
    if (g.format !== 'chat-reader-game') say('format should be "chat-reader-game"');
    if (!g.name) say('has no name');
    if (!g.id) say('has no id');
    else if (ids.has(g.id)) say(`has the same id as ${ids.get(g.id)}`);
    else ids.set(g.id, file);
    if (!g.ref || !(g.ref.width >= 100) || !(g.ref.height >= 100)) say('ref needs the width and height of the screen it was made on');
    if (g.ref && g.ref.aspect && !(g.ref.aspect > 0.5 && g.ref.aspect < 5)) say('ref.aspect should be 0, or the shape the game draws at (16:9 is 1.7778)');
    for (const a of Array.isArray(g.apps) ? g.apps : []) {
      const key = L.comparable(a);
      if (apps.has(key)) say(`shares the program ${a} with ${apps.get(key)}`);
      else apps.set(key, file);
    }
    if (!Array.isArray(g.zones) || !g.zones.length) say('has no zones');
    (g.zones || []).forEach((z, i) => {
      const who = `zone ${i + 1} (${z.name || 'no name'})`;
      if (!z.name) say(`${who} has no name`);
      const r = rectProblem(z.rect);
      if (r) say(`${who} ${r}`);
      if (!MODES.has(z.mode)) say(`${who} has the mode "${z.mode}", not one of ${[...MODES].join(', ')}`);
      if (z.interrupt !== undefined && !INTERRUPTS.has(z.interrupt)) say(`${who} has the interrupt "${z.interrupt}"`);
      if (z.anchor && !L.ANCHORS[z.anchor]) say(`${who} has the anchor "${z.anchor}", not one of ${Object.keys(L.ANCHORS).join(' ')}`);
      if (z.fit && !FITS.has(z.fit)) say(`${who} has fit "${z.fit}", not one of ${[...FITS].join(', ')}`);
      if (z.fit === 'text' && !z.fitText) say(`${who} fits by text but has no fitText`);
    });
    (g.landmarks || []).forEach((m, i) => {
      if (!m.text) say(`landmark ${i + 1} has no text`);
      const r = rectProblem(m.rect);
      if (r) say(`landmark ${i + 1} ${r}`);
    });
    const fitBy = (g.zones || []).filter((z) => z.fit).length + (g.landmarks || []).length;
    if (!fitBy) say('has nothing to fit by: give a zone that is always on screen "fit": "number" or "any", or add landmarks');
  }
  if (problems.length) {
    bad++;
    console.log(`✗ ${file}`);
    for (const p of problems) console.log(`    ${p}`);
  } else {
    console.log(`✓ ${file}: ${g.name}, ${g.zones.length} zones`);
  }
}
process.exitCode = bad ? 1 : 0;
