'use strict';

// Turning raw chat text into something that sounds natural when spoken.

const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[\w-]+\.(?:com|net|org|tv|gg|io|co|me|ly|be|dev|app|xyz)(?:\/\S*)?\b/gi;
const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}\u{20E3}]/gu;

function hashString(s) {
  let h = 2166136261;
  for (const ch of s) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Twitch gives emote positions as code point ranges: "25:0-4,12-16/1902:6-10".
function removeEmotes(text, emotesTag) {
  if (!emotesTag) return text;
  const chars = Array.from(text);
  const ranges = [];
  for (const group of emotesTag.split('/')) {
    const positions = group.split(':')[1];
    if (!positions) continue;
    for (const range of positions.split(',')) {
      const [start, end] = range.split('-').map(Number);
      if (Number.isFinite(start) && Number.isFinite(end)) ranges.push([start, end]);
    }
  }
  ranges.sort((a, b) => b[0] - a[0]);
  for (const [start, end] of ranges) chars.splice(start, end - start + 1, ' ');
  return chars.join('');
}

function normalizeLogin(name) {
  return (name || '').trim().replace(/^@/, '').toLowerCase();
}

// A nickname set by the user wins. Otherwise prefer the display name, but fall
// back to the login when the display name uses a script the voice probably
// can't pronounce. Underscores read badly.
function speakableName(displayName, login, nicknames) {
  const nickname = nicknames && (nicknames[normalizeLogin(login)] || nicknames[normalizeLogin(displayName)]);
  if (nickname) return nickname;
  const name = displayName && /^[\x20-\x7E]+$/.test(displayName) ? displayName : (login || displayName || 'someone');
  return name.replace(/_+/g, ' ').trim() || login || 'someone';
}

function stripLeadingMention(text, login, displayName) {
  const names = [login, displayName].filter(Boolean).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!names.length) return text;
  return text.replace(new RegExp(`^\\s*@(?:${names.join('|')})\\b[,:]?\\s*`, 'i'), '');
}

function truncateAtWord(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:!?-]+$/, '') + '…';
}

function cleanForSpeech(text, { readEmojis = false, maxLength = 0, nicknames = null } = {}) {
  let t = text;
  t = t.replace(URL_RE, ' link ');
  if (!readEmojis) t = t.replace(EMOJI_RE, ' ');
  t = t.replace(/@([\w]+)/g, (_, name) => (nicknames && nicknames[name.toLowerCase()]) || name.replace(/_+/g, ' '));
  // "noooooooo" -> "nooo", "!!!!!!!" -> "!!!" (leave digits alone)
  t = t.replace(/([^\d\s])\1{3,}/gu, '$1$1$1');
  // "lol lol lol lol lol" -> "lol lol lol"
  t = t.replace(/(^|\s)(\S+)(?:\s+\2){3,}(?=\s|$)/giu, '$1$2 $2 $2');
  t = t.replace(/\s+/g, ' ').trim();
  if (!/[\p{L}\p{N}]/u.test(t)) return '';
  if (maxLength > 0) t = truncateAtWord(t, maxLength);
  return t;
}

/** Split text into sentence-sized chunks no longer than `max` characters. */
function splitIntoChunks(text, max = 180) {
  const sentences = text.match(/[^.!?…]+[.!?…]*["')\]]*\s*|[.!?…]+\s*/g) || [text];
  const chunks = [];
  let current = '';
  const push = () => { if (current.trim()) chunks.push(current); current = ''; };
  for (const sentence of sentences) {
    if (sentence.length > max) {
      push();
      let piece = '';
      // (No regex lookbehind here: it's a syntax error before Safari 16.4.)
      for (const word of sentence.match(/\S+\s*/g) || [sentence]) {
        if ((piece + word).length > max && piece) { chunks.push(piece); piece = ''; }
        piece += word;
      }
      current = piece;
    } else if ((current + sentence).length > max) {
      push();
      current = sentence;
    } else {
      current += sentence;
    }
  }
  push();
  return chunks.length ? chunks : [text];
}

/**
 * Build the sentence that is actually spoken for a chat entry.
 * `prev` is the previously spoken entry (used to avoid repeating names).
 * Returns '' when there is nothing worth saying (e.g. emote-only message).
 */
function composeSpeech(entry, prev, settings) {
  const nicknames = settings.nicknames || {};
  const opts = { readEmojis: settings.readEmojis, maxLength: settings.maxLength, nicknames };
  const name = speakableName(entry.displayName, entry.login, nicknames);
  const body = cleanForSpeech(entry.speechBody, opts);

  if (entry.kind === 'event') {
    let systemText = entry.systemText || '';
    const nickname = nicknames[normalizeLogin(entry.login)];
    if (nickname && entry.displayName) systemText = systemText.split(entry.displayName).join(nickname);
    const system = cleanForSpeech(systemText, { readEmojis: false, nicknames });
    if (!system || !body) return system || body;
    return /[.!?…]$/.test(system) ? `${system} ${body}` : `${system}. ${body}`;
  }

  if (entry.kind === 'announcement') {
    return body ? `Announcement from ${name}: ${body}` : '';
  }

  if (!body) return '';

  if (entry.action) return `${name} ${body}`;

  if (entry.isReply) {
    const parent = speakableName(entry.parentDisplayName, entry.parentLogin, nicknames);
    let lead = settings.nameFormat === 'none'
      ? `Reply to ${parent}`
      : `${name}, replying to ${parent}`;
    if (settings.quoteParent && entry.parentBody) {
      const quoted = cleanForSpeech(entry.parentBody.replace(/^\s*@\S+\s*/, ''),{ readEmojis: false, maxLength: 90, nicknames });
      if (quoted) lead += `, who said, “${quoted}”`;
    }
    return `${lead}: ${body}`;
  }

  const sameSpeaker = settings.collapseNames && prev && prev.login === entry.login &&
    prev.kind === 'chat' && entry.receivedAt - prev.receivedAt < 30000;

  if (settings.nameFormat === 'none' || sameSpeaker) return body;
  if (settings.nameFormat === 'says') return `${name} says: ${body}`;
  return `${name}: ${body}`;
}
