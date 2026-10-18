'use strict';

// Twitch accounts and the Helix API.
//
// Logging in uses the device code flow: the app shows a code, the streamer
// enters it on twitch.tv/activate, and the app gets a token. That needs a
// Client ID from a "Public" application the streamer registers at
// dev.twitch.tv (no redirect page, no secret). Tokens are kept encrypted by
// the main process, and refreshed on their own.

const TWITCH_ID = 'https://id.twitch.tv/oauth2';
const HELIX = 'https://api.twitch.tv/helix';

const STREAMER_SCOPES = [
  'user:read:chat', 'user:write:chat', 'user:bot', 'channel:bot',
  'moderator:read:followers', 'channel:read:subscriptions', 'bits:read',
  'channel:read:redemptions', 'channel:manage:redemptions',
  'channel:read:hype_train', 'channel:manage:polls', 'channel:manage:predictions',
  'channel:read:ads', 'channel:edit:commercial', 'channel:manage:broadcast', 'clips:edit',
  'moderator:read:chatters', 'moderator:manage:chat_messages', 'moderator:manage:banned_users',
  'moderator:manage:announcements', 'moderator:manage:shoutouts', 'moderator:read:shoutouts',
  'channel:manage:raids', 'channel:manage:vips', 'channel:read:charity', 'channel:moderate',
];
const BOT_SCOPES = ['user:read:chat', 'user:write:chat', 'user:bot'];

const Twitch = Bot.twitch = {
  accounts: { streamer: null, bot: null },
  login: null,          // the device-code login in progress: { role, userCode, uri, expiresAt }
  refreshing: {},
  cache: new Map(),     // short-lived answers: users by login, follows, the stream
  sent: [],             // what the bot said lately: [{ at, login, text }]
};

const form = (fields) => new URLSearchParams(fields).toString();
// A request Twitch never answers shouldn't leave the bot waiting forever.
const timeout = () => AbortSignal.timeout(20000);

