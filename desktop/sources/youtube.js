'use strict';

// YouTube live chat, read the way youtube.com's own chat pop-out reads it:
// the page hands out an innertube key and a continuation token, and
// get_live_chat is polled with that token for new messages. No API key, no
// sign-in and no quota, but it only works outside a browser, because YouTube
// sends no CORS headers. That's why this lives in the desktop app.

const { EventEmitter } = require('node:events');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  // Without these, visitors from the EU get the cookie consent page instead.
  Cookie: 'SOCS=CAI; CONSENT=YES+1',
};

const POLL_MS = 2000;            // between get_live_chat requests
const OFFLINE_RETRY_MS = 30000;  // while waiting for a channel to go live
const REQUEST_TIMEOUT_MS = 15000;

const HANDLE_RE = /^@[\p{L}\p{N}_.\-·]{3,30}$/u;
const VIDEO_RE = /^[\w-]{11}$/;
const CHANNEL_RE = /^UC[\w-]{22}$/;

// The page sends one of '@handle', 'video:ID' or 'channel:UC…' (see
// js/sources.js); anything else is refused rather than put into a URL.
function parseTarget(target) {
  const s = String(target || '');
  if (HANDLE_RE.test(s)) return { kind: 'handle', path: `${encodeURIComponent(s)}/live`, label: s };
  if (s.startsWith('video:') && VIDEO_RE.test(s.slice(6))) return { kind: 'video', id: s.slice(6), label: 'the stream' };
  if (s.startsWith('channel:') && CHANNEL_RE.test(s.slice(8))) return { kind: 'channel', path: `channel/${s.slice(8)}/live`, label: 'the channel' };
  return null;
}

class Fatal extends Error {}

