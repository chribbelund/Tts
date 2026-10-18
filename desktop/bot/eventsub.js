'use strict';

// Twitch EventSub over a WebSocket: follows, subs, raids, redemptions and the
// rest arrive here, as does the channel's chat (so the bot hears its channel
// whether or not the reader is reading it). Each notification is turned into
// one of the bot's own event types; see EVENT_TYPES in triggers.js.

const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws';

const userOf = (e, prefix = 'user') => (e[`${prefix}_id`]
  ? { id: e[`${prefix}_id`], login: e[`${prefix}_login`] || '', displayName: e[`${prefix}_name`] || e[`${prefix}_login`] || '', platform: 'twitch' }
  : null);

const tierName = (tier) => ({ 1000: 'Tier 1', 2000: 'Tier 2', 3000: 'Tier 3', Prime: 'Prime' }[tier] || String(tier || ''));

// Subscription type -> what to ask for, and how to turn it into a bot event.
const SUBSCRIPTIONS = [
  { type: 'channel.chat.message', version: '1', condition: (id) => ({ broadcaster_user_id: id, user_id: id }), chat: true },
  {
    type: 'channel.follow', version: '2', condition: (id) => ({ broadcaster_user_id: id, moderator_user_id: id }),
    map: (e) => ['follow', userOf(e), {}],
  },
  {
    type: 'channel.subscribe', version: '1',
    map: (e) => [e.is_gift ? 'giftReceived' : 'sub', userOf(e), { tier: tierName(e.tier), isGift: !!e.is_gift }],
  },
  {
    type: 'channel.subscription.message', version: '1',
    map: (e) => ['resub', userOf(e), { tier: tierName(e.tier), months: e.cumulative_months || 0, streak: e.streak_months || 0, duration: e.duration_months || 1, message: (e.message && e.message.text) || '' }],
  },
  {
    type: 'channel.subscription.gift', version: '1',
    map: (e) => ['giftSub', e.is_anonymous ? { id: '', login: 'anonymous', displayName: 'Anonymous', platform: 'twitch' } : userOf(e),
      { tier: tierName(e.tier), giftCount: e.total || 1, totalGifted: e.cumulative_total || 0, anonymous: !!e.is_anonymous }],
  },
  {
    type: 'channel.cheer', version: '1',
    map: (e) => ['cheer', e.is_anonymous ? { id: '', login: 'anonymous', displayName: 'Anonymous', platform: 'twitch' } : userOf(e),
      { bits: e.bits || 0, message: e.message || '', anonymous: !!e.is_anonymous }],
  },
  {
    type: 'channel.raid', version: '1', condition: (id) => ({ to_broadcaster_user_id: id }),
    map: (e) => ['raid', userOf(e, 'from_broadcaster_user'), { viewers: e.viewers || 0 }],
  },
  {
    type: 'channel.channel_points_custom_reward_redemption.add', version: '1',
    map: (e) => ['redemption', userOf(e), {
      rewardId: e.reward.id, rewardName: e.reward.title, rewardCost: e.reward.cost, message: e.user_input || '', redemptionId: e.id, status: e.status,
    }],
  },
  {
    type: 'channel.hype_train.begin', version: '2',
    map: (e) => ['hypeTrainStart', null, { level: e.level || 1, total: e.total || 0, goal: e.goal || 0 }],
  },
  {
    type: 'channel.hype_train.end', version: '2',
    map: (e) => ['hypeTrainEnd', null, { level: e.level || 1, total: e.total || 0 }],
  },
  {
    type: 'channel.poll.begin', version: '1',
    map: (e) => ['pollStart', null, { title: e.title, choices: (e.choices || []).map((c) => c.title).join(', ') }],
  },
  {
    type: 'channel.poll.end', version: '1',
    map: (e) => {
      const choices = e.choices || [];
      const top = choices.reduce((best, c) => ((c.votes || 0) > ((best && best.votes) || 0) ? c : best), null);
      return ['pollEnd', null, { title: e.title, winner: top ? top.title : '', votes: top ? top.votes || 0 : 0, status: e.status }];
    },
  },
  {
    type: 'channel.prediction.begin', version: '1',
    map: (e) => ['predictionStart', null, { title: e.title, outcomes: (e.outcomes || []).map((o) => o.title).join(', ') }],
  },
  {
    type: 'channel.prediction.end', version: '1',
    map: (e) => {
      const won = (e.outcomes || []).find((o) => o.id === e.winning_outcome_id);
      return ['predictionEnd', null, { title: e.title, winner: won ? won.title : '', status: e.status }];
    },
  },
  {
    type: 'channel.ad_break.begin', version: '1', condition: (id) => ({ broadcaster_id: id }),
    map: (e) => ['adBreak', null, { seconds: e.duration_seconds || 0, automatic: !!e.is_automatic }],
  },
  {
    type: 'channel.shoutout.receive', version: '1', condition: (id) => ({ broadcaster_user_id: id, moderator_user_id: id }),
    map: (e) => ['shoutoutReceived', userOf(e, 'from_broadcaster_user'), { viewers: e.viewer_count || 0 }],
  },
  {
    type: 'channel.ban', version: '1',
    map: (e) => ['ban', userOf(e), { reason: e.reason || '', permanent: !!e.is_permanent, moderator: e.moderator_user_name || '' }],
  },
  {
    type: 'channel.unban', version: '1',
    map: (e) => ['unban', userOf(e), { moderator: e.moderator_user_name || '' }],
  },
  { type: 'stream.online', version: '1', map: () => ['streamOnline', null, {}] },
  { type: 'stream.offline', version: '1', map: () => ['streamOffline', null, {}] },
  {
    type: 'channel.update', version: '2',
    map: (e) => ['channelUpdate', null, { title: e.title || '', game: e.category_name || '' }],
  },
  {
    type: 'channel.charity_campaign.donate', version: '1',
    map: (e) => {
      const a = e.amount || {};
      const amount = a.value !== undefined ? a.value / 10 ** (a.decimal_places || 0) : 0;
      return ['charityDonation', userOf(e), { amount, currency: a.currency || '', charity: e.charity_name || '' }];
    },
  },
];