async function idPost(path, fields) {
  const res = await fetch(`${TWITCH_ID}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form(fields),
    signal: timeout(),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

async function validate(token) {
  const res = await fetch(`${TWITCH_ID}/validate`, { headers: { Authorization: `OAuth ${token}` }, signal: timeout() });
  if (!res.ok) return null;
  return res.json();
}

async function saveAccount(role) {
  const account = Twitch.accounts[role];
  await Bot.desktop.setSecret(`twitch-${role}`, account ? JSON.stringify(account) : null);
  Bot.emit('accounts');
}

Twitch.streamerId = () => (Twitch.accounts.streamer ? Twitch.accounts.streamer.id : '');
Twitch.streamerLogin = () => (Twitch.accounts.streamer ? Twitch.accounts.streamer.login : '');
Twitch.loggedIn = () => !!Twitch.accounts.streamer;
// Who chat replies are sent as: the bot account when there is one.
Twitch.chatRole = () => (Bot.data.replyAs === 'bot' && Twitch.accounts.bot ? 'bot' : 'streamer');

// ---------------------------------------------------------------------------
// Logging in
// ---------------------------------------------------------------------------

Twitch.init = async () => {
  for (const role of ['streamer', 'bot']) {
    const raw = await Bot.desktop.getSecret(`twitch-${role}`);
    if (!raw) continue;
    try {
      Twitch.accounts[role] = JSON.parse(raw);
    } catch {
      continue;
    }
    // Checks the token still works, refreshing it if it ran out while the app was closed.
    try {
      await Twitch.token(role);
    } catch (err) {
      Bot.log('error', `The ${role} account needs to log in again: ${err.message}`);
    }
  }
  Bot.emit('accounts');
};

// Starts a device-code login. Resolves once the streamer has entered the
// code (or it ran out); `Twitch.login` holds the code meanwhile.
Twitch.startLogin = async (role) => {
  const clientId = Bot.data.clientId.trim();
  if (!clientId) throw new Error('Enter your Client ID first');
  const scopes = (role === 'bot' ? BOT_SCOPES : STREAMER_SCOPES).join(' ');
  const start = await idPost('device', { client_id: clientId, scopes });
  if (!start.ok) {
    const why = String(start.body.message || '');
    throw new Error(/invalid client/i.test(why)
      ? 'Twitch doesn’t know that Client ID. Copy it again from your application on dev.twitch.tv, and check its Client Type is “Public”.'
      : why || `Twitch said ${start.status}. Is the Client ID right, and is the application’s Client Type “Public”?`);
  }
  const { device_code: deviceCode, user_code: userCode, verification_uri: uri, interval = 5, expires_in: expiresIn = 1800 } = start.body;
  const login = { role, userCode, uri, expiresAt: Date.now() + expiresIn * 1000, cancelled: false };
  if (Twitch.login) Twitch.login.cancelled = true;
  Twitch.login = login;
  Bot.emit('accounts');

  let wait = interval * 1000;
  while (!login.cancelled && Date.now() < login.expiresAt) {
    await Bot.wait(wait);
    if (login.cancelled) break;
    const res = await idPost('token', {
      client_id: clientId,
      scopes,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    if (res.ok) {
      const info = await validate(res.body.access_token);
      if (!info) throw new Error('Twitch gave a token that doesn’t work');
      const users = await fetch(`${HELIX}/users?id=${info.user_id}`, {
        headers: { Authorization: `Bearer ${res.body.access_token}`, 'Client-Id': clientId },
      }).then((r) => r.json()).catch(() => ({}));
      const user = (users.data && users.data[0]) || {};
      Twitch.accounts[role] = {
        id: info.user_id,
        login: info.login,
        displayName: user.display_name || info.login,
        avatar: user.profile_image_url || '',
        token: res.body.access_token,
        refresh: res.body.refresh_token,
        expiresAt: Date.now() + (res.body.expires_in || info.expires_in || 3600) * 1000,
        scopes: info.scopes || [],
        clientId,
      };
      Twitch.login = null;
      await saveAccount(role);
      Bot.log('info', `Logged in as ${Twitch.accounts[role].displayName} (${role})`);
      Bot.emit('login', role);
      return Twitch.accounts[role];
    }
    const message = String(res.body.message || '');
    if (message === 'authorization_pending') continue;
    if (message === 'slow_down') { wait += 5000; continue; }
    Twitch.login = null;
    Bot.emit('accounts');
    throw new Error(message === 'invalid device code' ? 'The code ran out. Try again.' : message || 'Logging in failed');
  }
  if (Twitch.login === login) Twitch.login = null;
  Bot.emit('accounts');
  return null;
};

Twitch.cancelLogin = () => {
  if (Twitch.login) Twitch.login.cancelled = true;
  Twitch.login = null;
  Bot.emit('accounts');
};

Twitch.logout = async (role) => {
  const account = Twitch.accounts[role];
  if (account) {
    // Revoking is a courtesy; the token is forgotten either way.
    idPost('revoke', { client_id: account.clientId, token: account.token }).catch(() => {});
  }
  Twitch.accounts[role] = null;
  await saveAccount(role);
  Bot.emit('logout', role);
};

// A working token, refreshed first when it's about to run out.
Twitch.token = async (role = 'streamer', { force = false } = {}) => {
  const account = Twitch.accounts[role];
  if (!account) throw new Error(role === 'bot' ? 'No bot account' : 'Log in to Twitch first');
  if (!force && account.expiresAt - Date.now() > 5 * 60 * 1000) return account.token;
  if (!Twitch.refreshing[role]) {
    Twitch.refreshing[role] = (async () => {
      const res = await idPost('token', { client_id: account.clientId, grant_type: 'refresh_token', refresh_token: account.refresh });
      if (!res.ok) {
        // A refresh token that doesn't work any more means logging in again.
        if (res.status === 400 || res.status === 401) {
          Twitch.accounts[role] = null;
          await saveAccount(role);
          Bot.emit('logout', role);
        }
        throw new Error(res.body.message || 'couldn’t refresh the login');
      }
      account.token = res.body.access_token;
      account.refresh = res.body.refresh_token || account.refresh;
      account.expiresAt = Date.now() + (res.body.expires_in || 3600) * 1000;
      await saveAccount(role);
      return account.token;
    })().finally(() => { delete Twitch.refreshing[role]; });
  }
  return Twitch.refreshing[role];
};

// ---------------------------------------------------------------------------
// Helix
// ---------------------------------------------------------------------------

class HelixError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

Twitch.api = async (method, path, { query = null, body = null, as = 'streamer', retry = true } = {}) => {
  const account = Twitch.accounts[as];
  if (!account) throw new HelixError(0, as === 'bot' ? 'No bot account is logged in' : 'Log in to Twitch first');
  const url = new URL(`${HELIX}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, item);
    }
  }
  const token = await Twitch.token(as);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Client-Id': account.clientId,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: timeout(),
  });
  if (res.status === 401 && retry) {
    await Twitch.token(as, { force: true });
    return Twitch.api(method, path, { query, body, as, retry: false });
  }
  if (res.status === 429 && retry) {
    const reset = Number(res.headers.get('Ratelimit-Reset')) * 1000;
    await Bot.wait(Math.min(10000, Math.max(500, reset - Date.now())));
    return Twitch.api(method, path, { query, body, as, retry: false });
  }
  if (res.status === 204) return {};
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HelixError(res.status, data.message || `Twitch said ${res.status}`);
  return data;
};

