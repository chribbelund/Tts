'use strict';

// What makes effects run: chat commands (custom and built in), events from
// Twitch, YouTube and TikTok, channel point rewards, timers, hotkeys and the
// HTTP API. Chat from the streamer's Twitch channel arrives over EventSub;
// YouTube and TikTok chat comes from the reader (js/app.js) via the host.

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const userFields = [['user', 'Their name'], ['username', 'Their login']];

// id -> { name, category, fields: [[key, label]], text(user, fields), sample }
const EVENT_TYPES = {
  follow: { name: 'Follow', category: 'Twitch', fields: [], text: (u) => `${u} followed` },
  sub: { name: 'New subscriber', category: 'Twitch', fields: [['tier', 'Tier']], text: (u, f) => `${u} subscribed (${f.tier})`, sample: { tier: 'Tier 1', isGift: false } },
  resub: {
    name: 'Resubscribe', category: 'Twitch', fields: [['tier', 'Tier'], ['months', 'Months in total'], ['streak', 'Months in a row'], ['message', 'Their message']],
    text: (u, f) => `${u} resubscribed for ${f.months} months (${f.tier})`, sample: { tier: 'Tier 1', months: 7, streak: 3, duration: 1, message: 'Love the streams!' },
  },
  giftSub: {
    name: 'Gifted subs', category: 'Twitch', fields: [['giftCount', 'Subs gifted'], ['tier', 'Tier'], ['totalGifted', 'Gifted in total']],
    text: (u, f) => `${u} gifted ${f.giftCount} sub${f.giftCount === 1 ? '' : 's'} (${f.tier})`, sample: { giftCount: 5, tier: 'Tier 1', totalGifted: 25, anonymous: false },
  },
  giftReceived: { name: 'Received a gifted sub', category: 'Twitch', fields: [['tier', 'Tier']], text: (u, f) => `${u} got a gifted sub (${f.tier})`, sample: { tier: 'Tier 1', isGift: true } },
  cheer: { name: 'Cheer', category: 'Twitch', fields: [['bits', 'Bits'], ['message', 'Their message']], text: (u, f) => `${u} cheered ${f.bits} bits`, sample: { bits: 500, message: 'Cheer500 great play!', anonymous: false } },
  raid: { name: 'Raid', category: 'Twitch', fields: [['viewers', 'Raiders']], text: (u, f) => `${u} raided with ${f.viewers} viewers`, sample: { viewers: 42 } },
  redemption: {
    name: 'Channel point redemption (any reward)', category: 'Twitch', fields: [['rewardName', 'Reward'], ['rewardCost', 'Cost'], ['message', 'What they typed']],
    text: (u, f) => `${u} redeemed ${f.rewardName}${f.message ? `: ${f.message}` : ''}`, sample: { rewardId: 'test', rewardName: 'Hydrate', rewardCost: 500, message: '', redemptionId: '' },
  },
  hypeTrainStart: { name: 'Hype train started', category: 'Twitch', fields: [['level', 'Level'], ['total', 'Points'], ['goal', 'Goal']], text: () => 'A hype train started', sample: { level: 1, total: 1200, goal: 2000 } },
  hypeTrainEnd: { name: 'Hype train ended', category: 'Twitch', fields: [['level', 'Level reached'], ['total', 'Points']], text: (u, f) => `The hype train ended at level ${f.level}`, sample: { level: 3, total: 9000 } },
  pollStart: { name: 'Poll started', category: 'Twitch', fields: [['title', 'Question'], ['choices', 'Choices']], text: (u, f) => `Poll: ${f.title}`, sample: { title: 'Which boss next?', choices: 'Dragon, Golem' } },
  pollEnd: { name: 'Poll ended', category: 'Twitch', fields: [['title', 'Question'], ['winner', 'Winning choice'], ['votes', 'Votes for it']], text: (u, f) => `Poll ended: ${f.winner}`, sample: { title: 'Which boss next?', winner: 'Dragon', votes: 31, status: 'COMPLETED' } },
  predictionStart: { name: 'Prediction started', category: 'Twitch', fields: [['title', 'Question'], ['outcomes', 'Outcomes']], text: (u, f) => `Prediction: ${f.title}`, sample: { title: 'Will we win?', outcomes: 'Yes, No' } },
  predictionEnd: { name: 'Prediction ended', category: 'Twitch', fields: [['title', 'Question'], ['winner', 'Winning outcome']], text: (u, f) => `Prediction ended: ${f.winner || f.status}`, sample: { title: 'Will we win?', winner: 'Yes', status: 'RESOLVED' } },
  adBreak: { name: 'Ad break started', category: 'Twitch', fields: [['seconds', 'Length (seconds)']], text: (u, f) => `${f.seconds} second ad break`, sample: { seconds: 90, automatic: true } },
  shoutoutReceived: { name: 'Shoutout received', category: 'Twitch', fields: [['viewers', 'Their viewers']], text: (u) => `${u} gave you a shoutout`, sample: { viewers: 120 } },
  ban: { name: 'Viewer banned or timed out', category: 'Twitch', fields: [['reason', 'Reason'], ['moderator', 'By']], text: (u, f) => `${u} was ${f.permanent ? 'banned' : 'timed out'}`, sample: { reason: 'spam', permanent: false, moderator: 'a mod' } },
  unban: { name: 'Viewer unbanned', category: 'Twitch', fields: [['moderator', 'By']], text: (u) => `${u} was unbanned`, sample: { moderator: 'a mod' } },
  streamOnline: { name: 'Stream went live', category: 'Twitch', fields: [], text: () => 'You went live' },
  streamOffline: { name: 'Stream ended', category: 'Twitch', fields: [], text: () => 'The stream ended' },
  channelUpdate: { name: 'Title or category changed', category: 'Twitch', fields: [['title', 'Title'], ['game', 'Category']], text: (u, f) => `Now: ${f.title} · ${f.game}`, sample: { title: 'Speedruns!', game: 'Celeste' } },
  charityDonation: { name: 'Charity donation', category: 'Twitch', fields: [['amount', 'Amount'], ['currency', 'Currency'], ['charity', 'Charity']], text: (u, f) => `${u} donated ${f.amount} ${f.currency} to ${f.charity}`, sample: { amount: 10, currency: 'USD', charity: 'a charity' } },

  chatMessage: { name: 'Any chat message', category: 'Chat', fields: [['message', 'The message']], text: (u, f) => `${u}: ${f.message}`, sample: { message: 'hello chat' }, quiet: true },
  firstChat: { name: 'First chat message ever', category: 'Chat', fields: [['message', 'The message']], text: (u) => `${u} chatted for the first time`, sample: { message: 'hi, first time here!' } },
  viewerArrived: { name: 'Viewer arrived (first message this stream)', category: 'Chat', fields: [['message', 'The message']], text: (u) => `${u} arrived`, sample: { message: 'hey!' } },

  youtubeSuperChat: { name: 'Super Chat or Super Sticker', category: 'YouTube', fields: [['amount', 'Amount (as shown)'], ['message', 'Their message']], text: (u, f) => `${u} sent a ${f.label}`, sample: { amount: '$5.00', label: 'Super Chat of $5.00', message: 'keep it up!' } },
  youtubeMember: { name: 'New member or gifted memberships', category: 'YouTube', fields: [['text', 'What YouTube says']], text: (u, f) => f.text, sample: { text: 'Someone became a member' } },
  tiktokGift: { name: 'Gift', category: 'TikTok', fields: [['gift', 'Gift'], ['count', 'How many']], text: (u, f) => `${u} sent ${f.count} ${f.gift}`, sample: { gift: 'Rose', count: 5, text: 'sent 5 Roses' } },

  appStarted: { name: 'The app started', category: 'App', fields: [], text: () => 'Chat Reader started', quiet: true },
};

