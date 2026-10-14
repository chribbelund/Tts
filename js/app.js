'use strict';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'twitch-chat-reader:v1';
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const DEFAULTS = {
  channel: '',
  youtube: '',           // what was typed in the YouTube field (desktop app only)
  tiktok: '',            // the TikTok username (desktop app only)
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
  keys: {
    pause: { code: 'KeyP', alt: true, ctrl: false, shift: false, meta: false },
    skip: { code: 'KeyS', alt: true, ctrl: false, shift: false, meta: false },
    volumeUp: { code: 'ArrowUp', alt: true, ctrl: false, shift: false, meta: false },
    volumeDown: { code: 'ArrowDown', alt: true, ctrl: false, shift: false, meta: false },
    clear: { code: 'KeyC', alt: true, ctrl: false, shift: true, meta: false },
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
};

// Switches that are one checkbox each, in the order they appear on the page.
const APPEARANCE_SETTINGS = ['highContrast', 'reduceMotion'];
const NUMBER_SETTINGS = ['maxLength', 'catchUp', 'cheerPriority', 'cheerEffects'];
const CHECKBOX_SETTINGS = [
  ...APPEARANCE_SETTINGS, 'announce',
  'varyVoices', 'collapseNames', 'quoteParent', 'readEvents', 'readEmojis',
  'skipCommands', 'skipLinks',
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
    };
  } catch {
    return cloneDefaults();
  }
}

const settings = loadSettings();
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
  lastSpoken: null,
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
  if (entry.kind === 'event' && !settings.readEvents) return 'events off';
  if (entry.kind === 'chat') {
    if (isIgnored(entry.login)) return 'ignored';
    if (settings.skipCommands && /^\s*!/.test(entry.rawText)) return 'command';
    if (settings.skipLinks && new RegExp(URL_RE.source, 'i').test(entry.rawText)) return 'link';
  }
  return null;
}

function pump() {
  if (reader.paused || reader.current) return;

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
  toggleWindow: () => desktop && desktop.toggleWindow(),
  // Not bound to a key; the desktop app's Settings menu sends these. The
  // backup tab is opened first so its status line can be seen.
  openSettings: () => openSettings(),
  exportSettings: () => { openSettings('backup'); exportSettings(); },
  importSettings: () => { openSettings('backup'); importSettings(); },
};

function runAction(action) {
  if (ACTIONS[action]) ACTIONS[action]();
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
  if (reader.controller) {
    if (paused) reader.controller.pause();
    else reader.controller.resume();
  }
  if (!paused) pump();
  renderNow();
  updateMediaSession();
  announce(paused ? 'Reading paused' : 'Reading resumed');
}

function skipCurrent() {
  if (!reader.current) return;
  setStatus(reader.current, 'skipped', 'skipped');
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
  setStatus(entry, 'queued');
  reader.queue.unshift(entry);
  reader.current = null;
  reader.controller = null;
  controller.stop();
  pump();
}

// ---------------------------------------------------------------------------
// Twitch → entries
// ---------------------------------------------------------------------------

// Emote names in the 7TV/BTTV/FFZ sets, loaded once we know the channel id.
const thirdPartyEmotes = new ThirdPartyEmotes(() => {
  renderEmoteStatus();
  // Messages that queued up while the sets were still downloading.
  refreshSpeechBodies();
  renderNow();
});

let currentRoomId = null;

function loadThirdPartyEmotes(roomId) {
  if (roomId && roomId !== currentRoomId) {
    currentRoomId = roomId;
    thirdPartyEmotes.clear();
  }
  if (settings.emoteMode === 'skip-all' && currentRoomId) thirdPartyEmotes.load(currentRoomId);
  renderEmoteStatus();
}

