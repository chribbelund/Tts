'use strict';

// The Bot workspace's tabs, in the order they appear. See ui.js for the
// controls they're built from.

(() => {
  const h = UI.h;
  const save = () => Bot.save();
  const external = (url) => window.chatReaderDesktop.openExternal(url);
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  // -------------------------------------------------------------------------
  // Dashboard
  // -------------------------------------------------------------------------

  UI.addTab('dashboard', 'Dashboard', (panel) => {
    const me = Bot.twitch.accounts.streamer;
    const stream = UI.lastStream;
    const overlay = Bot.overlayStatus || {};
    const card = (title, value, detail, state = '') => h('div', { class: 'bot-card', 'data-state': state },
      h('div', { class: 'bot-card-title' }, title), h('div', { class: 'bot-card-value' }, value), detail ? h('div', { class: 'hint' }, detail) : null);

    panel.append(
      UI.needsLogin() || '',
      UI.grid(
        card('Twitch', me ? me.displayName : 'Not logged in', me ? (Bot.community.live && stream ? `Live · ${stream.viewer_count} watching · ${Bot.duration((Date.now() - Date.parse(stream.started_at)) / 1000)}` : 'Offline') : 'Account tab', me ? (Bot.community.live ? 'on' : '') : 'off'),
        card('Events', { connected: 'Receiving', connecting: 'Connecting…', error: 'Problem', idle: 'Off' }[Bot.eventsub.state] || '', Bot.eventsub.text || (me ? '' : 'Starts once you log in'), Bot.eventsub.state === 'connected' ? 'on' : Bot.eventsub.state === 'error' ? 'error' : ''),
        card('Overlay', overlay.running ? plural(overlay.clients || 0, 'overlay') + ' open' : 'Off', overlay.error || (overlay.running ? overlay.url : ''), overlay.running ? 'on' : overlay.error ? 'error' : ''),
        card('OBS', { connected: 'Connected', connecting: 'Connecting…', error: 'Not connected', idle: 'Off' }[Bot.obs.state], Bot.obs.state === 'error' ? Bot.obs.text : '', Bot.obs.state === 'connected' ? 'on' : Bot.obs.state === 'error' ? 'error' : ''),
      ),
    );

    // Title and category.
    if (me) {
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
      panel.append(UI.section('Stream', h('div', { class: 'bot-stream-form' }, UI.field('Title', title), UI.field('Category', h('div', {}, game, list)), saveInfo), status));
    }

    // Quick actions.
    const qStatus = UI.status();
    const act = (label, fn) => UI.button(label, (e) => UI.busy(e.currentTarget, async () => { await fn(); UI.say(qStatus, `${label}: done.`); }, qStatus));
    const ad = { seconds: '60' };
    const raffle = Bot.games.raffle;
    panel.append(UI.section('Quick actions',
      h('div', { class: 'bot-actions' },
        h('span', { class: 'bot-inline' }, UI.select(ad, 'seconds', [['30', '30 s'], ['60', '60 s'], ['90', '90 s'], ['120', '2 min'], ['180', '3 min']], { label: 'Ad length' }), act('Run ad', () => Bot.twitch.commercial(Number(ad.seconds)))),
        act('Marker', () => Bot.twitch.marker('from Chat Reader')),
        act('Clip', async () => {
          const res = await Bot.twitch.clip(false);
          const clip = res.data && res.data[0];
          if (clip) Bot.addActivity({ kind: 'note', text: `Clip: https://clips.twitch.tv/${clip.id}` });
        }),
        act(raffle.open ? `Draw raffle (${raffle.entries.size})` : 'Open raffle', () => Bot.games.raffleAction(raffle.open ? 'draw' : 'start')),
        act('Test alert', () => Bot.effects.run([{ ...Bot.effects.newEffect('alert'), title: 'Test alert', message: 'The overlay works!' }], UI.testContext())),
        act('Clear overlay', () => Bot.effects.run([Bot.effects.newEffect('overlayClear')], UI.testContext())),
      ),
      Bot.data.lists.length ? h('div', { class: 'bot-actions' }, h('span', { class: 'hint' }, 'Effect lists:'), Bot.data.lists.map((l) => act(`▶ ${l.name}`, () => Bot.lists.run(l.id)))) : null,
      qStatus));

    // Chat as the bot or the streamer.
    if (me) {
      const msg = { text: '', as: Bot.twitch.chatRole() };
      const cStatus = UI.status();
      const input = UI.text(msg, 'text', { placeholder: 'Say something in your chat', maxlength: 500 });
      const send = UI.button('Send', (e) => UI.busy(e.currentTarget, async () => {
        if (!msg.text.trim()) return;
        await Bot.twitch.say(msg.text, { as: msg.as });
        msg.text = '';
        input.value = '';
        UI.say(cStatus, '');
        input.focus();
      }, cStatus), { cls: 'btn small primary' });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send.click(); } });
      const as = Bot.twitch.accounts.bot ? UI.select(msg, 'as', [['bot', `as ${Bot.twitch.accounts.bot.displayName}`], ['streamer', `as ${me.displayName}`]], { label: 'Send as' }) : null;
      panel.append(UI.section('Chat', h('div', { class: 'bot-chat-send' }, input, as, send), cStatus));
    }

    // Activity feed.
    const items = Bot.activity.slice(0, 80);
    panel.append(UI.section('Activity',
      items.length ? h('ul', { class: 'bot-activity' }, items.map((a) => h('li', { 'data-kind': a.kind },
        h('time', {}, UI.time(a.at)),
        h('span', { class: 'bot-activity-text' }, a.text, a.simulated ? h('span', { class: 'pill' }, 'test') : null),
        a.replay ? UI.button('↻', () => a.replay(), { cls: 'x', aria: `Run the effects for “${a.text}” again`, title: 'Run its effects again' }) : null,
      ))) : h('p', { class: 'hint bot-empty' }, 'Follows, subs, raids, redemptions and the rest show up here as they happen.')));

    const lines = Bot.logLines.slice(-60).reverse();
    const errors = lines.filter((l) => l.level === 'error').length;
    panel.append(h('details', { class: 'bot-log', open: errors > 0 && UI.logOpen ? true : null, ontoggle: (e) => { UI.logOpen = e.currentTarget.open; } },
      h('summary', {}, `Log${errors ? ` · ${plural(errors, 'problem')}` : ''}`),
      lines.length ? h('ul', {}, lines.map((l) => h('li', { 'data-level': l.level }, h('time', {}, UI.time(l.at)), ' ', l.text))) : h('p', { class: 'hint' }, 'Nothing logged.')));
  }, { listens: ['activity', 'stream', 'live', 'eventsub', 'accounts', 'log', 'obs', 'overlay', 'raffle'] });

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  const COMMAND_VARS = [['arg[1]', 'First word after the command'], ['target', 'That word without @'], ['args', 'Everything after the command'], ['count', 'Times used']];

  function editCommand(cmd, isNew) {
    UI.edit({
      title: isNew ? 'New command' : `Command ${cmd.trigger}`,
      item: cmd,
      build: (c, rebuild) => [
        UI.row(
          UI.field('Trigger', UI.text(c, 'trigger', { placeholder: '!hello' }), c.match === 'regex' ? 'A regular expression; its groups become $arg[1], $arg[2]…' : ''),
          UI.field('Other names for it', UI.text(c, 'aliases', { placeholder: '!hi, !hey' }), 'Separated by commas'),
          UI.field('It’s used when the message', UI.select(c, 'match', [['start', 'starts with it'], ['anywhere', 'has it anywhere'], ['regex', 'matches the regex']], { onChange: rebuild })),
        ),
        UI.field('Description', UI.text(c, 'description', { placeholder: 'What it does, for you' })),
        UI.row(
          UI.field('Who can use it', UI.select(c, 'permission', UI.permissionOptions())),
          UI.field('Also these users', UI.text(c, 'users', { placeholder: 'alice, bob' })),
          UI.field('From', UI.select(c, 'platforms', [['all', 'Every chat'], ['twitch', 'Twitch only']])),
        ),
        UI.row(
          UI.field('Cooldown for everyone (s)', UI.number(c, 'cooldownGlobal', { min: 0, max: 86400 })),
          UI.field('Cooldown per chatter (s)', UI.number(c, 'cooldownUser', { min: 0, max: 86400 })),
          Bot.data.currency.enabled ? UI.field(`Costs (${Bot.data.currency.name})`, UI.number(c, 'cost', { min: 0, max: 1e9 })) : null,
        ),
        UI.check(c, 'modsSkipCooldown', 'Mods and you skip the cooldown'),
        UI.check(c, 'hidden', 'Leave it out of !commands'),
        h('details', { class: 'fx-more' }, h('summary', {}, 'Replies when it can’t be used'),
          UI.field('While cooling down (empty = say nothing)', UI.text(c, 'cooldownText', { vars: true, extraVars: [['cooldown', 'Seconds left']], placeholder: '@$user, wait $cooldown seconds' })),
          UI.field('Not allowed (empty = say nothing)', UI.text(c, 'deniedText', { vars: true, placeholder: '@$user, that’s for subscribers' }))),
        h('details', { class: 'fx-more' }, h('summary', {}, 'Advanced'),
          UI.field('Queue', UI.text(c, 'queue', { placeholder: 'e.g. alerts' }), 'Commands, events and lists with the same queue name run one after the other.')),
        h('div', { class: 'field nested' }, h('div', { class: 'row-label' }, 'What it does'), UI.effects(c.effects, { fields: COMMAND_VARS })),
      ],
      onTest: (c) => Bot.effects.run(c.effects, UI.testContext(COMMAND_VARS, { args: ['test'], command: c })),
      onSave: (c) => {
        c.trigger = c.trigger.trim();
        if (!c.trigger) c.trigger = '!command';
        if (c.match === 'start' && !c.trigger.includes(' ')) c.trigger = c.trigger.toLowerCase();
        const i = Bot.data.commands.findIndex((x) => x.id === c.id);
        if (i === -1) Bot.data.commands.push(c); else Bot.data.commands[i] = c;
        save();
        UI.rerender();
      },
    });
  }

  function systemOverride(key) {
    if (!Bot.data.systemCommands[key]) Bot.data.systemCommands[key] = {};
    return Bot.data.systemCommands[key];
  }

  function editSystemTexts(spec) {
    const o = Bot.clone(systemOverride(spec.key));
    o.texts = { ...spec.texts, ...(o.texts || {}) };
    if (o.official === undefined && spec.key === 'so') o.official = true;
    if (o.allowGive === undefined && spec.key === 'points') o.allowGive = true;
    if (o.addPermission === undefined && spec.key === 'quote') o.addPermission = 'mods';
    UI.edit({
      title: `Built-in ${spec.trigger || spec.name}`,
      item: o,
      build: (x) => [
        UI.lead('What it says in chat. Leave a reply empty to say nothing.'),
        ...Object.keys(spec.texts).map((k) => UI.field(k, UI.text(x.texts, k, { multiline: true, rows: 2, vars: true, extraVars: [['who', 'Who it’s about'], ['amount', 'Amount'], ['list', 'The list'], ['number', 'Number'], ['quoteText', 'The quote'], ['age', 'How long'], ['time', 'Watch time'], ['rank', 'Rank'], ['seconds', 'Seconds']] }))),
        spec.key === 'so' ? UI.check(x, 'official', 'Also send Twitch’s own /shoutout') : null,
        spec.key === 'points' ? UI.check(x, 'allowGive', 'Let chatters give their points to others (“give @name 100”)') : null,
        spec.key === 'quote' ? UI.field('Who can add quotes', UI.select(x, 'addPermission', UI.permissionOptions())) : null,
      ],
      onSave: (x) => { Bot.data.systemCommands[spec.key] = x; save(); UI.rerender(); },
    });
  }

  UI.addTab('commands', 'Commands', (panel) => {
    const view = UI.commandsView || 'custom';
    const seg = h('div', { class: 'seg bot-seg', role: 'radiogroup', 'aria-label': 'Which commands' },
      ...[['custom', 'Your commands'], ['system', 'Built in']].map(([v, label]) => {
        const r = h('input', { type: 'radio', name: 'botCmdView', value: v });
        r.checked = view === v;
        r.addEventListener('change', () => { UI.commandsView = v; UI.rerender(); });
        return h('label', {}, r, h('span', {}, label));
      }));
    panel.append(UI.needsLogin() || '', seg);

    if (view === 'custom') {
      panel.append(
        UI.lead('Chat commands that run effects: reply in chat, play a sound, show an alert, change a counter… Click Edit to choose what a command does.'),
        UI.row(UI.button('+ New command', () => editCommand(Bot.commands.newCommand(), true), { cls: 'btn small primary' })),
        UI.table(
          [{ label: 'On', cls: 'c-on' }, { label: 'Command' }, { label: 'Does' }, { label: 'Who' }, { label: 'Cooldown' }, { label: 'Used', cls: 'num' }, { label: '', cls: 'c-act' }],
          Bot.data.commands.map((c) => ({
            off: !c.enabled,
            cells: [
              UI.toggle(c, 'enabled', `${c.trigger} is on`, UI.rerender),
              h('code', {}, c.trigger),
              UI.trim(c.description || (c.effects[0] ? `${Bot.effects.types.get(c.effects[0].type).name}: ${(Bot.effects.types.get(c.effects[0].type).summary || (() => ''))(c.effects[0])}` : 'nothing yet'), 60),
              Bot.roleName(c.permission),
              c.cooldownGlobal || c.cooldownUser ? `${c.cooldownGlobal || 0} s / ${c.cooldownUser || 0} s` : '–',
              String(c.count || 0),
              h('span', { class: 'bot-row-actions' },
                UI.button('Edit', () => editCommand(Bot.clone(c), false)),
                UI.button('▶', () => Bot.effects.run(c.effects, UI.testContext(COMMAND_VARS, { command: c })), { cls: 'x', aria: `Try ${c.trigger}`, title: 'Try it' }),
                UI.button('⧉', () => { const d = Bot.clone(c); d.id = Bot.uid('c'); d.trigger = `${c.trigger}2`; d.count = 0; d.effects.forEach(UI.reId); Bot.data.commands.push(d); save(); UI.rerender(); }, { cls: 'x', aria: `Duplicate ${c.trigger}`, title: 'Duplicate' }),
                UI.button('🗑', () => { if (confirm(`Delete ${c.trigger}?`)) { Bot.data.commands = Bot.data.commands.filter((x) => x !== c); save(); UI.rerender(); } }, { cls: 'x', aria: `Delete ${c.trigger}`, title: 'Delete' })),
            ],
          })),
          { empty: 'No commands yet. Try “!hello” that says “Hi $user!” in chat.' },
        ),
      );
      return;
    }

    panel.append(UI.lead('Commands the bot has from the start. Rename them, change who may use them, or switch them off. Games and the raffle are set up under Points & games.'));
    const rows = Bot.commands.system.filter((s) => !['slots', 'gamble', 'heist', 'raffle'].includes(s.key)).map((spec) => {
      const o = Bot.data.systemCommands[spec.key] || {};
      const merged = { ...spec, ...o };
      const unavailable = spec.when && !spec.when();
      const trigger = h('input', { spellcheck: 'false', autocomplete: 'off', class: 'mono', 'aria-label': `Command for ${spec.name}` });
      trigger.value = o.trigger || (spec.triggerFrom ? spec.triggerFrom() : spec.trigger);
      trigger.addEventListener('input', () => { systemOverride(spec.key).trigger = trigger.value.trim().toLowerCase(); save(); });
      return {
        off: merged.enabled === false || unavailable,
        cells: [
          UI.toggle(systemOverride(spec.key), 'enabled', `${spec.name} is on`, UI.rerender),
          trigger,
          h('span', {}, spec.name, unavailable ? h('span', { class: 'hint' }, spec.key === 'permit' ? ' · needs link moderation' : ' · needs points turned on') : null),
          UI.select(systemOverride(spec.key), 'permission', UI.permissionOptions(), { onChange: save, label: `Who can use ${spec.name}` }),
          h('span', { class: 'bot-inline' },
            UI.number(Object.assign(systemOverride(spec.key), { cooldownGlobal: merged.cooldownGlobal || 0 }), 'cooldownGlobal', { min: 0, max: 86400, onChange: save }),
            UI.number(Object.assign(systemOverride(spec.key), { cooldownUser: merged.cooldownUser || 0 }), 'cooldownUser', { min: 0, max: 86400, onChange: save })),
          Object.keys(spec.texts || {}).length ? UI.button('Replies…', () => editSystemTexts({ ...spec, trigger: merged.trigger })) : '',
        ],
      };
    });
    for (const s of Bot.commands.system) {
      const o = systemOverride(s.key);
      if (o.permission === undefined) o.permission = s.permission;
    }
    panel.append(UI.table([{ label: 'On', cls: 'c-on' }, { label: 'Command' }, { label: 'What' }, { label: 'Who' }, { label: 'Cooldown: all / each (s)' }, { label: '' }], rows));
    panel.append(UI.lead('Mods can also use: !title and !game with text after them to change those, !points add/remove/set @name 100, !quote add/del, !raffle start/draw.'));
  });

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  const eventTypeOptions = () => {
    const groups = new Map();
    for (const [id, t] of Object.entries(Bot.events.types)) {
      if (!groups.has(t.category)) groups.set(t.category, []);
      groups.get(t.category).push([id, t.name]);
    }
    return [...groups].map(([group, options]) => ({ group, options }));
  };
  const eventFields = (type) => {
    const t = Bot.events.types[type];
    return t ? [['user', 'Their name'], ['username', 'Their login'], ...t.fields] : [];
  };

  function editEvent(ev, isNew) {
    UI.edit({
      title: isNew ? 'New event' : `Event: ${ev.name || (Bot.events.types[ev.type] || {}).name}`,
      item: ev,
      build: (e, rebuild) => {
        const t = Bot.events.types[e.type] || { name: e.type, fields: [] };
        return [
          UI.row(
            UI.field('When', UI.select(e, 'type', eventTypeOptions(), { onChange: rebuild })),
            UI.field('Name (for you)', UI.text(e, 'name', { placeholder: t.name })),
          ),
          h('div', { class: 'field nested' }, h('div', { class: 'row-label' }, 'Only if (filters)'), UI.conditions(e.filters, { fields: eventFields(e.type) })),
          h('details', { class: 'fx-more' }, h('summary', {}, 'Advanced'),
            UI.field('Queue', UI.text(e, 'queue', { placeholder: 'e.g. alerts' }), 'Events with the same queue name run one after the other: give all your alerts the queue “alerts” so they don’t overlap.')),
          h('div', { class: 'field nested' }, h('div', { class: 'row-label' }, 'What happens'), UI.effects(e.effects, { fields: eventFields(e.type) })),
        ];
      },
      onTest: (e) => Bot.effects.run(e.effects, UI.testContext([], { fields: { ...(Bot.events.types[e.type].sample || {}), user: 'Test_Viewer', username: 'test_viewer' } })),
      onSave: (e) => {
        const i = Bot.data.events.findIndex((x) => x.id === e.id);
        if (i === -1) Bot.data.events.push(e); else Bot.data.events[i] = e;
        save();
        UI.rerender();
      },
    });
  }

  UI.addTab('events', 'Events', (panel) => {
    const pick = { type: 'follow' };
    const sim = { type: 'follow' };
    const sStatus = UI.status();
    panel.append(
      UI.needsLogin() || '',
      UI.lead('Alerts and anything else that should happen when someone follows, subscribes, cheers, raids or redeems — or when YouTube and TikTok chat do their own thing. Each event can have filters, like “only cheers of 100 bits or more”.'),
      UI.row(
        UI.select(pick, 'type', eventTypeOptions(), { label: 'Event type' }),
        UI.button('+ New event', () => editEvent({ id: Bot.uid('v'), enabled: true, type: pick.type, name: '', filters: { mode: 'all', items: [] }, queue: '', effects: [] }, true), { cls: 'btn small primary' }),
      ),
      UI.table(
        [{ label: 'On', cls: 'c-on' }, { label: 'Name' }, { label: 'When' }, { label: 'Filters', cls: 'num' }, { label: 'Effects', cls: 'num' }, { label: '', cls: 'c-act' }],
        Bot.data.events.map((e) => {
          const t = Bot.events.types[e.type] || { name: e.type };
          return {
            off: !e.enabled,
            cells: [
              UI.toggle(e, 'enabled', `${e.name || t.name} is on`, UI.rerender),
              e.name || t.name,
              t.name,
              String((e.filters.items || []).length),
              String(e.effects.length),
              h('span', { class: 'bot-row-actions' },
                UI.button('Edit', () => editEvent(Bot.clone(e), false)),
                UI.button('▶', () => Bot.events.simulate(e.type), { cls: 'x', aria: `Pretend a ${t.name} happened`, title: 'Pretend it happened (every event of this kind runs)' }),
                UI.button('⧉', () => { const d = Bot.clone(e); d.id = Bot.uid('v'); d.name = `${e.name || t.name} (copy)`; d.effects.forEach(UI.reId); Bot.data.events.push(d); save(); UI.rerender(); }, { cls: 'x', aria: 'Duplicate', title: 'Duplicate' }),
                UI.button('🗑', () => { if (confirm(`Delete “${e.name || t.name}”?`)) { Bot.data.events = Bot.data.events.filter((x) => x !== e); save(); UI.rerender(); } }, { cls: 'x', aria: 'Delete', title: 'Delete' })),
            ],
          };
        }),
        { empty: 'No events yet. Start with a Follow event that shows an overlay alert.' },
      ),
      UI.section('Try them out',
        UI.lead('Pretends the event happened, with you as the viewer, so every event of that kind runs as if it were real.'),
        UI.row(UI.select(sim, 'type', eventTypeOptions(), { label: 'Event to pretend' }), UI.button('Simulate', () => { Bot.events.simulate(sim.type); UI.say(sStatus, `Simulated: ${Bot.events.types[sim.type].name}. See the Dashboard’s activity.`); })),
        sStatus),
    );
  });

  // -------------------------------------------------------------------------
  // Channel point rewards
  // -------------------------------------------------------------------------

  function editRewardAction(reward) {
    const existing = Bot.data.rewardActions[reward.id];
    const action = existing ? Bot.clone(existing) : { title: reward.title, enabled: true, after: 'none', queue: '', effects: [] };
    const fields = [['user', 'Their name'], ['rewardName', 'Reward'], ['rewardCost', 'Cost'], ['message', 'What they typed']];
    UI.edit({
      title: `Reward: ${reward.title}`,
      item: action,
      build: (a) => [
        UI.check(a, 'enabled', 'Run these effects when it’s redeemed'),
        reward.manageable
          ? UI.field('Afterwards', UI.select(a, 'after', [['none', 'Leave it in the queue on Twitch'], ['fulfill', 'Mark it complete'], ['refund', 'Refund the points']]))
          : h('p', { class: 'hint' }, 'This reward was made on Twitch, so Twitch won’t let the app complete or refund it. Make it here (below) for that.'),
        UI.field('Queue', UI.text(a, 'queue', { placeholder: 'e.g. alerts' })),
        h('div', { class: 'field nested' }, h('div', { class: 'row-label' }, 'What happens'), UI.effects(a.effects, { fields })),
      ],
      onTest: (a) => Bot.effects.run(a.effects, UI.testContext(fields, { fields: { rewardName: reward.title, rewardCost: reward.cost, message: 'test', user: 'Test_Viewer' } })),
      onSave: (a) => { a.title = reward.title; Bot.data.rewardActions[reward.id] = a; save(); UI.rerender(); },
    });
  }

  function editReward(reward) {
    const r = reward ? {
      title: reward.title, cost: reward.cost, prompt: reward.prompt, is_user_input_required: reward.is_user_input_required, background_color: reward.background_color || '#9147ff',
      maxPerStream: reward.max_per_stream_setting.is_enabled ? reward.max_per_stream_setting.max_per_stream : 0,
      cooldown: reward.global_cooldown_setting.is_enabled ? reward.global_cooldown_setting.global_cooldown_seconds : 0,
      should_redemptions_skip_request_queue: reward.should_redemptions_skip_request_queue,
    } : { title: '', cost: 500, prompt: '', is_user_input_required: false, background_color: '#9147ff', maxPerStream: 0, cooldown: 0, should_redemptions_skip_request_queue: false };
    UI.edit({
      title: reward ? `Change ${reward.title}` : 'New channel point reward',
      saveLabel: reward ? 'Save on Twitch' : 'Create on Twitch',
      item: r,
      build: (x) => [
        UI.row(UI.field('Title', UI.text(x, 'title', { maxlength: 45 })), UI.field('Cost', UI.number(x, 'cost', { min: 1, max: 1e9 }))),
        UI.field('Description', UI.text(x, 'prompt', { maxlength: 200 })),
        UI.check(x, 'is_user_input_required', 'The viewer types a message'),
        UI.row(
          UI.field('Colour', (() => { const c = h('input', { type: 'color' }); c.value = x.background_color; c.addEventListener('input', () => { x.background_color = c.value; }); return c; })()),
          UI.field('Most per stream (0 = no limit)', UI.number(x, 'maxPerStream', { min: 0, max: 1e6 })),
          UI.field('Cooldown (s)', UI.number(x, 'cooldown', { min: 0, max: 604800 })),
        ),
        UI.check(x, 'should_redemptions_skip_request_queue', 'Skip Twitch’s request queue (mark complete at once)'),
      ],
      onSave: async (x) => {
        const body = {
          title: x.title.trim(), cost: Math.max(1, Math.round(x.cost)), prompt: x.prompt, is_user_input_required: x.is_user_input_required,
          background_color: x.background_color.toUpperCase(),
          is_max_per_stream_enabled: x.maxPerStream > 0, ...(x.maxPerStream > 0 ? { max_per_stream: x.maxPerStream } : {}),
          is_global_cooldown_enabled: x.cooldown > 0, ...(x.cooldown > 0 ? { global_cooldown_seconds: x.cooldown } : {}),
          should_redemptions_skip_request_queue: x.should_redemptions_skip_request_queue,
        };
        try {
          if (reward) await Bot.twitch.updateReward(reward.id, body); else await Bot.twitch.createReward(body);
          await UI.loadRewards();
        } catch (err) {
          alert(`Twitch said: ${err.message}`);
        }
        UI.rerender();
      },
    });
  }

  UI.addTab('rewards', 'Rewards', (panel) => {
    const login = UI.needsLogin();
    panel.append(UI.lead('Your channel point rewards, with effects of their own. Rewards made here can also be turned on and off by effects, and completed or refunded automatically; ones made on Twitch can only run effects.'));
    if (login) { panel.append(login); return; }
    const status = UI.status();
    panel.append(UI.row(
      UI.button('+ New reward', () => editReward(null), { cls: 'btn small primary' }),
      UI.button('Refresh', (e) => UI.busy(e.currentTarget, async () => { await UI.loadRewards(); UI.rerender(); }, status)),
    ), status);
    const list = UI.rewardsCache;
    if (!list) {
      panel.append(h('p', { class: 'hint' }, 'Loading your rewards…'));
      UI.loadRewards().then(UI.rerender).catch((err) => UI.say(status, err.message, true));
      return;
    }
    const toggle = (r, field, value) => UI.busy(document.activeElement, async () => { await Bot.twitch.updateReward(r.id, { [field]: value }); await UI.loadRewards(); UI.rerender(); }, status);
    panel.append(UI.table(
      [{ label: '' }, { label: 'Reward' }, { label: 'Cost', cls: 'num' }, { label: 'State' }, { label: 'Effects' }, { label: '', cls: 'c-act' }],
      list.map((r) => {
        const action = Bot.data.rewardActions[r.id];
        return {
          off: !r.is_enabled,
          cells: [
            h('span', { class: 'swatch', style: `background:${r.background_color || '#9147ff'}` }),
            h('span', {}, r.title, r.manageable ? h('span', { class: 'pill' }, 'made here') : null, r.is_user_input_required ? h('span', { class: 'hint' }, ' · asks for text') : null),
            r.cost.toLocaleString(),
            !r.is_enabled ? 'Off' : r.is_paused ? 'Paused' : 'On',
            action && action.effects.length ? `${plural(action.effects.length, 'effect')}${action.enabled === false ? ' (off)' : ''}` : '–',
            h('span', { class: 'bot-row-actions' },
              UI.button('Effects', () => editRewardAction(r)),
              r.manageable ? UI.button(r.is_enabled ? 'Turn off' : 'Turn on', () => toggle(r, 'is_enabled', !r.is_enabled)) : null,
              r.manageable ? UI.button(r.is_paused ? 'Unpause' : 'Pause', () => toggle(r, 'is_paused', !r.is_paused)) : null,
              r.manageable ? UI.button('Change', () => editReward(r)) : null,
              r.manageable ? UI.button('🗑', () => {
                if (!confirm(`Delete the reward “${r.title}” from Twitch?`)) return;
                UI.busy(document.activeElement, async () => { await Bot.twitch.deleteReward(r.id); delete Bot.data.rewardActions[r.id]; save(); await UI.loadRewards(); UI.rerender(); }, status);
              }, { cls: 'x', aria: `Delete ${r.title}`, title: 'Delete' }) : null),
          ],
        };
      }),
      { empty: 'No custom rewards on your channel yet.' },
    ));
  });

  // -------------------------------------------------------------------------
  // Timers
  // -------------------------------------------------------------------------

  function editTimer(t, isNew) {
    UI.edit({
      title: isNew ? 'New timer' : `Timer: ${t.name}`,
      item: t,
      build: (x) => [
        UI.field('Name', UI.text(x, 'name')),
        UI.row(
          UI.field('Every (minutes)', UI.number(x, 'interval', { min: 1, max: 1440 })),
          UI.field('Only after this many chat messages', UI.number(x, 'minLines', { min: 0, max: 10000 })),
        ),
        UI.check(x, 'onlyLive', 'Only while live'),
        h('div', { class: 'field nested' }, h('div', { class: 'row-label' }, 'What happens'), UI.effects(x.effects)),
      ],
      onTest: (x) => Bot.effects.run(x.effects, UI.testContext()),
      onSave: (x) => {
        const i = Bot.data.timers.findIndex((y) => y.id === x.id);
        if (i === -1) Bot.data.timers.push(x); else Bot.data.timers[i] = x;
        save();
        UI.rerender();
      },
    });
  }

  UI.addTab('timers', 'Timers', (panel) => {
    panel.append(
      UI.lead('Effects that repeat while you stream: a reminder to follow, your socials, a hydration alert. A timer waits until enough chat has happened since it last ran, so a quiet chat isn’t filled with them.'),
      UI.row(UI.button('+ New timer', () => editTimer(Bot.timers.newTimer(), true), { cls: 'btn small primary' })),
      UI.table(
        [{ label: 'On', cls: 'c-on' }, { label: 'Name' }, { label: 'Every' }, { label: 'After' }, { label: 'Live only' }, { label: '', cls: 'c-act' }],
        Bot.data.timers.map((t) => ({
          off: !t.enabled,
          cells: [
            UI.toggle(t, 'enabled', `${t.name} is on`, UI.rerender),
            t.name,
            `${t.interval} min`,
            plural(t.minLines || 0, 'message'),
            t.onlyLive ? 'yes' : 'no',
            h('span', { class: 'bot-row-actions' },
              UI.button('Edit', () => editTimer(Bot.clone(t), false)),
              UI.button('▶', () => Bot.timers.run(t), { cls: 'x', aria: `Run ${t.name} now`, title: 'Run now' }),
              UI.button('🗑', () => { if (confirm(`Delete “${t.name}”?`)) { Bot.data.timers = Bot.data.timers.filter((x) => x !== t); save(); UI.rerender(); } }, { cls: 'x', aria: 'Delete', title: 'Delete' })),
          ],
        })),
        { empty: 'No timers yet.' },
      ),
      UI.field('At least this many seconds between two timers', UI.number(Bot.data.timerSettings, 'minGapSeconds', { min: 0, max: 3600, onChange: save })),
    );
  });

  // -------------------------------------------------------------------------
  // Effect lists
  // -------------------------------------------------------------------------

  function editList(l, isNew) {
    UI.edit({
      title: isNew ? 'New effect list' : `Effect list: ${l.name}`,
      item: l,
      build: (x) => [
        UI.field('Name', UI.text(x, 'name')),
        UI.field('Arguments it takes (for you)', UI.text(x, 'args', { placeholder: 'e.g. 1: the user, 2: the amount' }), 'Read them with $listArg[1], $listArg[2]… Handed over by the “Run effect list” effect or the HTTP API.'),
        UI.field('Queue', UI.text(x, 'queue', { placeholder: 'e.g. alerts' })),
        h('div', { class: 'field nested' }, h('div', { class: 'row-label' }, 'Effects'), UI.effects(x.effects, { fields: [['listArg[1]', 'First argument'], ['listArg[2]', 'Second argument']] })),
      ],
      onTest: (x) => Bot.effects.run(x.effects, UI.testContext()),
      onSave: (x) => {
        const i = Bot.data.lists.findIndex((y) => y.id === x.id);
        if (i === -1) Bot.data.lists.push(x); else Bot.data.lists[i] = x;
        save();
        UI.rerender();
      },
    });
  }

  const apiUrl = (l) => `${(Bot.overlayStatus && Bot.overlayStatus.url) || `http://127.0.0.1:${Bot.data.overlay.port}/`}api/run/${encodeURIComponent(l.id)}?key=${Bot.data.overlay.apiKey}`;

  UI.addTab('lists', 'Effect lists', (panel) => {
    panel.append(
      UI.lead('Effects you use in more than one place. Run them from a command or event with “Run effect list”, from a hotkey, from the Dashboard, or from a Stream Deck through the HTTP API.'),
      UI.row(UI.button('+ New effect list', () => editList(Bot.lists.newList(), true), { cls: 'btn small primary' })),
      UI.table(
        [{ label: 'Name' }, { label: 'Arguments' }, { label: 'Effects', cls: 'num' }, { label: '', cls: 'c-act' }],
        Bot.data.lists.map((l) => ({
          cells: [
            l.name,
            l.args || '–',
            String(l.effects.length),
            h('span', { class: 'bot-row-actions' },
              UI.button('Edit', () => editList(Bot.clone(l), false)),
              UI.button('▶', () => Bot.lists.run(l.id), { cls: 'x', aria: `Run ${l.name}`, title: 'Run now' }),
              UI.copyButton(() => apiUrl(l), 'Copy API link'),
              UI.button('🗑', () => { if (confirm(`Delete “${l.name}”?`)) { Bot.data.lists = Bot.data.lists.filter((x) => x !== l); save(); UI.rerender(); } }, { cls: 'x', aria: 'Delete', title: 'Delete' })),
          ],
        })),
        { empty: 'No effect lists yet.' },
      ),
    );
  });

  // -------------------------------------------------------------------------
  // Hotkeys and the HTTP API
  // -------------------------------------------------------------------------

  function keyCapture(hk, onChange) {
    const button = UI.button('', () => (capturing ? stop() : start()), { cls: 'btn small keycap' });
    let capturing = false;
    const label = () => (hk.binding ? Bot.host.keyLabel(hk.binding) : 'Set keys');
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') { stop(); return; }
      if (/^(Shift|Control|Alt|Meta|OS)(Left|Right)?$/.test(e.code)) return;
      hk.binding = e.code === 'Backspace' || e.code === 'Delete' ? null : { code: e.code, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey };
      stop();
      onChange();
    };
    function start() {
      capturing = true;
      button.classList.add('capturing');
      button.textContent = 'Press keys…';
      window.addEventListener('keydown', onKey, true);
    }
    function stop() {
      capturing = false;
      button.classList.remove('capturing');
      button.textContent = label();
      window.removeEventListener('keydown', onKey, true);
    }
    button.textContent = label();
    button.setAttribute('aria-label', `Keys for ${hk.name}: ${label()}. Activate, then press the keys you want.`);
    return button;
  }

  function editHotkey(hk, isNew) {
    UI.edit({
      title: isNew ? 'New hotkey' : `Hotkey: ${hk.name}`,
      item: hk,
      build: (x, rebuild) => [
        UI.row(UI.field('Name', UI.text(x, 'name')), h('div', { class: 'field' }, h('span', { class: 'row-label' }, 'Keys'), keyCapture(x, rebuild))),
        h('div', { class: 'field nested' }, h('div', { class: 'row-label' }, 'What happens'), UI.effects(x.effects)),
      ],
      onTest: (x) => Bot.effects.run(x.effects, UI.testContext()),
      onSave: (x) => {
        const i = Bot.data.hotkeys.findIndex((y) => y.id === x.id);
        if (i === -1) Bot.data.hotkeys.push(x); else Bot.data.hotkeys[i] = x;
        save();
        Bot.host.syncHotkeys();
        UI.rerender();
      },
    });
  }

  UI.addTab('hotkeys', 'Hotkeys & API', (panel) => {
    const problems = Bot.host.hotkeyProblems();
    panel.append(
      UI.lead('Keys that run effects, working while a game is focused (like the reader’s own shortcuts under Settings → Keys). An ordinary key needs a modifier such as Alt; F-keys can be used alone.'),
      UI.row(UI.button('+ New hotkey', () => editHotkey(Bot.hotkeys.newHotkey(), true), { cls: 'btn small primary' })),
      UI.table(
        [{ label: 'On', cls: 'c-on' }, { label: 'Name' }, { label: 'Keys' }, { label: 'Effects', cls: 'num' }, { label: '', cls: 'c-act' }],
        Bot.data.hotkeys.map((hk) => ({
          off: hk.enabled === false,
          cells: [
            UI.toggle(hk, 'enabled', `${hk.name} is on`, () => { Bot.host.syncHotkeys(); UI.rerender(); }),
            hk.name,
            h('span', {}, keyCapture(hk, () => { save(); Bot.host.syncHotkeys(); setTimeout(UI.rerender, 300); }), problems[`bot:${hk.id}`] ? h('span', { class: 'hint warn-text' }, ` ${problems[`bot:${hk.id}`]}`) : null),
            String(hk.effects.length),
            h('span', { class: 'bot-row-actions' },
              UI.button('Edit', () => editHotkey(Bot.clone(hk), false)),
              UI.button('▶', () => Bot.hotkeys.run(`bot:${hk.id}`), { cls: 'x', aria: `Run ${hk.name}`, title: 'Run now' }),
              UI.button('🗑', () => { if (confirm(`Delete “${hk.name}”?`)) { Bot.data.hotkeys = Bot.data.hotkeys.filter((x) => x !== hk); save(); Bot.host.syncHotkeys(); UI.rerender(); } }, { cls: 'x', aria: 'Delete', title: 'Delete' })),
          ],
        })),
        { empty: 'No hotkeys yet.' },
      ),
    );

    const base = (Bot.overlayStatus && Bot.overlayStatus.url) || `http://127.0.0.1:${Bot.data.overlay.port}/`;
    const keyBox = h('code', { class: 'code-box' }, Bot.data.overlay.apiKey);
    panel.append(UI.section('HTTP API (Stream Deck and other tools)',
      UI.lead('Runs an effect list from anything that can open a web address on this computer. On a Stream Deck, use the “Website” action with “Access in background”.'),
      h('p', { class: 'code-box' }, `${base}api/run/<effect list name or id>?key=…`),
      h('p', { class: 'hint' }, `Add &arg=… for $listArg[1], and again for $listArg[2]. ${base}api/lists?key=… lists them all. Every effect list has a “Copy API link” button.`),
      UI.row(h('span', { class: 'row-label' }, 'Key'), keyBox, UI.copyButton(() => Bot.data.overlay.apiKey), UI.button('New key', async () => {
        if (!confirm('Make a new key? Links with the old one stop working.')) return;
        Bot.data.overlay.apiKey = Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(16).padStart(2, '0')).join('');
        save();
        await Bot.applyOverlay();
        UI.rerender();
      })),
      h('p', { class: 'hint' }, 'Keep the key to yourself: with it, anything on this computer can run your effect lists.')));
  });

  // -------------------------------------------------------------------------
  // Counters
  // -------------------------------------------------------------------------

  UI.addTab('counters', 'Counters', (panel) => {
    const add = { name: '' };
    const base = (Bot.overlayStatus && Bot.overlayStatus.url) || `http://127.0.0.1:${Bot.data.overlay.port}/`;
    const addIt = () => {
      const name = add.name.trim();
      if (!name || Bot.counters.find(name)) return;
      Bot.data.counters.push({ id: Bot.uid('n'), name, value: 0, min: '', max: '', file: '' });
      save();
      UI.rerender();
    };
    const nameInput = UI.text(add, 'name', { placeholder: 'e.g. deaths' });
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addIt(); } });
    panel.append(
      UI.lead('Numbers that commands and events change with the “Update counter” effect, and read back with $counter[name]: deaths, wins, hugs. Show one on stream with its overlay link as a browser source, or have it written to a text file for OBS.'),
      UI.row(nameInput, UI.button('+ Add counter', addIt, { cls: 'btn small primary' })),
      UI.table(
        [{ label: 'Name' }, { label: 'Value' }, { label: 'Min / max' }, { label: 'Text file' }, { label: 'Overlay' }, { label: '' }],
        Bot.data.counters.map((c) => {
          const value = UI.number(c, 'value', { onChange: () => { save(); Bot.counters.publish(c); } });
          return {
            cells: [
              UI.text(c, 'name', { onChange: save }),
              h('span', { class: 'bot-inline' },
                UI.button('−', () => { Bot.counters.update(c.name, 'subtract', 1); value.value = c.value; }, { cls: 'btn small', aria: `Take one off ${c.name}` }),
                value,
                UI.button('+', () => { Bot.counters.update(c.name, 'add', 1); value.value = c.value; }, { cls: 'btn small', aria: `Add one to ${c.name}` })),
              h('span', { class: 'bot-inline' }, UI.text(c, 'min', { placeholder: 'min', onChange: save, cls: 'short' }), UI.text(c, 'max', { placeholder: 'max', onChange: save, cls: 'short' })),
              UI.file(c, 'file', { kind: 'text', save: true, defaultName: `${c.name}.txt`, onChange: () => { save(); Bot.counters.publish(c); } }),
              UI.copyButton(() => `${base}?counter=${encodeURIComponent(c.name)}`, 'Copy link'),
              UI.button('🗑', () => { if (confirm(`Delete the counter “${c.name}”?`)) { Bot.data.counters = Bot.data.counters.filter((x) => x !== c); save(); UI.rerender(); } }, { cls: 'x', aria: `Delete ${c.name}`, title: 'Delete' }),
            ],
          };
        }),
        { empty: 'No counters yet.' },
      ),
      UI.section('Custom variables',
        UI.lead('Set with the “Set variable” effect, read with $var[name].'),
        UI.table([{ label: 'Name' }, { label: 'Value' }, { label: '' }], Object.entries(Bot.data.variables).map(([k, v]) => ({
          cells: [h('code', {}, k), UI.text(Bot.data.variables, k, { onChange: save }), UI.button('🗑', () => { delete Bot.data.variables[k]; save(); UI.rerender(); }, { cls: 'x', aria: `Delete ${k}`, title: 'Delete' })],
        })), { empty: 'None set yet.' })),
    );
  }, { listens: ['counters'] });

  // -------------------------------------------------------------------------
  // Viewers
  // -------------------------------------------------------------------------

  UI.addTab('viewers', 'Viewers', (panel) => {
    const q = UI.viewerQuery || { text: '', sort: 'lastSeen' };
    UI.viewerQuery = q;
    const all = Object.values(Bot.viewers.users);
    const search = UI.text(q, 'text', { type: 'search', placeholder: 'Find a viewer' });
    const tableBox = h('div', {});
    const draw = () => {
      const t = q.text.trim().toLowerCase();
      const list = all.filter((v) => !t || v.login.includes(t) || String(v.displayName).toLowerCase().includes(t))
        .sort((a, b) => (q.sort === 'name' ? a.login.localeCompare(b.login) : (b[q.sort] || 0) - (a[q.sort] || 0)))
        .slice(0, 150);
      tableBox.replaceChildren(UI.table(
        [{ label: 'Viewer' }, { label: 'Messages', cls: 'num' }, { label: 'Watched' }, { label: Bot.data.currency.name, cls: 'num' }, { label: 'First seen' }, { label: 'Last seen' }, { label: '' }],
        list.map((v) => ({
          cells: [
            h('span', {}, v.displayName || v.login, v.platform !== 'twitch' ? h('span', { class: 'platform', 'data-platform': v.platform }, { youtube: 'YouTube', tiktok: 'TikTok' }[v.platform]) : null),
            String(v.messages || 0),
            Bot.duration((v.minutes || 0) * 60),
            UI.number(v, 'currency', { min: 0, onChange: () => { Bot.saveViewers(); } }),
            UI.date(v.firstSeen),
            UI.date(v.lastSeen),
            UI.button('🗑', () => { if (confirm(`Forget ${v.displayName}? Their points and watch time are deleted.`)) { Bot.viewersDb.remove(v.key); UI.rerender(); } }, { cls: 'x', aria: `Forget ${v.displayName}`, title: 'Forget' }),
          ],
        })),
        { empty: all.length ? 'Nobody matches.' : 'Viewers are added as they chat and while they watch.' },
      ));
    };
    search.addEventListener('input', draw);
    const status = UI.status();
    panel.append(
      UI.lead(`${plural(all.length, 'viewer')} so far. Everyone who chats is added, and while you’re live so is everyone in the chatters list, lurkers too.`),
      UI.row(search,
        UI.select(q, 'sort', [['lastSeen', 'Last seen'], ['currency', `Most ${Bot.data.currency.name}`], ['minutes', 'Most watched'], ['messages', 'Most messages'], ['firstSeen', 'Newest'], ['name', 'Name']], { label: 'Sort by', onChange: draw }),
        UI.button('Export CSV…', async () => {
          const r = await Bot.desktop.pickFile({ kind: 'csv', save: true, defaultName: 'viewers.csv' });
          if (!r.path) return;
          const res = await Bot.desktop.writeFile({ file: r.path, text: Bot.viewersDb.csv() });
          UI.say(status, res.error ? res.error : `Saved to ${r.path}`, !!res.error);
        })),
      status,
      tableBox,
    );
    draw();

    // Custom roles.
    const role = { name: '' };
    panel.append(UI.section('Custom roles',
      UI.lead('Named lists of viewers, for commands only they can use (pick the role under “Who can use it”).'),
      ...Bot.data.roles.map((r) => h('div', { class: 'bot-role' },
        UI.field('Role', UI.text(r, 'name', { onChange: save })),
        UI.field('Members (logins, separated by commas or spaces)', h('textarea', {
          rows: 2, spellcheck: 'false',
          oninput: (e) => { r.users = e.target.value.split(/[\s,]+/).filter(Boolean); save(); },
        }, r.users.join(', '))),
        UI.button('🗑', () => { if (confirm(`Delete the role “${r.name}”?`)) { Bot.data.roles = Bot.data.roles.filter((x) => x !== r); save(); UI.rerender(); } }, { cls: 'x', aria: `Delete ${r.name}`, title: 'Delete' }))),
      UI.row(UI.text(role, 'name', { placeholder: 'e.g. Regulars' }), UI.button('+ Add role', () => {
        if (!role.name.trim()) return;
        Bot.data.roles.push({ id: Bot.uid('r'), name: role.name.trim(), users: [] });
        save();
        UI.rerender();
      }))));
  }, { listens: ['viewers'] });

  // -------------------------------------------------------------------------
  // Points and games
  // -------------------------------------------------------------------------

  UI.addTab('points', 'Points & games', (panel) => {
    const cur = Bot.data.currency;
    const g = Bot.data.games;
    const game = (key, title, extra = []) => {
      const x = g[key];
      return UI.section(title,
        UI.check(x, 'enabled', `Turn on ${title.toLowerCase()}`, { onChange: () => { save(); UI.rerender(); } }),
        UI.row(
          UI.field('Command', UI.text(x, 'trigger', { onChange: save })),
          UI.field('Smallest bet', UI.number(x, 'minBet', { min: 1, max: 1e9, onChange: save })),
          UI.field('Biggest bet (0 = any)', UI.number(x, 'maxBet', { min: 0, max: 1e9, onChange: save })),
        ),
        UI.row(
          UI.field('Chance to win (%)', UI.number(x, 'chance', { min: 0, max: 100, onChange: save })),
          UI.field('Pays the bet ×', UI.number(x, 'multiplier', { min: 1, max: 100, step: 0.1, onChange: save })),
          UI.field('Cooldown (s)', UI.number(x, 'cooldown', { min: 0, max: 86400, onChange: save })),
        ),
        ...extra);
    };
    const raffle = Bot.games.raffle;
    const rStatus = UI.status();
    panel.append(
      UI.section('Points',
        UI.check(cur, 'enabled', 'Give viewers points for watching', { onChange: () => { save(); UI.rerender(); } }),
        UI.row(
          UI.field('They’re called', UI.text(cur, 'name', { onChange: save })),
          UI.field('Per minute', UI.number(cur, 'perMinute', { min: 0, max: 1e6, step: 0.1, onChange: save })),
          UI.field('Extra per minute for subs', UI.number(cur, 'subBonus', { min: 0, max: 1e6, step: 0.1, onChange: save })),
        ),
        UI.row(
          UI.field('New viewers start with', UI.number(cur, 'startAmount', { min: 0, max: 1e9, onChange: save })),
          UI.field('Most anyone can have (0 = no limit)', UI.number(cur, 'max', { min: 0, max: 1e12, onChange: save })),
        ),
        UI.check(cur, 'whileOffline', 'Also while you’re offline', { onChange: save }),
        UI.check(cur, 'activeOnly', 'Only for viewers who chatted in the last 15 minutes', { onChange: save }),
        h('p', { class: 'hint' }, `Viewers check theirs with !${cur.name.toLowerCase().replace(/\s+/g, '')} (rename it under Commands → Built in) and the leaderboard with !top. Give points with the “Change points” effect, e.g. for a follow or a cheer.`)),
      game('slots', 'Slots', [UI.field('Symbols', UI.text(g.slots, 'symbols', { onChange: save }))]),
      game('gamble', 'Gamble'),
      game('heist', 'Heist', [
        UI.row(
          UI.field('Seconds to join', UI.number(g.heist, 'joinSeconds', { min: 10, max: 600, onChange: save })),
          UI.field('Fewest people', UI.number(g.heist, 'minUsers', { min: 1, max: 100, onChange: save })),
        ),
        UI.field('When it starts', UI.text(g.heist, 'startText', { vars: true, extraVars: [['trigger', 'The command'], ['seconds', 'Seconds to join']], onChange: save })),
        UI.field('When someone joins (empty = say nothing)', UI.text(g.heist, 'joinText', { vars: true, onChange: save })),
        UI.field('When some win', UI.text(g.heist, 'successText', { vars: true, extraVars: [['winners', 'Who won what']], onChange: save })),
        UI.field('When everyone loses', UI.text(g.heist, 'failText', { vars: true, onChange: save })),
      ]),
      UI.section('Raffle',
        UI.lead('Open entries, let chat join with a command, then draw. Mods can also type !raffle start <prize>, !raffle close and !raffle draw.'),
        UI.row(
          UI.field('Command to enter', UI.text(g.raffle, 'trigger', { onChange: save })),
          UI.field('Who can enter', UI.select(g.raffle, 'permission', UI.permissionOptions(), { onChange: save })),
          UI.field(`Costs (${cur.name})`, UI.number(g.raffle, 'cost', { min: 0, max: 1e9, onChange: save })),
          UI.field('Winners', UI.number(g.raffle, 'winners', { min: 1, max: 50, onChange: save })),
        ),
        UI.check(g.raffle, 'announce', 'Say in chat when it opens, closes and who won', { onChange: save }),
        h('div', { class: 'bot-raffle' },
          h('strong', {}, raffle.open ? `Open${raffle.prize ? ` for ${raffle.prize}` : ''}: ${plural(raffle.entries.size, 'entry', 'entries')}` : `Closed · ${plural(raffle.entries.size, 'entry', 'entries')}`),
          raffle.winners && raffle.winners.length ? h('span', {}, ` · Won by ${raffle.winners.map((w) => w.displayName).join(', ')}`) : null,
          UI.row(
            raffle.open ? UI.button('Close entries', () => Bot.games.raffleAction('close')) : UI.button('Open entries', () => {
              const prize = prompt('What’s being given away? (optional)') || '';
              Bot.games.raffleAction('start', prize);
            }, { cls: 'btn small primary' }),
            UI.button('Draw', (e) => UI.busy(e.currentTarget, () => Bot.games.raffleAction('draw'), rStatus), { disabled: !raffle.entries.size }),
            UI.button('Clear', () => Bot.games.raffleAction('clear'), { disabled: !raffle.entries.size }),
          ),
          raffle.entries.size ? h('p', { class: 'hint' }, [...raffle.entries.values()].map((u) => u.displayName).join(', ')) : null,
          rStatus),
      ),
    );
  }, { listens: ['raffle'] });

  // -------------------------------------------------------------------------
  // Quotes
  // -------------------------------------------------------------------------

  UI.addTab('quotes', 'Quotes', (panel) => {
    const add = { text: '', author: '' };
    panel.append(
      UI.lead('Things said on stream, kept by number. In chat: !quote, !quote 12, !quote search word, and for mods !quote add @who what they said, !quote del 12.'),
      UI.row(
        UI.text(add, 'text', { placeholder: 'What was said' }),
        UI.text(add, 'author', { placeholder: 'Who said it' }),
        UI.button('+ Add quote', async () => {
          if (!add.text.trim()) return;
          await Bot.quotes.add(add.text, Bot.twitch.streamerLogin(), add.author.trim().replace(/^@/, ''));
          UI.rerender();
        }, { cls: 'btn small primary' }),
      ),
      UI.table(
        [{ label: '#', cls: 'num' }, { label: 'Quote' }, { label: 'By' }, { label: 'Category' }, { label: 'Date' }, { label: '' }],
        [...Bot.data.quotes.list].reverse().map((q) => ({
          cells: [
            String(q.id),
            UI.text(q, 'text', { onChange: save }),
            UI.text(q, 'author', { onChange: save, cls: 'short' }),
            UI.text(q, 'game', { onChange: save, cls: 'short' }),
            UI.date(q.date),
            UI.button('🗑', () => { if (confirm(`Delete quote #${q.id}?`)) { Bot.quotes.remove(q.id); UI.rerender(); } }, { cls: 'x', aria: `Delete quote ${q.id}`, title: 'Delete' }),
          ],
        })),
        { empty: 'No quotes yet.' },
      ),
    );
  });

  // -------------------------------------------------------------------------
  // Moderation
  // -------------------------------------------------------------------------

  UI.addTab('moderation', 'Moderation', (panel) => {
    const m = Bot.data.moderation;
    const rule = (key, label, fields) => h('div', { class: 'bot-rule' }, UI.check(m[key], 'enabled', label, { onChange: save }), fields ? UI.row(...fields) : null);
    const test = { text: '' };
    const tStatus = UI.status();
    panel.append(
      UI.needsLogin() || '',
      UI.lead('The bot deletes or times out messages that break your rules, on your Twitch chat. Mods and you are never moderated.'),
      UI.check(m, 'enabled', 'Moderate my chat', { onChange: save }),
      UI.row(
        UI.field('Leave alone', UI.select(m, 'exempt', [['everyone', 'Nobody is moderated'], ['subs', 'Subscribers and up'], ['vips', 'VIPs and up'], ['mods', 'Only mods']], { onChange: save })),
        UI.field('When a rule is broken', UI.select(m, 'action', [['delete', 'Delete the message'], ['timeout', 'Time them out']], { onChange: save })),
        UI.field('Timeout (s)', UI.number(m, 'timeoutSeconds', { min: 1, max: 1209600, onChange: save })),
      ),
      UI.check(m, 'escalate', 'Be stricter with repeat offenders: the first time deletes, after that timeouts get longer', { onChange: save }),
      UI.field('Warning in chat (empty = none)', UI.text(m, 'warnText', { vars: true, extraVars: [['reason', 'Why']], onChange: save })),
      UI.section('Banned words',
        UI.field('Words and phrases, one per line. * matches the rest of a word: “idiot*”', UI.text(m, 'bannedWords', { multiline: true, rows: 4, onChange: save })),
        UI.field('Regular expressions, one per line', UI.text(m, 'bannedRegex', { multiline: true, rows: 2, onChange: save })),
        UI.field('For banned words', UI.select(m, 'bannedAction', [['delete', 'Delete the message'], ['timeout', 'Time them out'], ['ban', 'Ban them']], { onChange: save }))),
      UI.section('Rules',
        rule('links', 'No links, unless permitted', [
          UI.field('Always allowed (start of the address, separated by spaces)', UI.text(m.links, 'allowed', { onChange: save })),
          UI.field('Permit command', UI.text(m.links, 'permitTrigger', { onChange: save })),
          UI.field('Permit lasts (s)', UI.number(m.links, 'permitSeconds', { min: 10, max: 3600, onChange: save })),
        ]),
        rule('caps', 'Not too many capitals', [
          UI.field('In messages longer than', UI.number(m.caps, 'minLength', { min: 1, max: 500, onChange: save })),
          UI.field('More than (%)', UI.number(m.caps, 'percent', { min: 1, max: 100, onChange: save })),
        ]),
        rule('symbols', 'Not too many symbols', [
          UI.field('In messages longer than', UI.number(m.symbols, 'minLength', { min: 1, max: 500, onChange: save })),
          UI.field('More than (%)', UI.number(m.symbols, 'percent', { min: 1, max: 100, onChange: save })),
        ]),
        rule('emotes', 'Not too many emotes', [UI.field('More than', UI.number(m.emotes, 'max', { min: 1, max: 200, onChange: save }))]),
        rule('length', 'Not too long', [UI.field('Characters', UI.number(m.length, 'max', { min: 20, max: 500, onChange: save }))]),
        rule('repeats', 'No repeating the same message', [
          UI.field('Times', UI.number(m.repeats, 'count', { min: 2, max: 20, onChange: save })),
          UI.field('Within (s)', UI.number(m.repeats, 'seconds', { min: 5, max: 600, onChange: save })),
        ])),
      UI.section('Try a message',
        UI.row(UI.text(test, 'text', { placeholder: 'Type a message to check' }), UI.button('Check', async () => {
          const p = await Bot.moderation.test(test.text);
          UI.say(tStatus, p ? `Would be moderated: ${p.reason}` : 'That one is fine.', !!p);
        })),
        tStatus),
    );
  });

  // -------------------------------------------------------------------------
  // Overlay
  // -------------------------------------------------------------------------

  UI.addTab('overlay', 'Overlay', (panel) => {
    const o = Bot.data.overlay;
    const s = Bot.overlayStatus || {};
    const status = UI.status();
    const url = s.url || `http://127.0.0.1:${o.port}/`;
    panel.append(
      UI.lead('Alerts, pictures, videos, text and counters appear on stream through an overlay: a web page OBS shows as a browser source.'),
      h('div', { class: 'bot-card', 'data-state': s.running ? 'on' : s.error ? 'error' : '' },
        h('div', { class: 'bot-card-title' }, 'Overlay'),
        h('div', { class: 'bot-card-value' }, s.running ? `Running · ${plural(s.clients || 0, 'overlay')} open` : 'Not running'),
        s.error ? h('div', { class: 'hint bad' }, s.error) : null),
      UI.check(o, 'enabled', 'Run the overlay', { onChange: async () => { save(); await Bot.applyOverlay(); UI.rerender(); } }),
      UI.row(UI.field('Port', UI.number(o, 'port', { min: 1024, max: 65535 })), UI.button('Apply', async () => { save(); await Bot.applyOverlay(); UI.rerender(); })),
      UI.section('Add it to OBS',
        h('ol', { class: 'bot-steps' },
          h('li', {}, 'In OBS, add a source: + → Browser.'),
          h('li', {}, 'URL: ', h('code', { class: 'code-box' }, url), ' ', UI.copyButton(() => url)),
          h('li', {}, 'Width 1920, height 1080 (or your canvas size). Tick “Control audio via OBS” to hear its sounds on stream.'),
          h('li', {}, 'Put it on top of your scenes. Every alert, picture, video and text shows up there.')),
        UI.row(UI.button('Open it in the browser', () => Bot.desktop.openOverlay()), UI.button('Send a test alert', () => Bot.effects.run([{ ...Bot.effects.newEffect('alert'), title: 'It works!', message: 'This is a test alert from Chat Reader.' }], UI.testContext()))),
        status),
      UI.section('Instances',
        UI.lead('Several overlays can show different things: add ?instance=name to the URL (e.g. one for alerts, one for a camera frame) and pick that instance in an effect’s “More options”. An effect with no instance shows on every overlay.')),
      UI.section('Counters on stream',
        UI.lead('A counter alone, updating live: add ?counter=name to the URL, e.g.'),
        h('p', { class: 'code-box' }, `${url}?counter=deaths&label=Deaths: &size=64&color=ffffff`),
        h('p', { class: 'hint' }, 'label is shown before the number; size is in pixels; color is a hex colour without the #.')),
    );
  }, { listens: ['overlay'] });

  // -------------------------------------------------------------------------
  // OBS
  // -------------------------------------------------------------------------

  UI.addTab('obs', 'OBS', (panel) => {
    const o = Bot.data.obs;
    const pw = { value: '' };
    const status = UI.status();
    const password = UI.text(pw, 'value', { type: 'password', placeholder: 'Leave empty to keep the saved one' });
    panel.append(
      UI.lead('Switch scenes, show and hide sources, toggle filters and start recording from effects, and react to OBS in Events. In OBS: Tools → WebSocket Server Settings → Enable WebSocket server, then Show Connect Info for the password.'),
      h('div', { class: 'bot-card', 'data-state': Bot.obs.state === 'connected' ? 'on' : Bot.obs.state === 'error' ? 'error' : '' },
        h('div', { class: 'bot-card-title' }, 'OBS'),
        h('div', { class: 'bot-card-value' }, { connected: 'Connected', connecting: 'Connecting…', error: 'Not connected', idle: 'Not connected' }[Bot.obs.state]),
        Bot.obs.text ? h('div', { class: 'hint' }, Bot.obs.text) : null),
      UI.row(
        UI.field('Address', UI.text(o, 'url', { onChange: save })),
        UI.field('Password', password),
      ),
      UI.check(o, 'autoConnect', 'Connect when the app starts', { onChange: save }),
      UI.row(
        UI.button(Bot.obs.state === 'connected' || Bot.obs.state === 'connecting' ? 'Reconnect' : 'Connect', async () => {
          if (pw.value) await Bot.desktop.setSecret('obs-password', pw.value);
          o.enabled = true;
          save();
          Bot.obs.connect();
        }, { cls: 'btn small primary' }),
        Bot.obs.state !== 'idle' ? UI.button('Disconnect', () => { o.enabled = false; save(); Bot.obs.disconnect(); }) : null,
      ),
      status,
      Bot.obs.state === 'connected' ? UI.section('Scenes', h('div', { class: 'bot-actions' }, Bot.obs.scenes.map((sc) => UI.button(sc, () => Bot.obs.run('scene', { scene: sc }).catch((err) => UI.say(status, err.message, true)))))) : null,
    );
  }, { listens: ['obs'] });

  // -------------------------------------------------------------------------
  // Account and settings
  // -------------------------------------------------------------------------

  function accountBox(role) {
    const account = Bot.twitch.accounts[role];
    const login = Bot.twitch.login && Bot.twitch.login.role === role ? Bot.twitch.login : null;
    const status = UI.status();
    const scopes = role === 'bot' ? Bot.twitch.BOT_SCOPES : Bot.twitch.STREAMER_SCOPES;
    if (account) {
      const missing = scopes.filter((s) => !(account.scopes || []).includes(s));
      return h('div', { class: 'bot-account' },
        account.avatar ? h('img', { src: account.avatar, alt: '', width: 40, height: 40 }) : null,
        h('div', {}, h('strong', {}, account.displayName), h('div', { class: 'hint' }, role === 'bot' ? 'Bot account: chat replies come from here' : 'Your channel'),
          missing.length ? h('div', { class: 'hint warn-text' }, 'Log in again to allow everything the bot can do now.') : null),
        h('span', { class: 'bot-account-actions' },
          missing.length ? UI.button('Log in again', () => startLogin(role, status)) : null,
          UI.button('Log out', async () => { await Bot.twitch.logout(role); UI.rerender(); })),
        status);
    }
    if (login) {
      return h('div', { class: 'bot-account bot-device' },
        h('div', {},
          h('p', {}, role === 'bot'
            ? 'Open the link in a browser window where you are logged in as the bot account (a private window works), and enter this code:'
            : 'Open twitch.tv/activate, logged in as yourself, and enter this code:'),
          h('div', { class: 'bot-code' }, login.userCode),
          UI.row(
            UI.button('Open twitch.tv/activate', () => external(login.uri), { cls: 'btn small primary' }),
            UI.copyButton(() => login.uri, 'Copy the link'),
            UI.button('Cancel', () => { Bot.twitch.cancelLogin(); UI.rerender(); }),
          ),
          h('p', { class: 'hint' }, 'This page carries on by itself once Twitch has the code.')));
    }
    return h('div', { class: 'bot-account' },
      h('div', {}, h('strong', {}, role === 'bot' ? 'Bot account (optional)' : 'Your Twitch account'),
        h('div', { class: 'hint' }, role === 'bot' ? 'A second Twitch account for the bot to talk as, like “YourNameBot”. Without one, replies come from you.' : 'Needed for everything in the bot.')),
      UI.button(role === 'bot' ? 'Log in the bot account' : 'Log in to Twitch', () => startLogin(role, status), { cls: `btn small${role === 'bot' ? '' : ' primary'}`, disabled: !Bot.data.clientId.trim() || (role === 'bot' && !Bot.twitch.accounts.streamer) }),
      status);
  }

  function startLogin(role, status) {
    Bot.twitch.startLogin(role).then((account) => { if (account) UI.rerender(); }).catch((err) => { UI.rerender(); Bot.log('error', err.message); setTimeout(() => alert(`Logging in didn’t work: ${err.message}`), 50); });
    setTimeout(UI.rerender, 600);
  }

  // What an import found, with a box per kind to take it or leave it.
  function showImport(result, status) {
    const chosen = {};
    for (const [key] of Bot.importers.CATEGORIES) chosen[key] = Bot.importers.count(result, key) > 0;
    UI.edit({
      title: `Import from ${result.source}`,
      saveLabel: 'Import',
      item: chosen,
      build: (x) => [
        UI.lead(`From ${result.name}. Choose what to bring over:`),
        ...Bot.importers.CATEGORIES.filter(([key]) => Bot.importers.count(result, key) > 0).map(([key, label]) => UI.check(x, key, `${label} (${Bot.importers.count(result, key).toLocaleString()})`)),
        Bot.importers.CATEGORIES.every(([key]) => !Bot.importers.count(result, key)) ? h('p', { class: 'warn' }, 'Nothing that can be imported was found.') : null,
        result.unsupported.size ? h('details', { class: 'fx-more', open: true },
          h('summary', {}, 'What has no equal here'),
          h('p', { class: 'hint' }, 'Effects like these are kept as “From another bot (not converted)”, which do nothing, so you can see where something is missing and rebuild it. Events and conditions like these are left out.'),
          h('ul', { class: 'bot-steps' }, [...result.unsupported].sort((a, b) => b[1] - a[1]).map(([what, n]) => h('li', {}, `${what}${n > 1 ? ` × ${n}` : ''}`)))) : null,
        ...result.notes.map((n) => h('p', { class: 'hint' }, n)),
      ],
      onSave: (x) => {
        const { done, skipped } = Bot.importers.apply(result, x);
        const parts = Object.entries(done).filter(([, n]) => n).map(([key, n]) => `${key === 'currency' ? 'points settings' : `${n.toLocaleString()} ${(Bot.importers.CATEGORIES.find(([k]) => k === key) || [key, key])[1].toLowerCase().split(',')[0]}`}`);
        // Kept, because the tab is drawn again right after.
        UI.importNote = `Imported ${parts.join(', ') || 'nothing'}.${skipped.length ? ` Skipped ${skipped.length} command${skipped.length === 1 ? '' : 's'} you already have: ${skipped.slice(0, 8).join(', ')}${skipped.length > 8 ? '…' : ''}.` : ''}`;
        UI.say(status, UI.importNote);
        Bot.log('info', `Imported from ${result.source}: ${parts.join(', ')}`);
        UI.rerender();
      },
    });
  }

  UI.addTab('account', 'Account & settings', (panel) => {
    const d = Bot.data;
    const clientInput = UI.text(d, 'clientId', { placeholder: 'e.g. abcd1234efgh5678…', onChange: () => { d.clientId = d.clientId.trim(); save(); } });
    clientInput.addEventListener('change', UI.rerender);
    panel.append(
      UI.section('1. Your Twitch application',
        UI.lead('The bot logs in through a Twitch application of your own, which takes a minute to make and is free:'),
        h('ol', { class: 'bot-steps' },
          h('li', {}, UI.button('Open dev.twitch.tv', () => external('https://dev.twitch.tv/console/apps/create'), { cls: 'link' }), ' and log in (Twitch asks for two-factor authentication on your account first).'),
          h('li', {}, 'Name: anything, for example “Chat Reader for ', h('em', {}, 'yourname'), '”.'),
          h('li', {}, 'OAuth Redirect URLs: ', h('code', {}, 'http://localhost'), ' (it isn’t used, but Twitch wants one).'),
          h('li', {}, 'Category: Chat Bot. Client Type: ', h('strong', {}, 'Public'), '.'),
          h('li', {}, 'Create, then Manage, and copy the Client ID into this box:')),
        UI.field('Client ID', clientInput)),
      UI.section('2. Log in', accountBox('streamer'), accountBox('bot')),
      UI.section('Chat',
        Bot.twitch.accounts.bot ? UI.field('Replies are sent as', UI.select(d, 'replyAs', [['bot', Bot.twitch.accounts.bot.displayName], ['streamer', 'Me']], { onChange: save })) : null,
        UI.check(d, 'readBotMessages', 'Read the bot’s own chat messages out loud', { onChange: save }),
        UI.check(d, 'skipBotCommands', 'Don’t read out commands meant for the bot, in my channel', { onChange: save }),
        UI.check(d, 'remoteCommands', 'YouTube and TikTok chat can use commands too (replies go to Twitch chat)', { onChange: save })),
    );

    // Where the bot's sounds play.
    const sound = Bot.data.sound;
    const device = h('select', { 'aria-label': 'Sound output' });
    UI.options(device, [['', 'The system’s default output']], sound.device);
    navigator.mediaDevices.enumerateDevices().then((devices) => {
      const outs = devices.filter((x) => x.kind === 'audiooutput' && x.deviceId !== 'default');
      UI.options(device, [['', 'The system’s default output'], ...outs.map((x, i) => [x.deviceId, x.label || `Output ${i + 1}`])], sound.device);
    }).catch(() => {});
    device.addEventListener('change', () => { sound.device = device.value; save(); });
    panel.append(UI.section('Sounds',
      UI.field('Play the bot’s sounds on', device, 'Pick a virtual cable here to keep alert sounds off your headphones but on stream. The reader’s own voice isn’t affected.'),
      UI.field('Volume of every bot sound', UI.range(sound, 'volume', { onChange: save }))));

    // Backup, and importing from other bots.
    const bStatus = UI.status();
    const opts = { withViewers: true };
    panel.append(UI.section('Backup',
      UI.lead('Saves everything in one file — the reader’s settings (voices, filters, nicknames, keys…) and the whole bot: commands, events, timers, effect lists, counters, quotes, multistream and the rest. Your logins are never in it. Settings → Backup saves the same file.'),
      UI.check(opts, 'withViewers', 'Include the viewer list, with points and watch time'),
      UI.row(
        UI.button('Save everything…', async () => {
          const r = await Bot.desktop.pickFile({ kind: 'json', save: true, defaultName: `chat-reader-settings-${new Date().toISOString().slice(0, 10)}.json` });
          if (!r.path) return;
          const text = JSON.stringify({
            kind: 'chat-reader-settings', version: 1, savedAt: new Date().toISOString(),
            settings: Bot.host.settings,
            bot: { setup: Bot.data, ...(opts.withViewers ? { viewers: Bot.viewers } : {}) },
          }, null, 2);
          const res = await Bot.desktop.writeFile({ file: r.path, text });
          UI.say(bStatus, res.error ? `Couldn’t save: ${res.error}` : `Saved to ${r.path}`, !!res.error);
        }),
        UI.button('Load from a file…', async () => {
          const r = await Bot.desktop.pickFile({ kind: 'json' });
          if (!r.path) return;
          const res = await Bot.desktop.readFile(r.path);
          if (res.error) { UI.say(bStatus, res.error, true); return; }
          let data;
          try { data = JSON.parse(res.text); } catch { UI.say(bStatus, 'That file isn’t valid JSON.', true); return; }
          // A full file, a bot-only file from an earlier version, or reader settings alone.
          const bot = data.bot || (data.kind === 'chat-reader-bot' ? data : null);
          const reader = data.settings && typeof data.settings === 'object' ? data.settings : null;
          if (!bot && !reader) { UI.say(bStatus, 'Nothing in that file looked like Chat Reader settings.', true); return; }
          if (!confirm(`Replace ${[reader ? 'the reader’s settings' : '', bot ? 'your whole bot setup' : ''].filter(Boolean).join(' and ')} with what’s in this file?`)) return;
          try {
            const kept = reader ? Bot.host.importReaderSettings(reader) : 0;
            if (bot) Bot.replaceData(bot, { withViewers: opts.withViewers });
            UI.say(bStatus, `Loaded ${[kept ? `${kept} reader settings` : '', bot ? 'the bot setup' : ''].filter(Boolean).join(' and ')}.`);
            UI.rerender();
          } catch (err) { UI.say(bStatus, `That file couldn’t be used: ${err.message}`, true); }
        }),
        UI.button('Start the bot over…', () => {
          if (!confirm('Delete every command, event, timer, effect list, counter and quote? Your login, the reader’s settings and the viewer list stay.')) return;
          Bot.replaceData({ clientId: Bot.data.clientId });
          UI.rerender();
        }, { cls: 'btn small danger' }),
      ),
      bStatus));

    const iStatus = UI.status();
    if (UI.importNote) UI.say(iStatus, UI.importNote);
    const runImport = (kind) => async (e) => {
      const button = e.currentTarget;
      UI.importNote = '';
      UI.say(iStatus, 'Reading…');
      const result = await UI.busy(button, () => Bot.importers.read(kind), iStatus);
      if (!result) { if (!iStatus.classList.contains('bad')) UI.say(iStatus, ''); return; }
      UI.say(iStatus, '');
      showImport(result, iStatus);
    };
    panel.append(UI.section('Import from another bot',
      UI.lead('Brings over commands, events, timers, effect lists, counters, quotes, roles, hotkeys and viewers with their points. Nothing here is replaced: a command that already exists is skipped. You see what was found before anything is added.'),
      UI.row(
        UI.button('Firebot profile folder…', runImport('firebot-folder')),
        UI.button('Firebot setup file…', runImport('firebot-setup')),
        UI.button('Mix It Up backup or file…', runImport('mixitup')),
      ),
      h('p', { class: 'hint' }, 'Firebot: pick Firebot/v5/profiles in your app data folder (Windows: %APPDATA%\\Firebot, macOS: ~/Library/Application Support/Firebot), or a .firebotsetup you exported. Mix It Up: make a backup under Settings → Advanced → Backup Settings and pick the .miubackup, or pick exported .miucommand files. Pictures and sounds stay where they are on disk, so effects that use them work as long as the files are still there.'),
      iStatus));
  }, { listens: ['accounts'] });
})();
