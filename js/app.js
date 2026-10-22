'use strict';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'twitch-chat-reader:v1';
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const DEFAULTS = {
  // The chats in the top bar, as typed: [{ platform: 'twitch' | 'youtube' | 'tiktok', input }].
  sources: [],
  // Saved lists of chats: [{ name, sources: [...] }].
  presets: [],
  // How the page looks. Kept with everything else so a backup carries it over.
  theme: 'auto',         // auto | light | dark
  uiScale: 100,          // percent; zooms the whole interface
  highContrast: false,
  reduceMotion: false,
  announce: true,        // short screen-reader notices on pause, skip, volume
  engine: 'kokoro',
  kokoroMode: 'auto',
  kokoroVoices: KOKORO_BEST,
  systemVoices: null, // null = pick good defaults automatically
  systemLang: (navigator.language || 'en').slice(0, 2),
  varyVoices: true,
  volume: 80,
  rate: 1,
  nameFormat: 'colon',
  collapseNames: true,
  quoteParent: false,
  readEvents: true,
  readEmojis: false,
  emoteMode: 'skip-all', // skip-all | skip-twitch | read
  readEmoteOnly: true,   // a message with nothing but emotes: read their names
  maxLength: 300,
  catchUp: 0,
  skipCommands: true,
  skipLinks: false,
  ignoredUsers: '',
  // Hearing read messages again: a key steps back one message per press.
  replay: true,
  replayAnnounce: true,  // say something when a replay starts and when it ends
  replayStartText: 'Replaying.',
  replayEndText: 'Back to live chat.',
  keys: {
    pause: { code: 'KeyP', alt: true, ctrl: false, shift: false, meta: false },
    skip: { code: 'KeyS', alt: true, ctrl: false, shift: false, meta: false },
    volumeUp: { code: 'ArrowUp', alt: true, ctrl: false, shift: false, meta: false },
    volumeDown: { code: 'ArrowDown', alt: true, ctrl: false, shift: false, meta: false },
    clear: { code: 'KeyC', alt: true, ctrl: false, shift: true, meta: false },
    replay: { code: 'KeyR', alt: true, ctrl: false, shift: false, meta: false },
    toggleWindow: { code: 'KeyH', alt: true, ctrl: false, shift: true, meta: false },
  },
  mediaKeys: false,
  globalHotkeys: true, // desktop app only: let the OS deliver the keys from any app
  userVoices: { kokoro: {}, system: {} },
  nicknames: {}, // twitch login -> spoken name
  // What viewers can do from chat. "Who" settings are everyone | subs | vips | mods | off.
  cheerAnnounce: true,   // "Alice cheered 100 bits: …"
  cheerPriority: 0,      // cheers of at least this many bits are read first (0 = off)
  cheerEffects: 0,       // cheers of at least this many bits may pick a voice effect (0 = off)
  highlightPriority: true,
  voiceCommand: '!voice',
  voiceCommandWho: 'everyone',
  voiceConfirm: true,    // say "Alice now sounds like this" in the new voice
  modCommand: '!tts',
  modCommandWho: 'mods',
  rewards: {},           // channel points reward id -> { name, action }
  // Twitch collabs (Shared Chat), per channel being read: whose chats to read.
  // mode: all | own | pick; `muted` are the room ids left out when picking.
  sharedChat: {},        // twitch login -> { mode, muted: [roomId] }
};

// Switches that are one checkbox each, in the order they appear on the page.
const APPEARANCE_SETTINGS = ['highContrast', 'reduceMotion'];
const NUMBER_SETTINGS = ['maxLength', 'catchUp', 'cheerPriority', 'cheerEffects'];
const TEXT_SETTINGS = ['replayStartText', 'replayEndText'];
const CHECKBOX_SETTINGS = [
  ...APPEARANCE_SETTINGS, 'announce',
  'varyVoices', 'collapseNames', 'quoteParent', 'readEvents', 'readEmojis',
  'skipCommands', 'skipLinks', 'replayAnnounce',
  'cheerAnnounce', 'highlightPriority', 'voiceConfirm',
];

// JSON rather than structuredClone, which older Safari lacks.
const cloneDefaults = () => JSON.parse(JSON.stringify(DEFAULTS));

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return {
      ...cloneDefaults(),
      ...saved,
      keys: { ...DEFAULTS.keys, ...(saved.keys || {}) },
      userVoices: { kokoro: {}, system: {}, ...(saved.userVoices || {}) },
      nicknames: { ...(saved.nicknames || {}) },
      rewards: { ...(saved.rewards || {}) },
      sharedChat: { ...(saved.sharedChat || {}) },
      // Before several chats could be read there was one Twitch channel.
      sources: Array.isArray(saved.sources) ? saved.sources : saved.channel ? [{ platform: 'twitch', input: saved.channel }] : [],
      presets: Array.isArray(saved.presets) ? saved.presets : [],
    };
  } catch {
    return cloneDefaults();
  }
}

const settings = loadSettings();
// Single-chat settings from before the list of chats; loadSettings() moved them.
for (const old of ['channel', 'youtube', 'tiktok']) delete settings[old];
let saveTimer = null;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch {}
  }, 200);
}

// The Electron shell in desktop/ exposes this from its preload script. In a
// browser it stays null and every desktop-only path below is skipped.
const desktop = window.chatReaderDesktop || null;

// What the OS currently holds for us, filled in by syncGlobalHotkeys().
const globalHotkeys = { registered: {}, problems: {}, mediaAccess: true };

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

// ---------------------------------------------------------------------------
// Appearance and screen-reader notices
// ---------------------------------------------------------------------------

const UI_SCALES = [100, 115, 130, 150, 175, 200];

// Theme, contrast, motion and size are all read off <html> by the stylesheet.
function applyAppearance() {
  const root = document.documentElement;
  root.dataset.theme = settings.theme;
  if (settings.highContrast) root.dataset.contrast = 'high';
  else delete root.dataset.contrast;
  if (settings.reduceMotion) root.dataset.motion = 'reduce';
  else delete root.dataset.motion;
  root.style.setProperty('--ui-zoom', String(settings.uiScale / 100));
  applyLayoutWidth();
}

// Zooming the page doesn't move a CSS media query, which keeps measuring the
// window, so the layout's own breakpoints are decided here instead: against
// the width the page is left with once the zoom is taken off.
function applyLayoutWidth() {
  const usable = window.innerWidth / (settings.uiScale / 100);
  document.documentElement.dataset.width = usable < 860 ? 'narrow' : usable < 1100 ? 'medium' : 'wide';
}

window.addEventListener('resize', applyLayoutWidth);

// Hotkeys and the tray can pause, skip or change the volume without anything
// on screen moving under the reader's cursor, so say what happened in a live
// region. Chat messages are left out: they're read out loud already.
const srAnnounce = $('#srAnnounce');
let announceTimer = null;

function announce(text) {
  if (!srAnnounce || !settings.announce || !text) return;
  // Setting the same text twice isn't announced again, so clear it first.
  clearTimeout(announceTimer);
  srAnnounce.textContent = '';
  announceTimer = setTimeout(() => { srAnnounce.textContent = text; }, 60);
}

// ---------------------------------------------------------------------------
// Settings dialog
// ---------------------------------------------------------------------------

// Everything that isn't needed while chat is being read sits in a dialog, one
// tab per section, so the main window fits without scrolling.
const settingsDialog = $('#settingsDialog');
const settingsTabs = $$('#settingsDialog [role="tab"]');

function selectSettingsTab(name, { focus = false } = {}) {
  for (const tab of settingsTabs) {
    const on = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    $(`#${tab.getAttribute('aria-controls')}`).hidden = !on;
    if (on && focus) tab.focus();
  }
  $('#settingsDialog .tab-panels').scrollTop = 0;
}

function openSettings(tab) {
  // The desktop app shows the same sections as pages of its own window.
  const shell = window.chatReaderHost && window.chatReaderHost.showSettings;
  if (shell) { shell(tab || ''); return; }
  if (tab) selectSettingsTab(tab);
  if (!settingsDialog.open) settingsDialog.showModal();
  if (!tab) settingsTabs.find((t) => t.getAttribute('aria-selected') === 'true').focus();
}

function closeSettings() {
  if (settingsDialog.open) settingsDialog.close();
}

$('#settingsBtn').addEventListener('click', () => openSettings());
$('#settingsClose').addEventListener('click', closeSettings);
// The box fills the dialog, so a click landing on the dialog itself is a
// click on the dimmed backdrop around it.
settingsDialog.addEventListener('click', (e) => { if (e.target === settingsDialog) closeSettings(); });
settingsDialog.addEventListener('close', () => $('#settingsBtn').focus());

for (const tab of settingsTabs) tab.addEventListener('click', () => selectSettingsTab(tab.dataset.tab));
$('#settingsDialog [role="tablist"]').addEventListener('keydown', (e) => {
  const i = settingsTabs.indexOf(document.activeElement);
  if (i < 0) return;
  const last = settingsTabs.length - 1;
  const next = { ArrowDown: i + 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: last }[e.key];
  if (next === undefined) return;
  e.preventDefault();
  selectSettingsTab(settingsTabs[(next + last + 1) % (last + 1)].dataset.tab, { focus: true });
});

// ---------------------------------------------------------------------------
// Engines and voices
// ---------------------------------------------------------------------------

const systemEngine = new SystemEngine();
const kokoroEngine = new KokoroEngine({ onState: renderKokoroState });

function activeEngine() {
  if (settings.engine === 'kokoro' && kokoroEngine.state === 'ready') return kokoroEngine;
  return systemEngine;
}

function defaultSystemVoiceIds() {
  const lang = settings.systemLang;
  const voices = systemEngine.voices().filter((v) => lang === 'all' || v.lang.toLowerCase().startsWith(lang));
  const natural = voices.filter((v) => v.natural && !v.novelty);
  const decent = voices.filter((v) => !v.novelty);
  const pick = natural.length >= 3 ? natural : [...natural, ...decent.filter((v) => !v.natural)].slice(0, 12);
  return (pick.length ? pick : voices).map((v) => v.id);
}

function voicePool(engine) {
  if (engine === kokoroEngine) {
    const pool = settings.kokoroVoices.filter((id) => KOKORO_VOICES.some((v) => v.id === id));
    return pool.length ? pool : ['af_heart'];
  }
  const available = new Set(systemEngine.voices().map((v) => v.id));
  const chosen = (settings.systemVoices || defaultSystemVoiceIds()).filter((id) => available.has(id));
  return chosen.length ? chosen : [...available].slice(0, 1);
}

function voiceIdFor(login, engine) {
  const pool = voicePool(engine);
  const override = settings.userVoices[engine.id][login];
  if (override && pool.includes(override)) return override;
  return pool[hashString(login) % pool.length];
}

function voiceName(engine, id) {
  if (engine === kokoroEngine) return (KOKORO_VOICES.find((v) => v.id === id) || {}).name || id;
  const v = systemEngine.voices().find((x) => x.id === id);
  return v ? v.name.replace(/\s*\(.*?\)\s*/g, ' ').trim() : 'Default';
}

function voiceOptionsFor(entry, engine) {
  const voiceId = entry.forcedVoice || voiceIdFor(entry.login, engine);
  const h = hashString(`${entry.login}#vary`);
  const pitchJitter = settings.varyVoices ? ((h % 21) - 10) / 100 : 0;         // ±0.10
  const paceJitter = settings.varyVoices ? (((h >>> 8) % 11) - 5) / 100 : 0;   // ±0.05
  // Neural voices play the effect through Web Audio; system voices can only
  // approximate it with their own pitch and pace.
  const fx = VOICE_EFFECTS[entry.effect] || null;
  return {
    voiceId,
    rate: settings.rate * (1 + paceJitter) * ((fx && fx.rate) || 1),
    speed: Math.min(2, Math.max(0.5, settings.rate * (1 + paceJitter))),
    pitch: fx && fx.pitch !== undefined ? fx.pitch : 1 + pitchJitter,
    effect: fx ? entry.effect : null,
  };
}

const getVolume = () => settings.volume / 100;

// ---------------------------------------------------------------------------
// Reader: the queue and pause/resume logic
// ---------------------------------------------------------------------------

const reader = {
  queue: [],
  current: null,
  controller: null,
  paused: false,
  held: false,      // held back by the desktop app's screen reader, apart from pausing
  lastSpoken: null,
  readCount: 0,     // numbers messages in the order they finished, for replay
};

const feedEntries = [];
const MAX_FEED = 250;
let entrySeq = 0;

function enqueue(entry) {
  entry.uid = ++entrySeq;
  entry.receivedAt = entry.receivedAt || Date.now();
  addToFeed(entry);

  const reason = filterReason(entry);
  if (reason) {
    setStatus(entry, 'filtered', reason);
    return;
  }
  setStatus(entry, 'queued');
  if (entry.priority) {
    // In front of everything else, but behind earlier ones that also paid.
    const at = reader.queue.findIndex((e) => !e.priority);
    reader.queue.splice(at === -1 ? reader.queue.length : at, 0, entry);
  } else {
    reader.queue.push(entry);
  }

  if (settings.catchUp > 0 && reader.queue.length > settings.catchUp) {
    // Oldest first, but never something a viewer spent bits or points on.
    const excess = reader.queue.length - settings.catchUp;
    for (const old of reader.queue.filter((e) => !isPaidFor(e)).slice(0, excess)) {
      reader.queue.splice(reader.queue.indexOf(old), 1);
      setStatus(old, 'skipped', 'skipped to catch up');
    }
  }
  pump();
  renderNow();
}

const isPaidFor = (entry) => !!(entry.priority || entry.bits || entry.rewardId || entry.paid);

function filterReason(entry) {
  // A chat command that did something says what instead of being read.
  if (entry.handled) return entry.handled;
  // The desktop app's bot can keep its own replies out of the queue.
  const botReason = host.skipReason && host.skipReason(entry);
  if (botReason) return botReason;
  if (entry.kind === 'event' && !settings.readEvents) return 'events off';
  if (entry.kind === 'chat') {
    if (isIgnored(entry.login)) return 'ignored';
    if (settings.skipCommands && /^\s*!/.test(entry.rawText)) return 'command';
    if (settings.skipLinks && new RegExp(URL_RE.source, 'i').test(entry.rawText)) return 'link';
  }
  return null;
}

function pump() {
  if (reader.paused || reader.held || reader.current) return;
  // A replay holds the live queue back until it's over.
  if (replay.active) {
    pumpReplay();
    // Ending it may have paused reading again.
    if (replay.active || reader.current || reader.paused) return;
  }

  while (reader.queue.length) {
    const entry = reader.queue.shift();
    const text = composeSpeech(entry, reader.lastSpoken, settings);
    if (!text) {
      setStatus(entry, 'skipped', 'nothing to read');
      continue;
    }

    const engine = activeEngine();
    const opts = voiceOptionsFor(entry, engine);
    entry.spokenText = text;
    entry.engine = engine;
    entry.voiceId = opts.voiceId;
    reader.current = entry;
    setStatus(entry, 'speaking');

    const controller = engine.speak(text, opts, { getVolume });
    reader.controller = controller;
    controller.done.then(() => {
      if (reader.controller !== controller) return;
      if (entry.status === 'speaking') {
        setStatus(entry, 'done');
        entry.readSeq = ++reader.readCount;
        reader.lastSpoken = entry;
      }
      reader.current = null;
      reader.controller = null;
      pump();
      renderNow();
    });

    prefetchUpcoming(entry);
    break;
  }
  renderNow();
}

function prefetchUpcoming(after) {
  if (activeEngine() !== kokoroEngine) return;
  let prev = after;
  const items = [];
  for (const entry of reader.queue.slice(0, 2)) {
    const text = composeSpeech(entry, prev, settings);
    if (!text) continue;
    const opts = voiceOptionsFor(entry, kokoroEngine);
    items.push({ text, voiceId: opts.voiceId, speed: opts.speed });
    prev = entry;
  }
  kokoroEngine.prefetch(items);
}

// Everything a key can be bound to. The desktop app sends the same names back
// when the OS delivers a shortcut from another window.
const ACTIONS = {
  pause: () => { userGesture(); togglePause(); },
  skip: () => skipCurrent(),
  volumeUp: () => setVolume(settings.volume + 5),
  volumeDown: () => setVolume(settings.volume - 5),
  clear: () => clearQueue(),
  replay: () => { userGesture(); replayBack(); },
  toggleWindow: () => desktop && desktop.toggleWindow(),
  // Not bound to a key; the desktop app's Settings menu sends these. The
  // backup tab is opened first so its status line can be seen.
  openSettings: () => openSettings(),
  exportSettings: () => { openSettings('backup'); exportSettings(); },
  importSettings: () => { openSettings('backup'); importSettings(); },
};

// An action that is switched off in the settings leaves its keys alone, so
// they still reach the page or the app that has focus.
const actionEnabled = (action) => action !== 'replay' || settings.replay;

function runAction(action) {
  // The desktop app's bot has hotkeys of its own, named "bot:…".
  if (action.startsWith('bot:')) { if (host.onAction) host.onAction(action); return; }
  if (ACTIONS[action] && actionEnabled(action)) ACTIONS[action]();
}

function togglePause() {
  setPaused(!reader.paused);
}

function setVolume(value, { live = false } = {}) {
  const next = Math.max(0, Math.min(100, Math.round(value)));
  settings.volume = next;
  $('#volume').value = next;
  $('#volume').setAttribute('aria-valuetext', `${next} percent`);
  $('#volumeOut').textContent = `${next}%`;
  // While the slider itself is being dragged the screen reader already reads
  // out every step, so only a change from somewhere else is worth saying.
  if (!live) announce(`Volume ${next} percent`);
  // Neural playback follows the volume while the slider moves; a system-voice
  // utterance has to be restarted for it, so that waits until the slider is
  // let go (or until a hotkey changes the volume in one step).
  if (reader.controller && (!live || reader.current.engine === kokoroEngine)) reader.controller.volumeChanged();
  saveSettings();
}

function setRate(value) {
  settings.rate = Math.max(0.6, Math.min(2, Math.round(value * 20) / 20));
  renderRate();
  saveSettings();
}

function setPaused(paused) {
  if (reader.paused === paused) return;
  reader.paused = paused;
  // Pausing or resuming during a replay takes over from whatever the replay
  // would have done at the end.
  if (replay.active) replay.pauseAfter = false;
  // While held, the message stays paused until the hold ends.
  if (reader.controller && !reader.held) {
    if (paused) reader.controller.pause();
    else reader.controller.resume();
  }
  if (!paused) pump();
  renderNow();
  updateMediaSession();
  announce(paused ? 'Reading paused' : 'Reading resumed');
}

// The desktop app's screen reader holds chat back while it reads the screen,
// without it showing as paused: the message being read stops where it is and
// carries on from there once the hold ends.
function setHeld(held) {
  if (reader.held === held) return;
  reader.held = held;
  if (reader.controller && !reader.paused) {
    if (held) reader.controller.pause();
    else reader.controller.resume();
  }
  if (!held) pump();
}

