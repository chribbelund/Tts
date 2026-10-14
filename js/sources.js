'use strict';

// YouTube and TikTok chat. Neither can be read from a web page (they send no
// CORS headers and TikTok's connection has to be signed), so the desktop app
// reads them in its main process (desktop/sources/) and passes each message
// here. In a browser these simply aren't available.

const PLATFORMS = {
  twitch: { name: 'Twitch', short: 'TW' },
  youtube: { name: 'YouTube', short: 'YT' },
  tiktok: { name: 'TikTok', short: 'TT' },
};

// Chatters from YouTube and TikTok are kept apart from Twitch logins, and
// from each other, by a prefix on everything keyed by login: nicknames,
// voices, the ignore list. Twitch logins stay bare, as they always were.
const LOGIN_PREFIX = { youtube: 'yt:', tiktok: 'tt:' };

function platformOfLogin(login) {
  if ((login || '').startsWith('yt:')) return 'youtube';
  if ((login || '').startsWith('tt:')) return 'tiktok';
  return 'twitch';
}

const bareLogin = (login) => (login || '').replace(/^(?:yt|tt):/, '');

/**
 * What the YouTube field holds, as the desktop app wants it: '@handle',
 * 'video:ID' or 'channel:UC…'. Accepts handles with or without the @, and
 * links to a channel, a watch page, youtu.be, /live/ID or the chat pop-out.
 */
function normalizeYouTube(input) {
  let s = (input || '').trim();
  if (!s) return null;
  const url = /^(?:https?:\/\/)?(?:[\w-]+\.)?(?:youtube\.com|youtu\.be)\//i.test(s) ? new URL(/^https?:/i.test(s) ? s : `https://${s}`) : null;
  if (url) {
    const v = url.searchParams.get('v');
    if (v && /^[\w-]{11}$/.test(v)) return `video:${v}`;
    const parts = url.pathname.split('/').filter(Boolean);
    if (/youtu\.be$/i.test(url.hostname) && /^[\w-]{11}$/.test(parts[0] || '')) return `video:${parts[0]}`;
    if (['live', 'shorts', 'embed', 'video'].includes(parts[0]) && /^[\w-]{11}$/.test(parts[1] || '')) return `video:${parts[1]}`;
    if (parts[0] === 'channel' && /^UC[\w-]{22}$/.test(parts[1] || '')) return `channel:${parts[1]}`;
    if (parts[0] && parts[0].startsWith('@')) s = decodeURIComponent(parts[0]);
    else return null;
  }
  if (/^UC[\w-]{22}$/.test(s)) return `channel:${s}`;
  const handle = s.replace(/^@/, '');
  // Eleven characters with a digit, dash or underscore is a video id; a
  // plain word that long is more likely a handle.
  if (!s.startsWith('@') && /^[\w-]{11}$/.test(s) && /[\d_-]/.test(s)) return `video:${s}`;
  return /^[\p{L}\p{N}_.\-·]{3,30}$/u.test(handle) ? `@${handle}` : null;
}

function normalizeTikTok(input) {
  let s = (input || '').trim();
  const fromUrl = s.match(/tiktok\.com\/@([\w.]+)/i);
  if (fromUrl) s = fromUrl[1];
  s = s.replace(/^@/, '').toLowerCase();
  return /^[a-z0-9_.]{2,24}$/.test(s) ? s : null;
}

// How a connected source is named in the status line and the tray.
function sourceLabel(platform, target) {
  if (!target) return PLATFORMS[platform].name;
  if (platform === 'twitch') return `#${target}`;
  if (platform === 'tiktok') return `@${target}`;
  return target.startsWith('@') ? target : `YouTube ${target.startsWith('video:') ? 'stream' : 'channel'}`;
}

/**
 * The page's end of a chat the desktop app reads. Same shape as TwitchChat:
 * connect(), disconnect(), .connected, .channel, and the handlers onStatus,
 * onMessage, onDeleteMessage and onClearChat.
 */
class RemoteChat {
  static get available() {
    return !!(window.chatReaderDesktop && window.chatReaderDesktop.connectSource);
  }

  constructor(platform, handlers) {
    this.platform = platform;
    this.h = handlers;
    this.channel = null;
    this.state = 'idle';
    RemoteChat.all[platform] = this;
    RemoteChat.listen();
  }

  static listen() {
    if (RemoteChat.listening || !RemoteChat.available) return;
    RemoteChat.listening = true;
    window.chatReaderDesktop.onSourceEvent((event) => {
      const chat = RemoteChat.all[event && event.platform];
      if (chat && chat.channel) chat.handle(event);
    });
  }

  get connected() {
    return this.state === 'connected';
  }

  // Connecting or connected: what TwitchChat's `ws` stands for.
  get active() {
    return !!this.channel;
  }

  connect(target) {
    this.channel = target;
    if (!RemoteChat.available) {
      this.channel = null;
      this.setState('error', `${PLATFORMS[this.platform].name} needs the desktop app`);
      return;
    }
    this.setState('connecting', `Connecting to ${sourceLabel(this.platform, target)}…`);
    window.chatReaderDesktop.connectSource(this.platform, target);
  }

  disconnect(silent = false) {
    const was = this.channel;
    this.channel = null;
    if (was && RemoteChat.available) window.chatReaderDesktop.disconnectSource(this.platform);
    this.state = 'idle';
    if (!silent) this.h.onStatus('idle', 'Disconnected');
  }

  setState(state, text) {
    this.state = state;
    this.h.onStatus(state, text);
  }

  handle(event) {
    switch (event.type) {
      case 'status':
        if (event.state === 'idle' || event.state === 'error') this.channel = null;
        this.setState(event.state, event.text);
        break;
      case 'message':
        this.h.onMessage(event);
        break;
      case 'delete':
        this.h.onDeleteMessage(`${LOGIN_PREFIX[this.platform]}${event.id}`);
        break;
      case 'clear':
        this.h.onClearChat(`${LOGIN_PREFIX[this.platform]}${event.userId}`);
        break;
    }
  }
}

RemoteChat.all = {};
RemoteChat.listening = false;
