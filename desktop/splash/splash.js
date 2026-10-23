// Shows what splash-main.js sends: { text, percent, detail, canSkip }.
// `percent` null means "busy, no number yet".
'use strict';

const status = document.getElementById('status');
const bar = document.getElementById('bar');
const fill = document.getElementById('fill');
const detail = document.getElementById('detail');
const skip = document.getElementById('skip');

window.splash.onStatus(({ text, percent, detail: more, canSkip }) => {
  status.textContent = text || '';
  detail.textContent = more || '';
  const busy = typeof percent !== 'number';
  bar.dataset.busy = String(busy);
  fill.style.width = busy ? '' : `${Math.max(0, Math.min(100, percent))}%`;
  if (busy) bar.removeAttribute('aria-valuenow');
  else bar.setAttribute('aria-valuenow', String(Math.round(percent)));
  // Hidden but still taking up its space, so nothing jumps when it appears.
  skip.style.visibility = canSkip ? 'visible' : 'hidden';
});

skip.addEventListener('click', () => {
  skip.disabled = true;
  window.splash.skip();
});