const EventsApi = Bot.events = { types: EVENT_TYPES };

EventsApi.fire = async (type, { user = null, fields = {}, raw = null, message = null, simulated = false } = {}) => {
  const spec = EVENT_TYPES[type];
  if (!spec) return;
  if (user && user.platform === 'twitch' && user.id) Bot.viewersDb.noteEvent(user, type, fields);
  if (type === 'streamOnline') Bot.community.setLive(true);
  if (type === 'streamOffline') Bot.community.setLive(false);

  if (Bot.relay) Bot.relay.onEvent(type, user, fields, spec.quiet ? '' : spec.text(user ? user.displayName || user.login : '', fields), simulated);

  if (!spec.quiet) {
    Bot.addActivity({
      kind: 'event', type, simulated, fields, platform: user ? user.platform || 'twitch' : 'twitch',
      text: spec.text(user ? user.displayName || user.login : '', fields),
      replay: () => EventsApi.fire(type, { user, fields, raw, message, simulated: true }),
    });
  }

  const base = { trigger: { type: 'event', name: spec.name }, user, message, fields: { ...fields, ...(user ? { user: user.displayName, username: user.login } : {}) } };
  for (const ev of Bot.data.events) {
    if (!ev.enabled || ev.type !== type) continue;
    const ctx = Bot.effects.newContext({ ...base, trigger: { type: 'event', name: ev.name || spec.name } });
    if (!(await Bot.effects.check(ev.filters, ctx))) continue;
    Bot.effects.runQueued(ev.queue, ev.effects, ctx);
  }

  // A reward with effects of its own, from the Rewards tab.
  if (type === 'redemption') runRewardActions(user, fields, base);
};

