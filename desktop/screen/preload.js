'use strict';

// For the windows the screen reader puts on top of a game (screen-main.js):
// the zone editor, the zone outlines and the lens.

const { contextBridge, ipcRenderer } = require('electron');

const arg = process.argv.find((a) => a.startsWith('--screen-role='));

contextBridge.exposeInMainWorld('screenOverlay', {
  role: arg ? arg.slice('--screen-role='.length) : '',
  platform: process.platform,
  onState: (handler) => ipcRenderer.on('screen-overlay:state', (_event, state) => handler(state)),
  // Where the screen is inside this window: { x, y, width, height } in its pixels.
  onFrame: (handler) => ipcRenderer.on('screen-overlay:frame', (_event, frame) => handler(frame)),
  // The editor: the zones as they are now, or null to throw the changes away.
  done: (zones, selected = '') => ipcRenderer.send('screen-editor:done', zones ? { zones, selected } : null),
  // Spoken by the reader, for someone who can't see the editor well.
  say: (text) => ipcRenderer.send('screen-overlay:say', text),
});