function skipCurrent() {
  if (!reader.current) return;
  // A replayed message was read once already, and stays marked as read.
  if (!replay.active) setStatus(reader.current, 'skipped', 'skipped');
  reader.controller.stop();
  announce('Message skipped');
}

function clearQueue() {
  const cleared = reader.queue.length;
  for (const entry of reader.queue) setStatus(entry, 'skipped', 'cleared');
  reader.queue.length = 0;
  renderNow();
  announce(cleared ? `Cleared ${cleared} waiting message${cleared === 1 ? '' : 's'}` : 'Nothing was waiting');
}

function removeFromQueue(entry, status, note) {
  const i = reader.queue.indexOf(entry);
  if (i !== -1) reader.queue.splice(i, 1);
  if (reader.current === entry) {
    setStatus(entry, status, note);
    reader.controller.stop();
  } else if (i !== -1) {
    setStatus(entry, status, note);
  }
  renderNow();
}

// Put the current message back at the front and start it again (used when
// switching engines so nothing is lost).
function restartCurrent() {
  const entry = reader.current;
  if (!entry) return;
  const controller = reader.controller;
  if (replay.active) {
    // The replay hasn't moved on, so pump() says the same step again.
    reader.current = null;
    reader.controller = null;
    controller.stop();
    pump();
    return;
  }
  setStatus(entry, 'queued');
  reader.queue.unshift(entry);
  reader.current = null;
  reader.controller = null;
  controller.stop();
  pump();
}

// ---------------------------------------------------------------------------
// Replay: hearing messages that were already read
// ---------------------------------------------------------------------------

// The replay key steps back one message per press, then reading carries on
// in order up to where it was: three quick presses replay the last three
// messages. While a replay runs, live chat waits in the queue.
const replay = {
  active: false,
  phase: null,        // intro | item | outro
  items: [],          // the messages being replayed, oldest first
  index: 0,           // the one being read (or about to be)
  pauseAfter: false,  // reading was paused when the replay started
  stickToBottom: false,
};

// Messages that can be replayed: read to the end, and not taken down since.
function replayable(entry) {
  if (!entry || entry.status !== 'done' || !entry.readSeq || entry.removedByMod) return false;
  return !(entry.kind === 'chat' && isIgnored(entry.login));
}

function newestRead() {
  let best = null;
  for (const e of feedEntries) if (replayable(e) && (!best || e.readSeq > best.readSeq)) best = e;
  return best;
}

// The message read just before this one.
function readBefore(entry) {
  let best = null;
  for (const e of feedEntries) {
    if (replayable(e) && e.readSeq < entry.readSeq && (!best || e.readSeq > best.readSeq)) best = e;
  }
  return best;
}

function replayNoticeText(which) {
  if (!settings.replayAnnounce) return '';
  return (which === 'start' ? settings.replayStartText : settings.replayEndText).trim();
}

// The start and end notices are said by the reader itself, in the first voice
// of the pool, without any per-chatter variation.
function readerVoiceOptions(engine) {
  return {
    voiceId: voicePool(engine)[0],
    rate: settings.rate,
    speed: Math.min(2, Math.max(0.5, settings.rate)),
    pitch: 1,
    effect: null,
  };
}

function replayCount(n) {
  return `${n} message${n === 1 ? '' : 's'}`;
}

// The replay key, the Replay button and ⏮.
function replayBack() {
  if (!settings.replay) return;
  if (!replay.active) {
    const last = newestRead();
    if (!last) return replayNote('Nothing has been read yet');
    startReplay([last]);
    return;
  }

  const finished = replay.phase === 'outro' || replay.index >= replay.items.length;
  if (finished) {
    // Everything was heard again already, so go on from the oldest one
    // instead of repeating them all.
    const older = readBefore(replay.items[0]);
    if (!older) return replayNote('No older messages');
    Object.assign(replay, { items: [older], index: 0, phase: 'item' });
    interruptReplay();
  } else if (replay.phase === 'intro') {
    // Nothing has been read back yet; the intro carries on.
    const older = readBefore(replay.items[0]);
    if (!older) return replayNote('No older messages');
    replay.items.unshift(older);
  } else if (replay.index > 0) {
    replay.index--;
    interruptReplay();
  } else {
    const older = readBefore(replay.items[0]);
    if (!older) return replayNote('No older messages');
    replay.items.unshift(older);
    interruptReplay();
  }
  if (reader.paused) setPaused(false);
  renderNow();
  announce(`Replaying ${replayCount(replay.items.length - replay.index)}`);
}

// The ↻ on a message in chat: replay that one, or jump to it if it's already
// part of the replay.
function replayEntry(entry) {
  if (!settings.replay || !replayable(entry)) return;
  userGesture();
  if (!replay.active) {
    startReplay([entry]);
    return;
  }
  let at = replay.items.indexOf(entry);
  if (at === -1) {
    replay.items.push(entry);
    at = replay.items.length - 1;
  }
  // Already queued up in this replay: it comes when it comes.
  if (replay.phase === 'item' && at > replay.index) {
    renderNow();
    return;
  }
  Object.assign(replay, { index: at, phase: replay.phase === 'intro' ? 'intro' : 'item' });
  if (replay.phase === 'item') interruptReplay();
  if (reader.paused) setPaused(false);
  renderNow();
  announce(`Replaying a message from ${entry.displayName}`);
}

function startReplay(items) {
  replay.stickToBottom = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 60;
  Object.assign(replay, { active: true, items, index: 0, phase: 'intro', pauseAfter: reader.paused });

  // A live message that was being read goes back to the front of the queue,
  // to be read in full once the replay is over.
  if (reader.current) {
    const entry = reader.current;
    const controller = reader.controller;
    reader.current = null;
    reader.controller = null;
    setStatus(entry, 'queued', 'after replay');
    reader.queue.unshift(entry);
    controller.stop();
  }
  // The replay plays even if reading was paused, and pauses again after.
  if (reader.paused) {
    reader.paused = false;
    updateMediaSession();
  }
  announce(`Replaying ${replayCount(items.length)}`);
  pump();
  renderNow();
}

// Stops what the replay is saying without moving it on, so the next pump()
// says whatever the replay points at now.
function interruptReplay() {
  const controller = reader.controller;
  if (controller) {
    reader.current = null;
    reader.controller = null;
    controller.stop();
  }
  pump();
}

function stopReplay() {
  if (!replay.active) return;
  const controller = reader.controller;
  reader.current = null;
  reader.controller = null;
  endReplay();
  if (controller) controller.stop();
  pump();
  renderNow();
}

function endReplay() {
  replay.active = false;
  replay.phase = null;
  replay.items = [];
  replay.index = 0;
  // The next live message says who wrote it, whoever was read before.
  reader.lastSpoken = null;
  if (replay.stickToBottom) feedEl.scrollTop = feedEl.scrollHeight;
  if (replay.pauseAfter) setPaused(true);
  else announce('Replay finished');
}

// Says the next step of the replay: the start notice, the messages, then
// the end notice. Called by pump(); ends the replay when nothing is left.
function pumpReplay() {
  if (replay.phase === 'intro') {
    const text = replayNoticeText('start');
    if (text) return speakReplayStep({ kind: 'replay', notice: 'start' }, text, () => { replay.phase = 'item'; });
    replay.phase = 'item';
  }
  if (replay.phase === 'item') {
    while (replay.index < replay.items.length) {
      const entry = replay.items[replay.index];
      // Replays always say who wrote it, even after the same chatter.
      const text = replayable(entry) ? composeSpeech(entry, null, settings) : '';
      if (text) return speakReplayStep(entry, text, () => { replay.index++; });
      replay.index++;
    }
    replay.phase = 'outro';
  }
  const text = replayNoticeText('end');
  if (text) return speakReplayStep({ kind: 'replay', notice: 'end' }, text, endReplay);
  endReplay();
}

function speakReplayStep(entry, text, after) {
  const engine = activeEngine();
  const opts = entry.kind === 'replay' ? readerVoiceOptions(engine) : voiceOptionsFor(entry, engine);
  entry.spokenText = text;
  entry.engine = engine;
  entry.voiceId = opts.voiceId;
  reader.current = entry;

  const controller = engine.speak(text, opts, { getVolume });
  reader.controller = controller;
  controller.done.then(() => {
    if (reader.controller !== controller) return;
    reader.current = null;
    reader.controller = null;
    after();
    pump();
    renderNow();
  });

  if (entry.node && entry.node.isConnected) entry.node.scrollIntoView({ block: 'nearest' });
  prefetchReplay();
  renderNow();
}

function prefetchReplay() {
  if (activeEngine() !== kokoroEngine) return;
  const from = replay.phase === 'intro' ? replay.index : replay.index + 1;
  const items = replay.items.slice(from, from + 2).filter(replayable).map((entry) => {
    const opts = voiceOptionsFor(entry, kokoroEngine);
    return { text: composeSpeech(entry, null, settings), voiceId: opts.voiceId, speed: opts.speed };
  });
  const end = replayNoticeText('end');
  if (items.length < 2 && end && from + items.length >= replay.items.length) {
    const opts = readerVoiceOptions(kokoroEngine);
    items.push({ text: end, voiceId: opts.voiceId, speed: opts.speed });
  }
  kokoroEngine.prefetch(items.filter((item) => item.text));
}

// A short line in the player for a replay key press that had nothing to do.
let replayNoteTimer = null;
function replayNote(text) {
  const note = $('#replayNote');
  note.textContent = text;
  note.hidden = false;
  clearTimeout(replayNoteTimer);
  replayNoteTimer = setTimeout(() => { note.hidden = true; }, 2500);
  announce(text);
}

// Turning replay off ends one that is running and gives its keys back.
function applyReplaySetting() {
  document.body.classList.toggle('replay-off', !settings.replay);
  for (const id of TEXT_SETTINGS) $(`#${id}`).disabled = !settings.replay || !settings.replayAnnounce;
  $('#replayAnnounce').disabled = !settings.replay;
  if (!settings.replay) stopReplay();
}

// ---------------------------------------------------------------------------
// Twitch → entries
// ---------------------------------------------------------------------------

// Emote names in the 7TV/BTTV/FFZ sets. Each Twitch chat in the top bar has
// its own (chat.emotes), loaded once Twitch has told us the channel's id.
function emotesChanged() {
  renderEmoteStatus();
  // Messages that queued up while the sets were still downloading.
  refreshSpeechBodies();
  renderNow();
}

// `chat` and `roomId` when a Twitch chat has just learned its channel id;
// with neither, after the emote setting changes.
function loadThirdPartyEmotes(chat, roomId) {
  if (chat && roomId && roomId !== chat.roomId) {
    chat.roomId = roomId;
    chat.emotes.clear();
  }
  if (settings.emoteMode === 'skip-all') {
    for (const c of chats) if (c.emotes && c.roomId) c.emotes.load(c.roomId);
  }
  renderEmoteStatus();
}

// The emote set that applies to an entry: its Twitch channel's. YouTube and
// TikTok mark their own emotes, and 7TV names mean nothing there.
function emotesFor(entry) {
  const chat = entry && chats.find((c) => c.id === entry.sourceId);
  return chat && chat.emotes ? chat.emotes : null;
}

function renderEmoteStatus() {
  const hint = $('#emoteHint');
  const sets = chats.filter((c) => c.emotes && c.roomId).map((c) => c.emotes);
  // In "read" mode every emote is spoken anyway, so the option is moot.
  $('#readEmoteOnlyRow').hidden = settings.emoteMode === 'read';
  if (settings.emoteMode === 'read') {
    hint.textContent = 'Emote names are spoken as written, e.g. “Kappa”.';
  } else if (settings.emoteMode === 'skip-twitch') {
    hint.textContent = '7TV, BetterTTV and FrankerFaceZ emotes are still read out, because Twitch doesn’t mark them in the message.';
  } else if (!sets.length) {
    hint.textContent = 'The channel’s 7TV, BetterTTV and FrankerFaceZ emote names are fetched when you connect.';
  } else if (sets.some((e) => !e.loaded)) {
    hint.textContent = 'Fetching 7TV, BetterTTV and FrankerFaceZ emote names…';
  } else if (!sets.some((e) => e.size)) {
    hint.textContent = 'Couldn’t reach 7TV, BetterTTV or FrankerFaceZ, so only Twitch’s own emotes are skipped.';
  } else {
    const count = new Set(sets.flatMap((e) => [...e.names])).size.toLocaleString();
    const where = sets.length > 1 ? ` across ${sets.length} channels` : '';
    hint.textContent = `Also skipping ${count} 7TV/BTTV/FFZ emote names${where}${sets.some((e) => e.failed) ? ', though one source didn’t answer' : ''}.`;
  }
}

/**
 * The words actually handed to the voice. Twitch's own emotes come with
 * positions in the `emotes` tag; third-party ones arrive as plain words, so
 * they can only be recognised by name. `reply` is the chatter being replied
 * to, whose @mention Twitch puts in front of the message.
 */
function speechBodyFor(rawText, emotesTag, reply, emotes) {
  const withoutMention = (t) => (reply ? stripLeadingMention(t, reply.login, reply.displayName) : t);
  if (settings.emoteMode === 'read') return withoutMention(rawText);

  let body = removeEmotes(rawText, emotesTag);
  if (settings.emoteMode === 'skip-all' && emotes) body = emotes.strip(body);
  body = withoutMention(body);

  // Taking the emotes out left nothing to say, so the message was only emotes.
  // Read their names instead of staying silent, if that's what the user wants.
  if (settings.readEmoteOnly && !cleanForSpeech(body, { readEmojis: settings.readEmojis })) {
    return withoutMention(rawText);
  }
  return body;
}

// Re-derive what the voice will say for messages that haven't been read yet,
// after the emote settings change or the emote sets finish loading.
function refreshSpeechBodies() {
  for (const entry of [...reader.queue, reader.current]) {
    if (!entry || entry.rawText === undefined || entry.kind === 'notice') continue;
    entry.speechBody = entrySpeechBody(entry);
  }
}

// What a chat entry says once the cheermotes and a chosen effect word are out.
function entrySpeechBody(entry) {
  const reply = entry.isReply ? { login: entry.parentLogin, displayName: entry.parentDisplayName } : null;
  let body = speechBodyFor(entry.rawText, entry.emotesTag, reply, emotesFor(entry));
  if (entry.bits) body = stripCheermotes(body);
  if (entry.effectWord) body = body.replace(EFFECT_WORD_RE, '');
  return body;
}

function entryFromPrivmsg(msg) {
  const tags = msg.tags;
  let text = msg.params[1] || '';
  let action = false;
  const actionMatch = text.match(/^\u0001ACTION (.*)\u0001$/);
  if (actionMatch) { text = actionMatch[1]; action = true; }

  const login = (tags.login || msg.prefix.split('!')[0] || '').toLowerCase();
  const isReply = !!tags['reply-parent-msg-id'];

  let displayText = text;
  if (isReply) displayText = stripLeadingMention(text, tags['reply-parent-user-login'], tags['reply-parent-display-name']);

  return {
    id: tags.id,
    platform: 'twitch',
    kind: tags['msg-id'] === 'announcement' ? 'announcement' : 'chat',
    login,
    userId: tags['user-id'],
    displayName: tags['display-name'] || login,
    color: tags.color || null,
    rawText: text,
    emotesTag: tags.emotes,
    displayText,
    action,
    isReply,
    parentLogin: tags['reply-parent-user-login'],
    parentDisplayName: tags['reply-parent-display-name'],
    parentBody: tags['reply-parent-msg-body'],
    role: roleLevel(tags),
    bits: Number(tags.bits) || 0,
    rewardId: tags['custom-reward-id'] || null,
    highlighted: tags['msg-id'] === 'highlighted-message',
  };
}

function entryFromUserNotice(msg) {
  const tags = msg.tags;
  const text = msg.params[1] || '';
  const login = (tags.login || '').toLowerCase();
  const base = {
    id: tags.id,
    platform: 'twitch',
    login,
    userId: tags['user-id'],
    displayName: tags['display-name'] || login,
    color: tags.color || null,
    rawText: text,
    emotesTag: tags.emotes,
    displayText: text,
  };
  // In a collab, a notice from a partner's chat is wrapped as "sharedchatnotice".
  const kind = tags['msg-id'] === 'sharedchatnotice' ? tags['source-msg-id'] : tags['msg-id'];
  if (kind === 'announcement') return { ...base, kind: 'announcement' };
  return { ...base, kind: 'event', systemText: tags['system-msg'] || '' };
}

// ---------------------------------------------------------------------------
// Viewer interactions: bits, channel point rewards and chat commands
// ---------------------------------------------------------------------------

// The page reads chat anonymously, so it only sees what Twitch puts in chat:
// cheers, rewards that ask the viewer to type something, and messages. It
// can't answer in chat either, so the reader says the result out loud.

// `chat` is the top-bar chat it came in on; the test button leaves it out.
function handlePrivmsg(msg, chat) {
  if (chat && !takeShared(chat, msg)) return;
  const entry = withSource(entryFromPrivmsg(msg), chat);
  entry.sharedRoomId = partnerRoomOf(msg);
  if (entry.bits) applyCheer(entry);
  if (entry.rewardId) applyReward(entry);
  if (entry.highlighted && settings.highlightPriority) entry.priority = true;
  if (!entry.bits && !entry.rewardId) runChatCommand(entry);
  entry.speechBody = entrySpeechBody(entry);
  enqueue(entry);
}

// Who may do something, lowest to highest. The broadcaster passes them all.
const ROLE_LEVELS = { everyone: 0, subs: 1, vips: 2, mods: 3 };

function roleLevel(tags) {
  const badges = new Set((tags.badges || '').split(',').map((b) => b.split('/')[0]));
  if (badges.has('broadcaster')) return 4;
  if (tags.mod === '1' || badges.has('moderator')) return 3;
  if (tags.vip === '1' || badges.has('vip')) return 2;
  if (tags.subscriber === '1' || badges.has('subscriber') || badges.has('founder')) return 1;
  return 0;
}

const mayUse = (entry, who) => who in ROLE_LEVELS && entry.role >= ROLE_LEVELS[who];

// "Cheer200 robot hello" or "Cheer200 (robot) hello": the first word picks the effect.
const EFFECT_WORD_RE = new RegExp(`^\\s*\\(?(${Object.keys(VOICE_EFFECTS).join('|')})\\)?[:,]?(?=\\s|$)`, 'i');

function applyCheer(entry) {
  if (settings.cheerPriority > 0 && entry.bits >= settings.cheerPriority) entry.priority = true;
  if (settings.cheerEffects > 0 && entry.bits >= settings.cheerEffects) {
    const match = stripCheermotes(entry.rawText).match(EFFECT_WORD_RE);
    if (match) {
      entry.effect = match[1].toLowerCase();
      entry.effectWord = true;
    }
  }
}

