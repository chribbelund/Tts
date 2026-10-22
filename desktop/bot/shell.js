'use strict';

// One window for the reader and the bot. The sections run down the side,
// grouped by what they're for rather than by which half of the app they came
// from: the Dashboard first (the player and chat, with the stream next to
// them), then the reader, the bot, the community, the stream and the app.
//
// The reader's settings are the same sections the website shows in its
// Settings dialog: they're moved out of it into pages here, with their
// controls and listeners as they were. A page can hold a reader section and
// a bot tab together, like Shortcuts (the reader's keys, then the bot's).

(() => {
  const h = UI.h;
  const Shell = Bot.shell = { current: '', pages: [], byId: new Map(), navButtons: new Map() };

  // Which page a section of the website's Settings dialog lands on.
  const READER_TABS = {
    display: 'display', voices: 'voices', reading: 'reading', nicknames: 'nicknames', filters: 'filters',
    viewers: 'viewer-controls', keys: 'shortcuts', backup: 'backup',
  };

  // Pages, in order. A part is 'reader:<settings tab>' or 'tab:<bot tab id>';
  // a page that's a single bot tab is given as its id.
  const LAYOUT = [
    { group: '', pages: [{ id: 'dashboard', label: 'Dashboard' }] },
    {
      group: 'Reader',
      pages: [
        { id: 'voices', label: 'Voices', parts: ['reader:voices'], lead: 'How chat sounds: the voice engine, the voices chatters get, and how much they vary.' },
        { id: 'reading', label: 'Reading', parts: ['reader:reading'], lead: 'What’s read out and how: names, replies, emotes, events and replays.' },
        { id: 'nicknames', label: 'Nicknames', parts: ['reader:nicknames'] },
        { id: 'filters', label: 'Filters', parts: ['reader:filters'], lead: 'What the reader leaves out. The bot’s moderation, under Community, can delete or time out messages too.' },
        { id: 'viewer-controls', label: 'Viewer controls', parts: ['reader:viewers', 'tab:readerLinks'], lead: 'Bits, channel points and chat commands that change how chat is read.' },
      ],
    },
    {
      group: 'Accessibility',
      pages: [{ id: 'screen', label: 'Screen reader', parts: ['tab:screen'], lead: 'Reads text from anywhere on the screen out loud, without following the mouse, so it works in games that lock the mouse in the middle.' }],
    },
    { group: 'Bot', pages: ['commands', 'events', 'rewards', 'timers', 'lists', 'counters'] },
    { group: 'Community', pages: ['viewers', 'points', 'quotes', 'moderation'] },
    { group: 'Stream', pages: ['multistream', 'overlay', 'obs', 'spotify'] },
    {
      group: 'App',
      pages: [
        { id: 'guide', label: 'Setup guide', parts: ['tab:setupGuide'], lead: 'A step-by-step walk through the app: how it looks, the chats, the voice and what’s read, shortcuts, and the bot tools if you want them.' },
        { id: 'bot-tools', label: 'Bot tools (beta)', parts: ['tab:botTools'], lead: 'A Twitch bot and stream tools, on top of the chat reader. Off unless you turn it on.' },
        { id: 'account', label: 'Accounts', parts: ['tab:account'], lead: 'Your Twitch logins, and how the bot behaves in chat.' },
        { id: 'shortcuts', label: 'Shortcuts & API', parts: ['reader:keys', 'tab:hotkeys'] },
        { id: 'display', label: 'Display', parts: ['reader:display'] },
        { id: 'backup', label: 'Backup & import', parts: ['reader:backup', 'tab:import'] },
      ],
    },
  ];

  // The dashboard's side column, top to bottom (dashboard.js).
  const DASH_PARTS = ['dash-status', 'dash-chat', 'dash-actions', 'dash-activity', 'dash-stream'];

  // What only shows while the bot is on (Bot.enabled()): whole groups, whole
  // pages, and the bot's parts of pages the reader shares. The dashboard's
  // side column goes too.
  const BOT_GROUPS = new Set(['Bot', 'Community', 'Stream']);
  const BOT_PAGES = new Set(['account']);
  const BOT_PARTS = new Set(['tab:readerLinks', 'tab:hotkeys', 'tab:import']);

  function buildPages() {
    const placed = new Set();
    for (const { group, pages } of LAYOUT) {
      for (const p of pages) {
        const spec = typeof p === 'string' ? { id: p, parts: [`tab:${p}`] } : p;
        const parts = (spec.parts || []).filter((part) => !part.startsWith('tab:') || UI.tab(part.slice(4)));
        if (spec.id !== 'dashboard' && !parts.length) continue;
        const firstTab = parts.find((part) => part.startsWith('tab:'));
        const page = { ...spec, group, parts, label: spec.label || (firstTab ? UI.tab(firstTab.slice(4)).label : spec.id), bot: BOT_GROUPS.has(group) || BOT_PAGES.has(spec.id) };
        for (const part of parts) if (part.startsWith('tab:')) placed.add(part.slice(4));
        Shell.pages.push(page);
        Shell.byId.set(page.id, page);
      }
    }
    for (const id of DASH_PARTS) placed.add(id);
    // A tab no page names yet still gets one, under Bot.
    for (const tab of UI.tabs) {
      if (placed.has(tab.id)) continue;
      const page = { id: tab.id, label: tab.label, group: 'Bot', parts: [`tab:${tab.id}`], bot: true };
      const lastBot = Shell.pages.map((x) => x.group).lastIndexOf('Bot');
      Shell.pages.splice(lastBot + 1, 0, page);
      Shell.byId.set(page.id, page);
    }
  }

  // ---------------------------------------------------------------------------
  // The window
  // ---------------------------------------------------------------------------

  Shell.init = () => {
    buildPages();
    document.body.classList.add('has-shell');

    const main = document.querySelector('main.layout');
    const nav = h('nav', { class: 'app-nav', 'aria-label': 'Sections' });
    const pagesBox = h('div', { class: 'app-pages', hidden: true });
    const view = h('div', { class: 'app-view' });
    const shell = h('div', { class: 'app-shell' }, nav, view);
    main.before(shell);
    view.append(main, pagesBox);
    Shell.el = { shell, nav, view, main, pagesBox };

    // The nav: a heading per group, a button per page.
    let list = null;
    Shell.groups = new Map();
    for (const page of Shell.pages) {
      if (!list || list.dataset.group !== page.group) {
        list = h('ul', { class: 'app-nav-list', 'data-group': page.group, 'aria-labelledby': page.group ? `nav-${page.group.toLowerCase()}` : null });
        const head = page.group ? h('h2', { class: 'app-nav-head', id: `nav-${page.group.toLowerCase()}` }, page.group) : null;
        if (head) nav.append(head);
        nav.append(list);
        Shell.groups.set(page.group, { head, list });
      }
      const button = h('button', { type: 'button', class: 'app-nav-btn', 'data-page': page.id, onclick: () => Shell.show(page.id) },
        h('span', { class: 'app-nav-label' }, page.label),
        h('span', { class: 'app-nav-dot', 'aria-hidden': 'true' }));
      Shell.navButtons.set(page.id, button);
      list.append(h('li', {}, button));
    }
    nav.addEventListener('keydown', navKeys);

    // The pages. The dashboard is the reader's own player and chat, with the
    // stream's side column next to them.
    for (const page of Shell.pages) {
      if (page.id === 'dashboard') { buildDashboard(main); continue; }
      page.el = h('section', { class: 'app-page', id: `page-${page.id}`, 'aria-labelledby': `page-${page.id}-title`, hidden: true },
        h('header', { class: 'app-page-head' },
          h('h2', { id: `page-${page.id}-title` }, page.label),
          page.lead ? h('p', { class: 'hint' }, page.lead) : null));
      for (const part of page.parts) page.el.append(partBox(part));
      pagesBox.append(page.el);
    }

    // The reader's Settings button and dialog aren't needed: every section
    // of it is a page here. js/app.js asks for them through this.
    Bot.host.showSettings = (tab) => Shell.show(READER_TABS[tab] || Shell.lastReaderPage || 'voices');
    const settingsBtn = document.getElementById('settingsBtn');
    if (settingsBtn) settingsBtn.hidden = true;
    // The website's wording is about a browser.
    const backupHint = document.querySelector('#panel-backup > .hint');
    if (backupHint) backupHint.textContent = 'Everything in the app is kept on this computer. Save a copy to keep it safe or to move it to another computer; loading one replaces what’s here.';

    Shell.applyEnabled();
    Shell.show('dashboard', { focus: false });
  };

  // Shows or hides everything that belongs to the bot, after it's switched
  // on or off. Hidden parts stay in the page, just out of sight and out of
  // the keyboard order.
  Shell.applyEnabled = () => {
    if (!Shell.el) return;
    const on = Bot.enabled();
    document.body.classList.toggle('bot-off', !on);
    for (const page of Shell.pages) {
      const button = Shell.navButtons.get(page.id);
      if (button) button.parentElement.hidden = !!page.bot && !on;
    }
    for (const { head, list } of Shell.groups.values()) {
      const empty = [...list.children].every((li) => li.hidden);
      list.hidden = empty;
      if (head) head.hidden = empty;
    }
    for (const box of Shell.el.view.querySelectorAll('.bot-only')) box.hidden = !on;
    const current = Shell.byId.get(Shell.current);
    if (current && current.bot && !on) Shell.show('dashboard', { focus: false });
  };

  function partBox(part) {
    const [kind, id] = part.split(':');
    if (kind === 'reader') {
      // The same section the Settings dialog has, taken out of it.
      const panel = document.getElementById(`panel-${id}`);
      if (!panel) return h('p', { class: 'warn' }, `The reader’s ${id} settings are missing.`);
      panel.hidden = false;
      for (const attr of ['role', 'aria-labelledby', 'tabindex']) panel.removeAttribute(attr);
      panel.classList.add('page-part', 'reader-part');
      return panel;
    }
    const tab = UI.tab(id);
    const box = h('div', { class: `tab-panel page-part bot-part bot-scope${BOT_PARTS.has(part) ? ' bot-only' : ''}`, 'data-tab': id });
    UI.mount(tab, box);
    return box;
  }

  function buildDashboard(main) {
    main.classList.add('dash');
    const now = document.getElementById('nowPanel');
    const feed = main.querySelector('.feed-panel');
    const column = h('div', { class: 'dash-main' });
    now.before(column);
    column.append(now, feed);
    const side = h('aside', { class: 'dash-side bot-scope bot-only', 'aria-label': 'Stream' });
    for (const id of DASH_PARTS) {
      const tab = UI.tab(id);
      if (!tab) continue;
      const box = h('section', { class: 'dash-part', 'data-tab': id });
      UI.mount(tab, box);
      side.append(box);
    }
    main.append(side);
    Shell.byId.get('dashboard').el = main;
  }

  // ---------------------------------------------------------------------------
  // Moving between pages
  // ---------------------------------------------------------------------------

  // A page id, or a bot tab's id (it shows the page that tab is on).
  Shell.pageFor = (id) => {
    const page = Shell.byId.get(id) || Shell.pages.find((p) => p.parts && p.parts.includes(`tab:${id}`)) || null;
    // A bot page asked for while the bot is off: the page that turns it on.
    return page && page.bot && !Bot.enabled() ? Shell.byId.get('bot-tools') : page;
  };

  Shell.showing = (tabId) => {
    if (Shell.current === 'dashboard') return DASH_PARTS.includes(tabId);
    const page = Shell.byId.get(Shell.current);
    return !!page && page.parts.includes(`tab:${tabId}`);
  };

  Shell.show = (id, { focus = true } = {}) => {
    const page = Shell.pageFor(id) || Shell.byId.get('dashboard');
    const changed = Shell.current !== page.id;
    Shell.current = page.id;
    if (page.group === 'Reader') Shell.lastReaderPage = page.id;
    const dash = page.id === 'dashboard';
    Shell.el.main.hidden = !dash;
    Shell.el.pagesBox.hidden = dash;
    for (const p of Shell.pages) if (p.el && p.id !== 'dashboard') p.el.hidden = p !== page;
    for (const [pid, button] of Shell.navButtons) {
      if (pid === page.id) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    for (const tab of UI.tabs) if (UI.isShown(tab)) UI.renderTab(tab);
    if (changed) Shell.el.pagesBox.scrollTop = 0;
    const button = Shell.navButtons.get(page.id);
    if (button) button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (focus && changed && !dash && page.el && !Shell.el.nav.contains(document.activeElement)) {
      // Opened from somewhere else (a dashboard card, the voice chip): start
      // reading at the page's heading.
      const title = page.el.querySelector('h2');
      title.tabIndex = -1;
      title.focus({ preventScroll: true });
    }
    Bot.data.ui.tab = page.id;
    Bot.emit('page', page.id);
    return page;
  };

  // Up and down move through the sections; Home and End to the ends.
  function navKeys(e) {
    const buttons = [...Shell.navButtons.values()].filter((b) => !b.parentElement.hidden);
    const i = buttons.indexOf(document.activeElement);
    if (i < 0) return;
    const horizontal = document.documentElement.dataset.width === 'narrow';
    const keys = horizontal
      ? { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: buttons.length - 1 }
      : { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: buttons.length - 1 };
    const next = keys[e.key];
    if (next === undefined) return;
    e.preventDefault();
    buttons[(next + buttons.length) % buttons.length].focus();
  }

  // ---------------------------------------------------------------------------
  // Status dots on the sections that connect to something
  // ---------------------------------------------------------------------------

  Shell.status = () => {
    const out = {};
    const es = Bot.eventsub.state;
    out.account = !Bot.twitch.loggedIn() ? { state: 'off', text: 'Not logged in to Twitch' }
      : es === 'error' ? { state: 'error', text: Bot.eventsub.text }
      : es === 'connected' ? { state: 'on', text: `${Bot.twitch.accounts.streamer ? Bot.twitch.accounts.streamer.displayName : ''} · ${Bot.community.live ? 'live' : 'offline'}` }
      : es === 'connecting' ? { state: 'connecting', text: 'Connecting…' }
      // Logged in, but nothing is listening: say so rather than "connecting" forever.
      : { state: 'error', text: 'Not listening for Twitch events. Log out and in again.' };
    const o = Bot.overlayStatus || {};
    out.overlay = o.error ? { state: 'error', text: o.error } : o.running && o.clients ? { state: 'on', text: `${o.clients} open` } : null;
    out.obs = Bot.obs.state === 'connected' ? { state: 'on', text: 'Connected' } : Bot.obs.state === 'error' ? { state: 'error', text: Bot.obs.text } : null;
    const sp = Bot.spotify;
    if (sp.state === 'connected') out.spotify = sp.problem ? { state: 'error', text: sp.problem } : { state: 'on', text: `${Bot.data.spotify.queue.length} waiting` };
    else if (sp.state === 'error') out.spotify = { state: 'error', text: sp.text };
    const sr = Bot.screen;
    if (sr.status === 'watching') out.screen = sr.problem ? { state: 'error', text: sr.problem } : { state: 'on', text: `Watching ${sr.zones().filter((z) => z.enabled !== false && z.mode !== 'manual').length} zones` };
    else if (sr.status === 'error' || (Bot.data.screen.enabled && sr.problem)) out.screen = { state: 'error', text: sr.problem || 'Not working' };
    const ms = Bot.data.multistream;
    if (ms.enabled) {
      const errors = Object.values(Bot.relay.stats).map((x) => x.error).filter(Boolean);
      out.multistream = errors.length ? { state: 'error', text: errors[0] } : { state: 'on', text: 'Joining the chats' };
    }
    return out;
  };

  Shell.renderStatus = () => {
    if (!Shell.el) return;
    const status = Shell.status();
    for (const [pid, button] of Shell.navButtons) {
      const page = Shell.byId.get(pid);
      const s = status[pid] || (page.parts || []).map((part) => status[part.slice(4)]).find(Boolean);
      const dot = button.querySelector('.app-nav-dot');
      if (s) {
        dot.dataset.state = s.state;
        button.title = `${page.label}: ${s.text}`;
        dot.textContent = '';
        button.setAttribute('aria-label', `${page.label}, ${s.text}`);
      } else {
        delete dot.dataset.state;
        button.removeAttribute('title');
        button.removeAttribute('aria-label');
      }
    }
  };

  // ---------------------------------------------------------------------------
  // The switch for the bot (beta), on its own page and in the setup guide
  // ---------------------------------------------------------------------------

  // Said by screen readers. It lives outside the pages, so redrawing one
  // (which turning the bot on or off does) doesn't cut it off.
  const live = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  document.body.append(live);
  Shell.say = (text) => {
    live.textContent = '';
    setTimeout(() => { live.textContent = text; }, 60);
  };

  const FEATURES = [
    ['Chat commands', 'your own !commands, with cooldowns and who may use them'],
    ['Alerts and events', 'react to follows, subs, cheers, raids and channel points'],
    ['Timers', 'a message every so often while chat is active'],
    ['Community', 'loyalty points, quotes, a viewer list and moderation'],
    ['Stream tools', 'an overlay for OBS, OBS scene control, Spotify song requests and multistream chat'],
  ];

  Shell.FEATURES = FEATURES;

  // `where` names the place it's drawn, so a redraw gives it the same id and
  // keyboard focus can find it again.
  Shell.botSwitch = ({ where = 'page', onChange = null } = {}) => {
    const label = 'Turn on the bot and stream tools (beta)';
    const box = h('input', { type: 'checkbox', id: `botSwitch-${where}`, 'aria-label': label, 'aria-describedby': `botSwitchHint-${where}` });
    box.checked = Bot.enabled();
    // Not disabled while it switches: that would take keyboard focus away.
    box.addEventListener('change', async () => {
      const on = box.checked;
      await Bot.setEnabled(on);
      Shell.say(on
        ? 'Bot tools are on. The Bot, Community and Stream sections, and Accounts, are now in the sidebar.'
        : 'Bot tools are off. Their sections are hidden and nothing of the bot runs. Your setup is kept.');
      if (onChange) onChange(on);
    });
    return h('div', { class: 'bot-switch' },
      h('label', { class: 'check bot-switch-label', for: box.id },
        box,
        h('span', { 'aria-hidden': 'true' }, 'Turn on the bot and stream tools'),
        h('span', { class: 'beta-badge', 'aria-hidden': 'true' }, 'Beta')),
      h('p', { class: 'hint', id: `botSwitchHint-${where}` },
        'Beta: still being tested, so some parts may change or not work as expected. The chat reader works the same with it on or off, and turning it off keeps everything you set up.'));
  };

  UI.addTab('botTools', 'Bot tools (beta)', (panel) => {
    const on = Bot.enabled();
    panel.append(
      Shell.botSwitch(),
      UI.section('What it adds',
        h('ul', { class: 'bot-steps' }, FEATURES.map(([name, text]) => h('li', {}, h('strong', {}, name), `: ${text}.`))),
        h('p', { class: 'hint' }, 'Most of it needs you to log in to Twitch, which the setup guide walks you through.')),
      on ? UI.section('Getting started',
        UI.row(
          UI.button('Set up the bot step by step', () => Bot.setup.open('app'), { cls: 'btn small primary' }),
          UI.button('Go to Accounts', () => Shell.show('account')))) : null);
  }, { listens: ['enabled'] });
})();
