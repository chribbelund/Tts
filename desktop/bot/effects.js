'use strict';

// Effects: what commands, events, timers, rewards and hotkeys do. Each type
// declares its fields, which the workspace turns into a form (ui.js), and a
// run(effect, ctx) that does it. Text fields go through $variables first.
//
// ctx: { trigger, user, message, args, fields, command, listArgs, outputs, stopped }

const Effects = Bot.effects = { types: new Map(), queues: new Map(), running: 0 };

function type(id, spec) {
  Effects.types.set(id, { id, ...spec });
}

const render = (text, ctx) => Bot.vars.render(text, ctx);
const num = async (text, ctx, fallback = 0) => {
  const n = Number(String(await render(text, ctx)).replace(/[, ]/g, ''));
  return Number.isFinite(n) ? n : fallback;
};

// ---------------------------------------------------------------------------
// Running a list
// ---------------------------------------------------------------------------

Effects.newContext = (base = {}) => ({
  trigger: { type: 'manual', name: '' },
  user: null,
  message: null,
  args: [],
  fields: {},
  listArgs: [],
  outputs: {},
  stopped: false,
  depth: 0,
  ...base,
});

Effects.run = async (effects, ctx) => {
  if (!Array.isArray(effects) || ctx.depth > 12) return;
  for (const effect of effects) {
    if (ctx.stopped) break;
    if (!effect || effect.enabled === false) continue;
    const spec = Effects.types.get(effect.type);
    if (!spec) continue;
    Effects.running++;
    try {
      await spec.run(effect, ctx);
    } catch (err) {
      Bot.log('error', `${spec.name}${ctx.trigger && ctx.trigger.name ? ` (${ctx.trigger.name})` : ''}: ${err.message}`);
    } finally {
      Effects.running--;
    }
  }
};

// Lists with the same queue name run one after the other, so two alerts
// triggered at once don't talk over each other.
Effects.runQueued = (queue, effects, ctx) => {
  if (!queue) return Effects.run(effects, ctx);
  const before = Effects.queues.get(queue) || Promise.resolve();
  const next = before.then(() => Effects.run(effects, ctx));
  Effects.queues.set(queue, next.catch(() => {}));
  return next;
};

Effects.newEffect = (typeId) => {
  const spec = Effects.types.get(typeId);
  const effect = { id: Bot.uid('e'), type: typeId, enabled: true };
  for (const field of spec.fields) {
    if (field.default !== undefined) effect[field.key] = Bot.clone(field.default);
    else if (field.type === 'effects') effect[field.key] = [];
    else if (field.type === 'conditions') effect[field.key] = { mode: 'all', items: [] };
    else if (field.type === 'checkbox') effect[field.key] = false;
    else effect[field.key] = '';
  }
  return effect;
};

// ---------------------------------------------------------------------------
// Conditions: used by the "Conditional" effect and by event filters
// ---------------------------------------------------------------------------

const CONDITION_OPS = [
  ['==', 'is'], ['!=', 'is not'], ['contains', 'contains'], ['notContains', 'doesn’t contain'],
  ['startsWith', 'starts with'], ['matches', 'matches the regex'],
  ['>', 'is more than'], ['>=', 'is at least'], ['<', 'is less than'], ['<=', 'is at most'],
  ['empty', 'is empty'], ['notEmpty', 'isn’t empty'],
  ['role', 'the chatter is at least (role)'], ['chance', 'random chance (percent)'], ['following', 'the chatter follows (yes / no)'],
];
Effects.CONDITION_OPS = CONDITION_OPS;
Effects.opTakesLeft = (op) => !['role', 'chance', 'following'].includes(op);
Effects.opTakesRight = (op) => !['empty', 'notEmpty'].includes(op);

async function checkOne(item, ctx) {
  const op = item.op || '==';
  const left = Effects.opTakesLeft(op) ? await render(item.left || '', ctx) : '';
  const right = Effects.opTakesRight(op) ? await render(item.right || '', ctx) : '';
  switch (op) {
    case 'notContains': return !left.toLowerCase().includes(right.toLowerCase());
    case 'matches':
      try { return new RegExp(right, 'i').test(left); } catch { return false; }
    case 'empty': return !left.trim();
    case 'notEmpty': return !!left.trim();
    case 'role': return Bot.allowed(ctx.user, right || 'everyone');
    case 'chance': return Math.random() * 100 < Number(right);
    case 'following': {
      if (!ctx.user || ctx.user.platform !== 'twitch' || !ctx.user.id) return /^no|false$/i.test(right);
      const follows = (ctx.user.role || 0) >= 4 || !!(await Bot.twitch.follow(ctx.user.id));
      return /^no|false$/i.test(right) ? !follows : follows;
    }
    default: return Bot.vars.compare(left, op, right);
  }
}

Effects.check = async (conditions, ctx) => {
  const items = (conditions && conditions.items) || [];
  if (!items.length) return true;
  if (conditions.mode === 'any') {
    for (const item of items) if (await checkOne(item, ctx)) return true;
    return false;
  }
  for (const item of items) if (!(await checkOne(item, ctx))) return false;
  return true;
};

// ---------------------------------------------------------------------------
// Overlay: alerts go out one at a time per overlay instance
// ---------------------------------------------------------------------------

const overlayQueues = new Map();
Bot.overlay = {
  send: (event) => Bot.desktop.sendOverlay(event),
  // Resolves once the alert has finished showing.
  queue(instance, ms, event) {
    const key = instance || '';
    const before = overlayQueues.get(key) || Promise.resolve();
    const shown = before.then(async () => {
      Bot.overlay.send(event);
      await Bot.wait(ms + 400);
    });
    overlayQueues.set(key, shown.catch(() => {}));
    return shown;
  },
};

// How long a media file plays, for "wait for it to finish".
function mediaDuration(file, video = false) {
  return new Promise((resolve) => {
    const media = document.createElement(video ? 'video' : 'audio');
    media.preload = 'metadata';
    const done = (d) => { media.removeAttribute('src'); resolve(Number.isFinite(d) ? d : 0); };
    media.onloadedmetadata = () => done(media.duration);
    media.onerror = () => done(0);
    setTimeout(() => done(0), 4000);
    media.src = Bot.fileUrl(file);
  });
}