// What a linked reward can do. The name is what the streamer sees in the
// list; the label is what the drop-down says.
const REWARD_ACTIONS = {
  voice: { name: 'Pick your voice', label: 'Pick their voice (they type a voice name)' },
  priority: { name: 'Skip the line', label: 'Read the message before everything else' },
  ...Object.fromEntries(Object.entries(VOICE_EFFECTS).map(([id, fx]) => [id, {
    name: `${fx.label} voice`,
    label: `Read the message in the ${fx.label.toLowerCase()} voice${fx.neuralOnly ? ' (neural voices)' : ''}`,
  }])),
};

function applyReward(entry) {
  if (rewardLink.action) linkReward(entry);
  const reward = settings.rewards[entry.rewardId];
  if (!reward) return;
  if (reward.action === 'voice') {
    entry.handled = pickVoice(entry, entry.rawText);
    readerCommandDone(entry, 'voice', entry.rawText);
  }
  else if (reward.action === 'priority') entry.priority = true;
  else if (VOICE_EFFECTS[reward.action]) entry.effect = reward.action;
}

// Returns what follows the command word, '' for the bare command, or null
// when the message isn't that command at all.
function commandArgs(text, command) {
  if (!command) return null;
  const t = text.trim();
  const lower = t.toLowerCase();
  if (lower === command) return '';
  return lower.startsWith(`${command} `) ? t.slice(command.length + 1).trim() : null;
}

function runChatCommand(entry) {
  const voiceArgs = commandArgs(entry.rawText, settings.voiceCommand);
  if (voiceArgs !== null && mayUse(entry, settings.voiceCommandWho)) {
    entry.handled = pickVoice(entry, voiceArgs);
    readerCommandDone(entry, 'voice', voiceArgs);
    return;
  }
  const modArgs = commandArgs(entry.rawText, settings.modCommand);
  if (modArgs !== null && mayUse(entry, settings.modCommandWho)) {
    entry.handled = runModCommand(modArgs);
    readerCommandDone(entry, 'mod', modArgs);
  }
}

// The page can't write in chat; the desktop app's bot can answer for it.
function readerCommandDone(entry, kind, args) {
  if (!host.onReaderCommand || !entry.handled) return;
  try { host.onReaderCommand(entry, { kind, args, result: entry.handled }); } catch (err) { console.error(err); }
}

// "!tts volume 40", "!tts volume +10", "!tts speed 1.2". Unknown words return
// null, so the message is treated like any other command.
function runModCommand(args) {
  const [verb = '', value = ''] = args.toLowerCase().split(/\s+/);
  const level = (current, min, max) => {
    const m = value.match(/^([+-]?)(\d+(?:\.\d+)?)%?$/);
    if (!m) return null;
    const n = Number(m[2]);
    return Math.max(min, Math.min(max, m[1] === '+' ? current + n : m[1] === '-' ? current - n : n));
  };
  switch (verb) {
    case 'skip':
      skipCurrent();
      return 'skip';
    case 'pause':
    case 'stop':
      setPaused(true);
      return 'pause';
    case 'resume':
    case 'play':
    case 'unpause':
      setPaused(false);
      return 'resume';
    case 'clear':
      clearQueue();
      return 'clear';
    case 'volume':
    case 'vol': {
      const n = level(settings.volume, 0, 100);
      if (n === null) return null;
      setVolume(n);
      return `volume ${settings.volume}%`;
    }
    case 'speed':
    case 'rate': {
      const n = level(settings.rate, 0.6, 2);
      if (n === null) return null;
      setRate(n);
      return `speed ${settings.rate.toFixed(2)}×`;
    }
  }
  return null;
}

// A voice from the pool by name: an exact name first, then a whole word of
// it ("aria" for "Aria (Natural)"), then any part of it.
function findVoice(engine, query) {
  const pool = voicePool(engine);
  const score = (id, q) => {
    const name = voiceName(engine, id).toLowerCase();
    if (name === q) return 3;
    if (name.split(/[^\p{L}\p{N}]+/u).includes(q)) return 2;
    return name.includes(q) ? 1 : 0;
  };
  const q = query.trim().toLowerCase();
  for (const attempt of [q, q.split(/\s+/)[0]]) {
    let best = null;
    let bestScore = 0;
    for (const id of pool) {
      const s = score(id, attempt);
      if (s > bestScore) { best = id; bestScore = s; }
    }
    if (best) return best;
  }
  return null;
}

const voiceConfirmedAt = new Map();

// From "!voice Bella" or a reward: give the chatter that voice, or the next
// one in the pool when no name is given. Returns what the feed shows.
function pickVoice(entry, query) {
  const engine = activeEngine();
  const pool = voicePool(engine);
  let next;
  if (query.trim()) {
    next = findVoice(engine, query);
    if (!next) return 'no such voice';
  } else {
    if (pool.length < 2) return 'only one voice';
    next = pool[(pool.indexOf(voiceIdFor(entry.login, engine)) + 1) % pool.length];
  }
  setUserVoice(entry.login, engine, next);

  // Viewers can't see the page, so they hear the new voice instead, but only
  // once in a while: someone flipping through voices shouldn't flood the queue.
  const last = voiceConfirmedAt.get(entry.login) || 0;
  if (settings.voiceConfirm && Date.now() - last > 15000) {
    voiceConfirmedAt.set(entry.login, Date.now());
    const text = `${speakableName(entry.displayName, entry.login, settings.nicknames)} now sounds like this.`;
    queueMicrotask(() => enqueue({
      id: `notice-${entry.id}`,
      kind: 'notice',
      login: entry.login,
      userId: entry.userId,
      displayName: entry.displayName,
      color: entry.color,
      rawText: text,
      displayText: text,
      speechBody: text,
    }));
  }
  return `voice: ${voiceName(engine, next)}`;
}

// Linking a reward: Twitch only gives its id, not its title, so the streamer
// redeems it once and the next unknown reward that comes through is it.
const rewardLink = { action: null };

function startRewardLink() {
  if (rewardLink.action) {
    stopRewardLink('');
    return;
  }
  rewardLink.action = $('#rewardAction').value;
  $('#rewardLinkBtn').textContent = 'Stop waiting';
  const twitch = chats.find((c) => c.platform === 'twitch' && c.state === 'connected');
  $('#rewardStatus').textContent = twitch
    ? `Waiting… Redeem the reward on #${twitch.client.channel} now.`
    : 'Waiting… Connect to your channel, then redeem the reward.';
}

function stopRewardLink(status) {
  rewardLink.action = null;
  $('#rewardLinkBtn').textContent = 'Link the next redemption';
  $('#rewardStatus').textContent = status;
}

function linkReward(entry) {
  const existing = settings.rewards[entry.rewardId];
  if (existing) {
    $('#rewardStatus').textContent = `That one is already linked as “${existing.name}”. Still waiting for a different reward…`;
    return;
  }
  const action = rewardLink.action;
  settings.rewards[entry.rewardId] = { name: REWARD_ACTIONS[action].name, action };
  saveSettings();
  renderRewards();
  stopRewardLink(`Linked the reward ${entry.displayName} redeemed. Give it the name you use on Twitch, so you can tell them apart.`);
  const input = $(`#rewardList li[data-reward="${CSS.escape(entry.rewardId)}"] input`);
  if (input) { input.focus(); input.select(); }
}

function renderRewards() {
  const options = (selected) => Object.entries(REWARD_ACTIONS)
    .map(([value, a]) => el('option', { value, selected: value === selected }, a.label));
  const rows = Object.entries(settings.rewards);
  $('#rewardList').replaceChildren(...rows.map(([id, reward]) => el('li', { 'data-reward': id },
    el('input', {
      value: reward.name,
      spellcheck: 'false',
      'aria-label': 'Reward name',
      onchange: (e) => {
        reward.name = e.target.value.trim().slice(0, 60) || REWARD_ACTIONS[reward.action].name;
        e.target.value = reward.name;
        saveSettings();
      },
    }),
    el('select', {
      'aria-label': `What “${reward.name}” does`,
      onchange: (e) => { reward.action = e.target.value; saveSettings(); },
    }, options(reward.action)),
    el('button', {
      class: 'x',
      type: 'button',
      title: 'Unlink this reward',
      'aria-label': `Unlink “${reward.name}”`,
      onclick: () => { delete settings.rewards[id]; saveSettings(); renderRewards(); },
    }, '×'),
  )));
  $('#rewardEmpty').hidden = rows.length > 0;
}

$('#rewardAction').append(...Object.entries(REWARD_ACTIONS).map(([value, a]) => el('option', { value }, a.label)));
$('#rewardLinkBtn').addEventListener('click', startRewardLink);

// The command words, as typed into the settings: lower case, one word, and
// with a ! in front if the streamer left it off, so "voice" can't match
// ordinary chat.
function cleanCommand(value) {
  const word = String(value || '').trim().toLowerCase().split(/\s+/)[0].slice(0, 25);
  return word && /^[\p{L}\p{N}]/u.test(word) ? `!${word}` : word;
}

function renderCommandHints() {
  for (const node of $$('[data-command]')) node.textContent = settings[node.dataset.command] || '(off)';
}

for (const key of ['voiceCommand', 'modCommand']) {
  $(`#${key}`).addEventListener('change', (e) => {
    settings[key] = cleanCommand(e.target.value);
    e.target.value = settings[key];
    saveSettings();
    renderCommandHints();
  });
}
for (const key of ['voiceCommandWho', 'modCommandWho']) {
  $(`#${key}`).addEventListener('change', (e) => { settings[key] = e.target.value; saveSettings(); });
}

// ---------------------------------------------------------------------------
// Chats: every Twitch channel, YouTube stream and TikTok live being read
// ---------------------------------------------------------------------------

// Each field in the top bar is one chat, and any number of each platform
// can be read at once, all into the same queue. Twitch is read by the page
// itself (one IRC connection per channel); YouTube and TikTok only by the
// desktop app, see js/sources.js.
const MAX_CHATS = 12;
const chats = [];
let chatSeq = 0;

const NORMALIZE = { twitch: TwitchChat.normalizeChannel, youtube: normalizeYouTube, tiktok: normalizeTikTok };
const INVALID_TEXT = {
  twitch: 'That doesn’t look like a Twitch channel',
  youtube: 'That doesn’t look like a YouTube channel or video',
  tiktok: 'That doesn’t look like a TikTok username',
};
const PLACEHOLDERS = { twitch: 'Channel or twitch.tv link', youtube: '@handle or video link', tiktok: '@username' };

// YouTube and TikTok are only offered where they can work.
const addablePlatforms = () => (RemoteChat.available ? ['twitch', 'youtube', 'tiktok'] : ['twitch']);

function createChat(platform, input = '') {
  const chat = { id: `c${++chatSeq}`, platform, input, state: 'idle', text: '', roomId: null, shared: new Map() };
  if (platform === 'twitch') {
    chat.emotes = new ThirdPartyEmotes(emotesChanged);
    chat.client = new TwitchChat({
      onStatus: (state, text) => renderConnection(chat, state, text),
      onMessage: (msg) => handlePrivmsg(msg, chat),
      onUserNotice: (msg) => {
        if (!takeShared(chat, msg)) return;
        const entry = withSource(entryFromUserNotice(msg), chat);
        entry.sharedRoomId = partnerRoomOf(msg);
        entry.speechBody = entrySpeechBody(entry);
        enqueue(entry);
      },
      onRoomState: (roomId) => {
        if (roomId !== chat.roomId) resetShared(chat);
        loadThirdPartyEmotes(chat, roomId);
      },
      onClearChat: (userId) => removeChatterMessages(chat, userId),
      onDeleteMessage: removeMessage,
    });
  } else {
    chat.client = new RemoteChat(chat.id, platform, {
      onStatus: (state, text) => renderConnection(chat, state, text),
      onMessage: (m) => handleRemoteMessage(chat, m),
      onDeleteMessage: removeMessage,
      onClearChat: (userId) => removeChatterMessages(chat, userId),
    });
  }
  return chat;
}

// Connected, connecting, or waiting to retry or for the stream to start.
const isActive = (chat) => (chat.platform === 'twitch' ? !chat.client.manualClose : chat.client.active);
const activeChats = () => chats.filter(isActive);
const anyChatConnected = () => chats.some((c) => c.state === 'connected');
const chatLabel = (chat) => sourceLabel(chat.platform, chat.client.channel || NORMALIZE[chat.platform](chat.input));

// "#shroud, @lofigirl and @someone": what is being read, for the status
// line, the tray, the tab title and the media keys.
function chatsSummary({ connectedOnly = false } = {}) {
  const labels = activeChats().filter((c) => !connectedOnly || c.state === 'connected').map(chatLabel);
  return labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}` : labels[0] || '';
}

// Which chat an entry came in on, so a mod clearing one channel leaves the
// others alone and the feed can say where it was written.
function withSource(entry, chat) {
  if (chat) {
    entry.sourceId = chat.id;
    entry.sourceLabel = chatLabel(chat);
  }
  return entry;
}

// What a mod took out of chat comes out of the queue too. A user id only
// counts in the chat it was banned from; no user id means that whole chat
// was cleared.
function removeChatterMessages(chat, userId) {
  const hit = (e) => e.sourceId === chat.id && (!userId || e.userId === userId);
  // Already read messages stay in the feed, but aren't replayed any more.
  for (const e of feedEntries) if (hit(e)) e.removedByMod = true;
  const targets = [...reader.queue, reader.current].filter((e) => e && e.kind !== 'replay' && hit(e));
  for (const entry of targets) removeFromQueue(entry, 'deleted', userId ? 'removed by mod' : 'chat cleared');
}

function removeMessage(id) {
  for (const e of feedEntries) if (e.id === id) e.removedByMod = true;
  const entry = [...reader.queue, reader.current].find((e) => e && e.id === id);
  if (entry) removeFromQueue(entry, 'deleted', 'deleted by mod');
  else {
    const shown = feedEntries.find((e) => e.id === id);
    if (shown && shown.status !== 'done' && shown.status !== 'speaking') setStatus(shown, 'deleted', 'deleted by mod');
  }
}

// ---------------------------------------------------------------------------
// Twitch collabs (Shared Chat)
// ---------------------------------------------------------------------------

// While streamers share their chats, Twitch sends each of them the messages
// of every chat in the session, each marked with the room it was written in
// (`source-room-id`). Per channel in the top bar, the streamer picks whose
// chats get read: all of them, only that channel's own, or a few.
const SHARED_MODES = ['all', 'own', 'pick'];
// Room id -> "#login". Kept across chats: a partner's name doesn't change.
const sharedNames = new Map();
const sharedLookups = new Set();
// One message reaches every collab channel in the top bar; read it once.
const sharedSeen = new Set();

const sharedName = (roomId) => sharedNames.get(roomId) || 'collab chat';

// The partner's room a message was written in; null for the channel's own.
function partnerRoomOf(msg) {
  const from = msg.tags['source-room-id'];
  return from && from !== msg.tags['room-id'] ? from : null;
}

function sharedPrefs(chat) {
  const prefs = chat.client.channel && settings.sharedChat[chat.client.channel];
  return prefs && SHARED_MODES.includes(prefs.mode) ? prefs : { mode: 'all', muted: [] };
}

function setSharedPrefs(chat, mode, muted = sharedPrefs(chat).muted) {
  const login = chat.client.channel;
  if (!login) return;
  if (mode === 'all' && !muted.length) delete settings.sharedChat[login];
  else settings.sharedChat[login] = { mode, muted: [...new Set(muted)].slice(0, 50) };
  saveSettings();
  renderSharedButton(chat);
  updateSharedPanel(chat);
}

function sharedAllowed(chat, part) {
  const prefs = sharedPrefs(chat);
  if (prefs.mode === 'own') return part.own;
  if (prefs.mode === 'pick') return !prefs.muted.includes(part.roomId);
  return true;
}

function resetShared(chat) {
  chat.shared = new Map();
  closeSharedPanel(chat);
  if (chat.sharedPanel) { chat.sharedPanel.remove(); chat.sharedPanel = null; }
  renderSharedButton(chat);
}

// Notes who is in the collab, and says whether this message should be read.
function takeShared(chat, msg) {
  const tags = msg.tags;
  const own = tags['room-id'];
  const from = tags['source-room-id'];
  if (!from || !own) return true;

  let added = false;
  for (const roomId of new Set([own, from])) {
    if (chat.shared.has(roomId)) continue;
    chat.shared.set(roomId, { roomId, own: roomId === own, read: 0, skipped: 0 });
    added = true;
  }
  if (!sharedNames.has(own) && chat.client.channel) sharedNames.set(own, `#${chat.client.channel}`);
  learnSharedName(from, msg);

  const part = chat.shared.get(from);
  const allowed = sharedAllowed(chat, part);
  const key = tags['source-id'];
  if (allowed && key) {
    if (sharedSeen.has(key)) return false;
    sharedSeen.add(key);
    if (sharedSeen.size > 2000) sharedSeen.delete(sharedSeen.values().next().value);
  }
  if (allowed) part.read++;
  else part.skipped++;

  if (added) {
    renderSharedButton(chat);
    if (chat.sharedPanel) buildSharedPanel(chat);
  } else {
    updateSharedCounts(chat, part);
  }
  return allowed;
}

