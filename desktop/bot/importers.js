'use strict';

// Importing from other bots. The main process finds and reads the files
// (import-main.js); this turns what's in them into the bot's own commands,
// events, timers, effect lists, counters, quotes, roles, hotkeys and viewers.
//
// Firebot's formats come from its source (github.com/crowbartools/Firebot).
// Mix It Up's source isn't public any more, so its importer goes by the shape
// of the data: Mix It Up saves every object with a "$type" naming its class
// (…ChatCommandModel, …ChatActionModel), which is what's matched on.
// Anything that has no counterpart here is kept as a placeholder effect that
// says what it was, rather than dropped without a word.

const Imp = Bot.importers = {};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const parseJson = (text) => { try { return JSON.parse(text); } catch { return null; } };
const values = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);
const str = (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const stripHtml = (s) => str(s).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

// NeDB, which older Firebot uses: one JSON document per line, later lines
// replacing earlier ones with the same _id, and "$$deleted" removing them.
function nedb(text) {
  const docs = new Map();
  for (const line of String(text || '').split('\n')) {
    const doc = parseJson(line.trim());
    if (!doc || doc._id === undefined) continue;
    if (doc.$$deleted) docs.delete(doc._id);
    else docs.set(doc._id, doc);
  }
  return [...docs.values()];
}

function newEffect(type, fields = {}) {
  return { ...Bot.effects.newEffect(type), ...fields };
}

function unsupported(source, original, data) {
  return { id: Bot.uid('e'), type: 'unsupported', enabled: true, source, original: String(original || 'unknown'), data: Bot.clone(data || {}) };
}

// The counts and notes shown before anything is imported.
function newResult(source, name) {
  return {
    source, name,
    commands: [], events: [], timers: [], lists: [], counters: [], quotes: [], roles: [], hotkeys: [], viewers: [],
    rewardActions: {}, currency: null,
    unsupported: new Map(),   // what couldn't be converted -> how many times
    notes: [],
  };
}

function noteUnsupported(result, what) {
  result.unsupported.set(what, (result.unsupported.get(what) || 0) + 1);
}

// ---------------------------------------------------------------------------
// Firebot
// ---------------------------------------------------------------------------

// Firebot's $variables are mostly the same as here; these few differ.
function firebotText(text, ctx = {}) {
  let t = str(text);
  t = t.replace(/\$customVariable\[/g, '$var[');
  t = t.replace(/\$(chatMessage|rewardMessage)\b/g, '$message');
  t = t.replace(/\$cheerBitsAmount\b/g, '$bits');
  t = t.replace(/\$raidViewerCount\b/g, '$viewers');
  t = t.replace(/\$subMonths\b/g, '$months');
  t = t.replace(/\$streamTitle\b/g, '$title');
  t = t.replace(/\$subType\b/g, '$tier');
  t = t.replace(/\$giftReceiverUsername\b/g, '$user');
  // $currency[points, alice] -> $currency[alice]
  t = t.replace(/\$currency\[\s*[^,\]]+,\s*([^\]]+)\]/g, '$currency[$1]');
  // $presetListArg[name] -> $listArg[n]
  if (ctx.listArgs) t = t.replace(/\$presetListArg\[([^\]]+)\]/g, (m, name) => {
    const i = ctx.listArgs.indexOf(name.trim());
    return i === -1 ? m : `$listArg[${i + 1}]`;
  });
  return t;
}

const FB_POSITIONS = {
  'Top Left': 'top-left', 'Top Middle': 'top', 'Top Right': 'top-right', 'Middle Left': 'left', Middle: 'center',
  'Middle Right': 'right', 'Bottom Left': 'bottom-left', 'Bottom Middle': 'bottom', 'Bottom Right': 'bottom-right',
};
const fbPosition = (p) => FB_POSITIONS[p] || 'center';

const FB_COMPARE = {
  is: '==', 'is not': '!=', 'is strictly': '==', 'is not strictly': '!=', 'is less than': '<', 'is less than or equal to': '<=',
  'is greater than': '>', 'is greater than or equal to': '>=', contains: 'contains', 'does not contain': 'notContains',
  'contains (case-insensitive)': 'contains', 'does not contain (case-insensitive)': 'notContains', 'matches regex': 'matches',
  'matches regex (case-insensitive)': 'matches', 'starts with': 'startsWith', 'less than': '<', 'greater than': '>',
  'less than or equal to': '<=', 'greater than or equal to': '>=', "doesn't include": 'notContains', includes: 'contains',
};
const fbOp = (c) => FB_COMPARE[String(c || 'is').toLowerCase()] || '==';

const FB_ROLE_LEVEL = { broadcaster: 'broadcaster', mod: 'mods', vip: 'vips', sub: 'subs', tier1: 'subs', tier2: 'subs', tier3: 'subs' };

// Firebot's role ids: the lowest built-in role named is who may use it.
function fbPermission(roleIds, ctx) {
  const order = ['subs', 'vips', 'mods', 'broadcaster'];
  const levels = (roleIds || []).map((r) => FB_ROLE_LEVEL[r]).filter(Boolean).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  if (levels.length) return levels[0];
  const custom = (roleIds || []).map((r) => ctx.roleIds && ctx.roleIds[r]).find(Boolean);
  return custom ? `role:${custom}` : 'everyone';
}

function fbConditions(conditionData, ctx) {
  const out = { mode: conditionData && conditionData.mode === 'inclusive' ? 'any' : 'all', items: [] };
  for (const c of (conditionData && conditionData.conditions) || []) {
    const type = String(c.type || '');
    if (type === 'firebot:custom') out.items.push({ left: firebotText(c.leftSideValue, ctx), op: fbOp(c.comparisonType), right: firebotText(c.rightSideValue, ctx) });
    else if (type === 'firebot:username') out.items.push({ left: '$username', op: fbOp(c.comparisonType), right: str(c.rightSideValue) });
    else if (type === 'firebot:args-count') out.items.push({ left: '$argCount', op: fbOp(c.comparisonType), right: str(c.rightSideValue) });
    else if (type === 'firebot:viewerroles') out.items.push({ op: 'role', right: fbPermission([c.rightSideValue], ctx) });
    else if (type === 'firebot:follow-check') out.items.push({ op: 'following', right: /not|false/i.test(str(c.comparisonType)) ? 'no' : 'yes' });
    else noteUnsupported(ctx.result, `Firebot condition ${type}`);
  }
  return out;
}

