'use strict';

// Multistream: one stream on Twitch, YouTube and TikTok at once, with the
// three chats joined up. Every message written on one platform is posted on
// the other two, after a prefix the streamer chooses ("[YouTube] Alice: …"),
// so viewers everywhere see the whole conversation. The same messages can
// also be shown on stream in a combined chat overlay.
//
// Reading: Twitch comes over EventSub (triggers.js); YouTube and TikTok come
// from the reader's own top-bar chats when it reads the same channel, or from
// a connection of the relay's own. Sending: Twitch through Helix (as the bot
// account or the streamer), YouTube through the YouTube Data API (signed in
// with Google), TikTok through Euler Stream (experimental; see multistream-main.js).

const RELAY_PLATFORMS = ['twitch', 'youtube', 'tiktok'];
// Longest message each platform takes, and the least time between two posts.
const LIMITS = {
  twitch: { max: 500, gap: 1600 },
  youtube: { max: 200, gap: 1500 },
  tiktok: { max: 150, gap: 2500 },
};
const ECHO_MS = 120000;
const YT = 'https://www.googleapis.com/youtube/v3';
const YT_UNITS = { insert: 20, list: 1 };   // YouTube Data API quota costs
const YT_DAILY = 10000;                      // a project's default daily quota

const Relay = Bot.relay = {
  own: {},           // platform -> { id, target, state, text, videoId }
  boxes: { twitch: [], youtube: [], tiktok: [] },
  timers: {},
  nextAt: { twitch: 0, youtube: 0, tiktok: 0 },
  stats: {
    twitch: { sent: 0, dropped: 0, error: '' },
    youtube: { sent: 0, dropped: 0, error: '' },
    tiktok: { sent: 0, dropped: 0, error: '' },
  },
  sent: [],          // [{ platform, norm, at }]: what was posted, to recognise it coming back
  youtube: { account: null, liveChatId: '', chatFor: '', pausedUntil: 0 },
};

const cfg = () => Bot.data.multistream;
const norm = (text) => String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// Which chats are part of the multistream
// ---------------------------------------------------------------------------

function targetFor(platform) {
  const raw = (cfg()[platform] || '').trim();
  if (!raw) return '';
  return (platform === 'youtube' ? normalizeYouTube(raw) : normalizeTikTok(raw)) || '';
}

// The reader's chat for the same channel, if it's reading it.
function readerChatFor(platform) {
  const target = targetFor(platform);
  if (!target) return null;
  return Bot.host.readerChats().find((c) => c.platform === platform && String(c.target).toLowerCase() === target.toLowerCase()) || null;
}

// Whether a YouTube or TikTok message from the reader belongs to the multistream.
Relay.isOurs = (entry) => {
  if (String(entry.sourceId || '').startsWith('ms-')) return true;
  const chat = Bot.host.readerChats().find((c) => c.id === entry.sourceId);
  const target = targetFor(entry.platform);
  return !!chat && !!target && String(chat.target).toLowerCase() === target.toLowerCase();
};

Relay.videoId = () => {
  const reader = readerChatFor('youtube');
  return (reader && reader.videoId) || (Relay.own.youtube && Relay.own.youtube.videoId) || '';
};

// Opens or closes the relay's own YouTube and TikTok connections.
Relay.sync = () => {
  const on = cfg().enabled;
  for (const platform of ['youtube', 'tiktok']) {
    const target = on ? targetFor(platform) : '';
    const needOwn = !!target && !readerChatFor(platform);
    const own = Relay.own[platform];
    if (own && (!needOwn || own.target !== target)) {
      window.chatReaderDesktop.disconnectSource(own.id);
      delete Relay.own[platform];
    }
    if (needOwn && !Relay.own[platform]) {
      Relay.own[platform] = { id: `ms-${platform}`, target, state: 'connecting', text: 'Connecting…', videoId: '' };
      window.chatReaderDesktop.connectSource(`ms-${platform}`, platform, target);
    }
  }
  Bot.emit('relay');
};

