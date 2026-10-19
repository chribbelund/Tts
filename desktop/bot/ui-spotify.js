'use strict';

// The Song requests page: connecting Spotify, the song playing with its
// controls, the request queue (reorder, play now, remove, add a song), the
// rules for requests, and the now-playing overlay. The logic is spotify.js.

(() => {
  const h = UI.h;
  const save = () => Bot.save();
  const external = (url) => window.chatReaderDesktop.openExternal(url);
  const Sp = Bot.spotify;
  const sp = () => Bot.data.spotify;

  const mmss = (ms) => {
    const s = Math.max(0, Math.round((ms || 0) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const art = (src, size = 40) => (src ? h('img', { class: 'sp-art', src, alt: '', width: size, height: size, loading: 'lazy' }) : h('span', { class: 'sp-art sp-art-none', 'aria-hidden': 'true' }, '♪'));
  const byName = (by) => (by ? `${by.displayName}${by.platform && by.platform !== 'twitch' ? ` (${{ youtube: 'YouTube', tiktok: 'TikTok' }[by.platform] || by.platform})` : ''}` : 'You');
  const fail = (status) => (err) => UI.say(status, err.message, true);

  // What the "Add a song" box last found; kept while the page redraws.
  const search = { text: '', results: [], busy: false, error: '' };

  const redirectUri = () => `http://127.0.0.1:${(Bot.overlayStatus && Bot.overlayStatus.port) || Bot.data.overlay.port}/spotify/callback`;

  // -------------------------------------------------------------------------
  // Connecting
  // -------------------------------------------------------------------------

  function connectSection(status) {
    const c = sp();
    const connected = Sp.connected();
    const overlayOn = !!(Bot.overlayStatus && Bot.overlayStatus.running);
    const steps = h('ol', { class: 'bot-steps' },
      h('li', {}, 'Open ', UI.button('developer.spotify.com/dashboard', () => external('https://developer.spotify.com/dashboard'), { cls: 'link' }), ', log in with the Spotify account you stream music from, and press Create app.'),
      h('li', {}, 'Give it any name and description. Under Redirect URIs add exactly ', h('code', { class: 'code-box' }, redirectUri()), ' ', UI.copyButton(redirectUri), ' and tick Web API.'),
      h('li', {}, 'Save, open the app’s Settings, and copy its Client ID here. No secret is needed.'),
      h('li', {}, 'Press Connect and allow it in the browser.'));
    const body = [
      steps,
      UI.row(
        UI.field('Client ID', UI.text(c, 'clientId', { placeholder: '32 letters and digits', onChange: () => { c.clientId = c.clientId.trim(); save(); } })),
        Sp.loggingIn
          ? UI.button('Cancel', () => Sp.cancelLogin())
          : UI.button(connected ? 'Connect again' : 'Connect Spotify', (e) => UI.busy(e.currentTarget, async () => {
            UI.say(status, 'Waiting for you to allow it in the browser…');
            await Sp.login();
            UI.say(status, '');
            UI.rerender();
          }, status), { cls: `btn small${connected ? '' : ' primary'}`, disabled: !/^[0-9a-f]{32}$/i.test(c.clientId.trim()) || !overlayOn }),
        connected ? UI.button('Disconnect', async () => { if (confirm('Disconnect Spotify? Requests stay in the queue.')) { await Sp.logout(); UI.rerender(); } }) : null),
      overlayOn ? null : h('p', { class: 'warn' }, 'The overlay is off. Spotify sends you back to it after logging in, so turn it on under ', UI.button('Overlay', () => UI.select_('overlay'), { cls: 'link' }), ' first.'),
      h('p', { class: 'hint' }, 'Adding songs to Spotify’s queue and skipping need Spotify Premium. While your Spotify app is in development mode, only accounts you add under its User Management can log in, which is fine: only yours needs to.'),
      status,
    ];
    if (connected) return h('details', { class: 'fx-more' }, h('summary', {}, 'Spotify app and login'), ...body);
    return UI.section('Connect Spotify', ...body);
  }

  // -------------------------------------------------------------------------
  // The song playing. Updated in place between redraws, so the time moves.
  // -------------------------------------------------------------------------

  const nowNodes = { box: null };

  function nowCard(status) {
    const box = h('div', { class: 'sp-now bot-card' });
    nowNodes.box = box;
    drawNow(status);
    return box;
  }

  function drawNow(status) {
    const box = nowNodes.box;
    if (!box || !box.isConnected) return;
    const n = Sp.now;
    if (!n) {
      box.dataset.state = '';
      box.replaceChildren(
        h('div', { class: 'bot-card-title' }, 'Now playing'),
        h('div', { class: 'bot-card-value' }, 'Nothing'),
        h('div', { class: 'hint' }, Sp.problem || 'Start playing something in Spotify (any playlist): requests are added to it as it plays.'),
        UI.row(UI.button('▶ Play', () => Sp.resume().catch(fail(status)))));
      return;
    }
    const req = Sp.current && Sp.current.uri === n.uri ? Sp.current : null;
    box.dataset.state = n.isPlaying ? 'on' : '';
    const bar = h('span', { class: 'sp-bar-fill' });
    const time = h('span', { class: 'hint sp-time' });
    const tick = () => {
      const at = Sp.progress();
      bar.style.width = `${n.durationMs ? Math.min(100, (at / n.durationMs) * 100) : 0}%`;
      time.textContent = `${mmss(at)} / ${mmss(n.durationMs)}`;
    };
    tick();
    nowNodes.tick = tick;
    box.replaceChildren(
      h('div', { class: 'sp-now-main' },
        art(n.image, 72),
        h('div', { class: 'sp-now-text' },
          h('div', { class: 'bot-card-title' }, n.isPlaying ? 'Now playing' : 'Paused', n.device ? ` · ${n.device}` : ''),
          h('div', { class: 'bot-card-value sp-title' }, n.name),
          h('div', { class: 'hint' }, n.artists, req ? h('span', { class: 'pill' }, `requested by ${byName(req.by)}`) : null),
          h('div', { class: 'sp-bar' }, bar),
          time)),
      h('div', { class: 'bot-actions' },
        n.isPlaying
          ? UI.button('⏸ Pause', () => Sp.pause().catch(fail(status)))
          : UI.button('▶ Play', () => Sp.resume().catch(fail(status))),
        UI.button('⏭ Skip', () => Sp.skip().catch(fail(status))),
        n.url ? UI.copyButton(() => n.url, 'Copy link') : null),
      ...(Sp.problem ? [h('div', { class: 'hint bad' }, Sp.problem)] : []));
  }

  Bot.on('spotify-now', () => drawNow(nowNodes.status));
  setInterval(() => { if (nowNodes.box && nowNodes.box.isConnected && nowNodes.tick) nowNodes.tick(); }, 1000);

  // -------------------------------------------------------------------------
  // The queue
  // -------------------------------------------------------------------------

  function queueTable(status) {
    const q = sp().queue;
    if (!q.length) return h('p', { class: 'hint bot-empty' }, sp().requests ? 'No requests waiting. Viewers add songs with !sr and a song name or Spotify link.' : 'No requests waiting. Requests are closed.');
    const list = h('ol', { class: 'sp-queue' });
    let dragging = null;
    q.forEach((r, i) => {
      const locked = !!r.sent;
      const minIndex = q[0] && q[0].sent ? 1 : 0;
      const row = h('li', { class: `sp-item${locked ? ' sent' : ''}`, draggable: locked ? 'false' : 'true', 'data-id': r.id },
        h('span', { class: 'sp-pos', 'aria-hidden': 'true' }, locked ? '▶' : String(i + 1)),
        art(r.image),
        h('div', { class: 'sp-item-text' },
          h('div', { class: 'sp-item-title' }, r.name, r.explicit ? h('span', { class: 'sp-e', title: 'Explicit' }, 'E') : null,
            locked ? h('span', { class: 'pill', title: 'Spotify has this one queued, so it stays first' }, 'next in Spotify') : null),
          h('div', { class: 'hint' }, `${r.artists} · ${mmss(r.durationMs)} · ${byName(r.by)}, ${UI.time(r.at)}`)),
        h('span', { class: 'bot-row-actions sp-item-actions' },
          UI.button('▲', () => Sp.move(r.id, i - 1), { cls: 'x', aria: `Move ${r.name} up`, title: 'Up', disabled: locked || i <= minIndex }),
          UI.button('▼', () => Sp.move(r.id, i + 1), { cls: 'x', aria: `Move ${r.name} down`, title: 'Down', disabled: locked || i === q.length - 1 }),
          UI.button('Play now', () => Sp.playNow(r.id).catch(fail(status)), { aria: `Play ${r.name} now` }),
          UI.button('✕', () => Sp.remove(r.id), { cls: 'x', aria: `Remove ${r.name}`, title: 'Remove' })));
      row.addEventListener('dragstart', (e) => { dragging = r.id; row.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', r.id); });
      row.addEventListener('dragend', () => { dragging = null; row.classList.remove('dragging'); });
      row.addEventListener('dragover', (e) => { if (dragging && dragging !== r.id) { e.preventDefault(); row.classList.add('drop'); } });
      row.addEventListener('dragleave', () => row.classList.remove('drop'));
      row.addEventListener('drop', (e) => { e.preventDefault(); row.classList.remove('drop'); if (dragging) Sp.move(dragging, i); });
      list.append(row);
    });
    return list;
  }

  function addSongBox(status) {
    const results = h('ul', { class: 'sp-results' });
    const run = async () => {
      const text = search.text.trim();
      if (!text) return;
      search.busy = true;
      search.error = '';
      draw();
      try {
        // A link goes straight in.
        if (/open\.spotify\.com\/|spotify:track:/.test(text)) {
          const r = await Sp.request(text, null, { force: true });
          if (r.req) { search.text = ''; input.value = ''; search.results = []; } else search.error = r.reason || 'That link isn’t a Spotify song';
        } else {
          search.results = await Sp.search(text);
          if (!search.results.length) search.error = 'Nothing found';
        }
      } catch (err) {
        search.error = err.message;
      }
      search.busy = false;
      draw();
    };
    const draw = () => {
      results.replaceChildren(
        ...(search.busy ? [h('li', { class: 'hint' }, 'Searching…')] : []),
        ...(search.error ? [h('li', { class: 'hint bad' }, search.error)] : []),
        ...search.results.map((t) => h('li', { class: 'sp-item' },
          art(t.image),
          h('div', { class: 'sp-item-text' }, h('div', { class: 'sp-item-title' }, t.name, t.explicit ? h('span', { class: 'sp-e', title: 'Explicit' }, 'E') : null), h('div', { class: 'hint' }, `${t.artists} · ${mmss(t.durationMs)}`)),
          h('span', { class: 'bot-row-actions' }, UI.button('Add', () => {
            Sp.addTrack(t);
            search.results = search.results.filter((x) => x !== t);
            UI.say(status, `Added “${t.name}”.`);
          }, { cls: 'btn small primary', aria: `Add ${t.name}` })))));
      results.hidden = !results.children.length;
    };
    const input = UI.text(search, 'text', { placeholder: 'Search Spotify, or paste a song link' });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
    draw();
    return h('div', { class: 'sp-add' },
      UI.row(input, UI.button('Search', run), search.results.length ? UI.button('Clear', () => { search.results = []; search.error = ''; draw(); }) : null),
      results);
  }

  function spotifyQueue(status) {
    const body = h('div', {});
    const draw = () => body.replaceChildren(Sp.upcoming.length
      ? h('ol', { class: 'sp-upcoming' }, Sp.upcoming.slice(0, 20).map((t) => h('li', {}, h('strong', {}, t.name), ` – ${t.artists}`)))
      : h('p', { class: 'hint' }, 'Press Refresh to see it.'));
    draw();
    return h('details', { class: 'fx-more' },
      h('summary', {}, 'Spotify’s own queue'),
      h('p', { class: 'hint' }, 'What Spotify will play after the song playing: anything you queued in Spotify, the request handed to it, then your playlist. Spotify doesn’t let apps change this list, which is why requests wait here instead.'),
      UI.row(UI.button('Refresh', (e) => UI.busy(e.currentTarget, async () => {
        await Sp.refreshUpcoming();
        draw();
      }, status))),
      body);
  }

  function historyList() {
    const list = sp().history.slice(0, 15);
    return h('details', { class: 'fx-more' },
      h('summary', {}, `Played requests (${sp().history.length})`),
      list.length ? h('ul', { class: 'sp-history' }, list.map((r) => h('li', { class: 'sp-item' },
        art(r.image, 32),
        h('div', { class: 'sp-item-text' }, h('div', { class: 'sp-item-title' }, r.name), h('div', { class: 'hint' }, `${r.artists} · ${byName(r.by)}, ${UI.time(r.playedAt || r.at)}`)),
        h('span', { class: 'bot-row-actions' }, UI.button('Queue again', () => Sp.addTrack(r, r.by)))))) : h('p', { class: 'hint' }, 'None yet.'),
      list.length ? UI.row(UI.button('Clear the list', () => { sp().history = []; save(); UI.rerender(); })) : null);
  }

  // -------------------------------------------------------------------------
  // The overlay link
  // -------------------------------------------------------------------------

  function overlayUrl() {
    const l = sp().overlayLink;
    const q = ['spotify'];
    if (Number(l.next) > 0) q.push(`next=${Math.min(10, Number(l.next))}`);
    if (!l.art) q.push('art=0');
    if (!l.requester) q.push('requester=0');
    if (!l.progress) q.push('progress=0');
    if (!l.hideIdle) q.push('idle=1');
    if (Number(l.size) > 0) q.push(`size=${Number(l.size)}`);
    return `${UI.overlayBase()}?${q.join('&')}`;
  }

  function overlaySection() {
    const running = !!(Bot.overlayStatus && Bot.overlayStatus.running);
    if (!running) return UI.section('On stream', h('p', { class: 'hint' }, 'Turn on the overlay under ', UI.button('Overlay', () => UI.select_('overlay'), { cls: 'link' }), ' to show the song on stream.'));
    const l = sp().overlayLink;
    const builder = UI.linkBuilder((changedLink) => [
      UI.row(
        UI.field('Requests shown under it', UI.number(l, 'next', { min: 0, max: 10, onChange: changedLink })),
        UI.field('Title size (px)', UI.text(l, 'size', { type: 'number', placeholder: 'style', cls: 'short', onChange: changedLink }))),
      UI.row(
        UI.check(l, 'art', 'Album art', { onChange: changedLink }),
        UI.check(l, 'requester', 'Who requested it', { onChange: changedLink }),
        UI.check(l, 'progress', 'Progress bar', { onChange: changedLink }),
        UI.check(l, 'hideIdle', 'Hide while paused', { onChange: changedLink })),
    ], overlayUrl, [UI.button('Send it again', () => Sp.publish())]);
    return UI.section('On stream',
      UI.lead('What’s playing, with who asked for it, as an OBS Browser source. Add the link as its own source, about 560 × 160 (taller to show requests under it), and place it where you like. Colours, font and corners follow the overlay style.'),
      builder.node);
  }

  // -------------------------------------------------------------------------
  // The page
  // -------------------------------------------------------------------------

  UI.addTab('spotify', 'Song requests', (panel) => {
    const c = sp();
    const status = UI.status();
    nowNodes.status = status;
    const connected = Sp.connected();
    const commands = Bot.commands.activeSystem().filter((x) => ['songrequest', 'song', 'songqueue', 'wrongsong', 'skipsong'].includes(x.key));

    panel.append(
      UI.lead('Viewers request songs in chat; they wait in the queue below, where you can reorder and remove them, and each goes to Spotify shortly before the song playing ends. Your own playlist plays in between.'),
      h('div', { class: 'bot-card', 'data-state': connected ? (Sp.problem ? 'error' : 'on') : Sp.state === 'error' ? 'error' : '' },
        h('div', { class: 'bot-card-title' }, 'Spotify'),
        h('div', { class: 'bot-card-value' }, connected ? Sp.text : Sp.state === 'connecting' ? 'Connecting…' : Sp.loggingIn ? 'Waiting for the browser…' : 'Not connected'),
        !connected && Sp.text ? h('div', { class: `hint${Sp.state === 'error' ? ' bad' : ''}` }, Sp.text) : null,
        connected && Sp.account && Sp.account.product && Sp.account.product !== 'premium' ? h('div', { class: 'hint bad' }, 'This Spotify account isn’t Premium, so songs can’t be added to its queue.') : null),
      connectSection(status),
      connected ? nowCard(status) : null,
      UI.section(`Request queue (${c.queue.length})`,
        UI.row(
          UI.check(c, 'requests', 'Take requests from chat', { onChange: () => { save(); Bot.emit('spotify', {}); } }),
          UI.check(c, 'autoplay', 'Hand them to Spotify as songs end', { onChange: () => { save(); Sp.poll(); } })),
        c.autoplay ? null : h('p', { class: 'hint' }, 'Requests only wait now: press Play now on one to play it.'),
        connected ? addSongBox(status) : null,
        queueTable(status),
        c.queue.length ? UI.row(UI.button('Empty the queue', () => { if (confirm(`Remove all ${c.queue.length} requests?`)) Sp.clear(); })) : null,
        status,
        connected ? spotifyQueue(status) : null,
        historyList()),
      UI.section('Rules for requests',
        UI.lead('Mods and you skip the limits on length, songs per viewer and queue size. Blocked songs are blocked for everyone but you.'),
        UI.row(
          UI.field('Songs per viewer waiting (0 = any)', UI.number(c, 'maxPerUser', { min: 0, max: 100, onChange: save })),
          UI.field('Longest song (minutes, 0 = any)', UI.number(c, 'maxMinutes', { min: 0, max: 120, onChange: save })),
          UI.field('Most requests waiting (0 = any)', UI.number(c, 'maxQueue', { min: 0, max: 1000, onChange: save }))),
        UI.row(
          UI.check(c, 'noExplicit', 'No explicit songs', { onChange: save }),
          UI.check(c, 'noDuplicates', 'No song twice in the queue', { onChange: save })),
        UI.field('Blocked words, artists or song links', UI.text(c, 'blocked', { multiline: true, rows: 3, placeholder: 'Separated by commas or new lines', onChange: save }), 'A song whose title or artist contains one of these can’t be requested.'),
        h('details', { class: 'fx-more' }, h('summary', {}, 'Advanced'),
          UI.field('Hand the next request to Spotify this many seconds before a song ends', UI.number(c, 'sendAhead', { min: 5, max: 120, onChange: save }), 'Until then a request can still be moved or removed. Too short, and Spotify may start the next playlist song first.'))),
      UI.section('Chat commands',
        UI.lead('Built-in commands: change their names, who can use them, cooldowns, a points cost and their replies under Commands → Built in.'),
        UI.table([{ label: 'Command' }, { label: 'What it does' }, { label: 'Who' }],
          commands.map((x) => ({ cells: [h('code', {}, x.trigger), x.name.replace(/ \(Spotify\)$/, ''), Bot.roleName(x.permission)] })),
          { empty: 'Enter a Client ID above to turn them on.' }),
        UI.row(UI.button('Open Commands', () => UI.select_('commands'))),
        h('p', { class: 'hint' }, 'To take requests through channel points instead, give a reward (with “The viewer types a message”) the Spotify effect, Request a song, under Rewards.')),
      overlaySection(),
    );
  }, { listens: ['spotify', 'spotify-queue', 'overlay'] });
})();
