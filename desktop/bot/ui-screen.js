'use strict';

// The Screen reader page: turning it on, its voices (neural ones load from
// here), the zones of each profile (drawn on screen, from a template, or typed
// in), the reading cursor, the lens and the hotkeys. The logic is screen.js.

(() => {
  const h = UI.h;
  const S = Bot.screen;
  const c = () => Bot.data.screen;
  const save = () => Bot.save();
  const IS_MAC = window.chatReaderDesktop.platform === 'darwin';

  const MODE_SHORT = { changes: 'When it changes', 'new-lines': 'New lines', menu: 'Highlighted line', manual: 'When I ask' };
  const pct = (v) => Math.round(v * 1000) / 10;

  // -------------------------------------------------------------------------
  // Voices
  // -------------------------------------------------------------------------

  // The neural voices' loading state, kept from the reader's own events so a
  // progress bar can move without redrawing the page.
  const neural = { state: '', progress: 0, loaded: 0, total: 0, error: '' };
  const neuralNodes = new Set();

  function neuralState() {
    return neural.state || Bot.host.allVoices().neuralState;
  }

  function neuralText() {
    const state = neuralState();
    if (state === 'ready') return `Neural voices are ready${Bot.host.allVoices().neuralDevice === 'webgpu' ? ' (on the GPU)' : ''}.`;
    if (state === 'loading') {
      const mb = (n) => (n / 1e6).toFixed(0);
      return neural.total >= 1e6 ? `Loading neural voices… ${mb(neural.loaded)} of ${mb(neural.total)} MB` : 'Loading neural voices…';
    }
    if (state === 'error') return `Neural voices couldn’t load${neural.error ? `: ${neural.error}` : ''}. A system voice reads instead.`;
    return 'Neural voices aren’t loaded yet.';
  }

  Bot.on('neural', (info) => {
    const before = neuralState();
    Object.assign(neural, { progress: 0, loaded: 0, total: 0, error: '' }, info);
    for (const n of [...neuralNodes]) {
      if (!n.isConnected) { neuralNodes.delete(n); continue; }
      n.text.textContent = neuralText();
      n.bar.hidden = neural.state !== 'loading';
      n.bar.value = neural.progress || 0;
    }
    if (neural.state !== before) Bot.emit('neural-state', neural.state);
  });

  // A line saying how the neural voices are doing, with a progress bar while
  // they load. `button` adds a way to load them (or try again).
  function neuralStatus({ button = true } = {}) {
    const state = neuralState();
    const text = h('span', { role: 'status' }, neuralText());
    const bar = h('progress', { max: 1, value: neural.progress || 0, 'aria-hidden': 'true' });
    bar.hidden = state !== 'loading';
    neuralNodes.add({ text, bar, get isConnected() { return text.isConnected; } });
    const action = button && (state === 'unloaded' || state === 'error')
      ? UI.button(state === 'error' ? 'Try again' : 'Load them now', () => Bot.host.loadNeural(), { cls: 'btn small' })
      : null;
    return h('div', { class: `sr-neural${state === 'error' ? ' warn' : ''}` }, h('div', { class: 'sr-neural-line' }, text, action), bar);
  }

  function voiceLabel(voice) {
    const all = Bot.host.allVoices();
    if (!voice.engine) return 'The reader’s voice';
    const list = voice.engine === 'kokoro' ? all.neural : all.system;
    const v = list.find((x) => x.id === voice.voiceId);
    const name = v ? v.name : 'Default';
    if (voice.engine !== 'kokoro') return name;
    const state = neuralState();
    return state === 'ready' ? `${name} · neural` : `${name} · neural, ${state === 'loading' ? 'loading' : 'not loaded'}`;
  }

  // One list with every voice, neural ones first. Picking a neural voice
  // loads them right here; until they're ready a system voice reads.
  function voicePicker(voice, { sample = 'This is how I sound.', onChange = () => {}, status = true, label = 'Voice' } = {}) {
    const box = h('div', { class: 'sr-voice' });
    const more = { open: false };
    const draw = () => {
      const all = Bot.host.allVoices();
      const lang = (navigator.language || 'en').slice(0, 2);
      const mine = all.system.filter((v) => v.lang.slice(0, 2) === lang);
      const other = all.system.filter((v) => v.lang.slice(0, 2) !== lang);
      const holder = { v: voice.engine ? `${voice.engine}:${voice.voiceId || ''}` : '' };
      const options = [
        ['', 'The reader’s own voice'],
        ...(voice.engine && !voice.voiceId ? [[`${voice.engine}:`, voice.engine === 'kokoro' ? 'A neural voice' : 'A system voice']] : []),
        { group: 'Neural voices · most natural, English', options: all.neural.map((v) => [`kokoro:${v.id}`, v.name]) },
        ...(mine.length ? [{ group: 'System voices · your language', options: mine.map((v) => [`system:${v.id}`, `${v.name} (${v.lang})`]) }] : []),
        ...(other.length ? [{ group: 'System voices · other languages', options: other.map((v) => [`system:${v.id}`, `${v.name} (${v.lang})`]) }] : []),
      ];
      const pick = UI.select(holder, 'v', options, {
        label,
        onChange: (value) => {
          const at = value.indexOf(':');
          voice.engine = at === -1 ? '' : value.slice(0, at);
          voice.voiceId = at === -1 ? '' : value.slice(at + 1);
          if (voice.engine === 'kokoro') Bot.host.loadNeural();
          onChange();
          draw();
          box.querySelector('select').focus();
        },
      });
      const details = h('details', { class: 'fx-more' },
        h('summary', {}, 'Pitch and volume'),
        UI.row(
          voice.engine === 'kokoro' ? null : UI.field('Pitch', UI.range(voice, 'pitch', { min: 0.5, max: 1.5, step: 0.05, suffix: '', onChange })),
          UI.field('Volume', UI.range(voice, 'volume', { min: 0, max: 100, step: 5, onChange }))));
      details.open = more.open;
      details.addEventListener('toggle', () => { more.open = details.open; });
      box.replaceChildren(...[
        UI.row(
          UI.field(label, pick),
          UI.field('Speed', UI.range(voice, 'rate', { min: 0.5, max: 2.5, step: 0.05, suffix: '×', onChange })),
          UI.button('Hear it', () => S.preview(voice, sample))),
        status && voice.engine === 'kokoro' && neuralState() !== 'ready' ? neuralStatus() : null,
        details].filter(Boolean));
    };
    draw();
    // Redrawn when the neural voices finish loading, unless being used.
    const off = Bot.on('neural-state', () => {
      if (!box.isConnected) { off(); return; }
      if (!box.contains(document.activeElement)) draw();
    });
    return box;
  }

  // -------------------------------------------------------------------------
  // Keys
  // -------------------------------------------------------------------------

  function keyCapture(obj, key, name, onChange) {
    let capturing = false;
    const label = () => (obj[key] && obj[key].code ? Bot.host.keyLabel(obj[key]) : 'Not set');
    const button = UI.button('', () => (capturing ? stop() : start()), { cls: 'btn small keycap' });
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') { stop(); return; }
      if (/^(Shift|Control|Alt|Meta|OS)(Left|Right)?$/.test(e.code)) return;
      obj[key] = e.code === 'Backspace' || e.code === 'Delete' ? { code: '' } : { code: e.code, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey };
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
    button.setAttribute('aria-label', `Keys for ${name}: ${label()}. Activate, then press the keys you want. Backspace clears them.`);
    return button;
  }

  // -------------------------------------------------------------------------
  // Only read what matches
  // -------------------------------------------------------------------------

  const REGEX_SITE = 'https://regex101.com/';

  // Ready-made rules. `ask` asks for the word instead.
  const ONLY_SUGGESTIONS = [
    { label: 'My name, or another word (asks which)', ask: true },
    { label: 'Whispers to me (WoW: “[Name] whispers: …”)', rule: '/whispers:/i' },
    { label: 'Party and raid chat (WoW)', rule: '/^\\[(party|party leader|raid|raid leader|raid warning)\\]/i' },
    { label: 'Guild chat (WoW)', rule: '/^\\[(guild|officer)\\]/i' },
    { label: 'Any of several words (change the words after)', rule: '/\\b(help|heal|inc)\\b/i' },
    { label: 'Questions (lines ending in ?)', rule: '/\\?\\s*$/' },
  ];

  function onlyField(z, rebuild) {
    const bad = h('p', { class: 'warn', role: 'status' });
    const tryOut = h('span', { class: 'hint', role: 'status' });
    const sample = { v: '' };
    const check = () => {
      const rule = S.badRule(z.only);
      bad.textContent = rule ? `“${rule}” isn’t a working regular expression, so it’s left out.` : '';
      bad.hidden = !rule;
      if (!sample.v.trim()) { tryOut.textContent = ''; return; }
      tryOut.textContent = S.allowed(z, sample.v) ? '✓ Would be read' : '✗ Would not be read';
    };
    const add = (rule) => {
      const lines = String(z.only || '').split('\n').map((l) => l.trim()).filter(Boolean);
      if (!lines.includes(rule)) lines.push(rule);
      z.only = lines.join('\n');
      rebuild();
    };
    const suggest = UI.select({ v: '' }, 'v', [['', '+ Add a suggestion…'], ...ONLY_SUGGESTIONS.map((x, i) => [String(i), x.label])], {
      label: 'Add a suggestion',
      onChange: (v) => {
        if (v === '') return;
        const pick = ONLY_SUGGESTIONS[Number(v)];
        if (!pick.ask) { add(pick.rule); return; }
        const word = prompt('Which word? Lines with it are read, in any case. Your name, for example:', '');
        if (word && word.trim()) add(word.trim().slice(0, 100));
        else rebuild();
      },
    });
    const sampleInput = UI.text(sample, 'v', { placeholder: 'e.g. [Guild] [Thrall]: hi Chris, need a heal?', onChange: check });
    sampleInput.setAttribute('aria-label', 'A line to try the rules on');
    check();
    return h('div', { class: 'field nested' },
      h('div', { class: 'row-label' }, 'Only read'),
      UI.text(z, 'only', { multiline: true, rows: 3, placeholder: 'Empty reads everything. One per line, e.g.\nChris\n/whispers:/i', onChange: check }),
      h('p', { class: 'hint' },
        'When this has something in it, only text with one of these lines in it is read: in a chat box, only the messages that mention your name. ',
        'A plain word matches in any case. /…/ is a regular expression; ',
        h('a', { href: REGEX_SITE, target: '_blank', rel: 'noopener' }, 'regex101.com'),
        ' is a good place to build and try one (pick the ECMAScript/JavaScript flavour). ',
        'In a chat box each line is checked on its own, so the second line of a long message that wraps is read only if it matches too.'),
      bad,
      UI.row(suggest, UI.field('Try a line', sampleInput), tryOut));
  }

  // -------------------------------------------------------------------------
  // Editing one zone
  // -------------------------------------------------------------------------

  function editZone(zone, isNew) {
    UI.edit({
      title: isNew ? 'New zone' : `Zone: ${zone.name}`,
      item: zone,
      saveLabel: isNew ? 'Add zone' : 'Save',
      build: (z, rebuild) => {
        const r = z.rect;
        const pos = (k, label) => {
          const holder = { v: pct(r[k]) };
          return UI.field(label, UI.number(holder, 'v', { min: 0, max: 100, step: 0.5, onChange: (n) => { r[k] = n / 100; z.rect = { ...r }; } }));
        };
        return [
          UI.row(UI.field('Name', UI.text(z, 'name', { maxlength: 40 })), UI.check(z, 'enabled', 'On')),
          UI.field('What it reads', UI.select(z, 'mode', S.MODES, { onChange: rebuild })),
          z.mode === 'menu' ? h('p', { class: 'hint' }, 'Looks for the line that stands out from the others, by colour or brightness, and reads it each time it moves. Works best when the box holds only the menu.') : null,
          z.mode === 'new-lines' ? h('p', { class: 'hint' }, 'What’s in the box when it starts is not read; after that, each line that wasn’t there before is.') : null,
          voicePicker(z.voice, { sample: `This is ${z.name || 'this zone'}.` }),
          UI.row(
            UI.field('When new text comes', UI.select(z, 'interrupt', S.INTERRUPTS)),
            UI.field('Wait for it to settle (ms)', UI.number(z, 'settle', { min: 0, max: 5000, step: 50 }), 'Text being typed out or fading in is read once it stops changing.')),
          UI.field('Say first', UI.text(z, 'prefix', { placeholder: 'e.g. Objective', maxlength: 40 }), 'Said before the text, to tell zones in the same voice apart. Leave empty to say only the text.'),
          UI.field('Leave out', UI.text(z, 'ignore', { multiline: true, rows: 3, placeholder: 'One per line, e.g.\n[E]\n/\\d+ m$/' }), 'Words or phrases never read from this box, one per line. /…/ is a regular expression.'),
          onlyField(z, rebuild),
          h('div', { class: 'field nested' },
            h('div', { class: 'row-label' }, 'Where on the screen (% of its width and height)'),
            UI.row(pos('x', 'From the left'), pos('y', 'From the top'), pos('w', 'Width'), pos('h', 'Height')),
            UI.row(
              UI.select({ t: '' }, 't', [['', 'Move it to a template’s spot…'], ...S.TEMPLATES.map((t, i) => [String(i), t.name])], {
                label: 'Use the position of a template',
                onChange: (v) => { if (v !== '') { z.rect = { ...S.TEMPLATES[Number(v)].rect }; rebuild(); } },
              }))),
        ];
      },
      onTest: (z) => S.preview(z.voice, `This is ${z.name}.`),
      onSave: (z) => {
        const zones = S.profile().zones;
        const i = zones.findIndex((x) => x.id === z.id);
        if (i === -1) zones.push(z); else zones[i] = z;
        save();
        S.apply({ keys: true });
      },
    });
  }

  // -------------------------------------------------------------------------
  // Sections
  // -------------------------------------------------------------------------

  const liveNodes = { now: null };

  function statusSection() {
    const cfg = c();
    const zones = S.zones();
    const watching = zones.filter((z) => z.enabled !== false && z.mode !== 'manual').length;
    let line;
    if (!cfg.enabled) line = 'Off. The hotkeys still read the screen when you press them.';
    else if (!watching) line = 'On, but no zone reads by itself yet. Add one under Zones.';
    else if (S.status === 'watching') line = `Watching ${watching} zone${watching === 1 ? '' : 's'} in “${S.profile().name}”.`;
    else if (S.status === 'starting') line = 'Starting…';
    else line = 'Not watching.';
    const nowLine = h('p', { class: 'hint sr-now' });
    liveNodes.now = nowLine;
    drawLive();
    return UI.section('Screen reader',
      UI.check(cfg, 'enabled', 'On: read the zones out loud when their text changes', { onChange: () => { save(); S.apply(); } }),
      h('p', { class: S.problem ? 'warn' : 'hint' }, S.problem || line),
      nowLine,
      IS_MAC && S.access !== 'granted' ? h('div', { class: 'warn' },
        h('p', {}, 'macOS has to allow Chat Reader to see the screen. Press the button, turn Chat Reader on under Screen Recording, then quit and open the app again.'),
        UI.button('Allow screen recording…', async () => { await S.askAccess(); UI.rerender(); }, { cls: 'btn small primary' })) : null,
      UI.row(
        UI.button('Read the whole screen', () => S.navigate('readAll')),
        UI.button('Stop', () => S.stop())));
  }

  // Neural voices for the screen reader, without going to Voices.
  function voicesSection() {
    const cfg = c();
    const zones = S.zones();
    const state = neuralState();
    const allNeural = S.allNeural();
    return UI.section('Voices',
      UI.lead('Neural voices sound the most natural. They run on this computer, in English; the first time they download once, around 90 MB. Until they’re ready, a system voice reads.'),
      S.usesNeural() || state !== 'unloaded' ? neuralStatus() : null,
      allNeural ? null : UI.row(
        UI.button(zones.length ? 'Use neural voices' : 'Use a neural voice', () => {
          S.useNeuralVoices();
          save();
          S.apply();
          UI.rerender();
        }, { cls: 'btn small primary' }),
        h('span', { class: 'hint' }, zones.length
          ? 'Gives each zone and the reading cursor a neural voice of its own, so you can tell them apart.'
          : 'For the reading cursor, and new zones get one too.')),
      voicePicker(cfg.nav.voice, { sample: 'Next line.', status: false, label: 'Reading cursor voice', onChange: () => { save(); S.apply(); UI.rerender(); } }),
      zones.length ? h('p', { class: 'hint' }, 'Each zone’s own voice is under ', UI.button('Zones', () => Bot.shell.show('screen/zones'), { cls: 'link' }), ', with Edit.') : null);
  }

  // The first sub-page: on or off, the voices, the profile in use, and what
  // the other sub-pages are for.
  function overviewSections() {
    const zones = S.zones();
    const watching = zones.filter((z) => z.enabled !== false && z.mode !== 'manual').length;
    const go = (sub, label) => UI.button(label, () => Bot.shell.show(`screen/${sub}`), { cls: 'link' });
    return [
      statusSection(),
      voicesSection(),
      UI.section('Profile',
        profilePicker(),
        h('p', { class: 'hint' }, `${zones.length ? `${zones.length} zone${zones.length === 1 ? '' : 's'}, ${watching} reading by themselves. ` : 'No zones yet. '}`,
          go('zones', zones.length ? 'Change the zones' : 'Add a zone'))),
      UI.section('More',
        h('ul', { class: 'sr-overview' },
          h('li', {}, go('cursor', 'Reading cursor'), ': read the screen line by line with hotkeys.'),
          h('li', {}, go('lens', 'Lens'), `: a magnifier that follows what’s read. ${c().lens.enabled ? 'On.' : 'Off.'}`),
          h('li', {}, go('keys', 'Hotkeys'), ': the keys for all of it, working while a game is focused.'),
          h('li', {}, go('tuning', 'Speech & timing'), ': pausing chat, text recognition and tips for games.'))),
    ];
  }

  function drawLive() {
    const node = liveNodes.now;
    if (!node || !node.isConnected) return;
    const s = S.speaking;
    const zone = s && S.zones().find((z) => z.id === s.zone);
    node.textContent = s ? `Reading${zone ? ` (${zone.name})` : ''}: ${UI.trim(s.text, 120)}` : '';
    node.hidden = !s;
    for (const cell of document.querySelectorAll('[data-sr-last]')) {
      const last = S.last.get(cell.dataset.srLast);
      cell.textContent = last ? UI.trim(last.text, 60) : '–';
      cell.title = last ? last.text : '';
    }
  }
  Bot.on('screen-live', drawLive);

  // The open programs, once asked for. Kept here so a redraw doesn't lose them.
  const appPick = { loading: false, list: null, error: '' };

  function appsBlock(p) {
    const cfg = c();
    const same = (name) => (a) => S.appMatches(a, { exe: name, name });
    const add = (raw) => {
      const name = String(raw || '').trim().slice(0, 120);
      if (!name) return;
      // A program belongs to one profile, or which to use would be a guess.
      for (const other of cfg.profiles) if (other !== p) other.apps = other.apps.filter((a) => !same(name)(a));
      if (!p.apps.some(same(name))) p.apps.push(name);
      save();
      S.apply();
    };
    const remove = (a) => {
      p.apps = p.apps.filter((x) => x !== a);
      save();
      S.apply();
    };
    const typed = { v: '' };
    const input = UI.text(typed, 'v', { placeholder: IS_MAC ? 'e.g. Hades' : 'e.g. eldenring.exe', maxlength: 120 });
    input.setAttribute('aria-label', 'Program name');
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(typed.v); } });
    const owner = (app) => S.profileForApp(app);
    const last = S.app;
    const lastOwner = last && owner(last);

    return h('div', { class: 'field nested' },
      h('div', { class: 'row-label' }, 'Programs that use this profile'),
      h('p', { class: 'hint' }, 'When one of these comes to the front, this profile is used by itself and its name is said. Any other program, like chat or Discord, leaves the profile as it is.'),
      p.apps.length
        ? h('ul', { class: 'sr-apps', 'aria-label': `Programs for ${p.name}` }, p.apps.map((a) => h('li', {},
          h('span', {}, a),
          UI.button('×', () => remove(a), { cls: 'x', aria: `Remove ${a}`, title: 'Remove' }))))
        : h('p', { class: 'hint' }, 'None yet, so this profile is only picked by hand or with the Next profile hotkey.'),
      last && (!lastOwner || lastOwner !== p) ? UI.row(
        UI.button(`+ Add ${last.name || last.exe}`, () => add(S.appLabel(last)), { cls: 'btn small primary' }),
        h('span', { class: 'hint' }, lastOwner ? `The program in front last. It’s in “${lastOwner.name}” now and moves here.` : 'The program in front last. Start the game, switch back here and add it.')) : null,
      UI.row(
        appPick.list
          ? UI.select({ v: '' }, 'v', [
            ['', appPick.list.length ? 'Pick an open program…' : 'No open programs found'],
            ...appPick.list.map((a) => {
              const extra = !IS_MAC && a.name && a.exe && S.appKey(a.name) !== S.appKey(a.exe) ? ` (${a.exe})` : '';
              const where = owner(a);
              return [S.appLabel(a), `${a.name || a.exe}${extra}${where ? ` · in “${where.name}”` : ''}`];
            }),
          ], { label: 'Open programs', onChange: (v) => add(v) })
          : null,
        UI.button(appPick.loading ? 'Looking…' : appPick.list ? 'Look again' : 'Choose from open programs…', async () => {
          appPick.loading = true;
          UI.rerender();
          try {
            const r = await window.chatReaderDesktop.screen.apps();
            appPick.list = r.apps || [];
            appPick.error = r.error || '';
          } catch (err) {
            appPick.list = [];
            appPick.error = err.message;
          } finally {
            appPick.loading = false;
            UI.rerender();
          }
        }, { disabled: appPick.loading }),
        UI.field('Or type its name', input),
        UI.button('Add', () => add(typed.v))),
      appPick.error ? h('p', { class: 'warn' }, appPick.error) : null,
      UI.check(cfg, 'autoProfile', 'Switch profile by itself when one of its programs comes to the front', { onChange: () => { save(); S.apply(); } }));
  }

  // The profile in use, to switch it from the pages that depend on it.
  function profilePicker() {
    const cfg = c();
    const row = UI.row(
      UI.field('Profile in use', UI.select(cfg, 'profile', cfg.profiles.map((x) => [x.id, `${x.name} (${x.zones.length})`]), { onChange: () => { save(); S.apply({ keys: true }); } })),
      UI.button('Manage profiles', () => Bot.shell.show('screen/profiles')));
    row.classList.add('sr-profile-row');
    return row;
  }

  function profileSection() {
    const cfg = c();
    const p = S.profile();
    const displays = S.displays.length > 1
      ? UI.field('Screen', UI.select(p, 'display', [['', 'The main screen'], ...S.displays.map((d) => [d.id, `${d.label}${d.primary ? ' (main)' : ''} · ${d.pixels.width}×${d.pixels.height}`])], { onChange: () => { save(); S.apply(); } }))
      : null;
    return UI.section('Profiles',
      UI.lead('A profile is a set of zones, usually one per game. Give it the game’s program and it’s used by itself when the game comes up, or switch here or with the Next profile hotkey.'),
      UI.row(
        UI.field('Profile in use', UI.select(cfg, 'profile', cfg.profiles.map((x) => [x.id, `${x.name} (${x.zones.length})`]), { onChange: () => { save(); S.apply({ keys: true }); } })),
        displays,
        UI.button('New', () => {
          const name = prompt('Name of the new profile, e.g. the game it’s for:', '');
          if (!name) return;
          const np = S.newProfile(name.trim().slice(0, 60));
          cfg.profiles.push(np);
          cfg.profile = np.id;
          save();
          S.apply({ keys: true });
        }),
        UI.button('Rename', () => {
          const name = prompt('New name:', p.name);
          if (!name) return;
          p.name = name.trim().slice(0, 60);
          save();
          S.apply();
        }),
        UI.button('Duplicate', () => {
          const copy = Bot.clone(p);
          copy.id = Bot.uid('p');
          copy.name = `${p.name} (copy)`.slice(0, 60);
          copy.apps = [];   // the programs stay with the original
          for (const z of copy.zones) z.id = Bot.uid('z');
          cfg.profiles.push(copy);
          cfg.profile = copy.id;
          save();
          S.apply({ keys: true });
        }),
        cfg.profiles.length > 1 ? UI.button('Delete', () => {
          if (!confirm(`Delete the profile “${p.name}” and its ${p.zones.length} zones?`)) return;
          cfg.profiles = cfg.profiles.filter((x) => x !== p);
          cfg.profile = cfg.profiles[0].id;
          save();
          S.apply({ keys: true });
        }, { cls: 'btn small danger' }) : null),
      appsBlock(p));
  }

  function zonesSection() {
    const cfg = c();
    const zones = S.zones();
    const move = (i, d) => {
      const j = i + d;
      if (j < 0 || j >= zones.length) return;
      [zones[i], zones[j]] = [zones[j], zones[i]];
      save();
      S.apply({ keys: true });
    };
    const template = UI.select({ t: '' }, 't', [['', '+ Add from a template…'], ...S.TEMPLATES.map((t, i) => [String(i), t.name])], {
      label: 'Add a zone from a template',
      onChange: (v) => {
        if (v === '') return;
        const z = S.newZone(S.TEMPLATES[Number(v)]);
        editZone(z, true);
      },
    });
    return UI.section('Reading zones',
      UI.lead('Boxes on the screen whose text is read out loud, each in its own voice. Draw them over the game, start from a template, or type in where they go. Each profile has its own zones.'),
      profilePicker(),
      UI.row(
        UI.button(S.editing ? 'Drawing…' : 'Draw zones on screen', () => S.editOnScreen({ hideMain: true }), { cls: 'btn small primary', disabled: S.editing }),
        template,
        UI.button('+ Add a zone', () => editZone(S.newZone(), true))),
      h('p', { class: 'hint' }, `Drawing hides this window and covers the screen until you press Enter to save or Escape to cancel. You can also open it from inside a game with ${Bot.host.keyLabel(cfg.keys.edit)}.`),
      UI.table(
        [{ label: '#', cls: 'num' }, { label: 'On', cls: 'c-on' }, { label: 'Name' }, { label: 'Reads' }, { label: 'Voice' }, { label: 'Last read' }, { label: '', cls: 'c-act' }],
        zones.map((z, i) => ({
          off: z.enabled === false,
          cells: [
            String(i + 1),
            UI.toggle(z, 'enabled', `${z.name} is on`, () => S.apply()),
            h('span', {}, z.color ? h('span', { class: 'sr-swatch', 'aria-hidden': 'true', style: `background:${z.color}` }) : null, z.name),
            `${MODE_SHORT[z.mode] || z.mode}${String(z.only || '').trim() ? ', only matches' : ''}`,
            voiceLabel(z.voice),
            h('span', { class: 'hint', 'data-sr-last': z.id }, S.last.has(z.id) ? UI.trim(S.last.get(z.id).text, 60) : '–'),
            h('span', { class: 'bot-row-actions' },
              UI.button('Edit', () => editZone(Bot.clone(z), false)),
              UI.button('▶', () => S.readZone(z), { cls: 'x', aria: `Read ${z.name} now`, title: 'Read now' }),
              UI.button('↑', () => move(i, -1), { cls: 'x', aria: `Move ${z.name} up`, title: 'Move up', disabled: i === 0 }),
              UI.button('↓', () => move(i, 1), { cls: 'x', aria: `Move ${z.name} down`, title: 'Move down', disabled: i === zones.length - 1 }),
              UI.button('🗑', () => {
                if (!confirm(`Delete the zone “${z.name}”?`)) return;
                S.profile().zones = zones.filter((x) => x !== z);
                save();
                S.apply({ keys: true });
              }, { cls: 'x', aria: `Delete ${z.name}`, title: 'Delete' })),
          ],
        })),
        { empty: 'No zones yet. Draw one on screen, or start from a template such as Subtitles.' }),
      UI.check(cfg, 'numberKeys', `${Bot.host.keyLabel({ code: 'Digit1', ctrl: true, alt: true })} to ${Bot.host.keyLabel({ code: 'Digit9', ctrl: true, alt: true })} read zone 1 to 9, whatever it’s set to read`, { onChange: () => { save(); Bot.host.syncHotkeys(); } }),
      UI.check(cfg, 'showZones', 'Show the zones on screen while playing', { onChange: () => { save(); S.apply(); } }));
  }

  function cursorSection() {
    const cfg = c();
    const k = (name) => Bot.host.keyLabel(cfg.keys[name]);
    return UI.section('Reading cursor',
      UI.lead('A cursor for the text on screen, moved by hotkeys instead of the mouse. The screen is looked at again each time you press one, so it keeps up with the game.'),
      h('ul', { class: 'sr-keys-list' },
        h('li', {}, h('kbd', {}, k('centre')), ' reads the text nearest the middle of the screen: what the crosshair is on.'),
        h('li', {}, h('kbd', {}, k('next')), ' and ', h('kbd', {}, k('prev')), ' read the next and previous line, top to bottom.'),
        h('li', {}, h('kbd', {}, k('left')), ' and ', h('kbd', {}, k('right')), ' jump to the nearest text on the left or right, for menus laid out side by side.'),
        h('li', {}, h('kbd', {}, k('readAll')), ' reads everything on the screen, ', h('kbd', {}, k('stop')), ' stops.')),
      voicePicker(cfg.nav.voice, { sample: 'Next line.', label: 'Cursor voice', onChange: save }),
      UI.check(cfg.nav, 'wrap', 'Go round to the top after the last line', { onChange: save }),
      UI.check(cfg, 'highlight', 'Draw a box around what’s being read', { onChange: () => { save(); S.apply(); } }));
  }

  function lensSection() {
    const cfg = c();
    const l = cfg.lens;
    const apply = () => { save(); S.pushLens(); };
    const displays = S.displays.length > 1
      ? UI.field('On screen', UI.select(l, 'display', [['', 'The screen being read'], ...S.displays.map((d) => [d.id, `${d.label}${d.primary ? ' (main)' : ''}`])], { onChange: apply }))
      : null;
    return UI.section('Lens',
      UI.lead('A magnifier that follows what’s being read, not the mouse. It stays on top of the game and never takes the mouse or the keyboard.'),
      UI.check(l, 'enabled', 'Show the lens', { onChange: () => { apply(); UI.rerender(); } }),
      UI.row(
        UI.field('Shows', UI.select(l, 'follow', [['focus', 'What’s being read'], ['centre', 'The middle of the screen'], ['zone', 'One zone, always']], { onChange: () => { apply(); UI.rerender(); } })),
        l.follow === 'zone' ? UI.field('Zone', UI.select(l, 'zone', S.zones().map((z) => [z.id, z.name]), { onChange: apply })) : null,
        UI.field('Zoom', UI.range(l, 'zoom', { min: 1, max: 12, step: 0.5, suffix: '×', onChange: apply }))),
      UI.row(
        UI.field('Where', UI.select(l, 'position', [
          ['top-right', 'Top right'], ['top-left', 'Top left'], ['bottom-right', 'Bottom right'], ['bottom-left', 'Bottom left'],
          ['top', 'Top middle'], ['bottom', 'Bottom middle'], ['fill', 'The whole screen (for a second screen)'],
        ], { onChange: apply })),
        displays,
        UI.field('Width', UI.number(l, 'width', { min: 200, max: 3000, step: 20, onChange: apply })),
        UI.field('Height', UI.number(l, 'height', { min: 100, max: 2000, step: 20, onChange: apply }))),
      UI.row(
        UI.field('Colours', UI.select(l, 'filter', [
          ['none', 'As they are'], ['contrast', 'Stronger contrast'], ['invert', 'Inverted'], ['gray', 'Grey, stronger contrast'],
          ['gray-invert', 'Grey, inverted'], ['yellow', 'Yellow on black'],
        ], { onChange: apply })),
        UI.field('Caption size', UI.number(l, 'captionSize', { min: 14, max: 96, step: 2, onChange: apply }))),
      UI.check(l, 'caption', 'Write the text being read under the picture, in large letters', { onChange: apply }),
      l.position === 'fill' && !(l.display && l.display !== S.profile().display)
        ? h('p', { class: 'warn' }, 'A lens filling the screen being read covers the game. Pick another screen for it, or a corner.') : null);
  }

  function keysSection() {
    const cfg = c();
    const problems = Bot.host.hotkeyProblems();
    const changedKeys = () => { save(); Bot.host.syncHotkeys(); setTimeout(UI.rerender, 300); };
    return UI.section('Hotkeys',
      UI.lead('These work while a game is focused. Click one and press the keys you want; Backspace clears it.'),
      UI.table(
        [{ label: 'Action' }, { label: 'Keys' }],
        S.KEY_ACTIONS.map(([name, label]) => ({
          cells: [label, h('span', {}, keyCapture(cfg.keys, name, label, changedKeys), problems[`bot:sr:${name}`] ? h('span', { class: 'hint warn-text' }, ` ${problems[`bot:sr:${name}`]}`) : null)],
        }))));
  }

  function tuningSection() {
    const cfg = c();
    const ocr = S.ocr;
    const testOut = h('p', { class: 'hint', role: 'status' });
    return UI.section('Speech and timing',
      UI.check(cfg, 'pauseChat', 'Pause chat while screen text is read', { onChange: save }),
      h('p', { class: 'hint' }, 'Chat carries on from where it stopped. Two system voices can’t talk at once, so chat in a system voice always waits.'),
      UI.row(
        UI.field('Notice changes', UI.select(cfg, 'sensitivity', [['low', 'Only big changes'], ['normal', 'Normal'], ['high', 'Even small changes']], { onChange: save })),
        UI.field('Look every (ms)', UI.number(cfg, 'interval', { min: 100, max: 2000, step: 50, onChange: () => { save(); S.apply(); } }))),
      UI.check(cfg, 'fastOcr', 'Faster but rougher text recognition', { onChange: save }),
      UI.row(
        h('span', { class: 'hint' }, `Text recognition: ${ocr.engine || (IS_MAC ? 'Apple Vision' : 'Windows OCR')}${ocr.error ? ` — ${ocr.error}` : ''}`),
        UI.button('Test it', (e) => UI.busy(e.currentTarget, async () => {
          UI.say(testOut, 'Reading a test picture… The first time can take a few seconds.');
          const r = await S.selfTest();
          UI.say(testOut, r.text ? `Read “${r.text}” in ${r.ms} ms.` : 'It ran, but found no text.', !r.text);
        }, testOut))),
      testOut,
      h('details', { class: 'fx-more' },
        h('summary', {}, 'Tips for games'),
        h('ul', { class: 'sr-keys-list' },
          h('li', {}, 'Use borderless or windowed full screen. True (exclusive) full screen can hide the game from screen capture and puts it above the lens.'),
          h('li', {}, 'Big, plain subtitles with a dark background behind them are read best. Many games have both settings.'),
          h('li', {}, 'Keep a box tight around its text: less moving picture behind it means fewer misreads.'),
          h('li', {}, 'The lens, the outlines and the zone editor are hidden from screen capture, so they’re never read or streamed.'))));
  }

  // The page is split into sub-pages (shell.js); show(id) says which
  // sections the one showing has.
  UI.addTab('screen', 'Screen reader', (panel, show) => {
    panel.append(
      ...(show('status') ? overviewSections() : []),
      show('profile') && profileSection(),
      show('zones') && zonesSection(),
      show('cursor') && cursorSection(),
      show('lens') && lensSection(),
      show('keys') && keysSection(),
      show('tuning') && tuningSection());
  }, { listens: ['screen', 'neural-state'] });

  // The engine's status shows on the page; look it up when the page opens.
  Bot.on('page', (id) => { if (id === 'screen') S.checkOcr(false).catch(() => {}); });
})();