async function runRewardActions(user, fields, base) {
  const action = Bot.data.rewardActions[fields.rewardId];
  if (!action || action.enabled === false) return;
  const ctx = Bot.effects.newContext({ ...base, trigger: { type: 'reward', name: action.title || fields.rewardName } });
  await Bot.effects.runQueued(action.queue, action.effects, ctx);
  if ((action.after === 'fulfill' || action.after === 'refund') && fields.redemptionId && fields.status === 'unfulfilled') {
    Bot.twitch.updateRedemption(fields.rewardId, fields.redemptionId, action.after === 'fulfill' ? 'FULFILLED' : 'CANCELED')
      .catch((err) => Bot.log('error', `Couldn’t ${action.after === 'fulfill' ? 'complete' : 'refund'} the redemption: ${err.message} (only rewards made in this app can be)`));
  }
}

// Someone to pin a simulated event on: the streamer.
EventsApi.simulate = (type) => {
  const spec = EVENT_TYPES[type];
  const me = Bot.twitch.accounts.streamer;
  const user = { id: me ? me.id : '0', login: me ? me.login : 'test_viewer', displayName: me ? me.displayName : 'Test_Viewer', platform: type.startsWith('youtube') ? 'youtube' : type.startsWith('tiktok') ? 'tiktok' : 'twitch', role: 4 };
  const fields = { ...(spec.sample || {}) };
  return EventsApi.fire(type, { user, fields, simulated: true, message: fields.message ? { id: '', text: fields.message } : null });
};

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

const ChatApi = Bot.chat = { recent: [] };

function roleFromBadges(badges = []) {
  const ids = new Set(badges.map((b) => b.set_id));
  if (ids.has('broadcaster')) return 4;
  if (ids.has('moderator') || ids.has('lead_moderator')) return 3;
  if (ids.has('vip')) return 2;
  if (ids.has('subscriber') || ids.has('founder')) return 1;
  return 0;
}

ChatApi.fromEventSub = (e) => {
  const fragments = (e.message && e.message.fragments) || [];
  ChatApi.handle({
    platform: 'twitch',
    id: e.message_id,
    user: {
      id: e.chatter_user_id, login: e.chatter_user_login, displayName: e.chatter_user_name || e.chatter_user_login,
      platform: 'twitch', role: roleFromBadges(e.badges), color: e.color || '',
    },
    text: (e.message && e.message.text) || '',
    emotes: fragments.filter((f) => f.type === 'emote').length,
    bits: (e.cheer && e.cheer.bits) || 0,
    rewardId: e.channel_points_custom_reward_id || '',
    isReply: !!e.reply,
  });
};

// From the reader: a YouTube or TikTok chat message or event.
ChatApi.seenRemote = new Set();

