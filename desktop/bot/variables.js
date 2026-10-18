'use strict';

// $variables in effect text, the way Firebot writes them: `$user`, or with
// arguments in brackets, `$randomNumber[1,6]`, nestable:
// `$upper[$arg[1]]`. A `$word` that isn't a known variable (or a field of the
// event that ran it) is left as typed, so "$5" stays "$5".

const Vars = Bot.vars = { defs: new Map() };

function def(name, category, description, fn, usage = '') {
  Vars.defs.set(name.toLowerCase(), { name, category, description, fn, usage: usage || `$${name}` });
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function matchBracket(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '[') depth++;
    else if (text[i] === ']' && --depth === 0) return i;
  }
  return -1;
}

function splitArgs(text) {
  const args = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '[') depth++;
    else if (ch === ']') depth--;
    if (ch === ',' && depth === 0) { args.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  args.push(current.trim());
  return args;
}

function fieldValue(ctx, name) {
  const fields = (ctx && ctx.fields) || {};
  const key = Object.keys(fields).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : fields[key];
}

Vars.render = async (template, ctx = {}, depth = 0) => {
  const text = template === undefined || template === null ? '' : String(template);
  if (!text.includes('$') || depth > 20) return text;
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '$') { out += text[i++]; continue; }
    const m = /^\$([A-Za-z][A-Za-z0-9_]*)/.exec(text.slice(i, i + 64));
    if (!m) { out += text[i++]; continue; }
    const name = m[1];
    let j = i + m[0].length;
    // A value the trigger brought along ($bits, $amount…) wins over a
    // variable of the same name, unless it's written with [arguments].
    const field = text[j] === '[' ? undefined : fieldValue(ctx, name);
    const known = field === undefined ? Vars.defs.get(name.toLowerCase()) : null;
    if (!known && field === undefined) { out += m[0]; i += m[0].length; continue; }
    let rawArgs = [];
    if (text[j] === '[') {
      const end = matchBracket(text, j);
      if (end !== -1) {
        rawArgs = splitArgs(text.slice(j + 1, end));
        j = end + 1;
      }
    }
    if (known) {
      const args = await Promise.all(rawArgs.map((a) => Vars.render(a, ctx, depth + 1)));
      let value = '';
      try { value = await known.fn(ctx, args); } catch (err) { Bot.log('error', `$${name}: ${err.message}`); }
      out += value === undefined || value === null ? '' : String(value);
    } else {
      out += String(field);
    }
    i = j;
  }
  return out;
};

// ---------------------------------------------------------------------------
// Arithmetic for $math, without eval
// ---------------------------------------------------------------------------

const MATH_FUNCS = {
  round: (x, d = 0) => Math.round(x * 10 ** d) / 10 ** d,
  floor: Math.floor, ceil: Math.ceil, abs: Math.abs, sqrt: Math.sqrt,
  min: Math.min, max: Math.max, pow: Math.pow,
  random: (a = 0, b = 1) => a + Math.random() * (b - a),
};

