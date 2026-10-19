'use strict';

// The bot's shared state: its setup (saved as bot-config.json), the viewer
// database (bot-viewers.json), the activity feed and the log, and a small
// event bus the workspace listens to. Loaded only by the desktop app; see
// docs/bot-plan.md. js/app.js hands over `chatReaderHost` to reach the reader.

const Bot = window.Bot = {
  desktop: window.chatReaderDesktop.bot,
  host: window.chatReaderHost,
  data: null,
  viewers: null,
  activity: [],
  logLines: [],
  listeners: new Map(),
  ready: false,
};

const BOT_DEFAULTS = {
  version: 1,
  clientId: '',
  replyAs: 'bot',            // bot | streamer: who chat replies come from
  readBotMessages: false,    // let the reader say the bot's own chat replies
  skipBotCommands: true,     // the reader doesn't read the bot's commands in your channel
  remoteCommands: true,      // YouTube and TikTok chat can use commands too
  answerReaderCommands: true, // the bot answers the reader's !voice and !tts in Twitch chat
  commandPrefixHint: '!',
  commands: [],
  systemCommands: {},        // id -> { enabled, trigger, permission, cooldownGlobal, cooldownUser }
  events: [],
  rewardActions: {},         // reward id -> { title, effects, after: none | fulfill | refund }
  timers: [],
  timerSettings: { minGapSeconds: 60 },
  lists: [],                 // reusable effect lists
  hotkeys: [],
  counters: [],
  variables: {},             // custom variables, $var[name]
  roles: [],                 // custom roles: [{ id, name, users: ['login'] }]
  currency: {
    enabled: false,
    name: 'points',
    perMinute: 1,
    subBonus: 1,             // extra per minute for subscribers
    whileOffline: false,
    activeOnly: false,       // only viewers who chatted in the last 15 minutes
    startAmount: 0,
    max: 0,                  // 0 = no limit
  },
  quotes: { list: [], next: 1 },
  games: {
    slots: { enabled: false, trigger: '!spin', minBet: 10, maxBet: 1000, cooldown: 30, chance: 35, multiplier: 2, symbols: '🍒 🍋 🔔 💎 7️⃣' },
    gamble: { enabled: false, trigger: '!gamble', minBet: 10, maxBet: 5000, cooldown: 30, chance: 45, multiplier: 2 },
    heist: {
      enabled: false, trigger: '!heist', minBet: 10, maxBet: 1000, joinSeconds: 60, cooldown: 300, minUsers: 1, chance: 50, multiplier: 2,
      startText: '$user is planning a heist! Type $trigger [amount] in the next $seconds seconds to join.',
      joinText: '',
      successText: 'The heist worked! Winners: $winners',
      failText: 'The crew got caught. Everyone lost their $currencyName.',
    },
    raffle: { trigger: '!join', cost: 0, permission: 'everyone', winners: 1, announce: true },
  },
  moderation: {
    enabled: false,
    exempt: 'vips',          // this role and up is never moderated
    action: 'delete',        // delete | timeout
    timeoutSeconds: 60,
    escalate: true,          // first offence deletes, the next ones time out
    warnText: '@$user, $reason',
    bannedWords: '',
    bannedRegex: '',
    bannedAction: 'timeout',
    links: { enabled: false, allowed: 'clips.twitch.tv twitch.tv/$streamer', permitTrigger: '!permit', permitSeconds: 60 },
    caps: { enabled: false, minLength: 15, percent: 70 },
    symbols: { enabled: false, minLength: 15, percent: 50 },
    emotes: { enabled: false, max: 15 },
    length: { enabled: false, max: 400 },
    repeats: { enabled: false, count: 3, seconds: 30 },
  },
  overlay: {
    enabled: true,
    port: 7473,
    apiKey: '',
    // How every overlay looks; an instance's style only holds what it changes.
    style: { font: '', textColor: '#ffffff', accent: '#a37bff', shadow: 'soft', boxColor: '#0a0814', boxOpacity: 78, radius: 12, scale: 100 },
    css: '',
    instances: [],           // [{ id, name, style: {}, css: '' }]
    // What the link builders on the Overlay tab were last set to.
    chatLink: { instance: '', max: 12, fade: 0, size: '', background: '', badges: true, platforms: { twitch: true, youtube: true, tiktok: true } },
    counterLink: { name: '', instance: '', label: '', size: '', color: '', font: '' },
  },
  obs: { enabled: false, url: 'ws://127.0.0.1:4455', autoConnect: true },
  sound: { device: '', volume: 100 },
  // Multistream: the three chats joined up (relay.js).
  multistream: {
    enabled: false,
    youtube: '',             // @handle, channel or stream link
    tiktok: '',              // username
    sendTwitch: true,
    twitchAs: 'auto',        // auto | bot | streamer
    sendYoutube: false,
    youtubeClientId: '',
    youtubeBatch: 8,         // seconds between YouTube posts; messages in between go together
    sendTiktok: false,
    tiktokBatch: 4,
    prefix: '[$platform] $user: ',
    labels: { twitch: 'Twitch', youtube: 'YouTube', tiktok: 'TikTok' },
    skipCommands: true,
    ignoreUsers: 'nightbot, streamelements, moobot, fossabot, streamlabs',
    relayEvents: true,
    overlayChat: true,
    quota: { day: '', units: 0 },
  },
  ui: {
    tab: 'dashboard',
    feedActivity: true,      // follows, redemptions and the rest as lines in the chat list
    backupViewers: true,     // backups include the viewer list
    setupDone: false,        // the setup guide was finished or closed (setup.js)
  },
};

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// Saved objects keep any keys they had, gain new defaults, and keep arrays
// as they were saved.
function mergeDefaults(defaults, saved) {
  if (!isPlainObject(saved)) return JSON.parse(JSON.stringify(defaults));
  const out = {};
  for (const [key, value] of Object.entries(defaults)) {
    if (isPlainObject(value)) out[key] = mergeDefaults(value, saved[key]);
    else if (key in saved && (Array.isArray(value) ? Array.isArray(saved[key]) : typeof saved[key] === typeof value || value === null)) out[key] = saved[key];
    else out[key] = JSON.parse(JSON.stringify(value));
  }
  for (const [key, value] of Object.entries(saved)) if (!(key in out)) out[key] = value;
  return out;
}