const playing = new Set();
Bot.stopSounds = () => { for (const a of playing) { a.pause(); playing.delete(a); } };

async function playInApp(source, volume, wait) {
  const audio = new Audio(Bot.fileUrl(source));
  audio.volume = Math.max(0, Math.min(1, (volume / 100) * ((Bot.data.sound.volume ?? 100) / 100)));
  if (Bot.data.sound.device && audio.setSinkId) {
    try { await audio.setSinkId(Bot.data.sound.device); } catch (err) { Bot.log('error', `Sound output: ${err.message}`); }
  }
  playing.add(audio);
  const ended = new Promise((resolve) => {
    audio.onended = resolve;
    audio.onerror = () => { Bot.log('error', `Couldn’t play ${source}`); resolve(); };
    audio.onpause = resolve;
  }).finally(() => playing.delete(audio));
  await audio.play().catch((err) => { Bot.log('error', `Couldn’t play ${source}: ${err.message}`); });
  if (wait) await ended;
}

// ---------------------------------------------------------------------------
// Shared field lists
// ---------------------------------------------------------------------------

const POSITIONS = [
  ['top-left', 'Top left'], ['top', 'Top'], ['top-right', 'Top right'],
  ['left', 'Left'], ['center', 'Middle'], ['right', 'Right'],
  ['bottom-left', 'Bottom left'], ['bottom', 'Bottom'], ['bottom-right', 'Bottom right'],
];
const ENTER = [['fade', 'Fade in'], ['slide-up', 'Slide up'], ['slide-down', 'Slide down'], ['slide-left', 'Slide in from the right'], ['slide-right', 'Slide in from the left'], ['zoom', 'Zoom'], ['bounce', 'Bounce'], ['none', 'Just appear']];
const EXIT = [['fade', 'Fade out'], ['slide-up', 'Slide up'], ['slide-down', 'Slide down'], ['zoom', 'Zoom out'], ['none', 'Just disappear']];
// Alerts and text follow the overlay style unless set to their own look.
// Effects saved before there was a choice keep the colours they were given.
const lookOf = (e) => e.look || 'custom';
const custom = (e) => lookOf(e) === 'custom';
const lookField = { key: 'look', label: 'Look', type: 'select', options: [['overlay', 'Overlay style (set on the Overlay tab)'], ['custom', 'Its own colours and size']], default: 'overlay' };
const instanceField = { key: 'instance', label: 'Overlay instance', type: 'text', placeholder: 'empty = every overlay', default: '', advanced: true };
const waitField = (label = 'Wait until it’s over before the next effect') => ({ key: 'wait', label, type: 'checkbox', default: false });
const userField = (label = 'User', def = '$username') => ({ key: 'username', label, type: 'text', default: def, vars: true });
const SENDERS = [['auto', 'The bot account, or me without one'], ['bot', 'The bot account'], ['streamer', 'Me (the streamer)']];

async function targetUser(e, ctx) {
  const login = (await render(e.username || '$username', ctx)).trim().replace(/^@/, '').toLowerCase();
  if (!login) throw new Error('no user given');
  if (ctx.user && ctx.user.login === login && ctx.user.platform === 'twitch' && ctx.user.id) return { id: ctx.user.id, login, display_name: ctx.user.displayName };
  const u = await Bot.twitch.user(login);
  if (!u) throw new Error(`no Twitch user called ${login}`);
  return u;
}

const senderRole = (as) => (as === 'auto' || !as ? Bot.twitch.chatRole() : as);

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

type('chat', {
  name: 'Send chat message', category: 'Chat', icon: '💬',
  fields: [
    { key: 'message', label: 'Message', type: 'textarea', vars: true, default: '' },
    { key: 'as', label: 'Send as', type: 'select', options: SENDERS, default: 'auto' },
    { key: 'reply', label: 'As a reply to the message that triggered this', type: 'checkbox', default: false },
  ],
  summary: (e) => e.message,
  async run(e, ctx) {
    const text = await render(e.message, ctx);
    const replyTo = e.reply && ctx.message && ctx.user && ctx.user.platform === 'twitch' ? ctx.message.id : '';
    await Bot.twitch.say(text, { replyTo, as: senderRole(e.as) });
  },
});

type('announce', {
  name: 'Send announcement', category: 'Chat', icon: '📣',
  fields: [
    { key: 'message', label: 'Announcement', type: 'textarea', vars: true, default: '' },
    { key: 'color', label: 'Colour', type: 'select', options: [['primary', 'Channel colour'], ['blue', 'Blue'], ['green', 'Green'], ['orange', 'Orange'], ['purple', 'Purple']], default: 'primary' },
  ],
  summary: (e) => e.message,
  async run(e, ctx) { await Bot.twitch.announce(await render(e.message, ctx), e.color); },
});

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

type('speak', {
  name: 'Speak with TTS', category: 'Reader', icon: '🗣️',
  fields: [
    { key: 'text', label: 'What to say', type: 'textarea', vars: true, default: '' },
    { key: 'voice', label: 'Voice', type: 'voice', default: '' },
    { key: 'priority', label: 'Say it before chat messages that are waiting', type: 'checkbox', default: true },
    waitField('Wait until it has been said'),
  ],
  summary: (e) => e.text,
  async run(e, ctx) {
    const done = Bot.host.speak(await render(e.text, ctx), { voice: e.voice, priority: e.priority });
    if (e.wait) await done;
  },
});