// Every page of a paginated list, up to `max` items.
Twitch.all = async (path, query = {}, { as = 'streamer', max = 5000, pageSize = 100 } = {}) => {
  const items = [];
  let after = '';
  do {
    const page = await Twitch.api('GET', path, { query: { ...query, first: pageSize, after }, as });
    items.push(...(page.data || []));
    after = page.pagination && page.pagination.cursor;
  } while (after && items.length < max);
  return items;
};

async function cached(key, ttl, fn) {
  const hit = Twitch.cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = await fn();
  Twitch.cache.set(key, { at: Date.now(), value });
  return value;
}

Twitch.forget = (prefix) => {
  for (const key of Twitch.cache.keys()) if (key.startsWith(prefix)) Twitch.cache.delete(key);
};

const B = () => ({ broadcaster_id: Twitch.streamerId() });
const M = () => ({ broadcaster_id: Twitch.streamerId(), moderator_id: Twitch.streamerId() });

Twitch.user = (login) => {
  const name = String(login || '').trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_]{1,25}$/.test(name)) return Promise.resolve(null);
  return cached(`user:${name}`, 10 * 60 * 1000, async () => {
    const res = await Twitch.api('GET', '/users', { query: { login: name } });
    return (res.data && res.data[0]) || null;
  });
};

Twitch.userById = (id) => cached(`userid:${id}`, 10 * 60 * 1000, async () => {
  const res = await Twitch.api('GET', '/users', { query: { id } });
  return (res.data && res.data[0]) || null;
});

Twitch.channel = () => cached('channel', 30 * 1000, async () => {
  const res = await Twitch.api('GET', '/channels', { query: B() });
  return (res.data && res.data[0]) || null;
});

Twitch.stream = () => cached('stream', 30 * 1000, async () => {
  const res = await Twitch.api('GET', '/streams', { query: { user_id: Twitch.streamerId() } });
  return (res.data && res.data[0]) || null;
});

Twitch.followerCount = () => cached('followers', 60 * 1000, async () => {
  const res = await Twitch.api('GET', '/channels/followers', { query: { ...B(), first: 1 } });
  return res.total || 0;
});

Twitch.follow = (userId) => cached(`follow:${userId}`, 5 * 60 * 1000, async () => {
  const res = await Twitch.api('GET', '/channels/followers', { query: { ...B(), user_id: userId } });
  return (res.data && res.data[0]) || null;
});

Twitch.updateChannel = async (fields) => {
  await Twitch.api('PATCH', '/channels', { query: B(), body: fields });
  Twitch.forget('channel');
};

