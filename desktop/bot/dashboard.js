'use strict';

// The Dashboard's side column, next to the reader's player and chat: how
// everything is doing at a glance, chat and TTS in one box, quick actions,
// what happened on stream, and the stream's title and category. Each part
// is a tab of its own, so a busy chat redraws only the part that changed.

(() => {
  const h = UI.h;
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const PLATFORM_NAMES = { twitch: 'Twitch', youtube: 'YouTube', tiktok: 'TikTok' };
  const head = (text, ...extra) => h('div', { class: 'dash-head' }, h('h3', { class: 'sub-head' }, text), ...extra);

  // -------------------------------------------------------------------------
  // At a glance: a card per thing that can be on, off or broken. A click
  // opens its page. The cards are updated in place, so one being clicked
  // isn't swapped out from under the pointer.
  // -------------------------------------------------------------------------

  const CARDS = [
    { id: 'reader', title: 'Reader', page: 'voices' },
    { id: 'chats', title: 'Chats', page: '' },
    { id: 'twitch', title: 'Twitch', page: 'account' },
    { id: 'events', title: 'Twitch events', page: 'events' },
    { id: 'multistream', title: 'Multistream', page: 'multistream' },
    { id: 'overlay', title: 'Overlay', page: 'overlay' },
    { id: 'obs', title: 'OBS', page: 'obs' },
    { id: 'spotify', title: 'Song requests', page: 'spotify' },
  ];

  function cardState(id) {
    const host = Bot.host;
    if (id === 'reader') {
      const r = host.state();
      const voice = host.voiceStatus();
      const value = r.paused ? 'Paused' : r.speaking ? 'Reading' : 'Waiting for chat';
      return { value, detail: `${plural(r.waiting, 'message')} waiting · ${voice.text}`, state: voice.state === 'error' ? 'error' : r.paused ? 'off' : r.speaking ? 'on' : '' };
    }
    if (id === 'chats') {
      const list = host.readerChats();
      const on = list.filter((c) => c.state === 'connected');
      const bad = list.filter((c) => c.state === 'error');
      if (!list.length) return { value: 'None open', detail: 'Enter a channel at the top and press Connect', state: 'off' };
      return {
        value: `${on.length} of ${list.length} connected`,
        detail: list.map((c) => `${PLATFORM_NAMES[c.platform]} ${c.platform === 'twitch' ? '#' : ''}${c.target}`).join(', '),
        state: bad.length ? 'error' : on.length === list.length ? 'on' : 'connecting',
      };
    }
    if (id === 'twitch') {
      const me = Bot.twitch.accounts.streamer;
      if (!me) return { value: 'Not logged in', detail: 'Log in for commands, alerts and the rest', state: 'off' };
      const s = UI.lastStream;
      return {
        value: me.displayName,
        detail: Bot.community.live && s ? `Live · ${s.viewer_count} watching · ${Bot.duration((Date.now() - Date.parse(s.started_at)) / 1000)}` : 'Offline',
        state: Bot.community.live ? 'on' : '',
      };
    }
    if (id === 'events') {
      const es = Bot.eventsub.state;
      return {
        value: { connected: 'Receiving', connecting: 'Connecting…', error: 'Problem', idle: 'Off' }[es] || '',
        detail: Bot.eventsub.text || (Bot.twitch.loggedIn() ? '' : 'Starts once you log in'),
        state: es === 'connected' ? 'on' : es === 'error' ? 'error' : es === 'connecting' ? 'connecting' : '',
      };
    }
    if (id === 'multistream') {
      const c = Bot.data.multistream;
      if (!c.enabled) return { value: 'Off', detail: 'Join Twitch, YouTube and TikTok chat', state: '' };
      const stats = Bot.relay.stats;
      const errors = Object.entries(stats).filter(([, x]) => x.error);
      const sent = Object.values(stats).reduce((n, x) => n + x.sent, 0);
      const joined = ['twitch', c.youtube.trim() ? 'youtube' : '', c.tiktok.trim() ? 'tiktok' : ''].filter(Boolean);
      return {
        value: `${joined.length} chats joined`,
        detail: errors.length ? `${PLATFORM_NAMES[errors[0][0]]}: ${errors[0][1].error}` : `${plural(sent, 'message')} relayed`,
        state: errors.length ? 'error' : 'on',
      };
    }
    if (id === 'overlay') {
      const o = Bot.overlayStatus || {};
      return { value: o.running ? `${plural(o.clients || 0, 'overlay')} open` : 'Off', detail: o.error || (o.running ? 'Add it to OBS as a Browser source' : ''), state: o.error ? 'error' : o.running && o.clients ? 'on' : '' };
    }
    if (id === 'obs') {
      const st = Bot.obs.state;
      return { value: { connected: 'Connected', connecting: 'Connecting…', error: 'Not connected', idle: Bot.data.obs.enabled ? 'Not connected' : 'Off' }[st], detail: st === 'error' ? Bot.obs.text : '', state: st === 'connected' ? 'on' : st === 'error' ? 'error' : '' };
    }
    if (id === 'spotify') {
      const sp = Bot.spotify;
      const waiting = plural(Bot.data.spotify.queue.length, 'request');
      if (sp.state === 'connected') {
        const n = sp.now;
        return { value: n ? n.name : 'Nothing playing', detail: sp.problem || `${n && !n.isPlaying ? 'Paused · ' : ''}${waiting} waiting${Bot.data.spotify.requests ? '' : ' · closed'}`, state: sp.problem ? 'error' : n && n.isPlaying ? 'on' : '' };
      }
      return { value: sp.state === 'connecting' ? 'Connecting…' : sp.state === 'error' ? 'Not connected' : 'Off', detail: sp.state === 'error' ? sp.text : 'Connect Spotify for !sr', state: sp.state === 'error' ? 'error' : '' };
    }
    return { value: '', detail: '', state: '' };
  }

  UI.addTab('dash-status', 'At a glance', (panel) => {
    const nodes = new Map();
    const grid = h('div', { class: 'dash-cards' });
    for (const card of CARDS) {
      const value = h('span', { class: 'bot-card-value' });
      const detail = h('span', { class: 'hint' });
      const button = h('button', {
        type: 'button', class: 'bot-card dash-card',
        onclick: () => {
          if (card.page) { Bot.shell.show(card.page); return; }
          const field = document.querySelector('#chatFields input');
          if (field) field.focus();
        },
      }, h('span', { class: 'bot-card-title' }, card.title), value, detail);
      nodes.set(card.id, { button, value, detail, card });
      grid.append(button);
    }
    panel.append(head('At a glance'), grid);
    const update = () => {
      for (const [id, n] of nodes) {
        const s = cardState(id);
        n.value.textContent = s.value;
        n.detail.textContent = s.detail;
        n.button.dataset.state = s.state;
        n.button.setAttribute('aria-label', `${n.card.title}: ${s.value}${s.detail ? `. ${s.detail}` : ''}. ${n.card.page ? 'Open its page.' : 'Go to the chats.'}`);
      }
    };
    update();
    UI.tab('dash-status').update = update;
  });

  let statusTimer = null;
  const refreshStatus = () => {
    const tab = UI.tab('dash-status');
    if (!tab || !tab.update || !UI.isShown(tab) || statusTimer) return;
    statusTimer = setTimeout(() => { statusTimer = null; if (UI.isShown(tab)) tab.update(); }, 200);
  };
  for (const type of ['reader', 'stream', 'live', 'eventsub', 'accounts', 'obs', 'overlay', 'relay', 'spotify', 'spotify-queue', 'spotify-now']) Bot.on(type, refreshStatus);
  // The uptime moves on by itself.
  setInterval(refreshStatus, 30000);

  // -------------------------------------------------------------------------
  // Chat and TTS: one box for writing in chat (on Twitch, or every chat of
  // the multistream) or saying something with the reader's voice.
  // -------------------------------------------------------------------------

  const draft = { text: '', as: '', to: 'twitch' };

  UI.addTab('dash-chat', 'Say something', (panel) => {
    const me = Bot.twitch.accounts.streamer;
    const ms = Bot.data.multistream;
    if (!draft.as) draft.as = Bot.twitch.chatRole();
    if (!ms.enabled) draft.to = 'twitch';
    const status = UI.status();
    const input = UI.text(draft, 'text', { placeholder: me ? 'Write in chat, or have the reader say it' : 'Have the reader say something', maxlength: 500 });
    input.setAttribute('aria-label', 'Message');

    const send = me ? UI.button('Send', (e) => UI.busy(e.currentTarget, async () => {
      const text = draft.text.trim();
      if (!text) return;
      if (draft.to === 'all') {
        const where = await Bot.relay.broadcast(text, { as: draft.as });
        UI.say(status, `Sent to ${where.map((p) => PLATFORM_NAMES[p]).join(', ')}.`);
      } else {
        await Bot.twitch.say(text, { as: draft.as });
        UI.say(status, '');
      }
      draft.text = '';
      input.value = '';
      input.focus();
    }, status), { cls: 'btn small primary', title: 'Send it in chat (Enter)' }) : null;

    const speak = UI.button('🗣 Say it', () => {
      const text = draft.text.trim();
      if (!text) { input.focus(); return; }
      Bot.host.speak(text, { priority: true, label: 'You' });
      draft.text = '';
      input.value = '';
      UI.say(status, 'The reader says it next.');
      input.focus();
    }, { title: me ? 'Read it out loud with the reader’s voice instead (Shift+Enter)' : 'Read it out loud (Enter)' });

    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      (send && !e.shiftKey ? send : speak).click();
    });

    const options = me ? h('div', { class: 'dash-chat-opts' },
      Bot.twitch.accounts.bot ? UI.select(draft, 'as', [['bot', `as ${Bot.twitch.accounts.bot.displayName}`], ['streamer', `as ${me.displayName}`]], { label: 'Send as' }) : null,
      ms.enabled ? UI.select(draft, 'to', [['twitch', 'in Twitch chat'], ['all', 'in every chat']], { label: 'Where to send it' }) : null) : null;

    panel.append(
      head('Chat and TTS'),
      h('div', { class: 'bot-chat-send' }, input, send, speak),
      options,
      status,
    );
  }, { listens: ['accounts'] });

  // -------------------------------------------------------------------------
  // Quick actions
  // -------------------------------------------------------------------------

  UI.addTab('dash-actions', 'Quick actions', (panel) => {
    const me = Bot.twitch.accounts.streamer;
    const status = UI.status();
    const act = (label, fn, opts = {}) => UI.button(label, (e) => UI.busy(e.currentTarget, async () => { await fn(); UI.say(status, `${label}: done.`); }, status), opts);
    const ad = { seconds: '60' };
    const raffle = Bot.games.raffle;
    panel.append(head('Quick actions'));
    if (me) {
      panel.append(h('div', { class: 'bot-actions' },
        h('span', { class: 'bot-inline' }, UI.select(ad, 'seconds', [['30', '30 s'], ['60', '60 s'], ['90', '90 s'], ['120', '2 min'], ['180', '3 min']], { label: 'Ad length' }), act('Run ad', () => Bot.twitch.commercial(Number(ad.seconds)))),
        act('Marker', () => Bot.twitch.marker('from Chat Reader')),
        act('Clip', async () => {
          const res = await Bot.twitch.clip(false);
          const clip = res.data && res.data[0];
          if (clip) Bot.addActivity({ kind: 'note', text: `Clip: https://clips.twitch.tv/${clip.id}` });
        }),
        act(raffle.open ? `Draw raffle (${raffle.entries.size})` : 'Open raffle', () => Bot.games.raffleAction(raffle.open ? 'draw' : 'start'))));
    }
    panel.append(h('div', { class: 'bot-actions' },
      act('Test alert', () => Bot.effects.run([{ ...Bot.effects.newEffect('alert'), title: 'Test alert', message: 'The overlay works!' }], UI.testContext())),
      act('Clear overlay', () => Bot.effects.run([Bot.effects.newEffect('overlayClear')], UI.testContext()))));
    if (Bot.data.lists.length) {
      panel.append(h('div', { class: 'bot-actions' }, h('span', { class: 'hint' }, 'Effect lists:'), Bot.data.lists.map((l) => act(`▶ ${l.name}`, () => Bot.lists.run(l.id)))));
    }
    if (!me) panel.append(h('p', { class: 'hint' }, 'Ads, markers, clips and raffles need you logged in under ', UI.button('Accounts', () => Bot.shell.show('account'), { cls: 'link' }), '.'));
    panel.append(status);
  }, { listens: ['accounts', 'raffle'] });

  // -------------------------------------------------------------------------
  // What happened on stream, and the log
  // -------------------------------------------------------------------------

  UI.addTab('dash-activity', 'Activity', (panel) => {
    const items = Bot.activity.slice(0, 80);
    panel.append(head('Activity'),
      items.length ? h('ul', { class: 'bot-activity' }, items.map((a) => h('li', { 'data-kind': a.kind },
        h('time', {}, UI.time(a.at)),
        h('span', { class: 'bot-activity-text' }, a.text, a.simulated ? h('span', { class: 'pill' }, 'test') : null),
        a.replay ? UI.button('↻', () => a.replay(), { cls: 'x', aria: `Run the effects for “${a.text}” again`, title: 'Run its effects again' }) : null,
      ))) : h('p', { class: 'hint bot-empty' }, 'Follows, subs, raids, redemptions and the rest show up here as they happen. Try them under Events.'));

    const lines = Bot.logLines.slice(-60).reverse();
    const errors = lines.filter((l) => l.level === 'error').length;
    panel.append(h('details', { class: 'bot-log', open: errors > 0 && UI.logOpen ? true : null, ontoggle: (e) => { UI.logOpen = e.currentTarget.open; } },
      h('summary', {}, `Log${errors ? ` · ${plural(errors, 'problem')}` : ''}`),
      lines.length ? h('ul', {}, lines.map((l) => h('li', { 'data-level': l.level }, h('time', {}, UI.time(l.at)), ' ', l.text))) : h('p', { class: 'hint' }, 'Nothing logged.')));
  }, { listens: ['activity', 'log'] });

  // -------------------------------------------------------------------------
  // The stream's title and category
  // -------------------------------------------------------------------------

  UI.addTab('dash-stream', 'Stream', (panel) => {
    const me = Bot.twitch.accounts.streamer;
    if (!me) return;
    const info = { title: '', game: '' };
    const status = UI.status();
    const title = UI.text(info, 'title', { maxlength: 140, placeholder: 'Stream title' });
    const listId = 'botCategoryList';
    const list = h('datalist', { id: listId });
    const game = UI.text(info, 'game', { list: listId, placeholder: 'Category' });
    let searchTimer = null;
    game.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(async () => {
        try {
          const found = await Bot.twitch.searchCategories(game.value);
          list.replaceChildren(...found.map((c) => h('option', { value: c.name })));
        } catch {}
      }, 300);
    });
    Bot.twitch.channel().then((ch) => {
      if (!ch) return;
      if (document.activeElement !== title) { title.value = ch.title; info.title = ch.title; }
      if (document.activeElement !== game) { game.value = ch.game_name; info.game = ch.game_name; }
    }).catch((err) => UI.say(status, err.message, true));
    const saveInfo = UI.button('Save', (e) => UI.busy(e.currentTarget, async () => {
      const fields = { title: info.title.trim().slice(0, 140) };
      if (info.game.trim()) {
        const cat = await Bot.twitch.findCategory(info.game);
        if (!cat) throw new Error(`There’s no category called “${info.game}”`);
        fields.game_id = cat.id;
      }
      await Bot.twitch.updateChannel(fields);
      UI.say(status, 'Saved.');
    }, status), { cls: 'btn small primary' });
    panel.append(head('Stream'), UI.field('Title', title), UI.field('Category', h('div', {}, game, list)), h('div', { class: 'bot-actions' }, saveInfo), status);
  }, { listens: ['accounts'] });
})();
