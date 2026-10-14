'use strict';

// Turns the bindings the page stores ({ code, ctrl, alt, shift, meta }, where
// `code` is a KeyboardEvent.code) into Electron accelerator strings.
// https://www.electronjs.org/docs/latest/api/accelerator

const IS_MAC = process.platform === 'darwin';

// Keys whose accelerator name isn't just the code with its prefix removed.
const NAMED_KEYS = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Escape: 'Esc',
  Enter: 'Return',
  NumpadEnter: 'Return',
  Space: 'Space',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  PrintScreen: 'PrintScreen',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  IntlBackslash: '\\',
  NumpadAdd: 'numadd',
  NumpadSubtract: 'numsub',
  NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv',
  NumpadDecimal: 'numdec',
  // Pseudo-codes for the media keys. The page can't read these from a keydown
  // event, so it never captures them; the media-key option sends them directly.
  MediaPlayPause: 'MediaPlayPause',
  MediaTrackNext: 'MediaNextTrack',
  MediaTrackPrevious: 'MediaPreviousTrack',
  MediaStop: 'MediaStop',
};

// Keys that are useless or unsafe to grab system-wide on their own.
const MODIFIER_ONLY = /^(Shift|Control|Alt|Meta|OS|CapsLock|NumLock|ScrollLock|Fn|ContextMenu|Dead|Unidentified)/;

function keyName(code) {
  if (!code || MODIFIER_ONLY.test(code)) return null;
  if (Object.prototype.hasOwnProperty.call(NAMED_KEYS, code)) return NAMED_KEYS[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(6)}`;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return null;
}

const isMediaKey = (code) => typeof code === 'string' && code.startsWith('Media');

// A bare letter registered system-wide would swallow that key in every app, so
// ordinary keys need a modifier. Function and media keys are fine on their own.
function needsModifier(code) {
  return !isMediaKey(code) && !/^F([1-9]|1[0-9]|2[0-4])$/.test(code);
}

/**
 * @returns {{ accelerator: string } | { error: string }}
 */
function toAccelerator(binding) {
  if (!binding || !binding.code) return { error: 'not set' };
  const key = keyName(binding.code);
  if (!key) return { error: `${binding.code} can't be used as a global hotkey` };

  const parts = [];
  if (binding.ctrl) parts.push('Control');
  if (binding.alt) parts.push('Alt');
  if (binding.shift) parts.push('Shift');
  if (binding.meta) parts.push(IS_MAC ? 'Command' : 'Super');

  if (!parts.length && needsModifier(binding.code)) {
    return { error: 'add Ctrl, Alt, Shift or ⌘ — a plain key would be taken from every other app' };
  }
  parts.push(key);
  return { accelerator: parts.join('+') };
}

module.exports = { toAccelerator, isMediaKey };