Bot.uid = (prefix = 'x') => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
Bot.clone = (v) => JSON.parse(JSON.stringify(v));

// Patterns from the setup (regex commands, banned words) are tested against
// every chat message, so each is compiled once. Throws on a bad pattern, like
// new RegExp does.
const regexCache = new Map();
Bot.regex = (source, flags = '') => {
  const id = `${flags}/${source}`;
  let re = regexCache.get(id);
  if (!re) {
    re = new RegExp(source, flags);
    if (regexCache.size >= 500) regexCache.delete(regexCache.keys().next().value);
    regexCache.set(id, re);
  }
  re.lastIndex = 0;
  return re;
};

Bot.on = (type, fn) => {
  if (!Bot.listeners.has(type)) Bot.listeners.set(type, new Set());
  Bot.listeners.get(type).add(fn);
  return () => Bot.listeners.get(type).delete(fn);
};

Bot.emit = (type, payload) => {
  for (const fn of Bot.listeners.get(type) || []) {
    try { fn(payload); } catch (err) { console.error(`Bot listener for ${type}:`, err); }
  }
};

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

const saveTimers = {};
const writers = {};
function scheduleWrite(name, write, delay) {
  clearTimeout(saveTimers[name]);
  writers[name] = write;
  saveTimers[name] = setTimeout(() => {
    delete saveTimers[name];
    write();
  }, delay);
}

Bot.save = () => {
  scheduleWrite('bot-config', () => Bot.desktop.writeStore('bot-config', JSON.stringify(Bot.data)), 400);
  Bot.emit('change');
};

// Each viewer is its own row in the database, so only the ones that changed
// are sent. Called with no viewers, the whole list is written again (after an
// import, a backup, or a change to everyone at once).
const dirtyViewers = new Set();
let allViewersDirty = false;

function writeViewers() {
  const users = Bot.viewers.users;
  if (allViewersDirty) {
    Bot.desktop.writeViewers({ replace: true, upsert: Object.entries(users).map(([key, v]) => [key, JSON.stringify(v)]) });
  } else if (dirtyViewers.size) {
    const upsert = [];
    const remove = [];
    for (const key of dirtyViewers) {
      if (users[key]) upsert.push([key, JSON.stringify(users[key])]);
      else remove.push(key);
    }
    Bot.desktop.writeViewers({ upsert, remove });
  }
  dirtyViewers.clear();
  allViewersDirty = false;
}

// Takes viewers or their keys, or a list of them. Written every few seconds at most.
Bot.saveViewers = (...changed) => {
  if (!changed.length) allViewersDirty = true;
  for (const v of changed.flat()) {
    const key = typeof v === 'string' ? v : v && v.key;
    if (key) dirtyViewers.add(key);
    else allViewersDirty = true;
  }
  scheduleWrite('bot-viewers', writeViewers, 8000);
};

// A reload or quitting the app shouldn't lose the last few seconds.
window.addEventListener('beforeunload', () => {
  for (const name of Object.keys(saveTimers)) {
    clearTimeout(saveTimers[name]);
    delete saveTimers[name];
    writers[name]();
  }
});

// ---------------------------------------------------------------------------
// Log and activity feed
// ---------------------------------------------------------------------------