const EventSub = Bot.eventsub = {
  ws: null,
  sessionId: '',
  state: 'idle',       // idle | connecting | connected | error
  text: '',
  failed: {},          // subscription type -> why it couldn't be made
  seen: new Set(),
  keepaliveMs: 15000,
  watchdog: null,
  retries: 0,
  retryTimer: null,
};

function setEventSubState(state, text = '') {
  EventSub.state = state;
  EventSub.text = text;
  Bot.emit('eventsub', { state, text });
}

EventSub.start = () => {
  EventSub.stop();
  if (!Bot.twitch.loggedIn()) return;
  EventSub.open(EVENTSUB_URL, true);
};

EventSub.stop = () => {
  clearTimeout(EventSub.retryTimer);
  clearTimeout(EventSub.watchdog);
  if (EventSub.ws) {
    const ws = EventSub.ws;
    EventSub.ws = null;
    ws.close();
  }
  EventSub.sessionId = '';
  setEventSubState('idle', '');
};

// `fresh`: a new session that needs its subscriptions made. A reconnect URL
// that Twitch hands over carries them across instead.
EventSub.open = (url, fresh) => {
  setEventSubState('connecting', 'Connecting to Twitch events…');
  const ws = new WebSocket(url);
  const previous = EventSub.ws;
  EventSub.ws = ws;
  // The old socket keeps delivering until the new one is welcomed.
  EventSub.draining = fresh ? null : previous;

  ws.onmessage = (msg) => {
    if (EventSub.ws !== ws && EventSub.draining !== ws) return;
    let data;
    try { data = JSON.parse(msg.data); } catch { return; }
    if (EventSub.ws === ws) resetWatchdog();
    const type = data.metadata && data.metadata.message_type;
    if (type === 'session_welcome') {
      const session = data.payload.session;
      EventSub.sessionId = session.id;
      EventSub.keepaliveMs = (session.keepalive_timeout_seconds || 10) * 1000;
      EventSub.retries = 0;
      if (previous && previous !== ws) previous.close();
      EventSub.draining = null;
      if (fresh) {
        subscribeAll(ws).catch((err) => {
          if (EventSub.ws === ws) setEventSubState('error', `Couldn’t subscribe to Twitch events: ${err.message}`);
        });
      }
      else setEventSubState('connected', 'Receiving Twitch events');
      resetWatchdog();
    } else if (type === 'session_reconnect') {
      EventSub.open(data.payload.session.reconnect_url, false);
    } else if (type === 'notification') {
      const id = data.metadata.message_id;
      if (EventSub.seen.has(id)) return;
      EventSub.seen.add(id);
      if (EventSub.seen.size > 2000) EventSub.seen = new Set([...EventSub.seen].slice(-1000));
      handleNotification(data.metadata.subscription_type, data.payload.event);
    } else if (type === 'revocation') {
      const subType = data.payload.subscription.type;
      EventSub.failed[subType] = `stopped by Twitch: ${data.payload.subscription.status}`;
      Bot.log('error', `Twitch stopped sending ${subType} (${data.payload.subscription.status})`);
      Bot.emit('eventsub', { state: EventSub.state, text: EventSub.text });
    }
  };

  ws.onclose = (event) => {
    if (EventSub.ws !== ws) return;
    EventSub.ws = null;
    clearTimeout(EventSub.watchdog);
    if (!Bot.twitch.loggedIn()) { setEventSubState('idle', ''); return; }
    const delay = Math.min(60000, 1000 * 2 ** EventSub.retries++);
    setEventSubState('error', `Twitch events dropped${event.code >= 4000 ? ` (${event.code})` : ''}, retrying in ${Math.round(delay / 1000)} s…`);
    EventSub.retryTimer = setTimeout(() => EventSub.open(EVENTSUB_URL, true), delay);
  };
};

