'use strict';

// Anonymous, read-only connection to Twitch chat over its IRC WebSocket.
// "justinfan" nicknames with any password are accepted by Twitch for reading.

const TWITCH_IRC_URL = 'wss://irc-ws.chat.twitch.tv:443';

function unescapeTagValue(value) {
  return value.replace(/\\(.)?/g, (_, c) => {
    switch (c) {
      case 's': return ' ';
      case ':': return ';';
      case '\\': return '\\';
      case 'r': return '\r';
      case 'n': return '\n';
      default: return c || '';
    }
  });
}

function parseIrcLine(line) {
  const msg = { tags: {}, prefix: '', command: '', params: [] };
  let rest = line;

  if (rest.startsWith('@')) {
    const space = rest.indexOf(' ');
    for (const pair of rest.slice(1, space).split(';')) {
      const eq = pair.indexOf('=');
      if (eq === -1) msg.tags[pair] = '';
      else msg.tags[pair.slice(0, eq)] = unescapeTagValue(pair.slice(eq + 1));
    }
    rest = rest.slice(space + 1);
  }
  if (rest.startsWith(':')) {
    const space = rest.indexOf(' ');
    msg.prefix = rest.slice(1, space);
    rest = rest.slice(space + 1);
  }
  const trailingAt = rest.indexOf(' :');
  let trailing = null;
  if (trailingAt !== -1) {
    trailing = rest.slice(trailingAt + 2);
    rest = rest.slice(0, trailingAt);
  }
  const parts = rest.split(' ').filter(Boolean);
  msg.command = parts.shift() || '';
  msg.params = parts;
  if (trailing !== null) msg.params.push(trailing);
  return msg;
}

class TwitchChat {
  /**
   * handlers: onStatus(state, text), onMessage(msg), onUserNotice(msg),
   *           onClearChat(targetUserId|null), onDeleteMessage(messageId)
   */
  constructor(handlers) {
    this.h = handlers;
    this.ws = null;
    this.channel = null;
    this.manualClose = true;
    this.retries = 0;
    this.retryTimer = null;
    this.pingTimer = null;
    this.pongTimer = null;
  }

  static normalizeChannel(input) {
    let s = (input || '').trim();
    const fromUrl = s.match(/twitch\.tv\/(?:popout\/)?([A-Za-z0-9_]+)/i);
    if (fromUrl) s = fromUrl[1];
    s = s.replace(/^[#@]/, '').toLowerCase();
    return /^[a-z0-9_]{1,25}$/.test(s) ? s : null;
  }

  connect(channel) {
    this.disconnect(true);
    this.channel = channel;
    this.manualClose = false;
    this.retries = 0;
    this.open();
  }

  disconnect(silent = false) {
    this.manualClose = true;
    clearTimeout(this.retryTimer);
    this.stopKeepalive();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.close();
    }
    if (!silent) this.h.onStatus('idle', 'Disconnected');
  }

  get connected() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  open() {
    this.h.onStatus('connecting', `Connecting to #${this.channel}…`);
    const ws = new WebSocket(TWITCH_IRC_URL);
    this.ws = ws;

    ws.onopen = () => {
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      ws.send('PASS SCHMOOPIIE');
      ws.send(`NICK justinfan${10000 + Math.floor(Math.random() * 89999)}`);
      ws.send(`JOIN #${this.channel}`);
      this.startKeepalive();
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      for (const line of String(event.data).split('\r\n')) {
        if (line) this.handle(parseIrcLine(line));
      }
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopKeepalive();
      if (this.manualClose) return;
      const delay = Math.min(30000, 1000 * 2 ** this.retries++);
      this.h.onStatus('connecting', `Connection lost, retrying in ${Math.round(delay / 1000)}s…`);
      this.retryTimer = setTimeout(() => this.open(), delay);
    };
  }

  send(line) {
    if (this.connected) this.ws.send(line);
  }

  // Twitch pings us every ~5 minutes, but a silently dropped socket would go
  // unnoticed until then, so we ping too and reconnect if nothing comes back.
  startKeepalive() {
    this.stopKeepalive();
    this.pingTimer = setInterval(() => {
      this.send('PING :keepalive');
      clearTimeout(this.pongTimer);
      this.pongTimer = setTimeout(() => this.ws && this.ws.close(), 10000);
    }, 60000);
  }

  stopKeepalive() {
    clearInterval(this.pingTimer);
    clearTimeout(this.pongTimer);
  }

  handle(msg) {
    switch (msg.command) {
      case 'PING':
        this.send(`PONG :${msg.params[0] || 'tmi.twitch.tv'}`);
        break;
      case 'PONG':
        clearTimeout(this.pongTimer);
        break;
      case 'RECONNECT':
        this.ws && this.ws.close();
        break;
      case 'JOIN':
        if (msg.prefix.startsWith('justinfan')) {
          this.retries = 0;
          this.h.onStatus('connected', `Reading #${this.channel}`);
        }
        break;
      case 'NOTICE':
        if (msg.tags['msg-id'] && msg.tags['msg-id'].startsWith('msg_channel_suspended')) {
          this.manualClose = true;
          this.h.onStatus('error', `#${this.channel} doesn't exist or is suspended`);
          this.ws && this.ws.close();
        }
        break;
      case 'PRIVMSG':
        this.h.onMessage(msg);
        break;
      case 'USERNOTICE':
        this.h.onUserNotice(msg);
        break;
      case 'CLEARCHAT':
        this.h.onClearChat(msg.params.length > 1 ? msg.tags['target-user-id'] || null : null);
        break;
      case 'CLEARMSG':
        this.h.onDeleteMessage(msg.tags['target-msg-id']);
        break;
    }
  }
}