ChatApi.fromRemote = (entry) => {
  const platform = entry.platform;
  // The reader and the multistream relay can both read the same chat.
  if (entry.id) {
    if (ChatApi.seenRemote.has(entry.id)) return;
    ChatApi.seenRemote.add(entry.id);
    if (ChatApi.seenRemote.size > 3000) ChatApi.seenRemote = new Set([...ChatApi.seenRemote].slice(-1500));
  }
  const login = String(entry.login || '').replace(/^(?:yt|tt):/, '');
  const user = { id: String(entry.userId || '').replace(/^(?:yt|tt):/, '') || login, login, displayName: entry.displayName || login, platform, role: entry.role || 0 };
  if (entry.paid) {
    const amount = String(entry.paid.badge || '').split(' ')[0];
    EventsApi.fire('youtubeSuperChat', { user, fields: { amount, label: entry.paid.label, message: entry.rawText || '' } });
  }
  if (entry.kind === 'event') {
    const text = entry.systemText || '';
    if (platform === 'tiktok') {
      const m = /sent (\d+) (.+)$/.exec(text);
      EventsApi.fire('tiktokGift', { user, fields: { gift: m ? m[2] : text, count: m ? Number(m[1]) : 1, text } });
    } else if (platform === 'youtube') {
      EventsApi.fire('youtubeMember', { user, fields: { text } });
    }
    return;
  }
  if (!entry.rawText) return;
  ChatApi.handle({ platform, id: entry.id, user, text: entry.rawText, emotes: 0, bits: 0, rewardId: '', isReply: false, ours: Bot.relay.isOurs(entry) });
};

ChatApi.handle = async (msg) => {
  // The bot's own replies never trigger anything, or it could answer itself forever.
  const botAccount = Bot.twitch.accounts.bot;
  if (msg.platform === 'twitch' && botAccount && msg.user.id === botAccount.id) return;
  // Nor does what it said as the streamer, when there's no bot account.
  const said = String(msg.text).toLowerCase();
  if (msg.platform === 'twitch' && Bot.twitch.sent.some((s) => s.login === msg.user.login && Date.now() - s.at < 15000 && s.text.startsWith(said.slice(0, 200)))) return;
  // Nor do messages the multistream relay posted here, coming back in.
  if (Bot.relay.isEcho(msg.platform, msg.text) || Bot.relay.isRelayAccount(msg)) return;

  ChatApi.recent.push({ at: Date.now(), msg });
  if (ChatApi.recent.length > 200) ChatApi.recent.shift();
  Bot.timers.chatLine();

  const seen = Bot.viewersDb.noteChat(msg);
  if (await Bot.moderation.check(msg)) return;
  Bot.relay.toOverlay(msg);
  Bot.relay.onChat(msg);

  const ctxBase = { user: msg.user, message: { id: msg.id, text: msg.text }, fields: { message: msg.text } };
  EventsApi.fire('chatMessage', ctxBase);
  if (seen.firstEver) EventsApi.fire('firstChat', ctxBase);
  if (seen.firstThisStream) EventsApi.fire('viewerArrived', ctxBase);

  if (msg.platform === 'twitch' || Bot.data.remoteCommands) await CommandsApi.handle(msg);
};

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const CommandsApi = Bot.commands = { cooldowns: new Map(), system: [] };

const words = (text) => String(text).trim().split(/\s+/).filter(Boolean);

// Whether `text` uses this command, and what follows it.
function matchCommand(cmd, text) {
  const t = String(text).trim();
  if (!t) return null;
  if (cmd.match === 'regex') {
    try {
      const m = Bot.regex(cmd.trigger, 'i').exec(t);
      return m ? { args: m.length > 1 ? m.slice(1).filter((x) => x !== undefined) : words(t) } : null;
    } catch { return null; }
  }
  const triggers = [cmd.trigger, ...String(cmd.aliases || '').split(/[\s,]+/)].map((x) => String(x || '').trim().toLowerCase()).filter(Boolean);
  const list = words(t);
  if (cmd.match === 'anywhere') {
    const lower = list.map((w) => w.toLowerCase().replace(/[.,!?]+$/, ''));
    return triggers.some((tr) => lower.includes(tr)) ? { args: list } : null;
  }
  return list.length && triggers.includes(list[0].toLowerCase()) ? { args: list.slice(1) } : null;
}

// For the reader: a message that is one of the bot's commands isn't read out.
CommandsApi.isCommand = (text) => [...Bot.data.commands, ...CommandsApi.activeSystem()].some((c) => c.enabled !== false && c.match !== 'anywhere' && matchCommand(c, text));