type('reader', {
  name: 'Control the reader', category: 'Reader', icon: '⏯️',
  fields: [
    { key: 'action', label: 'Action', type: 'select', options: [['pause', 'Pause'], ['resume', 'Resume'], ['toggle', 'Pause or resume'], ['skip', 'Skip the message being read'], ['clear', 'Clear waiting messages'], ['volume', 'Set volume'], ['speed', 'Set speed']], default: 'pause' },
    { key: 'value', label: 'Volume (0–100) or speed (0.6–2)', type: 'text', vars: true, default: '', showIf: (e) => e.action === 'volume' || e.action === 'speed' },
  ],
  summary: (e) => e.action + (e.value ? ` ${e.value}` : ''),
  async run(e, ctx) {
    const h = Bot.host;
    if (e.action === 'pause') h.setPaused(true);
    else if (e.action === 'resume') h.setPaused(false);
    else if (e.action === 'toggle') h.togglePause();
    else if (e.action === 'skip') h.skip();
    else if (e.action === 'clear') h.clear();
    else if (e.action === 'volume') h.setVolume(await num(e.value, ctx, h.state().volume));
    else if (e.action === 'speed') h.setRate(await num(e.value, ctx, h.state().rate));
  },
});

// What the reader does for one chatter, the same things a click on their
// name in chat changes. With a channel point reward that asks for text,
// "Their voice" + $message is a "pick your TTS voice" reward.
type('ttsChatter', {
  name: 'Change how a chatter is read', category: 'Reader', icon: '🎙️',
  fields: [
    { key: 'action', label: 'Change', type: 'select', options: [['voice', 'Their voice, to the one named'], ['nextVoice', 'Their voice, to the next one in the pool'], ['nickname', 'Their nickname'], ['clearNickname', 'Remove their nickname'], ['ignore', 'Stop reading them'], ['unignore', 'Read them again']], default: 'voice' },
    userField('Chatter'),
    { key: 'value', label: 'Voice name or nickname', type: 'text', vars: true, default: '$message', showIf: (e) => e.action === 'voice' || e.action === 'nickname' },
  ],
  summary: (e) => `${e.action} · ${e.username}`,
  async run(e, ctx) {
    const login = (await render(e.username || '$username', ctx)).trim().replace(/^@/, '').toLowerCase();
    if (!login) throw new Error('no chatter given');
    const value = (await render(e.value, ctx)).trim();
    const host = Bot.host;
    if (e.action === 'voice' || e.action === 'nextVoice') {
      if (e.action === 'voice' && !value) throw new Error('no voice name given');
      const name = host.setChatterVoice(login, e.action === 'voice' ? value : '');
      if (!name) throw new Error(`there’s no voice called “${value}”`);
      ctx.outputs.voice = name;
    } else if (e.action === 'nickname') {
      if (!value) throw new Error('no nickname given');
      host.setNickname(login, value);
    } else if (e.action === 'clearNickname') {
      host.setNickname(login, '');
    } else {
      host.setIgnored(login, e.action === 'ignore');
    }
  },
});

// ---------------------------------------------------------------------------
// Sound and overlay
// ---------------------------------------------------------------------------

type('sound', {
  name: 'Play sound', category: 'Sound and overlay', icon: '🔊',
  fields: [
    { key: 'file', label: 'Sound file', type: 'file', kind: 'sound', default: '' },
    { key: 'url', label: 'or a link to one', type: 'text', placeholder: 'https://…', default: '', advanced: true },
    { key: 'volume', label: 'Volume', type: 'range', min: 0, max: 100, default: 80 },
    { key: 'output', label: 'Play it', type: 'select', options: [['app', 'From this app (pick the device under Accounts)'], ['overlay', 'In the OBS overlay']], default: 'app' },
    waitField('Wait until it has finished'),
    instanceField,
  ],
  summary: (e) => (e.file || e.url || '').split(/[\\/]/).pop(),
  async run(e, ctx) {
    const source = e.url ? await render(e.url, ctx) : e.file;
    if (!source) return;
    if (e.output === 'overlay') {
      Bot.overlay.send({ type: 'sound', [e.url ? 'soundSrc' : 'soundFile']: source, volume: e.volume, instance: e.instance });
      if (e.wait) await Bot.wait((await mediaDuration(source)) * 1000);
      return;
    }
    await playInApp(source, e.volume, e.wait);
  },
});

type('alert', {
  name: 'Show overlay alert', category: 'Sound and overlay', icon: '🎉',
  description: 'A picture or video with a title and message, and a sound. Alerts on the same overlay wait for each other.',
  fields: [
    { key: 'title', label: 'Title', type: 'text', vars: true, default: '$user just followed!' },
    { key: 'message', label: 'Message', type: 'textarea', vars: true, default: '' },
    { key: 'file', label: 'Picture or video', type: 'file', kind: 'media', default: '' },
    { key: 'soundFile', label: 'Sound', type: 'file', kind: 'sound', default: '' },
    { key: 'volume', label: 'Volume', type: 'range', min: 0, max: 100, default: 80 },
    { key: 'duration', label: 'Show for (seconds)', type: 'number', min: 1, max: 120, default: 6 },
    { key: 'position', label: 'Position', type: 'select', options: POSITIONS, default: 'top' },
    { key: 'enter', label: 'Coming in', type: 'select', options: ENTER, default: 'bounce' },
    { key: 'exit', label: 'Going out', type: 'select', options: EXIT, default: 'fade' },
    lookField,
    { key: 'color', label: 'Highlight colour', type: 'color', default: '#a37bff', showIf: custom },
    { key: 'textColor', label: 'Text colour', type: 'color', default: '#ffffff', showIf: custom },
    { key: 'fontSize', label: 'Text size (px)', type: 'number', min: 10, max: 200, default: 36, showIf: custom },
    { key: 'speak', label: 'Also read the message out loud with TTS', type: 'checkbox', default: false },
    waitField('Wait until it has gone'),
    instanceField,
  ],
  summary: (e) => e.title,
  async run(e, ctx) {
    const [title, message] = await Promise.all([render(e.title, ctx), render(e.message, ctx)]);
    const seconds = Math.max(1, Number(e.duration) || 6);
    const event = {
      type: 'alert', id: Bot.uid('o'), title, message, file: e.file, soundFile: e.soundFile, volume: e.volume,
      duration: seconds, position: e.position, enter: e.enter, exit: e.exit, instance: e.instance,
      ...(custom(e) ? { color: e.color, textColor: e.textColor, fontSize: e.fontSize } : {}),
    };
    const shown = Bot.overlay.queue(e.instance, seconds * 1000, event);
    if (e.speak && message.trim()) Bot.host.speak(message, { priority: true });
    if (e.wait) await shown;
  },
});