Vars.math = (expr) => {
  const tokens = String(expr).match(/\d+(?:\.\d+)?|[A-Za-z]+|[-+*/%^(),]/g) || [];
  let pos = 0;
  const peek = () => tokens[pos];
  const take = () => tokens[pos++];
  const expect = (t) => { if (take() !== t) throw new Error(`expected ${t}`); };
  function primary() {
    const t = take();
    if (t === undefined) throw new Error('unfinished expression');
    if (t === '(') { const v = sum(); expect(')'); return v; }
    if (t === '-') return -primary();
    if (t === '+') return primary();
    if (/^\d/.test(t)) return Number(t);
    const fn = MATH_FUNCS[t.toLowerCase()];
    if (!fn) throw new Error(`unknown “${t}”`);
    expect('(');
    const args = [];
    if (peek() !== ')') { args.push(sum()); while (peek() === ',') { take(); args.push(sum()); } }
    expect(')');
    return fn(...args);
  }
  function power() {
    const base = primary();
    if (peek() === '^') { take(); return base ** power(); }
    return base;
  }
  function product() {
    let v = power();
    while (['*', '/', '%'].includes(peek())) {
      const op = take();
      const r = power();
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  }
  function sum() {
    let v = product();
    while (['+', '-'].includes(peek())) v = take() === '+' ? v + product() : v - product();
    return v;
  }
  const value = sum();
  if (pos < tokens.length) throw new Error(`unexpected “${tokens[pos]}”`);
  if (!Number.isFinite(value)) throw new Error('not a number');
  return Math.round(value * 1e6) / 1e6;
};

// "a >= b", "a contains b", for $if and the conditions.
const COMPARE_RE = /^(.*?)\s*(==|!=|>=|<=|>|<|\bcontains\b|\bstartsWith\b)\s*(.*)$/i;
Vars.compare = (left, op, right) => {
  const a = String(left).trim();
  const b = String(right).trim();
  const na = Number(a);
  const nb = Number(b);
  const numeric = a !== '' && b !== '' && Number.isFinite(na) && Number.isFinite(nb);
  switch (op.toLowerCase()) {
    case '==': return numeric ? na === nb : a.toLowerCase() === b.toLowerCase();
    case '!=': return numeric ? na !== nb : a.toLowerCase() !== b.toLowerCase();
    case '>': return numeric && na > nb;
    case '>=': return numeric && na >= nb;
    case '<': return numeric && na < nb;
    case '<=': return numeric && na <= nb;
    case 'contains': return a.toLowerCase().includes(b.toLowerCase());
    case 'startswith': return a.toLowerCase().startsWith(b.toLowerCase());
    default: return false;
  }
};

// ---------------------------------------------------------------------------
// Who a variable is about: the argument, or the chatter who ran it
// ---------------------------------------------------------------------------

const cleanName = (s) => String(s || '').trim().replace(/^@/, '').toLowerCase();

function subjectLogin(ctx, arg) {
  if (arg && arg.trim()) return cleanName(arg);
  return ctx.user ? cleanName(ctx.user.login) : '';
}

async function twitchUserFor(ctx, arg) {
  const login = subjectLogin(ctx, arg);
  if (!login) return null;
  if (!arg && ctx.user && ctx.user.platform === 'twitch' && ctx.user.id) return { id: ctx.user.id, login, display_name: ctx.user.displayName };
  return Bot.twitch.user(login);
}

const argList = (ctx) => (ctx.args || []);

// ---------------------------------------------------------------------------
// The variables
// ---------------------------------------------------------------------------

def('user', 'User', 'Display name of the chatter or viewer that triggered this', (ctx) => (ctx.user ? ctx.user.displayName || ctx.user.login : Bot.twitch.streamerLogin()));
def('username', 'User', 'Their login name (lower case)', (ctx) => (ctx.user ? ctx.user.login : Bot.twitch.streamerLogin()));
def('userId', 'User', 'Their Twitch user id', (ctx) => (ctx.user ? ctx.user.id : ''));
def('platform', 'User', 'Twitch, YouTube or TikTok', (ctx) => (ctx.user ? ({ twitch: 'Twitch', youtube: 'YouTube', tiktok: 'TikTok' }[ctx.user.platform] || '') : 'Twitch'));
def('userRole', 'User', 'Their highest role: broadcaster, mod, vip, sub or viewer', (ctx) => ['viewer', 'sub', 'vip', 'mod', 'broadcaster'][(ctx.user && ctx.user.role) || 0]);
def('target', 'Command', 'The first word after the command, without @ (often a username)', (ctx) => String(argList(ctx)[0] || '').replace(/^@/, '').replace(/[^\p{L}\p{N}_.]+$/u, ''));
def('arg', 'Command', 'A word after the command. $arg[1] is the first; $arg[2-] is the second onwards; $arg[all] is everything', (ctx, [n = '1']) => {
  const args = argList(ctx);
  if (n === 'all') return args.join(' ');
  const range = /^(\d+)-(\d*)$/.exec(n);
  if (range) return args.slice(Number(range[1]) - 1, range[2] ? Number(range[2]) : undefined).join(' ');
  return args[Number(n) - 1] || '';
}, '$arg[1]');
def('args', 'Command', 'Everything after the command', (ctx) => argList(ctx).join(' '));
def('argCount', 'Command', 'How many words came after the command', (ctx) => argList(ctx).length);
def('count', 'Command', 'How many times this command has been used', (ctx) => (ctx.command ? ctx.command.count || 0 : 0));
def('message', 'Chat', 'The chat message, or the message that came with a sub, cheer or redemption', (ctx) => (ctx.message ? ctx.message.text : fieldValue(ctx, 'message') || ''));
def('messageId', 'Chat', 'The id of the chat message that triggered this', (ctx) => (ctx.message ? ctx.message.id : ''));
def('listArg', 'Effect lists', 'An argument handed to this effect list: $listArg[1]', (ctx, [n = '1']) => (ctx.listArgs || [])[Number(n) - 1] || '', '$listArg[1]');
def('effectOutput', 'Effect lists', 'What an earlier effect kept, e.g. an HTTP response: $effectOutput[name]', (ctx, [name = '']) => (ctx.outputs || {})[name] ?? '', '$effectOutput[name]');

def('counter', 'Data', 'A counter’s value: $counter[deaths]', (ctx, [name = '']) => {
  const c = Bot.counters.find(name);
  return c ? c.value : 0;
}, '$counter[name]');
def('var', 'Data', 'A custom variable set with the “Set variable” effect: $var[name]', (ctx, [name = '']) => Bot.data.variables[name.toLowerCase()] ?? '', '$var[name]');

def('currency', 'Currency', 'Points of the chatter, or of the user named: $currency[name]', (ctx, [name = '']) => {
  const v = Bot.viewersDb.byLogin(subjectLogin(ctx, name), ctx.user && !name ? ctx.user.platform : 'twitch');
  return v ? Math.floor(v.currency || 0) : 0;
}, '$currency');
def('currencyName', 'Currency', 'What the points are called', () => Bot.data.currency.name);
def('currencyRank', 'Currency', 'Their place on the points leaderboard', (ctx, [name = '']) => Bot.viewersDb.rank(subjectLogin(ctx, name)) || '');
def('watchTime', 'Viewers', 'How long they’ve watched, e.g. “3 hours, 20 minutes”', (ctx, [name = '']) => {
  const v = Bot.viewersDb.byLogin(subjectLogin(ctx, name), 'twitch');
  return Bot.duration(((v && v.minutes) || 0) * 60);
}, '$watchTime');
def('chatMessages', 'Viewers', 'How many chat messages they’ve sent', (ctx, [name = '']) => {
  const v = Bot.viewersDb.byLogin(subjectLogin(ctx, name), ctx.user && !name ? ctx.user.platform : 'twitch');
  return v ? v.messages || 0 : 0;
}, '$chatMessages');
def('randomViewer', 'Viewers', 'Someone who chatted in the last 15 minutes', () => {
  const recent = Bot.viewersDb.recentChatters(15);
  const pick = recent[Math.floor(Math.random() * recent.length)];
  return pick ? pick.displayName || pick.login : '';
});

def('randomNumber', 'Random', 'A whole number between the two, both included: $randomNumber[1,100]', (ctx, [a = '1', b = '100']) => {
  const lo = Math.ceil(Math.min(Number(a), Number(b)));
  const hi = Math.floor(Math.max(Number(a), Number(b)));
  return Number.isFinite(lo) && Number.isFinite(hi) ? lo + Math.floor(Math.random() * (hi - lo + 1)) : '';
}, '$randomNumber[1,100]');
def('pick', 'Random', 'One of the choices at random: $pick[heads,tails]', (ctx, args) => args[Math.floor(Math.random() * args.length)] || '', '$pick[a,b,c]');

def('math', 'Text and numbers', 'Works out arithmetic: $math[$bits / 100]. Has round(), floor(), ceil(), min(), max(), abs(), sqrt()', (ctx, args) => Vars.math(args.join(',')), '$math[1 + 2]');
def('if', 'Text and numbers', 'Picks text by a comparison: $if[$bits >= 100,big cheer,cheer]. Compares with == != > >= < <= contains startsWith', (ctx, [cond = '', yes = '', no = '']) => {
  const m = COMPARE_RE.exec(cond);
  const result = m ? Vars.compare(m[1], m[2], m[3]) : !!cond.trim() && cond.trim() !== 'false' && cond.trim() !== '0';
  return result ? yes : no;
}, '$if[a == b,yes,no]');
def('upper', 'Text and numbers', 'IN CAPITALS', (ctx, args) => args.join(',').toUpperCase(), '$upper[text]');
def('lower', 'Text and numbers', 'in lower case', (ctx, args) => args.join(',').toLowerCase(), '$lower[text]');
def('length', 'Text and numbers', 'How many characters', (ctx, args) => Array.from(args.join(',')).length, '$length[text]');
def('urlEncode', 'Text and numbers', 'Safe to put in a link', (ctx, args) => encodeURIComponent(args.join(',')), '$urlEncode[text]');
def('number', 'Text and numbers', 'A number with thousands separators: $number[12345]', (ctx, [n = '']) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString() : n), '$number[1234]');