function cooldownLeft(cmd, user) {
  const now = Date.now();
  const global = (Number(cmd.cooldownGlobal) || 0) * 1000 - (now - (CommandsApi.cooldowns.get(cmd.id) || 0));
  const personal = (Number(cmd.cooldownUser) || 0) * 1000 - (now - (CommandsApi.cooldowns.get(`${cmd.id}:${user.platform}:${user.login}`) || 0));
  return Math.max(0, global, personal);
}

function startCooldown(cmd, user) {
  const now = Date.now();
  CommandsApi.cooldowns.set(cmd.id, now);
  CommandsApi.cooldowns.set(`${cmd.id}:${user.platform}:${user.login}`, now);
}

CommandsApi.handle = async (msg) => {
  const candidates = [...Bot.data.commands.filter((c) => c.enabled !== false), ...CommandsApi.activeSystem()];
  for (const cmd of candidates) {
    const match = matchCommand(cmd, msg.text);
    if (!match) continue;
    if (msg.platform !== 'twitch' && cmd.platforms === 'twitch') continue;
    if (!Bot.allowed(msg.user, cmd.permission || 'everyone', cmd.users)) {
      if (cmd.deniedText) Bot.twitch.say(await Bot.vars.render(cmd.deniedText, { user: msg.user }), { replyTo: msg.platform === 'twitch' ? msg.id : '' }).catch(() => {});
      return;
    }
    const left = (msg.user.role >= 3 && cmd.modsSkipCooldown !== false) ? 0 : cooldownLeft(cmd, msg.user);
    if (left > 0) {
      if (cmd.cooldownText) {
        Bot.twitch.say(await Bot.vars.render(cmd.cooldownText, { user: msg.user, fields: { cooldown: Math.ceil(left / 1000) } })).catch(() => {});
      }
      return;
    }
    const ctx = Bot.effects.newContext({
      trigger: { type: 'command', name: cmd.trigger },
      user: msg.user,
      message: { id: msg.id, text: msg.text },
      args: match.args,
      command: cmd,
      fields: { message: msg.text, platformMessage: msg },
    });
    const cost = Math.max(0, Number(cmd.cost) || 0);
    if (cost && Bot.data.currency.enabled && msg.user.role < 4) {
      if (!Bot.viewersDb.spend(msg.user, cost)) {
        Bot.twitch.say(`@${msg.user.displayName}, that costs ${cost} ${Bot.data.currency.name}.`).catch(() => {});
        return;
      }
    }
    startCooldown(cmd, msg.user);
    cmd.count = (cmd.count || 0) + 1;
    if (!cmd.system) Bot.save();
    if (cmd.system) {
      try { await cmd.run(ctx, match.args, msg); } catch (err) { Bot.log('error', `${cmd.trigger}: ${err.message}`); }
    } else {
      Bot.effects.runQueued(cmd.queue, cmd.effects, ctx);
    }
    return;
  }
};

CommandsApi.newCommand = () => ({
  id: Bot.uid('c'), enabled: true, trigger: '!', aliases: '', match: 'start', description: '',
  permission: 'everyone', users: '', cooldownGlobal: 0, cooldownUser: 0, modsSkipCooldown: true,
  cooldownText: '', deniedText: '', cost: 0, platforms: 'all', hidden: false, queue: '', count: 0, effects: [],
});

// Built-in commands. Their trigger, permission, cooldowns and replies can be
// changed under Commands → Built in; the overrides live in data.systemCommands.
CommandsApi.define = system;
function system(id, spec) {
  CommandsApi.system.push({ id: `sys:${id}`, key: id, system: true, match: 'start', ...spec });
}

// The built-in commands with the streamer's changes applied.
CommandsApi.activeSystem = () => CommandsApi.system.map((cmd) => {
  const o = Bot.data.systemCommands[cmd.key] || {};
  const merged = { ...cmd, ...o, texts: { ...cmd.texts, ...(o.texts || {}) }, id: cmd.id, run: cmd.run, system: true };
  if (cmd.when && !cmd.when()) merged.enabled = false;
  if (cmd.triggerFrom && !o.trigger) merged.trigger = cmd.triggerFrom();
  // Games keep their settings in data.games; those win over the overrides.
  if (cmd.dynamic) Object.assign(merged, cmd.dynamic());
  return merged;
}).filter((c) => c.enabled !== false && c.trigger);