type('media', {
  name: 'Show picture or video', category: 'Sound and overlay', icon: '🖼️',
  fields: [
    { key: 'file', label: 'Picture or video', type: 'file', kind: 'media', default: '' },
    { key: 'url', label: 'or a link to one', type: 'text', vars: true, placeholder: 'https://…', default: '', advanced: true },
    { key: 'duration', label: 'Show for (seconds, 0 = until a video ends)', type: 'number', min: 0, max: 600, default: 5 },
    { key: 'volume', label: 'Video volume', type: 'range', min: 0, max: 100, default: 80 },
    { key: 'position', label: 'Position', type: 'select', options: POSITIONS, default: 'center' },
    { key: 'width', label: 'Width (px, 0 = as it is)', type: 'number', min: 0, max: 4000, default: 0, advanced: true },
    { key: 'height', label: 'Height (px, 0 = as it is)', type: 'number', min: 0, max: 4000, default: 0, advanced: true },
    { key: 'enter', label: 'Coming in', type: 'select', options: ENTER, default: 'fade' },
    { key: 'exit', label: 'Going out', type: 'select', options: EXIT, default: 'fade' },
    waitField(),
    instanceField,
  ],
  summary: (e) => (e.file || e.url || '').split(/[\\/]/).pop(),
  async run(e, ctx) {
    const src = e.url ? await render(e.url, ctx) : e.file;
    if (!src) return;
    const video = /\.(mp4|webm|mov|m4v)(\?|$)/i.test(src);
    let seconds = Number(e.duration) || 0;
    if (!seconds && video && !e.url) seconds = await mediaDuration(src, true);
    if (!seconds) seconds = 5;
    Bot.overlay.send({
      type: 'media', id: Bot.uid('o'), [e.url ? 'src' : 'file']: src, video, duration: Number(e.duration) || 0, volume: e.volume,
      position: e.position, width: e.width, height: e.height, enter: e.enter, exit: e.exit, instance: e.instance,
    });
    if (e.wait) await Bot.wait(seconds * 1000 + 400);
  },
});

type('text', {
  name: 'Show text', category: 'Sound and overlay', icon: '🔤',
  fields: [
    { key: 'text', label: 'Text', type: 'textarea', vars: true, default: '' },
    { key: 'duration', label: 'Show for (seconds)', type: 'number', min: 1, max: 3600, default: 5 },
    { key: 'position', label: 'Position', type: 'select', options: POSITIONS, default: 'center' },
    lookField,
    { key: 'fontSize', label: 'Text size (px)', type: 'number', min: 8, max: 300, default: 48, showIf: custom },
    { key: 'color', label: 'Text colour', type: 'color', default: '#ffffff', showIf: custom },
    { key: 'background', label: 'Background', type: 'select', options: [['none', 'None, with a shadow'], ['dark', 'Dark box'], ['light', 'Light box']], default: 'none' },
    { key: 'enter', label: 'Coming in', type: 'select', options: ENTER, default: 'fade' },
    { key: 'exit', label: 'Going out', type: 'select', options: EXIT, default: 'fade' },
    waitField(),
    instanceField,
  ],
  summary: (e) => e.text,
  async run(e, ctx) {
    const text = await render(e.text, ctx);
    const seconds = Math.max(1, Number(e.duration) || 5);
    Bot.overlay.send({
      type: 'text', id: Bot.uid('o'), text, duration: seconds, position: e.position, background: e.background, enter: e.enter, exit: e.exit, instance: e.instance,
      ...(custom(e) ? { fontSize: e.fontSize, color: e.color } : {}),
    });
    if (e.wait) await Bot.wait(seconds * 1000 + 400);
  },
});

type('overlayClear', {
  name: 'Clear the overlay', category: 'Sound and overlay', icon: '🧹',
  fields: [instanceField, { key: 'sounds', label: 'Also stop sounds playing in the app', type: 'checkbox', default: true }],
  summary: () => '',
  async run(e) {
    Bot.overlay.send({ type: 'clear', instance: e.instance });
    if (e.sounds) Bot.stopSounds();
  },
});

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

type('delay', {
  name: 'Wait', category: 'Flow', icon: '⏱️',
  fields: [{ key: 'seconds', label: 'Seconds', type: 'text', vars: true, default: '2' }],
  summary: (e) => `${e.seconds} s`,
  async run(e, ctx) { await Bot.wait(Math.min(3600, Math.max(0, await num(e.seconds, ctx, 0))) * 1000); },
});

type('conditional', {
  name: 'If… then… else', category: 'Flow', icon: '🔀',
  fields: [
    { key: 'conditions', label: 'If', type: 'conditions' },
    { key: 'then', label: 'Then', type: 'effects' },
    { key: 'else', label: 'Otherwise', type: 'effects' },
  ],
  summary: (e) => `${(e.conditions.items || []).length} condition${(e.conditions.items || []).length === 1 ? '' : 's'}`,
  async run(e, ctx) {
    await Effects.run((await Effects.check(e.conditions, ctx)) ? e.then : e.else, ctx);
  },
});

// Each random effect remembers which ones it has used, in memory, so
// "don't repeat" goes through all of them before starting over.
const bags = new Map();
type('random', {
  name: 'Random effect', category: 'Flow', icon: '🎲',
  fields: [
    { key: 'mode', label: 'Pick', type: 'select', options: [['any', 'One at random'], ['bag', 'One at random, not repeating until all have run']], default: 'any' },
    { key: 'effects', label: 'Effects to pick from', type: 'effects' },
  ],
  summary: (e) => `one of ${e.effects.length}`,
  async run(e, ctx) {
    const list = e.effects.filter((x) => x.enabled !== false);
    if (!list.length) return;
    let pick;
    if (e.mode === 'bag') {
      let bag = bags.get(e.id);
      if (!bag || !bag.length) bag = list.map((x) => x.id).sort(() => Math.random() - 0.5);
      const id = bag.shift();
      bags.set(e.id, bag);
      pick = list.find((x) => x.id === id) || list[0];
    } else {
      pick = list[Math.floor(Math.random() * list.length)];
    }
    await Effects.run([pick], ctx);
  },
});