function renderEmoteStatus() {
  const hint = $('#emoteHint');
  // In "read" mode every emote is spoken anyway, so the option is moot.
  $('#readEmoteOnlyRow').hidden = settings.emoteMode === 'read';
  if (settings.emoteMode === 'read') {
    hint.textContent = 'Emote names are spoken as written, e.g. “Kappa”.';
  } else if (settings.emoteMode === 'skip-twitch') {
    hint.textContent = '7TV, BetterTTV and FrankerFaceZ emotes are still read out, because Twitch doesn’t mark them in the message.';
  } else if (!currentRoomId) {
    hint.textContent = 'The channel’s 7TV, BetterTTV and FrankerFaceZ emote names are fetched when you connect.';
  } else if (!thirdPartyEmotes.loaded) {
    hint.textContent = 'Fetching 7TV, BetterTTV and FrankerFaceZ emote names…';
  } else if (!thirdPartyEmotes.size) {
    hint.textContent = 'Couldn’t reach 7TV, BetterTTV or FrankerFaceZ, so only Twitch’s own emotes are skipped.';
  } else {
    const count = thirdPartyEmotes.size.toLocaleString();
    hint.textContent = `Also skipping ${count} 7TV/BTTV/FFZ emote names${thirdPartyEmotes.failed ? ', though one source didn’t answer' : ''}.`;
  }
}

/**
 * The words actually handed to the voice. Twitch's own emotes come with
 * positions in the `emotes` tag; third-party ones arrive as plain words, so
 * they can only be recognised by name. `reply` is the chatter being replied
 * to, whose @mention Twitch puts in front of the message.
 */
function speechBodyFor(rawText, emotesTag, reply) {
  const withoutMention = (t) => (reply ? stripLeadingMention(t, reply.login, reply.displayName) : t);
  if (settings.emoteMode === 'read') return withoutMention(rawText);

  let body = removeEmotes(rawText, emotesTag);
  if (settings.emoteMode === 'skip-all') body = thirdPartyEmotes.strip(body);
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
  let body = speechBodyFor(entry.rawText, entry.emotesTag, reply);
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
    speechBody: speechBodyFor(text, tags.emotes),
  };
  if (tags['msg-id'] === 'announcement') return { ...base, kind: 'announcement' };
  return { ...base, kind: 'event', systemText: tags['system-msg'] || '' };
}

// ---------------------------------------------------------------------------
// Viewer interactions: bits, channel point rewards and chat commands
// ---------------------------------------------------------------------------

// The page reads chat anonymously, so it only sees what Twitch puts in chat:
// cheers, rewards that ask the viewer to type something, and messages. It
// can't answer in chat either, so the reader says the result out loud.

function handlePrivmsg(msg) {
  const entry = entryFromPrivmsg(msg);
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
  if (reward.action === 'voice') entry.handled = pickVoice(entry, entry.rawText);
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
    return;
  }
  const modArgs = commandArgs(entry.rawText, settings.modCommand);
  if (modArgs !== null && mayUse(entry, settings.modCommandWho)) entry.handled = runModCommand(modArgs);
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
  $('#rewardStatus').textContent = chat.connected
    ? `Waiting… Redeem the reward on #${chat.channel} now.`
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

// What a mod took out of chat comes out of the queue too, whichever chat it
// was in. Ids and user ids from YouTube and TikTok carry their prefix, so
// they can't match anything from another platform.
function removeChatterMessages(userId, platform = 'twitch') {
  const targets = [...reader.queue, reader.current]
    .filter((e) => e && (userId ? e.userId === userId : (e.platform || 'twitch') === platform));
  for (const entry of targets) removeFromQueue(entry, 'deleted', userId ? 'removed by mod' : 'chat cleared');
}

function removeMessage(id) {
  const entry = [...reader.queue, reader.current].find((e) => e && e.id === id);
  if (entry) removeFromQueue(entry, 'deleted', 'deleted by mod');
  else {
    const shown = feedEntries.find((e) => e.id === id);
    if (shown && shown.status !== 'done' && shown.status !== 'speaking') setStatus(shown, 'deleted', 'deleted by mod');
  }
}

