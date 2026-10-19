'use strict';

// The OBS overlay. The desktop app pushes each alert, picture, video, text,
// sound and counter here over Server-Sent Events (/events). Add
// ?instance=name to only get what's meant for that instance, or
// ?counter=name to show one counter on its own.

const params = new URLSearchParams(location.search);
const instance = params.get('instance') || '';
const counterName = (params.get('counter') || '').toLowerCase();
// ?chat shows the multistream's chats together: &max= messages, &fade= seconds, &size= px.
const chatMode = params.has('chat');
// ?spotify shows the song playing: &next= songs of the queue under it, &art=0,
// &requester=0, &progress=0, &idle=1 to stay up while paused, &size= px.
const spotifyMode = params.has('spotify');
const chatOnly = (params.get('platforms') || '').toLowerCase().split(',').filter(Boolean);

const EXIT_MS = 520;
const COLOR_RE = /^#[0-9a-f]{3,8}$/i;

const SHADOWS = {
  none: 'none',
  soft: '0 2px 6px rgba(0, 0, 0, .8), 0 0 2px rgba(0, 0, 0, .9)',
  strong: '0 3px 12px rgba(0, 0, 0, 1), 0 0 4px rgba(0, 0, 0, 1)',
  outline: '-2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000, 0 2px 6px rgba(0, 0, 0, .6)',
};