type('runList', {
  name: 'Run effect list', category: 'Flow', icon: '📋',
  fields: [
    { key: 'list', label: 'Effect list', type: 'list', default: '' },
    { key: 'args', label: 'Arguments ($listArg[1], $listArg[2]…), separated by commas', type: 'text', vars: true, default: '' },
    { key: 'background', label: 'Carry on without waiting for it', type: 'checkbox', default: false },
  ],
  summary: (e) => (Bot.data.lists.find((l) => l.id === e.list) || { name: '(none)' }).name,
  async run(e, ctx) {
    const list = Bot.data.lists.find((l) => l.id === e.list);
    if (!list) throw new Error('that effect list was deleted');
    const args = e.args ? (await render(e.args, ctx)).split(',').map((a) => a.trim()) : [];
    const child = { ...ctx, listArgs: args, stopped: false, depth: ctx.depth + 1 };
    const done = Effects.run(list.effects, child);
    if (!e.background) await done;
  },
});

type('stop', {
  name: 'Stop here', category: 'Flow', icon: '⛔',
  description: 'Nothing after this runs.',
  fields: [],
  summary: () => '',
  async run(e, ctx) { ctx.stopped = true; },
});

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

type('counter', {
  name: 'Update counter', category: 'Data', icon: '🔢',
  fields: [
    { key: 'name', label: 'Counter', type: 'counter', default: '' },
    { key: 'action', label: 'Action', type: 'select', options: [['add', 'Add'], ['subtract', 'Subtract'], ['set', 'Set to'], ['reset', 'Reset to 0']], default: 'add' },
    { key: 'amount', label: 'Amount', type: 'text', vars: true, default: '1', showIf: (e) => e.action !== 'reset' },
  ],
  summary: (e) => `${e.name} ${e.action}${e.action === 'reset' ? '' : ` ${e.amount}`}`,
  async run(e, ctx) {
    const amount = await num(e.amount, ctx, 1);
    Bot.counters.update(await render(e.name, ctx), e.action, amount);
  },
});

type('variable', {
  name: 'Set variable', category: 'Data', icon: '🏷️',
  description: 'Read it back anywhere with $var[name]. Kept when the app restarts.',
  fields: [
    { key: 'name', label: 'Name', type: 'text', default: '' },
    { key: 'action', label: 'Action', type: 'select', options: [['set', 'Set to'], ['add', 'Add (numbers)'], ['clear', 'Clear']], default: 'set' },
    { key: 'value', label: 'Value', type: 'text', vars: true, default: '', showIf: (e) => e.action !== 'clear' },
  ],
  summary: (e) => `${e.name} = ${e.value}`,
  async run(e, ctx) {
    const name = (await render(e.name, ctx)).trim().toLowerCase();
    if (!name) return;
    if (e.action === 'clear') delete Bot.data.variables[name];
    else if (e.action === 'add') Bot.data.variables[name] = (Number(Bot.data.variables[name]) || 0) + (await num(e.value, ctx, 0));
    else Bot.data.variables[name] = await render(e.value, ctx);
    Bot.save();
  },
});

type('currency', {
  name: 'Change points', category: 'Data', icon: '🪙',
  fields: [
    { key: 'action', label: 'Action', type: 'select', options: [['add', 'Give'], ['remove', 'Take away'], ['set', 'Set to']], default: 'add' },
    { key: 'amount', label: 'Amount', type: 'text', vars: true, default: '100' },
    { key: 'who', label: 'To', type: 'select', options: [['user', 'The user named below'], ['watching', 'Everyone watching now'], ['all', 'Everyone in the viewer list']], default: 'user' },
    { ...userField(), showIf: (e) => e.who === 'user' },
  ],
  summary: (e) => `${e.action} ${e.amount}`,
  async run(e, ctx) {
    const amount = await num(e.amount, ctx, 0);
    if (e.who === 'user') {
      const login = (await render(e.username, ctx)).trim().replace(/^@/, '').toLowerCase();
      const platform = ctx.user && ctx.user.login === login ? ctx.user.platform : 'twitch';
      Bot.viewersDb.changeCurrency(login, platform, e.action, amount, ctx.user && ctx.user.login === login ? ctx.user : null);
    } else {
      const list = e.who === 'watching' ? Bot.viewersDb.watching() : Object.values(Bot.viewers.users);
      for (const v of list) Bot.viewersDb.applyCurrency(v, e.action, amount);
      if (list.length) Bot.saveViewers(list);
      Bot.emit('viewers');
    }
  },
});

// ---------------------------------------------------------------------------
// Moderation and Twitch
// ---------------------------------------------------------------------------

type('moderate', {
  name: 'Moderate', category: 'Twitch', icon: '🛡️',
  fields: [
    { key: 'action', label: 'Action', type: 'select', options: [['timeout', 'Time out'], ['ban', 'Ban'], ['unban', 'Unban or end a timeout'], ['delete', 'Delete the message that triggered this'], ['vip', 'Make VIP'], ['unvip', 'Remove VIP'], ['clear', 'Clear the whole chat']], default: 'timeout' },
    { ...userField(), showIf: (e) => !['delete', 'clear'].includes(e.action) },
    { key: 'seconds', label: 'Seconds', type: 'text', vars: true, default: '60', showIf: (e) => e.action === 'timeout' },
    { key: 'reason', label: 'Reason', type: 'text', vars: true, default: '', showIf: (e) => e.action === 'timeout' || e.action === 'ban' },
  ],
  summary: (e) => `${e.action} ${['delete', 'clear'].includes(e.action) ? '' : e.username}`,
  async run(e, ctx) {
    if (e.action === 'delete') {
      if (ctx.message && ctx.user && ctx.user.platform === 'twitch') await Bot.twitch.deleteMessage(ctx.message.id);
      return;
    }
    if (e.action === 'clear') { await Bot.twitch.clearChat(); return; }
    const u = await targetUser(e, ctx);
    if (u.id === Bot.twitch.streamerId()) throw new Error('that’s you');
    if (e.action === 'timeout') await Bot.twitch.ban(u.id, { seconds: await num(e.seconds, ctx, 60), reason: await render(e.reason, ctx) });
    else if (e.action === 'ban') await Bot.twitch.ban(u.id, { reason: await render(e.reason, ctx) });
    else if (e.action === 'unban') await Bot.twitch.unban(u.id);
    else if (e.action === 'vip') await Bot.twitch.addVip(u.id);
    else if (e.action === 'unvip') await Bot.twitch.removeVip(u.id);
  },
});