function onSourceEvent(event) {
  const platform = Object.keys(Relay.own).find((p) => Relay.own[p].id === (event && event.id));
  if (!platform) return;
  const own = Relay.own[platform];
  if (event.type === 'status') {
    own.state = event.state;
    own.text = event.text;
    own.videoId = event.state === 'connected' ? event.videoId || '' : '';
    Bot.emit('relay');
    return;
  }
  if (event.type !== 'message') return;
  const m = event.message;
  const prefix = LOGIN_PREFIX[platform];
  Bot.chat.fromRemote({
    id: `${prefix}${m.id || `${Date.now()}-${Math.random()}`}`,
    platform,
    sourceId: own.id,
    kind: m.kind === 'event' ? 'event' : 'chat',
    login: m.login ? `${prefix}${String(m.login).toLowerCase()}` : '',
    userId: m.userId ? `${prefix}${m.userId}` : '',
    displayName: String(m.displayName || m.login || 'someone'),
    rawText: String(m.text || ''),
    systemText: String(m.systemText || ''),
    role: Number(m.role) || 0,
    paid: m.paid || null,
  });
}

// ---------------------------------------------------------------------------
// Recognising what the relay posted when it comes back in
// ---------------------------------------------------------------------------

Relay.isEcho = (platform, text) => {
  const n = norm(text);
  if (!n) return false;
  const now = Date.now();
  return Relay.sent.some((s) => s.platform === platform && now - s.at < ECHO_MS && (s.norm === n || (n.length > 20 && s.norm.startsWith(n))));
};

// A YouTube account that isn't the streamer's own is a bot: nothing from it is relayed.
Relay.isRelayAccount = (msg) => {
  const acc = Relay.youtube.account;
  if (msg.platform !== 'youtube' || !acc) return false;
  const mine = norm(cfg().youtube).replace(/^.*@/, '@');
  return msg.user.id === acc.id && acc.customUrl && norm(acc.customUrl) !== mine;
};

// ---------------------------------------------------------------------------
// Relaying
// ---------------------------------------------------------------------------

const canSend = (platform) => {
  const c = cfg();
  if (platform === 'twitch') return c.sendTwitch && Bot.twitch.loggedIn();
  if (platform === 'youtube') return c.sendYoutube && !!Relay.youtube.account && Date.now() > Relay.youtube.pausedUntil;
  if (platform === 'tiktok') return c.sendTiktok && !!targetFor('tiktok');
  return false;
};
Relay.canSend = canSend;

async function format(msg) {
  const c = cfg();
  const template = c.prefix || '';
  const ctx = { user: msg.user, fields: { platform: c.labels[msg.platform] || PLATFORMS[msg.platform].name, message: msg.text } };
  const head = await Bot.vars.render(template, ctx);
  return /\$message\b/i.test(template) ? head : `${head}${msg.text}`;
}

const ignored = (login) => cfg().ignoreUsers.toLowerCase().split(/[\s,]+/).filter(Boolean).includes(String(login || '').toLowerCase().replace(/^@/, ''));

// A chat message from one of the three chats: post it on the other two.
Relay.onChat = async (msg) => {
  const c = cfg();
  if (!c.enabled || !msg.text.trim()) return;
  if (msg.platform !== 'twitch' && !msg.ours) return;
  if (c.skipCommands && /^\s*!/.test(msg.text)) return;
  if (ignored(msg.user.login) || Relay.isRelayAccount(msg)) return;
  const destinations = RELAY_PLATFORMS.filter((p) => p !== msg.platform && canSend(p));
  if (!destinations.length) return;
  const text = await format(msg);
  for (const p of destinations) Relay.queue(p, text);
};