const sleep = (ms, signal) => new Promise((resolve) => {
  if (signal.aborted) return resolve();
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

async function request(url, signal, init = {}) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const res = await fetch(url, { ...init, headers: { ...HEADERS, ...(init.headers || {}) }, signal: AbortSignal.any([signal, timeout]) });
  if (!res.ok) throw new Error(`YouTube answered ${res.status}`);
  return res;
}

const runsText = (t) => (t ? t.simpleText || (t.runs || []).map((r) => r.text || '').join('') : '');

// A message's text, plus where the channel's own emotes sit in it, written
// the way Twitch writes emote positions ("yt:0-4,10-15", in code points) so
// the page can drop them with the same code.
function messageParts(message) {
  let text = '';
  let length = 0;
  const ranges = [];
  for (const run of (message && message.runs) || []) {
    let piece = '';
    if (run.text !== undefined) {
      piece = run.text;
    } else if (run.emoji) {
      if (run.emoji.isCustomEmoji) {
        const name = ((run.emoji.shortcuts || [])[0] || ':emote:').replace(/^:|:$/g, '');
        // Glued to the words around it, a name would be read as part of them.
        const before = text && !/\s$/.test(text) ? ' ' : '';
        piece = `${before}${name} `;
        const start = length + before.length;
        ranges.push(`${start}-${start + Array.from(name).length - 1}`);
      } else {
        piece = run.emoji.emojiId || '';
      }
    }
    text += piece;
    length += Array.from(piece).length;
  }
  return { text, emotes: ranges.length ? `yt:${ranges.join(',')}` : '' };
}

function roleOf(badges) {
  let role = 0;
  for (const badge of badges || []) {
    const r = badge.liveChatAuthorBadgeRenderer || {};
    const icon = r.icon && r.icon.iconType;
    if (icon === 'OWNER') role = Math.max(role, 4);
    else if (icon === 'MODERATOR') role = Math.max(role, 3);
    else if (r.customThumbnail) role = Math.max(role, 1);   // channel member
  }
  return role;
}

// YouTube shows "@handle" as the author for nearly everyone now; the channel
// id is the fallback for the few accounts without one.
function author(renderer) {
  const name = runsText(renderer.authorName).trim();
  const channelId = renderer.authorExternalChannelId || '';
  const handle = name.startsWith('@') ? name.slice(1) : '';
  return {
    userId: channelId,
    login: (handle || channelId).toLowerCase(),
    displayName: handle || name || 'someone',
    role: roleOf(renderer.authorBadges),
  };
}

function toEvents(action) {
  if (action.addChatItemAction) {
    const item = action.addChatItemAction.item || {};
    if (item.liveChatTextMessageRenderer) {
      const r = item.liveChatTextMessageRenderer;
      return [{ type: 'message', kind: 'chat', id: r.id, ...author(r), ...messageParts(r.message) }];
    }
    if (item.liveChatPaidMessageRenderer) {
      const r = item.liveChatPaidMessageRenderer;
      const amount = runsText(r.purchaseAmountText);
      return [{ type: 'message', kind: 'chat', id: r.id, ...author(r), ...messageParts(r.message), paid: { label: `Super Chat of ${amount}`, badge: `${amount} Super Chat` } }];
    }
    if (item.liveChatPaidStickerRenderer) {
      const r = item.liveChatPaidStickerRenderer;
      const amount = runsText(r.purchaseAmountText);
      return [{ type: 'message', kind: 'chat', id: r.id, ...author(r), text: '', emotes: '', paid: { label: `Super Sticker of ${amount}`, badge: `${amount} Super Sticker` } }];
    }
    if (item.liveChatMembershipItemRenderer) {
      const r = item.liveChatMembershipItemRenderer;
      const who = author(r);
      // A milestone says "Member for 6 months" and may carry a message; a new
      // member only gets YouTube's welcome line, which isn't worth reading.
      const milestone = runsText(r.headerPrimaryText);
      const systemText = milestone ? `${who.displayName}: ${milestone}` : `${who.displayName} became a member`;
      return [{ type: 'message', kind: 'event', id: r.id, ...who, ...messageParts(r.message), systemText }];
    }
    if (item.liveChatSponsorshipsGiftPurchaseAnnouncementRenderer) {
      const r = item.liveChatSponsorshipsGiftPurchaseAnnouncementRenderer;
      const header = (r.header && r.header.liveChatSponsorshipsHeaderRenderer) || {};
      const who = author({ ...header, authorExternalChannelId: r.authorExternalChannelId });
      const what = runsText(header.primaryText) || 'Sent gift memberships';
      return [{ type: 'message', kind: 'event', id: r.id, ...who, text: '', emotes: '', systemText: `${who.displayName}: ${what}` }];
    }
    return [];
  }
  const removed = action.removeChatItemAction || action.markChatItemAsDeletedAction;
  if (removed && removed.targetItemId) return [{ type: 'delete', id: removed.targetItemId }];
  const banned = action.removeChatItemByAuthorAction || action.markChatItemsByAuthorAsDeletedAction;
  if (banned && banned.externalChannelId) return [{ type: 'clear', userId: banned.externalChannelId }];
  return [];
}

class YouTubeChat extends EventEmitter {
  start(target) {
    this.stop();
    this.target = parseTarget(target);
    if (!this.target) {
      this.status('error', 'That doesn’t look like a YouTube channel or video');
      return;
    }
    this.abort = new AbortController();
    this.run(this.abort.signal);
  }

  stop() {
    if (this.abort) this.abort.abort();
    this.abort = null;
  }

  status(state, text) {
    this.emit('event', { type: 'status', state, text });
  }

  async run(signal) {
    let retries = 0;
    while (!signal.aborted) {
      try {
        this.status('connecting', `Looking for ${this.target.label}…`);
        const video = await this.findVideo(signal);
        if (signal.aborted) return;
        if (!video) {
          this.status('connecting', `${this.target.label} isn’t live. Waiting for the stream to start…`);
          await sleep(OFFLINE_RETRY_MS, signal);
          continue;
        }
        const chat = await this.openChat(video, signal);
        if (signal.aborted) return;
        retries = 0;
        this.status('connected', `Reading ${video.label}`);
        await this.poll(chat, signal);
        if (signal.aborted) return;
        if (this.target.kind === 'video') {
          this.status('idle', 'The stream has ended');
          return;
        }
        this.status('connecting', 'The stream has ended. Waiting for the next one…');
        await sleep(OFFLINE_RETRY_MS, signal);
      } catch (err) {
        if (signal.aborted) return;
        if (err instanceof Fatal) {
          this.status('error', err.message);
          return;
        }
        const delay = Math.min(60000, 2000 * 2 ** retries++);
        this.status('connecting', `${err.message || 'Connection lost'}, retrying in ${Math.round(delay / 1000)}s…`);
        await sleep(delay, signal);
      }
    }
  }

  // The live video a handle or channel points at, or null when nothing is
  // live there. A video id is taken as it is: its chat says whether it's live.
  async findVideo(signal) {
    if (this.target.kind === 'video') return { id: this.target.id, label: 'the stream' };
    const res = await request(`https://www.youtube.com/${this.target.path}`, signal);
    const html = await res.text();
    if (/"(?:status|reason)":"[^"]*(?:doesn.t exist|isn.t available)/.test(html) || res.url.includes('/error')) {
      throw new Fatal(`${this.target.label} doesn’t exist on YouTube`);
    }
    // /live redirects to the stream itself only while there is one.
    const canonical = (html.match(/<link rel="canonical" href="([^"]+)"/) || [])[1] || '';
    const id = (canonical.match(/[?&]v=([\w-]{11})/) || [])[1];
    if (!id || !/"isLive(?:Now)?":true/.test(html)) return null;
    const channel = (html.match(/"ownerChannelName":"((?:[^"\\]|\\.)*)"/) || [])[1];
    return { id, label: this.target.kind === 'handle' ? this.target.label : (channel ? JSON.parse(`"${channel}"`) : 'the stream') };
  }

  async openChat(video, signal) {
    const res = await request(`https://www.youtube.com/live_chat?is_popout=1&v=${video.id}`, signal);
    const html = await res.text();
    const key = (html.match(/"INNERTUBE_API_KEY":"([\w-]+)"/) || [])[1];
    const context = (html.match(/"INNERTUBE_CONTEXT":(\{.*?\}),"INNERTUBE_CONTEXT_CLIENT_NAME"/s) || [])[1];
    const data = (html.match(/(?:window\["ytInitialData"\]|var ytInitialData)\s*=\s*(\{.+?\});\s*<\/script>/s) || [])[1];
    if (!key || !context || !data) throw new Error('Couldn’t read the YouTube chat page');
    const renderer = (JSON.parse(data).contents || {}).liveChatRenderer;
    if (!renderer) {
      throw new Fatal(this.target.kind === 'video' ? 'That video has no live chat' : 'Chat is turned off for this stream');
    }
    // "Live chat" rather than "Top chat", which YouTube filters.
    const menu = (((renderer.header || {}).liveChatHeaderRenderer || {}).viewSelector || {}).sortFilterSubMenuRenderer;
    const all = menu && menu.subMenuItems && menu.subMenuItems[1];
    const continuation = (all && all.continuation && all.continuation.reloadContinuationData && all.continuation.reloadContinuationData.continuation)
      || nextContinuation(renderer.continuations).continuation;
    if (!continuation) throw new Error('Couldn’t start the YouTube chat');
    return { key, context: JSON.parse(context), continuation };
  }

  async poll(chat, signal) {
    let continuation = chat.continuation;
    // The first answer replays the last few dozen messages, which were
    // written before we got here. Twitch doesn't replay them either.
    let first = true;
    while (!signal.aborted) {
      const res = await request(`https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${chat.key}&prettyPrint=false`, signal, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: chat.context, continuation }),
      });
      const body = await res.json();
      const live = body.continuationContents && body.continuationContents.liveChatContinuation;
      if (!live) return;   // the stream is over
      for (const action of live.actions || []) {
        for (const event of toEvents(action)) {
          if (first && event.type === 'message') continue;
          this.emit('event', event);
        }
      }
      first = false;
      const next = nextContinuation(live.continuations);
      if (!next.continuation) return;
      continuation = next.continuation;
      await sleep(Math.max(1000, Math.min(next.timeoutMs || POLL_MS, POLL_MS)), signal);
    }
  }
}

function nextContinuation(list) {
  for (const entry of list || []) {
    const data = entry.invalidationContinuationData || entry.timedContinuationData || entry.reloadContinuationData;
    if (data && data.continuation) return data;
  }
  return {};
}

module.exports = { YouTubeChat, parseTarget, messageParts, toEvents };
