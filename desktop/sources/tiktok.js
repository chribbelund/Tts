'use strict';

// TikTok LIVE chat, through tiktok-live-connector. TikTok has no public chat
// API: the library speaks the same push protocol as the TikTok website, and
// the Euler Stream sign server signs the connection for it (free, without an
// account, at a modest rate limit). Like YouTube, this can't run in a page.

const { EventEmitter } = require('node:events');

const OFFLINE_RETRY_MS = 30000;
const HANDLE_RE = /^[a-z0-9_.]{2,24}$/;

// ESM only, so it's loaded the first time someone connects.
let library = null;
const loadLibrary = () => (library ||= import('tiktok-live-connector'));

const sleep = (ms, signal) => new Promise((resolve) => {
  if (signal.aborted) return resolve();
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

function roleOf(identity) {
  if (!identity) return 0;
  if (identity.isAnchor) return 4;
  if (identity.isModeratorOfAnchor) return 3;
  if (identity.isSubscriberOfAnchor) return 1;
  return 0;
}

function author(data) {
  const user = data.user || {};
  const handle = user.uniqueId || user.displayId || '';
  return {
    userId: String(user.userId || user.id || handle),
    login: handle.toLowerCase(),
    displayName: user.nickname || handle || 'someone',
    role: roleOf(data.userIdentity),
  };
}

class TikTokChat extends EventEmitter {
  start(target) {
    this.stop();
    const handle = String(target || '').replace(/^@/, '').toLowerCase();
    if (!HANDLE_RE.test(handle)) {
      this.status('error', 'That doesn’t look like a TikTok username');
      return;
    }
    this.handle = handle;
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
      let lib;
      try {
        lib = await loadLibrary();
      } catch (err) {
        this.status('error', `Couldn’t load the TikTok connector: ${err.message}`);
        return;
      }
      const connection = new lib.TikTokLiveConnection(this.handle, { processInitialData: false });
      const closed = new Promise((resolve) => {
        connection.on(lib.ControlEvent.DISCONNECTED, () => resolve('lost'));
        connection.on(lib.WebcastEvent.STREAM_END, () => resolve('ended'));
        signal.addEventListener('abort', () => resolve('stopped'), { once: true });
      });
      this.listen(connection, lib);
      // The library also reports errors it recovers from; the outcome that
      // matters is whether the connection closes, handled below.
      connection.on(lib.ControlEvent.ERROR, () => {});

      try {
        this.status('connecting', `Connecting to @${this.handle}…`);
        await connection.connect();
      } catch (err) {
        connection.disconnect().catch(() => {});
        if (signal.aborted) return;
        if (err instanceof lib.UserOfflineError) {
          retries = 0;
          this.status('connecting', `@${this.handle} isn’t live. Waiting for the stream to start…`);
          await sleep(OFFLINE_RETRY_MS, signal);
          continue;
        }
        if (err instanceof lib.InvalidUniqueIdError) {
          this.status('error', `@${this.handle} doesn’t exist on TikTok`);
          return;
        }
        const delay = Math.min(60000, 5000 * 2 ** retries++);
        const why = err instanceof lib.SignatureRateLimitError ? 'TikTok’s sign server is busy' : 'Couldn’t connect';
        this.status('connecting', `${why}, retrying in ${Math.round(delay / 1000)}s…`);
        await sleep(delay, signal);
        continue;
      }

      retries = 0;
      this.status('connected', `Reading @${this.handle}`);
      const why = await closed;
      connection.disconnect().catch(() => {});
      if (signal.aborted || why === 'stopped') return;
      this.status('connecting', why === 'ended'
        ? 'The stream has ended. Waiting for the next one…'
        : 'Connection lost, reconnecting…');
      await sleep(why === 'ended' ? OFFLINE_RETRY_MS : 3000, signal);
    }
  }

  listen(connection, lib) {
    const emit = (event) => this.emit('event', event);

    connection.on(lib.WebcastEvent.CHAT, (data) => {
      const text = data.content || data.comment || '';
      emit({ type: 'message', kind: 'chat', id: (data.common && data.common.msgId) || '', ...author(data), text, emotes: '' });
    });

    connection.on(lib.WebcastEvent.GIFT, (data) => {
      const gift = data.gift || data.giftDetails || {};
      // A streak of the same gift arrives once per tap; only the last one,
      // with the final count, is worth saying.
      if ((gift.type === 1 || gift.giftType === 1) && !data.repeatEnd) return;
      const name = gift.name || gift.giftName || (data.extendedGiftInfo && data.extendedGiftInfo.name) || 'a gift';
      const count = Math.max(1, Number(data.repeatCount) || 1);
      const who = author(data);
      const what = count > 1 ? `${count} ${name}${/s$/i.test(name) ? '' : 's'}` : name;
      emit({ type: 'message', kind: 'event', id: (data.common && data.common.msgId) || '', ...who, text: '', emotes: '', systemText: `${who.displayName} sent ${what}` });
    });

    connection.on(lib.WebcastEvent.IM_DELETE, (data) => {
      for (const id of data.deleteMsgIds || []) emit({ type: 'delete', id: String(id) });
      for (const userId of data.deleteUserIds || []) emit({ type: 'clear', userId: String(userId) });
    });
  }
}

module.exports = { TikTokChat };