// Subs, cheers, Super Chats and gifts, as a short line on the other platforms.
const RELAYED_EVENTS = { sub: 'twitch', resub: 'twitch', giftSub: 'twitch', cheer: 'twitch', raid: 'twitch', youtubeSuperChat: 'youtube', youtubeMember: 'youtube', tiktokGift: 'tiktok' };
Relay.onEvent = (type, user, fields, text, simulated) => {
  const c = cfg();
  const from = RELAYED_EVENTS[type];
  if (!c.enabled || !c.relayEvents || !from || simulated || !text) return;
  const line = `[${c.labels[from] || PLATFORMS[from].name}] ${text}${fields.message ? `: ${fields.message}` : ''}`;
  for (const p of RELAY_PLATFORMS) if (p !== from && canSend(p)) Relay.queue(p, line);
};

// The streamer's own message from the Dashboard, in every chat of the
// multistream that can be posted to. Returns where it went.
Relay.broadcast = async (text, { as = Bot.twitch.chatRole() } = {}) => {
  const where = [];
  if (Bot.twitch.loggedIn()) {
    await Bot.twitch.say(text, { as });
    where.push('twitch');
  }
  if (cfg().enabled) {
    for (const p of ['youtube', 'tiktok']) {
      if (!canSend(p)) continue;
      Relay.queue(p, text);
      where.push(p);
    }
  }
  return where;
};

Relay.queue = (platform, text) => {
  const box = Relay.boxes[platform];
  box.push(text);
  // Too far behind: the oldest go, so the relay stays close to live.
  if (box.length > 40) {
    Relay.stats[platform].dropped += box.length - 40;
    box.splice(0, box.length - 40);
  }
  schedule(platform);
  Bot.emit('relay');
};

function gapFor(platform) {
  const c = cfg();
  if (platform === 'youtube') return Math.max(LIMITS.youtube.gap, (Number(c.youtubeBatch) || 0) * 1000);
  if (platform === 'tiktok') return Math.max(LIMITS.tiktok.gap, (Number(c.tiktokBatch) || 0) * 1000);
  return LIMITS[platform].gap;
}

function schedule(platform) {
  if (Relay.timers[platform]) return;
  const wait = Math.max(0, Relay.nextAt[platform] - Date.now());
  Relay.timers[platform] = setTimeout(() => { Relay.timers[platform] = null; flush(platform); }, wait);
}

// Takes as many waiting messages as fit in one post, joined with a dot.
function takeBatch(platform) {
  const box = Relay.boxes[platform];
  const max = LIMITS[platform].max;
  const fit = (t) => (Array.from(t).length > max ? `${Array.from(t).slice(0, max - 1).join('')}…` : t);
  let text = fit(box.shift());
  while (box.length && Array.from(`${text} · ${box[0]}`).length <= max) text = `${text} · ${box.shift()}`;
  return text;
}

async function flush(platform) {
  const box = Relay.boxes[platform];
  if (!box.length) return;
  if (!canSend(platform)) { box.length = 0; Bot.emit('relay'); return; }
  const text = takeBatch(platform);
  Relay.nextAt[platform] = Date.now() + gapFor(platform);
  Relay.sent.push({ platform, norm: norm(text), at: Date.now() });
  if (Relay.sent.length > 200) Relay.sent.splice(0, Relay.sent.length - 200);
  try {
    if (platform === 'twitch') {
      const as = cfg().twitchAs === 'auto' ? Bot.twitch.chatRole() : cfg().twitchAs;
      await Bot.twitch.say(text, { as });
    } else if (platform === 'youtube') {
      await Relay.youtubeSend(text);
    } else {
      const res = await Bot.desktop.tiktokSend(targetFor('tiktok'), text);
      if (res.error) throw new Error(res.error);
    }
    Relay.stats[platform].sent++;
    Relay.stats[platform].error = '';
  } catch (err) {
    Relay.stats[platform].error = err.message;
    Bot.log('error', `Relay to ${PLATFORMS[platform].name}: ${err.message}`);
  }
  Bot.emit('relay');
  if (box.length) schedule(platform);
}

// ---------------------------------------------------------------------------
// The combined chat overlay
// ---------------------------------------------------------------------------