const chat = new TwitchChat({
  onStatus: (state, text) => renderConnection('twitch', state, text),
  onMessage: handlePrivmsg,
  onUserNotice: (msg) => enqueue(entryFromUserNotice(msg)),
  onRoomState: (roomId) => loadThirdPartyEmotes(roomId),
  onClearChat: (userId) => removeChatterMessages(userId),
  onDeleteMessage: removeMessage,
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
function handleRemoteMessage(platform, m) {
  const entry = entryFromRemote(platform, m);
  if (entry.kind === 'chat' && !entry.paid) runChatCommand(entry);
  entry.speechBody = entrySpeechBody(entry);
  enqueue(entry);
}

const remoteHandlers = (platform) => ({
  onStatus: (state, text) => renderConnection(platform, state, text),
  onMessage: (m) => handleRemoteMessage(platform, m),
  onDeleteMessage: removeMessage,
  onClearChat: (userId) => removeChatterMessages(userId, platform),
});

const sources = {
  twitch: chat,
  youtube: new RemoteChat('youtube', remoteHandlers('youtube')),
  tiktok: new RemoteChat('tiktok', remoteHandlers('tiktok')),
};

const SOURCE_INPUTS = { twitch: '#channelInput', youtube: '#youtubeInput', tiktok: '#tiktokInput' };
const SOURCE_NORMALIZE = { twitch: TwitchChat.normalizeChannel, youtube: normalizeYouTube, tiktok: normalizeTikTok };
const SOURCE_INVALID = {
  twitch: 'That doesn’t look like a Twitch channel',
  youtube: 'That doesn’t look like a YouTube channel or video',
  tiktok: 'That doesn’t look like a TikTok username',
};
const sourceStatus = Object.fromEntries(Object.keys(sources).map((p) => [p, { state: 'idle', text: '' }]));

// YouTube and TikTok are only offered where they can work.
const usablePlatforms = () => (RemoteChat.available ? ['twitch', 'youtube', 'tiktok'] : ['twitch']);

// Connected, connecting, or waiting to retry or for the stream to start.
function sourceIsActive(platform) {
  return platform === 'twitch' ? !chat.manualClose : sources[platform].active;
}

const activePlatforms = () => usablePlatforms().filter(sourceIsActive);
const anySourceConnected = () => usablePlatforms().some((p) => sourceStatus[p].state === 'connected');

// "#shroud, @lofigirl and @someone": what is being read, for the tray, the
// tab title and the media keys.
function sourcesSummary({ connectedOnly = false } = {}) {
  const labels = activePlatforms()
    .filter((p) => !connectedOnly || sourceStatus[p].state === 'connected')
    .map((p) => sourceLabel(p, sources[p].channel));
  return labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}` : labels[0] || '';
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

// Which chat a message came from, once there is more than Twitch to tell
// apart. Notices from the reader itself have no platform.
function platformTag(entry) {
  const platform = entry.platform;
  if (!platform || (platform === 'twitch' && activePlatforms().length < 2)) return null;
  return el('span', { class: 'platform', 'data-platform': platform }, PLATFORMS[platform].name);
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
  const label = { event: 'Event', notice: 'Reader' }[entry.kind];
  const meta = el('div', { class: 'meta' },
    platformTag(entry),
    label ? el('span', { class: 'reply-to' }, label) : name,
    entry.kind === 'announcement' ? el('span', { class: 'reply-to' }, 'announcement') : null,
    badges.map((b) => el('span', { class: 'badge' }, b)),
    entry.isReply ? el('span', { class: 'reply-to' }, `↩ replying to @${entry.parentDisplayName || entry.parentLogin}`) : null,
    el('span', { class: 'tail' }, voiceBtn, stateEl, removeBtn),
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
  const entry = reader.current;
  const state = reader.paused ? 'paused' : entry ? 'speaking' : 'idle';
  nowPanel.dataset.state = state;
  $('#pauseBtn').setAttribute('aria-pressed', String(reader.paused));
  $('#pauseBtn').title = reader.paused ? 'Resume reading' : 'Pause reading';
  $('#pauseBtn').setAttribute('aria-label', reader.paused ? 'Resume reading' : 'Pause reading');

  const loading = entry && reader.controller && reader.controller.loading;
  $('#nowLabel').textContent = reader.paused
    ? (entry ? 'Paused on this message' : 'Paused')
    : loading ? 'Preparing voice…' : entry ? 'Reading' : 'Idle';

  const waiting = reader.queue.length;
  $('#queueCount').textContent = `${waiting} waiting`;

  const msgEl = $('#nowMsg');
  msgEl.replaceChildren();
  if (entry) {
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
      : anySourceConnected() ? 'Waiting for chat messages…' : 'Nothing is being read right now.'));
  }
  if (!entry) {
    nowBar.style.width = '0';
    tickProgress.lastPercent = 0;
    $('#nowProgress').setAttribute('aria-valuenow', '0');
  }

  for (const e of feedEntries) e.node.classList.toggle('paused', e.status === 'speaking' && reader.paused);

  if (desktop) desktop.setState({ paused: reader.paused, channel: chat.channel || '', where: sourcesSummary(), waiting });
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

function renderConnection(platform, state, text) {
  sourceStatus[platform] = { state, text };
  const field = $(SOURCE_INPUTS[platform]).closest('.source-field');
  field.dataset.state = state;
  field.title = text ? `${PLATFORMS[platform].name}: ${text}` : '';
  renderStatusLine();
  renderConnectButton();
  renderNow();
}

// One line for every chat: the ones being read are named together, anything
// else (connecting, waiting for a stream, an error) says which chat it is.
function renderStatusLine() {
  const platforms = usablePlatforms();
  const shown = platforms.filter((p) => sourceIsActive(p) || sourceStatus[p].state === 'error');
  const connected = shown.filter((p) => sourceStatus[p].state === 'connected');
  const others = shown.filter((p) => sourceStatus[p].state !== 'connected');
  const parts = [];
  if (connected.length) parts.push(connected.length === 1 ? sourceStatus[connected[0]].text : `Reading ${sourcesSummary({ connectedOnly: true })}`);
  const named = shown.length > 1;
  for (const p of others) parts.push(named ? `${PLATFORMS[p].name}: ${sourceStatus[p].text}` : sourceStatus[p].text);

  // The dot shows the worst of them, so a chat that dropped isn't hidden
  // behind one that's fine.
  const states = shown.map((p) => sourceStatus[p].state);
  const state = ['error', 'connecting', 'connected'].find((s) => states.includes(s)) || 'idle';
  const fallback = platforms.map((p) => sourceStatus[p].text).find(Boolean) || 'Not connected';
  const text = parts.join(' · ') || fallback;
  $('#status').dataset.state = state;
  $('#statusText').textContent = text;
  $('#status').title = text;

  const reading = sourcesSummary({ connectedOnly: true });
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
const chatter = { login: '', displayName: '', opener: null };

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
  Object.assign(chatter, { login: entry.login, displayName: entry.displayName || entry.login, opener });
  $('#chatterTitle').textContent = chatter.displayName;
  $('#chatterNick').value = settings.nicknames[chatter.login] || '';
  renderChatterVoices();
  renderChatterIgnore();
  chatterDialog.showModal();
  $('#chatterNick').focus();
  $('#chatterNick').select();
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

  for (const [action, binding] of Object.entries(settings.keys)) {
    if (!matches(binding)) continue;
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
    };
    // Browsers throw for actions they don't support.
    for (const [action, handler] of Object.entries(handlers)) {
      try { session.setActionHandler(action, handler); } catch {}
    }
    updateMediaSession();
  } else {
    if (mediaKeys.audio) mediaKeys.audio.pause();
    for (const action of ['play', 'pause', 'stop', 'nexttrack']) {
      try { session.setActionHandler(action, null); } catch {}
    }
    session.metadata = null;
    session.playbackState = 'none';
  }
}

function updateMediaSession() {
  if (!settings.mediaKeys || !('mediaSession' in navigator)) return;
  if (typeof MediaMetadata === 'function') navigator.mediaSession.metadata = new MediaMetadata({
    title: reader.paused ? 'Chat reading paused' : 'Reading chat',
    artist: sourcesSummary() || 'Chat Reader',
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
    bindings: settings.keys,
    media: settings.mediaKeys,
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
    const problem = settings.globalHotkeys ? globalHotkeys.problems[button.dataset.bind] : null;
    const note = button.closest('.keybind').querySelector('.hotkey-note');
    note.textContent = problem || '';
    note.hidden = !problem;
    button.classList.toggle('conflict', !!problem);
  }

  const MEDIA_LABELS = { 'media:pause': '⏯', 'media:skip': '⏭' };
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
  const { clean, kept } = sanitizeSettings(raw);
  if (!kept) {
    backupStatus('Nothing in that file looked like a Chat Reader setting, so nothing changed.');
    return;
  }
  Object.assign(settings, clean);
  saveSettings();
  applyAllSettings();
  backupStatus(`Loaded ${kept} setting${kept === 1 ? '' : 's'}${name ? ` from ${name}` : ''}.`);
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
  youtube: (v) => (typeof v === 'string' && v.length <= 300 ? (normalizeYouTube(v) ? v.trim() : '') : undefined),
  tiktok: (v) => (typeof v === 'string' && v.length <= 300 ? (normalizeTikTok(v) ? v.trim() : '') : undefined),
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
};

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
  return { clean, kept };
}

// Put the settings into the controls. The one place that knows how, so
// starting up, importing a file and resetting all go through it.
function syncControlsFromSettings() {
  $('#channelInput').value = settings.channel;
  $('#youtubeInput').value = settings.youtube;
  $('#tiktokInput').value = settings.tiktok;
  syncShownSources();
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
  for (const key of ['voiceCommand', 'modCommand', 'voiceCommandWho', 'modCommandWho']) $(`#${key}`).value = settings[key];
  for (const key of [...CHECKBOX_SETTINGS, 'readEmoteOnly', 'mediaKeys', 'globalHotkeys']) {
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

// What pressing Connect would do to each chat: start one whose field was
// filled in or changed, stop one whose field was emptied.
function pendingSourceChanges() {
  const changes = [];
  for (const platform of usablePlatforms()) {
    const raw = $(SOURCE_INPUTS[platform]).value.trim();
    const target = raw ? SOURCE_NORMALIZE[platform](raw) : null;
    const active = sourceIsActive(platform);
    if (raw && !target) changes.push({ platform, invalid: true });
    else if (target && (!active || sources[platform].channel !== target)) changes.push({ platform, target, raw });
    else if (!target && active) changes.push({ platform, stop: true });
  }
  return changes;
}

// "Disconnect" only when everything typed is already being read; after an
// edit the same button applies it instead.
function renderConnectButton() {
  const disconnect = activePlatforms().length > 0 && pendingSourceChanges().length === 0;
  $('#connectBtn').textContent = disconnect ? 'Disconnect' : 'Connect';
  $('#connectBtn').classList.toggle('primary', !disconnect);
}

function connectSource(platform, target, raw) {
  if (platform === 'twitch') {
    settings.channel = target;
    $('#channelInput').value = target;
    const url = new URL(location.href);
    url.searchParams.set('channel', target);
    history.replaceState(null, '', url);
  } else {
    // Kept as typed, so a pasted link stays readable in the field.
    settings[platform] = raw;
  }
  saveSettings();
  sources[platform].connect(target);
}

function disconnectSource(platform) {
  if (platform !== 'twitch') {
    settings[platform] = '';
    saveSettings();
  }
  sources[platform].disconnect();
}

function connectSources() {
  const changes = pendingSourceChanges();
  const invalid = changes.find((c) => c.invalid);
  if (invalid) {
    renderConnection(invalid.platform, 'error', SOURCE_INVALID[invalid.platform]);
    $(SOURCE_INPUTS[invalid.platform]).focus();
    return;
  }
  // An emptied field also takes back the error it showed.
  for (const platform of usablePlatforms()) {
    if (!$(SOURCE_INPUTS[platform]).value.trim() && sourceStatus[platform].state === 'error') renderConnection(platform, 'idle', '');
  }
  if (!changes.length) {
    const active = activePlatforms();
    if (active.length) for (const platform of active) disconnectSource(platform);
    else renderConnection('twitch', 'error', usablePlatforms().length > 1 ? 'Enter a channel to read' : SOURCE_INVALID.twitch);
    return;
  }
  userGesture();
  for (const change of changes) {
    if (change.stop) disconnectSource(change.platform);
    else connectSource(change.platform, change.target, change.raw);
  }
}

$('#connectForm').addEventListener('submit', (e) => {
  e.preventDefault();
  connectSources();
});
for (const selector of Object.values(SOURCE_INPUTS)) $(selector).addEventListener('input', renderConnectButton);

// Twitch's field is always there. YouTube and TikTok come in through the +
// button, and stay as long as they hold something or are being read.
const ADDABLE = ['youtube', 'tiktok'];
const shownSources = new Set();

function renderSourceFields() {
  for (const platform of ADDABLE) $(SOURCE_INPUTS[platform]).closest('.source-field').hidden = !shownSources.has(platform);
  const left = RemoteChat.available ? ADDABLE.filter((p) => !shownSources.has(p)) : [];
  $('#sourceAdd').hidden = !left.length;
  for (const item of $$('[data-add]')) item.hidden = !left.includes(item.dataset.add);
  if (!left.length) closeSourceMenu();
}

// After loading settings: show whichever fields have something in them.
function syncShownSources() {
  shownSources.clear();
  for (const platform of ADDABLE) if (settings[platform] || sourceIsActive(platform)) shownSources.add(platform);
  renderSourceFields();
}

function addSource(platform) {
  closeSourceMenu();
  shownSources.add(platform);
  renderSourceFields();
  $(SOURCE_INPUTS[platform]).focus();
  renderConnectButton();
}

function removeSource(platform) {
  $(SOURCE_INPUTS[platform]).value = '';
  shownSources.delete(platform);
  if (sourceIsActive(platform)) disconnectSource(platform);
  else if (settings[platform]) { settings[platform] = ''; saveSettings(); }
  renderConnection(platform, 'idle', '');
  renderSourceFields();
  $('#sourceAdd').hidden ? $('#channelInput').focus() : $('#sourceAddBtn').focus();
}

function openSourceMenu() {
  const left = ADDABLE.filter((p) => !shownSources.has(p));
  // With only one left there's nothing to choose between.
  if (left.length === 1) { addSource(left[0]); return; }
  $('#sourceAddMenu').hidden = false;
  $('#sourceAddBtn').setAttribute('aria-expanded', 'true');
  $('#sourceAddMenu [data-add]:not([hidden])').focus();
}

function closeSourceMenu({ focus = false } = {}) {
  if ($('#sourceAddMenu').hidden) return;
  $('#sourceAddMenu').hidden = true;
  $('#sourceAddBtn').setAttribute('aria-expanded', 'false');
  if (focus) $('#sourceAddBtn').focus();
}

$('#sourceAddBtn').addEventListener('click', () => ($('#sourceAddMenu').hidden ? openSourceMenu() : closeSourceMenu()));
for (const item of $$('[data-add]')) item.addEventListener('click', () => addSource(item.dataset.add));
for (const button of $$('[data-remove]')) button.addEventListener('click', () => removeSource(button.dataset.remove));
$('#sourceAddMenu').addEventListener('keydown', (e) => {
  const items = $$('#sourceAddMenu [data-add]:not([hidden])');
  const i = items.indexOf(document.activeElement);
  if (e.key === 'Escape') { e.preventDefault(); closeSourceMenu({ focus: true }); return; }
  const next = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[e.key];
  if (next === undefined) return;
  e.preventDefault();
  items[(next + items.length) % items.length].focus();
});
document.addEventListener('click', (e) => { if (!e.target.closest('#sourceAdd')) closeSourceMenu(); });

$('#pauseBtn').addEventListener('click', () => { userGesture(); togglePause(); });
$('#skipBtn').addEventListener('click', skipCurrent);
$('#clearBtn').addEventListener('click', clearQueue);

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
    handleRemoteMessage('youtube', {
      id: `test-${now}-yt`, kind: 'chat', login: 'lofi_listener', userId: 'test-yt', displayName: 'lofi_listener',
      text: 'greetings from YouTube, this stream is so chill',
      paid: { label: 'Super Chat of $5.00', badge: '$5.00 Super Chat' },
    });
    handleRemoteMessage('tiktok', {
      id: `test-${now}-tt`, kind: 'event', login: 'dance.queen', userId: 'test-tt', displayName: 'Dance Queen',
      systemText: 'Dance Queen sent 5 Roses',
    });
  }
});

$('#gateBtn').addEventListener('click', () => {
  $('#gate').hidden = true;
  connectSources();
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
renderNow();

{
  const fromUrl = TwitchChat.normalizeChannel(new URLSearchParams(location.search).get('channel') || '');
  if (fromUrl) settings.channel = fromUrl;
  $('#channelInput').value = settings.channel;
  if (fromUrl) {
    // Browsers block audio until the page is clicked, so ask once.
    $('#gateChannel').textContent = `#${fromUrl}`;
    $('#gate').hidden = false;
    $('#gateBtn').focus();
  }
  renderStatusLine();
  renderConnectButton();
}