const reply = async (cmd, key, ctx, extra = {}) => {
  const template = cmd.texts[key];
  if (!template) return;
  const text = await Bot.vars.render(template, { ...ctx, fields: { ...ctx.fields, ...extra } });
  const m = ctx.fields.platformMessage;
  await Bot.twitch.say(text, { replyTo: m && m.platform === 'twitch' && cmd.replyInThread ? m.id : '' });
};

const isMod = (ctx) => (ctx.user && ctx.user.role >= 3);
const targetOf = (args) => String(args[0] || '').replace(/^@/, '').toLowerCase();

system('commands', {
  name: 'List of commands', trigger: '!commands', permission: 'everyone', cooldownGlobal: 30,
  texts: { list: 'Commands: $list' },
  async run(ctx) {
    const cmds = [...Bot.data.commands.filter((c) => c.enabled !== false && !c.hidden && c.match !== 'regex'), ...CommandsApi.activeSystem().filter((c) => !c.hidden)];
    const list = cmds.filter((c) => Bot.allowed(ctx.user, c.permission || 'everyone', c.users)).map((c) => c.trigger).filter((t, i, all) => all.indexOf(t) === i);
    await reply(this, 'list', ctx, { list: list.join(', ') });
  },
});

system('uptime', {
  name: 'Uptime', trigger: '!uptime', permission: 'everyone', cooldownGlobal: 10,
  texts: { live: '$streamer has been live for $uptime.', offline: '$streamer isn’t live right now.' },
  async run(ctx) { await reply(this, (await Bot.twitch.stream()) ? 'live' : 'offline', ctx); },
});

system('followage', {
  name: 'Follow age', trigger: '!followage', permission: 'everyone', cooldownUser: 30,
  texts: { following: '$who has been following for $age.', notFollowing: '$who isn’t following.' },
  async run(ctx, args) {
    const name = targetOf(args) || ctx.user.login;
    if (ctx.user.platform !== 'twitch' && !args.length) return;
    const u = name === ctx.user.login && ctx.user.id ? { id: ctx.user.id, display_name: ctx.user.displayName } : await Bot.twitch.user(name);
    if (!u) return;
    if (u.id === Bot.twitch.streamerId()) return;
    const f = await Bot.twitch.follow(u.id);
    await reply(this, f ? 'following' : 'notFollowing', ctx, { who: u.display_name, age: f ? Bot.duration((Date.now() - Date.parse(f.followed_at)) / 1000) : '' });
  },
});

system('watchtime', {
  name: 'Watch time', trigger: '!watchtime', permission: 'everyone', cooldownUser: 30,
  texts: { reply: '$who has watched for $time.' },
  async run(ctx, args) {
    const name = targetOf(args) || ctx.user.login;
    const v = Bot.viewersDb.byLogin(name, args.length ? 'twitch' : ctx.user.platform);
    await reply(this, 'reply', ctx, { who: v ? v.displayName : name, time: Bot.duration(((v && v.minutes) || 0) * 60) });
  },
});

system('title', {
  name: 'Show or change the title', trigger: '!title', permission: 'everyone', cooldownGlobal: 10,
  texts: { show: 'Title: $title', changed: 'Title changed to: $title' },
  async run(ctx, args) {
    if (args.length && isMod(ctx)) {
      await Bot.twitch.updateChannel({ title: args.join(' ').slice(0, 140) });
      await reply(this, 'changed', ctx);
    } else {
      await reply(this, 'show', ctx);
    }
  },
});

system('game', {
  name: 'Show or change the category', trigger: '!game', permission: 'everyone', cooldownGlobal: 10,
  texts: { show: '$streamer is playing $game.', changed: 'Category changed to $game.', notFound: 'There’s no category called “$args”.' },
  async run(ctx, args) {
    if (args.length && isMod(ctx)) {
      const cat = await Bot.twitch.findCategory(args.join(' '));
      if (!cat) { await reply(this, 'notFound', ctx); return; }
      await Bot.twitch.updateChannel({ game_id: cat.id });
      await reply(this, 'changed', ctx);
    } else {
      await reply(this, 'show', ctx);
    }
  },
});