Bot.log = (level, text) => {
  const line = { at: Date.now(), level, text: String(text) };
  Bot.logLines.push(line);
  if (Bot.logLines.length > 300) Bot.logLines.shift();
  if (level === 'error') console.warn('Bot:', text);
  Bot.emit('log', line);
};

// Something that happened on stream. `replay` re-runs the event's effects.
Bot.addActivity = (item) => {
  const entry = { id: Bot.uid('a'), at: Date.now(), ...item };
  Bot.activity.unshift(entry);
  if (Bot.activity.length > 200) Bot.activity.pop();
  Bot.emit('activity', entry);
  return entry;
};

// ---------------------------------------------------------------------------
// Small helpers the other files share
// ---------------------------------------------------------------------------

Bot.ROLES = [
  { id: 'everyone', name: 'Everyone', level: 0 },
  { id: 'subs', name: 'Subscribers', level: 1 },
  { id: 'vips', name: 'VIPs', level: 2 },
  { id: 'mods', name: 'Mods', level: 3 },
  { id: 'broadcaster', name: 'Broadcaster', level: 4 },
  { id: 'listed', name: 'Only the users listed', level: 5 },
];
Bot.roleLevel = (id) => (Bot.ROLES.find((r) => r.id === id) || { level: 0 }).level;
Bot.roleName = (id) => (Bot.ROLES.find((r) => r.id === id) || { name: id }).name;

// Whether a chatter may use something: their role is high enough, or they
// are in one of the custom roles, or named in the list of users.
Bot.allowed = (user, permission = 'everyone', users = '') => {
  if (!user) return permission === 'everyone';
  if ((user.role || 0) >= 4) return true;
  const login = String(user.login || '').toLowerCase();
  const names = String(users || '').toLowerCase().split(/[\s,]+/).filter(Boolean).map((n) => n.replace(/^@/, ''));
  if (names.includes(login)) return true;
  if (String(permission).startsWith('role:')) {
    const role = Bot.data.roles.find((r) => `role:${r.id}` === permission);
    return !!role && role.users.some((u) => u.toLowerCase().replace(/^@/, '') === login);
  }
  return (user.role || 0) >= Bot.roleLevel(permission);
};

Bot.duration = (seconds) => {
  let s = Math.max(0, Math.floor(seconds));
  const units = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]];
  const parts = [];
  for (const [name, size] of units) {
    if (s >= size && parts.length < 2) {
      const n = Math.floor(s / size);
      s -= n * size;
      parts.push(`${n} ${name}${n === 1 ? '' : 's'}`);
    }
  }
  return parts.join(', ') || '0 seconds';
};

Bot.wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Windows paths have backslashes and a drive letter; both become a file URL.
Bot.fileUrl = (file) => {
  if (!file) return '';
  if (/^https?:\/\//i.test(file)) return file;
  const p = String(file).replace(/\\/g, '/');
  return `file://${p.startsWith('/') ? '' : '/'}${p.split('/').map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/, '$1:')}`;
};

// ---------------------------------------------------------------------------
// Start-up: read the files, then every other part starts in order.
// ---------------------------------------------------------------------------

Bot.loadData = async () => {
  const [config, viewers] = await Promise.all([Bot.desktop.readStore('bot-config'), Bot.desktop.readStore('bot-viewers')]);
  let saved = null;
  try { saved = config ? JSON.parse(config) : null; } catch { Bot.log('error', 'The bot setup file couldn’t be read, so the bot starts empty. The old file is kept as bot-config.json until something changes.'); }
  Bot.data = mergeDefaults(BOT_DEFAULTS, saved);
  if (!Bot.data.overlay.apiKey) {
    Bot.data.overlay.apiKey = Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(16).padStart(2, '0')).join('');
    Bot.save();
  }
  try { Bot.viewers = viewers ? JSON.parse(viewers) : null; } catch { Bot.viewers = null; }
  if (!isPlainObject(Bot.viewers) || !isPlainObject(Bot.viewers.users)) Bot.viewers = { users: {} };
};

// Replace the whole setup, from a backup file. Returns what was taken.
Bot.replaceData = (raw, { withViewers = false } = {}) => {
  if (!isPlainObject(raw)) throw new Error('That file doesn’t hold a bot setup');
  const setup = isPlainObject(raw.setup) ? raw.setup : raw;
  const clientId = Bot.data.clientId;
  Bot.data = mergeDefaults(BOT_DEFAULTS, setup);
  // A backup from another computer shouldn't log anyone out here.
  if (!Bot.data.clientId) Bot.data.clientId = clientId;
  if (withViewers && isPlainObject(raw.viewers) && isPlainObject(raw.viewers.users)) {
    Bot.viewers = raw.viewers;
    Bot.saveViewers();
  }
  Bot.save();
  Bot.emit('reset');
};

Bot.mergeDefaults = mergeDefaults;
Bot.DEFAULTS = BOT_DEFAULTS;
