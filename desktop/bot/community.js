'use strict';

// Everything about the people in chat: the viewer database (with watch time
// and points), counters, quotes, the points games and chat moderation.

// ---------------------------------------------------------------------------
// Live status
// ---------------------------------------------------------------------------

const Community = Bot.community = {
  live: false,
  session: `app-${Date.now()}`,   // what "this stream" means for "viewer arrived"
  present: new Map(),             // platform:login -> last time seen in the chatters list or chat
  timers: [],
};

Community.setLive = (live, startedAt = '') => {
  if (live && !Community.live) Community.session = startedAt ? `stream-${startedAt}` : `stream-${Date.now()}`;
  Community.live = live;
  Bot.emit('live', live);
};

async function pollStream() {
  if (!Bot.twitch.loggedIn()) return;
  try {
    Bot.twitch.forget('stream');
    const stream = await Bot.twitch.stream();
    if (!!stream !== Community.live || (stream && Community.session !== `stream-${stream.started_at}`)) Community.setLive(!!stream, stream ? stream.started_at : '');
    Bot.emit('stream', stream);
  } catch (err) {
    Bot.log('error', `Couldn’t check whether you’re live: ${err.message}`);
  }
}

// Who is in chat: Twitch's chatters list (it includes lurkers), refreshed
// every few minutes, plus anyone who wrote something recently anywhere.
async function pollChatters() {
  if (!Bot.twitch.loggedIn()) return;
  try {
    const list = await Bot.twitch.chatters();
    const now = Date.now();
    for (const c of list) {
      const v = Viewers.ensure({ platform: 'twitch', login: c.user_login, id: c.user_id, displayName: c.user_name });
      v.lastSeen = now;
      Community.present.set(`twitch:${c.user_login}`, now);
    }
  } catch (err) {
    if (err.status !== 403) Bot.log('error', `Couldn’t get the chatters list: ${err.message}`);
  }
}

// Once a minute: watch time while live, and points.
function accrue() {
  const now = Date.now();
  const cur = Bot.data.currency;
  const counting = Community.live || cur.whileOffline;
  if (!counting) {
    for (const [key, at] of Community.present) if (now - at > 15 * 60000) Community.present.delete(key);
    return;
  }
  const botLogin = Bot.twitch.accounts.bot && Bot.twitch.accounts.bot.login;
  for (const [key, at] of Community.present) if (now - at > 15 * 60000) Community.present.delete(key);
  for (const v of Viewers.watching()) {
    if (v.platform === 'twitch' && v.login === botLogin) continue;
    if (Community.live) v.minutes = (v.minutes || 0) + 1;
    if (!cur.enabled) continue;
    if (cur.activeOnly && now - (v.lastChat || 0) > 15 * 60000) continue;
    Viewers.applyCurrency(v, 'add', Number(cur.perMinute || 0) + ((v.role || 0) >= 1 ? Number(cur.subBonus || 0) : 0));
  }
  Bot.saveViewers();
  Bot.emit('viewers');
}

Community.start = () => {
  for (const t of Community.timers) clearInterval(t);
  pollStream();
  pollChatters();
  Community.timers = [
    setInterval(pollStream, 2 * 60000),
    setInterval(pollChatters, 5 * 60000),
    setInterval(accrue, 60000),
  ];
};

// ---------------------------------------------------------------------------
// Viewer database
// ---------------------------------------------------------------------------

// Keyed by platform and login: "twitch:alice", "youtube:bob".
const Viewers = Bot.viewersDb = {};
const keyOf = (platform, login) => `${platform || 'twitch'}:${String(login || '').toLowerCase().replace(/^@/, '')}`;

Viewers.byLogin = (login, platform = 'twitch') => (login ? Bot.viewers.users[keyOf(platform, login)] || null : null);

Viewers.ensure = (user) => {
  const key = keyOf(user.platform, user.login);
  let v = Bot.viewers.users[key];
  if (!v) {
    v = Bot.viewers.users[key] = {
      key, platform: user.platform || 'twitch', login: String(user.login || '').toLowerCase(), id: user.id || '',
      displayName: user.displayName || user.login, firstSeen: Date.now(), lastSeen: Date.now(), lastChat: 0,
      messages: 0, minutes: 0, currency: Number(Bot.data.currency.startAmount) || 0, role: 0, session: '',
    };
  }
  if (user.displayName) v.displayName = user.displayName;
  if (user.id) v.id = user.id;
  return v;
};