system('so', {
  name: 'Shoutout', trigger: '!so', permission: 'mods', cooldownGlobal: 5,
  texts: { reply: 'Go check out $target at https://twitch.tv/$target — they were last playing $lastGame[$target]!' },
  official: true,
  async run(ctx, args) {
    const u = await Bot.twitch.user(targetOf(args));
    if (!u) return;
    await reply(this, 'reply', ctx);
    if (this.official !== false) Bot.twitch.shoutout(u.id).catch((err) => Bot.log('info', `Twitch shoutout: ${err.message}`));
  },
});

system('marker', {
  name: 'Stream marker', trigger: '!marker', permission: 'mods', cooldownGlobal: 5,
  texts: { reply: 'Marker added.' },
  async run(ctx, args) {
    await Bot.twitch.marker(args.join(' ') || `by ${ctx.user.displayName}`);
    await reply(this, 'reply', ctx);
  },
});

system('points', {
  name: 'Points', permission: 'everyone', cooldownUser: 10,
  when: () => Bot.data.currency.enabled,
  triggerFrom: () => `!${Bot.data.currency.name.toLowerCase().replace(/\s+/g, '')}`,
  allowGive: true,
  texts: {
    own: '$who has $amount $currencyName (rank $rank).',
    gave: '$user gave $amount $currencyName to $who.',
    notEnough: '$user, you don’t have that many $currencyName.',
    changed: '$who now has $amount $currencyName.',
  },
  async run(ctx, args) {
    const [verb = '', who = '', amountText = ''] = args;
    const v = verb.toLowerCase();
    const amount = Math.floor(Number(amountText));
    if (['add', 'remove', 'set'].includes(v) && isMod(ctx) && who && Number.isFinite(amount)) {
      const login = targetOf([who]);
      const viewer = Bot.viewersDb.changeCurrency(login, 'twitch', v, amount);
      await reply(this, 'changed', ctx, { who: viewer ? viewer.displayName : login, amount: viewer ? Math.floor(viewer.currency) : 0 });
      return;
    }
    if (v === 'give' && this.allowGive !== false && who && amount > 0) {
      const login = targetOf([who]);
      if (!Bot.viewersDb.byLogin(login, 'twitch')) return;
      if (!Bot.viewersDb.spend(ctx.user, amount)) { await reply(this, 'notEnough', ctx); return; }
      const viewer = Bot.viewersDb.changeCurrency(login, 'twitch', 'add', amount);
      await reply(this, 'gave', ctx, { who: viewer.displayName, amount });
      return;
    }
    const login = targetOf(args) || ctx.user.login;
    const viewer = Bot.viewersDb.byLogin(login, args.length ? 'twitch' : ctx.user.platform);
    await reply(this, 'own', ctx, { who: viewer ? viewer.displayName : login, amount: viewer ? Math.floor(viewer.currency || 0) : 0, rank: Bot.viewersDb.rank(login) || '–' });
  },
});

system('top', {
  name: 'Points leaderboard', trigger: '!top', permission: 'everyone', cooldownGlobal: 30,
  when: () => Bot.data.currency.enabled,
  texts: { reply: 'Top $currencyName: $list' },
  async run(ctx) {
    const list = Bot.viewersDb.top(5).map((v, i) => `${i + 1}. ${v.displayName} (${Math.floor(v.currency).toLocaleString()})`).join(', ');
    await reply(this, 'reply', ctx, { list });
  },
});

system('quote', {
  name: 'Quotes', trigger: '!quote', permission: 'everyone', cooldownUser: 10, addPermission: 'mods',
  texts: {
    show: '$quoteText', none: 'No quotes yet.', notFound: 'No quote matches that.',
    added: 'Added quote #$number.', deleted: 'Deleted quote #$number.',
  },
  async run(ctx, args) {
    const [verb = '', ...rest] = args;
    const v = verb.toLowerCase();
    if (v === 'add' && rest.length && Bot.allowed(ctx.user, this.addPermission || 'mods')) {
      const q = await Bot.quotes.add(rest.join(' '), ctx.user.displayName);
      await reply(this, 'added', ctx, { number: q.id });
      return;
    }
    if ((v === 'del' || v === 'delete' || v === 'remove') && isMod(ctx) && /^\d+$/.test(rest[0] || '')) {
      if (Bot.quotes.remove(Number(rest[0]))) await reply(this, 'deleted', ctx, { number: rest[0] });
      return;
    }
    let q;
    if (/^\d+$/.test(v)) q = Bot.quotes.get(Number(v));
    else if (v === 'search' || (v && !/^\d+$/.test(v))) q = Bot.quotes.search((v === 'search' ? rest : args).join(' '));
    else q = Bot.quotes.random();
    if (!q) { await reply(this, Bot.data.quotes.list.length ? 'notFound' : 'none', ctx); return; }
    await reply(this, 'show', ctx, { quoteText: Bot.quotes.format(q), number: q.id });
  },
});