def('streamer', 'Channel', 'Your display name', () => (Bot.twitch.accounts.streamer ? Bot.twitch.accounts.streamer.displayName : ''));
def('bot', 'Channel', 'The bot account’s name (or yours, without one)', () => {
  const a = Bot.twitch.accounts.bot || Bot.twitch.accounts.streamer;
  return a ? a.displayName : '';
});
def('uptime', 'Channel', 'How long the stream has been live', async () => {
  const stream = await Bot.twitch.stream();
  return stream ? Bot.duration((Date.now() - Date.parse(stream.started_at)) / 1000) : 'offline';
});
def('isLive', 'Channel', '“true” while live', async () => String(!!(await Bot.twitch.stream())));
def('game', 'Channel', 'The stream’s category, or the category of the channel named: $game[name]', async (ctx, [name = '']) => {
  if (name.trim()) {
    const u = await Bot.twitch.user(name);
    if (!u) return '';
    const res = await Bot.twitch.api('GET', '/channels', { query: { broadcaster_id: u.id } });
    return (res.data && res.data[0] && res.data[0].game_name) || '';
  }
  const ch = await Bot.twitch.channel();
  return ch ? ch.game_name : '';
}, '$game');
def('title', 'Channel', 'The stream title', async () => {
  const ch = await Bot.twitch.channel();
  return ch ? ch.title : '';
});
def('viewerCount', 'Channel', 'Viewers watching now', async () => {
  const stream = await Bot.twitch.stream();
  return stream ? stream.viewer_count : 0;
});
def('followCount', 'Channel', 'How many followers the channel has', () => Bot.twitch.followerCount());
def('followAge', 'Viewers', 'How long they’ve followed: $followAge or $followAge[name]', async (ctx, [name = '']) => {
  const u = await twitchUserFor(ctx, name);
  if (!u) return '';
  const f = await Bot.twitch.follow(u.id);
  return f ? Bot.duration((Date.now() - Date.parse(f.followed_at)) / 1000) : 'not following';
}, '$followAge');
def('accountAge', 'Viewers', 'How old their Twitch account is', async (ctx, [name = '']) => {
  const u = await twitchUserFor(ctx, name);
  if (!u) return '';
  const full = u.created_at ? u : await Bot.twitch.userById(u.id);
  return full && full.created_at ? Bot.duration((Date.now() - Date.parse(full.created_at)) / 1000) : '';
}, '$accountAge');
def('lastGame', 'Viewers', 'The last category the user named streamed (for shoutouts): $lastGame[name]', async (ctx, [name = '']) => {
  const u = await twitchUserFor(ctx, name || argList(ctx)[0] || '');
  if (!u) return '';
  const res = await Bot.twitch.api('GET', '/channels', { query: { broadcaster_id: u.id } });
  return (res.data && res.data[0] && res.data[0].game_name) || 'something';
}, '$lastGame[$target]');

def('date', 'Time', 'Today’s date', () => new Date().toLocaleDateString());
def('time', 'Time', 'The time now', () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
def('quote', 'Quotes', 'A random quote, or quote number N: $quote[3]', (ctx, [n = '']) => {
  const q = n ? Bot.quotes.get(Number(n)) : Bot.quotes.random();
  return q ? Bot.quotes.format(q) : '';
}, '$quote');

// What the editors list, grouped.
Vars.catalog = () => {
  const groups = new Map();
  for (const v of Vars.defs.values()) {
    if (!groups.has(v.category)) groups.set(v.category, []);
    groups.get(v.category).push(v);
  }
  return groups;
};