Twitch.findCategory = async (name) => {
  const res = await Twitch.api('GET', '/search/categories', { query: { query: name, first: 10 } });
  const list = res.data || [];
  const q = name.trim().toLowerCase();
  return list.find((c) => c.name.toLowerCase() === q) || list[0] || null;
};

Twitch.searchCategories = async (name) => {
  if (!name.trim()) return [];
  const res = await Twitch.api('GET', '/search/categories', { query: { query: name, first: 10 } });
  return res.data || [];
};

// Chat goes out from the bot account when there is one, or as the streamer.
Twitch.say = async (text, { replyTo = '', as = Twitch.chatRole() } = {}) => {
  const message = String(text || '').replace(/\s+/g, ' ').trim();
  if (!message) return null;
  const sender = Twitch.accounts[as] || Twitch.accounts.streamer;
  const chunks = [];
  // Twitch's limit is 500 characters; longer replies go out in parts.
  for (let rest = message; rest; ) {
    if (rest.length <= 500) { chunks.push(rest); break; }
    const cut = rest.lastIndexOf(' ', 500);
    const at = cut > 300 ? cut : 500;
    chunks.push(rest.slice(0, at));
    rest = rest.slice(at).trim();
  }
  let last = null;
  // So the reader can leave out what the bot said, even when it says it as you.
  Twitch.sent.push({ at: Date.now(), login: sender.login, text: message.toLowerCase() });
  if (Twitch.sent.length > 30) Twitch.sent.shift();
  for (const [i, chunk] of chunks.entries()) {
    const res = await Twitch.api('POST', '/chat/messages', {
      as: Twitch.accounts[as] ? as : 'streamer',
      body: { broadcaster_id: Twitch.streamerId(), sender_id: sender.id, message: chunk, ...(replyTo && i === 0 ? { reply_parent_message_id: replyTo } : {}) },
    });
    last = res.data && res.data[0];
    if (last && last.is_sent === false) throw new Error(`Twitch didn’t send it: ${(last.drop_reason && last.drop_reason.message) || 'dropped'}`);
  }
  return last;
};

Twitch.announce = (message, color = 'primary') => Twitch.api('POST', '/chat/announcements', {
  query: M(), body: { message: String(message).slice(0, 500), color },
});

Twitch.ban = (userId, { seconds = 0, reason = '' } = {}) => Twitch.api('POST', '/moderation/bans', {
  query: M(), body: { data: { user_id: userId, ...(seconds ? { duration: Math.min(1209600, Math.max(1, Math.round(seconds))) } : {}), reason: String(reason).slice(0, 500) } },
});

Twitch.unban = (userId) => Twitch.api('DELETE', '/moderation/bans', { query: { ...M(), user_id: userId } });
Twitch.deleteMessage = (messageId) => Twitch.api('DELETE', '/moderation/chat', { query: { ...M(), message_id: messageId } });
Twitch.clearChat = () => Twitch.api('DELETE', '/moderation/chat', { query: M() });
Twitch.shoutout = (userId) => Twitch.api('POST', '/chat/shoutouts', { query: { from_broadcaster_id: Twitch.streamerId(), to_broadcaster_id: userId, moderator_id: Twitch.streamerId() } });
Twitch.addVip = (userId) => Twitch.api('POST', '/channels/vips', { query: { ...B(), user_id: userId } });
Twitch.removeVip = (userId) => Twitch.api('DELETE', '/channels/vips', { query: { ...B(), user_id: userId } });
Twitch.commercial = (length) => Twitch.api('POST', '/channels/commercial', { body: { broadcaster_id: Twitch.streamerId(), length: Math.min(180, Math.max(30, Math.round(length / 30) * 30)) } });
Twitch.marker = (description = '') => Twitch.api('POST', '/streams/markers', { body: { user_id: Twitch.streamerId(), description: String(description).slice(0, 140) } });
Twitch.clip = (hasDelay = false) => Twitch.api('POST', '/clips', { query: { ...B(), has_delay: hasDelay } });
Twitch.raid = (userId) => Twitch.api('POST', '/raids', { query: { from_broadcaster_id: Twitch.streamerId(), to_broadcaster_id: userId } });
Twitch.cancelRaid = () => Twitch.api('DELETE', '/raids', { query: B() });