Viewers.noteChat = (msg) => {
  const isNew = !Bot.viewers.users[keyOf(msg.user.platform, msg.user.login)];
  const v = Viewers.ensure(msg.user);
  const now = Date.now();
  v.messages = (v.messages || 0) + 1;
  v.lastChat = now;
  v.lastSeen = now;
  v.role = msg.user.role || 0;
  Community.present.set(v.key, now);
  const firstThisStream = v.session !== Community.session;
  v.session = Community.session;
  Bot.saveViewers();
  return { firstEver: isNew, firstThisStream };
};

Viewers.noteEvent = (user, type, fields) => {
  const v = Viewers.ensure(user);
  if (type === 'follow') v.followedAt = Date.now();
  if (type === 'cheer') v.bits = (v.bits || 0) + (Number(fields.bits) || 0);
  if (type === 'sub' || type === 'resub') v.subTier = fields.tier;
  if (type === 'giftSub') v.giftsGiven = (v.giftsGiven || 0) + (Number(fields.giftCount) || 0);
  Bot.saveViewers();
};

// Here now: in the last chatters list (10 minutes), or wrote something in the last 10 minutes.
Viewers.watching = () => {
  const cutoff = Date.now() - 10 * 60000;
  return [...Community.present.entries()].filter(([, at]) => at > cutoff).map(([key]) => Bot.viewers.users[key]).filter(Boolean);
};

Viewers.recentChatters = (minutes = 15) => {
  const cutoff = Date.now() - minutes * 60000;
  const botLogin = Bot.twitch.accounts.bot && Bot.twitch.accounts.bot.login;
  return Object.values(Bot.viewers.users).filter((v) => (v.lastChat || 0) > cutoff && v.login !== botLogin);
};

Viewers.applyCurrency = (v, action, amount) => {
  const max = Number(Bot.data.currency.max) || 0;
  let next = action === 'set' ? amount : action === 'remove' ? (v.currency || 0) - amount : (v.currency || 0) + amount;
  next = Math.max(0, next);
  if (max > 0) next = Math.min(max, next);
  v.currency = Math.round(next * 100) / 100;
};

Viewers.changeCurrency = (login, platform, action, amount, user = null) => {
  let v = Viewers.byLogin(login, platform);
  if (!v && user) v = Viewers.ensure(user);
  if (!v && login) v = Viewers.ensure({ platform, login, displayName: login });
  if (!v) return null;
  Viewers.applyCurrency(v, action, amount);
  Bot.saveViewers();
  Bot.emit('viewers');
  return v;
};

Viewers.spend = (user, cost) => {
  const v = Viewers.byLogin(user.login, user.platform);
  if (!v || (v.currency || 0) < cost) return false;
  v.currency -= cost;
  Bot.saveViewers();
  Bot.emit('viewers');
  return true;
};

Viewers.balance = (user) => {
  const v = Viewers.byLogin(user.login, user.platform);
  return v ? Math.floor(v.currency || 0) : 0;
};

Viewers.top = (n = 10) => {
  const botLogin = Bot.twitch.accounts.bot && Bot.twitch.accounts.bot.login;
  return Object.values(Bot.viewers.users).filter((v) => v.login !== botLogin && v.login !== Bot.twitch.streamerLogin())
    .sort((a, b) => (b.currency || 0) - (a.currency || 0)).slice(0, n);
};

Viewers.rank = (login) => {
  const sorted = Object.values(Bot.viewers.users).sort((a, b) => (b.currency || 0) - (a.currency || 0));
  const i = sorted.findIndex((v) => v.login === String(login || '').toLowerCase());
  return i === -1 ? 0 : i + 1;
};

Viewers.remove = (key) => {
  delete Bot.viewers.users[key];
  Bot.saveViewers();
  Bot.emit('viewers');
};

