'use strict';

// Starts the bot once every other file has loaded: reads its files, hooks
// into the reader, logs back in, and starts the overlay, events, timers and
// OBS. The last of the bot's scripts js/app.js loads.

Bot.overlayStatus = null;

Bot.applyOverlay = async () => {
  const o = Bot.data.overlay;
  Bot.overlayStatus = await Bot.desktop.configureOverlay({ enabled: o.enabled, port: o.port, apiKey: o.apiKey });
  if (Bot.overlayStatus.error) Bot.log('error', `Overlay: ${Bot.overlayStatus.error}`);
  Bot.emit('overlay');
  // An overlay that reconnects gets the counters again from the server's memory.
  Bot.counters.publishAll();
  return Bot.overlayStatus;
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

  host.onAction = (action) => Bot.hotkeys.run(action);

  // Settings → Backup saves the bot along with the reader, and loads it back.
  host.backupExtra = () => ({ setup: Bot.data, viewers: Bot.viewers });
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
  const backupHint = document.querySelector('#panel-backup .hint');
  if (backupHint) backupHint.append(' In the desktop app the file also holds the bot: commands, events, timers, the viewer list and the rest. Logins are never in it.');
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
  Bot.lists.publish();
  Bot.timers.start();
  Bot.community.start();

  Bot.on('login', (role) => { if (role === 'streamer') startTwitch(); UI.rerender(); });
  Bot.on('logout', (role) => {
    if (role === 'streamer') Bot.eventsub.stop();
    UI.rerender();
  });
  Bot.on('stream', (stream) => { UI.lastStream = stream; });
  Bot.on('reset', () => { Bot.lists.publish(); Bot.host.syncHotkeys(); Bot.applyOverlay(); });

  await Bot.twitch.init();
  if (Bot.twitch.loggedIn()) startTwitch();
  if (Bot.data.obs.enabled && Bot.data.obs.autoConnect) Bot.obs.connect();
  Bot.relay.start();
  Bot.host.syncHotkeys();

  Bot.ready = true;
  Bot.events.fire('appStarted');
  Bot.log('info', 'Bot started');
})();