// The streamer writing in their own chat gives the name away; anyone else
// needs a lookup, from a public API that needs no key.
function learnSharedName(roomId, msg) {
  if (sharedNames.has(roomId)) return;
  const login = (msg.tags.login || msg.prefix.split('!')[0] || '').toLowerCase();
  if (/(^|,)broadcaster\//.test(msg.tags['source-badges'] || '') && login) {
    setSharedName(roomId, login);
    return;
  }
  if (sharedLookups.has(roomId)) return;
  sharedLookups.add(roomId);
  fetch(`https://api.ivr.fi/v2/twitch/user?id=${encodeURIComponent(roomId)}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      const user = Array.isArray(data) ? data[0] : null;
      if (user && typeof user.login === 'string') setSharedName(roomId, user.login.toLowerCase());
    })
    .catch(() => {});
}

function setSharedName(roomId, login) {
  if (!LOGIN_RE.test(login)) return;
  sharedNames.set(roomId, `#${login}`);
  for (const e of feedEntries) if (e.sharedRoomId === roomId && e.sharedEl) e.sharedEl.textContent = `#${login}`;
  for (const chat of chats) {
    if (!chat.shared || !chat.shared.has(roomId)) continue;
    renderSharedButton(chat);
    if (chat.sharedPanel) buildSharedPanel(chat);
  }
}

// The button in the channel's field, there only while a collab is going on.
function renderSharedButton(chat) {
  const btn = chat.sharedBtn;
  if (!btn) return;
  const parts = [...chat.shared.values()];
  const collab = parts.some((p) => !p.own);
  btn.hidden = !collab;
  if (!collab) return;
  const reading = parts.filter((p) => sharedAllowed(chat, p)).length;
  const mode = sharedPrefs(chat).mode;
  const short = mode === 'own' ? 'own chat' : reading === parts.length ? `all ${parts.length}` : `${reading} of ${parts.length}`;
  btn.textContent = `Collab · ${short}`;
  btn.dataset.mode = mode;
  btn.title = `#${chat.client.channel} shares its chat with ${parts.length - 1} other channel${parts.length > 2 ? 's' : ''}. Pick whose messages are read.`;
}

function buildSharedPanel(chat) {
  const channel = `#${chat.client.channel}`;
  const parts = [...chat.shared.values()].sort((a, b) => (b.own - a.own) || sharedName(a.roomId).localeCompare(sharedName(b.roomId)));
  const radio = (mode, text) => el('label', { class: 'check' },
    el('input', { type: 'radio', name: `shared-mode-${chat.id}`, value: mode, onchange: () => setSharedPrefs(chat, mode) }),
    ` ${text}`);
  const rows = parts.map((part) => {
    part.countEl = el('span', { class: 'shared-count' });
    const box = el('input', {
      type: 'checkbox',
      'data-room': part.roomId,
      onchange: (e) => toggleSharedRoom(chat, part, e.target.checked),
    });
    return el('li', {},
      el('label', { class: 'check' }, box, ' ', sharedName(part.roomId), part.own ? el('span', { class: 'shared-own' }, ' (this channel)') : null),
      part.countEl);
  });
  const panel = el('div', { class: 'popover shared-panel', role: 'dialog', 'aria-label': `Collab chats for ${channel}` },
    el('p', { class: 'shared-head' }, `${channel} is sharing its chat with ${parts.length - 1} other channel${parts.length > 2 ? 's' : ''}. Read messages from:`),
    el('div', { class: 'shared-modes', role: 'radiogroup', 'aria-label': 'Whose messages to read' },
      radio('all', 'Every chat in the collab'),
      radio('own', `Only ${channel}’s own chat`),
      radio('pick', 'Only the chats ticked below')),
    el('ul', { class: 'shared-list', 'aria-label': 'Chats in the collab' }, rows),
    el('p', { class: 'hint' }, 'Messages from chats that are left out are dropped before they reach the queue, chat commands included. The choice is remembered for this channel.'),
  );
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeSharedPanel(chat, { focus: true }); }
  });
  const wasOpen = chat.sharedPanel && !chat.sharedPanel.hidden;
  if (chat.sharedPanel) chat.sharedPanel.replaceWith(panel);
  else chat.field.append(panel);
  chat.sharedPanel = panel;
  panel.hidden = !wasOpen;
  updateSharedPanel(chat);
}

// Ticking a box always means picking by hand, starting from what's read now.
function toggleSharedRoom(chat, part, on) {
  const muted = [...chat.shared.values()].filter((p) => !sharedAllowed(chat, p)).map((p) => p.roomId);
  const keep = sharedPrefs(chat).muted.filter((id) => !chat.shared.has(id));
  const next = on ? muted.filter((id) => id !== part.roomId) : [...muted, part.roomId];
  setSharedPrefs(chat, 'pick', [...keep, ...next]);
}

function updateSharedPanel(chat) {
  const panel = chat.sharedPanel;
  if (!panel) return;
  const mode = sharedPrefs(chat).mode;
  for (const input of panel.querySelectorAll('input[type="radio"]')) input.checked = input.value === mode;
  for (const input of panel.querySelectorAll('input[type="checkbox"]')) {
    const part = chat.shared.get(input.dataset.room);
    if (part) input.checked = sharedAllowed(chat, part);
  }
  for (const part of chat.shared.values()) updateSharedCounts(chat, part);
}

function updateSharedCounts(chat, part) {
  if (!part.countEl || !chat.sharedPanel || chat.sharedPanel.hidden) return;
  const bits = [];
  if (part.read) bits.push(`${part.read.toLocaleString()} read`);
  if (part.skipped) bits.push(`${part.skipped.toLocaleString()} left out`);
  part.countEl.textContent = bits.join(' · ');
}

function openSharedPanel(chat) {
  for (const other of chats) if (other !== chat) closeSharedPanel(other);
  buildSharedPanel(chat);
  chat.sharedPanel.hidden = false;
  updateSharedPanel(chat);
  chat.sharedBtn.setAttribute('aria-expanded', 'true');
  const current = chat.sharedPanel.querySelector('input[type="radio"]:checked');
  if (current) current.focus();
}

function closeSharedPanel(chat, { focus = false } = {}) {
  if (!chat.sharedPanel || chat.sharedPanel.hidden) return;
  chat.sharedPanel.hidden = true;
  if (chat.sharedBtn) {
    chat.sharedBtn.setAttribute('aria-expanded', 'false');
    if (focus) chat.sharedBtn.focus();
  }
}

document.addEventListener('click', (e) => {
  if (!e.target.isConnected) return;
  for (const chat of chats) if (chat.field && !chat.field.contains(e.target)) closeSharedPanel(chat);
});

// ---------------------------------------------------------------------------
// YouTube and TikTok → entries (desktop app only, see js/sources.js)
// ---------------------------------------------------------------------------

function entryFromRemote(platform, m) {
  const prefix = LOGIN_PREFIX[platform];
  const text = String(m.text || '');
  return {
    id: `${prefix}${m.id || `${Date.now()}-${entrySeq + 1}`}`,
    platform,
    kind: m.kind === 'event' ? 'event' : 'chat',
    login: m.login ? `${prefix}${String(m.login).toLowerCase()}` : '',
    userId: m.userId ? `${prefix}${m.userId}` : '',
    displayName: String(m.displayName || m.login || 'someone'),
    color: null,
    rawText: text,
    emotesTag: m.emotes || '',
    displayText: text,
    systemText: String(m.systemText || ''),
    action: false,
    isReply: false,
    role: Number(m.role) || 0,
    // A YouTube Super Chat or Super Sticker: { label: 'Super Chat of $5.00', badge: '$5.00 Super Chat' }.
    paid: m.paid ? { label: String(m.paid.label), badge: String(m.paid.badge) } : null,
  };
}