Relay.toOverlay = (msg) => {
  if (!cfg().overlayChat || !Bot.overlayStatus || !Bot.overlayStatus.clients) return;
  if (msg.platform !== 'twitch' && !msg.ours) return;
  Bot.overlay.send({
    type: 'chat', id: msg.id, platform: msg.platform, label: cfg().labels[msg.platform] || PLATFORMS[msg.platform].name,
    user: msg.user.displayName || msg.user.login, color: msg.user.color || '', text: msg.text,
  });
};

// ---------------------------------------------------------------------------
// YouTube: signed in with Google, posting with the YouTube Data API
// ---------------------------------------------------------------------------

async function ytTokens() {
  const raw = await Bot.desktop.getSecret('youtube-token');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function ytAccessToken() {
  const t = await ytTokens();
  if (!t) throw new Error('Sign in to YouTube first (under Multistream)');
  if (t.expiresAt - Date.now() > 60000) return t.accessToken;
  if (!t.refreshToken) throw new Error('The YouTube sign-in ran out; sign in again');
  const secret = await Bot.desktop.getSecret('youtube-client-secret');
  const res = await Bot.desktop.http({
    method: 'POST', url: 'https://oauth2.googleapis.com/token',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg().youtubeClientId, client_secret: secret || '', refresh_token: t.refreshToken, grant_type: 'refresh_token' }).toString(),
  });
  let body = {};
  try { body = JSON.parse(res.text || '{}'); } catch {}
  if (res.error || !res.ok) {
    if (body.error === 'invalid_grant') {
      await Bot.desktop.setSecret('youtube-token', null);
      Relay.youtube.account = null;
      Bot.emit('relay');
      throw new Error('The YouTube sign-in ran out (Google ends them after 7 days while your Google app is in “Testing”); sign in again');
    }
    throw new Error(res.error || body.error_description || `Google said ${res.status}`);
  }
  const next = { ...t, accessToken: body.access_token, expiresAt: Date.now() + (body.expires_in || 3600) * 1000 };
  await Bot.desktop.setSecret('youtube-token', JSON.stringify(next));
  return next.accessToken;
}

function countQuota(units) {
  const q = cfg().quota;
  const day = new Date().toISOString().slice(0, 10);
  if (q.day !== day) { q.day = day; q.units = 0; }
  q.units += units;
  Bot.save();
}

