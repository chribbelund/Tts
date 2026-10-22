'use strict';

// Starts the bot once every other file has loaded: reads its files, hooks
// into the reader, logs back in, and starts the overlay, events, timers and
// OBS. The last of the bot's scripts js/app.js loads.

Bot.overlayStatus = null;

Bot.applyOverlay = async () => {
  const o = Bot.data.overlay;
  // The overlay server only runs while the bot is on.
  Bot.overlayStatus = await Bot.desktop.configureOverlay({ enabled: o.enabled && Bot.enabled(), port: o.port, apiKey: o.apiKey });
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
    if (!Bot.enabled() || entry.kind !== 'chat') return null;
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
    if (!Bot.ready || !Bot.enabled()) return;
    try { Bot.chat.fromRemote(entry); } catch (err) { Bot.log('error', err.message); }
  };

  // The setup guide comes from the macOS Settings menu; the rest are hotkeys:
  // the screen reader's ("bot:sr:…") and the bot's own.
  host.onAction = (action) => {
    if (action === 'bot:setup') return Bot.setup.open();
    if (action.startsWith('bot:sr:')) return Bot.screen.run(action.slice(7));
    if (Bot.enabled()) Bot.hotkeys.run(action);
    return undefined;
  };

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
  host.hotkeys = () => (Bot.data ? [...(Bot.enabled() ? Bot.hotkeys.bindings() : []), ...Bot.screen.bindings()] : []);
}

function startTwitch() {
  Bot.eventsub.start();
  Bot.community.start();
  UI.rewardsCache = null;
}

// ---------------------------------------------------------------------------
// Switching the bot on and off (App → Bot (beta), and the setup guide)
// ---------------------------------------------------------------------------

// Everything the bot runs: Twitch and its events, the overlay server, timers,
// the viewer list, OBS, Spotify and the multistream relay. None of it starts
// while the bot is off, so the app is only a chat reader until it's turned on.
let running = false;
async function startBot() {
  if (running) return;
  running = true;
  // A timer shouldn't fire the moment the bot starts just because it was due
  // while it wasn't running.
  for (const t of Bot.data.timers) { t.lastRun = Date.now(); t.linesSince = 0; }

  await Bot.applyOverlay().catch((err) => Bot.log('error', `Overlay: ${err.message}`));
  // One part that fails to start shouldn't keep the rest (Twitch above all) from starting.
  for (const [name, step] of [['effect lists', Bot.lists.publish], ['timers', Bot.timers.start], ['community', Bot.community.start]]) {
    try { step(); } catch (err) { Bot.log('error', `Couldn’t start the ${name}: ${err.message}`); }
  }

  await Bot.twitch.init().catch((err) => Bot.log('error', `Twitch: ${err.message}`));
  if (!running) return;
  if (Bot.twitch.loggedIn()) startTwitch();
  if (Bot.data.obs.enabled && Bot.data.obs.autoConnect) Bot.obs.connect();
  Bot.spotify.connect().catch((err) => Bot.log('error', `Spotify: ${err.message}`));
  Bot.relay.start();
  Bot.host.syncHotkeys();
  Bot.log('info', 'Bot started');
}

function stopBot() {
  if (!running) return;
  running = false;
  for (const step of [Bot.eventsub.stop, Bot.community.stop, Bot.timers.stop, () => Bot.obs.disconnect(true), Bot.spotify.stop, Bot.relay.sync]) {
    try { step(); } catch (err) { console.error(err); }
  }
  Bot.applyOverlay().catch(() => {});
  Bot.host.syncHotkeys();
  Bot.log('info', 'Bot switched off');
}

// Turns the bot and stream tools on or off, right away: the pages appear or
// go, and its parts start or stop.
Bot.setEnabled = async (on) => {
  on = !!on;
  if (Bot.data.ui.botEnabled === on && running === on) return;
  Bot.data.ui.botEnabled = on;
  Bot.save();
  Bot.shell.applyEnabled();
  Bot.emit('enabled', on);
  if (on) {
    await startBot();
    Bot.events.fire('appStarted');
  } else {
    stopBot();
  }
  UI.rerender();
  Bot.shell.renderStatus();
};

// Before the switch existed, everyone had the bot. Someone who already used
// it (logged in to Twitch, or made commands or events) keeps it; anyone else
// starts with the reader only.
async function decideEnabled() {
  if (typeof Bot.data.ui.botEnabled === 'boolean') return;
  let used = Bot.data.commands.length > 0 || Bot.data.events.length > 0;
  if (!used) used = !!(await Bot.desktop.getSecret('twitch-streamer').catch(() => ''));
  Bot.data.ui.botEnabled = used;
  Bot.save();
}

(async () => {
  try {
    await Bot.loadData();
  } catch (err) {
    console.error('Bot: couldn’t read its files', err);
    return;
  }
  await decideEnabled();
  hookIntoReader();
  UI.init();

  // Before anything below can fail or stall: a login made from the Accounts
  // page has to start the Twitch events whatever happened at startup.
  Bot.on('login', (role) => { if (role === 'streamer' && Bot.enabled()) startTwitch(); UI.rerender(); });
  Bot.on('logout', (role) => {
    if (role === 'streamer') Bot.eventsub.stop();
    UI.rerender();
  });
  Bot.on('stream', (stream) => { UI.lastStream = stream; });
  Bot.on('reset', () => {
    // A backup can carry the switch with it.
    if (typeof Bot.data.ui.botEnabled !== 'boolean') Bot.data.ui.botEnabled = running;
    if (Bot.data.ui.botEnabled !== running) Bot.setEnabled(Bot.data.ui.botEnabled);
    Bot.lists.publish(); Bot.host.syncHotkeys(); Bot.applyOverlay();
  });

  Bot.desktop.onMainEvent(({ type, payload }) => {
    if (type === 'overlay') { Bot.overlayStatus = payload; Bot.emit('overlay'); }
    if (type === 'api' && payload && payload.action === 'run' && Bot.enabled()) {
      Bot.lists.run(payload.id, payload.args || [], { type: 'api', name: '' });
    }
  });

  if (Bot.enabled()) await startBot();
  else await Bot.applyOverlay().catch(() => {});
  // The screen reader is part of the reader, so it runs either way.
  await Bot.screen.start().catch((err) => Bot.log('error', `Screen reader: ${err.message}`));
  Bot.host.syncHotkeys();

  Bot.ready = true;
  Bot.events.fire('appStarted');
  // The first time, the setup guide. Someone already logged in (from before
  // the guide existed) has done it.
  if (!Bot.data.ui.setupDone) {
    if (Bot.enabled() && Bot.twitch.loggedIn()) { Bot.data.ui.setupDone = true; Bot.save(); } else Bot.setup.open();
  }
  Bot.log('info', Bot.enabled() ? 'App started, with the bot' : 'App started, reader only');
})();