function rgba(hex, opacity) {
  let h = hex.slice(1);
  if (h.length <= 4) h = [...h].map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(100, opacity)) / 100})`;
}

function container(position) {
  return document.querySelector(`.pos[data-pos="${position}"]`) || document.querySelector('.pos[data-pos="center"]');
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Shows `node` with its way in, and takes it away with its way out after
// `seconds` (or when `until` resolves).
function show(node, { position = 'center', enter = 'fade', exit = 'fade', seconds = 5, until = null }) {
  if (enter !== 'none') node.classList.add(`in-${enter}`);
  container(position).append(node);
  const leave = () => {
    if (!node.isConnected) return;
    if (exit === 'none') { node.remove(); return; }
    node.classList.remove(`in-${enter}`);
    node.classList.add(`out-${exit}`);
    setTimeout(() => node.remove(), EXIT_MS);
  };
  if (until) until.then(leave);
  else setTimeout(leave, Math.max(0.5, seconds) * 1000);
}

function mediaElement(src, { video, volume = 80, width = 0, height = 0, loop = false }) {
  const isVideo = video || /\.(mp4|webm|mov|m4v)(\?|$)/i.test(src);
  const media = el(isVideo ? 'video' : 'img');
  media.src = src;
  if (isVideo) {
    media.autoplay = true;
    media.playsInline = true;
    media.loop = loop;
    media.volume = Math.max(0, Math.min(1, volume / 100));
  }
  if (width) media.style.width = `${width}px`;
  if (height) media.style.height = `${height}px`;
  return media;
}

function playSound(src, volume = 80) {
  if (!src) return;
  const audio = new Audio(src);
  audio.volume = Math.max(0, Math.min(1, volume / 100));
  audio.play().catch(() => {});
}

const handlers = {
  alert(e) {
    const box = el('div', 'item alert');
    // Without its own colours and size, an alert follows the overlay style.
    if (e.color) box.style.setProperty('--accent', e.color);
    if (e.textColor) box.style.setProperty('--text', e.textColor);
    if (Number(e.fontSize)) box.style.setProperty('--size', `${Number(e.fontSize)}px`);
    if (e.src) box.append(mediaElement(e.src, { volume: e.volume, loop: true }));
    if (e.title) box.append(el('div', 'alert-title', e.title));
    if (e.message) box.append(el('div', 'alert-message', e.message));
    playSound(e.soundSrc, e.volume);
    show(box, { position: e.position || 'top', enter: e.enter, exit: e.exit, seconds: Number(e.duration) || 6 });
  },

  media(e) {
    if (!e.src) return;
    const box = el('div', 'item media');
    const media = mediaElement(e.src, { video: e.video, volume: e.volume, width: e.width, height: e.height });
    box.append(media);
    const seconds = Number(e.duration) || 0;
    // A video with no duration stays until it ends.
    const until = !seconds && media.tagName === 'VIDEO'
      ? new Promise((resolve) => { media.onended = resolve; media.onerror = resolve; })
      : null;
    show(box, { position: e.position, enter: e.enter, exit: e.exit, seconds: seconds || 5, until });
  },

  text(e) {
    const box = el('div', 'item text', e.text || '');
    if (Number(e.fontSize)) box.style.fontSize = `${Number(e.fontSize)}px`;
    if (e.color) box.style.color = e.color;
    box.dataset.bg = e.background || 'none';
    show(box, { position: e.position, enter: e.enter, exit: e.exit, seconds: Number(e.duration) || 5 });
  },

  // The look set on the Overlay tab, for every kind of overlay.
  style(e) {
    const t = e.theme || {};
    const root = document.documentElement.style;
    const set = (name, value) => (value ? root.setProperty(name, value) : root.removeProperty(name));
    const font = String(t.font || '').replace(/[;{}<>]/g, '').trim();
    set('--font', font ? `${font}, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` : '');
    set('--text', COLOR_RE.test(t.textColor) ? t.textColor : '');
    set('--accent', COLOR_RE.test(t.accent) ? t.accent : '');
    set('--shadow', SHADOWS[t.shadow] || '');
    set('--box-bg', COLOR_RE.test(t.boxColor) ? rgba(t.boxColor, Number(t.boxOpacity ?? 78)) : '');
    set('--radius', Number.isFinite(Number(t.radius)) && t.radius !== '' ? `${Math.max(0, Number(t.radius))}px` : '');
    set('--scale', Number(t.scale) > 0 ? String(Number(t.scale) / 100) : '');
    let custom = document.getElementById('custom-css');
    if (!custom) {
      custom = el('style');
      custom.id = 'custom-css';
      document.head.append(custom);
    }
    custom.textContent = String(e.css || '');
  },

  sound(e) { playSound(e.soundSrc || e.src, e.volume); },

  clear() {
    for (const node of document.querySelectorAll('.item')) node.remove();
    for (const media of document.querySelectorAll('audio, video')) media.pause();
  },

  chat(e) {
    if (!chatMode || (chatOnly.length && !chatOnly.includes(e.platform))) return;
    const list = document.getElementById('chat');
    const item = el('li');
    if (params.get('badges') !== '0') {
      const badge = el('span', 'chat-platform', e.label || e.platform);
      badge.dataset.platform = e.platform;
      item.append(badge);
    }
    const name = el('span', 'chat-user', e.user || '');
    if (e.color && /^#[0-9a-f]{3,8}$/i.test(e.color)) name.style.color = e.color;
    item.append(name, el('span', 'chat-text', e.text || ''));
    list.append(item);
    const max = Math.max(1, Number(params.get('max')) || 12);
    while (list.children.length > max) list.firstElementChild.remove();
    const fade = Number(params.get('fade')) || 0;
    if (fade > 0) setTimeout(() => { item.classList.add('out'); setTimeout(() => item.remove(), EXIT_MS); }, fade * 1000);
  },

  spotify(e) {
    if (!spotifyMode) return;
    spotify.last = e;
    spotify.at = performance.now();
    const box = document.getElementById('spotify');
    const t = e.track;
    const idle = !t || (!e.isPlaying && params.get('idle') !== '1');
    box.classList.toggle('idle', idle);
    if (t) {
      const key = `${t.name}\n${t.artists}`;
      const art = box.querySelector('.np-art');
      if (params.get('art') !== '0' && t.image) { if (art.getAttribute('src') !== t.image) art.src = t.image; art.hidden = false; } else art.hidden = true;
      box.querySelector('.np-label').textContent = e.requestedBy && params.get('requester') !== '0' ? `Requested by ${e.requestedBy}` : 'Now playing';
      if (key !== spotify.key) {
        spotify.key = key;
        const title = box.querySelector('.np-title');
        title.firstElementChild.textContent = t.name;
        box.querySelector('.np-artist').textContent = t.artists;
        const card = box.querySelector('.np');
        card.classList.remove('changed');
        void card.offsetWidth;
        card.classList.add('changed');
        requestAnimationFrame(() => marquee(title));
      }
    }
    const max = Math.max(0, Math.min(10, Number(params.get('next')) || 0));
    const list = box.querySelector('.np-next');
    list.replaceChildren(...(e.next || []).slice(0, max).map((n) => {
      const item = el('li');
      item.append(el('span', 'np-next-title', n.name), el('span', 'np-next-artist', ` – ${n.artists}`));
      if (n.by && params.get('requester') !== '0') item.append(el('span', 'np-next-by', n.by));
      return item;
    }));
    list.hidden = !max || !list.children.length;
  },

  counter(e) {
    if (!counterName || String(e.name).toLowerCase() !== counterName) return;
    const box = document.getElementById('counter');
    const text = `${params.get('label') || ''}${e.value}`;
    if (box.textContent === text) return;
    box.textContent = text;
    box.classList.remove('bump');
    void box.offsetWidth;
    box.classList.add('bump');
  },
};

if (counterName) {
  const box = document.getElementById('counter');
  box.hidden = false;
  document.getElementById('stage').hidden = true;
  // Anything not in the link comes from the overlay style.
  if (Number(params.get('size'))) box.style.fontSize = `${Number(params.get('size'))}px`;
  const color = params.get('color') || '';
  if (color) box.style.color = /^[0-9a-f]{3,8}$/i.test(color) ? `#${color}` : color;
  if (params.get('font')) box.style.fontFamily = params.get('font');
}