async function ytApi(method, path, { query = {}, body = null, units = YT_UNITS.list } = {}) {
  const url = new URL(`${YT}${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const token = await ytAccessToken();
  countQuota(units);
  const res = await Bot.desktop.http({
    method, url: url.toString(),
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : '',
  });
  if (res.error) throw new Error(res.error);
  let data = {};
  try { data = JSON.parse(res.text || '{}'); } catch {}
  if (!res.ok) {
    const reason = data.error && data.error.errors && data.error.errors[0] && data.error.errors[0].reason;
    const err = new Error((data.error && data.error.message) || `YouTube said ${res.status}`);
    err.reason = reason || '';
    throw err;
  }
  return data;
}

Relay.youtubeLoadAccount = async () => {
  if (!(await ytTokens())) { Relay.youtube.account = null; return null; }
  try {
    const res = await ytApi('GET', '/channels', { query: { part: 'snippet', mine: 'true' } });
    const ch = res.items && res.items[0];
    Relay.youtube.account = ch ? { id: ch.id, title: ch.snippet.title, customUrl: ch.snippet.customUrl || '', avatar: (ch.snippet.thumbnails && ch.snippet.thumbnails.default && ch.snippet.thumbnails.default.url) || '' } : { id: '', title: 'a Google account with no YouTube channel', customUrl: '' };
  } catch (err) {
    Relay.stats.youtube.error = err.message;
  }
  Bot.emit('relay');
  return Relay.youtube.account;
};

Relay.youtubeLogin = async () => {
  const res = await Bot.desktop.youtubeLogin(cfg().youtubeClientId.trim());
  if (res.error) throw new Error(res.error);
  await Bot.desktop.setSecret('youtube-token', JSON.stringify(res.tokens));
  return Relay.youtubeLoadAccount();
};

Relay.youtubeLogout = async () => {
  const t = await ytTokens();
  if (t && t.refreshToken) Bot.desktop.http({ method: 'POST', url: `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t.refreshToken)}`, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  await Bot.desktop.setSecret('youtube-token', null);
  Relay.youtube.account = null;
  Relay.youtube.liveChatId = '';
  Bot.emit('relay');
};

// The live chat to post to: the stream being read, or the account's own live broadcast.
async function liveChatId() {
  const video = Relay.videoId();
  const key = video || 'mine';
  if (Relay.youtube.liveChatId && Relay.youtube.chatFor === key) return Relay.youtube.liveChatId;
  let id = '';
  if (video) {
    const res = await ytApi('GET', '/videos', { query: { part: 'liveStreamingDetails', id: video } });
    id = (res.items && res.items[0] && res.items[0].liveStreamingDetails && res.items[0].liveStreamingDetails.activeLiveChatId) || '';
  } else {
    const res = await ytApi('GET', '/liveBroadcasts', { query: { part: 'snippet', broadcastStatus: 'active', broadcastType: 'all' } });
    id = (res.items && res.items[0] && res.items[0].snippet.liveChatId) || '';
  }
  if (!id) throw new Error('No live YouTube chat to post to yet (is the stream live?)');
  Relay.youtube.liveChatId = id;
  Relay.youtube.chatFor = key;
  return id;
}

Relay.youtubeSend = async (text, retry = true) => {
  const chat = await liveChatId();
  try {
    await ytApi('POST', '/liveChatMessages', {
      query: { part: 'snippet' }, units: YT_UNITS.insert,
      body: { snippet: { liveChatId: chat, type: 'textMessageEvent', textMessageDetails: { messageText: text } } },
    });
  } catch (err) {
    if (err.reason === 'quotaExceeded' || err.reason === 'dailyLimitExceeded') {
      // Google's quota day starts at midnight Pacific time, 08:00 UTC.
      const reset = new Date();
      reset.setUTCHours(8, 0, 0, 0);
      if (reset.getTime() <= Date.now()) reset.setUTCDate(reset.getUTCDate() + 1);
      Relay.youtube.pausedUntil = reset.getTime();
      throw new Error('YouTube’s daily quota is used up, so relaying to YouTube waits until it resets');
    }
    if (retry && /liveChatEnded|liveChatNotFound|liveChatDisabled|forbidden/i.test(err.reason)) {
      Relay.youtube.liveChatId = '';
      return Relay.youtubeSend(text, false);
    }
    throw err;
  }
};

Relay.quotaToday = () => {
  const q = cfg().quota;
  return q.day === new Date().toISOString().slice(0, 10) ? q.units : 0;
};
Relay.YT_DAILY = YT_DAILY;
Relay.YT_UNITS = YT_UNITS;

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

Relay.start = () => {
  window.chatReaderDesktop.onSourceEvent(onSourceEvent);
  Relay.youtubeLoadAccount();
  Relay.sync();
  // The reader's top bar may start or stop reading the same channels.
  setInterval(Relay.sync, 15000);
};

// A test, from the Multistream tab: one made-up message from each platform.
Relay.test = () => {
  const make = (platform, name) => ({ platform, id: `test-${platform}-${Date.now()}`, ours: true, user: { id: name, login: name.toLowerCase(), displayName: name, platform, role: 0 }, text: `testing the relay from ${PLATFORMS[platform].name}` });
  for (const [p, n] of [['twitch', 'Pixel_Panda'], ['youtube', 'LofiListener'], ['tiktok', 'DanceQueen']]) {
    const msg = make(p, n);
    Relay.toOverlay(msg);
    Relay.onChat(msg);
  }
};
