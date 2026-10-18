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
    { group: 'Bot', pages: ['commands', 'events', 'rewards', 'timers', 'lists', 'counters'] },
    { group: 'Community', pages: ['viewers', 'points', 'quotes', 'moderation'] },
    { group: 'Stream', pages: ['multistream', 'overlay', 'obs'] },
    {
      group: 'App',
      pages: [
        { id: 'account', label: 'Accounts', parts: ['tab:account'], lead: 'Your Twitch logins, and how the bot behaves in chat.' },
        { id: 'shortcuts', label: 'Shortcuts & API', parts: ['reader:keys', 'tab:hotkeys'] },
        { id: 'display', label: 'Display', parts: ['reader:display'] },
        { id: 'backup', label: 'Backup & import', parts: ['reader:backup', 'tab:import'] },
      ],
    },
  ];

  // The dashboard's side column, top to bottom (dashboard.js).
  const DASH_PARTS = ['dash-status', 'dash-chat', 'dash-actions', 'dash-activity', 'dash-stream'];

  function buildPages() {
    const placed = new Set();
    for (const { group, pages } of LAYOUT) {
      for (const p of pages) {
        const spec = typeof p === 'string' ? { id: p, parts: [`tab:${p}`] } : p;
        const parts = (spec.parts || []).filter((part) => !part.startsWith('tab:') || UI.tab(part.slice(4)));
        if (spec.id !== 'dashboard' && !parts.length) continue;
        const firstTab = parts.find((part) => part.startsWith('tab:'));
        const page = { ...spec, group, parts, label: spec.label || (firstTab ? UI.tab(firstTab.slice(4)).label : spec.id) };
        for (const part of parts) if (part.startsWith('tab:')) placed.add(part.slice(4));
        Shell.pages.push(page);
        Shell.byId.set(page.id, page);
      }
    }
    for (const id of DASH_PARTS) placed.add(id);
    // A tab no page names yet still gets one, under Bot.
    for (const tab of UI.tabs) {
      if (placed.has(tab.id)) continue;
      const page = { id: tab.id, label: tab.label, group: 'Bot', parts: [`tab:${tab.id}`] };
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
    for (const page of Shell.pages) {
      if (!list || list.dataset.group !== page.group) {
        list = h('ul', { class: 'app-nav-list', 'data-group': page.group, 'aria-labelledby': page.group ? `nav-${page.group.toLowerCase()}` : null });
        if (page.group) nav.append(h('h2', { class: 'app-nav-head', id: `nav-${page.group.toLowerCase()}` }, page.group));
        nav.append(list);
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

    Shell.show('dashboard', { focus: false });
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
    const box = h('div', { class: 'tab-panel page-part bot-part bot-scope', 'data-tab': id });
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
    const side = h('aside', { class: 'dash-side bot-scope', 'aria-label': 'Stream' });
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
  Shell.pageFor = (id) => Shell.byId.get(id) || Shell.pages.find((p) => p.parts && p.parts.includes(`tab:${id}`)) || null;

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
    const buttons = [...Shell.navButtons.values()];
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
})();