// The same path as a Twitch message, minus bits and channel points: mods
// and the streamer can use the reader's chat commands from any platform.
function handleRemoteMessage(chat, m) {
  const entry = withSource(entryFromRemote(chat ? chat.platform : m.platform, m), chat);
  if (entry.kind === 'chat' && !entry.paid) runChatCommand(entry);
  entry.speechBody = entrySpeechBody(entry);
  // The desktop app's bot answers commands from YouTube and TikTok too.
  if (host.onRemoteMessage) host.onRemoteMessage(entry, m);
  enqueue(entry);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const feedEl = $('#feed');

const STATUS_TEXT = {
  queued: 'waiting',
  speaking: 'reading',
  done: 'read',
  skipped: 'skipped',
  filtered: 'skipped',
  deleted: 'deleted',
};

// Which chat a message came from, once there is more than one Twitch chat to
// tell apart: the platform, and the channel too when that platform has more
// than one. Notices from the reader itself have no platform.
function platformTag(entry) {
  const platform = entry.platform;
  const active = activeChats();
  if (!platform || (platform === 'twitch' && active.length < 2)) return null;
  const name = PLATFORMS[platform].name;
  const several = active.filter((c) => c.platform === platform).length > 1;
  const text = several && entry.sourceLabel ? `${name} ${entry.sourceLabel}` : name;
  return el('span', { class: 'platform', 'data-platform': platform, title: entry.sourceLabel ? `${name} ${entry.sourceLabel}` : name }, text);
}

function addToFeed(entry) {
  $('#feedEmpty').hidden = true;
  const nearBottom = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 60;

  const voiceBtn = el('button', {
    class: 'tag',
    type: 'button',
    title: 'Give this chatter a different voice',
    onclick: () => cycleUserVoice(entry),
  });
  const stateEl = el('span', { class: 'state' });
  const removeBtn = el('button', {
    class: 'x',
    type: 'button',
    title: 'Don’t read this message',
    'aria-label': `Don’t read this message from ${entry.displayName}`,
    onclick: () => removeFromQueue(entry, 'skipped', 'removed'),
  }, '×');
  // Takes the place of × once the message has been read.
  const replayBtn = el('button', {
    class: 'replay-btn',
    type: 'button',
    title: 'Hear this message again',
    'aria-label': `Replay this message from ${entry.displayName}`,
    onclick: () => replayEntry(entry),
  }, '↻');
  const replayEl = el('span', { class: 'replay-mark' });

  const name = el('button', {
    class: 'name',
    type: 'button',
    title: 'Nickname, voice and ignoring',
    'aria-label': `Options for ${entry.displayName}`,
    'aria-haspopup': 'dialog',
    style: entry.color ? `--c:${entry.color}` : '',
    onclick: (e) => openChatter(entry, e.currentTarget),
  }, entry.displayName);
  const reward = entry.rewardId ? settings.rewards[entry.rewardId] : null;
  const badges = [
    entry.paid ? entry.paid.badge : null,
    entry.bits ? `${entry.bits.toLocaleString()} bits` : null,
    entry.rewardId ? (reward ? reward.name : 'channel points') : null,
    entry.highlighted ? 'highlighted' : null,
    entry.effect ? VOICE_EFFECTS[entry.effect].label.toLowerCase() : null,
    entry.priority ? 'read first' : null,
  ].filter(Boolean);
  const label = entry.label || { event: 'Event', notice: 'Reader' }[entry.kind];
  const meta = el('div', { class: 'meta' },
    platformTag(entry),
    entry.sharedRoomId ? (entry.sharedEl = el('span', { class: 'platform shared-from', 'data-platform': 'twitch', title: 'Written in a collab partner’s chat' }, sharedName(entry.sharedRoomId))) : null,
    label ? el('span', { class: 'reply-to' }, label) : name,
    entry.kind === 'announcement' ? el('span', { class: 'reply-to' }, 'announcement') : null,
    badges.map((b) => el('span', { class: 'badge' }, b)),
    entry.isReply ? el('span', { class: 'reply-to' }, `↩ replying to @${entry.parentDisplayName || entry.parentLogin}`) : null,
    el('span', { class: 'tail' }, voiceBtn, replayEl, stateEl, removeBtn, replayBtn),
  );

  const node = el('li', { class: `msg ${entry.kind}` },
    meta,
    entry.isReply && entry.parentBody ? el('div', { class: 'reply-quote' }, entry.parentBody) : null,
    el('div', { class: 'text' }, entry.kind === 'event' ? [entry.systemText, entry.displayText].filter(Boolean).join(' · ') : (entry.action ? `* ${entry.displayText}` : entry.displayText)),
  );
  node.style.setProperty('--c', entry.color || '');

  entry.node = node;
  entry.voiceBtn = voiceBtn;
  entry.stateEl = stateEl;
  entry.replayEl = replayEl;
  feedEntries.push(entry);
  feedEl.append(node);

  while (feedEntries.length > MAX_FEED) {
    const old = feedEntries.shift();
    old.node.remove();
  }
  updateVoiceTag(entry);
  if (nearBottom) feedEl.scrollTop = feedEl.scrollHeight;
}

function setStatus(entry, status, note) {
  entry.status = status;
  // Something the bot said, which an effect may be waiting on.
  if (entry.whenDone && status !== 'queued' && status !== 'speaking') {
    entry.whenDone(status);
    entry.whenDone = null;
  }
  if (!entry.node) return;
  entry.node.dataset.status = status;
  entry.stateEl.textContent = note || STATUS_TEXT[status] || status;
  entry.node.classList.toggle('paused', status === 'speaking' && reader.paused);
  updateVoiceTag(entry);
}

function updateVoiceTag(entry) {
  if (!entry.voiceBtn) return;
  if (entry.kind === 'event' || !entry.login) { entry.voiceBtn.hidden = true; return; }
  const engine = entry.status === 'done' || entry.status === 'speaking' ? entry.engine || activeEngine() : activeEngine();
  const id = entry.status === 'done' || entry.status === 'speaking' ? entry.voiceId : voiceIdFor(entry.login, engine);
  const name = voiceName(engine, id);
  entry.voiceBtn.textContent = name;
  entry.voiceBtn.setAttribute('aria-label', `Voice for ${entry.displayName}: ${name}. Pick the next one.`);
}

function refreshVoiceTags() {
  for (const entry of feedEntries) updateVoiceTag(entry);
}

function cycleUserVoice(entry) {
  const engine = activeEngine();
  const pool = voicePool(engine);
  if (pool.length < 2) return;
  const current = voiceIdFor(entry.login, engine);
  const next = pool[(pool.indexOf(current) + 1) % pool.length];
  setUserVoice(entry.login, engine, next);
  engine.preview && previewVoice(engine, next, `This is how ${speakableName(entry.displayName, entry.login, settings.nicknames)} sounds now.`);
}

function setUserVoice(login, engine, voiceId) {
  settings.userVoices[engine.id][login] = voiceId;
  saveSettings();
  for (const e of feedEntries) if (e.login === login && e.status !== 'done') updateVoiceTag(e);
}

const nowPanel = $('#nowPanel');
const nowBar = $('#nowBar');

function renderNow() {
  readerChanged();
  const entry = reader.current;
  const state = reader.paused ? 'paused' : entry ? 'speaking' : 'idle';
  nowPanel.dataset.state = state;
  nowPanel.dataset.replay = replay.active ? 'on' : 'off';
  renderReplayMarks();
  $('#pauseBtn').setAttribute('aria-pressed', String(reader.paused));
  $('#pauseBtn').title = reader.paused ? 'Resume reading' : 'Pause reading';
  $('#pauseBtn').setAttribute('aria-label', reader.paused ? 'Resume reading' : 'Pause reading');

  const loading = entry && reader.controller && reader.controller.loading;
  $('#nowLabel').textContent = reader.paused
    ? (entry ? 'Paused on this message' : 'Paused')
    : replay.active ? replayLabel()
    : loading ? 'Preparing voice…' : entry ? 'Reading' : 'Idle';

  const waiting = reader.queue.length;
  $('#queueCount').textContent = replay.active && waiting ? `${waiting} waiting for live` : `${waiting} waiting`;
  $('#replayStop').hidden = !replay.active;
  $('#replayBtn').disabled = !replay.active && !newestRead();

  const msgEl = $('#nowMsg');
  msgEl.replaceChildren();
  if (entry && entry.kind === 'replay') {
    // The reader's own start and end notice.
    msgEl.append(el('span', { class: 'muted replay-notice' }, `“${entry.spokenText}”`));
  } else if (entry) {
    if (replay.active) msgEl.append(el('span', { class: 'replay-pill' }, `↻ from ${timeAgo(entry.receivedAt)}`), ' ');
    const tag = platformTag(entry);
    if (tag) msgEl.append(tag, ' ');
    if (entry.kind !== 'event') {
      const name = el('span', { class: 'name' }, entry.displayName);
      name.style.color = entry.color && !settings.highContrast ? `color-mix(in oklab, ${entry.color} 72%, var(--fg))` : '';
      msgEl.append(name);
    }
    if (entry.isReply) msgEl.append(el('span', { class: 'muted' }, ` ↩ @${entry.parentDisplayName || entry.parentLogin}`));
    if (entry.effect) msgEl.append(el('span', { class: 'muted' }, ` · ${VOICE_EFFECTS[entry.effect].label.toLowerCase()} voice`));
    msgEl.append(el('div', {}, entry.spokenText));
  } else {
    msgEl.append(el('span', { class: 'muted' }, reader.paused
      ? `Reading is paused${waiting ? `, ${waiting} message${waiting === 1 ? '' : 's'} waiting` : ''}. Press ${keyLabel(settings.keys.pause)} to continue.`
      : anyChatConnected() ? 'Waiting for chat messages…' : 'Nothing is being read right now.'));
  }
  if (!entry) {
    nowBar.style.width = '0';
    tickProgress.lastPercent = 0;
    $('#nowProgress').setAttribute('aria-valuenow', '0');
  }

  for (const e of feedEntries) e.node.classList.toggle('paused', e.status === 'speaking' && reader.paused);

  if (desktop) desktop.setState({ paused: reader.paused, where: chatsSummary(), waiting, replay: settings.replay });
}

function replayLabel() {
  const n = replay.items.length;
  if (replay.phase === 'intro') return n > 1 ? `Replay · ${n} messages` : 'Replay';
  if (replay.phase === 'outro' || replay.index >= n) return 'Replay finished';
  return n > 1 ? `Replaying ${replay.index + 1} of ${n}` : 'Replaying';
}

function timeAgo(time) {
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

// Marks the messages in chat that belong to the replay: the one being read,
// the ones still to come and the ones heard again already.
const replayMarked = new Set();

function renderReplayMarks() {
  const marks = new Map();
  if (replay.active) {
    const n = replay.items.length;
    replay.items.forEach((entry, i) => {
      if (!entry.node) return;
      const step = replay.phase === 'outro' || i < replay.index ? 'played'
        : i === replay.index && replay.phase === 'item' ? 'current' : 'next';
      const pos = n > 1 ? ` ${i + 1}/${n}` : '';
      marks.set(entry, [step, step === 'current' ? `↻ replaying${pos}` : step === 'next' ? `↻ replay${pos}` : '↻ replayed']);
    });
  }
  for (const entry of replayMarked) {
    if (marks.has(entry)) continue;
    delete entry.node.dataset.replay;
    entry.replayEl.textContent = '';
    replayMarked.delete(entry);
  }
  for (const [entry, [step, text]] of marks) {
    entry.node.dataset.replay = step;
    entry.replayEl.textContent = text;
    replayMarked.add(entry);
  }
}

function tickProgress() {
  if (reader.controller) {
    const percent = reader.controller.progress() * 100;
    nowBar.style.width = `${percent.toFixed(1)}%`;
    const whole = Math.round(percent);
    if (whole !== tickProgress.lastPercent) {
      tickProgress.lastPercent = whole;
      $('#nowProgress').setAttribute('aria-valuenow', String(whole));
    }
    const loading = !!reader.controller.loading;
    if (loading !== tickProgress.lastLoading) { tickProgress.lastLoading = loading; renderNow(); }
  }
  requestAnimationFrame(tickProgress);
}
requestAnimationFrame(tickProgress);

function renderConnection(chat, state, text) {
  chat.state = state;
  chat.text = text;
  if (chat.field) {
    chat.field.dataset.state = state;
    chat.field.title = text ? `${PLATFORMS[chat.platform].name}: ${text}` : '';
  }
  renderStatusLine();
  renderConnectButton();
  renderNow();
}

// One line for every chat: the ones being read are named together, anything
// else (connecting, waiting for a stream, an error) says which chat it is.
function renderStatusLine() {
  readerChanged();
  const shown = chats.filter((c) => isActive(c) || c.state === 'error');
  const connected = shown.filter((c) => c.state === 'connected');
  const others = shown.filter((c) => c.state !== 'connected');
  const parts = [];
  if (connected.length) parts.push(connected.length === 1 ? connected[0].text : `Reading ${chatsSummary({ connectedOnly: true })}`);
  for (const c of others) {
    // "TikTok: @x isn't live…" — most of these already name the chat.
    const label = c.text.includes(chatLabel(c)) ? '' : ` ${chatLabel(c)}`;
    parts.push(shown.length > 1 ? `${PLATFORMS[c.platform].name}${label}: ${c.text}` : c.text);
  }

  // The dot shows the worst of them, so a chat that dropped isn't hidden
  // behind one that's fine.
  const states = shown.map((c) => c.state);
  const state = ['error', 'connecting', 'connected'].find((x) => states.includes(x)) || 'idle';
  const text = parts.join(' · ') || chats.map((c) => c.text).find(Boolean) || 'Not connected';
  $('#status').dataset.state = state;
  $('#statusText').textContent = text;
  $('#status').title = text;

  const reading = chatsSummary({ connectedOnly: true });
  document.title = reading ? `${reading} · Chat Reader` : 'Chat Reader · Twitch TTS';
}

// ---------------------------------------------------------------------------
// Voice settings UI
// ---------------------------------------------------------------------------

function renderEngineUI() {
  for (const radio of $$('input[name="engine"]')) radio.checked = radio.value === settings.engine;
  const kokoro = settings.engine === 'kokoro';
  $('#kokoroBox').hidden = !kokoro;
  $('#systemBox').hidden = kokoro;
  $('#engineHint').textContent = kokoro
    ? 'Neural voices run on this computer and sound the most natural. English only. The model downloads once, then loads from cache.'
    : 'Built-in voices from your browser and OS. They start instantly and cover many languages. Edge has the most natural ones.';
  renderVoiceList();
  renderKokoroState(kokoroEngine.state, {});
  renderGpuWarning();
}

// The line under the player that says which voices are speaking. While the
// neural model loads it shows how far along it is, since the settings that
// hold the full status are usually closed.
function renderVoiceChip(kokoroState = kokoroEngine.state, info = {}) {
  const chip = $('#voiceChip');
  const kokoro = settings.engine === 'kokoro';
  const state = kokoro ? kokoroState : 'ready';
  const deviceName = (info.device || kokoroEngine.device) === 'webgpu' ? 'GPU' : 'CPU';
  let text;
  if (!kokoro) text = 'System voices';
  else if (state === 'ready') text = `Neural voices · ${deviceName}`;
  else if (state === 'loading') text = info.progress ? `Loading neural voices… ${Math.round(info.progress * 100)}%` : 'Loading neural voices…';
  else if (state === 'error') text = 'Neural voices failed · using system voices';
  else text = 'Neural voices not loaded · using system voices';
  chip.dataset.state = state;
  $('#voiceChipText').textContent = text;
  readerChanged();
  chip.setAttribute('aria-label', `${text}. Open voice settings.`);
}

$('#voiceChip').addEventListener('click', () => openSettings('voices'));

function renderLanguageOptions() {
  const langs = new Map();
  for (const v of systemEngine.voices()) {
    const code = v.lang.slice(0, 2).toLowerCase();
    if (!langs.has(code)) {
      let label = code;
      try { label = new Intl.DisplayNames([navigator.language], { type: 'language' }).of(code) || code; } catch {}
      langs.set(code, label);
    }
  }
  const select = $('#systemLang');
  select.replaceChildren(
    ...[...langs].sort((a, b) => a[1].localeCompare(b[1])).map(([code, label]) => el('option', { value: code }, label)),
    el('option', { value: 'all' }, 'All languages'),
  );
  // Voices load asynchronously; only fall back once we know what exists.
  if (langs.size && !langs.has(settings.systemLang) && settings.systemLang !== 'all') settings.systemLang = langs.has('en') ? 'en' : 'all';
  if (!langs.size) return;
  select.value = settings.systemLang;
}

function renderVoiceList() {
  const list = $('#voiceList');
  list.replaceChildren();

  if (settings.engine === 'kokoro') {
    const selected = new Set(settings.kokoroVoices);
    for (const v of KOKORO_VOICES) {
      const good = /^[AB]/.test(v.grade);
      list.append(el('li', {},
        el('label', {},
          el('input', {
            type: 'checkbox',
            checked: selected.has(v.id),
            onchange: (e) => toggleVoice('kokoro', v.id, e.target.checked),
          }),
          el('span', { class: 'vname' }, v.name),
          el('span', { class: 'vmeta' }, `${v.gender === 'F' ? 'female' : 'male'} · ${v.accent} · `, el('span', { class: good ? 'good' : '' }, v.grade)),
        ),
        el('button', { class: 'play', type: 'button', title: `Preview ${v.name}`, 'aria-label': `Hear ${v.name}`, onclick: () => previewVoice(kokoroEngine, v.id) }, '▶'),
      ));
    }
  } else {
    const lang = settings.systemLang;
    const voices = systemEngine.voices()
      .filter((v) => lang === 'all' || v.lang.toLowerCase().startsWith(lang))
      .sort((a, b) => (b.natural - a.natural) || (a.novelty - b.novelty) || a.name.localeCompare(b.name));
    const selected = new Set(voicePool(systemEngine));
    if (!voices.length) {
      list.append(el('li', { class: 'hint' }, systemEngine.supported ? 'Loading voices…' : 'This browser has no speech voices.'));
    }
    for (const v of voices) {
      list.append(el('li', {},
        el('label', {},
          el('input', {
            type: 'checkbox',
            checked: selected.has(v.id),
            onchange: (e) => toggleVoice('system', v.id, e.target.checked),
          }),
          el('span', { class: 'vname', title: v.raw.name }, v.name),
          el('span', { class: 'vmeta' }, v.lang, v.natural ? el('span', { class: 'good' }, ' · natural') : null),
        ),
        el('button', { class: 'play', type: 'button', title: `Preview ${v.name}`, 'aria-label': `Hear ${v.name}`, onclick: () => previewVoice(systemEngine, v.id) }, '▶'),
      ));
    }
  }
  const poolSize = settings.engine === 'kokoro' ? voicePool(kokoroEngine).length : voicePool(systemEngine).length;
  $('#poolCount').textContent = `· ${poolSize} in use`;
}

function toggleVoice(engineId, id, on) {
  if (engineId === 'kokoro') {
    const set = new Set(settings.kokoroVoices);
    on ? set.add(id) : set.delete(id);
    settings.kokoroVoices = KOKORO_VOICES.map((v) => v.id).filter((x) => set.has(x));
  } else {
    const set = new Set(voicePool(systemEngine));
    on ? set.add(id) : set.delete(id);
    settings.systemVoices = [...set];
  }
  saveSettings();
  renderVoiceList();
  refreshVoiceTags();
}

let previewing = false;
async function previewVoice(engine, voiceId, text) {
  if (previewing) return;
  if (engine === kokoroEngine && kokoroEngine.state !== 'ready') {
    loadKokoro();
    return;
  }
  previewing = true;
  const wasReading = !!reader.controller && !reader.paused;
  if (wasReading) reader.controller.pause();
  try {
    await engine.preview(text || `Hi! I'm ${voiceName(engine, voiceId)}, and this is how I'll sound reading your chat.`, voiceId, getVolume());
  } catch (err) {
    console.warn('Preview failed:', err);
  }
  previewing = false;
  if (wasReading && !reader.paused && reader.controller) reader.controller.resume();
}

// Where each browser keeps its hardware acceleration switch. Settings pages
// can't be linked to from a web page, so the address is offered for copying.
function graphicsSettingsHelp() {
  const ua = navigator.userAgent;
  const chromium = (url) => ({ steps: 'open Settings → System and turn on “Use graphics acceleration when available”', url });
  if (/Firefox\//.test(ua)) {
    return {
      steps: 'open Settings → General → Performance, untick “Use recommended performance settings” and tick “Use hardware acceleration when available”',
      url: 'about:preferences#general',
    };
  }
  if (/Edg\//.test(ua)) return { steps: 'open Settings → System and performance and turn on “Use graphics acceleration when available”', url: 'edge://settings/system' };
  if (/OPR\//.test(ua)) return { steps: 'open Settings → System and turn on “Use hardware acceleration when available”', url: 'opera://settings/system' };
  if (navigator.brave) return chromium('brave://settings/system');
  if (/Chrome\/|Chromium\//.test(ua)) return chromium('chrome://settings/system');
  if (/Safari\//.test(ua)) {
    // Safari has no acceleration switch; WebGPU is a feature flag.
    return {
      steps: 'turn on Settings → Advanced → “Show features for web developers” and check that Develop → Feature Flags → “WebGPU” is on',
      url: '',
      restart: false,
    };
  }
  return { steps: 'turn on hardware (graphics) acceleration in your browser settings', url: '' };
}

async function renderGpuWarning() {
  const box = $('#gpuWarning');
  const wantsGpu = () => settings.engine === 'kokoro' && settings.kokoroMode !== 'wasm';
  if (!wantsGpu()) { box.hidden = true; return; }

  const gfx = await detectGraphics();
  if (!wantsGpu() || gfx.gpuUsable) { box.hidden = true; return; }

  const fallback = settings.kokoroMode === 'webgpu'
    ? 'GPU mode can’t be used, so neural voices will fall back to the CPU'
    : 'Neural voices will run on the CPU instead';

  if (!window.isSecureContext) {
    // Browsers hide WebGPU on insecure pages, which would look like missing support.
    $('#gpuWarningTitle').textContent = 'GPU voices need HTTPS';
    $('#gpuWarningText').textContent = 'This page isn’t loaded over HTTPS, so the browser won’t allow GPU or neural voices. Open it with https:// (or on localhost).';
    $('#gpuWarningFix').hidden = true;
    $('#gpuWarningCopy').hidden = true;
  } else if (gfx.accelerated === false) {
    const help = graphicsSettingsHelp();
    $('#gpuWarningTitle').textContent = 'Graphics acceleration is turned off';
    $('#gpuWarningText').textContent = `${fallback}. That is slower and can fall behind a busy chat.`;
    $('#gpuWarningFix').textContent = `To fix it, ${help.steps}${help.restart === false ? '' : ', then restart the browser'}.`;
    $('#gpuWarningFix').hidden = false;
    $('#gpuSettingsUrl').textContent = help.url;
    $('#gpuWarningCopy').hidden = !help.url;
  } else {
    $('#gpuWarningTitle').textContent = 'GPU voices aren’t available in this browser';
    $('#gpuWarningText').textContent = `This browser doesn’t support WebGPU. ${fallback}, which is slower. Recent versions of Chrome, Edge and Safari can use the GPU.`;
    $('#gpuWarningFix').hidden = true;
    $('#gpuWarningCopy').hidden = true;
  }
  box.hidden = false;
}

function loadKokoro() {
  kokoroEngine.load(settings.kokoroMode);
}

function renderKokoroState(state, info) {
  const status = $('#kokoroStatus');
  const btn = $('#kokoroLoadBtn');
  const wrap = $('#kokoroProgressWrap');
  if (!status) return;
  const deviceName = (info.device || kokoroEngine.device) === 'webgpu' ? 'GPU' : 'CPU';
  const changed = state !== renderKokoroState.lastState;
  renderKokoroState.lastState = state;
  btn.hidden = state === 'loading' || state === 'ready';
  wrap.hidden = state !== 'loading';
  renderVoiceChip(state, info);

  if (state === 'unloaded') {
    status.textContent = 'Not loaded. System voices are used until it is.';
  } else if (state === 'loading') {
    const mb = (n) => (n / 1e6).toFixed(0);
    status.textContent = info.total >= 1e6
      ? `Loading on ${deviceName}… ${mb(info.loaded)} / ${mb(info.total)} MB`
      : `Loading on ${deviceName}…`;
    $('#kokoroProgress').style.width = `${((info.progress || 0) * 100).toFixed(1)}%`;
  } else if (state === 'ready') {
    status.textContent = `Ready (${deviceName})`;
    if (changed) announce(`Neural voices are ready, running on the ${deviceName}`);
    if (settings.engine === 'kokoro' && reader.current && reader.current.engine !== kokoroEngine && !reader.paused) {
      // Keep the current system-voice message; the next one switches over.
    }
    refreshVoiceTags();
  } else if (state === 'error') {
    btn.hidden = false;
    btn.textContent = 'Try again';
    status.textContent = `Couldn't load: ${info.error || 'unknown error'}. Using system voices.`;
    if (changed) announce('Neural voices couldn’t load. System voices are used instead.');
  }
}

// ---------------------------------------------------------------------------
// Nicknames
// ---------------------------------------------------------------------------

// "someone (TikTok)" for a prefixed login; a Twitch login as it is.
function loginLabel(login) {
  const platform = platformOfLogin(login);
  return platform === 'twitch' ? login : `${bareLogin(login)} (${PLATFORMS[platform].name})`;
}

function renderNicknames() {
  const rows = Object.entries(settings.nicknames).sort((a, b) => a[0].localeCompare(b[0]));
  $('#nicknameList').replaceChildren(...rows.map(([login, nickname]) => el('li', { 'data-login': login },
    el('span', { class: 'nick-user', title: login }, loginLabel(login)),
    el('span', { class: 'nick-arrow', 'aria-hidden': 'true' }, '→'),
    el('input', {
      value: nickname,
      spellcheck: 'false',
      'aria-label': `Nickname for ${loginLabel(login)}`,
      onchange: (e) => setNickname(login, e.target.value),
    }),
    el('button', { class: 'play', type: 'button', title: 'Hear it', 'aria-label': `Hear how ${login} is said`, onclick: () => previewNickname(login) }, '▶'),
    el('button', { class: 'x', type: 'button', title: `Remove nickname for ${login}`, 'aria-label': `Remove the nickname for ${login}`, onclick: () => setNickname(login, '') }, '×'),
  )));
  $('#nicknameEmpty').hidden = rows.length > 0;
}

function setNickname(login, nickname) {
  const key = normalizeLogin(login);
  if (!key) return;
  const value = nickname.trim();
  if (value) settings.nicknames[key] = value;
  else delete settings.nicknames[key];
  saveSettings();
  renderNicknames();
}

function previewNickname(login) {
  const engine = activeEngine();
  previewVoice(engine, voiceIdFor(login, engine), speakableName('', login, settings.nicknames));
}

// ---------------------------------------------------------------------------
// Chatter dialog: a click on a name in chat
// ---------------------------------------------------------------------------

const chatterDialog = $('#chatterDialog');
const chatter = { login: '', displayName: '', opener: null, entry: null };

const ignoredList = () => settings.ignoredUsers.toLowerCase().split(/[\s,]+/).filter(Boolean);
const isIgnored = (login) => ignoredList().includes(login);

function setIgnored(login, on) {
  const others = settings.ignoredUsers.split(/[\s,]+/).filter((u) => u && u.toLowerCase() !== login);
  settings.ignoredUsers = (on ? [...others, login] : others).join(', ');
  $('#ignoredUsers').value = settings.ignoredUsers;
  saveSettings();
  if (!on) return;
  // What they already wrote and is still waiting, or being read, goes too.
  for (const entry of [reader.current, ...reader.queue]) {
    if (entry && entry.login === login && entry.kind === 'chat') removeFromQueue(entry, 'filtered', 'ignored');
  }
}

function renderChatterIgnore(confirming = false) {
  const ignored = isIgnored(chatter.login);
  $('#chatterIgnoreBtn').hidden = ignored || confirming;
  $('#chatterIgnoreConfirm').hidden = !confirming;
  $('#chatterIgnored').hidden = !ignored;
  $('#chatterIgnoreText').textContent = `Stop reading everything ${chatter.displayName} writes? You can undo this here or under Filters.`;
}

function renderChatterVoices() {
  const engine = activeEngine();
  const current = voiceIdFor(chatter.login, engine);
  $('#chatterVoice').replaceChildren(...voicePool(engine).map((id) => el('option', { value: id, selected: id === current }, voiceName(engine, id))));
}

// What the dialog would make the reader say right now, saved or not.
function chatterSpokenName() {
  const typed = $('#chatterNick').value.trim();
  return speakableName(chatter.displayName, chatter.login, typed ? { [chatter.login]: typed } : {});
}

function hearChatter() {
  const engine = activeEngine();
  if (!engine.preview) return;
  previewVoice(engine, $('#chatterVoice').value, `${chatterSpokenName()}: this is how I sound.`);
}

function saveChatterNickname() {
  const typed = $('#chatterNick').value.trim();
  if (typed !== (settings.nicknames[chatter.login] || '')) setNickname(chatter.login, typed);
}

function openChatter(entry, opener) {
  if (!entry.login) return;
  Object.assign(chatter, { login: entry.login, displayName: entry.displayName || entry.login, opener, entry });
  $('#chatterTitle').textContent = chatter.displayName;
  $('#chatterNick').value = settings.nicknames[chatter.login] || '';
  renderChatterVoices();
  renderChatterIgnore();
  renderChatterExtra();
  chatterDialog.showModal();
  $('#chatterNick').focus();
  $('#chatterNick').select();
}

// In the desktop app the bot adds the viewer's points, watch time and
// moderation buttons.
function renderChatterExtra() {
  const box = $('#chatterExtra');
  let part = null;
  try { part = host.chatterExtra ? host.chatterExtra(chatter.entry) : null; } catch (err) { console.error(err); }
  box.replaceChildren(...(part ? [part] : []));
  box.hidden = !part;
}

$('#chatterForm').addEventListener('submit', (e) => { e.preventDefault(); chatterDialog.close(); });
$('#chatterClose').addEventListener('click', () => chatterDialog.close());
chatterDialog.addEventListener('click', (e) => { if (e.target === chatterDialog) chatterDialog.close(); });
chatterDialog.addEventListener('close', () => {
  saveChatterNickname();
  const opener = chatter.opener;
  chatter.opener = null;
  if (opener && opener.isConnected) opener.focus();
});
$('#chatterNick').addEventListener('change', saveChatterNickname);
$('#chatterVoice').addEventListener('change', (e) => {
  const engine = activeEngine();
  setUserVoice(chatter.login, engine, e.target.value);
  hearChatter();
});
$('#chatterHear').addEventListener('click', hearChatter);
$('#chatterIgnoreBtn').addEventListener('click', () => {
  renderChatterIgnore(true);
  $('#chatterIgnoreNo').focus();
});
$('#chatterIgnoreNo').addEventListener('click', () => {
  renderChatterIgnore();
  $('#chatterIgnoreBtn').focus();
});
$('#chatterIgnoreYes').addEventListener('click', () => {
  setIgnored(chatter.login, true);
  renderChatterIgnore();
  announce(`${chatter.displayName} is now ignored`);
  $('#chatterUnignore').focus();
});
$('#chatterUnignore').addEventListener('click', () => {
  setIgnored(chatter.login, false);
  renderChatterIgnore();
  announce(`${chatter.displayName} is no longer ignored`);
  $('#chatterIgnoreBtn').focus();
});

$('#nicknameForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const userInput = $('#nickUser');
  const nameInput = $('#nickName');
  const login = normalizeLogin(userInput.value);
  userInput.setCustomValidity('');
  if (!/^[a-z0-9_]{1,25}$/.test(login)) {
    userInput.setCustomValidity('Enter a Twitch username (letters, numbers, underscores)');
    userInput.reportValidity();
    return;
  }
  if (!nameInput.value.trim()) {
    nameInput.focus();
    return;
  }
  setNickname(login, nameInput.value);
  userInput.value = '';
  nameInput.value = '';
  userInput.focus();
});
$('#nickUser').addEventListener('input', (e) => e.target.setCustomValidity(''));

// ---------------------------------------------------------------------------
// Keyboard shortcuts and media keys
// ---------------------------------------------------------------------------

function keyLabel(binding) {
  if (!binding || !binding.code) return 'none';
  const parts = [];
  if (binding.ctrl) parts.push(IS_MAC ? '⌃' : 'Ctrl');
  if (binding.alt) parts.push(IS_MAC ? '⌥' : 'Alt');
  if (binding.shift) parts.push(IS_MAC ? '⇧' : 'Shift');
  if (binding.meta) parts.push(IS_MAC ? '⌘' : 'Win');
  const key = binding.code
    .replace(/^Key/, '')
    .replace(/^Digit/, '')
    .replace(/^Numpad/, 'Num ')
    .replace(/^Arrow/, '')
    .replace('Backquote', '`')
    .replace('Space', 'Space');
  parts.push(key);
  return parts.join(IS_MAC ? '' : '+');
}

function renderKeyLabels() {
  for (const node of $$('[data-key-label]')) node.textContent = keyLabel(settings.keys[node.dataset.keyLabel]);
  for (const node of $$('[data-bind]')) {
    const what = node.closest('.keybind').querySelector('span').textContent.trim();
    const label = keyLabel(settings.keys[node.dataset.bind]);
    node.setAttribute('aria-label', `${what}: ${label}. Activate, then press the keys you want.`);
    if (!node.classList.contains('capturing')) node.textContent = label;
  }
}

let capturing = null;

function startCapture(button) {
  if (capturing) capturing.classList.remove('capturing');
  capturing = button;
  button.classList.add('capturing');
  button.textContent = 'Press keys…';
}

function stopCapture() {
  if (!capturing) return;
  capturing.classList.remove('capturing');
  capturing = null;
  renderKeyLabels();
}

const MODIFIER_CODES = /^(Shift|Control|Alt|Meta|OS)(Left|Right)?$/;

window.addEventListener('keydown', (e) => {
  if (capturing) {
    e.preventDefault();
    e.stopPropagation();
    if (e.code === 'Escape') return stopCapture();
    if (MODIFIER_CODES.test(e.code)) return;
    const action = capturing.dataset.bind;
    // Backspace and Delete clear a shortcut rather than becoming one.
    settings.keys[action] = (e.code === 'Backspace' || e.code === 'Delete')
      ? null
      : { code: e.code, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey };
    saveSettings();
    stopCapture();
    syncGlobalHotkeys();
    renderNow();
    return;
  }
  if (e.repeat) return;

  const matches = (b) => b && b.code === e.code && !!b.ctrl === e.ctrlKey && !!b.alt === e.altKey && !!b.shift === e.shiftKey && !!b.meta === e.metaKey;
  const typing = e.target.closest && e.target.closest('input:not([type="checkbox"]):not([type="radio"]):not([type="range"]), textarea, select, [contenteditable]');

  for (const [action, binding] of [...Object.entries(settings.keys), ...hostHotkeys()]) {
    if (!matches(binding) || !actionEnabled(action)) continue;
    if (typing && !(binding.ctrl || binding.alt || binding.meta)) return;
    // In the desktop app the OS already delivered this one, from whichever
    // window had focus; acting on it here too would run it twice.
    if (globalHotkeys.registered[action]) return;
    e.preventDefault();
    runAction(action);
    return;
  }
}, true);

// Chrome/Edge route hardware media keys to a page that is playing media, even
// when the browser is in the background. A near-silent looping track keeps the
// page eligible; the ⏯ key then toggles pause.
const mediaKeys = { audio: null };

function makeQuietLoop() {
  const rate = 8000;
  const samples = new Float32Array(rate * 2);
  for (let i = 0; i < samples.length; i++) samples[i] = (Math.random() - 0.5) * 0.0004;
  return URL.createObjectURL(floatToWav(samples, rate));
}

function enableMediaKeys(on) {
  // The desktop app takes the ⏯ key from the OS, together with the other
  // global hotkeys, so none of the trickery below is needed there.
  if (desktop) return syncGlobalHotkeys();
  if (!('mediaSession' in navigator)) return;
  const session = navigator.mediaSession;
  if (on) {
    if (!mediaKeys.audio) {
      mediaKeys.audio = new Audio(makeQuietLoop());
      mediaKeys.audio.loop = true;
    }
    mediaKeys.audio.play().catch(() => {});
    const handlers = {
      play: () => setPaused(false),
      pause: () => setPaused(true),
      stop: () => setPaused(true),
      nexttrack: () => skipCurrent(),
      previoustrack: () => runAction('replay'),
    };
    // Browsers throw for actions they don't support.
    for (const [action, handler] of Object.entries(handlers)) {
      try { session.setActionHandler(action, handler); } catch {}
    }
    updateMediaSession();
  } else {
    if (mediaKeys.audio) mediaKeys.audio.pause();
    for (const action of ['play', 'pause', 'stop', 'nexttrack', 'previoustrack']) {
      try { session.setActionHandler(action, null); } catch {}
    }
    session.metadata = null;
    session.playbackState = 'none';
  }
}

function updateMediaSession() {
  if (!settings.mediaKeys || !('mediaSession' in navigator)) return;
  if (typeof MediaMetadata === 'function') navigator.mediaSession.metadata = new MediaMetadata({
    title: reader.paused ? 'Chat reading paused' : replay.active ? 'Replaying chat' : 'Reading chat',
    artist: chatsSummary() || 'Chat Reader',
  });
  navigator.mediaSession.playbackState = reader.paused ? 'paused' : 'playing';
}

// ---------------------------------------------------------------------------
// Desktop app: hotkeys the OS delivers from whichever window has focus
// ---------------------------------------------------------------------------

function syncGlobalHotkeys() {
  if (!desktop) return;
  desktop.applyHotkeys({
    enabled: settings.globalHotkeys,
    // A switched-off action doesn't take its keys from other apps.
    bindings: Object.fromEntries([...Object.entries(settings.keys).filter(([action]) => actionEnabled(action)), ...hostHotkeys()]),
    media: settings.mediaKeys,
    mediaReplay: settings.replay,
  }).then((result) => {
    globalHotkeys.registered = result.registered || {};
    globalHotkeys.problems = result.problems || {};
    globalHotkeys.mediaAccess = result.mediaAccess !== false;
    renderHotkeyState();
  }).catch(() => {});
}

function renderHotkeyState() {
  if (!desktop) return;

  for (const button of $$('[data-bind]')) {
    if (!actionEnabled(button.dataset.bind)) continue;
    const problem = settings.globalHotkeys ? globalHotkeys.problems[button.dataset.bind] : null;
    const note = button.closest('.keybind').querySelector('.hotkey-note');
    note.textContent = problem || '';
    note.hidden = !problem;
    button.classList.toggle('conflict', !!problem);
  }

  const MEDIA_LABELS = { 'media:pause': '⏯', 'media:skip': '⏭', 'media:replay': '⏮' };
  const taken = Object.keys(globalHotkeys.registered)
    .map((action) => MEDIA_LABELS[action] || keyLabel(settings.keys[action]))
    .filter((label, i, all) => all.indexOf(label) === i);

  $('#hotkeyStatus').textContent = !settings.globalHotkeys
    ? `Shortcuts only work while this window is focused.${taken.length ? ` ${taken.join(' and ')} still work everywhere.` : ''}`
    : !taken.length
      ? 'Nothing is bound, so no keys are taken from other apps.'
      : `Working in every app: ${taken.join(', ')}.`;

  $('#accessibilityNote').hidden = !(settings.mediaKeys && !globalHotkeys.mediaAccess);
}

function startDesktop() {
  if (!desktop) return;
  document.body.classList.add('is-desktop');
  if (desktop.version) $('#desktopVersion').textContent = `Desktop app ${desktop.version}`;

  desktop.onAction(runAction);

  $('#globalHotkeys').addEventListener('change', (e) => {
    settings.globalHotkeys = e.target.checked;
    saveSettings();
    syncGlobalHotkeys();
  });
  $('#accessibilityBtn').addEventListener('click', () => {
    desktop.requestAccessibility().then(syncGlobalHotkeys);
  });

  syncGlobalHotkeys();
}

// ---------------------------------------------------------------------------
// Backup: writing the settings to a file and reading one back
// ---------------------------------------------------------------------------

const BACKUP_KIND = 'chat-reader-settings';
const BACKUP_VERSION = 1;
// A Twitch login, or a YouTube or TikTok chatter with its prefix (see js/sources.js).
const LOGIN_RE = /^(?:[a-z0-9_]{1,25}|tt:[a-z0-9_.]{2,24}|yt:[\p{L}\p{N}_.\-·]{3,30})$/u;

function backupStatus(text) {
  $('#backupStatus').textContent = text || '';
}

function settingsFileName() {
  return `chat-reader-settings-${new Date().toISOString().slice(0, 10)}.json`;
}

function settingsFileText() {
  return JSON.stringify({
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    savedAt: new Date().toISOString(),
    settings,
    // The desktop app's bot goes in the same file. The website has none.
    ...(host.backupExtra ? { bot: host.backupExtra() } : {}),
  }, null, 2);
}

async function exportSettings() {
  const text = settingsFileText();
  const name = settingsFileName();
  // The desktop app can show a real save dialog; a browser can only download.
  if (desktop && desktop.saveFile) {
    const result = await desktop.saveFile(name, text);
    if (result.canceled) return;
    backupStatus(result.error ? `Couldn’t save the file: ${result.error}` : `Saved to ${result.path}.`);
    return;
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = el('a', { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  backupStatus(`Saved ${name} with your downloads.`);
}

async function importSettings() {
  if (desktop && desktop.openFile) {
    const result = await desktop.openFile();
    if (result.canceled) return;
    if (result.error) {
      backupStatus(`Couldn’t open the file: ${result.error}`);
      return;
    }
    applyImportedText(result.text, result.name);
    return;
  }
  $('#importFile').click();
}

async function readImportedFile(file) {
  try {
    applyImportedText(await file.text(), file.name);
  } catch (err) {
    backupStatus(`Couldn’t read that file: ${err.message}`);
  }
}

function applyImportedText(text, name) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    backupStatus('That isn’t a Chat Reader backup: the file isn’t valid JSON.');
    return;
  }
  // Both a file written here and a bare settings object are accepted.
  const raw = data && typeof data === 'object' && data.settings && typeof data.settings === 'object' ? data.settings : data;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    backupStatus('That file doesn’t hold any settings.');
    return;
  }
  // The desktop app's bot, saved in the same file (or a file of the bot's own).
  const botPart = host.restoreExtra && data && (data.bot || (data.kind === 'chat-reader-bot' ? data : null));
  const kept = importReaderSettings(raw);
  const botLoaded = botPart ? host.restoreExtra(botPart) : false;
  if (!kept && !botLoaded) {
    backupStatus(botPart ? 'Nothing changed.' : 'Nothing in that file looked like a Chat Reader setting, so nothing changed.');
    return;
  }
  const what = [kept ? `${kept} setting${kept === 1 ? '' : 's'}` : '', botLoaded ? 'the bot setup' : ''].filter(Boolean).join(' and ');
  backupStatus(`Loaded ${what}${name ? ` from ${name}` : ''}.`);
}

// Takes over every recognised reader setting in `raw`. Returns how many.
function importReaderSettings(raw) {
  const { clean, kept } = sanitizeSettings(raw);
  if (!kept) return 0;
  Object.assign(settings, clean);
  saveSettings();
  applyAllSettings();
  return kept;
}

function resetSettings() {
  const sure = confirm('Put every setting back to the way it started? Nicknames, chosen voices and shortcuts are cleared too. This can’t be undone.');
  if (!sure) return;
  Object.assign(settings, cloneDefaults());
  saveSettings();
  applyAllSettings();
  backupStatus('Every setting is back to its default.');
}

// A file can hold anything, so each setting is only taken over when it still
// looks like what it should be. Anything else keeps the value it has.
const accept = {
  bool: (v) => (typeof v === 'boolean' ? v : undefined),
  oneOf: (...allowed) => (v) => (allowed.includes(v) ? v : undefined),
  int: (min, max) => (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : undefined),
  number: (min, max) => (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : undefined),
  text: (max) => (v) => (typeof v === 'string' && v.length <= max ? v : undefined),
  ids: (max, allowed) => (v) => (Array.isArray(v)
    ? v.filter((x) => typeof x === 'string' && x.length <= 160 && (!allowed || allowed.has(x))).slice(0, max)
    : undefined),
  logins: (max, value) => (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
    const out = {};
    for (const [key, raw] of Object.entries(v).slice(0, max)) {
      const login = normalizeLogin(key);
      const clean = value(raw);
      if (LOGIN_RE.test(login) && clean !== undefined && clean !== '') out[login] = clean;
    }
    return out;
  },
};

function acceptKeys(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out = { ...DEFAULTS.keys };
  for (const action of Object.keys(DEFAULTS.keys)) {
    if (!(action in value)) continue;
    const binding = value[action];
    if (binding === null) { out[action] = null; continue; }   // cleared on purpose
    if (!binding || typeof binding !== 'object') continue;
    if (typeof binding.code !== 'string' || !/^[A-Za-z0-9]{1,24}$/.test(binding.code)) continue;
    out[action] = { code: binding.code, ctrl: !!binding.ctrl, alt: !!binding.alt, shift: !!binding.shift, meta: !!binding.meta };
  }
  return out;
}

function acceptUserVoices(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const perEngine = (v) => accept.logins(2000, accept.text(160))(v) || {};
  return { kokoro: perEngine(value.kokoro), system: perEngine(value.system) };
}

function acceptRewards(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out = {};
  for (const [id, reward] of Object.entries(value).slice(0, 100)) {
    if (!/^[0-9a-f-]{8,64}$/i.test(id) || !reward || typeof reward !== 'object') continue;
    if (!(reward.action in REWARD_ACTIONS)) continue;
    const name = accept.text(60)(reward.name);
    out[id.toLowerCase()] = { name: (name && name.trim()) || REWARD_ACTIONS[reward.action].name, action: reward.action };
  }
  return out;
}

const SETTING_CHECKS = {
  channel: (v) => (typeof v === 'string' ? (TwitchChat.normalizeChannel(v) || '') : undefined),
  sources: acceptChatList,
  presets: (v) => (Array.isArray(v)
    ? v.filter((p) => p && typeof p.name === 'string' && p.name.trim() && p.name.length <= 60)
      .map((p) => ({ name: p.name.trim(), sources: acceptChatList(p.sources) || [] }))
      .filter((p) => p.sources.length)
      .slice(0, MAX_PRESETS)
    : undefined),
  theme: accept.oneOf('auto', 'light', 'dark'),
  uiScale: (v) => {
    const n = accept.int(UI_SCALES[0], UI_SCALES[UI_SCALES.length - 1])(v);
    if (n === undefined) return undefined;
    return UI_SCALES.reduce((best, scale) => (Math.abs(scale - n) < Math.abs(best - n) ? scale : best));
  },
  highContrast: accept.bool,
  reduceMotion: accept.bool,
  announce: accept.bool,
  engine: accept.oneOf('kokoro', 'system'),
  kokoroMode: accept.oneOf('auto', 'webgpu', 'wasm'),
  kokoroVoices: accept.ids(KOKORO_VOICES.length, new Set(KOKORO_VOICES.map((v) => v.id))),
  // Voice ids differ from computer to computer, so they're kept as they come
  // and filtered against what exists when the pool is built.
  systemVoices: (v) => (v === null ? null : accept.ids(500)(v)),
  systemLang: (v) => (typeof v === 'string' && /^([a-z]{2}|all)$/i.test(v) ? v.toLowerCase() : undefined),
  varyVoices: accept.bool,
  volume: accept.int(0, 100),
  rate: accept.number(0.6, 2),
  nameFormat: accept.oneOf('colon', 'says', 'none'),
  collapseNames: accept.bool,
  quoteParent: accept.bool,
  readEvents: accept.bool,
  readEmojis: accept.bool,
  emoteMode: accept.oneOf('skip-all', 'skip-twitch', 'read'),
  readEmoteOnly: accept.bool,
  maxLength: accept.int(20, 500),
  catchUp: accept.int(0, 500),
  skipCommands: accept.bool,
  skipLinks: accept.bool,
  ignoredUsers: accept.text(4000),
  replay: accept.bool,
  replayAnnounce: accept.bool,
  replayStartText: accept.text(200),
  replayEndText: accept.text(200),
  keys: acceptKeys,
  mediaKeys: accept.bool,
  globalHotkeys: accept.bool,
  userVoices: acceptUserVoices,
  nicknames: accept.logins(500, accept.text(60)),
  cheerAnnounce: accept.bool,
  cheerPriority: accept.int(0, 1000000),
  cheerEffects: accept.int(0, 1000000),
  highlightPriority: accept.bool,
  voiceCommand: (v) => (typeof v === 'string' && v.length <= 60 ? cleanCommand(v) : undefined),
  voiceCommandWho: accept.oneOf('everyone', 'subs', 'vips', 'mods', 'off'),
  voiceConfirm: accept.bool,
  modCommand: (v) => (typeof v === 'string' && v.length <= 60 ? cleanCommand(v) : undefined),
  modCommandWho: accept.oneOf('mods', 'vips', 'off'),
  rewards: acceptRewards,
  sharedChat: accept.logins(200, (v) => (v && typeof v === 'object' && SHARED_MODES.includes(v.mode)
    ? { mode: v.mode, muted: (Array.isArray(v.muted) ? v.muted : []).filter((id) => typeof id === 'string' && /^\d{1,20}$/.test(id)).slice(0, 50) }
    : undefined)),
};

function acceptChatList(value) {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item) => item && typeof item === 'object' && Object.hasOwn(NORMALIZE, item.platform)
      && typeof item.input === 'string' && item.input.length <= 300 && NORMALIZE[item.platform](item.input))
    .slice(0, MAX_CHATS)
    .map((item) => ({ platform: item.platform, input: item.input.trim() }));
}

function sanitizeSettings(raw) {
  const clean = {};
  let kept = 0;
  for (const [key, validate] of Object.entries(SETTING_CHECKS)) {
    if (!(key in raw)) continue;
    const value = validate(raw[key]);
    if (value === undefined) continue;
    clean[key] = value;
    kept++;
  }
  // A file from before several chats could be read has one Twitch channel.
  if ('channel' in clean) {
    if (!clean.sources && clean.channel) clean.sources = [{ platform: 'twitch', input: clean.channel }];
    delete clean.channel;
  }
  return { clean, kept };
}

// Put the settings into the controls. The one place that knows how, so
// starting up, importing a file and resetting all go through it.
function syncControlsFromSettings() {
  setChatList(settings.sources);
  $('#theme').value = settings.theme;
  $('#uiScale').value = String(settings.uiScale);
  $('#volume').value = settings.volume;
  $('#volume').setAttribute('aria-valuetext', `${settings.volume} percent`);
  $('#volumeOut').textContent = `${settings.volume}%`;
  renderRate();
  $('#kokoroMode').value = settings.kokoroMode;
  $('#nameFormat').value = settings.nameFormat;
  $('#emoteMode').value = settings.emoteMode;
  $('#ignoredUsers').value = settings.ignoredUsers;
  for (const key of NUMBER_SETTINGS) $(`#${key}`).value = settings[key];
  for (const key of TEXT_SETTINGS) $(`#${key}`).value = settings[key];
  for (const key of ['voiceCommand', 'modCommand', 'voiceCommandWho', 'modCommandWho']) $(`#${key}`).value = settings[key];
  for (const key of [...CHECKBOX_SETTINGS, 'readEmoteOnly', 'replay', 'mediaKeys', 'globalHotkeys']) {
    $(`#${key}`).checked = !!settings[key];
  }
}

function renderRate() {
  const rate = Number(settings.rate);
  $('#rate').value = rate;
  $('#rate').setAttribute('aria-valuetext', `${rate.toFixed(2)} times normal speed`);
  $('#rateOut').textContent = `${rate.toFixed(2)}×`;
}

// Everything that has to happen when the settings change wholesale.
function applyAllSettings() {
  applyAppearance();
  syncControlsFromSettings();
  renderLanguageOptions();
  renderEngineUI();
  renderKeyLabels();
  renderNicknames();
  renderRewards();
  renderCommandHints();
  renderEmoteStatus();
  loadThirdPartyEmotes();
  refreshSpeechBodies();
  refreshVoiceTags();
  applyReplaySetting();
  renderNow();
  syncGlobalHotkeys();
  enableMediaKeys(settings.mediaKeys);
}

// ---------------------------------------------------------------------------
// Wiring up controls
// ---------------------------------------------------------------------------

function userGesture() {
  // Audio playback needs a user gesture in most browsers; use it to prime both.
  kokoroEngine.ensureAudio();
  if (kokoroEngine.ctx.state === 'suspended' && !reader.paused) kokoroEngine.ctx.resume();
  if (settings.mediaKeys && !desktop) enableMediaKeys(true);
  if (settings.engine === 'kokoro' && kokoroEngine.state === 'unloaded') loadKokoro();
}

// ---------------------------------------------------------------------------
// The chat fields in the top bar
// ---------------------------------------------------------------------------

// The list as it's saved and put into presets: what's typed, in order.
const chatListOf = (list) => list.filter((c) => c.input.trim()).map((c) => ({ platform: c.platform, input: c.input.trim() }));

function saveChatList() {
  settings.sources = chatListOf(chats);
  saveSettings();
  renderPresets();
}

function chatField(chat) {
  if (chat.field) return chat.field;
  const name = PLATFORMS[chat.platform].name;
  const inputId = `chat-${chat.id}`;
  chat.inputEl = el('input', {
    id: inputId,
    placeholder: PLACEHOLDERS[chat.platform],
    spellcheck: 'false',
    oninput: (e) => {
      chat.input = e.target.value;
      saveChatList();
      renderConnectButton();
    },
  });
  chat.inputEl.value = chat.input;
  chat.removeBtn = el('button', {
    type: 'button',
    class: 'x source-remove',
    title: `Stop reading this ${name} chat`,
    'aria-label': `Remove this ${name} chat`,
    onclick: () => removeChat(chat),
  }, '×');
  if (chat.platform === 'twitch') {
    chat.sharedBtn = el('button', {
      type: 'button',
      class: 'source-collab',
      hidden: true,
      'aria-haspopup': 'dialog',
      'aria-expanded': 'false',
      onclick: () => (chat.sharedPanel && !chat.sharedPanel.hidden ? closeSharedPanel(chat) : openSharedPanel(chat)),
    });
  }
  chat.field = el('div', { class: 'source-field', 'data-platform': chat.platform, 'data-state': chat.state },
    el('label', { class: 'source-tag', for: inputId }, el('span', { class: 'dot', 'aria-hidden': 'true' }), name),
    chat.inputEl,
    chat.sharedBtn || null,
    chat.removeBtn,
  );
  renderSharedButton(chat);
  return chat.field;
}

function renderChatFields() {
  $('#chatFields').replaceChildren(...chats.map(chatField));
  // The last field can't go: there's always somewhere to type a channel.
  for (const chat of chats) chat.removeBtn.hidden = chats.length < 2;
  $('#sourceAdd').hidden = chats.length >= MAX_CHATS;
  for (const item of $$('[data-add]')) item.hidden = !addablePlatforms().includes(item.dataset.add);
  renderConnectButton();
  renderStatusLine();
}

// Swap the whole list for another (a preset, a loaded backup). A chat that is
// in both keeps running instead of reconnecting; the rest are stopped.
function setChatList(list, { connect = false } = {}) {
  const sameTarget = (chat, item) => chat.platform === item.platform
    && (NORMALIZE[item.platform](chat.input) || chat.input.trim()) === (NORMALIZE[item.platform](item.input) || item.input.trim());
  const pool = [...chats];
  const next = [];
  for (const item of list.slice(0, MAX_CHATS)) {
    if (!NORMALIZE[item.platform]) continue;
    const i = pool.findIndex((chat) => sameTarget(chat, item));
    const chat = i === -1 ? createChat(item.platform, item.input) : pool.splice(i, 1)[0];
    chat.input = item.input;
    if (chat.inputEl) chat.inputEl.value = item.input;
    next.push(chat);
  }
  for (const chat of pool) dropChat(chat);
  if (!next.length) next.push(createChat('twitch'));
  chats.splice(0, chats.length, ...next);
  saveChatList();
  renderChatFields();
  renderNow();
  if (connect) connectChats({ toggle: false });
}

function dropChat(chat) {
  if (isActive(chat)) chat.client.disconnect(true);
  if (chat.client.dispose) chat.client.dispose();
}

function addChat(platform) {
  closeAddMenu();
  const chat = createChat(platform);
  chats.push(chat);
  renderChatFields();
  chat.inputEl.focus();
}

function removeChat(chat) {
  const i = chats.indexOf(chat);
  if (i === -1 || chats.length < 2) return;
  dropChat(chat);
  chats.splice(i, 1);
  saveChatList();
  renderChatFields();
  renderNow();
  (chats[i] || chats[i - 1]).inputEl.focus();
}

// What pressing Connect would do to each chat: start one whose field was
// filled in or changed, stop one whose field was emptied.
function pendingChanges() {
  const seen = new Set();
  const changes = [];
  for (const chat of chats) {
    const raw = chat.input.trim();
    const target = raw ? NORMALIZE[chat.platform](raw) : null;
    if (raw && !target) {
      changes.push({ chat, invalid: INVALID_TEXT[chat.platform] });
      continue;
    }
    const key = `${chat.platform}:${(target || '').toLowerCase()}`;
    if (target && seen.has(key)) {
      changes.push({ chat, invalid: 'That one is already in the list' });
      continue;
    }
    if (target) seen.add(key);
    const active = isActive(chat);
    if (target && (!active || chat.client.channel !== target)) changes.push({ chat, target });
    else if (!target && active) changes.push({ chat, stop: true });
  }
  return changes;
}

// "Disconnect" only when everything typed is already being read; after an
// edit the same button applies it instead.
function renderConnectButton() {
  const disconnect = activeChats().length > 0 && pendingChanges().length === 0;
  $('#connectBtn').textContent = disconnect ? 'Disconnect' : 'Connect';
  $('#connectBtn').classList.toggle('primary', !disconnect);
}

// `toggle`: with nothing to change, disconnect everything (the button).
// Switching to a preset only ever connects.
function connectChats({ toggle = true } = {}) {
  const changes = pendingChanges();
  const invalid = changes.find((c) => c.invalid);
  if (invalid) {
    renderConnection(invalid.chat, 'error', invalid.invalid);
    invalid.chat.inputEl.focus();
    return;
  }
  // An emptied field also takes back the error it showed.
  for (const chat of chats) if (!chat.input.trim() && chat.state === 'error') renderConnection(chat, 'idle', '');
  if (!changes.length) {
    const active = activeChats();
    if (!toggle) return;
    if (active.length) for (const chat of active) chat.client.disconnect();
    else renderConnection(chats[0], 'error', 'Enter a channel to read');
    return;
  }
  userGesture();
  for (const change of changes) {
    if (change.stop) {
      change.chat.client.disconnect();
      continue;
    }
    if (change.chat.platform === 'twitch') {
      resetShared(change.chat);
      change.chat.input = change.target;
      change.chat.inputEl.value = change.target;
    }
    change.chat.client.connect(change.target);
  }
  saveChatList();
  updateChannelParam();
}

// ?channel= in the address is the first Twitch channel, so a bookmark or a
// shared link opens it.
function updateChannelParam() {
  const twitch = chats.find((c) => c.platform === 'twitch' && c.client.channel);
  const url = new URL(location.href);
  if (twitch) url.searchParams.set('channel', twitch.client.channel);
  else url.searchParams.delete('channel');
  history.replaceState(null, '', url);
}

$('#connectForm').addEventListener('submit', (e) => {
  e.preventDefault();
  connectChats();
});

// The + button: another Twitch channel, a YouTube stream or a TikTok live.
// In a browser, where only Twitch is possible, it adds a Twitch field.
function openAddMenu() {
  const platforms = addablePlatforms();
  if (platforms.length === 1) { addChat(platforms[0]); return; }
  $('#sourceAddMenu').hidden = false;
  $('#sourceAddBtn').setAttribute('aria-expanded', 'true');
  $('#sourceAddMenu [data-add]:not([hidden])').focus();
}

function closeAddMenu({ focus = false } = {}) {
  if ($('#sourceAddMenu').hidden) return;
  $('#sourceAddMenu').hidden = true;
  $('#sourceAddBtn').setAttribute('aria-expanded', 'false');
  if (focus) $('#sourceAddBtn').focus();
}

// Arrow keys between the items of a small menu, Esc to close it.
function menuKeys(menu, close) {
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('[role="menuitem"]:not([hidden])')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); close({ focus: true }); return; }
    const next = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[e.key];
    if (next === undefined || !items.length) return;
    e.preventDefault();
    items[(next + items.length) % items.length].focus();
  });
}

