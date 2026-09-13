'use strict';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'twitch-chat-reader:v1';
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const DEFAULTS = {
  channel: '',
  engine: 'kokoro',
  kokoroMode: 'auto',
  kokoroVoices: KOKORO_BEST,
  systemVoices: null, // null = pick good defaults automatically
  systemLang: (navigator.language || 'en').slice(0, 2),
  varyVoices: true,
  volume: 80,
  rate: 1,
  nameFormat: 'colon',
  collapseNames: true,
  quoteParent: false,
  readEvents: true,
  readEmojis: false,
  maxLength: 300,
  catchUp: 0,
  skipCommands: true,
  skipLinks: false,
  ignoredUsers: '',
  keys: {
    pause: { code: 'KeyP', alt: true, ctrl: false, shift: false, meta: false },
    skip: { code: 'KeyS', alt: true, ctrl: false, shift: false, meta: false },
  },
  mediaKeys: false,
  userVoices: { kokoro: {}, system: {} },
};

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return {
      ...structuredClone(DEFAULTS),
      ...saved,
      keys: { ...DEFAULTS.keys, ...(saved.keys || {}) },
      userVoices: { kokoro: {}, system: {}, ...(saved.userVoices || {}) },
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

const settings = loadSettings();
let saveTimer = null;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch {}
  }, 200);
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

// ---------------------------------------------------------------------------
// Engines and voices
// ---------------------------------------------------------------------------

const systemEngine = new SystemEngine();
const kokoroEngine = new KokoroEngine({ onState: renderKokoroState });

function activeEngine() {
  if (settings.engine === 'kokoro' && kokoroEngine.state === 'ready') return kokoroEngine;
  return systemEngine;
}

function defaultSystemVoiceIds() {
  const lang = settings.systemLang;
  const voices = systemEngine.voices().filter((v) => lang === 'all' || v.lang.toLowerCase().startsWith(lang));
  const natural = voices.filter((v) => v.natural && !v.novelty);
  const decent = voices.filter((v) => !v.novelty);
  const pick = natural.length >= 3 ? natural : [...natural, ...decent.filter((v) => !v.natural)].slice(0, 12);
  return (pick.length ? pick : voices).map((v) => v.id);
}

function voicePool(engine) {
  if (engine === kokoroEngine) {
    const pool = settings.kokoroVoices.filter((id) => KOKORO_VOICES.some((v) => v.id === id));
    return pool.length ? pool : ['af_heart'];
  }
  const available = new Set(systemEngine.voices().map((v) => v.id));
  const chosen = (settings.systemVoices || defaultSystemVoiceIds()).filter((id) => available.has(id));
  return chosen.length ? chosen : [...available].slice(0, 1);
}

function voiceIdFor(login, engine) {
  const pool = voicePool(engine);
  const override = settings.userVoices[engine.id][login];
  if (override && pool.includes(override)) return override;
  return pool[hashString(login) % pool.length];
}

function voiceName(engine, id) {
  if (engine === kokoroEngine) return (KOKORO_VOICES.find((v) => v.id === id) || {}).name || id;
  const v = systemEngine.voices().find((x) => x.id === id);
  return v ? v.name.replace(/\s*\(.*?\)\s*/g, ' ').trim() : 'Default';
}

function voiceOptionsFor(entry, engine) {
  const voiceId = entry.forcedVoice || voiceIdFor(entry.login, engine);
  const h = hashString(`${entry.login}#vary`);
  const pitchJitter = settings.varyVoices ? ((h % 21) - 10) / 100 : 0;         // ±0.10
  const paceJitter = settings.varyVoices ? (((h >>> 8) % 11) - 5) / 100 : 0;   // ±0.05
  return {
    voiceId,
    rate: settings.rate * (1 + paceJitter),
    speed: Math.min(2, Math.max(0.5, settings.rate * (1 + paceJitter))),
    pitch: 1 + pitchJitter,
  };
}

const getVolume = () => settings.volume / 100;

// ---------------------------------------------------------------------------
// Reader: the queue and pause/resume logic
// ---------------------------------------------------------------------------

const reader = {
  queue: [],
  current: null,
  controller: null,
  paused: false,
  lastSpoken: null,
};

const feedEntries = [];
const MAX_FEED = 250;
let entrySeq = 0;

function enqueue(entry) {
  entry.uid = ++entrySeq;
  entry.receivedAt = entry.receivedAt || Date.now();
  addToFeed(entry);

  const reason = filterReason(entry);
  if (reason) {
    setStatus(entry, 'filtered', reason);
    return;
  }
  setStatus(entry, 'queued');
  reader.queue.push(entry);

  if (settings.catchUp > 0 && reader.queue.length > settings.catchUp) {
    for (const old of reader.queue.splice(0, reader.queue.length - settings.catchUp)) {
      setStatus(old, 'skipped', 'skipped to catch up');
    }
  }
  pump();
  renderNow();
}