if (chatMode) {
  const list = document.getElementById('chat');
  list.hidden = false;
  document.getElementById('stage').hidden = true;
  if (Number(params.get('size'))) list.style.setProperty('--chat-size', `${Number(params.get('size'))}px`);
  if (params.has('background')) list.style.setProperty('--chat-box', `rgba(10, 8, 20, ${Math.max(0, Math.min(1, Number(params.get('background')) || 0))})`);
}

// The song playing: the bar moves on between the app's updates, and a title
// too long for the box scrolls.
const spotify = { last: null, at: 0, key: '' };

function marquee(title) {
  const span = title.firstElementChild;
  const over = span.scrollWidth - title.clientWidth;
  title.classList.toggle('scroll', over > 4);
  title.style.setProperty('--over', `${-over - 24}px`);
  title.style.setProperty('--secs', `${Math.max(6, over / 30)}s`);
}

function spotifyFrame() {
  const e = spotify.last;
  if (e && e.track && e.track.durationMs) {
    const ms = e.progressMs + (e.isPlaying ? performance.now() - spotify.at : 0);
    document.querySelector('#spotify .np-bar span').style.width = `${Math.min(100, (ms / e.track.durationMs) * 100)}%`;
  }
  requestAnimationFrame(spotifyFrame);
}

if (spotifyMode) {
  const box = document.getElementById('spotify');
  box.hidden = false;
  box.classList.add('idle');
  document.getElementById('stage').hidden = true;
  if (Number(params.get('size')) > 0) box.style.setProperty('--np-size', `${Number(params.get('size'))}px`);
  if (params.get('progress') === '0') box.querySelector('.np-bar').hidden = true;
  requestAnimationFrame(spotifyFrame);
}

const query = new URLSearchParams();
if (instance) query.set('instance', instance);
if (params.has('preview')) query.set('preview', '1');  // the app's own previews
const source = new EventSource(`/events${query.toString() ? `?${query}` : ''}`);
source.onmessage = (msg) => {
  let event;
  try { event = JSON.parse(msg.data); } catch { return; }
  const handler = handlers[event.type];
  const wanted = event.type === 'style' || (counterName ? event.type === 'counter'
    : chatMode ? event.type === 'chat'
      : spotifyMode ? event.type === 'spotify'
        : !['counter', 'chat', 'spotify'].includes(event.type));
  if (handler && wanted) handler(event);
};
