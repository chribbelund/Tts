'use strict';

// The screen reader. Ordinary screen readers follow the mouse, which is no
// use in a game that keeps the mouse locked in the middle of the screen. This
// one never looks at the mouse. It has three ways in:
//
//   Reading zones  Boxes on the screen, drawn once per game (a profile). Each
//                  is watched, and its text is read out loud when it changes,
//                  in a voice of its own: subtitles in one voice, the quest
//                  log in another, the menu in a third. A profile can name
//                  the programs it's for; it's picked by itself when one of
//                  them comes to the front.
//   Reading cursor Hotkeys that work inside the game: read the whole screen,
//                  step to the next or previous line of text, to the one on
//                  the left or right, or to the text in the middle of the
//                  screen, where a game's crosshair is ("what am I aiming at").
//   Lens           A magnifier window that follows whatever is being read,
//                  with the text in large letters under it.
//
// The screen is captured here; the text is recognised by the operating
// system (Apple Vision, Windows OCR) through screen-main.js. Positions are
// fractions of the screen, so zones survive a change of resolution.
//
// A zone:
//   { id, name, enabled, rect: { x, y, w, h },
//     mode: changes | new-lines | menu | manual,
//     voice: { engine: '' | 'system' | 'kokoro', voiceId, rate, pitch, volume },
//     interrupt: self | all | none, settle (ms), prefix, ignore, only, color }
//   ignore: words or /regex/ taken out of the text, one per line
//   only:   when set, only text matching one of these (one per line) is read