$('#sourceAddBtn').addEventListener('click', () => ($('#sourceAddMenu').hidden ? openAddMenu() : closeAddMenu()));
for (const item of $$('[data-add]')) item.addEventListener('click', () => addChat(item.dataset.add));
menuKeys($('#sourceAddMenu'), closeAddMenu);

// ---------------------------------------------------------------------------
// Presets: saved lists of chats, to switch streamers in one click
// ---------------------------------------------------------------------------

const MAX_PRESETS = 50;
const targetKey = (item) => `${item.platform}:${(NORMALIZE[item.platform](item.input) || item.input).toLowerCase()}`;
const sameChats = (a, b) => a.length === b.length && a.every((item, i) => targetKey(item) === targetKey(b[i]));
const currentPreset = () => {
  const now = chatListOf(chats);
  return now.length ? settings.presets.find((p) => sameChats(p.sources, now)) : null;
};

// "Twitch #shroud · YouTube @shroud".
const describeChats = (list) => list
  .map((item) => `${PLATFORMS[item.platform].name} ${sourceLabel(item.platform, NORMALIZE[item.platform](item.input) || item.input)}`)
  .join(' · ');

function renderPresets() {
  const current = currentPreset();
  $('#presetsLabel').textContent = current ? current.name : 'Presets';
  $('#presetsBtn').setAttribute('aria-label', current ? `Presets: ${current.name} is open` : 'Presets');
  $('#presetList').replaceChildren(...settings.presets.map((preset) => el('li', {},
    el('button', {
      type: 'button',
      class: 'preset-pick',
      'aria-current': preset === current ? 'true' : null,
      onclick: () => applyPreset(preset),
    },
    el('span', { class: 'preset-name' }, preset.name),
    el('span', { class: 'preset-what' }, describeChats(preset.sources))),
    el('button', {
      type: 'button',
      class: 'x',
      title: 'Delete this preset',
      'aria-label': `Delete the preset “${preset.name}”`,
      onclick: () => deletePreset(preset),
    }, '×'),
  )));
  $('#presetEmpty').hidden = settings.presets.length > 0;
  renderPresetSave();
}