type('shoutout', {
  name: 'Shoutout', category: 'Twitch', icon: '📢',
  fields: [
    { ...userField('Channel', '$target') },
    { key: 'message', label: 'Chat message (empty for none)', type: 'textarea', vars: true, default: 'Go check out $target at https://twitch.tv/$target — they were last playing $lastGame[$target]!' },
    { key: 'official', label: 'Also send Twitch’s own /shoutout (live only, at most every 2 minutes)', type: 'checkbox', default: true },
  ],
  summary: (e) => e.username,
  async run(e, ctx) {
    const u = await targetUser(e, ctx);
    const message = await render(e.message, ctx);
    if (message.trim()) await Bot.twitch.say(message);
    if (e.official) await Bot.twitch.shoutout(u.id).catch((err) => Bot.log('error', `Twitch shoutout: ${err.message}`));
  },
});

type('streamInfo', {
  name: 'Change title or category', category: 'Twitch', icon: '✏️',
  fields: [
    { key: 'title', label: 'Title (empty = keep it)', type: 'text', vars: true, default: '' },
    { key: 'game', label: 'Category (empty = keep it)', type: 'text', vars: true, default: '' },
  ],
  summary: (e) => [e.title, e.game].filter(Boolean).join(' · '),
  async run(e, ctx) {
    const [title, game] = await Promise.all([render(e.title, ctx), render(e.game, ctx)]);
    const fields = {};
    if (title.trim()) fields.title = title.trim().slice(0, 140);
    if (game.trim()) {
      const cat = await Bot.twitch.findCategory(game);
      if (!cat) throw new Error(`no category called “${game}”`);
      fields.game_id = cat.id;
    }
    if (Object.keys(fields).length) await Bot.twitch.updateChannel(fields);
  },
});

type('commercial', {
  name: 'Run an ad break', category: 'Twitch', icon: '📺',
  fields: [{ key: 'seconds', label: 'Length', type: 'select', options: [['30', '30 seconds'], ['60', '1 minute'], ['90', '1½ minutes'], ['120', '2 minutes'], ['150', '2½ minutes'], ['180', '3 minutes']], default: '60' }],
  summary: (e) => `${e.seconds} s`,
  async run(e) { await Bot.twitch.commercial(Number(e.seconds)); },
});

type('marker', {
  name: 'Add stream marker', category: 'Twitch', icon: '📍',
  fields: [{ key: 'description', label: 'Description', type: 'text', vars: true, default: '' }],
  summary: (e) => e.description,
  async run(e, ctx) { await Bot.twitch.marker(await render(e.description, ctx)); },
});

type('clip', {
  name: 'Create clip', category: 'Twitch', icon: '🎬',
  description: 'The link is kept as $effectOutput[clip].',
  fields: [{ key: 'message', label: 'Chat message once it’s made (empty for none)', type: 'text', vars: true, default: 'Clipped! $effectOutput[clip]' }],
  summary: (e) => e.message,
  async run(e, ctx) {
    const res = await Bot.twitch.clip(false);
    const clip = res.data && res.data[0];
    if (!clip) throw new Error('Twitch didn’t make a clip (is the stream live?)');
    ctx.outputs.clip = `https://clips.twitch.tv/${clip.id}`;
    const message = await render(e.message, ctx);
    if (message.trim()) await Bot.twitch.say(message);
  },
});

type('poll', {
  name: 'Poll', category: 'Twitch', icon: '📊',
  fields: [
    { key: 'action', label: 'Action', type: 'select', options: [['start', 'Start a poll'], ['end', 'End the poll and show the result'], ['cancel', 'Cancel the poll']], default: 'start' },
    { key: 'title', label: 'Question', type: 'text', vars: true, default: '', showIf: (e) => e.action === 'start' },
    { key: 'choices', label: 'Choices, separated by commas (2 to 5)', type: 'text', vars: true, default: 'Yes, No', showIf: (e) => e.action === 'start' },
    { key: 'seconds', label: 'Seconds', type: 'number', min: 15, max: 1800, default: 120, showIf: (e) => e.action === 'start' },
  ],
  summary: (e) => (e.action === 'start' ? e.title : e.action),
  async run(e, ctx) {
    if (e.action === 'start') {
      const choices = (await render(e.choices, ctx)).split(',').map((c) => c.trim()).filter(Boolean);
      if (choices.length < 2) throw new Error('a poll needs at least two choices');
      await Bot.twitch.createPoll(await render(e.title, ctx), choices, e.seconds);
    } else {
      await Bot.twitch.endPoll(e.action === 'end' ? 'TERMINATED' : 'ARCHIVED');
    }
  },
});