// One Firebot effect, or a list of them, converted.
function fbEffects(list, ctx) {
  const items = Array.isArray(list) ? list : (list && list.list) || [];
  return items.map((e) => fbEffect(e, ctx)).filter(Boolean);
}

function fbEffect(e, ctx) {
  const t = (s) => firebotText(s, ctx);
  const type = String(e.type || '');
  let out = null;
  switch (type) {
    case 'firebot:chat':
      out = newEffect('chat', { message: t(e.message), as: /streamer/i.test(str(e.chatter)) ? 'streamer' : 'auto', reply: !!e.sendAsReply });
      if (e.whisper) noteUnsupported(ctx.result, 'Firebot whispers (sent to chat instead)');
      break;
    case 'firebot:delay': out = newEffect('delay', { seconds: str(e.delay || 0) }); break;
    case 'firebot:playsound': {
      const overlay = e.audioOutputDevice && e.audioOutputDevice.deviceId === 'overlay';
      out = newEffect('sound', {
        file: e.soundType === 'url' ? '' : str(e.filepath), url: e.soundType === 'url' ? str(e.url) : '',
        volume: Math.round(Math.max(0, Math.min(10, Number(e.volume) || 5)) * 10), wait: !!e.waitForSound,
        output: overlay ? 'overlay' : 'app', instance: str(e.overlayInstance),
      });
      if (e.soundType === 'folderRandom') noteUnsupported(ctx.result, 'Firebot random sound from a folder');
      break;
    }
    case 'firebot:text-to-speech': out = newEffect('speak', { text: t(e.text), wait: !!e.wait }); break;
    case 'firebot:show-text': case 'firebot:showtext':
      out = newEffect('text', {
        text: t(stripHtml(e.text)), duration: Number(e.duration) || 5, position: fbPosition(e.position),
        fontSize: Number(e.fontOptions && parseInt(e.fontOptions.size, 10)) || 48, color: (e.fontOptions && e.fontOptions.color) || '#ffffff', instance: str(e.overlayInstance),
      });
      break;
    case 'firebot:showImage': case 'firebot:show-image':
      out = newEffect('media', {
        file: e.imageType === 'url' ? '' : str(e.file), url: e.imageType === 'url' ? t(e.url) : '', duration: Number(e.length) || 5,
        position: fbPosition(e.position), width: Number(e.width) || 0, height: Number(e.height) || 0, instance: str(e.overlayInstance),
      });
      break;
    case 'firebot:playvideo':
      if (e.videoType && e.videoType !== 'Local Video') { noteUnsupported(ctx.result, `Firebot video: ${e.videoType}`); out = unsupported('Firebot', `Play video (${e.videoType})`, e); break; }
      out = newEffect('media', { file: str(e.file), duration: Number(e.length) || 0, volume: Math.round((Number(e.volume) || 5) * 10), position: fbPosition(e.position), width: Number(e.width) || 0, height: Number(e.height) || 0, wait: !!e.wait, instance: str(e.overlayInstance) });
      break;
    case 'firebot:overlayalert':
      out = newEffect('alert', {
        title: t(stripHtml(e.text)), message: '', file: str(e.mediaType === 'video' ? e.videoFile : e.imageFile), soundFile: e.playSound ? str(e.soundFile) : '',
        volume: Math.round((Number(e.soundVolume) || 5) * 10), duration: Number(e.duration) || 6, position: fbPosition(e.position), instance: str(e.overlayInstance),
      });
      break;
    case 'firebot:update-counter':
      out = newEffect('counter', { name: (ctx.counterNames && ctx.counterNames[e.counterId]) || str(e.counterId), action: e.mode === 'set' ? 'set' : 'add', amount: t(e.value) });
      break;
    case 'firebot:currency':
      out = newEffect('currency', {
        action: { Add: 'add', Remove: 'remove', Set: 'set' }[e.action] || 'add', amount: t(e.amount),
        who: e.target === 'allOnline' ? 'watching' : e.target === 'allViewers' ? 'all' : 'user', username: t(e.userTarget || '$username'),
      });
      break;
    case 'firebot:customvariable': out = newEffect('variable', { name: str(e.name), action: 'set', value: t(str(e.variableData)) }); break;
    case 'firebot:modban': out = newEffect('moderate', { action: e.action === 'Unban' ? 'unban' : 'ban', username: t(e.username), reason: t(e.reason) }); break;
    case 'firebot:modTimeout': out = newEffect('moderate', { action: 'timeout', username: t(e.username), seconds: t(e.time), reason: t(e.reason) }); break;
    case 'firebot:modpurge': out = newEffect('moderate', { action: 'timeout', username: t(e.username), seconds: '1', reason: '' }); break;
    case 'firebot:delete-chat-message': out = newEffect('moderate', { action: 'delete' }); break;
    case 'firebot:clearchat': out = newEffect('moderate', { action: 'clear' }); break;
    case 'firebot:shoutout': out = newEffect('shoutout', { username: t(e.username || '$target'), official: true }); break;
    case 'firebot:http-request': {
      const headers = values(e.headers).map((hd) => `${hd.name || hd.key}: ${hd.value}`).join('\n');
      out = newEffect('http', { method: str(e.method || 'GET').toUpperCase(), url: t(e.url), headers: t(headers), body: t(str(e.body)), output: 'httpResponse' });
      break;
    }
    case 'firebot:clip': out = newEffect('clip', { message: e.postLink ? 'Clipped! $effectOutput[clip]' : '' }); break;
    case 'firebot:toggle-command': case 'firebot:toggle-timer': case 'firebot:toggle-event': {
      const kind = type.endsWith('command') ? 'command' : type.endsWith('timer') ? 'timer' : 'event';
      const fbId = e.commandId || e.selectedTimerId || e.selectedEventId;
      out = newEffect('toggle', { target: `${kind}:${ctx.idMap[`${kind}:${fbId}`] || fbId}`, action: { enable: 'on', disable: 'off' }[e.toggleType] || 'toggle' });
      break;
    }
    case 'firebot:run-effect-list':
      if (e.listType === 'custom' || (!e.presetListId && e.effectList)) {
        // An inline group runs as an always-true "if".
        out = newEffect('conditional', { conditions: { mode: 'all', items: [] }, then: fbEffects(e.effectList, ctx), else: [] });
      } else {
        out = newEffect('runList', { list: ctx.idMap[`list:${e.presetListId}`] || `fb-${e.presetListId}`, args: values(e.presetListArgs).map((a) => t(a)).join(', '), background: !!e.dontWait });
      }
      break;
    case 'firebot:randomeffect': out = newEffect('random', { mode: e.dontRepeat ? 'bag' : 'any', effects: fbEffects(e.effectList, ctx) }); break;
    case 'firebot:conditional-effects': {
      // if / else if / else becomes nested "if… then… else".
      let otherwise = fbEffects(e.otherwiseEffectData, ctx);
      for (const clause of [...(e.ifs || [])].reverse()) {
        const cond = newEffect('conditional', { conditions: fbConditions(clause.conditionData, ctx), then: fbEffects(clause.effectData, ctx), else: otherwise });
        otherwise = [cond];
      }
      out = otherwise[0] || null;
      break;
    }
    case 'firebot:stop-effect-execution': out = newEffect('stop'); break;
    case 'firebot:activity-feed-alert': out = newEffect('activity', { text: t(e.message) }); break;
    case 'firebot:show-toast': out = newEffect('notify', { title: 'Firebot', body: t(e.message) }); break;
    case 'firebot:filewriter':
      out = newEffect('writeFile', { file: str(e.filepath), text: t(e.text), mode: e.writeMode === 'append' ? 'append' : 'replace' });
      noteUnsupported(ctx.result, 'Firebot file writers: pick the file again in the effect (the app may only write files you chose)');
      break;
    case 'firebot:comment': case 'firebot:log-message': return null;
    default: {
      if (/obs-change-scene$/.test(type)) out = newEffect('obs', { action: 'scene', scene: str(e.sceneName || (e.custom && e.customScene)) });
      else if (/obs-start-stream$/.test(type)) out = newEffect('obs', { action: 'startStream' });
      else if (/obs-stop-stream$/.test(type)) out = newEffect('obs', { action: 'stopStream' });
      else if (/save-replay-buffer$/.test(type)) out = newEffect('obs', { action: 'saveReplay' });
      else if (/stream-?title$/i.test(type)) out = newEffect('streamInfo', { title: t(e.title) });
      else if (/stream-?game$|category$/i.test(type)) out = newEffect('streamInfo', { game: t(e.gameName || e.game) });
      else if (/marker/i.test(type)) out = newEffect('marker', { description: t(e.description) });
      else if (/commercial|ad-?break/i.test(type)) out = newEffect('commercial', { seconds: String(Math.min(180, Math.max(30, Math.round((Number(e.duration || e.length) || 60) / 30) * 30))) });
      else {
        noteUnsupported(ctx.result, `Firebot effect ${type}`);
        out = unsupported('Firebot', e.effectLabel || type, e);
      }
    }
  }
  if (out && e.active === false) out.enabled = false;
  return out;
}

