'use strict';

// Starts the bot once every other file has loaded: reads its files, hooks
// into the reader, logs back in, and starts the overlay, events, timers and
// OBS. The last of the bot's scripts js/app.js loads.

Bot.overlayStatus = null;

Bot.applyOverlay = async () => {
  const o = Bot.data.overlay;
  Bot.overlayStatus = await Bot.desktop.configureOverlay({ enabled: o.enabled, port: o.port, apiKey: o.apiKey });
  if (Bot.overlayStatus.error) Bot.log('error', `Overlay: ${Bot.overlayStatus.error}`);
  Bot.applyOverlayStyle();
  Bot.emit('overlay');
  // An overlay that reconnects gets the counters again from the server's memory.
  Bot.counters.publishAll();
  return Bot.overlayStatus;
};

// Sends the overlay style to the server, which passes it on to every open
// overlay and to each one that connects later.
let styleTimer = null;
Bot.applyOverlayStyle = () => {
  clearTimeout(styleTimer);
  styleTimer = null;
  const o = Bot.data.overlay;
  Bot.desktop.setOverlayStyle({ style: o.style, css: o.css, instances: o.instances.map((i) => ({ name: i.name, style: i.style, css: i.css })) });
};
// For colour pickers and sliders, which change many times a second.
Bot.applyOverlayStyleSoon = () => {
  clearTimeout(styleTimer);
  styleTimer = setTimeout(Bot.applyOverlayStyle, 150);
};

function hookIntoReader() {
  const host = Bot.host;

  // What the reader leaves out: the bot's own replies, and commands for the
  // bot in the streamer's own channel.
  host.skipReason = (entry) => {
    if (!Bot.data || entry.kind !== 'chat') return null;
    // What the multistream relay posted, coming back in: it was read once already.
    if (Bot.relay.isEcho(entry.platform, entry.rawText)) return 'relayed';
    if (entry.platform !== 'twitch') return null;
    const now = Date.now();
    if (!Bot.data.readBotMessages) {
      const bot = Bot.twitch.accounts.bot;
      if (bot && entry.login === bot.login) return 'bot reply';
      const text = String(entry.rawText || '').toLowerCase();
      if (Bot.twitch.sent.some((s) => s.login === entry.login && now - s.at < 15000 && text && s.text.startsWith(text.slice(0, 200)))) return 'bot reply';
    }
    const mine = Bot.twitch.streamerLogin();
    if (Bot.data.skipBotCommands && mine && entry.sourceLabel === `#${mine}` && Bot.commands.isCommand(entry.rawText)) return 'bot command';
    return null;
  };

  host.onRemoteMessage = (entry) => {
    if (!Bot.ready) return;
    try { Bot.chat.fromRemote(entry); } catch (err) { Bot.log('error', err.message); }
  };

  // The setup guide comes from the macOS Settings menu; the rest are hotkeys.
  host.onAction = (action) => (action === 'bot:setup' ? Bot.setup.open() : Bot.hotkeys.run(action));

  // Backup & import saves the bot along with the reader, and loads it back.
  host.backupExtra = () => ({ setup: Bot.data, ...(Bot.data.ui.backupViewers !== false ? { viewers: Bot.viewers } : {}) });
  host.restoreExtra = (part) => {
    if (!confirm('This file also has a bot setup (commands, events, timers…). Replace your bot setup with it? Your Twitch login stays.')) return false;
    try {
      Bot.replaceData(part, { withViewers: !!part.viewers });
      return true;
    } catch (err) {
      Bot.log('error', `Couldn’t load the bot setup: ${err.message}`);
      return false;
    }
  };
  host.hotkeys = () => (Bot.data ? Bot.hotkeys.bindings() : []);
}

function startTwitch() {
  Bot.eventsub.start();
  Bot.community.start();
  UI.rewardsCache = null;
}

(async () => {
  try {
    await Bot.loadData();
  } catch (err) {
    console.error('Bot: couldn’t read its files', err);
    return;
  }
  hookIntoReader();
  UI.init();

  // Before anything below can fail or stall: a login made from the Accounts
  // page has to start the Twitch events whatever happened at startup.
  Bot.on('login', (role) => { if (role === 'streamer') startTwitch(); UI.rerender(); });
  Bot.on('logout', (role) => {
    if (role === 'streamer') Bot.eventsub.stop();
    UI.rerender();
  });
  Bot.on('stream', (stream) => { UI.lastStream = stream; });
  Bot.on('reset', () => { Bot.lists.publish(); Bot.host.syncHotkeys(); Bot.applyOverlay(); });

  Bot.desktop.onMainEvent(({ type, payload }) => {
    if (type === 'overlay') { Bot.overlayStatus = payload; Bot.emit('overlay'); }
    if (type === 'api' && payload && payload.action === 'run') {
      Bot.lists.run(payload.id, payload.args || [], { type: 'api', name: '' });
    }
  });

  // A timer shouldn't fire the moment the app opens just because it was due
  // when the app was closed.
  for (const t of Bot.data.timers) { t.lastRun = Date.now(); t.linesSince = 0; }

  await Bot.applyOverlay().catch((err) => Bot.log('error', `Overlay: ${err.message}`));
  // One part that fails to start shouldn't keep the rest (Twitch above all) from starting.
  for (const [name, step] of [['effect lists', Bot.lists.publish], ['timers', Bot.timers.start], ['community', Bot.community.start]]) {
    try { step(); } catch (err) { Bot.log('error', `Couldn’t start the ${name}: ${err.message}`); }
  }

  await Bot.twitch.init().catch((err) => Bot.log('error', `Twitch: ${err.message}`));
  if (Bot.twitch.loggedIn()) startTwitch();
  if (Bot.data.obs.enabled && Bot.data.obs.autoConnect) Bot.obs.connect();
  Bot.relay.start();
  Bot.host.syncHotkeys();

  Bot.ready = true;
  Bot.events.fire('appStarted');
  // The first time, the setup guide. Someone already logged in (from before
  // the guide existed) has done it.
  if (!Bot.data.ui.setupDone) {
    if (Bot.twitch.loggedIn()) { Bot.data.ui.setupDone = true; Bot.save(); } else Bot.setup.open();
  }
  Bot.log('info', 'Bot started');
})();
