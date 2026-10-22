'use strict';

// The setup guide: a step-by-step dialog the first time the app opens. It
// starts with the reader: how the app looks, which chats to read, the voice,
// its speed, what gets read and what viewers may change, and the shortcuts.
// Then the bot and stream tools (beta), which are off unless turned on here
// or under App → Bot tools; only with them on does it go on to the Twitch
// application, logging in, OBS and a few starter alerts.
//
// Every step can be skipped. The reader's steps work the real controls of
// the reader's settings pages, so anything done here can be changed there
// later, and the bot's steps use what its sections use. It can be run again
// from App → Setup guide, and on macOS from the Settings menu.
//
// Many people who use the app can't see the screen well, so: each step
// starts with keyboard focus on its heading (which says which step it is),
// results are said by screen readers, and nothing needs a mouse.

(() => {
  const h = UI.h;
  const save = () => Bot.save();
  const external = (url) => window.chatReaderDesktop.openExternal(url);
  const host = Bot.host;
  const say = (text) => Bot.shell.say(text);

  const Setup = Bot.setup = { open: null, isOpen: () => dialog.open };

  // What's typed in the guide, kept while it redraws.
  const S = {
    chatTwitch: true, chatTwitchName: '', chatYoutube: '', chatTiktok: '', chatsNote: '',
    obsPassword: '', obsNote: '',
    starter: { alerts: true, raidThanks: true, followSpeak: false, points: false }, starterNote: '',
    alertNote: '', sampleNote: '',
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

  // A copy of one of the reader's own controls (by its id in index.html).
  // It shows the reader's current value, and a change goes to the reader's
  // control, which saves and applies it as if it had been changed there.
  function mirror(id, label, hint = '') {
    const real = document.getElementById(id);
    if (!real) return null;
    const send = (value) => {
      if (real.type === 'checkbox') real.checked = value;
      else real.value = value;
      real.dispatchEvent(new Event('input', { bubbles: true }));
      real.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const hintEl = hint ? h('p', { class: 'hint' }, hint) : null;

    if (real.type === 'checkbox') {
      const box = h('input', { type: 'checkbox', id: `setup-${id}` });
      box.checked = real.checked;
      box.addEventListener('change', () => send(box.checked));
      if (hintEl) { hintEl.id = `${id}-setup-hint`; box.setAttribute('aria-describedby', hintEl.id); }
      return h('div', { class: 'setup-control' }, h('label', { class: 'check' }, box, h('span', {}, label)), hintEl);
    }

    let control;
    if (real.tagName === 'SELECT') {
      control = h('select');
      for (const child of real.children) control.append(child.cloneNode(true));
      control.value = real.value;
      control.addEventListener('change', () => send(control.value));
    } else if (real.tagName === 'TEXTAREA') {
      control = h('textarea', { rows: 2, spellcheck: 'false', placeholder: real.placeholder });
      control.value = real.value;
      control.addEventListener('change', () => send(control.value));
    } else if (real.type === 'range') {
      // The reader's own label for the value ("80%", "1.25×"), so a screen
      // reader says that rather than a bare number.
      const outText = () => (document.querySelector(`output[for="${id}"]`) || {}).textContent || real.value;
      const input = h('input', { type: 'range', min: real.min, max: real.max, step: real.step });
      input.value = real.value;
      const out = h('output', { 'aria-hidden': 'true' }, outText());
      input.setAttribute('aria-valuetext', outText());
      input.addEventListener('input', () => {
        send(input.value);
        out.textContent = outText();
        input.setAttribute('aria-valuetext', out.textContent);
      });
      control = h('div', { class: 'bot-range' }, input, out);
    } else {
      control = h('input', { type: real.type || 'text', min: real.min || null, max: real.max || null, step: real.step || null, spellcheck: 'false', autocomplete: 'off' });
      control.value = real.value;
      // The reader may tidy the value up (a number kept in range); show what it kept.
      control.addEventListener('change', () => { send(control.value); control.value = real.value; });
    }
    (control.matches('input, select, textarea') ? control : control.querySelector('input')).id = `setup-${id}`;
    const field = UI.field(label, control);
    if (hintEl) {
      field.append(hintEl);
      const target = control.matches('input, select, textarea') ? control : control.querySelector('input');
      hintEl.id = `${id}-setup-hint`;
      target.setAttribute('aria-describedby', hintEl.id);
    }
    return field;
  }

  // Says something in the reader's voice, now. A paused reader would keep
  // it waiting, so say so instead.
  function sampleButton(text, label = '▶ Hear a sample') {
    return UI.button(label, () => {
      if (host.state().paused) {
        S.sampleNote = 'Reading is paused, so the sample waits until you resume it with the Pause button or your pause shortcut.';
      } else {
        S.sampleNote = '';
        host.speak(text, { priority: true, label: 'Setup' });
      }
      say(S.sampleNote);
      redraw();
    }, { cls: 'btn small primary' });
  }
  const sampleNote = () => (S.sampleNote ? h('p', { class: 'hint', role: 'status' }, S.sampleNote) : null);

  // The steps there are now: the bot's only while it's switched on.
  const steps = () => STEPS.filter((s) => !s.bot || Bot.enabled());

  // -------------------------------------------------------------------------
  // The steps
  // -------------------------------------------------------------------------

  const STEPS = [
    {
      id: 'welcome',
      label: 'Welcome',
      title: 'Welcome to Chat Reader',
      render: () => [
        UI.lead('Chat Reader reads your stream’s chat out loud, so you can follow it without looking at the screen. This guide sets it up one step at a time: how it looks, which chats to read, the voice, and the shortcuts. It takes about five minutes.'),
        h('ol', { class: 'bot-steps setup-overview' },
          steps().filter((s) => s.id !== 'welcome' && s.overview).map((s) => h('li', {}, h('strong', {}, s.label), `: ${s.overview}`))),
        UI.section('Moving around the guide',
          h('ul', { class: 'bot-steps' },
            h('li', {}, 'Each step starts at its heading, which says which step you’re on. Press Tab to go through what’s in it.'),
            h('li', {}, 'Next, Back and Skip are at the bottom. The list of steps lets you jump to any of them.'),
            h('li', {}, 'Every step can be skipped, and every setting can be changed later in its own section.'),
            h('li', {}, 'Escape closes the guide. Open it again any time from App → Setup guide in the sidebar.'))),
      ],
      next: 'Let’s go',
    },

    {
      id: 'display',
      label: 'Look',
      title: 'Make it comfortable to use',
      overview: 'text size, contrast and screen reader announcements',
      render: () => [
        UI.lead('Set these first, so the rest of the guide is easier to use. They change the whole app straight away.'),
        mirror('uiScale', 'Size of everything', 'Makes text and buttons bigger, all through the app.'),
        mirror('theme', 'Theme', 'Light or dark, or whatever your computer uses.'),
        mirror('highContrast', 'Stronger contrast and thicker outlines'),
        mirror('reduceMotion', 'Stop animations and blinking'),
        mirror('announce', 'Announce what happens, for screen readers', 'Says when reading pauses, resumes or skips, and when the volume changes. Chat messages aren’t announced, since they’re read out loud anyway.'),
        h('p', { class: 'hint' }, 'All of these are under App → Display.'),
      ],
    },

    {
      id: 'chats',
      label: 'Chats',
      overview: 'your channel, and YouTube or TikTok if you stream there too',
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
          : UI.field('Twitch channel', UI.text(S, 'chatTwitchName', { placeholder: 'yourchannel or a twitch.tv link' }), Bot.enabled() ? 'Not logged in yet, so type the channel.' : 'Your channel’s name, or a link to it. Reading a Twitch chat doesn’t need a login.');
        const start = UI.button('Start reading', () => {
          const done = [];
          const name = me ? (S.chatTwitch ? me.login : '') : (S.chatTwitchName || '').trim();
          if (name && host.readChat('twitch', name)) done.push(`Twitch #${name.replace(/^#/, '')}`);
          if (S.chatYoutube.trim() && host.readChat('youtube', S.chatYoutube)) done.push('YouTube');
          if (S.chatTiktok.trim() && host.readChat('tiktok', S.chatTiktok)) done.push('TikTok');
          S.chatsNote = done.length ? `Reading ${done.join(', ')}. A chat that isn’t live yet waits for the stream to start.` : 'Pick at least one chat first.';
          say(S.chatsNote);
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
      overview: 'natural neural voices, or your computer’s own',
      render: (redraw) => {
        const engine = host.settings.engine;
        const pick = (value) => {
          const radio = document.querySelector(`input[name="engine"][value="${value}"]`);
          if (radio && !radio.checked) { radio.checked = true; radio.dispatchEvent(new Event('change', { bubbles: true })); }
          say(value === 'kokoro' ? 'Neural voices picked. They load in the background.' : 'System voices picked.');
          redraw();
        };
        const status = h('p', { class: 'hint', 'aria-live': 'off' });
        const updateStatus = () => {
          const v = host.voiceStatus();
          status.textContent = v.text ? `Voices: ${v.text}` : '';
        };
        updateStatus();
        clearInterval(voiceTimer);
        voiceTimer = setInterval(() => { if (dialog.open && steps()[index] && steps()[index].id === 'voice') updateStatus(); else clearInterval(voiceTimer); }, 700);
        return [
          UI.lead('Every chatter gets a voice of their own from a pool, and keeps it, so you can tell people apart by ear.'),
          h('div', { class: 'setup-choices', role: 'group', 'aria-label': 'Voice engine' },
            choiceCard(engine === 'kokoro', 'Neural voices', 'The most natural. They run on this computer, in English. The model downloads once (around 90 MB), then loads from the cache.', () => pick('kokoro')),
            choiceCard(engine === 'system', 'System voices', 'Built into your computer. They start instantly and cover many languages, including the ones your screen reader uses.', () => pick('system'))),
          status,
          engine === 'system' ? mirror('systemLang', 'Language', 'Which language’s voices go in the pool.') : null,
          mirror('varyVoices', 'Vary pitch and pace a little per chatter', 'Makes chatters easier to tell apart when several share a voice.'),
          UI.row(sampleButton('Hi chat! This is how your messages will sound.')),
          sampleNote(),
          h('p', { class: 'hint' }, 'Reader → Voices has the full list, to choose which voices are in the pool. To give one chatter a different voice, open their name in the chat list.'),
        ];
      },
    },

    {
      id: 'speed',
      label: 'Speed & volume',
      title: 'Speed and volume',
      overview: 'how fast and how loud chat is read',
      render: () => [
        UI.lead('If you’re used to a fast screen reader, turn the speed up. Both can also be changed any time from the Dashboard, or with the volume shortcuts.'),
        mirror('rate', 'Speed'),
        mirror('volume', 'Volume'),
        UI.row(sampleButton('This is how fast and how loud chat will be read.')),
        sampleNote(),
      ],
    },

    {
      id: 'reading',
      label: 'What’s read',
      title: 'What gets read out',
      overview: 'names, replies, emotes, and what to leave out',
      render: () => [
        UI.lead('How each message is said, and what’s skipped. The defaults suit most streams.'),
        UI.section('Each message',
          mirror('nameFormat', 'Say the chatter’s name'),
          mirror('collapseNames', 'Don’t repeat the name for back-to-back messages from the same chatter'),
          mirror('quoteParent', 'For replies, also read the message being replied to'),
          mirror('readEvents', 'Read subs, raids and gifts'),
          mirror('readAnnouncements', 'Read announcements (the highlighted messages mods post with /announce)'),
          mirror('readEmojis', 'Read emojis'),
          mirror('emoteMode', 'Emotes')),
        UI.section('Keeping up with a busy chat',
          mirror('maxLength', 'Cut long messages after this many characters'),
          mirror('catchUp', 'Skip old messages when more than this many are waiting', '0 reads everything, however far behind it gets.'),
          mirror('replay', 'Let me hear messages again after they were read', 'The replay shortcut goes back one message per press.')),
        UI.section('Leave out',
          mirror('skipCommands', 'Bot commands (messages starting with !)'),
          mirror('skipLinks', 'Messages with links'),
          mirror('ignoredUsers', 'Chatters never to read', 'Usernames separated by commas, for example other bots.')),
        h('p', { class: 'hint' }, 'More under Reader → Reading, Nicknames and Filters.'),
      ],
    },

    {
      id: 'viewers',
      label: 'Viewer controls',
      title: 'What viewers can change',
      overview: 'let chat pick its own voices',
      render: () => [
        UI.lead('Viewers can pick their own voice by typing a command in chat, and your mods can pause or skip the reader for you.'),
        mirror('voiceCommandWho', `Who can pick their own voice with ${host.settings.voiceCommand || '!voice'}`),
        mirror('voiceConfirm', 'Say “… now sounds like this” in the new voice'),
        mirror('modCommandWho', `Who can control the reader with ${host.settings.modCommand || '!tts'}`, 'For example “!tts skip”, “!tts pause” or “!tts volume 40”. You, as the broadcaster, always can unless it’s set to Nobody.'),
        mirror('cheerAnnounce', 'Say who cheered and how many bits'),
        h('p', { class: 'hint' }, 'Reader → Viewer controls has the rest: the command names, voice effects for bits, and channel point rewards.'),
      ],
    },

    {
      id: 'keys',
      label: 'Shortcuts',
      title: 'Shortcuts that work in-game',
      overview: 'control the reader without leaving your game',
      render: (redraw) => {
        const keys = host.settings.keys || {};
        const names = [['pause', 'Pause / resume'], ['skip', 'Skip the message'], ['replay', 'Hear the last one again'], ['volumeUp', 'Volume up'], ['volumeDown', 'Volume down'], ['clear', 'Clear what’s waiting'], ['toggleWindow', 'Show or hide this window']];
        const global = { on: !!host.settings.globalHotkeys };
        const box = UI.check(global, 'on', 'Let these work while another app (a game, Discord) is focused', {
          onChange: (on) => {
            const real = document.getElementById('globalHotkeys');
            if (real && real.checked !== on) { real.checked = on; real.dispatchEvent(new Event('change', { bubbles: true })); }
            redraw();
          },
        });
        return [
          UI.lead(`Control the reader without leaving your game. Every one can be changed under App → Shortcuts${Bot.enabled() ? ' & API, where you can also give the bot’s own effects a hotkey' : ''}.`),
          h('dl', { class: 'setup-keys' }, names.filter(([k]) => keys[k] !== undefined).flatMap(([k, label]) => [
            h('dt', {}, h('kbd', {}, host.keyLabel(keys[k]) || 'none')), h('dd', {}, label)])),
          box,
          mirror('mediaKeys', 'Use the keyboard’s media keys too: play/pause pauses, next skips and previous replays'),
          window.chatReaderDesktop.platform === 'darwin' ? h('p', { class: 'hint' }, 'On macOS, the media keys need the app allowed under System Settings → Privacy & Security → Accessibility. App → Shortcuts has a button that asks for it.') : null,
        ];
      },
    },

    {
      id: 'bot',
      label: 'Bot tools (beta)',
      title: 'Bot and stream tools (beta)',
      overview: 'optional: a Twitch bot, alerts and an OBS overlay',
      render: (redraw) => [
        UI.lead('Optional. Chat Reader can also run a Twitch bot and stream tools. They’re new and still in beta, so they’re off unless you turn them on. You don’t need them to have chat read out loud.'),
        Bot.shell.botSwitch({ where: 'setup', onChange: () => redraw() }),
        h('ul', { class: 'bot-steps' }, Bot.shell.FEATURES.map(([name, text]) => h('li', {}, h('strong', {}, name), `: ${text}.`))),
        h('p', { class: 'hint' }, Bot.enabled()
          ? `Turned on. The next ${steps().filter((s) => s.bot).length} steps set up your Twitch login, OBS and a few starter alerts.`
          : 'Left off, the next step is the last. You can turn this on later under App → Bot tools.'),
      ],
    },

    {
      id: 'app',
      bot: true,
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
      bot: true,
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
      id: 'obs',
      bot: true,
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
                say(S.alertNote);
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
      id: 'starter',
      bot: true,
      label: 'Head start',
      title: 'A head start',
      render: (redraw) => [
        UI.lead('Pick what to start with. It’s all added as ordinary events you can change or delete under Bot → Events.'),
        UI.check(S.starter, 'alerts', 'Alerts on stream for follows, subs, gifted subs, cheers and raids'),
        UI.check(S.starter, 'raidThanks', 'Thank raiders in chat: “Thanks for the raid, @name!”'),
        UI.check(S.starter, 'followSpeak', 'Say new followers out loud with the reader'),
        UI.check(S.starter, 'points', 'Loyalty points for watching (1 a minute, !points to check)'),
        UI.row(UI.button('Add these', () => { S.starterNote = addStarter(); say(S.starterNote); redraw(); }, { cls: 'btn small primary' })),
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
        const voice = host.voiceStatus();
        const items = [
          ['Reading chat', host.readerChats().length > 0, 'dashboard'],
          [voice.text ? `Voice: ${voice.text}` : 'Voice', voice.state !== 'error', 'voices'],
          ...(Bot.enabled() ? [
            ['Twitch application', looksLikeClientId(Bot.data.clientId), 'account'],
            [Bot.twitch.loggedIn() ? `Logged in as ${Bot.twitch.accounts.streamer.displayName}` : 'Logged in to Twitch', Bot.twitch.loggedIn(), 'account'],
            ['Overlay in OBS', !!(Bot.overlayStatus && Bot.overlayStatus.clients), 'overlay'],
            ['OBS remote control', Bot.obs.state === 'connected', 'obs'],
          ] : []),
        ];
        return [
          UI.lead('Here’s where things stand. Anything not done yet can be finished in its section; a dot next to a section in the sidebar shows when something there needs you.'),
          h('ul', { class: 'setup-summary' }, items.map(([text, ok, page]) => h('li', {},
            h('span', { class: `setup-mark${ok ? ' ok' : ''}`, 'aria-hidden': 'true' }, ok ? '✓' : '–'),
            h('span', {}, text, h('span', { class: 'sr-only' }, ok ? ', done' : ', not yet')),
            ok ? null : UI.button('Set up', () => goTo(page), { cls: 'link', aria: `Set up: ${text}` })))),
          UI.section('Where to next',
            h('ul', { class: 'bot-steps' },
              h('li', {}, h('strong', {}, 'Dashboard'), ': the chats to read, pause and skip, and what’s being read now.'),
              h('li', {}, h('strong', {}, 'Nicknames'), ': have a chatter’s name said the way you want.'),
              h('li', {}, h('strong', {}, 'Screen reader'), ', under Accessibility: reads text from parts of the screen out loud, for games that don’t.'),
              ...(Bot.enabled() ? [
                h('li', {}, h('strong', {}, 'Commands'), ': your own !commands, with cooldowns and who may use them.'),
                h('li', {}, h('strong', {}, 'Timers'), ': a message every so often, only while chat is active.'),
                h('li', {}, h('strong', {}, 'Multistream'), ': join your Twitch, YouTube and TikTok chats together.'),
              ] : [
                h('li', {}, h('strong', {}, 'Bot tools (beta)'), ', under App: a Twitch bot, alerts and an OBS overlay, if you want them later.'),
              ]))),
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
  const next = UI.button('Next', () => (index === steps().length - 1 ? finish() : show(index + 1)), { cls: 'btn small primary' });
  const close = UI.button('✕', () => finish(), { cls: 'x close-btn', aria: 'Close the setup guide' });

  dialog.append(h('div', { class: 'dialog-box' },
    h('header', { class: 'dialog-head setup-head' }, h('div', {}, counter, title), close),
    h('div', { class: 'setup-main' }, progress, body),
    h('footer', { class: 'bot-editor-foot setup-foot' },
      UI.button('Skip the guide', () => finish(), { cls: 'link setup-quit' }),
      back, skip, next)));

  // A control's name for finding it again after a redraw: its id when it has
  // a lasting one, else its label or text.
  const keyOf = (el) => (el.id && !/^bot-f\d+$/.test(el.id) ? `#${el.id}` : el.getAttribute('aria-label') || el.textContent);

  function draw() {
    const list = steps();
    index = Math.max(0, Math.min(list.length - 1, index));
    const step = list[index];
    // The heading is where each step starts, so it says which step it is.
    title.replaceChildren(step.title, h('span', { class: 'sr-only' }, `, step ${index + 1} of ${list.length}`));
    counter.textContent = `Step ${index + 1} of ${list.length}`;
    counter.setAttribute('aria-hidden', 'true');
    progress.replaceChildren(...list.map((s, i) => {
      const done = !!(s.done && s.done());
      return h('li', {},
        h('button', {
          type: 'button',
          class: 'setup-dot',
          'data-state': i === index ? 'current' : done ? 'done' : i < index ? 'seen' : '',
          'aria-current': i === index ? 'step' : null,
          onclick: () => show(i),
        },
        h('span', { class: 'setup-dot-mark', 'aria-hidden': 'true' }, done ? '✓' : String(i + 1)),
        h('span', {}, s.label),
        done ? h('span', { class: 'sr-only' }, ', done') : null));
    }));

    // Redrawing replaces every control; keep the caret where it was.
    const focused = body.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = focused && keyOf(focused);
    const scroll = body.scrollTop;
    try {
      body.replaceChildren(...[step.render(redraw)].flat().filter(Boolean));
    } catch (err) {
      console.error(err);
      body.replaceChildren(h('p', { class: 'warn' }, `Something went wrong drawing this step: ${err.message}`));
    }
    body.scrollTop = scroll;
    if (focusKey) {
      const again = [...body.querySelectorAll('button, input, select, textarea')].find((x) => keyOf(x) === focusKey);
      if (again) again.focus();
    }

    back.hidden = index === 0;
    skip.hidden = index === 0 || index === list.length - 1 || (step.done && step.done());
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
  for (const type of ['accounts', 'login', 'logout', 'obs', 'overlay', 'enabled']) Bot.on(type, redraw);

  function show(i) {
    index = Math.max(0, Math.min(steps().length - 1, i));
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
    const at = steps().findIndex((s) => s.id === step);
    if (!dialog.open) dialog.showModal();
    show(at === -1 ? 0 : at);
  };
  Setup.steps = steps;

  // App → Setup guide: open it again, from the start or at any step.
  UI.addTab('setupGuide', 'Setup guide', (panel) => {
    panel.append(
      UI.row(UI.button('Start the setup guide', () => Setup.open(), { cls: 'btn small primary' })),
      UI.section('Or go straight to a step',
        h('ul', { class: 'bot-steps' }, steps().filter((s) => s.id !== 'welcome').map((s) => h('li', {},
          UI.button(s.title, () => Setup.open(s.id), { cls: 'link' }),
          s.overview ? h('span', { class: 'hint' }, ` (${s.overview})`) : null)))));
  }, { listens: ['enabled'] });
})();
