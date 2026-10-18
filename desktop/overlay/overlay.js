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
const chatOnly = (params.get('platforms') || '').toLowerCase().split(',').filter(Boolean);

const EXIT_MS = 520;

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
    box.style.setProperty('--accent', e.color || '#a37bff');
    box.style.setProperty('--text', e.textColor || '#ffffff');
    box.style.setProperty('--size', `${Number(e.fontSize) || 36}px`);
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
    box.style.fontSize = `${Number(e.fontSize) || 48}px`;
    box.style.color = e.color || '#fff';
    box.dataset.bg = e.background || 'none';
    show(box, { position: e.position, enter: e.enter, exit: e.exit, seconds: Number(e.duration) || 5 });
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
  box.style.fontSize = `${Number(params.get('size')) || 64}px`;
  const color = params.get('color') || 'ffffff';
  box.style.color = /^[0-9a-f]{3,8}$/i.test(color) ? `#${color}` : color;
  if (params.get('font')) box.style.fontFamily = params.get('font');
}

if (chatMode) {
  const list = document.getElementById('chat');
  list.hidden = false;
  document.getElementById('stage').hidden = true;
  list.style.setProperty('--chat-size', `${Number(params.get('size')) || 26}px`);
  if (params.has('background')) list.style.setProperty('--chat-bg', String(Math.max(0, Math.min(1, Number(params.get('background')) || 0))));
}

const source = new EventSource(`/events${instance ? `?instance=${encodeURIComponent(instance)}` : ''}`);
source.onmessage = (msg) => {
  let event;
  try { event = JSON.parse(msg.data); } catch { return; }
  const handler = handlers[event.type];
  const wanted = counterName ? event.type === 'counter' : chatMode ? event.type === 'chat' : event.type !== 'counter' && event.type !== 'chat';
  if (handler && wanted) handler(event);
};