// Firebot event ids -> the ones here. A Firebot "sub" is both new subs and resubs.
const FB_EVENTS = {
  'twitch:follow': ['follow'], 'twitch:sub': ['sub', 'resub'], 'twitch:subs-gifted': ['giftSub'], 'twitch:community-subs-gifted': ['giftSub'],
  'twitch:cheer': ['cheer'], 'twitch:raid': ['raid'], 'twitch:channel-reward-redemption': ['redemption'], 'twitch:chat-message': ['chatMessage'],
  'twitch:first-time-chat': ['firstChat'], 'twitch:viewer-arrived': ['viewerArrived'], 'twitch:stream-online': ['streamOnline'],
  'twitch:stream-offline': ['streamOffline'], 'twitch:hype-train-start': ['hypeTrainStart'], 'twitch:hype-train-end': ['hypeTrainEnd'],
  'twitch:channel-poll-begin': ['pollStart'], 'twitch:channel-poll-end': ['pollEnd'], 'twitch:channel-prediction-begin': ['predictionStart'],
  'twitch:channel-prediction-end': ['predictionEnd'], 'twitch:ad-break-start': ['adBreak'], 'twitch:shoutout-received': ['shoutoutReceived'],
  'twitch:banned': ['ban'], 'twitch:timeout': ['ban'], 'twitch:unbanned': ['unban'], 'twitch:title-changed': ['channelUpdate'],
  'twitch:category-changed': ['channelUpdate'], 'firebot:category-changed': ['channelUpdate'], 'twitch:charity-donation': ['charityDonation'],
  'firebot:firebot-started': ['appStarted'],
};

// Event filters that have an equal here: the value they compare.
const FB_FILTERS = {
  'firebot:cheerbitsamount': '$bits', 'firebot:raid-viewer-count': '$viewers', 'firebot:viewer-count': '$viewers', 'firebot:sub-type': '$tier',
  'firebot:sub-kind': '$tier', 'firebot:reward': '$rewardId', 'firebot:rewardName': '$rewardName', 'firebot:reward-name': '$rewardName',
  'firebot:username': '$username', 'firebot:chatmessage': '$message', 'firebot:message': '$message', 'firebot:gift-count': '$giftCount',
  'firebot:subs-gifted-count': '$giftCount', 'firebot:months': '$months',
};

function fbEvent(e, ctx) {
  const key = e.sourceId && e.eventId ? `${e.sourceId}:${e.eventId}` : str(e.type);
  const types = FB_EVENTS[key];
  if (!types) { noteUnsupported(ctx.result, `Firebot event ${key}`); return []; }
  const filters = { mode: e.filterData && e.filterData.mode === 'inclusive' ? 'any' : 'all', items: [] };
  for (const f of (e.filterData && e.filterData.filters) || []) {
    const left = FB_FILTERS[f.type];
    if (!left) { noteUnsupported(ctx.result, `Firebot event filter ${f.type}`); continue; }
    const value = f.value && typeof f.value === 'object' ? str(f.value.id || f.value.value || f.value.name) : str(f.value);
    filters.items.push({ left, op: fbOp(f.comparisonType), right: value });
  }
  return types.map((type, i) => ({
    id: (i === 0 && ctx.idMap[`event:${e.id}`]) || Bot.uid('v'), enabled: e.active !== false, type, name: str(e.name) || '',
    filters: Bot.clone(filters), queue: e.effects && e.effects.queue ? 'firebot' : '', effects: fbEffects(e.effects, ctx),
  }));
}