function filterReason(entry) {
  if (entry.kind === 'event' && !settings.readEvents) return 'events off';
  if (entry.kind === 'chat') {
    const ignored = settings.ignoredUsers.toLowerCase().split(/[\s,]+/).filter(Boolean);
    if (ignored.includes(entry.login)) return 'ignored';
    if (settings.skipCommands && /^\s*!/.test(entry.rawText)) return 'command';
    if (settings.skipLinks && new RegExp(URL_RE.source, 'i').test(entry.rawText)) return 'link';
  }
  return null;
}

function pump() {
  if (reader.paused || reader.current) return;

  while (reader.queue.length) {
    const entry = reader.queue.shift();
    const text = composeSpeech(entry, reader.lastSpoken, settings);
    if (!text) {
      setStatus(entry, 'skipped', 'nothing to read');
      continue;
    }

    const engine = activeEngine();
    const opts = voiceOptionsFor(entry, engine);
    entry.spokenText = text;
    entry.engine = engine;
    entry.voiceId = opts.voiceId;
    reader.current = entry;
    setStatus(entry, 'speaking');

    const controller = engine.speak(text, opts, { getVolume });
    reader.controller = controller;
    controller.done.then(() => {
      if (reader.controller !== controller) return;
      if (entry.status === 'speaking') {
        setStatus(entry, 'done');
        reader.lastSpoken = entry;
      }
      reader.current = null;
      reader.controller = null;
      pump();
      renderNow();
    });

    prefetchUpcoming(entry);
    break;
  }
  renderNow();
}

function prefetchUpcoming(after) {
  if (activeEngine() !== kokoroEngine) return;
  let prev = after;
  const items = [];
  for (const entry of reader.queue.slice(0, 2)) {
    const text = composeSpeech(entry, prev, settings);
    if (!text) continue;
    const opts = voiceOptionsFor(entry, kokoroEngine);
    items.push({ text, voiceId: opts.voiceId, speed: opts.speed });
    prev = entry;
  }
  kokoroEngine.prefetch(items);
}

function togglePause() {
  setPaused(!reader.paused);
}

function setPaused(paused) {
  if (reader.paused === paused) return;
  reader.paused = paused;
  if (reader.controller) {
    if (paused) reader.controller.pause();
    else reader.controller.resume();
  }
  if (!paused) pump();
  renderNow();
  updateMediaSession();
}

function skipCurrent() {
  if (!reader.current) return;
  setStatus(reader.current, 'skipped', 'skipped');
  reader.controller.stop();
}

function clearQueue() {
  for (const entry of reader.queue) setStatus(entry, 'skipped', 'cleared');
  reader.queue.length = 0;
  renderNow();
}

function removeFromQueue(entry, status, note) {
  const i = reader.queue.indexOf(entry);
  if (i !== -1) reader.queue.splice(i, 1);
  if (reader.current === entry) {
    setStatus(entry, status, note);
    reader.controller.stop();
  } else if (i !== -1) {
    setStatus(entry, status, note);
  }
  renderNow();
}

// Put the current message back at the front and start it again (used when
// switching engines so nothing is lost).
function restartCurrent() {
  const entry = reader.current;
  if (!entry) return;
  const controller = reader.controller;
  setStatus(entry, 'queued');
  reader.queue.unshift(entry);
  reader.current = null;
  reader.controller = null;
  controller.stop();
  pump();
}

// ---------------------------------------------------------------------------
// Twitch → entries
// ---------------------------------------------------------------------------

function entryFromPrivmsg(msg) {
  const tags = msg.tags;
  let text = msg.params[1] || '';
  let action = false;
  const actionMatch = text.match(/^\u0001ACTION (.*)\u0001$/);
  if (actionMatch) { text = actionMatch[1]; action = true; }

  const login = (tags.login || msg.prefix.split('!')[0] || '').toLowerCase();
  const isReply = !!tags['reply-parent-msg-id'];

  let speechBody = removeEmotes(text, tags.emotes);
  if (isReply) speechBody = stripLeadingMention(speechBody, tags['reply-parent-user-login'], tags['reply-parent-display-name']);

  let displayText = text;
  if (isReply) displayText = stripLeadingMention(text, tags['reply-parent-user-login'], tags['reply-parent-display-name']);

  return {
    id: tags.id,
    kind: tags['msg-id'] === 'announcement' ? 'announcement' : 'chat',
    login,
    userId: tags['user-id'],
    displayName: tags['display-name'] || login,
    color: tags.color || null,
    rawText: text,
    displayText,
    speechBody,
    action,
    isReply,
    parentLogin: tags['reply-parent-user-login'],
    parentDisplayName: tags['reply-parent-display-name'],
    parentBody: tags['reply-parent-msg-body'],
  };
}