(() => {
  const desktop = window.chatReaderDesktop && window.chatReaderDesktop.screen;
  const host = Bot.host;

  const S = Bot.screen = {
    status: 'off',          // off | starting | watching | error
    problem: '',            // what's wrong, in words
    ocr: { engine: '', running: false, error: '', maxSide: 0, fallback: false },
    access: 'unknown',      // macOS screen recording: granted | denied | not-determined | …
    displays: [],
    focus: null,            // { rect, text, at } what's being read
    last: new Map(),        // zone id -> { text, at } last thing read from it
    map: null,              // the reading cursor's text: { at, lines, index }
    speaking: null,         // { text, zone }
    app: null,              // the program in front: { pid, exe, name, id, title }
  };

  const MODES = [
    ['changes', 'Read the text when it changes (subtitles, dialogue, objectives)'],
    ['new-lines', 'Read only new lines (logs, notifications, game chat)'],
    ['menu', 'Read the highlighted line as it moves (menus, dialogue choices)'],
    ['manual', 'Only when I ask (its number key or Read now)'],
  ];
  S.MODES = MODES;

  const INTERRUPTS = [
    ['self', 'Cuts off its own older text'],
    ['all', 'Cuts off anything being read'],
    ['none', 'Waits its turn'],
  ];
  S.INTERRUPTS = INTERRUPTS;

  // Starting points, for people who'd rather not draw. Fractions of the screen.
  S.TEMPLATES = [
    { name: 'Subtitles', rect: { x: 0.12, y: 0.76, w: 0.76, h: 0.2 }, mode: 'changes', settle: 300, interrupt: 'self' },
    { name: 'Dialogue choices', rect: { x: 0.52, y: 0.42, w: 0.36, h: 0.34 }, mode: 'menu', settle: 200, interrupt: 'self' },
    { name: 'Objective', rect: { x: 0.7, y: 0.12, w: 0.29, h: 0.22 }, mode: 'changes', settle: 600, interrupt: 'none' },
    { name: 'Notifications', rect: { x: 0.01, y: 0.08, w: 0.32, h: 0.3 }, mode: 'new-lines', settle: 400, interrupt: 'none' },
    { name: 'Crosshair', rect: { x: 0.36, y: 0.4, w: 0.28, h: 0.2 }, mode: 'changes', settle: 500, interrupt: 'self' },
    { name: 'Whole screen', rect: { x: 0, y: 0, w: 1, h: 1 }, mode: 'manual', settle: 400, interrupt: 'all' },
  ];

  const ZONE_DEFAULTS = {
    name: 'Zone', enabled: true, rect: { x: 0.3, y: 0.4, w: 0.4, h: 0.2 }, mode: 'changes',
    voice: { engine: '', voiceId: '', rate: 1, pitch: 1, volume: 100 },
    interrupt: 'self', settle: 350, prefix: '', ignore: '', only: '', color: '',
  };

  const KEY_ACTIONS = [
    ['toggle', 'Zones on / off'],
    ['readAll', 'Read the whole screen'],
    ['next', 'Next line'],
    ['prev', 'Previous line'],
    ['left', 'Text to the left'],
    ['right', 'Text to the right'],
    ['centre', 'Text in the middle (crosshair)'],
    ['repeat', 'Say it again'],
    ['stop', 'Stop reading the screen'],
    ['lens', 'Lens on / off'],
    ['zoomIn', 'Lens zoom in'],
    ['zoomOut', 'Lens zoom out'],
    ['profile', 'Next profile'],
    ['edit', 'Edit the zones on screen'],
  ];
  S.KEY_ACTIONS = KEY_ACTIONS;

  const SENSITIVITY = { low: 3, normal: 1.4, high: 0.6 };   // mean grey change, out of 255
  const MAX_WAIT = 1500;     // a zone that never stops changing is still read this often
  // How old the cursor's text may be: stepping through lines can use what was
  // seen a moment ago, the middle of the screen has to be what's there now.
  const MAP_AGE = { step: 5000, now: 700 };
  const MAP_KEEP_FRESH = 15000;   // after a cursor key, the text is kept fresh this long
  const SCAN_SIDE = 2400;         // a whole screen is read at most this big (pixels)
  const cfg = () => Bot.data.screen;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const uid = (p) => Bot.uid(p);
  // 'screen' redraws the Screen reader page; 'screen-live' only updates the
  // line saying what's being read, so the page doesn't redraw for every line.
  const changed = () => Bot.emit('screen');
  const live = () => Bot.emit('screen-live');

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  function fitRect(r) {
    const src = r && typeof r === 'object' ? r : ZONE_DEFAULTS.rect;
    const w = clamp(Number(src.w) || 0.1, 0.005, 1);
    const h = clamp(Number(src.h) || 0.1, 0.005, 1);
    return { x: clamp(Number(src.x) || 0, 0, 1 - w), y: clamp(Number(src.y) || 0, 0, 1 - h), w, h };
  }

  function normalizeZone(z, i = 0) {
    const zone = { ...Bot.clone(ZONE_DEFAULTS), ...(z && typeof z === 'object' ? z : {}) };
    zone.id = zone.id || uid('z');
    zone.name = String(zone.name || `Zone ${i + 1}`).slice(0, 40);
    zone.rect = fitRect(zone.rect);
    zone.voice = { ...ZONE_DEFAULTS.voice, ...(zone.voice || {}) };
    if (!MODES.some(([m]) => m === zone.mode)) zone.mode = 'changes';
    if (!INTERRUPTS.some(([m]) => m === zone.interrupt)) zone.interrupt = 'self';
    zone.settle = clamp(Math.round(Number(zone.settle) || 350), 0, 5000);
    zone.ignore = String(zone.ignore || '').slice(0, 2000);
    zone.only = String(zone.only || '').slice(0, 2000);
    delete zone.isNew;
    return zone;
  }

  S.newProfile = (name = 'My zones') => ({ id: uid('p'), name, display: '', apps: [], zones: [] });

  // -------------------------------------------------------------------------
  // A profile for each program
  // -------------------------------------------------------------------------

  // "EldenRing.exe", "eldenring" and "Elden Ring.app" are the same program.
  const appKey = (v) => String(v || '').trim().toLowerCase().replace(/\.(exe|app)$/, '');
  S.appKey = appKey;

  // What to save for a program: its file name on Windows (what the game's
  // folder shows), its name on macOS.
  S.appLabel = (app) => (window.chatReaderDesktop.platform === 'win32' ? app.exe || app.name : app.name || app.exe);

  S.appMatches = (entry, app) => {
    const want = appKey(entry);
    return !!want && !!app && [app.exe, app.name, app.id].some((v) => appKey(v) === want);
  };

  S.profileForApp = (app) => cfg().profiles.find((p) => p.apps.some((a) => S.appMatches(a, app))) || null;

  let watchingApps = null;
  function syncAppWatch() {
    // Also while the reader is on with no programs set yet, so the page can
    // offer the game that was just in front.
    const c = cfg();
    const want = !!(desktop && desktop.watchApps && c.autoProfile && (c.enabled || c.profiles.some((p) => p.apps.length)));
    if (want === watchingApps) return;
    watchingApps = want;
    desktop.watchApps(want).catch(() => { watchingApps = null; });
  }

  function onApp(app) {
    S.app = app;
    const c = cfg();
    const p = c.autoProfile ? S.profileForApp(app) : null;
    // A program without a profile leaves the one in use alone, so looking at
    // chat or Discord for a moment doesn't change anything.
    if (!p || p.id === c.profile) { changed(); return; }
    c.profile = p.id;
    Bot.save();
    S.apply({ keys: true });
    Bot.log('info', `Screen reader: ${app.name || app.exe} came to the front, using the profile “${p.name}”.`);
    navSay(`Profile ${p.name}, ${countZones()}.`);
  }

  function normalize() {
    const c = cfg();
    if (!Array.isArray(c.profiles) || !c.profiles.length) c.profiles = [S.newProfile('My zones')];
    for (const p of c.profiles) {
      p.id = p.id || uid('p');
      p.name = String(p.name || 'Profile').slice(0, 60);
      p.display = String(p.display || '');
      const seen = new Set();
      p.apps = (Array.isArray(p.apps) ? p.apps : [])
        .map((a) => String(a || '').trim().slice(0, 120))
        .filter((a) => a && !seen.has(appKey(a)) && seen.add(appKey(a)))
        .slice(0, 20);
      p.zones = (Array.isArray(p.zones) ? p.zones : []).slice(0, 50).map(normalizeZone);
    }
    if (!c.profiles.some((p) => p.id === c.profile)) c.profile = c.profiles[0].id;
    for (const [name] of KEY_ACTIONS) if (!c.keys[name]) c.keys[name] = { code: '' };
  }

  S.profile = () => cfg().profiles.find((p) => p.id === cfg().profile) || cfg().profiles[0];
  S.zones = () => (S.profile() ? S.profile().zones : []);
  const autoZones = () => S.zones().filter((z) => z.enabled !== false && z.mode !== 'manual');

  // A voice for a new zone that the other zones don't have yet, so each one
  // can be told apart by ear. The first zone gets the reader's own voice.
  // Neural when the reader or another zone already uses neural voices.
  S.voiceForNewZone = (zones = S.zones()) => {
    const all = host.allVoices();
    const navNeural = cfg().nav.voice.engine === 'kokoro';
    if (!zones.length && !navNeural) return { ...ZONE_DEFAULTS.voice };
    const neural = all.neuralState !== 'error' && (navNeural || all.reader.engine === 'kokoro' || zones.some((z) => z.voice.engine === 'kokoro'));
    const lang = (all.system.find((v) => v.id === all.reader.voiceId) || {}).lang || navigator.language || 'en';
    const list = neural ? all.neural : all.system.filter((v) => v.lang.slice(0, 2) === lang.slice(0, 2));
    const used = new Set([all.reader.voiceId, cfg().nav.voice.voiceId, ...zones.map((z) => z.voice.voiceId)]);
    const pick = list.find((v) => !used.has(v.id)) || list[zones.length % Math.max(1, list.length)];
    return pick ? { ...ZONE_DEFAULTS.voice, engine: neural ? 'kokoro' : 'system', voiceId: pick.id } : { ...ZONE_DEFAULTS.voice };
  };

  // Every voice the screen reader uses: the zones' and the cursor's.
  const voicesInUse = () => [...S.zones().map((z) => z.voice), cfg().nav.voice];
  S.usesNeural = () => voicesInUse().some((v) => v.engine === 'kokoro');
  S.allNeural = () => voicesInUse().every((v) => v.engine === 'kokoro');

  // Gives each zone and the cursor a neural voice of its own, keeping speed
  // and volume, and starts loading them.
  S.useNeuralVoices = () => {
    const list = host.allVoices().neural;
    if (!list.length) return;
    const voices = voicesInUse();
    const used = new Set(voices.filter((v) => v.engine === 'kokoro').map((v) => v.voiceId));
    let i = 0;
    for (const v of voices) {
      if (v.engine === 'kokoro' && v.voiceId) continue;
      const pick = list.find((x) => !used.has(x.id)) || list[i++ % list.length];
      used.add(pick.id);
      v.engine = 'kokoro';
      v.voiceId = pick.id;
    }
    host.loadNeural();
  };

  S.newZone = (template = null) => {
    const zones = S.zones();
    const base = template ? Bot.clone(template) : {};
    return normalizeZone({ ...base, id: uid('z'), name: base.name || `Zone ${zones.length + 1}`, voice: S.voiceForNewZone() }, zones.length);
  };

  // -------------------------------------------------------------------------
  // Capturing the screen
  // -------------------------------------------------------------------------

  const cap = { stream: null, track: null, display: null, frame: null, frameAt: 0, starting: null, video: null, lastUse: 0, stopTimer: null };

  function stopCapture() {
    clearTimeout(cap.stopTimer);
    if (cap.track) { cap.track.onended = null; cap.track.stop(); }
    if (cap.frame && cap.frame.close) cap.frame.close();
    if (cap.video) cap.video.srcObject = null;
    Object.assign(cap, { stream: null, track: null, display: null, frame: null, frameAt: 0, video: null });
  }

  async function openStream(displayId) {
    await desktop.want(displayId);
    try {
      return await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 10 }, audio: false });
    } catch (err) {
      // Refused without a click: the older way, by the screen's source id.
      const id = await desktop.sourceId(displayId);
      if (!id) throw err;
      return navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: id, maxFrameRate: 10 } } });
    }
  }

  // Keeps the newest frame. A screen that doesn't change sends no frames, so
  // waiting for the "next" one could wait forever; the last one is kept instead.
  function readFrames(track) {
    if (typeof MediaStreamTrackProcessor === 'function') {
      const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
      (async () => {
        for (;;) {
          let result;
          try { result = await reader.read(); } catch { break; }
          if (result.done || cap.track !== track) { if (result.value) result.value.close(); break; }
          if (cap.frame && cap.frame.close) cap.frame.close();
          cap.frame = result.value;
          cap.frameAt = performance.now();
        }
      })();
      return;
    }
    const video = document.createElement('video');
    video.muted = true;
    video.srcObject = new MediaStream([track]);
    video.play().catch(() => {});
    cap.video = video;
    const poll = () => {
      if (cap.track !== track) return;
      if (video.readyState >= 2) { cap.frame = video; cap.frameAt = performance.now(); }
      setTimeout(poll, 100);
    };
    poll();
  }

  async function ensureCapture() {
    const display = S.profile().display;
    cap.lastUse = Date.now();
    if (cap.track && cap.track.readyState === 'live' && cap.display === display) return true;
    if (cap.starting) return cap.starting;
    cap.starting = (async () => {
      stopCapture();
      try {
        const stream = await openStream(display);
        const track = stream.getVideoTracks()[0];
        if (!track) throw new Error('no picture came back');
        Object.assign(cap, { stream, track, display });
        track.onended = () => { if (cap.track === track) { stopCapture(); setProblem('Screen capture stopped.'); } };
        readFrames(track);
        // The first frame, so a hotkey pressed straight away has something to read.
        for (let i = 0; i < 30 && !cap.frame; i++) await Bot.wait(50);
        if (S.problem.startsWith('Screen')) setProblem('');
        return true;
      } catch (err) {
        stopCapture();
        await refreshAccess();
        setProblem(S.access !== 'granted' && window.chatReaderDesktop.platform === 'darwin'
          ? 'Screen capture needs your permission: allow Chat Reader under System Settings → Privacy & Security → Screen Recording, then restart the app.'
          : `Screen capture didn’t start: ${err.message}`);
        return false;
      } finally {
        cap.starting = null;
      }
    })();
    return cap.starting;
  }

  // Nothing watching and no hotkey for a while: let the screen go.
  function releaseCaptureLater() {
    clearTimeout(cap.stopTimer);
    cap.stopTimer = setTimeout(() => {
      if (!running() && Date.now() - cap.lastUse >= 20000) stopCapture();
      else if (!running()) releaseCaptureLater();
    }, 20000);
  }

  const frameSize = (f) => ({ w: f.displayWidth || f.videoWidth || f.width, h: f.displayHeight || f.videoHeight || f.height });

  function pixelRect(frame, r) {
    const { w, h } = frameSize(frame);
    const x = Math.floor(r.x * w);
    const y = Math.floor(r.y * h);
    return { x, y, w: Math.max(1, Math.min(w - x, Math.round(r.w * w))), h: Math.max(1, Math.min(h - y, Math.round(r.h * h))) };
  }

  // A small grey thumbnail of a zone, to notice when it changes without
  // reading it.
  const sigCanvas = new OffscreenCanvas(8, 8);
  const sigCtx = sigCanvas.getContext('2d', { willReadFrequently: true });

  function signature(frame, rect) {
    const p = pixelRect(frame, rect);
    const sw = Math.min(128, p.w);
    const sh = clamp(Math.round((sw * p.h) / p.w), 4, 72);
    if (sigCanvas.width !== sw || sigCanvas.height !== sh) { sigCanvas.width = sw; sigCanvas.height = sh; }
    sigCtx.drawImage(frame, p.x, p.y, p.w, p.h, 0, 0, sw, sh);
    const data = sigCtx.getImageData(0, 0, sw, sh).data;
    const out = new Uint8Array(sw * sh);
    for (let i = 0, j = 0; j < out.length; i += 4, j++) out[j] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
    return out;
  }

  function difference(a, b) {
    if (!a || !b || a.length !== b.length) return 255;
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
    return sum / a.length;
  }

  // -------------------------------------------------------------------------
  // Recognising text
  // -------------------------------------------------------------------------

  let ocrChain = Promise.resolve();
  let detector = null;   // Chromium's TextDetector, when the system's can't run

  async function canUseDetector() {
    if (detector !== null) return !!detector;
    detector = false;
    if (typeof TextDetector !== 'function') return false;
    try {
      // On macOS it finds where text is but can't say what it says.
      const c = new OffscreenCanvas(320, 60);
      const x = c.getContext('2d');
      x.fillStyle = '#fff'; x.fillRect(0, 0, 320, 60);
      x.fillStyle = '#000'; x.font = '32px sans-serif'; x.fillText('Hello there', 10, 42);
      const found = await new TextDetector().detect(c);
      if (found.some((f) => f.rawValue && f.rawValue.trim())) detector = new TextDetector();
    } catch { detector = false; }
    return !!detector;
  }

  // Draws the part of the frame at once (the frame may be replaced while the
  // text is being read), then reads it. Lines come back with boxes as
  // fractions of the screen, in reading order.
  function recognize(frame, rect, { fast = false, full = false } = {}) {
    const p = pixelRect(frame, rect);
    // A whole high-resolution screen is read faster a bit smaller, with no
    // loss for text of a size people read; small text is read better bigger.
    const limit = Math.min(S.ocr.maxSide || 4096, full ? SCAN_SIDE : 4096);
    let scale = p.h < 140 && !full ? 2 : 1;
    scale = Math.min(scale, limit / Math.max(p.w, p.h));
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(p.w * scale)), Math.max(1, Math.round(p.h * scale)));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(frame, p.x, p.y, p.w, p.h, 0, 0, canvas.width, canvas.height);

    const job = ocrChain.then(async () => {
      let lines = null;
      if (!S.ocr.fallback) {
        const t0 = performance.now();
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const t1 = performance.now();
        const res = await desktop.ocr(bytes, { fast: fast || cfg().fastOcr });
        // How long the last one took, for the page and for working on this.
        S.ocr.last = { width: canvas.width, height: canvas.height, kb: Math.round(bytes.length / 1024), encodeMs: Math.round(t1 - t0), totalMs: Math.round(performance.now() - t0), helperMs: res.ms || 0 };
        if (!res.error) {
          lines = res.lines.map((l) => ({ text: String(l.text || ''), conf: Number(l.conf) || 0, box: { x: l.box[0], y: l.box[1], w: l.box[2], h: l.box[3] } }));
          if (S.ocr.error) { S.ocr.error = ''; changed(); }
        } else {
          const status = await desktop.ocrStatus();
          Object.assign(S.ocr, { engine: status.engine, running: status.running, error: res.error, maxSide: status.maxSide });
          // The helper can't run here at all: try Chromium's own.
          if (!status.running && await canUseDetector()) { S.ocr.fallback = true; S.ocr.engine = 'Chromium'; }
          changed();
          if (!S.ocr.fallback) throw new Error(res.error);
        }
      }
      if (!lines) {
        const found = await detector.detect(canvas);
        lines = found.map((f) => ({
          text: f.rawValue || '', conf: 1,
          box: { x: f.boundingBox.x / canvas.width, y: f.boundingBox.y / canvas.height, w: f.boundingBox.width / canvas.width, h: f.boundingBox.height / canvas.height },
        }));
      }
      // Fractions of the crop -> fractions of the screen.
      for (const l of lines) {
        const b = l.box;
        l.cropBox = { ...b };
        l.box = { x: rect.x + b.x * rect.w, y: rect.y + b.y * rect.h, w: b.w * rect.w, h: b.h * rect.h };
      }
      return { lines, canvas };
    });
    ocrChain = job.catch(() => {});
    return job;
  }

  // -------------------------------------------------------------------------
  // Text: cleaning, ordering, comparing
  // -------------------------------------------------------------------------

  const squash = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const comparable = (t) => squash(t).toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, '').replace(/\s+/g, ' ').trim();

  // Bigram overlap (Dice): 1 is the same, 0 is nothing alike. Forgives the
  // odd misread letter between two looks at the same text.
  function similarity(a, b) {
    if (a === b) return 1;
    if (!a || !b) return 0;
    if (a.length < 3 || b.length < 3) return a === b ? 1 : 0;
    const grams = new Map();
    for (let i = 0; i < a.length - 1; i++) { const g = a.slice(i, i + 2); grams.set(g, (grams.get(g) || 0) + 1); }
    let hits = 0;
    for (let i = 0; i < b.length - 1; i++) {
      const g = b.slice(i, i + 2);
      const n = grams.get(g) || 0;
      if (n) { hits++; grams.set(g, n - 1); }
    }
    return (2 * hits) / (a.length + b.length - 2);
  }
  S.similarity = similarity;

  // One rule per line: a plain word or phrase (any case), or /…/flags.
  // `global` is for replacing; testing needs it off, or test() keeps a place.
  function rules(text, global) {
    return String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).map((rule) => {
      const re = /^\/(.+)\/([a-z]*)$/i.exec(rule);
      if (re) {
        const flags = re[2].replace(/g/g, '') + (global ? 'g' : '');
        try { return new RegExp(re[1], flags); } catch { return null; }
      }
      return new RegExp(rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), global ? 'gi' : 'i');
    }).filter(Boolean);
  }
  const ignoreRules = (zone) => rules(zone && zone.ignore, true);

  // Whether a zone's "Only read" rules let this text through.
  S.allowed = (zone, text) => {
    const only = rules(zone && zone.only, false);
    return !only.length || only.some((re) => re.test(text));
  };
  // A rule as typed that isn't a working regular expression, for the editor.
  S.badRule = (text) => String(text || '').split('\n').map((l) => l.trim()).find((rule) => {
    const re = /^\/(.+)\/([a-z]*)$/i.exec(rule);
    if (!re) return false;
    try { new RegExp(re[1], re[2].replace(/g/g, '')); return false; } catch { return true; }
  }) || '';

  // Top to bottom, then left to right within a row.
  function readingOrder(lines) {
    const sorted = [...lines].sort((a, b) => (a.box.y + a.box.h / 2) - (b.box.y + b.box.h / 2));
    const rows = [];
    for (const line of sorted) {
      const cy = line.box.y + line.box.h / 2;
      const row = rows.find((r) => Math.abs(r.cy - cy) < Math.min(r.h, line.box.h) * 0.6);
      if (row) row.lines.push(line);
      else rows.push({ cy, h: line.box.h, lines: [line] });
    }
    return rows.flatMap((r) => r.lines.sort((a, b) => a.box.x - b.box.x));
  }

  function clean(lines, zone = null) {
    const rules = ignoreRules(zone);
    const out = [];
    for (const l of lines) {
      if (l.conf < 0.25) continue;
      let text = squash(l.text);
      for (const re of rules) text = text.replace(re, ' ');
      text = squash(text);
      // Stray marks (a lone "|" from a border) aren't worth saying.
      if (!/[\p{L}\p{N}]/u.test(text)) continue;
      out.push({ ...l, text });
    }
    return readingOrder(out);
  }

  const union = (boxes) => {
    if (!boxes.length) return null;
    const x1 = Math.min(...boxes.map((b) => b.x));
    const y1 = Math.min(...boxes.map((b) => b.y));
    const x2 = Math.max(...boxes.map((b) => b.x + b.w));
    const y2 = Math.max(...boxes.map((b) => b.y + b.h));
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  };

  // Each line's average colour and contrast, from the zone's picture. In a
  // menu the highlighted line looks unlike the others.
  function lineLooks(lines, canvas) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    for (const l of lines) {
      const b = l.cropBox;
      const x = Math.floor(b.x * canvas.width);
      const y = Math.floor(b.y * canvas.height);
      const w = Math.max(1, Math.round(b.w * canvas.width));
      const h = Math.max(1, Math.round(b.h * canvas.height));
      const data = ctx.getImageData(x, y, w, h).data;
      let r = 0, g = 0, bl = 0, n = 0, lum = 0, lum2 = 0;
      for (let i = 0; i < data.length; i += 16) {
        r += data[i]; g += data[i + 1]; bl += data[i + 2];
        const v = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
        lum += v; lum2 += v * v; n++;
      }
      const mean = lum / n;
      l.look = [r / n, g / n, bl / n, Math.sqrt(Math.max(0, lum2 / n - mean * mean)) * 1.5];
    }
  }

  function highlighted(lines) {
    if (lines.length < 2) return null;
    const median = [0, 1, 2, 3].map((k) => {
      const v = lines.map((l) => l.look[k]).sort((a, b) => a - b);
      return v[Math.floor(v.length / 2)];
    });
    let best = null;
    let bestD = 0;
    for (const l of lines) {
      const d = Math.hypot(...l.look.map((v, k) => v - median[k]));
      if (d > bestD) { best = l; bestD = d; }
    }
    return bestD > 28 ? best : null;
  }

  // -------------------------------------------------------------------------
  // Speaking
  // -------------------------------------------------------------------------

  const speech = { queue: [], current: null, held: false, releaseTimer: null, focusTimer: null };

  function holdChat() {
    clearTimeout(speech.releaseTimer);
    if (speech.held) return;
    speech.held = true;
    host.hold(true);
  }

  function releaseChatSoon() {
    clearTimeout(speech.releaseTimer);
    speech.releaseTimer = setTimeout(() => {
      if (!speech.held || speech.current || speech.queue.length) return;
      speech.held = false;
      host.hold(false);
    }, 700);
  }

  // Two system voices can't speak at once, so chat waits for a system voice
  // even when it's allowed to carry on.
  function mustHold(voice) {
    if (cfg().pauseChat) return true;
    const engine = voice.engine || host.readerEngine();
    const neuralReady = host.allVoices().neuralState === 'ready';
    const screenSystem = engine === 'system' || !neuralReady;
    return screenSystem && host.readerEngine() === 'system';
  }

  function stopCurrent() {
    const c = speech.current;
    if (!c) return;
    speech.current = null;
    c.controller.stop();
  }

  S.stop = () => {
    speech.queue.length = 0;
    stopCurrent();
    S.speaking = null;
    releaseChatSoon();
    live();
  };

  // item: { text, voice, zone (id) or '', rect, interrupt: self | all | none }
  function say(item) {
    const text = squash(item.text);
    if (!text) return;
    const entry = { ...item, text };
    if (item.interrupt === 'all') {
      speech.queue.length = 0;
      stopCurrent();
    } else if (item.interrupt === 'self') {
      speech.queue = speech.queue.filter((q) => q.zone !== item.zone);
      if (speech.current && speech.current.item.zone === item.zone) stopCurrent();
    }
    speech.queue.push(entry);
    // A busy zone shouldn't build up a backlog of things that are long gone.
    while (speech.queue.length > 12) speech.queue.shift();
    pumpSpeech();
  }
  S.say = say;

  function pumpSpeech() {
    if (speech.current) return;
    const item = speech.queue.shift();
    if (!item) { S.speaking = null; releaseChatSoon(); live(); return; }
    if (mustHold(item.voice || {})) holdChat();
    const controller = host.speakVoice(item.text, item.voice || {});
    speech.current = { item, controller };
    S.speaking = { text: item.text, zone: item.zone || '' };
    S.lastSaid = item;
    if (item.navMap && item.navMap === S.map) S.map.index = item.navIndex;
    if (item.rect) showFocus(item.rect, item.text);
    live();
    controller.done.then(() => {
      if (!speech.current || speech.current.controller !== controller) return;
      speech.current = null;
      pumpSpeech();
    });
  }

  // -------------------------------------------------------------------------
  // What's shown on screen: zone outlines, the reading highlight, the lens
  // -------------------------------------------------------------------------

  function showFocus(rect, text) {
    S.focus = { rect, text, at: Date.now() };
    pushMarkers();
    pushLens();
    clearTimeout(speech.focusTimer);
    speech.focusTimer = setTimeout(() => {
      if (S.focus && Date.now() - S.focus.at >= 2500 && !speech.current) { S.focus = { ...S.focus, gone: true }; pushMarkers(); }
    }, 3500);
  }

  function pushMarkers() {
    if (!desktop) return;
    const c = cfg();
    const f = S.focus && !S.focus.gone && c.highlight ? { rect: S.focus.rect, ms: 2500 } : null;
    desktop.setMarkers({
      display: S.profile().display,
      showZones: !!c.showZones,
      zones: S.zones().map((z) => ({ rect: z.rect, name: z.name, color: z.color, on: z.enabled !== false })),
      focus: f,
    });
  }

  function pushLens() {
    if (!desktop) return;
    const l = cfg().lens;
    let target = null;
    if (l.follow === 'zone') {
      const z = S.zones().find((x) => x.id === l.zone) || S.zones()[0];
      target = z ? z.rect : null;
    } else if (l.follow === 'focus' && S.focus) {
      target = S.focus.rect;
    }
    desktop.setLens({
      enabled: !!l.enabled,
      display: S.profile().display,
      lensDisplay: l.display,
      position: l.position,
      width: l.width,
      height: l.height,
      zoom: l.zoom,
      filter: l.filter,
      follow: l.follow,
      caption: l.caption,
      captionSize: l.captionSize,
      target,
      text: S.focus && l.follow === 'focus' ? S.focus.text : '',
    });
  }
  S.pushLens = pushLens;

  // -------------------------------------------------------------------------
  // Watching the zones
  // -------------------------------------------------------------------------

  const zoneState = new Map();   // zone id -> what was seen and said
  const stateFor = (id) => {
    if (!zoneState.has(id)) zoneState.set(id, { sig: null, ocrSig: null, changedAt: 0, dirtySince: 0, busy: false, lastNorm: '', lastText: '', lines: [], primed: false, recent: [], highlight: '' });
    return zoneState.get(id);
  };

  let loopTimer = null;
  const running = () => !!(desktop && cfg().enabled && autoZones().length);

  function schedule(delay = cfg().interval) {
    clearTimeout(loopTimer);
    loopTimer = null;
    if (!running()) {
      if (S.status === 'watching' || S.status === 'starting') setStatus('off');
      releaseCaptureLater();
      return;
    }
    loopTimer = setTimeout(tick, clamp(delay, 100, 5000));
  }

  async function tick() {
    loopTimer = null;
    if (!running()) { schedule(); return; }
    if (S.status !== 'watching') setStatus('starting');
    if (!(await ensureCapture())) { setStatus('error'); schedule(4000); return; }
    const frame = cap.frame;
    if (!frame) { schedule(); return; }
    setStatus('watching');
    const now = performance.now();
    const threshold = SENSITIVITY[cfg().sensitivity] || SENSITIVITY.normal;
    for (const zone of autoZones()) {
      const st = stateFor(zone.id);
      if (st.busy) continue;
      let sig;
      try { sig = signature(frame, zone.rect); } catch (err) { console.warn('screen reader:', err); continue; }
      if (difference(sig, st.sig) > threshold) st.changedAt = now;
      st.sig = sig;
      if (difference(sig, st.ocrSig) <= threshold) { st.dirtySince = 0; continue; }
      if (!st.dirtySince) st.dirtySince = now;
      const settled = now - st.changedAt >= zone.settle;
      const waitedLong = now - st.dirtySince >= zone.settle + MAX_WAIT;
      if (!settled && !waitedLong) continue;
      st.busy = true;
      st.ocrSig = sig;
      st.dirtySince = 0;
      readZoneText(zone, st, frame);
    }
    schedule();
  }

  function readZoneText(zone, st, frame) {
    let job;
    try { job = recognize(frame, zone.rect); } catch (err) { st.busy = false; setProblem(err.message); return; }
    job.then(({ lines, canvas }) => {
      st.busy = false;
      if (!running()) return;
      const clean_ = clean(lines, zone);
      if (zone.mode === 'menu') lineLooks(clean_, canvas);
      handleZoneText(zone, st, clean_);
      if (S.problem && !S.problem.startsWith('Screen')) setProblem('');
    }, (err) => {
      st.busy = false;
      setProblem(`Text recognition: ${err.message}`);
    });
  }

  // `full` is the whole text when only the end of it is said (typed out).
  function speakZone(zone, text, rect, { interrupt = zone.interrupt, full = text } = {}) {
    if (!S.allowed(zone, full)) return false;
    const said = zone.prefix ? `${zone.prefix}: ${text}` : text;
    S.last.set(zone.id, { text, at: Date.now() });
    say({ text: said, voice: zone.voice, zone: zone.id, rect: rect || zone.rect, interrupt });
    return true;
  }

  function handleZoneText(zone, st, lines) {
    const now = Date.now();
    st.recent = st.recent.filter((r) => now - r.at < 5000);
    if (zone.mode === 'changes') {
      const text = lines.map((l) => l.text).join(' ');
      const norm = comparable(text);
      if (!norm) { st.lastNorm = ''; st.lastText = ''; return; }
      if (similarity(norm, st.lastNorm) >= 0.85) { st.lastNorm = norm; st.lastText = text; return; }
      // Text that flickered away and came back is not new.
      if (st.recent.some((r) => similarity(r.norm, norm) >= 0.85)) { st.lastNorm = norm; st.lastText = text; return; }
      let speakText = text;
      // Typed out a letter at a time: only what was added.
      if (st.lastNorm.length >= 8 && norm.startsWith(st.lastNorm)) {
        const before = st.lastText.split(/\s+/).length;
        const rest = text.split(/\s+/).slice(before).join(' ');
        if (rest) speakText = rest;
      }
      st.lastNorm = norm;
      st.lastText = text;
      st.recent.push({ norm, at: now });
      speakZone(zone, speakText, union(lines.map((l) => l.box)), { interrupt: speakText === text ? zone.interrupt : 'none', full: text });
    } else if (zone.mode === 'new-lines') {
      const norms = lines.map((l) => comparable(l.text));
      const fresh = lines.filter((l, i) => norms[i] && !st.lines.some((p) => similarity(p, norms[i]) >= 0.85));
      st.lines = norms;
      // The first look only learns what's already there.
      if (!st.primed) { st.primed = true; return; }
      for (const l of fresh.slice(-4)) speakZone(zone, l.text, l.box, { interrupt: 'none' });
    } else if (zone.mode === 'menu') {
      const pick = highlighted(lines);
      if (!pick) return;
      const norm = comparable(pick.text);
      if (norm === st.highlight) return;
      st.highlight = norm;
      speakZone(zone, pick.text, pick.box);
    }
  }

  // A zone read on request: all its text, whatever was read before.
  S.readZone = async (zoneOrIndex) => {
    const zone = typeof zoneOrIndex === 'number' ? S.zones()[zoneOrIndex] : zoneOrIndex;
    if (!zone) { navSay(`There is no zone ${typeof zoneOrIndex === 'number' ? zoneOrIndex + 1 : ''}.`); return; }
    if (!(await ensureCapture()) || !cap.frame) { navSay(S.problem || 'The screen can’t be captured.'); return; }
    try {
      const { lines } = await recognize(cap.frame, zone.rect);
      const clean_ = clean(lines, zone);
      const text = clean_.map((l) => l.text).join(' ');
      const st = stateFor(zone.id);
      st.lastNorm = comparable(text);
      st.lastText = text;
      if (!text) { say({ text: `Nothing to read in ${zone.name}.`, voice: zone.voice, zone: zone.id, rect: zone.rect, interrupt: 'all' }); return; }
      if (!speakZone(zone, text, union(clean_.map((l) => l.box)), { interrupt: 'all' })) {
        say({ text: `Nothing in ${zone.name} matches what it should read.`, voice: zone.voice, zone: zone.id, rect: zone.rect, interrupt: 'all' });
      }
    } catch (err) {
      navSay(`Couldn’t read ${zone.name}: ${err.message}`);
    } finally {
      releaseCaptureLater();
    }
  };

  // -------------------------------------------------------------------------
  // The reading cursor
  // -------------------------------------------------------------------------

  const navVoice = () => cfg().nav.voice;
  function navSay(text, rect = null) {
    say({ text, voice: navVoice(), zone: '', rect, interrupt: 'all' });
  }
  S.navSay = navSay;

  async function scan() {
    if (!(await ensureCapture()) || !cap.frame) throw new Error(S.problem || 'The screen can’t be captured');
    const { lines } = await recognize(cap.frame, { x: 0, y: 0, w: 1, h: 1 }, { full: true });
    releaseCaptureLater();
    return clean(lines);
  }

  // The text on screen, no older than `maxAge`, keeping the cursor on the same
  // line where it can. One look at a time: a key pressed during a look waits
  // for it.
  let scanning = null;
  async function freshMap(maxAge = MAP_AGE.step) {
    if (S.map && Date.now() - S.map.at < maxAge) return S.map;
    if (scanning) {
      await scanning.catch(() => {});
      if (S.map && Date.now() - S.map.at < maxAge + 1500) return S.map;
    }
    scanning = scan();
    let lines;
    try { lines = await scanning; } finally { scanning = null; }
    // Where the cursor is now, which may have moved while the screen was read.
    const old = S.map;
    const map = { at: Date.now(), lines, index: -1 };
    const was = old && old.lines[old.index];
    if (was && lines.length) {
      const norm = comparable(was.text);
      const cx = was.box.x + was.box.w / 2;
      const cy = was.box.y + was.box.h / 2;
      let best = -1;
      let bestScore = Infinity;
      lines.forEach((l, i) => {
        const d = Math.hypot(l.box.x + l.box.w / 2 - cx, l.box.y + l.box.h / 2 - cy);
        const score = d - (similarity(comparable(l.text), norm) >= 0.8 ? 1 : 0);
        if (score < bestScore) { bestScore = score; best = i; }
      });
      map.index = best;
    }
    S.map = map;
    return map;
  }

  function sayLine(map, i, suffix = '') {
    map.index = i;
    const line = map.lines[i];
    navSay(`${line.text}${suffix}`, line.box);
  }

  // While the cursor is in use, the text is read again in the background, so
  // the next key answers straight away.
  let keepFreshUntil = 0;
  let keepFreshTimer = null;
  function keepFresh() {
    keepFreshUntil = Date.now() + MAP_KEEP_FRESH;
    if (keepFreshTimer) return;
    const loop = () => {
      keepFreshTimer = setTimeout(async () => {
        if (Date.now() > keepFreshUntil) { keepFreshTimer = null; return; }
        try { await freshMap(1000); } catch { /* said when a key is pressed */ }
        loop();
      }, 1000);
    };
    loop();
  }

  async function navigate(kind) {
    let map;
    const maxAge = kind === 'readAll' || kind === 'centre' ? MAP_AGE.now : MAP_AGE.step;
    try { map = await freshMap(maxAge); } catch (err) { navSay(err.message); return; }
    if (kind !== 'readAll') keepFresh();
    const lines = map.lines;
    if (!lines.length) { navSay('No text found on the screen.'); return; }
    const cur = map.index;
    const wrap = cfg().nav.wrap;
    if (kind === 'readAll') {
      speech.queue.length = 0;
      stopCurrent();
      map.index = 0;
      lines.forEach((l, i) => say({ text: l.text, voice: navVoice(), zone: '', rect: l.box, interrupt: 'none', navIndex: i, navMap: map }));
      return;
    }
    if (kind === 'next' || kind === 'prev') {
      if (cur < 0) { sayLine(map, kind === 'next' ? 0 : lines.length - 1); return; }
      let i = cur + (kind === 'next' ? 1 : -1);
      if (i >= lines.length || i < 0) {
        if (!wrap) { navSay(kind === 'next' ? 'Bottom of the screen.' : 'Top of the screen.', lines[cur].box); return; }
        i = (i + lines.length) % lines.length;
      }
      sayLine(map, i);
      return;
    }
    if (kind === 'centre') {
      let best = 0;
      let bestD = Infinity;
      lines.forEach((l, i) => {
        const dx = Math.max(l.box.x - 0.5, 0, 0.5 - (l.box.x + l.box.w));
        const dy = Math.max(l.box.y - 0.5, 0, 0.5 - (l.box.y + l.box.h));
        const d = Math.hypot(dx * 1.6, dy);   // screens are wider than tall
        if (d < bestD) { bestD = d; best = i; }
      });
      sayLine(map, best);
      return;
    }
    if (kind === 'left' || kind === 'right') {
      if (cur < 0) { sayLine(map, 0); return; }
      const c = lines[cur].box;
      const ccx = c.x + c.w / 2;
      const ccy = c.y + c.h / 2;
      let best = -1;
      let bestScore = Infinity;
      lines.forEach((l, i) => {
        if (i === cur) return;
        const lx = l.box.x + l.box.w / 2;
        const ly = l.box.y + l.box.h / 2;
        const ahead = kind === 'right' ? l.box.x >= c.x + c.w * 0.5 : l.box.x + l.box.w <= c.x + c.w * 0.5;
        if (!ahead) return;
        const score = Math.abs(lx - ccx) + Math.abs(ly - ccy) * 3;
        if (score < bestScore) { bestScore = score; best = i; }
      });
      if (best < 0) { navSay(kind === 'right' ? 'Nothing further right.' : 'Nothing further left.', c); return; }
      sayLine(map, best);
    }
  }
  S.navigate = navigate;

  // -------------------------------------------------------------------------
  // Hotkeys
  // -------------------------------------------------------------------------

  S.bindings = () => {
    if (!desktop || !Bot.data) return [];
    const out = [];
    for (const [name] of KEY_ACTIONS) {
      const b = cfg().keys[name];
      if (b && b.code) out.push([`bot:sr:${name}`, b]);
    }
    if (cfg().numberKeys) {
      S.zones().slice(0, 9).forEach((_z, i) => out.push([`bot:sr:zone${i + 1}`, { code: `Digit${i + 1}`, ctrl: true, alt: true, shift: false, meta: false }]));
    }
    return out;
  };

  S.run = async (action) => {
    const c = cfg();
    const zoneKey = /^zone(\d)$/.exec(action);
    if (zoneKey) { S.readZone(Number(zoneKey[1]) - 1); return; }
    switch (action) {
      case 'toggle':
        c.enabled = !c.enabled;
        Bot.save();
        S.apply();
        navSay(c.enabled ? `Reading zones on. ${S.profile().name}, ${countZones()}.` : 'Reading zones off.');
        break;
      case 'readAll': case 'next': case 'prev': case 'left': case 'right': case 'centre':
        await navigate(action);
        break;
      case 'repeat':
        if (S.lastSaid) say({ ...S.lastSaid, interrupt: 'all' });
        else navSay('Nothing has been read yet.');
        break;
      case 'stop':
        S.stop();
        break;
      case 'lens':
        c.lens.enabled = !c.lens.enabled;
        Bot.save();
        pushLens();
        navSay(c.lens.enabled ? `Lens on, zoom ${c.lens.zoom}.` : 'Lens off.');
        changed();
        break;
      case 'zoomIn': case 'zoomOut': {
        c.lens.zoom = clamp(Math.round((c.lens.zoom + (action === 'zoomIn' ? 0.5 : -0.5)) * 2) / 2, 1, 12);
        if (!c.lens.enabled) c.lens.enabled = true;
        Bot.save();
        pushLens();
        navSay(`Zoom ${c.lens.zoom}`);
        changed();
        break;
      }
      case 'profile': {
        const i = c.profiles.findIndex((p) => p.id === c.profile);
        c.profile = c.profiles[(i + 1) % c.profiles.length].id;
        Bot.save();
        S.apply({ keys: true });
        navSay(`Profile ${S.profile().name}, ${countZones()}.`);
        break;
      }
      case 'edit':
        S.editOnScreen({ hideMain: document.hasFocus() });
        break;
      default:
        break;
    }
  };

  const countZones = () => {
    const n = S.zones().length;
    return n === 1 ? '1 zone' : `${n} zones`;
  };

  // -------------------------------------------------------------------------
  // Editing on screen
  // -------------------------------------------------------------------------

  S.editing = false;
  S.editOnScreen = async ({ selected = '', hideMain = true } = {}) => {
    if (!desktop || S.editing) return null;
    S.editing = true;
    changed();
    try {
      const result = await desktop.editZones({ display: S.profile().display, zones: Bot.clone(S.zones()), selected, hideMain });
      if (!result || result.canceled || !Array.isArray(result.zones)) { navSay('Zones not changed.'); return null; }
      const profile = S.profile();
      const before = new Map(profile.zones.map((z) => [z.id, z]));
      const zones = [];
      result.zones.forEach((z, i) => {
        // The editor only moves, sizes and names; the rest stays as it was.
        const old = before.get(z.id);
        if (old) zones.push(normalizeZone({ ...old, name: z.name, rect: z.rect }, i));
        else zones.push(normalizeZone({ id: z.id, name: z.name, rect: z.rect, color: z.color, voice: S.voiceForNewZone(zones) }, i));
      });
      profile.zones = zones;
      for (const id of before.keys()) if (!profile.zones.some((z) => z.id === id)) zoneState.delete(id);
      for (const z of profile.zones) zoneState.delete(z.id);
      Bot.save();
      S.apply({ keys: true });
      navSay(`Saved ${countZones()}.`);
      return result;
    } finally {
      S.editing = false;
      changed();
    }
  };

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  function setStatus(status) {
    if (S.status === status) return;
    S.status = status;
    changed();
  }

  function setProblem(text) {
    if (S.problem === text) return;
    S.problem = text;
    if (text) Bot.log('error', `Screen reader: ${text}`);
    changed();
  }

  async function refreshAccess() {
    if (!desktop) return;
    try { S.access = (await desktop.access()).status; } catch { S.access = 'unknown'; }
  }

  S.askAccess = async () => {
    const r = await desktop.askAccess();
    S.access = r.status;
    changed();
    return r.status;
  };

  S.checkOcr = async (start = false) => {
    if (!desktop) return S.ocr;
    const status = await desktop.ocrStatus({ start });
    Object.assign(S.ocr, { engine: S.ocr.fallback ? 'Chromium' : status.engine, running: status.running, error: status.error, maxSide: status.maxSide, supported: status.supported });
    changed();
    return S.ocr;
  };

  // Reads text off a picture the page drew itself: proves recognition works
  // without needing the screen.
  S.selfTest = async () => {
    const c = new OffscreenCanvas(560, 90);
    const x = c.getContext('2d');
    x.fillStyle = '#14141c'; x.fillRect(0, 0, 560, 90);
    x.fillStyle = '#fff'; x.font = '600 34px system-ui, sans-serif'; x.fillText('Text recognition works', 18, 58);
    const blob = await c.convertToBlob({ type: 'image/png' });
    const started = performance.now();
    const res = await desktop.ocr(new Uint8Array(await blob.arrayBuffer()), {});
    await S.checkOcr();
    if (res.error) throw new Error(res.error);
    return { text: res.lines.map((l) => l.text).join(' '), ms: Math.round(performance.now() - started) };
  };

  S.preview = (voice, text) => say({ text, voice, zone: '__preview', interrupt: 'all' });

  // After any change to the settings: outlines, lens, watching, hotkeys.
  S.apply = ({ keys = false } = {}) => {
    if (!desktop) return;
    normalize();
    for (const id of [...zoneState.keys()]) if (!S.zones().some((z) => z.id === id)) zoneState.delete(id);
    if (cap.track && cap.display !== S.profile().display) stopCapture();
    pushMarkers();
    pushLens();
    if (running()) { if (!loopTimer) schedule(50); } else schedule();
    if (keys) host.syncHotkeys();
    // Neural voices load as soon as the screen reader needs them.
    if (cfg().enabled && S.usesNeural() && host.allVoices().neuralState === 'unloaded') host.loadNeural();
    syncAppWatch();
    changed();
  };

  S.start = async () => {
    if (!desktop) return;
    normalize();
    desktop.onEvent(({ type, payload }) => {
      if (type === 'say') navSay(payload);
      if (type === 'displays') { S.displays = payload || []; S.map = null; changed(); }
      if (type === 'app' && payload) onApp(payload);
      if (type === 'app-error') Bot.log('error', `Screen reader: ${payload}`);
    });
    try { S.displays = await desktop.displays(); } catch { S.displays = []; }
    await refreshAccess();
    S.apply();
    // Loads the recognition model now, so the first hotkey isn't the slow one.
    setTimeout(() => { S.selfTest().catch(() => {}); }, 3000);
    Bot.on('reset', () => { zoneState.clear(); S.map = null; S.apply({ keys: true }); });
  };
})();