function renderPresetSave() {
  const name = $('#presetName').value.trim().toLowerCase();
  const exists = name && settings.presets.some((p) => p.name.toLowerCase() === name);
  $('#presetSaveBtn').textContent = exists ? 'Update' : 'Save';
}

function openPresets() {
  const current = currentPreset();
  const list = chatListOf(chats);
  $('#presetName').value = current ? current.name : list.length ? sourceLabel(list[0].platform, NORMALIZE[list[0].platform](list[0].input)).replace(/^[#@]/, '') : '';
  $('#presetStatus').textContent = '';
  renderPresets();
  $('#presetsPanel').hidden = false;
  $('#presetsBtn').setAttribute('aria-expanded', 'true');
  ($('#presetList .preset-pick') || $('#presetName')).focus();
}

function closePresets({ focus = false } = {}) {
  if ($('#presetsPanel').hidden) return;
  $('#presetsPanel').hidden = true;
  $('#presetsBtn').setAttribute('aria-expanded', 'false');
  if (focus) $('#presetsBtn').focus();
}

function savePreset() {
  const sources = chatListOf(chats);
  if (!sources.length) {
    $('#presetStatus').textContent = 'Type a channel into a field first: a preset saves the chats in the top bar.';
    return;
  }
  const name = $('#presetName').value.trim().slice(0, 60) || describeChats(sources).slice(0, 60);
  const existing = settings.presets.find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    existing.sources = sources;
  } else {
    if (settings.presets.length >= MAX_PRESETS) {
      $('#presetStatus').textContent = `That’s ${MAX_PRESETS} presets already. Delete one first.`;
      return;
    }
    settings.presets.push({ name, sources });
  }
  saveSettings();
  renderPresets();
  $('#presetStatus').textContent = `${existing ? 'Updated' : 'Saved'} “${name}”.`;
}

function applyPreset(preset) {
  closePresets({ focus: true });
  setChatList(preset.sources, { connect: true });
  announce(`Switched to ${preset.name}`);
}

function deletePreset(preset) {
  if (!confirm(`Delete the preset “${preset.name}”? The chats it opens aren’t affected.`)) return;
  settings.presets = settings.presets.filter((p) => p !== preset);
  saveSettings();
  renderPresets();
  $('#presetName').focus();
}

$('#presetsBtn').addEventListener('click', () => ($('#presetsPanel').hidden ? openPresets() : closePresets()));
$('#presetForm').addEventListener('submit', (e) => { e.preventDefault(); savePreset(); });
$('#presetName').addEventListener('input', renderPresetSave);
$('#presetsPanel').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closePresets({ focus: true }); }
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#sourceAdd')) closeAddMenu();
  // A preset's × asks first, and the panel has to survive that question.
  if (!e.target.closest('#presets') && e.target.isConnected) closePresets();
});

$('#pauseBtn').addEventListener('click', () => { userGesture(); togglePause(); });
$('#skipBtn').addEventListener('click', skipCurrent);
$('#clearBtn').addEventListener('click', clearQueue);
$('#replayBtn').addEventListener('click', () => runAction('replay'));
$('#replayStop').addEventListener('click', stopReplay);

$('#volume').addEventListener('input', (e) => setVolume(Number(e.target.value), { live: true }));
$('#volume').addEventListener('change', () => {
  if (reader.controller && reader.current.engine === systemEngine) reader.controller.volumeChanged();
});

$('#rate').addEventListener('input', (e) => setRate(Number(e.target.value)));

for (const radio of $$('input[name="engine"]')) {
  radio.addEventListener('change', () => {
    settings.engine = radio.value;
    saveSettings();
    renderEngineUI();
    if (settings.engine === 'kokoro' && kokoroEngine.state === 'unloaded') loadKokoro();
    const target = activeEngine();
    if (reader.current && reader.current.engine !== target && !reader.paused) restartCurrent();
    refreshVoiceTags();
  });
}

$('#kokoroMode').addEventListener('change', (e) => {
  settings.kokoroMode = e.target.value;
  saveSettings();
  renderGpuWarning();
  if (kokoroEngine.state === 'ready' || kokoroEngine.state === 'error') {
    kokoroEngine.state = 'unloaded';
    kokoroEngine.terminate();
    renderKokoroState('unloaded', {});
    if (reader.current && reader.current.engine === kokoroEngine) restartCurrent();
  }
});
$('#kokoroLoadBtn').addEventListener('click', () => { userGesture(); loadKokoro(); });
$('#gpuCopyBtn').addEventListener('click', async () => {
  const button = $('#gpuCopyBtn');
  try {
    await navigator.clipboard.writeText($('#gpuSettingsUrl').textContent);
    button.textContent = 'Copied';
  } catch {
    getSelection().selectAllChildren($('#gpuSettingsUrl'));
    button.textContent = 'Press Ctrl+C';
  }
  setTimeout(() => { button.textContent = 'Copy'; }, 2000);
});

$('#systemLang').addEventListener('change', (e) => {
  settings.systemLang = e.target.value;
  settings.systemVoices = null;
  saveSettings();
  renderVoiceList();
  refreshVoiceTags();
});

$('#poolBest').addEventListener('click', () => {
  if (settings.engine === 'kokoro') settings.kokoroVoices = [...KOKORO_BEST];
  else settings.systemVoices = null;
  saveSettings();
  renderVoiceList();
  refreshVoiceTags();
});
$('#poolAll').addEventListener('click', () => {
  if (settings.engine === 'kokoro') settings.kokoroVoices = KOKORO_VOICES.map((v) => v.id);
  else {
    const lang = settings.systemLang;
    settings.systemVoices = systemEngine.voices().filter((v) => lang === 'all' || v.lang.toLowerCase().startsWith(lang)).map((v) => v.id);
  }
  saveSettings();
  renderVoiceList();
  refreshVoiceTags();
});