type('prediction', {
  name: 'Prediction', category: 'Twitch', icon: '🔮',
  fields: [
    { key: 'action', label: 'Action', type: 'select', options: [['start', 'Start a prediction'], ['lock', 'Lock it'], ['resolve', 'Pick the winning outcome'], ['cancel', 'Cancel it and refund']], default: 'start' },
    { key: 'title', label: 'Question', type: 'text', vars: true, default: '', showIf: (e) => e.action === 'start' },
    { key: 'outcomes', label: 'Outcomes, separated by commas', type: 'text', vars: true, default: 'Yes, No', showIf: (e) => e.action === 'start' },
    { key: 'seconds', label: 'Seconds to vote', type: 'number', min: 30, max: 1800, default: 120, showIf: (e) => e.action === 'start' },
    { key: 'winner', label: 'Winning outcome (its name or number)', type: 'text', vars: true, default: '$arg[1]', showIf: (e) => e.action === 'resolve' },
  ],
  summary: (e) => (e.action === 'start' ? e.title : e.action),
  async run(e, ctx) {
    if (e.action === 'start') {
      const outcomes = (await render(e.outcomes, ctx)).split(',').map((c) => c.trim()).filter(Boolean);
      if (outcomes.length < 2) throw new Error('a prediction needs at least two outcomes');
      await Bot.twitch.createPrediction(await render(e.title, ctx), outcomes, e.seconds);
    } else if (e.action === 'lock') await Bot.twitch.endPrediction('LOCKED');
    else if (e.action === 'resolve') await Bot.twitch.endPrediction('RESOLVED', await render(e.winner, ctx));
    else await Bot.twitch.endPrediction('CANCELED');
  },
});

type('raid', {
  name: 'Raid', category: 'Twitch', icon: '🚀',
  fields: [
    { key: 'action', label: 'Action', type: 'select', options: [['start', 'Raid a channel'], ['cancel', 'Cancel the raid']], default: 'start' },
    { ...userField('Channel', '$target'), showIf: (e) => e.action === 'start' },
  ],
  summary: (e) => (e.action === 'start' ? e.username : 'cancel'),
  async run(e, ctx) {
    if (e.action === 'cancel') { await Bot.twitch.cancelRaid(); return; }
    await Bot.twitch.raid((await targetUser(e, ctx)).id);
  },
});

type('reward', {
  name: 'Channel point reward', category: 'Twitch', icon: '🎁',
  description: 'Only rewards made in this app can be changed (Twitch’s rule).',
  fields: [
    { key: 'action', label: 'Action', type: 'select', options: [['fulfill', 'Mark this redemption complete'], ['refund', 'Refund this redemption'], ['enable', 'Turn a reward on'], ['disable', 'Turn a reward off'], ['pause', 'Pause a reward'], ['unpause', 'Unpause a reward'], ['cost', 'Change a reward’s cost']], default: 'fulfill' },
    { key: 'reward', label: 'Reward', type: 'reward', default: '', showIf: (e) => !['fulfill', 'refund'].includes(e.action) },
    { key: 'cost', label: 'New cost', type: 'text', vars: true, default: '', showIf: (e) => e.action === 'cost' },
  ],
  summary: (e) => e.action,
  async run(e, ctx) {
    if (e.action === 'fulfill' || e.action === 'refund') {
      const { rewardId, redemptionId } = ctx.fields || {};
      if (!rewardId || !redemptionId) throw new Error('this only works in a channel point redemption');
      await Bot.twitch.updateRedemption(rewardId, redemptionId, e.action === 'fulfill' ? 'FULFILLED' : 'CANCELED');
      return;
    }
    if (!e.reward) throw new Error('pick a reward');
    const fields = { enable: { is_enabled: true }, disable: { is_enabled: false }, pause: { is_paused: true }, unpause: { is_paused: false } }[e.action]
      || { cost: Math.max(1, Math.round(await num(e.cost, ctx, 1))) };
    await Bot.twitch.updateReward(e.reward, fields);
  },
});

// ---------------------------------------------------------------------------
// The bot itself
// ---------------------------------------------------------------------------

type('toggle', {
  name: 'Turn a command, event or timer on or off', category: 'Bot', icon: '🔁',
  fields: [
    { key: 'target', label: 'Which', type: 'trigger', default: '' },
    { key: 'action', label: 'Action', type: 'select', options: [['on', 'Turn on'], ['off', 'Turn off'], ['toggle', 'Switch']], default: 'toggle' },
  ],
  summary: (e) => e.action,
  async run(e) {
    const [kind, id] = String(e.target).split(':');
    const lists = { command: Bot.data.commands, event: Bot.data.events, timer: Bot.data.timers };
    const item = (lists[kind] || []).find((x) => x.id === id);
    if (!item) throw new Error('that one was deleted');
    item.enabled = e.action === 'toggle' ? !item.enabled : e.action === 'on';
    Bot.save();
  },
});

type('raffle', {
  name: 'Raffle', category: 'Bot', icon: '🎟️',
  fields: [
    { key: 'action', label: 'Action', type: 'select', options: [['start', 'Open entries'], ['close', 'Close entries'], ['draw', 'Draw the winners'], ['clear', 'Clear the entries']], default: 'start' },
    { key: 'prize', label: 'What’s being given away', type: 'text', vars: true, default: '', showIf: (e) => e.action === 'start' },
  ],
  summary: (e) => e.action,
  async run(e, ctx) { await Bot.games.raffleAction(e.action, await render(e.prize || '', ctx)); },
});

type('activity', {
  name: 'Note in the activity feed', category: 'Bot', icon: '📝',
  fields: [{ key: 'text', label: 'Text', type: 'text', vars: true, default: '' }],
  summary: (e) => e.text,
  async run(e, ctx) { Bot.addActivity({ kind: 'note', text: await render(e.text, ctx) }); },
});

type('notify', {
  name: 'Desktop notification', category: 'Bot', icon: '🔔',
  fields: [
    { key: 'title', label: 'Title', type: 'text', vars: true, default: '' },
    { key: 'body', label: 'Text', type: 'textarea', vars: true, default: '' },
  ],
  summary: (e) => e.title,
  async run(e, ctx) { Bot.desktop.notify(await render(e.title, ctx), await render(e.body, ctx)); },
});

// ---------------------------------------------------------------------------
// Other apps
// ---------------------------------------------------------------------------

function pathInto(value, path) {
  let v = value;
  for (const part of String(path).split('.').filter(Boolean)) {
    if (v === null || v === undefined) return '';
    v = v[/^\d+$/.test(part) && Array.isArray(v) ? Number(part) : part];
  }
  return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : v;
}