Viewers.csv = () => {
  const cols = ['platform', 'login', 'displayName', 'firstSeen', 'lastSeen', 'messages', 'minutes', 'currency', 'bits', 'giftsGiven'];
  const cell = (v) => {
    const s = v === undefined || v === null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = Object.values(Bot.viewers.users).map((v) => cols.map((c) => cell(c === 'firstSeen' || c === 'lastSeen' ? (v[c] ? new Date(v[c]).toISOString() : '') : v[c])).join(','));
  return [cols.join(','), ...rows].join('\n');
};

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

Bot.counters = {
  find: (name) => Bot.data.counters.find((c) => c.name.toLowerCase() === String(name || '').trim().toLowerCase()) || null,
  update(name, action, amount) {
    const clean = String(name || '').trim();
    if (!clean) return null;
    let c = Bot.counters.find(clean);
    if (!c) {
      c = { id: Bot.uid('n'), name: clean, value: 0, min: '', max: '', file: '' };
      Bot.data.counters.push(c);
    }
    let v = action === 'set' ? amount : action === 'reset' ? 0 : action === 'subtract' ? c.value - amount : c.value + amount;
    if (c.min !== '' && Number.isFinite(Number(c.min))) v = Math.max(Number(c.min), v);
    if (c.max !== '' && Number.isFinite(Number(c.max))) v = Math.min(Number(c.max), v);
    c.value = Math.round(v * 1000) / 1000;
    Bot.save();
    Bot.counters.publish(c);
    Bot.emit('counters');
    return c;
  },
  publish(c) {
    Bot.overlay.send({ type: 'counter', name: c.name, value: c.value });
    if (c.file) Bot.desktop.writeFile({ file: c.file, text: String(c.value) }).then((r) => { if (r.error) Bot.log('error', `Counter ${c.name}: ${r.error}`); });
  },
  publishAll() { for (const c of Bot.data.counters) Bot.counters.publish(c); },
};

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

Bot.quotes = {
  get: (n) => Bot.data.quotes.list.find((q) => q.id === n) || null,
  random() {
    const list = Bot.data.quotes.list;
    return list.length ? list[Math.floor(Math.random() * list.length)] : null;
  },
  search(text) {
    const q = text.trim().toLowerCase();
    if (!q) return Bot.quotes.random();
    const hits = Bot.data.quotes.list.filter((x) => x.text.toLowerCase().includes(q) || (x.author || '').toLowerCase().includes(q));
    return hits.length ? hits[Math.floor(Math.random() * hits.length)] : null;
  },
  // "!quote add @alice I never miss" quotes Alice; without an @ it's the streamer.
  async add(text, addedBy = '', who = '') {
    let body = text.trim();
    let author = who || (Bot.twitch.accounts.streamer ? Bot.twitch.accounts.streamer.displayName : '');
    const m = who ? null : /^@(\w+)\s+(.+)$/.exec(body);
    if (m) { author = m[1]; body = m[2]; }
    body = body.replace(/^["“]|["”]$/g, '');
    let game = '';
    try { const ch = await Bot.twitch.channel(); game = ch ? ch.game_name : ''; } catch {}
    const q = { id: Bot.data.quotes.next++, text: body, author, game, date: Date.now(), addedBy };
    Bot.data.quotes.list.push(q);
    Bot.save();
    return q;
  },
  remove(n) {
    const before = Bot.data.quotes.list.length;
    Bot.data.quotes.list = Bot.data.quotes.list.filter((q) => q.id !== n);
    Bot.save();
    return Bot.data.quotes.list.length < before;
  },
  format: (q) => `#${q.id}: “${q.text}” — ${q.author || 'unknown'}${q.game ? `, ${q.game}` : ''}, ${new Date(q.date).toLocaleDateString()}`,
};

// ---------------------------------------------------------------------------
// Games
// ---------------------------------------------------------------------------

const Games = Bot.games = { heist: null, raffle: { open: false, prize: '', entries: new Map() } };
const sayIt = (text, ctx, extra = {}) => Bot.vars.render(text, { ...ctx, fields: { ...(ctx.fields || {}), ...extra } }).then((t) => (t.trim() ? Bot.twitch.say(t) : null));

// "100", "all", "half" or "50%" of what they have.
function betAmount(text, user, game) {
  const have = Viewers.balance(user);
  const t = String(text || '').trim().toLowerCase();
  let bet = t === 'all' ? have : t === 'half' ? Math.floor(have / 2) : /^\d+%$/.test(t) ? Math.floor((have * Number(t.slice(0, -1))) / 100) : Math.floor(Number(t));
  if (!Number.isFinite(bet) || bet <= 0) return { error: `Bet between ${game.minBet} and ${game.maxBet}, e.g. ${game.trigger} ${game.minBet}` };
  if (bet < game.minBet) return { error: `The smallest bet is ${game.minBet}` };
  if (game.maxBet > 0) bet = Math.min(bet, game.maxBet);
  if (bet > have) return { error: `you only have ${have} ${Bot.data.currency.name}` };
  return { bet };
}

function gameCommand(id, name, handler) {
  Bot.commands.define(id, {
    name,
    texts: {},
    dynamic: () => {
      const g = Bot.data.games[id];
      return { trigger: g.trigger, enabled: !!g.enabled && Bot.data.currency.enabled, cooldownUser: id === 'heist' ? 0 : g.cooldown, permission: 'everyone' };
    },
    run: handler,
  });
}

gameCommand('slots', 'Slots', async (ctx, args) => {
  const g = Bot.data.games.slots;
  const { bet, error } = betAmount(args[0], ctx.user, g);
  if (error) return sayIt(`@$user, ${error}.`, ctx);
  Viewers.spend(ctx.user, bet);
  const symbols = String(g.symbols).split(/\s+/).filter(Boolean);
  const pick = () => symbols[Math.floor(Math.random() * symbols.length)];
  const win = Math.random() * 100 < g.chance;
  let reels;
  if (win) { const s = pick(); reels = [s, s, s]; } else {
    do { reels = [pick(), pick(), pick()]; } while (symbols.length > 1 && reels[0] === reels[1] && reels[1] === reels[2]);
  }
  const payout = win ? Math.floor(bet * g.multiplier) : 0;
  if (payout) Viewers.changeCurrency(ctx.user.login, ctx.user.platform, 'add', payout);
  return sayIt(win ? `@$user [ ${reels.join(' | ')} ] You won ${payout} $currencyName!` : `@$user [ ${reels.join(' | ')} ] No luck, you lost ${bet} $currencyName.`, ctx);
});

gameCommand('gamble', 'Gamble', async (ctx, args) => {
  const g = Bot.data.games.gamble;
  const { bet, error } = betAmount(args[0], ctx.user, g);
  if (error) return sayIt(`@$user, ${error}.`, ctx);
  Viewers.spend(ctx.user, bet);
  const roll = Math.floor(Math.random() * 100) + 1;
  const win = roll <= g.chance;
  const payout = win ? Math.floor(bet * g.multiplier) : 0;
  if (payout) Viewers.changeCurrency(ctx.user.login, ctx.user.platform, 'add', payout);
  return sayIt(win ? `@$user rolled ${roll} and won ${payout} $currencyName! They now have $currency.` : `@$user rolled ${roll} and lost ${bet} $currencyName.`, ctx);
});

gameCommand('heist', 'Heist', async (ctx, args) => {
  const g = Bot.data.games.heist;
  const now = Date.now();
  const h = Games.heist;
  if (!h && Games.heistCooldownUntil && now < Games.heistCooldownUntil) {
    return sayIt(`@$user, the crew is lying low. Try again in ${Math.ceil((Games.heistCooldownUntil - now) / 1000)} seconds.`, ctx);
  }
  if (h && h.entries.has(`${ctx.user.platform}:${ctx.user.login}`)) return null;
  const { bet, error } = betAmount(args[0], ctx.user, g);
  if (error) return sayIt(`@$user, ${error}.`, ctx);
  Viewers.spend(ctx.user, bet);
  const extra = { trigger: g.trigger, seconds: g.joinSeconds };
  if (!h) {
    Games.heist = { entries: new Map([[`${ctx.user.platform}:${ctx.user.login}`, { user: ctx.user, bet }]]) };
    sayIt(g.startText, ctx, extra);
    setTimeout(() => finishHeist(ctx), g.joinSeconds * 1000);
  } else {
    h.entries.set(`${ctx.user.platform}:${ctx.user.login}`, { user: ctx.user, bet });
    if (g.joinText) sayIt(g.joinText, ctx, extra);
  }
  return null;
});

async function finishHeist(ctx) {
  const g = Bot.data.games.heist;
  const h = Games.heist;
  Games.heist = null;
  Games.heistCooldownUntil = Date.now() + g.cooldown * 1000;
  if (!h) return;
  const entries = [...h.entries.values()];
  if (entries.length < g.minUsers) {
    for (const e of entries) Viewers.changeCurrency(e.user.login, e.user.platform, 'add', e.bet);
    await sayIt(`Not enough people joined the heist (${entries.length} of ${g.minUsers}). Everyone got their $currencyName back.`, ctx);
    return;
  }
  const winners = [];
  for (const e of entries) {
    if (Math.random() * 100 < g.chance) {
      const payout = Math.floor(e.bet * g.multiplier);
      Viewers.changeCurrency(e.user.login, e.user.platform, 'add', payout);
      winners.push(`${e.user.displayName} (${payout})`);
    }
  }
  await sayIt(winners.length ? g.successText : g.failText, ctx, { winners: winners.join(', ') });
}

// A raffle: entries open with the effect, a button, or "!raffle start <prize>" from a mod.
Games.raffleAction = async (action, prize = '') => {
  const r = Games.raffle;
  const g = Bot.data.games.raffle;
  const ctx = Bot.effects.newContext();
  if (action === 'start') {
    r.open = true;
    r.prize = prize;
    r.entries.clear();
    if (g.announce) await sayIt(`A raffle${prize ? ` for ${prize}` : ''} is open! Type ${g.trigger} to enter${g.cost ? ` (costs ${g.cost} $currencyName)` : ''}.`, ctx);
  } else if (action === 'close') {
    r.open = false;
    if (g.announce) await sayIt(`The raffle is closed, with ${r.entries.size} ${r.entries.size === 1 ? 'entry' : 'entries'}.`, ctx);
  } else if (action === 'draw') {
    r.open = false;
    const pool = [...r.entries.values()];
    const winners = [];
    for (let i = 0; i < Math.max(1, g.winners) && pool.length; i++) winners.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    r.winners = winners;
    Bot.addActivity({ kind: 'note', text: winners.length ? `Raffle winner${winners.length > 1 ? 's' : ''}: ${winners.map((w) => w.displayName).join(', ')}` : 'The raffle had no entries' });
    await sayIt(winners.length ? `The raffle${r.prize ? ` for ${r.prize}` : ''} goes to ${winners.map((w) => `@${w.displayName}`).join(', ')}! 🎉` : 'Nobody entered the raffle.', ctx);
  } else if (action === 'clear') {
    r.entries.clear();
    r.winners = [];
  }
  Bot.emit('raffle');
};

Bot.commands.define('raffle', {
  name: 'Raffle entry',
  texts: {},
  dynamic: () => {
    const g = Bot.data.games.raffle;
    return { trigger: g.trigger, enabled: Games.raffle.open, permission: g.permission };
  },
  async run(ctx) {
    const g = Bot.data.games.raffle;
    const key = `${ctx.user.platform}:${ctx.user.login}`;
    if (!Games.raffle.open || Games.raffle.entries.has(key)) return;
    if (g.cost > 0 && Bot.data.currency.enabled && !Viewers.spend(ctx.user, g.cost)) {
      await sayIt(`@$user, entering costs ${g.cost} $currencyName.`, ctx);
      return;
    }
    Games.raffle.entries.set(key, ctx.user);
    Bot.emit('raffle');
  },
});

Bot.commands.define('raffleAdmin', {
  name: 'Raffle control (mods)', trigger: '!raffle', permission: 'mods',
  texts: {},
  async run(ctx, args) {
    const [verb = '', ...rest] = args;
    const v = verb.toLowerCase();
    if (['start', 'open'].includes(v)) await Games.raffleAction('start', rest.join(' '));
    else if (['close', 'stop'].includes(v)) await Games.raffleAction('close');
    else if (['draw', 'pick', 'end'].includes(v)) await Games.raffleAction('draw');
    else if (v === 'clear') await Games.raffleAction('clear');
  },
});

// ---------------------------------------------------------------------------
// Moderation
// ---------------------------------------------------------------------------

const Moderation = Bot.moderation = { permits: new Map(), offences: new Map(), history: new Map() };
const LINK_RE = /\b(?:https?:\/\/|www\.)\S+|\b[\w-]+(?:\.[\w-]+)*\.(?:com|net|org|tv|gg|io|co|me|ly|be|dev|app|xyz|info|biz|ru|uk|de|us|link|live|site|shop|online)(?:\/\S*)?\b/gi;

Moderation.permit = (login) => Moderation.permits.set(String(login).toLowerCase(), Date.now() + Bot.data.moderation.links.permitSeconds * 1000);

function bannedHit(text) {
  const m = Bot.data.moderation;
  const lower = ` ${text.toLowerCase()} `;
  for (const raw of m.bannedWords.split(/\n|,/)) {
    const word = raw.trim().toLowerCase();
    if (!word) continue;
    // Whole words only, so "class" doesn't trip over "ass". A * is a wildcard.
    const pattern = word.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '\\S*');
    if (new RegExp(`(^|[^\\p{L}\\p{N}])${pattern}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(lower)) return word;
  }
  for (const raw of m.bannedRegex.split('\n')) {
    const source = raw.trim();
    if (!source) continue;
    try { if (new RegExp(source, 'i').test(text)) return source; } catch {}
  }
  return null;
}

async function linkAllowed(url) {
  const allowed = (await Bot.vars.render(Bot.data.moderation.links.allowed, {})).toLowerCase().split(/\s+/).filter(Boolean);
  const u = url.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '');
  return allowed.some((a) => u.startsWith(a.replace(/^https?:\/\//, '').replace(/^www\./, '')));
}

// What's wrong with a message, or null.
async function problemWith(msg) {
  const m = Bot.data.moderation;
  const text = msg.text;
  const banned = bannedHit(text);
  if (banned) return { reason: 'that word isn’t allowed here', banned: true };

  if (m.links.enabled) {
    const links = text.match(LINK_RE) || [];
    if (links.length) {
      const until = Moderation.permits.get(msg.user.login) || 0;
      if (until > Date.now()) {
        Moderation.permits.delete(msg.user.login);
      } else {
        for (const link of links) if (!(await linkAllowed(link))) return { reason: 'please don’t post links without permission' };
      }
    }
  }
  const letters = text.replace(/[^\p{L}]/gu, '');
  if (m.caps.enabled && letters.length >= m.caps.minLength) {
    const upper = letters.replace(/[^\p{Lu}]/gu, '').length;
    if ((upper / letters.length) * 100 >= m.caps.percent) return { reason: 'please don’t shout (too many capitals)' };
  }
  const visible = text.replace(/\s/g, '');
  if (m.symbols.enabled && visible.length >= m.symbols.minLength) {
    const symbols = visible.replace(/[\p{L}\p{N}]/gu, '').length;
    if ((symbols / visible.length) * 100 >= m.symbols.percent) return { reason: 'too many symbols' };
  }
  if (m.emotes.enabled && msg.emotes > m.emotes.max) return { reason: 'too many emotes' };
  if (m.length.enabled && text.length > m.length.max) return { reason: 'that message is too long' };
  if (m.repeats.enabled) {
    const key = msg.user.login;
    const now = Date.now();
    const list = (Moderation.history.get(key) || []).filter((h) => now - h.at < m.repeats.seconds * 1000);
    list.push({ at: now, text: text.trim().toLowerCase() });
    Moderation.history.set(key, list.slice(-10));
    if (list.filter((h) => h.text === text.trim().toLowerCase()).length >= m.repeats.count) return { reason: 'please don’t repeat yourself' };
  }
  return null;
}

// True when the message was dealt with (deleted or the chatter timed out).
Moderation.check = async (msg) => {
  const m = Bot.data.moderation;
  if (!m.enabled || msg.platform !== 'twitch' || !Bot.twitch.loggedIn()) return false;
  if (Bot.allowed(msg.user, m.exempt) || msg.user.role >= 3) return false;
  const problem = await problemWith(msg);
  if (!problem) return false;

  const now = Date.now();
  const past = (Moderation.offences.get(msg.user.login) || []).filter((t) => now - t < 10 * 60000);
  past.push(now);
  Moderation.offences.set(msg.user.login, past);

  let action = problem.banned ? m.bannedAction : m.action;
  if (!problem.banned && m.escalate && past.length > 1) action = 'timeout';
  try {
    if (action === 'ban') await Bot.twitch.ban(msg.user.id, { reason: `Chat Reader: ${problem.reason}` });
    else if (action === 'timeout') {
      const seconds = m.escalate ? m.timeoutSeconds * Math.max(1, past.length - (problem.banned ? 0 : 1)) : m.timeoutSeconds;
      await Bot.twitch.ban(msg.user.id, { seconds, reason: `Chat Reader: ${problem.reason}` });
    } else await Bot.twitch.deleteMessage(msg.id);
    if (m.warnText && action !== 'ban') await sayIt(m.warnText, { user: msg.user }, { reason: problem.reason });
    Bot.addActivity({ kind: 'mod', text: `${action === 'delete' ? 'Deleted a message from' : action === 'ban' ? 'Banned' : 'Timed out'} ${msg.user.displayName}: ${problem.reason}` });
  } catch (err) {
    Bot.log('error', `Moderation: ${err.message}`);
  }
  return true;
};

// For the Moderation tab: what would happen to a message.
Moderation.test = async (text) => {
  const p = await problemWith({ text, emotes: 0, user: { login: '__test__', role: 0 } });
  Moderation.history.delete('__test__');
  return p;
};