// Twitch sends something at least every keepalive interval; silence for
// longer means the socket died without closing.
function resetWatchdog() {
  clearTimeout(EventSub.watchdog);
  EventSub.watchdog = setTimeout(() => { if (EventSub.ws) EventSub.ws.close(); }, EventSub.keepaliveMs + 5000);
}

async function subscribeAll(ws) {
  const id = Bot.twitch.streamerId();
  EventSub.failed = {};
  let ok = 0;
  await Promise.all(SUBSCRIPTIONS.map(async (sub) => {
    const body = {
      type: sub.type,
      version: sub.version,
      condition: sub.condition ? sub.condition(id) : { broadcaster_user_id: id },
      transport: { method: 'websocket', session_id: EventSub.sessionId },
    };
    try {
      await Bot.twitch.api('POST', '/eventsub/subscriptions', { body });
      ok++;
    } catch (err) {
      // Hype train v2 is newer than some accounts' access; v1 still works there.
      if (sub.version === '2' && sub.type.startsWith('channel.hype_train')) {
        try { await Bot.twitch.api('POST', '/eventsub/subscriptions', { body: { ...body, version: '1' } }); ok++; return; } catch {}
      }
      EventSub.failed[sub.type] = err.message;
    }
  }));
  // A newer socket took over meanwhile (a reconnect, logging in again): it says how things are.
  if (EventSub.ws !== ws) return;
  const failed = Object.keys(EventSub.failed);
  if (failed.length) Bot.log('error', `Couldn’t listen for ${failed.join(', ')}: ${Object.values(EventSub.failed)[0]}`);
  setEventSubState(ok ? 'connected' : 'error', ok ? `Receiving Twitch events${failed.length ? ` (${failed.length} unavailable)` : ''}` : 'Couldn’t subscribe to any Twitch events');
}

function handleNotification(subType, event) {
  const sub = SUBSCRIPTIONS.find((s) => s.type === subType);
  if (!sub) return;
  if (sub.chat) {
    Bot.chat.fromEventSub(event);
    return;
  }
  const [type, user, fields] = sub.map(event);
  Bot.events.fire(type, { user, fields, raw: event });
}

EventSub.SUBSCRIPTIONS = SUBSCRIPTIONS;
EventSub.tierName = tierName;