// Electron accelerator ("CommandOrControl+Shift+F1") -> a key binding here.
function acceleratorBinding(code) {
  const parts = str(code).split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const key = parts.pop();
  const mods = parts.map((p) => p.toLowerCase());
  const mac = window.chatReaderDesktop && window.chatReaderDesktop.platform === 'darwin';
  const binding = {
    ctrl: mods.includes('ctrl') || mods.includes('control') || (!mac && (mods.includes('commandorcontrol') || mods.includes('cmdorctrl'))),
    alt: mods.includes('alt') || mods.includes('option'),
    shift: mods.includes('shift'),
    meta: mods.includes('super') || mods.includes('meta') || mods.includes('command') || mods.includes('cmd') || (mac && (mods.includes('commandorcontrol') || mods.includes('cmdorctrl'))),
  };
  let c = key;
  if (/^[a-z]$/i.test(key)) c = `Key${key.toUpperCase()}`;
  else if (/^\d$/.test(key)) c = `Digit${key}`;
  else if (/^num\d$/i.test(key)) c = `Numpad${key.slice(3)}`;
  else if (/^(Up|Down|Left|Right)$/i.test(key)) c = `Arrow${key[0].toUpperCase()}${key.slice(1).toLowerCase()}`;
  else if (/^F\d{1,2}$/i.test(key)) c = key.toUpperCase();
  else c = { Space: 'Space', Enter: 'Enter', Return: 'Enter', Tab: 'Tab', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert', Delete: 'Delete' }[key] || '';
  return c ? { code: c, ...binding } : null;
}

Imp.firebot = (bundle) => {
  const result = newResult('Firebot', bundle.name);
  const files = bundle.files || {};
  const setup = bundle.kind === 'firebot-setup' ? parseJson(files.setup) : null;
  if (bundle.kind === 'firebot-setup' && !setup) throw new Error('That file isn’t a Firebot setup');
  const comp = setup ? setup.components || {} : null;

  const ctx = { result, idMap: {}, counterNames: {}, roleIds: {} };

  // Roles first, so commands can refer to them.
  const roles = comp ? values(comp.viewerRoles) : Object.entries(files).filter(([k]) => k.startsWith('roles/')).map(([, v]) => parseJson(v)).filter(Boolean);
  for (const r of roles) {
    if (!r || !r.name) continue;
    const id = Bot.uid('r');
    ctx.roleIds[r.id] = id;
    result.roles.push({ id, name: str(r.name), users: values(r.viewers).map((v) => (typeof v === 'string' ? v : v.username || v.displayName || '')).filter(Boolean).map((u) => u.toLowerCase()) });
  }

  // Counters and effect lists, which effects point at by id.
  const counters = comp ? values(comp.counters) : values(parseJson(files['counters/counters.json']));
  for (const c of counters) {
    if (!c || !c.name) continue;
    ctx.counterNames[c.id] = c.name;
    result.counters.push({ id: Bot.uid('n'), name: str(c.name), value: Number(c.value) || 0, min: c.minimum ?? '', max: c.maximum ?? '', file: '' });
  }
  const lists = comp ? values(comp.presetEffectLists) : values(parseJson(files['effects/preset-effect-lists.json']));
  for (const l of lists) if (l && l.id) ctx.idMap[`list:${l.id}`] = `fb-${l.id}`;
  const commandsFile = parseJson(files['chat/commands.json']) || {};
  const commands = comp ? values(comp.commands) : values(commandsFile.customCommands);
  for (const c of commands) if (c && c.id) ctx.idMap[`command:${c.id}`] = Bot.uid('c');
  const timers = comp ? values(comp.timers) : values(parseJson(files['timers.json']));
  for (const t of timers) if (t && t.id) ctx.idMap[`timer:${t.id}`] = Bot.uid('t');
  const eventsFile = parseJson(files['events/events.json']) || {};
  const groups = comp ? values(comp.eventGroups) : values(eventsFile.groups);
  const events = comp ? values(comp.events) : values(eventsFile.mainEvents);
  for (const e of [...events, ...groups.flatMap((g) => values(g.events))]) {
    if (e && e.id) ctx.idMap[`event:${e.id}`] = Bot.uid('v');
  }

  for (const l of lists) {
    if (!l || !l.id) continue;
    const listArgs = values(l.args).map((a) => a.name);
    result.lists.push({ id: `fb-${l.id}`, name: str(l.name), args: listArgs.join(', '), queue: '', effects: fbEffects(l.effects, { ...ctx, listArgs }) });
  }

  for (const c of commands) {
    if (!c || !c.trigger) continue;
    const restrictions = (c.restrictionData && c.restrictionData.restrictions) || [];
    const perm = restrictions.find((r) => r.type === 'firebot:permissions');
    const cost = restrictions.find((r) => r.type === 'firebot:channelcurrency');
    let effects = fbEffects(c.effects, ctx);
    // Subcommands: "!cmd add …" becomes "if $arg[1] is add".
    const subs = [...values(c.subCommands), ...(c.fallbackSubcommand ? [{ ...c.fallbackSubcommand, fallback: true }] : [])];
    if (subs.length) {
      let otherwise = effects;
      const fallback = subs.find((s) => s.fallback);
      if (fallback) otherwise = fbEffects(fallback.effects, ctx);
      for (const s of subs.filter((x) => !x.fallback).reverse()) {
        if (s.active === false) continue;
        const cond = { mode: 'all', items: [{ left: '$arg[1]', op: s.regex ? 'matches' : '==', right: str(s.arg) }] };
        otherwise = [newEffect('conditional', { conditions: cond, then: fbEffects(s.effects, ctx), else: otherwise })];
      }
      effects = otherwise;
    }
    result.commands.push({
      ...Bot.commands.newCommand(),
      id: ctx.idMap[`command:${c.id}`] || Bot.uid('c'),
      enabled: c.active !== false,
      trigger: str(c.trigger),
      aliases: values(c.aliases).join(', '),
      match: c.triggerIsRegex ? 'regex' : c.scanWholeMessage ? 'anywhere' : 'start',
      description: str(c.description),
      permission: perm ? (perm.mode === 'viewer' ? 'listed' : fbPermission(perm.roleIds, ctx)) : 'everyone',
      users: perm && perm.mode === 'viewer' ? str(perm.username) : '',
      cooldownGlobal: Number(c.cooldown && c.cooldown.global) || 0,
      cooldownUser: Number(c.cooldown && c.cooldown.user) || 0,
      cooldownText: c.sendCooldownMessage && c.useCustomCooldownMessage ? firebotText(c.cooldownMessage, ctx) : '',
      cost: cost ? Number(cost.amount) || 0 : 0,
      hidden: !!c.hidden,
      count: Number(c.count) || 0,
      effects,
    });
  }

  for (const t of timers) {
    if (!t) continue;
    result.timers.push({
      id: ctx.idMap[`timer:${t.id}`] || Bot.uid('t'), name: str(t.name) || 'Timer', enabled: t.active !== false,
      interval: Math.max(1, Math.round((Number(t.interval) || 600) / 60)), minLines: Number(t.requiredChatLines) || 0,
      onlyLive: t.onlyWhenLive !== false, effects: fbEffects(t.effects, ctx),
    });
  }

  for (const e of [...events, ...groups.flatMap((g) => values(g.events).map((x) => (g.active === false ? { ...x, active: false } : x)))]) {
    if (e) result.events.push(...fbEvent(e, ctx));
  }

  const hotkeys = comp ? values(comp.hotkeys) : values(parseJson(files['hotkeys.json']));
  for (const hk of hotkeys) {
    if (!hk) continue;
    result.hotkeys.push({ id: Bot.uid('h'), name: str(hk.name) || 'Hotkey', enabled: hk.active !== false, binding: acceleratorBinding(hk.code), effects: fbEffects(hk.effects, ctx) });
  }

  // Points: the first active currency, and everyone's balance in it.
  const currencies = comp ? values(comp.currencies) : values(parseJson(files['currency/currency.json']));
  const currency = currencies.find((c) => c && c.active !== false) || currencies[0];
  if (currency) {
    const interval = Math.max(1, Number(currency.interval) || 5);
    result.currency = {
      enabled: true, name: str(currency.name).toLowerCase() || 'points', perMinute: Math.round(((Number(currency.payout) || 0) / interval) * 100) / 100,
      subBonus: Math.round(((Number(currency.bonus && (currency.bonus.sub || currency.bonus.tier1)) || 0) / interval) * 100) / 100,
      whileOffline: !!Number(currency.offline), max: Number(currency.limit) || 0,
    };
  }

  const users = files['db/users.db'] ? nedb(files['db/users.db']) : [];
  for (const u of users) {
    if (!u.username) continue;
    result.viewers.push({
      platform: 'twitch', login: str(u.username).toLowerCase(), id: str(u._id), displayName: str(u.displayName || u.username),
      firstSeen: Number(u.joinDate) || Date.now(), lastSeen: Number(u.lastSeen) || 0, messages: Number(u.chatMessages) || 0,
      minutes: Number(u.minutesInChannel) || 0, currency: currency && u.currency ? Number(u.currency[currency.id]) || 0 : 0,
    });
  }

  const quoteRows = (bundle.databases && bundle.databases['quotes.db'] && bundle.databases['quotes.db'].quotes)
    || (files['db/quotes.db'] ? nedb(files['db/quotes.db']) : []);
  for (const q of quoteRows) {
    if (!q.text) continue;
    result.quotes.push({ text: str(q.text), author: str(q.originator), game: str(q.game), date: Date.parse(q.created_at || q.createdAt) || Date.now(), addedBy: str(q.creator) });
  }

  if (!setup && !Object.keys(files).length) result.notes.push('Nothing was found in that folder.');
  return result;
};

// ---------------------------------------------------------------------------
// Mix It Up
// ---------------------------------------------------------------------------

const miuType = (o) => String((o && o.$type) || '').split(',')[0].split('.').pop();

// Mix It Up's special identifiers that have an equal here.
function miuText(text) {
  let t = str(text);
  const map = [
    [/\$userdisplayname\b/gi, '$user'], [/\$username\b/gi, '$user'],
    [/\$targetuserdisplayname\b/gi, '$target'], [/\$targetusername\b/gi, '$target'],
    [/\$arg(\d+)(?:text|string|username)?\b/gi, (m, n) => `$arg[${n}]`], [/\$allargs\b/gi, '$args'],
    [/\$streamtitle\b/gi, '$title'], [/\$streamgamename\b/gi, '$game'], [/\$streamuptime\b/gi, '$uptime'],
    [/\$userfollowage\b/gi, '$followAge'], [/\$useraccountage\b/gi, '$accountAge'], [/\$userviewingtime\b/gi, '$watchTime'],
    [/\$randomuser(?:name)?\b/gi, '$randomViewer'], [/\$streamviewercount\b/gi, '$viewerCount'], [/\$bitsamount\b/gi, '$bits'],
    [/\$message\b/gi, '$message'], [/\$usermessage\b/gi, '$message'], [/\$targetusercurrency\w*/gi, '$currency[$target]'],
  ];
  for (const [re, to] of map) t = t.replace(re, to);
  return t;
}

const MIU_ROLE = { Streamer: 'broadcaster', Broadcaster: 'broadcaster', Mod: 'mods', Moderator: 'mods', ChannelEditor: 'mods', VIP: 'vips', Subscriber: 'subs', Follower: 'everyone', User: 'everyone' };

function miuPermission(cmd) {
  const req = cmd.Requirements || {};
  const role = req.Role || {};
  const name = str(role.UserRole || role.Role || role.StreamingPlatformRole || role.MixerRole || '');
  return MIU_ROLE[name] || 'everyone';
}

function miuActions(list, result) {
  return values(list).map((a) => miuAction(a, result)).filter(Boolean);
}

function miuAction(a, result) {
  const type = miuType(a);
  const at = str(a.ActionType);
  let out = null;
  switch (type) {
    case 'ChatActionModel': out = newEffect('chat', { message: miuText(a.ChatText), as: a.SendAsStreamer ? 'streamer' : 'auto' }); break;
    case 'WaitActionModel': out = newEffect('delay', { seconds: miuText(a.Amount || '1') }); break;
    case 'SoundActionModel': out = newEffect('sound', { file: str(a.FilePath), volume: Math.round(Number(a.VolumeScale) || 80) }); break;
    case 'TextToSpeechActionModel': out = newEffect('speak', { text: miuText(a.Text) }); break;
    case 'CounterActionModel':
      out = newEffect('counter', { name: str(a.CounterName), action: /reset/i.test(at) ? 'reset' : /set/i.test(at) ? 'set' : 'add', amount: miuText(a.Amount || '1') });
      break;
    case 'ConsumablesActionModel': case 'CurrencyActionModel':
      out = newEffect('currency', {
        action: /subtract|remove/i.test(at) ? 'remove' : /reset|set/i.test(at) ? 'set' : 'add', amount: miuText(a.Amount || '0'),
        who: /all/i.test(at) ? 'watching' : 'user', username: a.Username ? miuText(a.Username) : '$username',
      });
      break;
    case 'ModerationActionModel': {
      const action = /unban/i.test(at) ? 'unban' : /ban/i.test(at) ? 'ban' : /timeout|purge/i.test(at) ? 'timeout' : /clearchat/i.test(at) ? 'clear' : /unvip/i.test(at) ? 'unvip' : /vip/i.test(at) ? 'vip' : '';
      if (!action) break;
      out = newEffect('moderate', { action, username: miuText(a.TargetUsername || '$username'), seconds: /purge/i.test(at) ? '1' : miuText(a.TimeAmount || '60'), reason: miuText(a.ModerationReason || '') });
      break;
    }
    case 'WebRequestActionModel': out = newEffect('http', { method: 'GET', url: miuText(a.Url), output: 'webRequest' }); break;
    case 'SpecialIdentifierActionModel': out = newEffect('variable', { name: str(a.SpecialIdentifierName), action: 'set', value: miuText(a.ReplacementText) }); break;
    case 'FileActionModel':
      out = newEffect('writeFile', { file: str(a.FilePath), text: miuText(a.TransferText), mode: /append/i.test(at) ? 'append' : 'replace' });
      noteUnsupported(result, 'Mix It Up file actions: pick the file again in the effect');
      break;
    case 'TwitchActionModel':
      if (/adbreak|commercial/i.test(at)) out = newEffect('commercial', { seconds: String(Math.min(180, Math.max(30, Number(a.AdLength) || 60))) });
      else if (/marker/i.test(at)) out = newEffect('marker', { description: miuText(a.StreamMarkerDescription || '') });
      else if (/clip/i.test(at)) out = newEffect('clip', { message: a.ShowInfoInChat ? 'Clipped! $effectOutput[clip]' : '' });
      else if (/title/i.test(at)) out = newEffect('streamInfo', { title: miuText(a.Text || a.Title || '') });
      else if (/game|category/i.test(at)) out = newEffect('streamInfo', { game: miuText(a.Text || a.GameName || '') });
      else if (/raid/i.test(at)) out = newEffect('raid', { username: miuText(a.Username || a.Text || '$target') });
      break;
    case 'StreamingSoftwareActionModel':
      if (/scene/i.test(at)) out = newEffect('obs', { action: 'scene', scene: miuText(a.SceneName) });
      else if (/source/i.test(at)) out = newEffect('obs', { action: a.Visible === false ? 'hide' : 'show', scene: miuText(a.SceneName || ''), source: miuText(a.ItemName || a.SourceName || '') });
      else if (/filter/i.test(at)) out = newEffect('obs', { action: a.Visible === false ? 'filterOff' : 'filterOn', source: miuText(a.ItemName || a.SourceName || ''), filter: miuText(a.FilterName || '') });
      else if (/startstream/i.test(at)) out = newEffect('obs', { action: 'startStream' });
      else if (/stopstream/i.test(at)) out = newEffect('obs', { action: 'stopStream' });
      else if (/replay/i.test(at)) out = newEffect('obs', { action: 'saveReplay' });
      break;
    case 'ConditionalActionModel': {
      const ops = { Equals: '==', NotEquals: '!=', GreaterThan: '>', GreaterThanOrEqual: '>=', LessThan: '<', LessThanOrEqual: '<=', Contains: 'contains', DoesNotContain: 'notContains', Regex: 'matches' };
      const items = values(a.Clauses).map((c) => ({ left: miuText(c.Value1), op: ops[str(c.ComparisionType || c.ComparisonType)] || '==', right: miuText(c.Value2) }));
      out = newEffect('conditional', { conditions: { mode: /or/i.test(str(a.Operator)) ? 'any' : 'all', items }, then: miuActions(a.Actions, result), else: [] });
      break;
    }
    case 'RandomActionModel': out = newEffect('random', { mode: 'any', effects: miuActions(a.Actions, result) }); break;
    case 'GroupActionModel': out = newEffect('conditional', { conditions: { mode: 'all', items: [] }, then: miuActions(a.Actions, result), else: [] }); break;
    case 'OverlayActionModel': {
      const item = a.OverlayItem || a.OverlayItemV3 || {};
      const kind = miuType(item);
      if (/Text/i.test(kind)) out = newEffect('text', { text: miuText(item.Text), duration: Number(a.Duration || (a.Position && a.Position.Duration)) || 5 });
      else if (/Image|Video/i.test(kind)) out = newEffect('media', { file: str(item.FilePath || item.FileID), duration: Number(a.Duration) || 5 });
      break;
    }
    default: break;
  }
  if (!out) {
    noteUnsupported(result, `Mix It Up ${type.replace(/ActionModel$/, '')}${at ? ` (${at})` : ''}`);
    out = unsupported('Mix It Up', type.replace(/ActionModel$/, '') + (at ? `: ${at}` : ''), a);
  }
  if (a.Enabled === false || a.IsEnabled === false) out.enabled = false;
  return out;
}

const MIU_EVENTS = [
  [/MassSubscriptionsGifted|SubscriptionsGifted/i, 'giftSub'], [/SubscriptionGifted/i, 'giftReceived'], [/Resubscribed/i, 'resub'],
  [/Subscribed/i, 'sub'], [/Follow/i, 'follow'], [/Bits|Cheer/i, 'cheer'], [/Raid/i, 'raid'], [/StreamStart/i, 'streamOnline'],
  [/StreamStop|StreamEnd/i, 'streamOffline'], [/FirstJoin|FirstChat|FirstMessage/i, 'firstChat'], [/HypeTrainBegin|HypeTrainStart/i, 'hypeTrainStart'],
  [/HypeTrainEnd/i, 'hypeTrainEnd'], [/SuperChat|SuperSticker/i, 'youtubeSuperChat'], [/Member/i, 'youtubeMember'], [/TikTok.*Gift/i, 'tiktokGift'],
  [/ChatMessage|ChatUserJoined/i, 'chatMessage'],
];

function miuCommand(o, result) {
  const type = miuType(o);
  const actions = miuActions(o.Actions, result);
  const enabled = o.IsEnabled !== false;
  if (/ChatCommandModel/.test(type)) {
    const triggers = values(o.Triggers).map((t) => str(t).trim()).filter(Boolean).map((t) => (o.IncludeExclamation === false || t.startsWith('!') ? t : `!${t}`));
    if (!triggers.length) return;
    const cd = (o.Requirements && o.Requirements.Cooldown) || {};
    const amount = Number(cd.IndividualAmount || cd.Amount) || 0;
    result.commands.push({
      ...Bot.commands.newCommand(), enabled, trigger: triggers[0].toLowerCase(), aliases: triggers.slice(1).join(', '),
      match: o.Wildcards ? 'anywhere' : 'start', description: str(o.Name), permission: miuPermission(o),
      cooldownGlobal: /global/i.test(str(cd.Type)) ? amount : 0, cooldownUser: /global/i.test(str(cd.Type)) ? 0 : amount,
      effects: actions,
    });
  } else if (/TimerCommandModel/.test(type)) {
    result.timers.push({ id: Bot.uid('t'), name: str(o.Name) || 'Timer', enabled, interval: 15, minLines: 5, onlyLive: true, effects: actions });
  } else if (/EventCommandModel/.test(type)) {
    const key = str(o.EventType || o.Name);
    const found = MIU_EVENTS.find(([re]) => re.test(key));
    if (!found) { noteUnsupported(result, `Mix It Up event ${key}`); return; }
    result.events.push({ id: Bot.uid('v'), enabled, type: found[1], name: str(o.Name) || key, filters: { mode: 'all', items: [] }, queue: '', effects: actions });
  } else if (/ChannelPoint/.test(type)) {
    const id = str(o.ChannelPointRewardID || o.RewardID || '').toLowerCase();
    if (/^[0-9a-f-]{8,64}$/.test(id)) result.rewardActions[id] = { title: str(o.Name), enabled, after: 'none', queue: '', effects: actions };
    else result.events.push({ id: Bot.uid('v'), enabled, type: 'redemption', name: str(o.Name), filters: { mode: 'all', items: [{ left: '$rewardName', op: '==', right: str(o.Name) }] }, queue: '', effects: actions });
  } else if (/ActionGroupCommandModel|CustomCommandModel|StreamlootsCardCommandModel/.test(type)) {
    result.lists.push({ id: Bot.uid('l'), name: str(o.Name) || 'Action group', args: '', queue: '', effects: actions });
  } else if (/CommandModel/.test(type)) {
    noteUnsupported(result, `Mix It Up ${type.replace(/CommandModel$/, '')} command`);
  }
}

// A user record, whatever the version: a name, viewing minutes, and points.
function miuUser(o) {
  const twitch = (o.PlatformData && (o.PlatformData.Twitch || o.PlatformData['1'])) || {};
  const login = str(o.TwitchUsername || o.Username || twitch.Username || o.PlatformUsername || '').toLowerCase();
  if (!login) return null;
  const minutes = Number(o.OnlineViewingMinutes ?? o.ViewingMinutes ?? o.MinutesWatched ?? 0) || 0;
  const amounts = o.CurrencyAmounts || o.CurrencyData || {};
  const first = values(amounts)[0];
  const currency = typeof first === 'number' ? first : Number(first && (first.Amount ?? first.amount)) || 0;
  return {
    platform: 'twitch', login, id: str(o.TwitchID || twitch.ID || twitch.UserID || o.ID || ''), displayName: str(o.TwitchDisplayName || twitch.DisplayName || o.DisplayName || login),
    firstSeen: Date.parse(o.AccountDate || o.FirstSeen || '') || Date.now(), lastSeen: Date.parse(o.LastActivity || o.LastSeen || '') || 0,
    messages: Number(o.TotalChatMessageSent ?? o.ChatMessages ?? 0) || 0, minutes, currency,
  };
}

Imp.mixitup = (bundle) => {
  const result = newResult('Mix It Up', bundle.name);
  const objects = [];
  const collect = (v) => {
    if (!v) return;
    if (typeof v === 'string' && /^\s*[[{]/.test(v)) { collect(parseJson(v)); return; }
    if (Array.isArray(v)) { v.forEach(collect); return; }
    if (typeof v === 'object') objects.push(v);
  };
  for (const text of Object.values(bundle.files || {})) collect(text);
  const userRows = [];
  const quoteRows = [];
  for (const tables of Object.values(bundle.databases || {})) {
    for (const [table, rows] of Object.entries(tables)) {
      for (const row of rows) {
        // A row is usually an id and a Data column with the object as JSON.
        let found = false;
        for (const v of Object.values(row)) {
          if (typeof v === 'string' && /^\s*\{/.test(v)) {
            const o = parseJson(v);
            if (o) { objects.push(o); found = true; }
          }
        }
        if (!found && /user/i.test(table)) userRows.push(row);
        if (!found && /quote/i.test(table)) quoteRows.push(row);
      }
    }
  }

  for (const o of objects) {
    const type = miuType(o);
    if (/CommandModel$/.test(type)) miuCommand(o, result);
    else if (/UserV\d*Model|UserDataModel|UserModel$/.test(type) || (o.OnlineViewingMinutes !== undefined && (o.Username || o.TwitchUsername || o.PlatformData))) {
      const u = miuUser(o);
      if (u) result.viewers.push(u);
    } else if (/Quote/.test(type) || (o.Quote && o.ID !== undefined)) {
      quoteRows.push(o);
    } else if (Array.isArray(o.Commands) || Array.isArray(o.ChatCommands)) {
      // A settings object holding its commands inline (older versions).
      for (const c of [...values(o.Commands), ...values(o.ChatCommands), ...values(o.TimerCommands), ...values(o.EventCommands), ...values(o.ActionGroupCommands)]) miuCommand(c, result);
    }
  }
  for (const row of userRows) { const u = miuUser(row); if (u) result.viewers.push(u); }
  for (const q of quoteRows) {
    const text = str(q.Quote || q.Text);
    if (text) result.quotes.push({ text, author: '', game: str(q.GameName || q.Game || ''), date: Date.parse(q.DateTime || q.Date || '') || Date.now(), addedBy: '' });
  }
  if (!objects.length && !userRows.length) result.notes.push('Nothing in that file looked like Mix It Up data.');
  return result;
};

// ---------------------------------------------------------------------------
// Putting it in
// ---------------------------------------------------------------------------

Imp.read = async (kind) => {
  const res = await Bot.desktop.readImport(kind);
  if (res.canceled) return null;
  if (res.error) throw new Error(res.error);
  const bundle = res.bundle;
  return bundle.kind === 'mixitup' ? Imp.mixitup(bundle) : Imp.firebot(bundle);
};

Imp.CATEGORIES = [
  ['commands', 'Commands'], ['events', 'Events'], ['rewardActions', 'Channel point reward effects'], ['timers', 'Timers'],
  ['lists', 'Effect lists'], ['hotkeys', 'Hotkeys'], ['counters', 'Counters'], ['roles', 'Custom roles'],
  ['quotes', 'Quotes'], ['viewers', 'Viewers, with watch time and points'], ['currency', 'Points settings'],
];

Imp.count = (result, key) => {
  if (key === 'currency') return result.currency ? 1 : 0;
  if (key === 'rewardActions') return Object.keys(result.rewardActions).length;
  return result[key].length;
};

// Adds what was chosen to the bot, never replacing what's there: a command
// whose trigger already exists, or a counter with the same name, is skipped.
Imp.apply = (result, chosen) => {
  const d = Bot.data;
  const done = {};
  const skipped = [];
  const take = (key) => chosen[key] && Imp.count(result, key);

  if (take('commands')) {
    const have = new Set(d.commands.map((c) => c.trigger.toLowerCase()));
    done.commands = 0;
    for (const c of result.commands) {
      if (have.has(c.trigger.toLowerCase())) { skipped.push(c.trigger); continue; }
      have.add(c.trigger.toLowerCase());
      d.commands.push(c);
      done.commands++;
    }
  }
  // Importing the same thing twice doesn't double it up.
  const sameAs = {
    events: (a, b) => a.type === b.type && a.name === b.name && JSON.stringify(a.filters) === JSON.stringify(b.filters),
    timers: (a, b) => a.name.toLowerCase() === b.name.toLowerCase(),
    hotkeys: (a, b) => a.name.toLowerCase() === b.name.toLowerCase(),
  };
  for (const key of ['events', 'timers', 'hotkeys']) {
    if (!take(key)) continue;
    const fresh = result[key].filter((x) => !d[key].some((y) => sameAs[key](x, y)));
    d[key].push(...fresh);
    done[key] = fresh.length;
  }
  if (take('lists')) {
    const have = new Set(d.lists.map((l) => l.id));
    const fresh = result.lists.filter((l) => !have.has(l.id));
    d.lists.push(...fresh);
    done.lists = fresh.length;
  }
  if (take('rewardActions')) {
    done.rewardActions = 0;
    for (const [id, action] of Object.entries(result.rewardActions)) {
      if (d.rewardActions[id]) continue;
      d.rewardActions[id] = action;
      done.rewardActions++;
    }
  }
  if (take('counters')) {
    done.counters = 0;
    for (const c of result.counters) {
      if (Bot.counters.find(c.name)) continue;
      d.counters.push(c);
      done.counters++;
    }
  }
  if (take('roles')) {
    for (const r of result.roles) {
      const same = d.roles.find((x) => x.name.toLowerCase() === r.name.toLowerCase());
      if (same) {
        same.users = [...new Set([...same.users, ...r.users])];
        // Commands imported with the new role's id point at the old one.
        for (const c of d.commands) if (c.permission === `role:${r.id}`) c.permission = `role:${same.id}`;
      } else {
        d.roles.push(r);
      }
    }
    done.roles = result.roles.length;
  }
  if (take('quotes')) {
    const have = new Set(d.quotes.list.map((q) => q.text.trim().toLowerCase()));
    done.quotes = 0;
    for (const q of result.quotes) {
      if (have.has(q.text.trim().toLowerCase())) continue;
      have.add(q.text.trim().toLowerCase());
      d.quotes.list.push({ id: d.quotes.next++, ...q });
      done.quotes++;
    }
  }
  if (take('currency')) {
    Object.assign(d.currency, result.currency);
    done.currency = 1;
  }
  if (take('viewers')) {
    // Imported twice, or seen here already: each number keeps the larger value.
    let n = 0;
    for (const v of result.viewers) {
      const key = `${v.platform}:${v.login}`;
      const have = Bot.viewers.users[key];
      if (have) {
        for (const f of ['messages', 'minutes', 'currency']) have[f] = Math.max(Number(have[f]) || 0, Number(v[f]) || 0);
        have.firstSeen = Math.min(have.firstSeen || Date.now(), v.firstSeen || Date.now());
        if (!have.id && v.id) have.id = v.id;
      } else {
        Bot.viewers.users[key] = { key, lastChat: 0, role: 0, session: '', ...v };
      }
      n++;
    }
    done.viewers = n;
    Bot.saveViewers();
  }
  Bot.save();
  Bot.host.syncHotkeys();
  Bot.emit('viewers');
  return { done, skipped };
};