system('permit', {
  name: 'Permit a link', permission: 'mods',
  when: () => Bot.data.moderation.enabled && Bot.data.moderation.links.enabled,
  triggerFrom: () => Bot.data.moderation.links.permitTrigger || '!permit',
  texts: { reply: '$who may post a link in the next $seconds seconds.' },
  async run(ctx, args) {
    const login = targetOf(args);
    if (!login) return;
    Bot.moderation.permit(login);
    await reply(this, 'reply', ctx, { who: login, seconds: Bot.data.moderation.links.permitSeconds });
  },
});

// ---------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------

const TimersApi = Bot.timers = { lines: 0, lastAny: 0, tick: null };

TimersApi.chatLine = () => {
  TimersApi.lines++;
  for (const t of Bot.data.timers) t.linesSince = (t.linesSince || 0) + 1;
};

TimersApi.start = () => {
  clearInterval(TimersApi.tick);
  TimersApi.tick = setInterval(TimersApi.check, 10000);
};

TimersApi.check = () => {
  const now = Date.now();
  if (now - TimersApi.lastAny < (Bot.data.timerSettings.minGapSeconds || 0) * 1000) return;
  for (const t of Bot.data.timers) {
    if (!t.enabled) continue;
    if (t.onlyLive && !Bot.community.live) continue;
    if (!t.lastRun) { t.lastRun = now; continue; }
    if (now - t.lastRun < Math.max(1, Number(t.interval) || 10) * 60000) continue;
    if ((t.linesSince || 0) < (Number(t.minLines) || 0)) continue;
    TimersApi.run(t);
    return;   // one at a time, the next waits for the gap
  }
};

TimersApi.run = (t) => {
  t.lastRun = Date.now();
  t.linesSince = 0;
  TimersApi.lastAny = Date.now();
  return Bot.effects.run(t.effects, Bot.effects.newContext({ trigger: { type: 'timer', name: t.name } }));
};

TimersApi.newTimer = () => ({ id: Bot.uid('t'), name: 'New timer', enabled: true, interval: 15, minLines: 5, onlyLive: true, effects: [] });

// ---------------------------------------------------------------------------
// Effect lists, hotkeys and the HTTP API
// ---------------------------------------------------------------------------

Bot.lists = {
  run(id, args = [], trigger = { type: 'manual', name: '' }) {
    const list = Bot.data.lists.find((l) => l.id === id);
    if (!list) return Promise.resolve();
    return Bot.effects.runQueued(list.queue, list.effects, Bot.effects.newContext({ trigger: { ...trigger, name: trigger.name || list.name }, listArgs: args }));
  },
  newList: () => ({ id: Bot.uid('l'), name: 'New effect list', args: '', queue: '', effects: [] }),
  publish() {
    Bot.desktop.setCatalog(Bot.data.lists.map((l) => ({ id: l.id, name: l.name })));
  },
};

Bot.hotkeys = {
  bindings: () => Bot.data.hotkeys.filter((h) => h.enabled !== false && h.binding && h.binding.code).map((h) => [`bot:${h.id}`, h.binding]),
  run(action) {
    const id = action.slice(4);
    const hk = Bot.data.hotkeys.find((h) => h.id === id);
    if (!hk) return;
    Bot.effects.run(hk.effects, Bot.effects.newContext({ trigger: { type: 'hotkey', name: hk.name } }));
  },
  newHotkey: () => ({ id: Bot.uid('h'), name: 'New hotkey', enabled: true, binding: null, effects: [] }),
};

Bot.on('change', () => Bot.lists.publish());