for (const key of CHECKBOX_SETTINGS) {
  const input = $(`#${key}`);
  input.addEventListener('change', () => {
    settings[key] = input.checked;
    saveSettings();
    if (APPEARANCE_SETTINGS.includes(key)) {
      applyAppearance();
      renderNow();   // the chatter's own name colour is dropped in high contrast
    }
  });
}

$('#theme').addEventListener('change', (e) => {
  settings.theme = e.target.value;
  saveSettings();
  applyAppearance();
});

$('#uiScale').addEventListener('change', (e) => {
  settings.uiScale = Number(e.target.value);
  saveSettings();
  applyAppearance();
});

$('#exportBtn').addEventListener('click', exportSettings);
$('#importBtn').addEventListener('click', importSettings);
$('#importFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';   // so picking the same file twice works
  if (file) readImportedFile(file);
});
$('#resetBtn').addEventListener('click', resetSettings);

$('#nameFormat').addEventListener('change', (e) => { settings.nameFormat = e.target.value; saveSettings(); });

$('#emoteMode').addEventListener('change', (e) => {
  settings.emoteMode = e.target.value;
  saveSettings();
  loadThirdPartyEmotes();     // starts the fetch if this mode needs it
  refreshSpeechBodies();
  renderNow();
});

$('#readEmoteOnly').addEventListener('change', (e) => {
  settings.readEmoteOnly = e.target.checked;
  saveSettings();
  refreshSpeechBodies();
  renderNow();
});
renderEmoteStatus();

for (const key of NUMBER_SETTINGS) {
  const input = $(`#${key}`);
  input.addEventListener('change', () => {
    const n = Math.max(Number(input.min), Math.min(Number(input.max), Math.round(Number(input.value) || 0)));
    settings[key] = n;
    input.value = n;
    saveSettings();
  });
}

$('#replay').addEventListener('change', (e) => {
  settings.replay = e.target.checked;
  saveSettings();
  applyReplaySetting();
  syncGlobalHotkeys();
  renderNow();
});
$('#replayAnnounce').addEventListener('change', applyReplaySetting);
for (const key of TEXT_SETTINGS) {
  $(`#${key}`).addEventListener('change', (e) => {
    settings[key] = e.target.value.trim().slice(0, 200);
    e.target.value = settings[key];
    saveSettings();
  });
}
$$('[data-hear]').forEach((button) => button.addEventListener('click', () => {
  const text = settings[button.dataset.hear].trim();
  const engine = activeEngine();
  if (text && engine.preview) previewVoice(engine, readerVoiceOptions(engine).voiceId, text);
}));

$('#ignoredUsers').addEventListener('input', (e) => { settings.ignoredUsers = e.target.value; saveSettings(); });

for (const button of $$('[data-bind]')) {
  button.addEventListener('click', () => (capturing === button ? stopCapture() : startCapture(button)));
}
document.addEventListener('click', (e) => { if (capturing && !e.target.closest('[data-bind]')) stopCapture(); });

$('#mediaKeys').addEventListener('change', (e) => {
  settings.mediaKeys = e.target.checked;
  saveSettings();
  enableMediaKeys(settings.mediaKeys);
});

$('#testBtn').addEventListener('click', () => {
  userGesture();
  const now = Date.now();
  const samples = [
    { login: 'pixel_panda', displayName: 'Pixel_Panda', color: '#1E90FF', rawText: 'hey everyone, just got here! what did I miss?' },
    { login: 'quietstorm', displayName: 'QuietStorm', color: '#FF7F50', rawText: 'We just beat the second boss, it took like forty tries lol' },
    {
      login: 'pixel_panda', displayName: 'Pixel_Panda', color: '#1E90FF', rawText: '@QuietStorm forty?? that is dedication',
      isReply: true, parentLogin: 'quietstorm', parentDisplayName: 'QuietStorm', parentBody: 'We just beat the second boss, it took like forty tries lol',
    },
    { login: 'mossyrock88', displayName: 'MossyRock88', color: '#9ACD32', rawText: 'is waving at chat', action: true },
  ];
  samples.forEach((s, i) => {
    const displayText = s.isReply ? stripLeadingMention(s.rawText, s.parentLogin, s.parentDisplayName) : s.rawText;
    enqueue({
      id: `test-${now}-${i}`,
      kind: 'chat',
      userId: s.login,
      action: false,
      isReply: false,
      ...s,
      displayText,
      speechBody: displayText,
      receivedAt: now + i,
    });
  });
  // A cheer goes through the same path as a real one, effect word and all.
  const bits = Math.max(100, settings.cheerEffects);
  handlePrivmsg({
    tags: { id: `test-${now}-cheer`, login: 'bitbaron', 'display-name': 'BitBaron', color: '#B57EDC', 'user-id': 'bitbaron', bits: String(bits) },
    prefix: 'bitbaron!bitbaron@bitbaron.tmi.twitch.tv',
    params: ['#test', `Cheer${bits} ${settings.cheerEffects > 0 ? 'chipmunk ' : ''}take my bits, you earned them`],
  });
  // The desktop app also reads YouTube and TikTok, so show one of each.
  if (RemoteChat.available) {
    handleRemoteMessage(null, {
      platform: 'youtube',
      id: `test-${now}-yt`, kind: 'chat', login: 'lofi_listener', userId: 'test-yt', displayName: 'lofi_listener',
      text: 'greetings from YouTube, this stream is so chill',
      paid: { label: 'Super Chat of $5.00', badge: '$5.00 Super Chat' },
    });
    handleRemoteMessage(null, {
      platform: 'tiktok',
      id: `test-${now}-tt`, kind: 'event', login: 'dance.queen', userId: 'test-tt', displayName: 'Dance Queen',
      systemText: 'Dance Queen sent 5 Roses',
    });
  }
});

$('#gateBtn').addEventListener('click', () => {
  $('#gate').hidden = true;
  connectChats({ toggle: false });
});

if (systemEngine.supported) {
  let knownVoiceCount = -1;
  const onVoicesChanged = () => {
    const count = speechSynthesis.getVoices().length;
    if (count === knownVoiceCount) return;
    knownVoiceCount = count;
    renderLanguageOptions();
    renderVoiceList();
    refreshVoiceTags();
  };
  // Older Safari has no addEventListener on speechSynthesis and may never fire
  // voiceschanged, so also poll briefly until the voices show up.
  if (typeof speechSynthesis.addEventListener === 'function') speechSynthesis.addEventListener('voiceschanged', onVoicesChanged);
  else speechSynthesis.onvoiceschanged = onVoicesChanged;
  let polls = 0;
  const voicePoll = setInterval(() => {
    onVoicesChanged();
    if (knownVoiceCount > 0 || ++polls > 20) clearInterval(voicePoll);
  }, 250);
}

// ---------------------------------------------------------------------------
// The desktop app's bot (desktop/bot/, see docs/bot-plan.md)
// ---------------------------------------------------------------------------

// The website is only a reader and never loads any of this. In the desktop
// app the bot's scripts are loaded from the app itself and get this object to
// talk to the reader: say something, pause, skip, and hooks the code above
// calls when they're set.
const host = {
  skipReason: null,       // (entry) => reason to leave it unread, or null
  onRemoteMessage: null,  // (entry, raw) for YouTube and TikTok chat
  onAction: null,         // ('bot:…') from a hotkey
  hotkeys: null,          // () => [['bot:…', binding], …]
  showSettings: null,     // (tab) shows a settings section instead of the dialog
  chatterExtra: null,     // (entry) => a node for the chatter dialog, or null
  onReaderCommand: null,  // (entry, { kind, args, result }) after !voice or !tts
  onReaderChange: null,   // () when reading, the queue, the chats or the voices change

  settings,
  el,
  keyLabel,
  announce,
  openChatterFor: (entry, opener) => openChatter(entry, opener),

  // Said by the reader like its own notices, in the voice asked for (by
  // name, from every voice of the engine) or the reader's own. Resolves once
  // it was read, skipped or cleared.
  speak(text, { voice = '', priority = false, label = 'Bot', login = '' } = {}) {
    const body = String(text || '').trim();
    if (!body) return Promise.resolve('skipped');
    return new Promise((resolve) => {
      const engine = activeEngine();
      const entry = {
        id: `bot-${Date.now()}-${entrySeq + 1}`,
        kind: 'notice',
        login,
        displayName: label,
        rawText: body,
        displayText: body,
        speechBody: body,
        priority,
        paid: priority ? { label: '', badge: 'bot' } : null,
        forcedVoice: voice ? host.findAnyVoice(engine, voice) : readerVoiceOptions(engine).voiceId,
        whenDone: resolve,
      };
      enqueue(entry);
    });
  },

  findAnyVoice(engine, name) {
    const q = String(name).trim().toLowerCase();
    const all = host.voices(engine);
    const hit = all.find((v) => v.id.toLowerCase() === q || v.name.toLowerCase() === q)
      || all.find((v) => v.name.toLowerCase().split(/[^\p{L}\p{N}]+/u).includes(q))
      || all.find((v) => v.name.toLowerCase().includes(q));
    return hit ? hit.id : readerVoiceOptions(engine).voiceId;
  },

  // Every voice of the engine in use, the pool first.
  voices(engine = activeEngine()) {
    const pool = voicePool(engine);
    const ids = engine === kokoroEngine ? KOKORO_VOICES.map((v) => v.id) : systemEngine.voices().map((v) => v.id);
    return [...pool, ...ids.filter((id) => !pool.includes(id))].map((id) => ({ id, name: voiceName(engine, id), inPool: pool.includes(id) }));
  },

  // Starts reading a chat, from the desktop app's setup guide: it goes in an
  // empty field of its platform, or a new one, unless a field has it already.
  // False when there's no room for another chat.
  readChat(platform, input) {
    const target = String(input || '').trim();
    if (!target || !PLATFORMS[platform]) return false;
    const key = (text) => NORMALIZE[platform](text) || text.trim();
    if (!chats.some((c) => c.platform === platform && key(c.input) === key(target))) {
      const empty = chats.find((c) => c.platform === platform && !c.input.trim());
      if (empty) {
        empty.input = target;
        if (empty.inputEl) empty.inputEl.value = target;
      } else if (chats.length < MAX_CHATS) {
        chats.push(createChat(platform, target));
      } else {
        return false;
      }
      saveChatList();
      renderChatFields();
    }
    connectChats({ toggle: false });
    return true;
  },

  // The chats in the top bar, for the bot's multistream relay to reuse.
  readerChats: () => chats.filter(isActive).map((c) => ({ id: c.id, platform: c.platform, target: c.client.channel, state: c.state, videoId: c.client.videoId || '' })),

  state: () => ({ paused: reader.paused, held: reader.held, waiting: reader.queue.length, speaking: !!reader.current, volume: settings.volume, rate: settings.rate }),

  // The screen reader (desktop/bot/screen.js): chat waits while it speaks,
  // and it speaks right away in a voice of its own, outside the chat queue.
  hold: (on) => setHeld(!!on),
  readerEngine: () => (activeEngine() === kokoroEngine ? 'kokoro' : 'system'),
  // Every voice of both engines. Neural ones can only be used once loaded.
  allVoices: () => ({
    system: systemEngine.voices().filter((v) => !v.novelty).map((v) => ({ id: v.id, name: v.name, lang: v.lang })),
    neural: KOKORO_VOICES.map((v) => ({ id: v.id, name: `${v.name} (${v.accent === 'UK' ? 'British' : 'American'})` })),
    neuralState: kokoroEngine.state,
    reader: { engine: activeEngine() === kokoroEngine ? 'kokoro' : 'system', voiceId: readerVoiceOptions(activeEngine()).voiceId },
  }),
  // `engine` is 'system', 'kokoro' or '' for the reader's own voice. Neural
  // voices fall back to the reader's system voice until they're loaded.
  // Returns a controller with `done` and `stop()`.
  speakVoice(text, { engine = '', voiceId = '', rate = 1, pitch = 1, volume = 100 } = {}) {
    const body = String(text || '').trim();
    const getVol = () => Math.max(0, Math.min(1, Number(volume) / 100));
    let eng = engine === 'kokoro' ? kokoroEngine : engine === 'system' ? systemEngine : activeEngine();
    if (eng === kokoroEngine && kokoroEngine.state !== 'ready') eng = systemEngine;
    const known = eng === kokoroEngine ? KOKORO_VOICES.some((v) => v.id === voiceId) : systemEngine.voices().some((v) => v.id === voiceId);
    const id = engine && known && (eng === kokoroEngine) === (engine === 'kokoro') ? voiceId : readerVoiceOptions(eng).voiceId;
    if (!body) return { done: Promise.resolve(), stop() {}, engine: eng.id };
    const controller = eng === kokoroEngine
      ? kokoroEngine.speakApart(body, { voiceId: id, speed: rate }, { getVolume: getVol })
      : systemEngine.speak(body, { voiceId: id, rate, pitch }, { getVolume: getVol });
    controller.engine = eng.id;
    return controller;
  },
  setPaused: (paused) => setPaused(!!paused),
  togglePause: () => togglePause(),
  skip: () => skipCurrent(),
  clear: () => clearQueue(),
  setVolume: (n) => setVolume(n),
  setRate: (n) => setRate(n),
  voiceStatus: () => ({ engine: settings.engine, state: $('#voiceChip').dataset.state, text: $('#voiceChipText').textContent }),
  current: () => (reader.current ? { displayName: reader.current.displayName, text: reader.current.displayText || '', kind: reader.current.kind } : null),

  // Chatters: the voice and nickname the reader uses for them.
  chatterVoice(login) {
    const engine = activeEngine();
    return voiceName(engine, voiceIdFor(String(login || '').toLowerCase(), engine));
  },
  // A voice by name from every voice of the engine, kept like a click on the
  // voice tag. Returns its name, or '' when there's no such voice.
  setChatterVoice(login, name) {
    const engine = activeEngine();
    const user = String(login || '').toLowerCase().replace(/^@/, '');
    if (!user) return '';
    const q = String(name || '').trim();
    const id = q ? (findVoice(engine, q) || host.voices(engine).find((v) => v.name.toLowerCase().includes(q.toLowerCase()))?.id) : null;
    if (q && !id) return '';
    if (!q) {
      const pool = voicePool(engine);
      setUserVoice(user, engine, pool[(pool.indexOf(voiceIdFor(user, engine)) + 1) % pool.length]);
    } else {
      setUserVoice(user, engine, id);
    }
    return host.chatterVoice(user);
  },
  nickname: (login) => settings.nicknames[String(login || '').toLowerCase()] || '',
  setNickname: (login, nickname) => {
    const user = String(login || '').toLowerCase().replace(/^@/, '');
    if (user) setNickname(user, String(nickname || '').trim().slice(0, 60));
  },
  isIgnored: (login) => isIgnored(String(login || '').toLowerCase()),
  setIgnored: (login, on) => setIgnored(String(login || '').toLowerCase(), !!on),

  // The reader's own channel point rewards (Viewer controls), by reward id.
  rewardActions: () => Object.entries(REWARD_ACTIONS).map(([id, a]) => ({ id, name: a.name, label: a.label })),
  readerRewards: () => settings.rewards,
  setReaderReward(id, title, action) {
    if (!action) delete settings.rewards[id];
    else settings.rewards[id] = { name: String(title || REWARD_ACTIONS[action].name).slice(0, 60), action };
    saveSettings();
    renderRewards();
  },

  // A line in the chat list that isn't read out: a follow, a redemption…
  feedNote(text, { label = 'Bot', tag = '', platform = '' } = {}) {
    const body = String(text || '').trim();
    if (!body) return;
    const entry = {
      id: `note-${Date.now()}-${entrySeq + 1}`, uid: ++entrySeq, kind: 'notice', label, platform,
      login: '', displayName: label, rawText: body, displayText: body, speechBody: '',
    };
    addToFeed(entry);
    entry.node.classList.add('bot-note');
    setStatus(entry, 'info', tag);
  },
  syncHotkeys: () => syncGlobalHotkeys(),
  hotkeyProblems: () => (settings.globalHotkeys ? globalHotkeys.problems : {}),
  // Backups: what the bot adds to the settings file, and how it reads it back.
  backupExtra: null,      // () => object saved as "bot"
  restoreExtra: null,     // (object) => true when it was loaded
  importReaderSettings: (raw) => importReaderSettings(raw),
};
window.chatReaderHost = host;

// The bot's dashboard follows the player and the chats. Lots of changes come
// at once, so it's told once per frame at most.
let readerChangePending = false;
function readerChanged() {
  const h = window.chatReaderHost;
  if (!h || !h.onReaderChange || readerChangePending) return;
  readerChangePending = true;
  requestAnimationFrame(() => {
    readerChangePending = false;
    try { h.onReaderChange(); } catch (err) { console.error(err); }
  });
}

function hostHotkeys() {
  try { return host.hotkeys ? host.hotkeys() : []; } catch { return []; }
}

function loadBot() {
  const base = desktop && desktop.bot && desktop.bot.base;
  if (!base) return;
  document.head.append(el('link', { rel: 'stylesheet', href: `${base}bot.css` }));
  // In order, each after the one before, like the <script> tags above.
  const files = ['core.js', 'twitch.js', 'eventsub.js', 'variables.js', 'effects.js', 'triggers.js', 'community.js', 'obs.js', 'spotify.js', 'relay.js', 'importers.js', 'screen.js', 'ui.js', 'ui-tabs.js', 'ui-multistream.js', 'ui-spotify.js', 'ui-screen.js', 'dashboard.js', 'integrations.js', 'shell.js', 'setup.js', 'start.js'];
  const next = (i) => {
    if (i >= files.length) return;
    const script = el('script', { src: `${base}${files[i]}` });
    script.addEventListener('load', () => next(i + 1));
    script.addEventListener('error', () => console.error(`Bot: couldn’t load ${files[i]}`));
    document.body.append(script);
  };
  next(0);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

startDesktop();
applyAppearance();
syncControlsFromSettings();
renderLanguageOptions();
renderEngineUI();
renderKeyLabels();
renderNicknames();
renderRewards();
renderCommandHints();
applyReplaySetting();
renderNow();

{
  // ?channel=name puts that Twitch channel in the top bar, if it isn't there.
  const fromUrl = TwitchChat.normalizeChannel(new URLSearchParams(location.search).get('channel') || '');
  if (fromUrl && !chats.some((c) => c.platform === 'twitch' && NORMALIZE.twitch(c.input) === fromUrl)) {
    const empty = chats.find((c) => c.platform === 'twitch' && !c.input.trim());
    if (empty) {
      empty.input = fromUrl;
      empty.inputEl.value = fromUrl;
    } else {
      chats.unshift(createChat('twitch', fromUrl));
    }
    saveChatList();
    renderChatFields();
  }
  if (fromUrl) {
    // Browsers block audio until the page is clicked, so ask once.
    $('#gateChannel').textContent = `#${fromUrl}`;
    $('#gate').hidden = false;
    $('#gateBtn').focus();
  }
  renderStatusLine();
  renderConnectButton();
}

loadBot();