function entryFromUserNotice(msg) {
  const tags = msg.tags;
  const text = msg.params[1] || '';
  const login = (tags.login || '').toLowerCase();
  const base = {
    id: tags.id,
    login,
    userId: tags['user-id'],
    displayName: tags['display-name'] || login,
    color: tags.color || null,
    rawText: text,
    displayText: text,
    speechBody: removeEmotes(text, tags.emotes),
  };
  if (tags['msg-id'] === 'announcement') return { ...base, kind: 'announcement' };
  return { ...base, kind: 'event', systemText: tags['system-msg'] || '' };
}

const chat = new TwitchChat({
  onStatus: renderConnection,
  onMessage: (msg) => enqueue(entryFromPrivmsg(msg)),
  onUserNotice: (msg) => enqueue(entryFromUserNotice(msg)),
  onClearChat: (userId) => {
    const targets = [...reader.queue, reader.current].filter((e) => e && (!userId || e.userId === userId));
    for (const entry of targets) removeFromQueue(entry, 'deleted', userId ? 'removed by mod' : 'chat cleared');
  },
  onDeleteMessage: (id) => {
    const entry = [...reader.queue, reader.current].find((e) => e && e.id === id);
    if (entry) removeFromQueue(entry, 'deleted', 'deleted by mod');
    else {
      const shown = feedEntries.find((e) => e.id === id);
      if (shown && shown.status !== 'done' && shown.status !== 'speaking') setStatus(shown, 'deleted', 'deleted by mod');
    }
  },
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const feedEl = $('#feed');

const STATUS_TEXT = {
  queued: 'waiting',
  speaking: 'reading',
  done: 'read',
  skipped: 'skipped',
  filtered: 'skipped',
  deleted: 'deleted',
};

function addToFeed(entry) {
  $('#feedEmpty').hidden = true;
  const nearBottom = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 60;

  const voiceBtn = el('button', {
    class: 'tag',
    type: 'button',
    title: 'Give this chatter a different voice',
    onclick: () => cycleUserVoice(entry),
  });
  const stateEl = el('span', { class: 'state' });
  const removeBtn = el('button', {
    class: 'x',
    type: 'button',
    title: 'Don’t read this message',
    'aria-label': 'Remove from queue',
    onclick: () => removeFromQueue(entry, 'skipped', 'removed'),
  }, '×');

  const name = el('span', { class: 'name', style: entry.color ? `--c:${entry.color}` : '' }, entry.displayName);
  const meta = el('div', { class: 'meta' },
    entry.kind === 'event' ? el('span', { class: 'reply-to' }, 'Event') : name,
    entry.kind === 'announcement' ? el('span', { class: 'reply-to' }, 'announcement') : null,
    entry.isReply ? el('span', { class: 'reply-to' }, `↩ replying to @${entry.parentDisplayName || entry.parentLogin}`) : null,
    el('span', { class: 'tail' }, voiceBtn, stateEl, removeBtn),
  );

  const node = el('li', { class: `msg ${entry.kind}` },
    meta,
    entry.isReply && entry.parentBody ? el('div', { class: 'reply-quote' }, entry.parentBody) : null,
    el('div', { class: 'text' }, entry.kind === 'event' ? [entry.systemText, entry.displayText].filter(Boolean).join(' · ') : (entry.action ? `* ${entry.displayText}` : entry.displayText)),
  );
  node.style.setProperty('--c', entry.color || '');

  entry.node = node;
  entry.voiceBtn = voiceBtn;
  entry.stateEl = stateEl;
  feedEntries.push(entry);
  feedEl.append(node);

  while (feedEntries.length > MAX_FEED) {
    const old = feedEntries.shift();
    old.node.remove();
  }
  updateVoiceTag(entry);
  if (nearBottom) feedEl.scrollTop = feedEl.scrollHeight;
}

function setStatus(entry, status, note) {
  entry.status = status;
  if (!entry.node) return;
  entry.node.dataset.status = status;
  entry.stateEl.textContent = note || STATUS_TEXT[status] || status;
  entry.node.classList.toggle('paused', status === 'speaking' && reader.paused);
  updateVoiceTag(entry);
}

function updateVoiceTag(entry) {
  if (!entry.voiceBtn) return;
  if (entry.kind === 'event' || !entry.login) { entry.voiceBtn.hidden = true; return; }
  const engine = entry.status === 'done' || entry.status === 'speaking' ? entry.engine || activeEngine() : activeEngine();
  const id = entry.status === 'done' || entry.status === 'speaking' ? entry.voiceId : voiceIdFor(entry.login, engine);
  entry.voiceBtn.textContent = voiceName(engine, id);
}

function refreshVoiceTags() {
  for (const entry of feedEntries) updateVoiceTag(entry);
}

function cycleUserVoice(entry) {
  const engine = activeEngine();
  const pool = voicePool(engine);
  if (pool.length < 2) return;
  const current = voiceIdFor(entry.login, engine);
  const next = pool[(pool.indexOf(current) + 1) % pool.length];
  settings.userVoices[engine.id][entry.login] = next;
  saveSettings();
  for (const e of feedEntries) if (e.login === entry.login && e.status !== 'done') updateVoiceTag(e);
  engine.preview && previewVoice(engine, next, `This is how ${speakableName(entry.displayName, entry.login)} sounds now.`);
}

const nowPanel = $('#nowPanel');
const nowBar = $('#nowBar');

function renderNow() {
  const entry = reader.current;
  const state = reader.paused ? 'paused' : entry ? 'speaking' : 'idle';
  nowPanel.dataset.state = state;
  $('#pauseBtn').setAttribute('aria-pressed', String(reader.paused));
  $('#pauseBtn').title = reader.paused ? 'Resume reading' : 'Pause reading';

  const loading = entry && reader.controller && reader.controller.loading;
  $('#nowLabel').textContent = reader.paused
    ? (entry ? 'Paused on this message' : 'Paused')
    : loading ? 'Preparing voice…' : entry ? 'Reading' : 'Idle';

  const waiting = reader.queue.length;
  $('#queueCount').textContent = `${waiting} waiting`;

  const msgEl = $('#nowMsg');
  msgEl.replaceChildren();
  if (entry) {
    if (entry.kind !== 'event') {
      const name = el('span', { class: 'name' }, entry.displayName);
      name.style.color = entry.color ? `color-mix(in oklab, ${entry.color} 72%, var(--fg))` : '';
      msgEl.append(name);
    }
    if (entry.isReply) msgEl.append(el('span', { class: 'muted' }, ` ↩ @${entry.parentDisplayName || entry.parentLogin}`));
    msgEl.append(el('div', {}, entry.spokenText));
  } else {
    msgEl.append(el('span', { class: 'muted' }, reader.paused
      ? `Reading is paused${waiting ? `, ${waiting} message${waiting === 1 ? '' : 's'} waiting` : ''}. Press ${keyLabel(settings.keys.pause)} to continue.`
      : chat.connected ? 'Waiting for chat messages…' : 'Nothing is being read right now.'));
  }
  if (!entry) nowBar.style.width = '0';

  for (const e of feedEntries) e.node.classList.toggle('paused', e.status === 'speaking' && reader.paused);
}

function tickProgress() {
  if (reader.controller) {
    nowBar.style.width = `${(reader.controller.progress() * 100).toFixed(1)}%`;
    const loading = !!reader.controller.loading;
    if (loading !== tickProgress.lastLoading) { tickProgress.lastLoading = loading; renderNow(); }
  }
  requestAnimationFrame(tickProgress);
}
requestAnimationFrame(tickProgress);

function renderConnection(state, text) {
  $('#status').dataset.state = state;
  $('#statusText').textContent = text;
  const connectedish = state === 'connected' || state === 'connecting';
  $('#connectBtn').textContent = connectedish ? 'Disconnect' : 'Connect';
  $('#connectBtn').classList.toggle('primary', !connectedish);
  if (state === 'connected') document.title = `#${chat.channel} · Chat Reader`;
  renderNow();
}

// ---------------------------------------------------------------------------
// Voice settings UI
// ---------------------------------------------------------------------------

function renderEngineUI() {
  for (const radio of $$('input[name="engine"]')) radio.checked = radio.value === settings.engine;
  const kokoro = settings.engine === 'kokoro';
  $('#kokoroBox').hidden = !kokoro;
  $('#systemBox').hidden = kokoro;
  $('#engineHint').textContent = kokoro
    ? 'Neural voices run on this computer and sound the most natural. English only. The model downloads once, then loads from cache.'
    : 'Built-in voices from your browser and OS. They start instantly and cover many languages. Edge has the most natural ones.';
  renderVoiceList();
  renderKokoroState(kokoroEngine.state, {});
}

function renderLanguageOptions() {
  const langs = new Map();
  for (const v of systemEngine.voices()) {
    const code = v.lang.slice(0, 2).toLowerCase();
    if (!langs.has(code)) {
      let label = code;
      try { label = new Intl.DisplayNames([navigator.language], { type: 'language' }).of(code) || code; } catch {}
      langs.set(code, label);
    }
  }
  const select = $('#systemLang');
  select.replaceChildren(
    ...[...langs].sort((a, b) => a[1].localeCompare(b[1])).map(([code, label]) => el('option', { value: code }, label)),
    el('option', { value: 'all' }, 'All languages'),
  );
  // Voices load asynchronously; only fall back once we know what exists.
  if (langs.size && !langs.has(settings.systemLang) && settings.systemLang !== 'all') settings.systemLang = langs.has('en') ? 'en' : 'all';
  if (!langs.size) return;
  select.value = settings.systemLang;
}

function renderVoiceList() {
  const list = $('#voiceList');
  list.replaceChildren();

  if (settings.engine === 'kokoro') {
    const selected = new Set(settings.kokoroVoices);
    for (const v of KOKORO_VOICES) {
      const good = /^[AB]/.test(v.grade);
      list.append(el('li', {},
        el('label', {},
          el('input', {
            type: 'checkbox',
            checked: selected.has(v.id),
            onchange: (e) => toggleVoice('kokoro', v.id, e.target.checked),
          }),
          el('span', { class: 'vname' }, v.name),
          el('span', { class: 'vmeta' }, `${v.gender === 'F' ? 'female' : 'male'} · ${v.accent} · `, el('span', { class: good ? 'good' : '' }, v.grade)),
        ),
        el('button', { class: 'play', type: 'button', title: `Preview ${v.name}`, onclick: () => previewVoice(kokoroEngine, v.id) }, '▶'),
      ));
    }
  } else {
    const lang = settings.systemLang;
    const voices = systemEngine.voices()
      .filter((v) => lang === 'all' || v.lang.toLowerCase().startsWith(lang))
      .sort((a, b) => (b.natural - a.natural) || (a.novelty - b.novelty) || a.name.localeCompare(b.name));
    const selected = new Set(voicePool(systemEngine));
    if (!voices.length) {
      list.append(el('li', { class: 'hint' }, systemEngine.supported ? 'Loading voices…' : 'This browser has no speech voices.'));
    }
    for (const v of voices) {
      list.append(el('li', {},
        el('label', {},
          el('input', {
            type: 'checkbox',
            checked: selected.has(v.id),
            onchange: (e) => toggleVoice('system', v.id, e.target.checked),
          }),
          el('span', { class: 'vname', title: v.raw.name }, v.name),
          el('span', { class: 'vmeta' }, v.lang, v.natural ? el('span', { class: 'good' }, ' · natural') : null),
        ),
        el('button', { class: 'play', type: 'button', title: `Preview ${v.name}`, onclick: () => previewVoice(systemEngine, v.id) }, '▶'),
      ));
    }
  }
  const poolSize = settings.engine === 'kokoro' ? voicePool(kokoroEngine).length : voicePool(systemEngine).length;
  $('#poolCount').textContent = `· ${poolSize} in use`;
}

function toggleVoice(engineId, id, on) {
  if (engineId === 'kokoro') {
    const set = new Set(settings.kokoroVoices);
    on ? set.add(id) : set.delete(id);
    settings.kokoroVoices = KOKORO_VOICES.map((v) => v.id).filter((x) => set.has(x));
  } else {
    const set = new Set(voicePool(systemEngine));
    on ? set.add(id) : set.delete(id);
    settings.systemVoices = [...set];
  }
  saveSettings();
  renderVoiceList();
  refreshVoiceTags();
}

let previewing = false;
async function previewVoice(engine, voiceId, text) {
  if (previewing) return;
  if (engine === kokoroEngine && kokoroEngine.state !== 'ready') {
    loadKokoro();
    return;
  }
  previewing = true;
  const wasReading = !!reader.controller && !reader.paused;
  if (wasReading) reader.controller.pause();
  try {
    await engine.preview(text || `Hi! I'm ${voiceName(engine, voiceId)}, and this is how I'll sound reading your chat.`, voiceId, getVolume());
  } catch (err) {
    console.warn('Preview failed:', err);
  }
  previewing = false;
  if (wasReading && !reader.paused && reader.controller) reader.controller.resume();
}

function loadKokoro() {
  kokoroEngine.load(settings.kokoroMode);
}

function renderKokoroState(state, info) {
  const status = $('#kokoroStatus');
  const btn = $('#kokoroLoadBtn');
  const wrap = $('#kokoroProgressWrap');
  if (!status) return;
  const deviceName = (info.device || kokoroEngine.device) === 'webgpu' ? 'GPU' : 'CPU';
  btn.hidden = state === 'loading' || state === 'ready';
  wrap.hidden = state !== 'loading';

  if (state === 'unloaded') {
    status.textContent = 'Not loaded. System voices are used until it is.';
  } else if (state === 'loading') {
    const mb = (n) => (n / 1e6).toFixed(0);
    status.textContent = info.total
      ? `Loading on ${deviceName}… ${mb(info.loaded)} / ${mb(info.total)} MB`
      : `Loading on ${deviceName}…`;
    $('#kokoroProgress').style.width = `${((info.progress || 0) * 100).toFixed(1)}%`;
  } else if (state === 'ready') {
    status.textContent = `Ready (${deviceName})`;
    if (settings.engine === 'kokoro' && reader.current && reader.current.engine !== kokoroEngine && !reader.paused) {
      // Keep the current system-voice message; the next one switches over.
    }
    refreshVoiceTags();
  } else if (state === 'error') {
    btn.hidden = false;
    btn.textContent = 'Try again';
    status.textContent = `Couldn't load: ${info.error || 'unknown error'}. Using system voices.`;
  }
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts and media keys
// ---------------------------------------------------------------------------

function keyLabel(binding) {
  if (!binding || !binding.code) return 'none';
  const parts = [];
  if (binding.ctrl) parts.push(IS_MAC ? '⌃' : 'Ctrl');
  if (binding.alt) parts.push(IS_MAC ? '⌥' : 'Alt');
  if (binding.shift) parts.push(IS_MAC ? '⇧' : 'Shift');
  if (binding.meta) parts.push(IS_MAC ? '⌘' : 'Win');
  const key = binding.code
    .replace(/^Key/, '')
    .replace(/^Digit/, '')
    .replace(/^Numpad/, 'Num ')
    .replace(/^Arrow/, '')
    .replace('Backquote', '`')
    .replace('Space', 'Space');
  parts.push(key);
  return parts.join(IS_MAC ? '' : '+');
}

function renderKeyLabels() {
  for (const node of $$('[data-key-label]')) node.textContent = keyLabel(settings.keys[node.dataset.keyLabel]);
  for (const node of $$('[data-bind]')) {
    if (!node.classList.contains('capturing')) node.textContent = keyLabel(settings.keys[node.dataset.bind]);
  }
}

let capturing = null;

function startCapture(button) {
  if (capturing) capturing.classList.remove('capturing');
  capturing = button;
  button.classList.add('capturing');
  button.textContent = 'Press keys…';
}

function stopCapture() {
  if (!capturing) return;
  capturing.classList.remove('capturing');
  capturing = null;
  renderKeyLabels();
}

const MODIFIER_CODES = /^(Shift|Control|Alt|Meta|OS)(Left|Right)?$/;

window.addEventListener('keydown', (e) => {
  if (capturing) {
    e.preventDefault();
    e.stopPropagation();
    if (e.code === 'Escape') return stopCapture();
    if (MODIFIER_CODES.test(e.code)) return;
    settings.keys[capturing.dataset.bind] = { code: e.code, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey };
    saveSettings();
    stopCapture();
    renderNow();
    return;
  }
  if (e.repeat) return;

  const matches = (b) => b && b.code === e.code && !!b.ctrl === e.ctrlKey && !!b.alt === e.altKey && !!b.shift === e.shiftKey && !!b.meta === e.metaKey;
  const typing = e.target.closest && e.target.closest('input:not([type="checkbox"]):not([type="radio"]):not([type="range"]), textarea, select, [contenteditable]');

  for (const [action, binding] of Object.entries(settings.keys)) {
    if (!matches(binding)) continue;
    if (typing && !(binding.ctrl || binding.alt || binding.meta)) return;
    e.preventDefault();
    if (action === 'pause') togglePause();
    if (action === 'skip') skipCurrent();
    return;
  }
}, true);

// Chrome/Edge route hardware media keys to a page that is playing media, even
// when the browser is in the background. A near-silent looping track keeps the
// page eligible; the ⏯ key then toggles pause.
const mediaKeys = { audio: null };

function makeQuietLoop() {
  const rate = 8000;
  const samples = new Float32Array(rate * 2);
  for (let i = 0; i < samples.length; i++) samples[i] = (Math.random() - 0.5) * 0.0004;
  return URL.createObjectURL(floatToWav(samples, rate));
}

function enableMediaKeys(on) {
  if (!('mediaSession' in navigator)) return;
  const session = navigator.mediaSession;
  if (on) {
    if (!mediaKeys.audio) {
      mediaKeys.audio = new Audio(makeQuietLoop());
      mediaKeys.audio.loop = true;
    }
    mediaKeys.audio.play().catch(() => {});
    session.setActionHandler('play', () => setPaused(false));
    session.setActionHandler('pause', () => setPaused(true));
    try { session.setActionHandler('stop', () => setPaused(true)); } catch {}
    try { session.setActionHandler('nexttrack', () => skipCurrent()); } catch {}
    updateMediaSession();
  } else {
    if (mediaKeys.audio) mediaKeys.audio.pause();
    for (const action of ['play', 'pause', 'stop', 'nexttrack']) {
      try { session.setActionHandler(action, null); } catch {}
    }
    session.metadata = null;
    session.playbackState = 'none';
  }
}

function updateMediaSession() {
  if (!settings.mediaKeys || !('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: reader.paused ? 'Chat reading paused' : 'Reading chat',
    artist: chat.channel ? `#${chat.channel}` : 'Chat Reader',
  });
  navigator.mediaSession.playbackState = reader.paused ? 'paused' : 'playing';
}

// ---------------------------------------------------------------------------
// Wiring up controls
// ---------------------------------------------------------------------------

function userGesture() {
  // Audio playback needs a user gesture in most browsers; use it to prime both.
  kokoroEngine.ensureAudio();
  if (kokoroEngine.ctx.state === 'suspended' && !reader.paused) kokoroEngine.ctx.resume();
  if (settings.mediaKeys) enableMediaKeys(true);
  if (settings.engine === 'kokoro' && kokoroEngine.state === 'unloaded') loadKokoro();
}

function connectTo(input) {
  const channel = TwitchChat.normalizeChannel(input);
  if (!channel) {
    renderConnection('error', 'That doesn’t look like a Twitch channel');
    return;
  }
  settings.channel = channel;
  saveSettings();
  $('#channelInput').value = channel;
  const url = new URL(location.href);
  url.searchParams.set('channel', channel);
  history.replaceState(null, '', url);
  userGesture();
  chat.connect(channel);
}

$('#connectForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if (chat.ws) {
    chat.disconnect();
    return;
  }
  connectTo($('#channelInput').value);
});

$('#pauseBtn').addEventListener('click', () => { userGesture(); togglePause(); });
$('#skipBtn').addEventListener('click', skipCurrent);
$('#clearBtn').addEventListener('click', clearQueue);

$('#volume').value = settings.volume;
$('#volumeOut').textContent = `${settings.volume}%`;
$('#volume').addEventListener('input', (e) => {
  settings.volume = Number(e.target.value);
  $('#volumeOut').textContent = `${settings.volume}%`;
  if (reader.controller && reader.current.engine === kokoroEngine) reader.controller.volumeChanged();
  saveSettings();
});
$('#volume').addEventListener('change', () => {
  if (reader.controller && reader.current.engine === systemEngine) reader.controller.volumeChanged();
});

$('#rate').value = settings.rate;
$('#rateOut').textContent = `${Number(settings.rate).toFixed(2)}×`;
$('#rate').addEventListener('input', (e) => {
  settings.rate = Number(e.target.value);
  $('#rateOut').textContent = `${settings.rate.toFixed(2)}×`;
  saveSettings();
});

for (const radio of $$('input[name="engine"]')) {
  radio.addEventListener('change', () => {
    settings.engine = radio.value;
    saveSettings();
    renderEngineUI();
    if (settings.engine === 'kokoro' && kokoroEngine.state === 'unloaded') loadKokoro();
    const target = activeEngine();
    if (reader.current && reader.current.engine !== target && !reader.paused) restartCurrent();
    refreshVoiceTags();
  });
}

$('#kokoroMode').value = settings.kokoroMode;
$('#kokoroMode').addEventListener('change', (e) => {
  settings.kokoroMode = e.target.value;
  saveSettings();
  if (kokoroEngine.state === 'ready' || kokoroEngine.state === 'error') {
    kokoroEngine.state = 'unloaded';
    kokoroEngine.terminate();
    renderKokoroState('unloaded', {});
    if (reader.current && reader.current.engine === kokoroEngine) restartCurrent();
  }
});
$('#kokoroLoadBtn').addEventListener('click', () => { userGesture(); loadKokoro(); });

$('#systemLang').addEventListener('change', (e) => {
  settings.systemLang = e.target.value;
  settings.systemVoices = null;
  saveSettings();
  renderVoiceList();
  refreshVoiceTags();
});

$('#poolBest').addEventListener('click', () => {
  if (settings.engine === 'kokoro') settings.kokoroVoices = [...KOKORO_BEST];
  else settings.systemVoices = null;
  saveSettings();
  renderVoiceList();
  refreshVoiceTags();
});
$('#poolAll').addEventListener('click', () => {
  if (settings.engine === 'kokoro') settings.kokoroVoices = KOKORO_VOICES.map((v) => v.id);
  else {
    const lang = settings.systemLang;
    settings.systemVoices = systemEngine.voices().filter((v) => lang === 'all' || v.lang.toLowerCase().startsWith(lang)).map((v) => v.id);
  }
  saveSettings();
  renderVoiceList();
  refreshVoiceTags();
});

const checkboxSettings = ['varyVoices', 'collapseNames', 'quoteParent', 'readEvents', 'readEmojis', 'skipCommands', 'skipLinks'];
for (const key of checkboxSettings) {
  const input = $(`#${key}`);
  input.checked = !!settings[key];
  input.addEventListener('change', () => { settings[key] = input.checked; saveSettings(); });
}

$('#nameFormat').value = settings.nameFormat;
$('#nameFormat').addEventListener('change', (e) => { settings.nameFormat = e.target.value; saveSettings(); });

for (const key of ['maxLength', 'catchUp']) {
  const input = $(`#${key}`);
  input.value = settings[key];
  input.addEventListener('change', () => {
    const n = Math.max(Number(input.min), Math.min(Number(input.max), Math.round(Number(input.value) || 0)));
    settings[key] = n;
    input.value = n;
    saveSettings();
  });
}

$('#ignoredUsers').value = settings.ignoredUsers;
$('#ignoredUsers').addEventListener('input', (e) => { settings.ignoredUsers = e.target.value; saveSettings(); });

for (const button of $$('[data-bind]')) {
  button.addEventListener('click', () => (capturing === button ? stopCapture() : startCapture(button)));
}
document.addEventListener('click', (e) => { if (capturing && !e.target.closest('[data-bind]')) stopCapture(); });

$('#mediaKeys').checked = settings.mediaKeys;
$('#mediaKeys').addEventListener('change', (e) => {
  settings.mediaKeys = e.target.checked;
  saveSettings();
  enableMediaKeys(settings.mediaKeys);
});

$('#testBtn').addEventListener('click', () => {
  userGesture();
  const now = Date.now();
  const samples = [
    { login: 'pixel_panda', displayName: 'Pixel_Panda', color: '#1E90FF', rawText: 'hey everyone, just got here! what did I miss?' },
    { login: 'quietstorm', displayName: 'QuietStorm', color: '#FF7F50', rawText: 'We just beat the second boss, it took like forty tries lol' },
    {
      login: 'pixel_panda', displayName: 'Pixel_Panda', color: '#1E90FF', rawText: '@QuietStorm forty?? that is dedication',
      isReply: true, parentLogin: 'quietstorm', parentDisplayName: 'QuietStorm', parentBody: 'We just beat the second boss, it took like forty tries lol',
    },
    { login: 'mossyrock88', displayName: 'MossyRock88', color: '#9ACD32', rawText: 'is waving at chat', action: true },
  ];
  samples.forEach((s, i) => {
    const displayText = s.isReply ? stripLeadingMention(s.rawText, s.parentLogin, s.parentDisplayName) : s.rawText;
    enqueue({
      id: `test-${now}-${i}`,
      kind: 'chat',
      userId: s.login,
      action: false,
      isReply: false,
      ...s,
      displayText,
      speechBody: displayText,
      receivedAt: now + i,
    });
  });
});

$('#gateBtn').addEventListener('click', () => {
  $('#gate').hidden = true;
  connectTo(settings.channel);
});

if (systemEngine.supported) {
  speechSynthesis.addEventListener('voiceschanged', () => {
    renderLanguageOptions();
    renderVoiceList();
    refreshVoiceTags();
  });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

renderLanguageOptions();
renderEngineUI();
renderKeyLabels();
renderNow();

{
  const fromUrl = TwitchChat.normalizeChannel(new URLSearchParams(location.search).get('channel') || '');
  if (fromUrl) settings.channel = fromUrl;
  $('#channelInput').value = settings.channel;
  if (fromUrl) {
    // Browsers block audio until the page is clicked, so ask once.
    $('#gateChannel').textContent = `#${fromUrl}`;
    $('#gate').hidden = false;
  }
}