type('http', {
  name: 'HTTP request', category: 'Other apps', icon: '🌐',
  description: 'The answer is kept as $effectOutput[name] for the effects after it.',
  fields: [
    { key: 'method', label: 'Method', type: 'select', options: [['GET', 'GET'], ['POST', 'POST'], ['PUT', 'PUT'], ['PATCH', 'PATCH'], ['DELETE', 'DELETE']], default: 'GET' },
    { key: 'url', label: 'URL', type: 'text', vars: true, default: 'https://' },
    { key: 'headers', label: 'Headers, one “Name: value” per line', type: 'textarea', vars: true, default: '', advanced: true },
    { key: 'body', label: 'Body', type: 'textarea', vars: true, default: '', showIf: (e) => e.method !== 'GET' },
    { key: 'output', label: 'Keep the answer as', type: 'text', default: 'http' },
    { key: 'path', label: 'Only this part of a JSON answer (e.g. data.0.name)', type: 'text', default: '', advanced: true },
  ],
  summary: (e) => `${e.method} ${e.url}`,
  async run(e, ctx) {
    const headers = {};
    for (const line of (await render(e.headers, ctx)).split('\n')) {
      const at = line.indexOf(':');
      if (at > 0) headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    const res = await Bot.desktop.http({ method: e.method, url: await render(e.url, ctx), headers, body: e.method === 'GET' ? '' : await render(e.body, ctx) });
    if (res.error) throw new Error(res.error);
    let value = res.text;
    if (e.path) {
      try { value = pathInto(JSON.parse(res.text), e.path); } catch { value = ''; }
    }
    if (e.output) ctx.outputs[e.output] = value;
    if (!res.ok) Bot.log('error', `HTTP request answered ${res.status}`);
  },
});

type('discord', {
  name: 'Discord message', category: 'Other apps', icon: '🗨️',
  description: 'Through a webhook: in Discord, Channel settings → Integrations → Webhooks.',
  fields: [
    { key: 'url', label: 'Webhook URL', type: 'text', default: '' },
    { key: 'message', label: 'Message', type: 'textarea', vars: true, default: '$streamer is live! https://twitch.tv/$username' },
    { key: 'name', label: 'Name to post as (empty = the webhook’s)', type: 'text', vars: true, default: '', advanced: true },
  ],
  summary: (e) => e.message,
  async run(e, ctx) {
    if (!/^https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\//.test(e.url)) throw new Error('that isn’t a Discord webhook URL');
    const body = { content: (await render(e.message, ctx)).slice(0, 2000) };
    const name = await render(e.name, ctx);
    if (name.trim()) body.username = name.trim().slice(0, 80);
    const res = await Bot.desktop.http({ method: 'POST', url: e.url, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (res.error || !res.ok) throw new Error(res.error || `Discord answered ${res.status}`);
  },
});

type('writeFile', {
  name: 'Write to a text file', category: 'Other apps', icon: '📄',
  description: 'For OBS text sources (“Read from file”), or a log.',
  fields: [
    { key: 'file', label: 'File', type: 'savefile', kind: 'text', default: '' },
    { key: 'text', label: 'Text', type: 'textarea', vars: true, default: '' },
    { key: 'mode', label: 'How', type: 'select', options: [['replace', 'Replace what’s in it'], ['append', 'Add a line at the end']], default: 'replace' },
  ],
  summary: (e) => (e.file || '').split(/[\\/]/).pop(),
  async run(e, ctx) {
    if (!e.file) throw new Error('pick a file');
    const res = await Bot.desktop.writeFile({ file: e.file, text: await render(e.text, ctx), append: e.mode === 'append' });
    if (res.error) throw new Error(res.error);
  },
});

type('obs', {
  name: 'OBS', category: 'Other apps', icon: '🎥',
  description: 'Needs OBS’s WebSocket server (Tools → WebSocket Server Settings) and the OBS page (under Stream) set up.',
  fields: [
    {
      key: 'action', label: 'Action', type: 'select', default: 'scene', options: [
        ['scene', 'Switch scene'], ['show', 'Show a source'], ['hide', 'Hide a source'], ['toggleSource', 'Show or hide a source'],
        ['filterOn', 'Turn a filter on'], ['filterOff', 'Turn a filter off'], ['toggleFilter', 'Switch a filter'],
        ['mute', 'Mute an audio source'], ['unmute', 'Unmute an audio source'], ['toggleMute', 'Mute or unmute'],
        ['startStream', 'Start streaming'], ['stopStream', 'Stop streaming'], ['startRecord', 'Start recording'], ['stopRecord', 'Stop recording'],
        ['toggleRecord', 'Start or stop recording'], ['saveReplay', 'Save the replay buffer'],
      ],
    },
    { key: 'scene', label: 'Scene (empty = the current one)', type: 'obsScene', default: '', showIf: (e) => ['scene', 'show', 'hide', 'toggleSource'].includes(e.action) },
    { key: 'source', label: 'Source', type: 'obsSource', default: '', showIf: (e) => !['scene', 'startStream', 'stopStream', 'startRecord', 'stopRecord', 'toggleRecord', 'saveReplay'].includes(e.action) },
    { key: 'filter', label: 'Filter', type: 'text', default: '', showIf: (e) => ['filterOn', 'filterOff', 'toggleFilter'].includes(e.action) },
  ],
  summary: (e) => [e.action, e.scene, e.source, e.filter].filter(Boolean).join(' · '),
  async run(e, ctx) { await Bot.obs.run(e.action, { scene: await render(e.scene, ctx), source: await render(e.source, ctx), filter: await render(e.filter, ctx) }); },
});

// What an importer couldn't convert (see importers.js): kept, so it's clear
// what the original did, but it does nothing here.
type('unsupported', {
  name: 'From another bot (not converted)', category: 'Bot', icon: '⚠️', hidden: true,
  description: 'This came from another bot and has no equal here, so it does nothing. Rebuild it with the effects here, then delete this one.',
  fields: [],
  summary: (e) => `${e.source || 'Imported'}: ${e.original || ''}`,
  async run() {},
});

Effects.CATEGORIES = ['Chat', 'Reader', 'Sound and overlay', 'Flow', 'Data', 'Twitch', 'Bot', 'Other apps'];
