'use strict';

// The setup guide: a step-by-step dialog the first time the app opens, which
// walks through the Twitch application, logging in, the chats to read, the
// voice, the overlay and OBS, the shortcuts and a few starter alerts. Every
// step can be skipped; each one only uses what the sections themselves use,
// so anything done here can be changed there later. It can be run again from
// App → Accounts, and on macOS from the Settings menu.

(() => {
  const h = UI.h;
  const save = () => Bot.save();
  const external = (url) => window.chatReaderDesktop.openExternal(url);
  const host = Bot.host;

  const Setup = Bot.setup = { open: null, isOpen: () => dialog.open };

  // What's typed in the guide, kept while it redraws.
  const S = {
    chatTwitch: true, chatTwitchName: '', chatYoutube: '', chatTiktok: '', chatsNote: '',
    obsPassword: '', obsNote: '',
    starter: { alerts: true, raidThanks: true, followSpeak: false, points: false }, starterNote: '',
    alertNote: '',
  };
  let index = 0;
  let voiceTimer = null;

  const dialog = h('dialog', { class: 'settings-dialog bot-setup bot-scope', 'aria-labelledby': 'setupTitle' });
  document.body.append(dialog);

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  const looksLikeClientId = (id) => /^[a-z0-9]{20,40}$/i.test(String(id || '').trim());

  // Shows a section of the window and leaves the guide where it was.
  const goTo = (pageId) => { finish(); Bot.shell.show(pageId); };

  const tick = (ok, text) => h('p', { class: `setup-tick${ok ? ' ok' : ''}` },
    h('span', { 'aria-hidden': 'true' }, ok ? '✓' : '•'), ' ', text);

  // A choice drawn as a big button, for the voice engine.
  const choiceCard = (selected, title, text, onclick) => h('button', {
    type: 'button', class: 'setup-choice', 'aria-pressed': String(selected), onclick,
  }, h('strong', {}, title), h('span', { class: 'hint' }, text));

  // -------------------------------------------------------------------------
  // The steps
  // -------------------------------------------------------------------------

  const STEPS = [
    {
      id: 'welcome',
      label: 'Welcome',
      title: 'Welcome to Chat Reader',
      render: () => [
        UI.lead('Chat Reader reads your chat out loud and runs a Twitch bot: alerts, commands, timers, points and an overlay for OBS. This guide sets up the parts you need, one step at a time. It takes about five minutes.'),
        h('ol', { class: 'bot-steps setup-overview' },
          h('li', {}, h('strong', {}, 'Your Twitch application'), ': a free app on dev.twitch.tv the bot logs in through'),
          h('li', {}, h('strong', {}, 'Log in to Twitch'), ', and optionally a separate bot account'),
          h('li', {}, h('strong', {}, 'Chats to read'), ': your channel, and YouTube or TikTok if you stream there too'),
          h('li', {}, h('strong', {}, 'A voice'), ' for the reader'),
          h('li', {}, h('strong', {}, 'OBS'), ': the overlay for alerts, and remote control of scenes'),
          h('li', {}, h('strong', {}, 'Shortcuts'), ' that work while you’re in a game'),
          h('li', {}, h('strong', {}, 'A head start'), ': alerts and chat replies to begin with')),
        h('p', { class: 'hint' }, 'Every step can be skipped. You can run this guide again any time from App → Accounts.'),
      ],
      next: 'Let’s go',
    },

    {
      id: 'app',
      label: 'Twitch app',
      title: 'Make your Twitch application',
      done: () => looksLikeClientId(Bot.data.clientId),
      render: (redraw) => {
        const input = UI.text(Bot.data, 'clientId', {
          placeholder: 'e.g. abcd1234efgh5678…',
          onChange: () => { Bot.data.clientId = Bot.data.clientId.trim(); save(); status(); },
        });
        input.setAttribute('aria-label', 'Client ID');
        const note = h('p', { class: 'hint', role: 'status' });
        const status = () => {
          const id = Bot.data.clientId;
          note.textContent = !id ? '' : looksLikeClientId(id) ? '✓ That looks like a Client ID.' : 'A Client ID is 30 letters and numbers. Check it’s the Client ID, not the secret.';
          note.classList.toggle('bad', !!id && !looksLikeClientId(id));
          note.classList.toggle('good', looksLikeClientId(id));
        };
        status();
        input.addEventListener('change', redraw);
        return [
          UI.lead('Twitch lets an app log in only through an application its owner registered. Yours is free, takes a minute, and means nothing goes through anyone else’s server.'),
          h('ol', { class: 'bot-steps' },
            h('li', {}, UI.button('Open dev.twitch.tv', () => external('https://dev.twitch.tv/console/apps/create'), { cls: 'btn small primary' }), ' and log in. Twitch asks you to turn on two-factor authentication first if you haven’t.'),
            h('li', {}, h('strong', {}, 'Name'), ': anything unique, for example “Chat Reader for ', h('em', {}, 'yourname'), '”.'),
            h('li', {}, h('strong', {}, 'OAuth Redirect URLs'), ': ', h('code', { class: 'code-box' }, 'http://localhost'), ' ', UI.copyButton(() => 'http://localhost'), ' (it isn’t used, but Twitch wants one).'),
            h('li', {}, h('strong', {}, 'Category'), ': Chat Bot. ', h('strong', {}, 'Client Type'), ': Public.'),
            h('li', {}, 'Press ', h('em', {}, 'Create'), ', then ', h('em', {}, 'Manage'), ' next to it, and copy the ', h('strong', {}, 'Client ID'), ' into this box:')),
          UI.field('Client ID', input),
          note,
        ];
      },
    },

    {
      id: 'login',
      label: 'Log in',
      title: 'Log in to Twitch',
      done: () => Bot.twitch.loggedIn(),
      render: (redraw) => {
        if (!Bot.data.clientId.trim()) {
          return [
            UI.lead('Logging in needs the Client ID from the step before.'),
            UI.row(UI.button('← Back to the Twitch application', () => show(index - 1), { cls: 'btn small primary' })),
          ];
        }
        return [
          UI.lead('You log in on twitch.tv itself: the app shows a code, you type it there. Your password never goes through Chat Reader, and the login is kept encrypted by your system’s keychain.'),
          loginBox('streamer', redraw),
          h('details', { class: 'fx-more setup-more', open: !!Bot.twitch.accounts.bot || (Bot.twitch.login && Bot.twitch.login.role === 'bot') },
            h('summary', {}, 'A separate bot account (optional)'),
            h('p', { class: 'hint' }, 'With a second Twitch account, like “YourNameBot”, the bot’s replies come from it instead of from you. Make it a moderator in your channel so it can post quickly.'),
            loginBox('bot', redraw)),
        ];
      },
    },

    {
      id: 'chats',
      label: 'Chats',
      title: 'Which chats should be read?',
      done: () => (host.readerChats ? host.readerChats().length > 0 : false),
      render: (redraw) => {
        const me = Bot.twitch.accounts.streamer;
        const reading = host.readerChats ? host.readerChats() : [];
        const yt = UI.text(S, 'chatYoutube', { placeholder: '@handle or a channel link' });
        yt.setAttribute('aria-label', 'YouTube channel');
        const tt = UI.text(S, 'chatTiktok', { placeholder: '@username' });
        tt.setAttribute('aria-label', 'TikTok username');
        const twitch = me
          ? UI.check(S, 'chatTwitch', `Your Twitch chat, #${me.login}`)
          : UI.field('Twitch channel', UI.text(S, 'chatTwitchName', { placeholder: 'yourchannel or a twitch.tv link' }), 'Not logged in yet, so type the channel.');
        const start = UI.button('Start reading', () => {
          const done = [];
          const name = me ? (S.chatTwitch ? me.login : '') : (S.chatTwitchName || '').trim();
          if (name && host.readChat('twitch', name)) done.push(`Twitch #${name.replace(/^#/, '')}`);
          if (S.chatYoutube.trim() && host.readChat('youtube', S.chatYoutube)) done.push('YouTube');
          if (S.chatTiktok.trim() && host.readChat('tiktok', S.chatTiktok)) done.push('TikTok');
          S.chatsNote = done.length ? `Reading ${done.join(', ')}. A chat that isn’t live yet waits for the stream to start.` : 'Pick at least one chat first.';
          redraw();
        }, { cls: 'btn small primary' });
        return [
          UI.lead('Chat Reader can read several chats at once, all in one queue. They’re the fields in the top bar of the Dashboard, where you can add or change them later.'),
          twitch,
          h('details', { class: 'fx-more setup-more', open: !!(S.chatYoutube || S.chatTiktok) },
            h('summary', {}, 'Also streaming on YouTube or TikTok?'),
            h('p', { class: 'hint' }, 'Their chats are read in the same queue. A channel that isn’t live yet is fine: it waits and starts when you go live.'),
            UI.row(UI.field('YouTube', yt), UI.field('TikTok', tt))),
          UI.row(start),
          S.chatsNote ? h('p', { class: 'hint', role: 'status' }, S.chatsNote) : null,
          reading.length ? tick(true, `In the top bar now: ${reading.map((c) => `${PLATFORMS[c.platform] ? PLATFORMS[c.platform].name : c.platform} ${c.target || ''}`.trim()).join(', ')}`) : null,
        ];
      },
    },

    {
      id: 'voice',
      label: 'Voice',
      title: 'Pick a voice',
      render: (redraw) => {
        const engine = host.settings.engine;
        const pick = (value) => {
          const radio = document.querySelector(`input[name="engine"][value="${value}"]`);
          if (radio && !radio.checked) { radio.checked = true; radio.dispatchEvent(new Event('change', { bubbles: true })); }
          redraw();
        };
        const status = h('p', { class: 'hint', role: 'status' });
        const updateStatus = () => {
          const v = host.voiceStatus();
          status.textContent = v.text ? `Voices: ${v.text}` : '';
        };
        updateStatus();
        clearInterval(voiceTimer);
        voiceTimer = setInterval(() => { if (dialog.open && STEPS[index].id === 'voice') updateStatus(); else clearInterval(voiceTimer); }, 700);
        const volume = { value: host.state().volume };
        return [
          UI.lead('Every chatter gets a voice of their own from a pool, so you can tell people apart without looking.'),
          h('div', { class: 'setup-choices', role: 'group', 'aria-label': 'Voice engine' },
            choiceCard(engine === 'kokoro', 'Neural voices', 'The most natural. They run on this computer, in English. The model downloads once (around 90 MB), then loads from the cache.', () => pick('kokoro')),
            choiceCard(engine === 'system', 'System voices', 'Built into your computer. They start instantly and cover many languages.', () => pick('system'))),
          status,
          UI.field('Volume', UI.range(volume, 'value', { onChange: (n) => host.setVolume(n) })),
          UI.row(UI.button('▶ Hear a sample', () => host.speak('Hi chat! This is how your messages will sound.', { priority: true, label: 'Setup' }), { cls: 'btn small primary' })),
          h('p', { class: 'hint' }, 'Reader → Voices has the full list, to choose which voices are in the pool.'),
        ];
      },
    },

    {
      id: 'obs',
      label: 'OBS',
      title: 'Connect OBS',
      done: () => Bot.obs.state === 'connected',
      render: (redraw) => {
        const s = Bot.overlayStatus || {};
        const url = s.url || `http://127.0.0.1:${Bot.data.overlay.port}/`;
        const o = Bot.data.obs;
        const password = UI.text(S, 'obsPassword', { type: 'password', placeholder: 'From Show Connect Info' });
        password.setAttribute('aria-label', 'OBS WebSocket password');
        const address = UI.text(o, 'url', { onChange: save });
        address.setAttribute('aria-label', 'OBS WebSocket address');
        const obsState = { connected: 'Connected', connecting: 'Connecting…', error: 'Not connected', idle: 'Not connected' }[Bot.obs.state];
        return [
          UI.lead('Two parts, both optional: the overlay shows alerts, pictures and counters on stream, and the WebSocket lets the bot switch scenes and react to OBS.'),
          UI.section('1. The overlay',
            h('div', { class: 'bot-card', 'data-state': s.running ? 'on' : s.error ? 'error' : '' },
              h('div', { class: 'bot-card-title' }, 'Overlay'),
              h('div', { class: 'bot-card-value' }, s.running ? (s.clients ? `Running · ${s.clients} open` : 'Running · not in OBS yet') : 'Not running'),
              s.error ? h('div', { class: 'hint bad' }, s.error, ' ', UI.button('Pick another port', () => goTo('overlay'), { cls: 'link' })) : null),
            h('ol', { class: 'bot-steps' },
              h('li', {}, 'In OBS, under Sources, press + and pick ', h('strong', {}, 'Browser'), '.'),
              h('li', {}, 'URL: ', h('code', { class: 'code-box' }, url), ' ', UI.copyButton(() => url)),
              h('li', {}, 'Width 1920, height 1080. Tick ', h('em', {}, 'Control audio via OBS'), ' to hear alert sounds on stream.'),
              h('li', {}, 'Put it on top in each scene, then send a test:')),
            UI.row(
              UI.button('Send a test alert', () => {
                Bot.effects.run([{ ...Bot.effects.newEffect('alert'), title: 'It works!', message: 'This is a test alert from Chat Reader.' }], UI.testContext());
                S.alertNote = (Bot.overlayStatus || {}).clients ? 'Sent. It should be on your OBS preview now.' : 'Sent, but no overlay is open yet. Add the browser source, then try again.';
                redraw();
              }, { cls: 'btn small primary' }),
              UI.button('Open it in the browser', () => Bot.desktop.openOverlay())),
            S.alertNote ? h('p', { class: 'hint', role: 'status' }, S.alertNote) : null),
          UI.section('2. Remote control',
            h('ol', { class: 'bot-steps' },
              h('li', {}, 'In OBS: Tools → ', h('strong', {}, 'WebSocket Server Settings'), '.'),
              h('li', {}, 'Tick ', h('em', {}, 'Enable WebSocket server'), ', then press ', h('em', {}, 'Show Connect Info'), ' and copy the password here.')),
            UI.row(UI.field('Address', address), UI.field('Password', password)),
            UI.row(
              UI.button(Bot.obs.state === 'connected' ? 'Reconnect' : 'Connect', async () => {
                if (S.obsPassword) await Bot.desktop.setSecret('obs-password', S.obsPassword);
                o.enabled = true;
                o.autoConnect = true;
                save();
                Bot.obs.connect();
              }, { cls: 'btn small primary' }),
              h('span', { class: `setup-state${Bot.obs.state === 'connected' ? ' ok' : Bot.obs.state === 'error' ? ' bad' : ''}`, role: 'status' },
                obsState, Bot.obs.state === 'connected' && Bot.obs.scenes.length ? ` · ${Bot.obs.scenes.length} scene${Bot.obs.scenes.length === 1 ? '' : 's'}` : '', Bot.obs.text && Bot.obs.state !== 'connected' ? ` · ${Bot.obs.text}` : '')),
            h('p', { class: 'hint' }, 'Once connected it reconnects by itself whenever the app and OBS are both open.')),
        ];
      },
    },

    {
      id: 'keys',
      label: 'Shortcuts',
      title: 'Shortcuts that work in-game',
      render: (redraw) => {
        const keys = host.settings.keys || {};
        const names = [['pause', 'Pause / resume'], ['skip', 'Skip the message'], ['replay', 'Hear the last one again'], ['volumeUp', 'Volume up'], ['volumeDown', 'Volume down'], ['clear', 'Clear what’s waiting']];
        const global = { on: !!host.settings.globalHotkeys };
        const box = UI.check(global, 'on', 'Let these work while another app (a game, Discord) is focused', {
          onChange: (on) => {
            const real = document.getElementById('globalHotkeys');
            if (real && real.checked !== on) { real.checked = on; real.dispatchEvent(new Event('change', { bubbles: true })); }
            redraw();
          },
        });
        return [
          UI.lead('Control the reader without leaving your game. Every one can be changed under App → Shortcuts & API, where you can also give the bot’s own effects a hotkey.'),
          h('dl', { class: 'setup-keys' }, names.filter(([k]) => keys[k] !== undefined).flatMap(([k, label]) => [
            h('dt', {}, h('kbd', {}, host.keyLabel(keys[k]) || '—')), h('dd', {}, label)])),
          box,
          window.chatReaderDesktop.platform === 'darwin' ? h('p', { class: 'hint' }, 'On macOS, the keyboard’s media keys need the app allowed under System Settings → Privacy & Security → Accessibility. Shortcuts & API has a button that asks for it.') : null,
        ];
      },
    },

    {
      id: 'starter',
      label: 'Head start',
      title: 'A head start',
      render: (redraw) => [
        UI.lead('Pick what to start with. It’s all added as ordinary events you can change or delete under Bot → Events.'),
        UI.check(S.starter, 'alerts', 'Alerts on stream for follows, subs, gifted subs, cheers and raids'),
        UI.check(S.starter, 'raidThanks', 'Thank raiders in chat: “Thanks for the raid, @name!”'),
        UI.check(S.starter, 'followSpeak', 'Say new followers out loud with the reader'),
        UI.check(S.starter, 'points', 'Loyalty points for watching (1 a minute, !points to check)'),
        UI.row(UI.button('Add these', () => { S.starterNote = addStarter(); redraw(); }, { cls: 'btn small primary' })),
        S.starterNote ? h('p', { class: 'hint', role: 'status' }, S.starterNote) : null,
        UI.section('Coming from another bot?',
          UI.lead('Commands, events, timers, quotes and viewers with their points can be brought over from Firebot or Mix It Up.'),
          UI.row(UI.button('Import from Firebot or Mix It Up…', () => goTo('backup')))),
      ],
    },

    {
      id: 'done',
      label: 'Done',
      title: 'You’re set',
      render: () => {
        const items = [
          ['Twitch application', looksLikeClientId(Bot.data.clientId), 'account'],
          [Bot.twitch.loggedIn() ? `Logged in as ${Bot.twitch.accounts.streamer.displayName}` : 'Logged in to Twitch', Bot.twitch.loggedIn(), 'account'],
          ['Reading chat', host.readerChats().length > 0, 'dashboard'],
          ['Overlay in OBS', !!(Bot.overlayStatus && Bot.overlayStatus.clients), 'overlay'],
          ['OBS remote control', Bot.obs.state === 'connected', 'obs'],
        ];
        return [
          UI.lead('Here’s where things stand. Anything not done yet can be finished in its section; a dot next to a section in the sidebar shows when something there needs you.'),
          h('ul', { class: 'setup-summary' }, items.map(([text, ok, page]) => h('li', {},
            h('span', { class: `setup-mark${ok ? ' ok' : ''}`, 'aria-hidden': 'true' }, ok ? '✓' : '–'),
            h('span', {}, text, h('span', { class: 'sr-only' }, ok ? ', done' : ', not yet')),
            ok ? null : UI.button('Set up', () => goTo(page), { cls: 'link' })))),
          UI.section('Where to next',
            h('ul', { class: 'bot-steps' },
              h('li', {}, h('strong', {}, 'Commands'), ': your own !commands, with cooldowns and who may use them.'),
              h('li', {}, h('strong', {}, 'Viewer controls'), ': let viewers pick their voice with bits, points or !voice.'),
              h('li', {}, h('strong', {}, 'Timers'), ': a message every so often, only while chat is active.'),
              h('li', {}, h('strong', {}, 'Multistream'), ': join your Twitch, YouTube and TikTok chats together.'))),
        ];
      },
      next: 'Finish',
    },
  ];

  // -------------------------------------------------------------------------
  // Logging in, as on the Accounts page, redrawn as it goes
  // -------------------------------------------------------------------------

  function loginBox(role, redraw) {
    const account = Bot.twitch.accounts[role];
    const login = Bot.twitch.login && Bot.twitch.login.role === role ? Bot.twitch.login : null;
    if (account) {
      return h('div', { class: 'bot-account' },
        account.avatar ? h('img', { src: account.avatar, alt: '', width: 40, height: 40 }) : null,
        h('div', {}, h('strong', {}, `✓ ${account.displayName}`), h('div', { class: 'hint' }, role === 'bot' ? 'Bot account: chat replies come from here' : 'Logged in. Your channel is connected.')),
        h('span', { class: 'bot-account-actions' }, UI.button('Log out', async () => { await Bot.twitch.logout(role); redraw(); })));
    }
    if (login) {
      return h('div', { class: 'bot-account bot-device' },
        h('div', {},
          h('p', {}, role === 'bot'
            ? 'Open the link in a browser window where you’re logged in as the bot account (a private window works), and enter this code:'
            : 'Open twitch.tv/activate, logged in as yourself, and enter this code:'),
          h('div', { class: 'bot-code' }, login.userCode),
          UI.row(
            UI.button('Open twitch.tv/activate', () => external(login.uri), { cls: 'btn small primary' }),
            UI.copyButton(() => login.uri, 'Copy the link'),
            UI.button('Cancel', () => { Bot.twitch.cancelLogin(); redraw(); })),
          h('p', { class: 'hint' }, 'This carries on by itself once Twitch has the code.')));
    }
    const status = UI.status();
    const busy = Bot.twitch.login && Bot.twitch.login.role !== role;
    return h('div', { class: 'bot-account' },
      h('div', {}, h('strong', {}, role === 'bot' ? 'Bot account' : 'Your Twitch account'),
        h('div', { class: 'hint' }, role === 'bot' ? (Bot.twitch.accounts.streamer ? 'Log in your own account first, then this one.' : 'After your own account.') : 'The channel you stream on.')),
      UI.button(role === 'bot' ? 'Log in the bot account' : 'Log in to Twitch', () => {
        Bot.twitch.startLogin(role).then(() => redraw()).catch((err) => { UI.say(status, `Logging in didn’t work: ${err.message}`, true); redraw(); });
        setTimeout(redraw, 600);
      }, { cls: `btn small${role === 'bot' ? '' : ' primary'}`, disabled: busy || (role === 'bot' && !Bot.twitch.accounts.streamer) }),
      status);
  }

  // -------------------------------------------------------------------------
  // The head start: ordinary events, added once
  // -------------------------------------------------------------------------

  function addStarter() {
    const added = [];
    const has = (type, name) => Bot.data.events.some((e) => e.type === type && e.name === name);
    const event = (type, name, effects) => {
      if (has(type, name)) return;
      Bot.data.events.push({ id: Bot.uid('v'), enabled: true, type, name, filters: { mode: 'all', items: [] }, queue: 'alerts', effects });
      added.push(name);
    };
    const alert = (title, message = '') => ({ ...Bot.effects.newEffect('alert'), title, message });
    const chat = (message) => ({ ...Bot.effects.newEffect('chat'), message });
    const speak = (text) => ({ ...Bot.effects.newEffect('speak'), text });

    if (S.starter.alerts) {
      event('follow', 'Follow alert', [alert('$user just followed!')]);
      event('sub', 'Sub alert', [alert('$user just subscribed!', '$tier')]);
      event('resub', 'Resub alert', [alert('$user resubscribed!', '$months months · $message')]);
      event('giftSub', 'Gifted subs alert', [alert('$user gifted $giftCount subs!')]);
      event('cheer', 'Cheer alert', [alert('$user cheered $bits bits!', '$message')]);
      event('raid', 'Raid alert', [alert('$user is raiding with $viewers viewers!')]);
    }
    if (S.starter.raidThanks) event('raid', 'Thank raiders', [chat('Thanks for the raid, @$user! Welcome to everyone coming in with them.')]);
    if (S.starter.followSpeak) event('follow', 'Say new followers', [speak('$user just followed. Welcome!')]);
    if (S.starter.points && !Bot.data.currency.enabled) {
      Bot.data.currency.enabled = true;
      added.push('loyalty points');
    }
    // Event types this build doesn't have (an older copy) are left out.
    Bot.data.events = Bot.data.events.filter((e) => Bot.events.types[e.type]);
    save();
    UI.rerender();
    return added.length ? `Added: ${added.join(', ')}. Try them under Bot → Events with Simulate.` : 'Those are already set up.';
  }

  // -------------------------------------------------------------------------
  // The dialog
  // -------------------------------------------------------------------------

  const body = h('div', { class: 'setup-body' });
  const progress = h('ol', { class: 'setup-progress', 'aria-label': 'Steps' });
  const title = h('h2', { id: 'setupTitle' });
  const counter = h('p', { class: 'hint setup-count' });
  const back = UI.button('Back', () => show(index - 1));
  const skip = UI.button('Skip this step', () => show(index + 1), { cls: 'btn small ghost' });
  const next = UI.button('Next', () => (index === STEPS.length - 1 ? finish() : show(index + 1)), { cls: 'btn small primary' });
  const close = UI.button('✕', () => finish(), { cls: 'x close-btn', aria: 'Close the setup guide' });

  dialog.append(h('div', { class: 'dialog-box' },
    h('header', { class: 'dialog-head setup-head' }, h('div', {}, counter, title), close),
    h('div', { class: 'setup-main' }, progress, body),
    h('footer', { class: 'bot-editor-foot setup-foot' },
      UI.button('Skip the guide', () => finish(), { cls: 'link setup-quit' }),
      back, skip, next)));

  function draw() {
    const step = STEPS[index];
    title.textContent = step.title;
    counter.textContent = `Step ${index + 1} of ${STEPS.length}`;
    progress.replaceChildren(...STEPS.map((s, i) => h('li', {},
      h('button', {
        type: 'button',
        class: 'setup-dot',
        'data-state': i === index ? 'current' : s.done && s.done() ? 'done' : i < index ? 'seen' : '',
        'aria-current': i === index ? 'step' : null,
        onclick: () => show(i),
      }, h('span', { class: 'setup-dot-mark', 'aria-hidden': 'true' }, s.done && s.done() ? '✓' : String(i + 1)), h('span', {}, s.label)))));

    // Redrawing replaces every control; keep the caret where it was.
    const focused = body.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = focused && (focused.getAttribute('aria-label') || focused.textContent);
    const scroll = body.scrollTop;
    try {
      body.replaceChildren(...[step.render(redraw)].flat().filter(Boolean));
    } catch (err) {
      console.error(err);
      body.replaceChildren(h('p', { class: 'warn' }, `Something went wrong drawing this step: ${err.message}`));
    }
    body.scrollTop = scroll;
    if (focusKey) {
      const again = [...body.querySelectorAll('button, input, select, textarea')].find((x) => (x.getAttribute('aria-label') || x.textContent) === focusKey);
      if (again) again.focus();
    }

    back.hidden = index === 0;
    skip.hidden = index === 0 || index === STEPS.length - 1 || (step.done && step.done());
    next.textContent = step.next || 'Next';
  }

  // Things that change by themselves (a login going through, OBS connecting)
  // redraw the step, unless something is being typed in it.
  let redrawTimer = null;
  function redraw() {
    if (!dialog.open || redrawTimer) return;
    redrawTimer = setTimeout(() => {
      redrawTimer = null;
      if (!dialog.open) return;
      const typing = body.contains(document.activeElement) && document.activeElement.matches('input:not([type="checkbox"]):not([type="range"]), textarea');
      if (typing) { dialog.addEventListener('focusout', () => setTimeout(redraw, 0), { once: true }); return; }
      draw();
    }, 50);
  }
  for (const type of ['accounts', 'login', 'logout', 'obs', 'overlay']) Bot.on(type, redraw);

  function show(i) {
    index = Math.max(0, Math.min(STEPS.length - 1, i));
    body.scrollTop = 0;
    draw();
    title.tabIndex = -1;
    title.focus({ preventScroll: true });
  }

  function finish() {
    clearInterval(voiceTimer);
    if (!Bot.data.ui.setupDone) {
      Bot.data.ui.setupDone = true;
      save();
    }
    if (dialog.open) dialog.close();
  }

  dialog.addEventListener('cancel', (e) => { e.preventDefault(); finish(); });

  // `step` is a step's id, to open the guide there.
  Setup.open = (step = '') => {
    const at = STEPS.findIndex((s) => s.id === step);
    if (!dialog.open) dialog.showModal();
    show(at === -1 ? 0 : at);
  };
  Setup.steps = STEPS;
})();