Twitch.createPoll = (title, choices, seconds) => Twitch.api('POST', '/polls', {
  body: { broadcaster_id: Twitch.streamerId(), title: String(title).slice(0, 60), choices: choices.slice(0, 5).map((c) => ({ title: String(c).slice(0, 25) })), duration: Math.min(1800, Math.max(15, Math.round(seconds))) },
});

Twitch.endPoll = async (status = 'TERMINATED') => {
  const res = await Twitch.api('GET', '/polls', { query: { ...B(), first: 1 } });
  const poll = res.data && res.data[0];
  if (!poll || poll.status !== 'ACTIVE') return null;
  return Twitch.api('PATCH', '/polls', { body: { broadcaster_id: Twitch.streamerId(), id: poll.id, status } });
};

Twitch.createPrediction = (title, outcomes, seconds) => Twitch.api('POST', '/predictions', {
  body: { broadcaster_id: Twitch.streamerId(), title: String(title).slice(0, 45), outcomes: outcomes.slice(0, 10).map((c) => ({ title: String(c).slice(0, 25) })), prediction_window: Math.min(1800, Math.max(30, Math.round(seconds))) },
});

Twitch.currentPrediction = async () => {
  const res = await Twitch.api('GET', '/predictions', { query: { ...B(), first: 1 } });
  const p = res.data && res.data[0];
  return p && (p.status === 'ACTIVE' || p.status === 'LOCKED') ? p : null;
};

Twitch.endPrediction = async (status, winningTitle = '') => {
  const p = await Twitch.currentPrediction();
  if (!p) return null;
  const body = { broadcaster_id: Twitch.streamerId(), id: p.id, status };
  if (status === 'RESOLVED') {
    const q = winningTitle.trim().toLowerCase();
    const outcome = p.outcomes.find((o) => o.title.toLowerCase() === q) || p.outcomes.find((o) => o.title.toLowerCase().includes(q)) || (/^\d+$/.test(q) ? p.outcomes[Number(q) - 1] : null);
    if (!outcome) throw new Error(`No outcome called “${winningTitle}”`);
    body.winning_outcome_id = outcome.id;
  }
  return Twitch.api('PATCH', '/predictions', { body });
};

// Channel point rewards. Only the ones made by this Client ID can be changed.
Twitch.rewards = async () => {
  const [all, mine] = await Promise.all([
    Twitch.api('GET', '/channel_points/custom_rewards', { query: B() }),
    Twitch.api('GET', '/channel_points/custom_rewards', { query: { ...B(), only_manageable_rewards: true } }).catch(() => ({ data: [] })),
  ]);
  const manageable = new Set((mine.data || []).map((r) => r.id));
  return (all.data || []).map((r) => ({ ...r, manageable: manageable.has(r.id) }));
};

Twitch.createReward = (fields) => Twitch.api('POST', '/channel_points/custom_rewards', { query: B(), body: fields });
Twitch.updateReward = (id, fields) => Twitch.api('PATCH', '/channel_points/custom_rewards', { query: { ...B(), id }, body: fields });
Twitch.deleteReward = (id) => Twitch.api('DELETE', '/channel_points/custom_rewards', { query: { ...B(), id } });
Twitch.updateRedemption = (rewardId, redemptionId, status) => Twitch.api('PATCH', '/channel_points/custom_rewards/redemptions', {
  query: { ...B(), reward_id: rewardId, id: redemptionId }, body: { status },
});

Twitch.chatters = () => Twitch.all('/chat/chatters', M(), { max: 50000, pageSize: 1000 });

Twitch.HelixError = HelixError;
Twitch.STREAMER_SCOPES = STREAMER_SCOPES;
Twitch.BOT_SCOPES = BOT_SCOPES;
