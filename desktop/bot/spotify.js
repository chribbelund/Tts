'use strict';

// Song requests through Spotify. Viewers ask with !sr; the requests wait in
// the app's own queue (data.spotify.queue), where the streamer can reorder or
// remove them. Spotify's API can add to its queue but not reorder or empty
// it, so each request is handed to Spotify only shortly before the song
// playing ends. The overlay's ?spotify mode shows what's playing.
//
// Logging in is the main process's (bot-main.js): Spotify sends the browser
// back to the overlay server. The refresh token is kept with the secrets.

(() => {
  const SPOTIFY_API = 'https://api.spotify.com/v1';
  const POLL_MS = 4000;
  const TRACK_ID_RE = /^[A-Za-z0-9]{22}$/;

  const Sp = Bot.spotify = {
    state: 'idle',        // idle | connecting | connected | error
    text: '',
    account: null,        // { name, product }
    token: '',
    expiresAt: 0,
    now: null,            // what Spotify is playing: { uri, name, artists, image, durationMs, progressMs, isPlaying, at, device }
    current: null,        // the request playing now, when the song playing is one
    upcoming: [],         // Spotify's own queue, as it last said
    upcomingAt: 0,
    skipOnce: new Set(),  // songs Spotify already had when they were taken out of the queue: skipped when they come up
    lastUri: '',
    pollTimer: null,
    retryTimer: null,
    backoffUntil: 0,
    loggingIn: false,
    problem: '',          // the last thing that went wrong while playing, for the Spotify page
  };

  const cfg = () => Bot.data.spotify;

  class LoggedOut extends Error {}

  function setState(state, text = '') {
    Sp.state = state;
    Sp.text = text;
    Bot.emit('spotify', { state, text });
  }

  const changed = () => { Bot.save(); Bot.emit('spotify-queue'); publish(); };

  // ---------------------------------------------------------------------------
  // Tokens and the Web API. Everything goes through the main process, which has
  // no CORS limits.
  // ---------------------------------------------------------------------------

  const saveRefresh = (token) => Bot.desktop.setSecret('spotify-refresh', token || null);

  let refreshing = null;
  async function refreshToken() {
    const refresh = await Bot.desktop.getSecret('spotify-refresh');
    if (!refresh) throw new LoggedOut('Not connected to Spotify');
    const res = await Bot.desktop.http({
      method: 'POST',
      url: 'https://accounts.spotify.com/api/token',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: cfg().clientId.trim() }).toString(),
    });
    if (res.error) throw new Error(res.error);
    let body = {};
    try { body = JSON.parse(res.text); } catch {}
    if (!res.ok) {
      if (body.error === 'invalid_grant' || body.error === 'invalid_client') {
        await saveRefresh(null);
        throw new LoggedOut('Spotify logged the app out. Connect again.');
      }
      throw new Error(body.error_description || `Spotify said ${res.status}`);
    }
    Sp.token = body.access_token;
    Sp.expiresAt = Date.now() + ((body.expires_in || 3600) - 60) * 1000;
    // Spotify may hand out a new refresh token; the old one stops working.
    if (body.refresh_token) await saveRefresh(body.refresh_token);
  }

  // One refresh at a time: two at once would each use the same refresh token.
  function ensureToken(force = false) {
    if (!force && Sp.token && Date.now() < Sp.expiresAt) return Promise.resolve();
    if (!refreshing) refreshing = refreshToken().finally(() => { refreshing = null; });
    return refreshing;
  }

  function apiError(status, data) {
    const err = data && data.error;
    const message = (err && (err.message || err)) || '';
    const reason = (err && err.reason) || '';
    if (status === 404 && /device/i.test(`${message} ${reason}`)) return 'Spotify isn’t playing on any device. Start something in Spotify first.';
    if (status === 404 && !message) return 'Spotify isn’t playing on any device. Start something in Spotify first.';
    if (status === 403 && /premium/i.test(`${message} ${reason}`)) return 'Controlling Spotify needs Spotify Premium';
    if (status === 403 && /restrict/i.test(`${message} ${reason}`)) return 'Spotify won’t allow that right now';
    return message ? `Spotify: ${message}` : `Spotify said ${status}`;
  }

  Sp.api = async (method, path, { query = null, body } = {}) => {
    if (Date.now() < Sp.backoffUntil) throw new Error('Spotify asked the app to slow down; trying again in a moment');
    await ensureToken();
    const url = `${SPOTIFY_API}${path}${query ? `?${new URLSearchParams(query)}` : ''}`;
    const send = () => Bot.desktop.http({
      method,
      url,
      headers: { Authorization: `Bearer ${Sp.token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let res = await send();
    if (res.status === 401) {
      await ensureToken(true);
      res = await send();
    }
    if (res.error) throw new Error(`Spotify: ${res.error}`);
    if (res.status === 429) {
      Sp.backoffUntil = Date.now() + 30000;
      throw new Error('Spotify asked the app to slow down; trying again in 30 s');
    }
    let data = null;
    if (res.text) { try { data = JSON.parse(res.text); } catch {} }
    if (!res.ok) throw new Error(apiError(res.status, data));
    return data;
  };

  // ---------------------------------------------------------------------------
  // Connecting
  // ---------------------------------------------------------------------------

  Sp.connected = () => Sp.state === 'connected';
  Sp.setUp = () => !!cfg().clientId.trim();

  async function loadAccount() {
    const me = await Sp.api('GET', '/me');
    Sp.account = { name: (me && (me.display_name || me.id)) || 'Spotify', product: (me && me.product) || '' };
  }

  Sp.connect = async () => {
    clearTimeout(Sp.retryTimer);
    if (!Sp.setUp() || !(await Bot.desktop.getSecret('spotify-refresh'))) { stopPolling(); setState('idle'); return; }
    setState('connecting', 'Connecting to Spotify…');
    try {
      await ensureToken(true);
      await loadAccount();
      setState('connected', `Connected as ${Sp.account.name}`);
      startPolling();
    } catch (err) {
      stopPolling();
      if (err instanceof LoggedOut) { setState('idle', err.message); return; }
      setState('error', `${err.message}. Trying again in a minute.`);
      Sp.retryTimer = setTimeout(Sp.connect, 60000);
    }
  };

  // Opens Spotify's login page in the browser and waits for it to come back.
  Sp.login = async () => {
    if (!Sp.setUp()) throw new Error('Enter your Spotify Client ID first');
    Sp.loggingIn = true;
    Bot.emit('spotify', {});
    try {
      const r = await Bot.desktop.spotifyLogin(cfg().clientId.trim());
      if (r.error) throw new Error(r.error);
      Sp.token = r.accessToken;
      Sp.expiresAt = Date.now() + ((r.expiresIn || 3600) - 60) * 1000;
      await saveRefresh(r.refreshToken);
      await loadAccount();
      setState('connected', `Connected as ${Sp.account.name}`);
      Bot.log('info', `Spotify connected as ${Sp.account.name}`);
      startPolling();
    } finally {
      Sp.loggingIn = false;
      Bot.emit('spotify', {});
    }
  };

  Sp.cancelLogin = () => Bot.desktop.cancelSpotifyLogin();

  Sp.logout = async () => {
    stopPolling();
    clearTimeout(Sp.retryTimer);
    await saveRefresh(null);
    Object.assign(Sp, { token: '', expiresAt: 0, account: null, now: null, current: null, upcoming: [], lastUri: '' });
    setState('idle');
    publish();
  };

  // ---------------------------------------------------------------------------
  // Watching what plays, and handing Spotify the next request in time
  // ---------------------------------------------------------------------------

  function trackInfo(item) {
    const images = (item.album && item.album.images) || [];
    // Spotify lists the biggest first; about 300 px is plenty for the overlay.
    const image = (images.find((i) => (i.width || 0) <= 320) || images[0] || {}).url || '';
    return {
      uri: item.uri,
      trackId: item.id,
      name: item.name || '',
      artists: (item.artists || []).map((a) => a.name).join(', '),
      album: (item.album && item.album.name) || '',
      image,
      durationMs: item.duration_ms || 0,
      explicit: !!item.explicit,
      url: (item.external_urls && item.external_urls.spotify) || '',
    };
  }

  function startPolling() {
    stopPolling();
    const loop = async () => {
      await Sp.poll();
      if (Sp.connected()) Sp.pollTimer = setTimeout(loop, POLL_MS);
    };
    loop();
  }

  function stopPolling() {
    clearTimeout(Sp.pollTimer);
    Sp.pollTimer = null;
  }

  let polling = false;
  Sp.poll = async () => {
    if (!Sp.connected() || polling) return;
    polling = true;
    try {
      const p = await Sp.api('GET', '/me/player', { query: { additional_types: 'track,episode' } });
      const item = p && p.item;
      Sp.now = item ? {
        ...trackInfo(item),
        progressMs: p.progress_ms || 0,
        isPlaying: !!p.is_playing,
        at: Date.now(),
        device: (p.device && p.device.name) || '',
      } : null;
      const uri = item ? item.uri : '';
      if (uri !== Sp.lastUri) {
        Sp.lastUri = uri;
        if (uri) await trackChanged(uri);
      }
      await feed();
      Sp.problem = '';
    } catch (err) {
      if (err instanceof LoggedOut) { stopPolling(); setState('idle', err.message); return; }
      Sp.problem = err.message;
    } finally {
      polling = false;
    }
    Bot.emit('spotify-now');
    publish();
  };

  async function trackChanged(uri) {
    if (Sp.skipOnce.has(uri)) {
      Sp.skipOnce.delete(uri);
      await Sp.api('POST', '/me/player/next').catch((err) => Bot.log('error', `Couldn’t skip a removed request: ${err.message}`));
      return;
    }
    const q = cfg().queue;
    const i = q.findIndex((r) => r.uri === uri && r.sent);
    if (i === -1) {
      // After a restart, the request playing is the last one in the history.
      const last = cfg().history[0];
      Sp.current = last && last.uri === uri && Date.now() - (last.playedAt || 0) < (last.durationMs || 0) + 600000 ? last : null;
      return;
    }
    const [req] = q.splice(i, 1);
    delete req.sent;
    delete req.sentAt;
    req.playedAt = Date.now();
    Sp.current = req;
    cfg().history.unshift(req);
    cfg().history.length = Math.min(cfg().history.length, 30);
    changed();
    const user = req.by ? { login: req.by.login, displayName: req.by.displayName, platform: req.by.platform, id: req.by.id || '' } : null;
    Bot.events.fire('songRequestPlaying', { user, fields: { song: req.name, artist: req.artists } });
  }

  Sp.refreshUpcoming = refreshUpcoming;
  async function refreshUpcoming() {
    const data = await Sp.api('GET', '/me/player/queue');
    Sp.upcoming = ((data && data.queue) || []).filter(Boolean).map(trackInfo);
    Sp.upcomingAt = Date.now();
  }

  async function sendToSpotify(req) {
    await Sp.api('POST', '/me/player/queue', { query: { uri: req.uri } });
    req.sent = true;
    req.sentAt = Date.now();
    changed();
  }

  // Spotify gets the first request once the song playing is nearly over. One at
  // a time, so the rest can still be moved around.
  async function feed() {
    const c = cfg();
    const q = c.queue;
    if (!q.length) return;
    const sent = q.find((r) => r.sent);
    if (sent) {
      // Still waiting in Spotify? It may have been lost (Spotify's queue was
      // cleared, or another device took over); then it goes again.
      if (Date.now() - sent.sentAt > 30000 && Date.now() - Sp.upcomingAt > 20000) {
        await refreshUpcoming();
        if (!Sp.upcoming.some((t) => t.uri === sent.uri) && Sp.lastUri !== sent.uri) {
          sent.sent = false;
          changed();
        }
      }
      return;
    }
    if (!c.autoplay || !Sp.now || !Sp.now.isPlaying) return;
    const left = Sp.now.durationMs - Sp.now.progressMs;
    if (left > Math.max(5, Number(c.sendAhead) || 15) * 1000 + POLL_MS) return;
    await sendToSpotify(q[0]);
  }

  // ---------------------------------------------------------------------------
  // Requests
  // ---------------------------------------------------------------------------

  async function findTrack(text) {
    const link = /(?:open\.spotify\.com\/(?:intl-[\w-]+\/)?track\/|spotify:track:)([A-Za-z0-9]{22})/.exec(text);
    if (link) {
      const item = await Sp.api('GET', `/tracks/${link[1]}`, { query: { market: 'from_token' } }).catch(() => null);
      return item && item.uri ? trackInfo(item) : null;
    }
    if (/open\.spotify\.com\/|spotify:(?:album|playlist|artist|episode|show):/.test(text)) throw new Error('only links to a single song work.');
    if (TRACK_ID_RE.test(text)) {
      const item = await Sp.api('GET', `/tracks/${text}`, { query: { market: 'from_token' } }).catch(() => null);
      if (item && item.uri) return trackInfo(item);
    }
    const data = await Sp.api('GET', '/search', { query: { q: text.slice(0, 200), type: 'track', limit: '1', market: 'from_token' } });
    const item = data && data.tracks && data.tracks.items && data.tracks.items[0];
    return item ? trackInfo(item) : null;
  }

  const sameUser = (by, user) => !!by && !!user && by.platform === (user.platform || 'twitch') && by.login === String(user.login || '').toLowerCase();

  function blockedBy(track) {
    const hay = `${track.name} ${track.artists}`.toLowerCase();
    return String(cfg().blocked || '').split(/[,\n]/).map((x) => x.trim().toLowerCase()).filter(Boolean).find((b) => {
      const id = /track[/:]([A-Za-z0-9]{22})/i.exec(b);
      if (id) return id[1] === track.trackId.toLowerCase() || id[1] === track.trackId;
      return hay.includes(b);
    });
  }

  // Finds the song and puts it in the queue. Gives back { req, position } or
  // { error: 'usage' | 'notFound' | 'closed' | 'offline' | 'rejected', reason }.
  // `force` (from the app itself) skips the limits.
  Sp.request = async (text, user, { force = false } = {}) => {
    const c = cfg();
    const query = String(text || '').trim();
    if (!query) return { error: 'usage' };
    if (!Sp.connected()) return { error: 'offline' };
    if (!force && !c.requests) return { error: 'closed' };
    let track;
    try { track = await findTrack(query); } catch (err) { return { error: 'rejected', reason: err.message }; }
    if (!track) return { error: 'notFound' };
    const role = force ? 4 : (user && user.role) || 0;
    if (role < 4 && blockedBy(track)) return { error: 'rejected', reason: 'that song can’t be requested here.', track };
    if (role < 3) {
      if (c.noExplicit && track.explicit) return { error: 'rejected', reason: 'that song is marked explicit.', track };
      if (Number(c.maxMinutes) > 0 && track.durationMs > c.maxMinutes * 60000) return { error: 'rejected', reason: `songs can be ${c.maxMinutes} minutes long at most.`, track };
      if (Number(c.maxQueue) > 0 && c.queue.length >= c.maxQueue) return { error: 'rejected', reason: 'the song queue is full.', track };
      const mine = c.queue.filter((r) => sameUser(r.by, user)).length;
      if (Number(c.maxPerUser) > 0 && mine >= c.maxPerUser) return { error: 'rejected', reason: `you already have ${mine} song${mine === 1 ? '' : 's'} waiting.`, track };
    }
    if (c.noDuplicates && (c.queue.some((r) => r.uri === track.uri) || Sp.lastUri === track.uri)) {
      return { error: 'rejected', reason: Sp.lastUri === track.uri ? 'that song is playing right now.' : 'that song is already in the queue.', track };
    }
    const req = {
      ...track, id: Bot.uid('s'), at: Date.now(), sent: false,
      by: user ? { login: String(user.login || '').toLowerCase(), displayName: user.displayName || user.login || '', platform: user.platform || 'twitch', id: user.id || '' } : null,
    };
    c.queue.push(req);
    changed();
    Bot.events.fire('songRequested', { user, fields: { song: req.name, artist: req.artists, position: c.queue.length } });
    // A short song playing now may end before the next poll.
    setTimeout(() => Sp.poll(), 300);
    return { req, position: c.queue.length };
  };

  // Search results for the Spotify page's "Add a song" box.
  Sp.search = async (text) => {
    const data = await Sp.api('GET', '/search', { query: { q: String(text).slice(0, 200), type: 'track', limit: '8', market: 'from_token' } });
    return ((data && data.tracks && data.tracks.items) || []).map(trackInfo);
  };

  // Added from the app: no limits, and the streamer is who asked unless `user` says otherwise.
  Sp.addTrack = (track, user = null) => {
    const { uri, trackId, name, artists, album, image, durationMs, explicit, url } = track;
    const req = { id: Bot.uid('s'), uri, trackId, name, artists, album, image, durationMs, explicit, url, at: Date.now(), sent: false, by: user };
    cfg().queue.push(req);
    changed();
    setTimeout(() => Sp.poll(), 300);
    return req;
  };

  // ---------------------------------------------------------------------------
  // Changing the queue (the Spotify page, chat commands, effects)
  // ---------------------------------------------------------------------------

  const findReq = (id) => cfg().queue.find((r) => r.id === id) || null;

  Sp.remove = (id) => {
    const req = findReq(id);
    if (!req) return null;
    if (req.sent) Sp.skipOnce.add(req.uri);
    cfg().queue = cfg().queue.filter((r) => r !== req);
    changed();
    return req;
  };

  // The song already handed to Spotify stays first; the rest move freely.
  Sp.move = (id, to) => {
    const q = cfg().queue;
    const from = q.findIndex((r) => r.id === id);
    if (from === -1 || q[from].sent) return;
    const min = q[0] && q[0].sent ? 1 : 0;
    const target = Math.max(min, Math.min(q.length - 1, to));
    if (target === from) return;
    const [req] = q.splice(from, 1);
    q.splice(target, 0, req);
    changed();
  };

  Sp.clear = () => {
    for (const r of cfg().queue) if (r.sent) Sp.skipOnce.add(r.uri);
    cfg().queue = [];
    changed();
  };

  // The last request of a viewer, for !wrongsong.
  Sp.removeLastOf = (user) => {
    const mine = cfg().queue.filter((r) => sameUser(r.by, user));
    const last = mine[mine.length - 1];
    return last ? Sp.remove(last.id) : null;
  };

  Sp.positionOf = (user) => {
    const i = cfg().queue.findIndex((r) => sameUser(r.by, user));
    return i === -1 ? null : { position: i + 1, req: cfg().queue[i] };
  };

  const pollSoon = () => setTimeout(() => Sp.poll(), 700);

  // Plays a request straight away: it goes to Spotify, then Spotify skips to it.
  Sp.playNow = async (id) => {
    const q = cfg().queue;
    const req = findReq(id);
    if (!req) return;
    const other = q.find((r) => r.sent && r !== req);
    if (other) {
      // Spotify has that one first; it gets skipped and sent again later.
      other.sent = false;
      Sp.skipOnce.add(other.uri);
    }
    q.splice(q.indexOf(req), 1);
    q.unshift(req);
    if (!req.sent) await sendToSpotify(req);
    else changed();
    try {
      await Sp.api('POST', '/me/player/next');
    } catch (err) {
      // Nothing was playing anywhere: start the song itself.
      if (other) Sp.skipOnce.delete(other.uri);
      await Sp.api('PUT', '/me/player/play', { body: { uris: [req.uri] } });
    }
    pollSoon();
  };

  Sp.skip = async () => { await Sp.api('POST', '/me/player/next'); pollSoon(); };
  Sp.pause = async () => { await Sp.api('PUT', '/me/player/pause'); pollSoon(); };
  Sp.resume = async () => { await Sp.api('PUT', '/me/player/play'); pollSoon(); };

  // Where the song playing is now, counted on from the last poll.
  Sp.progress = () => {
    const n = Sp.now;
    if (!n) return 0;
    return Math.min(n.durationMs, n.progressMs + (n.isPlaying ? Date.now() - n.at : 0));
  };

  // ---------------------------------------------------------------------------
  // The overlay (?spotify)
  // ---------------------------------------------------------------------------

  let lastPublished = '';
  function publish() {
    const n = Sp.connected() ? Sp.now : null;
    const event = {
      type: 'spotify',
      track: n ? { name: n.name, artists: n.artists, album: n.album, image: n.image, durationMs: n.durationMs } : null,
      progressMs: n ? n.progressMs : 0,
      isPlaying: !!(n && n.isPlaying),
      requestedBy: Sp.current && n && Sp.current.uri === n.uri && Sp.current.by ? Sp.current.by.displayName : '',
      next: cfg().queue.slice(0, 10).map((r) => ({ name: r.name, artists: r.artists, by: r.by ? r.by.displayName : '' })),
    };
    // The overlay counts the progress on by itself; it only needs telling
    // when something else changes, or the time drifts.
    const key = JSON.stringify({ ...event, progressMs: Math.round(event.progressMs / 15000) });
    if (key === lastPublished && !(n && n.progressMs < POLL_MS * 2)) return;
    lastPublished = key;
    Bot.desktop.sendOverlay(event);
  }
  Sp.publish = () => { lastPublished = ''; publish(); };

  // ---------------------------------------------------------------------------
  // Events, variables, effects and chat commands
  // ---------------------------------------------------------------------------

  Object.assign(Bot.events.types, {
    songRequested: {
      name: 'Song requested', category: 'Spotify', fields: [['song', 'Song'], ['artist', 'Artist'], ['position', 'Place in the queue']],
      text: (u, f) => `${u || 'Someone'} requested ${f.song} by ${f.artist}`, sample: { song: 'Never Gonna Give You Up', artist: 'Rick Astley', position: 1 },
    },
    songRequestPlaying: {
      name: 'Requested song starts', category: 'Spotify', fields: [['song', 'Song'], ['artist', 'Artist']],
      text: (u, f) => `Playing ${f.song} by ${f.artist}${u ? `, requested by ${u}` : ''}`, sample: { song: 'Never Gonna Give You Up', artist: 'Rick Astley' },
    },
  });

  const defVar = (name, description, fn) => Bot.vars.defs.set(name.toLowerCase(), { name, category: 'Spotify', description, fn, usage: `$${name}` });
  defVar('spotifySong', 'The song playing on Spotify', () => (Sp.now ? Sp.now.name : ''));
  defVar('spotifyArtist', 'Who the song playing on Spotify is by', () => (Sp.now ? Sp.now.artists : ''));
  defVar('spotifyLink', 'A link to the song playing on Spotify', () => (Sp.now ? Sp.now.url : ''));
  defVar('spotifyRequester', 'Who requested the song playing, if someone did', () => (Sp.current && Sp.now && Sp.current.uri === Sp.now.uri && Sp.current.by ? Sp.current.by.displayName : ''));
  defVar('songQueueLength', 'How many song requests are waiting', () => cfg().queue.length);

  const REASONS = {
    usage: 'type a song name or a Spotify link.',
    notFound: 'that song wasn’t found on Spotify.',
    closed: 'song requests are closed.',
    offline: 'Spotify isn’t connected.',
  };

  Bot.effects.types.set('spotify', {
    id: 'spotify', name: 'Spotify', category: 'Other apps', icon: '🎵',
    description: 'Needs Spotify connected on the Song requests page (under Stream). Controlling playback needs Spotify Premium.',
    fields: [
      { key: 'action', label: 'Action', type: 'select', default: 'request', options: [['request', 'Request a song'], ['skip', 'Skip the song playing'], ['pause', 'Pause'], ['resume', 'Play'], ['clear', 'Empty the request queue'], ['open', 'Open or close requests']] },
      { key: 'query', label: 'Song name or Spotify link', type: 'text', vars: true, default: '$message', showIf: (e) => e.action === 'request' },
      { key: 'limits', label: 'The request limits apply (length, songs per viewer…)', type: 'checkbox', default: true, showIf: (e) => e.action === 'request' },
      { key: 'announce', label: 'Say in chat whether it worked', type: 'checkbox', default: true, showIf: (e) => e.action === 'request' },
      { key: 'open', label: 'Requests are', type: 'select', default: 'toggle', options: [['on', 'Open'], ['off', 'Closed'], ['toggle', 'Switched']], showIf: (e) => e.action === 'open' },
    ],
    summary: (e) => (e.action === 'request' ? `Request ${e.query}` : { skip: 'Skip', pause: 'Pause', resume: 'Play', clear: 'Empty the queue', open: 'Open or close requests' }[e.action] || e.action),
    async run(e, ctx) {
      if (e.action === 'request') {
        const r = await Sp.request(await Bot.vars.render(e.query, ctx), ctx.user, { force: e.limits === false });
        const who = ctx.user ? `@${ctx.user.displayName || ctx.user.login}` : '';
        ctx.outputs.songRequest = r.req ? 'added' : r.error;
        if (r.req) {
          if (e.announce) await Bot.twitch.say(`${who} added “${r.req.name}” by ${r.req.artists} (#${r.position} in the queue).`);
          return;
        }
        const reason = r.reason || REASONS[r.error] || r.error;
        if (e.announce) await Bot.twitch.say(`${who}, ${reason}`);
        throw new Error(`song request: ${reason}`);
      }
      if (e.action === 'skip') return Sp.skip();
      if (e.action === 'pause') return Sp.pause();
      if (e.action === 'resume') return Sp.resume();
      if (e.action === 'clear') return Sp.clear();
      if (e.action === 'open') {
        cfg().requests = e.open === 'toggle' ? !cfg().requests : e.open === 'on';
        Bot.save();
        Bot.emit('spotify', {});
      }
      return undefined;
    },
  });

  // Replies in chat, from the texts that can be changed under Commands → Built in.
  async function say(cmd, key, ctx, extra = {}) {
    const template = cmd.texts[key];
    if (!template) return;
    await Bot.twitch.say(await Bot.vars.render(template, { ...ctx, fields: { ...ctx.fields, trigger: cmd.trigger, ...extra } }));
  }

  const requestsSetUp = () => Sp.setUp();

  Bot.commands.define('songrequest', {
    name: 'Song request (Spotify)', trigger: '!sr', aliases: '!songrequest', permission: 'everyone', cooldownUser: 10,
    when: requestsSetUp,
    texts: {
      added: '@$user added “$song” by $artist (#$position in the queue).',
      notFound: '@$user, I couldn’t find that on Spotify.',
      usage: '@$user, type $trigger and a song name or a Spotify link.',
      rejected: '@$user, $reason',
      closed: '@$user, song requests are closed right now.',
      offline: '',
    },
    async run(ctx, args) {
      const r = await Sp.request(args.join(' '), ctx.user);
      if (r.req) await say(this, 'added', ctx, { song: r.req.name, artist: r.req.artists, position: r.position });
      else await say(this, r.error, ctx, { reason: r.reason || '', song: r.track ? r.track.name : '', artist: r.track ? r.track.artists : '' });
    },
  });

  Bot.commands.define('song', {
    name: 'Song playing (Spotify)', trigger: '!song', permission: 'everyone', cooldownGlobal: 10,
    when: requestsSetUp,
    texts: {
      playing: 'Now playing: “$song” by $artist $link',
      requested: 'Now playing: “$song” by $artist, requested by $who $link',
      nothing: 'Nothing is playing on Spotify right now.',
    },
    async run(ctx) {
      const n = Sp.now;
      if (!n || !Sp.connected()) { await say(this, 'nothing', ctx); return; }
      const who = Sp.current && Sp.current.uri === n.uri && Sp.current.by ? Sp.current.by.displayName : '';
      await say(this, who ? 'requested' : 'playing', ctx, { song: n.name, artist: n.artists, who, link: n.url });
    },
  });

  Bot.commands.define('songqueue', {
    name: 'Song queue (Spotify)', trigger: '!queue', aliases: '!songlist', permission: 'everyone', cooldownGlobal: 15,
    when: requestsSetUp,
    texts: {
      list: 'Up next: $list',
      yours: '@$user, your song “$song” is #$position in the queue.',
      empty: 'No song requests waiting. Request one with !sr and a song name.',
    },
    async run(ctx) {
      const mine = Sp.positionOf(ctx.user);
      const q = cfg().queue;
      if (!q.length) { await say(this, 'empty', ctx); return; }
      const list = q.slice(0, 5).map((r, i) => `${i + 1}. ${r.name} – ${r.artists}${r.by ? ` (${r.by.displayName})` : ''}`).join(' · ') + (q.length > 5 ? ` · and ${q.length - 5} more` : '');
      await say(this, 'list', ctx, { list });
      if (mine && mine.position > 5) await say(this, 'yours', ctx, { song: mine.req.name, position: mine.position });
    },
  });

  Bot.commands.define('wrongsong', {
    name: 'Take back a song request (Spotify)', trigger: '!wrongsong', permission: 'everyone', cooldownUser: 5,
    when: requestsSetUp,
    texts: { removed: '@$user, I took “$song” out of the queue.', none: '@$user, you have no songs waiting.' },
    async run(ctx) {
      const req = Sp.removeLastOf(ctx.user);
      await say(this, req ? 'removed' : 'none', ctx, { song: req ? req.name : '' });
    },
  });

  Bot.commands.define('skipsong', {
    name: 'Skip the song (Spotify)', trigger: '!skipsong', permission: 'mods', cooldownGlobal: 5,
    when: requestsSetUp,
    texts: { skipped: 'Skipped “$song”.' },
    async run(ctx) {
      const song = Sp.now ? Sp.now.name : '';
      await Sp.skip();
      await say(this, 'skipped', ctx, { song });
    },
  });
})();
