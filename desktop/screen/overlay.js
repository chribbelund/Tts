'use strict';

// The window the screen reader puts over a game (see overlay.html).
//   markers: the zone outlines and the box around what's being read
//   editor:  drawing, moving and resizing zones, by mouse or by keyboard
// Positions are fractions of the screen, so a zone stays put when the game's
// resolution changes.

(() => {
  // Opened on its own (overlay.html?demo) it shows the editor with a pretend
  // bridge, for working on it in a browser.
  const demo = !window.screenOverlay && /[?&]demo\b/.test(location.search);
  const api = window.screenOverlay || {
    role: demo ? 'editor' : 'markers',
    onState: () => {},
    done: (zones) => { console.log('done', zones); },
    say: (text) => { console.log('say:', text); },
  };

  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const live = $('live');
  const COLORS = ['#4fc3ff', '#ff8a3d', '#7dff6b', '#ff5fd2', '#ffe14d', '#b18cff', '#3dffd8', '#ff6b6b'];
  const MIN = 0.01;          // the smallest a zone can be, as a fraction of the screen
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const pct = (v) => `${Math.round(v * 100)}%`;

  let state = { zones: [], focus: null, showZones: false };

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function place(node, r) {
    node.style.left = `${r.x * 100}%`;
    node.style.top = `${r.y * 100}%`;
    node.style.width = `${r.w * 100}%`;
    node.style.height = `${r.h * 100}%`;
  }

  // -------------------------------------------------------------------------
  // Markers
  // -------------------------------------------------------------------------

  let focusBox = null;
  let fadeTimer = null;

  function drawMarkers() {
    document.body.className = 'markers';
    stage.querySelectorAll('.zone').forEach((n) => n.remove());
    if (state.showZones) {
      for (const [i, z] of (state.zones || []).entries()) {
        const node = el('div', `zone${z.on === false ? ' off' : ''}`);
        node.style.setProperty('--c', z.color || COLORS[i % COLORS.length]);
        place(node, z.rect);
        if (z.rect.y < 0.05) node.classList.add('label-inside');
        node.append(el('span', 'zone-label', `${i + 1} ${z.name || ''}`.trim()));
        stage.append(node);
      }
    }
    const f = state.focus;
    if (f && f.rect) {
      if (!focusBox) { focusBox = el('div', 'focus-box'); stage.append(focusBox); }
      const pad = 0.004;
      place(focusBox, { x: f.rect.x - pad, y: f.rect.y - pad, w: f.rect.w + pad * 2, h: f.rect.h + pad * 2 });
      focusBox.classList.remove('fading');
      clearTimeout(fadeTimer);
      if (f.hold !== true) fadeTimer = setTimeout(() => focusBox && focusBox.classList.add('fading'), Math.max(800, f.ms || 2500));
    } else if (focusBox) {
      focusBox.classList.add('fading');
    }
  }

  // -------------------------------------------------------------------------
  // Editor
  // -------------------------------------------------------------------------

  let zones = [];
  let selected = '';
  let drag = null;
  let moveTimer = null;
  const nodes = new Map();

  const current = () => zones.find((z) => z.id === selected) || null;
  const indexOf = (z) => zones.indexOf(z) + 1;
  const uid = () => `z${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  function say(text, { speak = true } = {}) {
    live.textContent = '';
    setTimeout(() => { live.textContent = text; }, 30);
    if (speak) api.say(text);
  }

  function where(z) {
    return `${z.name || `Box ${indexOf(z)}`}: ${pct(z.rect.x)} from the left, ${pct(z.rect.y)} from the top, ${pct(z.rect.w)} wide, ${pct(z.rect.h)} tall.`;
  }

  function fit(r) {
    const w = clamp(r.w, MIN, 1);
    const h = clamp(r.h, MIN, 1);
    return { x: clamp(r.x, 0, 1 - w), y: clamp(r.y, 0, 1 - h), w, h };
  }

  function drawEditor() {
    document.body.className = 'editor';
    for (const [id, node] of nodes) {
      if (!zones.some((z) => z.id === id)) { node.remove(); nodes.delete(id); }
    }
    zones.forEach((z, i) => {
      let node = nodes.get(z.id);
      if (!node) {
        node = el('div', 'zone');
        node.dataset.id = z.id;
        node.append(el('span', 'zone-label'));
        for (const h of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
          const handle = el('span', 'handle');
          handle.dataset.h = h;
          node.append(handle);
        }
        stage.append(node);
        nodes.set(z.id, node);
      }
      node.style.setProperty('--c', z.color || COLORS[i % COLORS.length]);
      place(node, z.rect);
      node.classList.toggle('selected', z.id === selected);
      node.classList.toggle('label-inside', z.rect.y < 0.05);
      node.querySelector('.zone-label').textContent = `${i + 1} ${z.name || ''}`.trim();
      const pos = { nw: [0, 0], n: [50, 0], ne: [100, 0], e: [100, 50], se: [100, 100], s: [50, 100], sw: [0, 100], w: [0, 50] };
      for (const handle of node.querySelectorAll('.handle')) {
        const [x, y] = pos[handle.dataset.h];
        handle.style.left = `${x}%`;
        handle.style.top = `${y}%`;
        handle.hidden = z.id !== selected;
      }
    });
    const z = current();
    $('tbName').value = z ? z.name || '' : '';
    $('tbName').disabled = !z;
    $('tbDelete').disabled = !z;
    $('tbPos').textContent = z ? `${pct(z.rect.x)}, ${pct(z.rect.y)} · ${pct(z.rect.w)} × ${pct(z.rect.h)}` : 'No box selected';
  }

  function select(z, { announce = true } = {}) {
    clearTimeout(moveTimer);
    selected = z ? z.id : '';
    drawEditor();
    if (z && announce) say(`Box ${indexOf(z)} of ${zones.length}. ${where(z)}`);
  }

  function addZone(rect, { announce = true } = {}) {
    const n = zones.length + 1;
    const z = { id: uid(), name: `Zone ${n}`, rect: fit(rect), color: COLORS[(n - 1) % COLORS.length], isNew: true };
    zones.push(z);
    select(z, { announce: false });
    if (announce) say(`New box, ${z.name}. Move it with the arrow keys, resize it with Alt and the arrow keys.`);
    return z;
  }

  function removeSelected() {
    const z = current();
    if (!z) return;
    const i = zones.indexOf(z);
    zones.splice(i, 1);
    const next = zones[Math.min(i, zones.length - 1)] || null;
    select(next, { announce: false });
    say(`Deleted ${z.name || 'the box'}.${next ? ` ${next.name} is selected.` : ' No boxes left.'}`);
  }

  function finish(save) {
    api.done(save ? zones.map(({ isNew, ...z }) => ({ ...z, rect: fit(z.rect) })) : null, selected);
  }

  // Said once the arrow keys have stopped, rather than for every step.
  function moved(z) {
    drawEditor();
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => say(where(z)), 450);
  }

  function pointer(e) {
    return { x: clamp(e.clientX / window.innerWidth, 0, 1), y: clamp(e.clientY / window.innerHeight, 0, 1) };
  }

  function onPointerDown(e) {
    if (e.button !== 0 || e.target.closest('.toolbar')) return;
    e.preventDefault();
    const p = pointer(e);
    const zoneNode = e.target.closest('.zone');
    if (zoneNode) {
      const z = zones.find((x) => x.id === zoneNode.dataset.id);
      if (!z) return;
      if (z.id !== selected) select(z, { announce: false });
      drag = { kind: e.target.dataset.h || 'move', z, start: p, from: { ...z.rect } };
    } else {
      const z = addZone({ x: p.x, y: p.y, w: MIN, h: MIN }, { announce: false });
      drag = { kind: 'se', z, start: p, from: { ...z.rect }, creating: true };
    }
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp, { once: true });
  }

  function onPointerMove(e) {
    if (!drag) return;
    const p = pointer(e);
    const dx = p.x - drag.start.x;
    const dy = p.y - drag.start.y;
    const f = drag.from;
    let { x, y, w, h } = f;
    if (drag.kind === 'move') {
      x = clamp(f.x + dx, 0, 1 - f.w);
      y = clamp(f.y + dy, 0, 1 - f.h);
    } else {
      let left = f.x, top = f.y, right = f.x + f.w, bottom = f.y + f.h;
      if (drag.kind.includes('w')) left = clamp(f.x + dx, 0, right - MIN);
      if (drag.kind.includes('e')) right = clamp(f.x + f.w + dx, left + MIN, 1);
      if (drag.kind.includes('n')) top = clamp(f.y + dy, 0, bottom - MIN);
      if (drag.kind.includes('s')) bottom = clamp(f.y + f.h + dy, top + MIN, 1);
      x = left; y = top; w = right - left; h = bottom - top;
    }
    drag.z.rect = { x, y, w, h };
    drawEditor();
  }

  function onPointerUp() {
    window.removeEventListener('pointermove', onPointerMove);
    const d = drag;
    drag = null;
    if (!d) return;
    // A click without a drag makes a box of a useful size rather than a dot.
    if (d.creating && d.z.rect.w < 0.02 && d.z.rect.h < 0.02) d.z.rect = fit({ x: d.z.rect.x - 0.1, y: d.z.rect.y - 0.04, w: 0.2, h: 0.08 });
    drawEditor();
    say(d.creating ? `New box, ${d.z.name}. ${where(d.z)}` : where(d.z));
  }

  function onKey(e) {
    const inName = e.target === $('tbName');
    if (e.key === 'Escape') {
      e.preventDefault();
      if (inName) { $('tbName').blur(); return; }
      finish(false);
      return;
    }
    if (e.key === 'Enter') {
      if (e.target.tagName === 'BUTTON' || e.target.tagName === 'SUMMARY') return;
      e.preventDefault();
      if (inName) { $('tbName').blur(); say(`Named ${current() ? current().name : ''}`); return; }
      finish(true);
      return;
    }
    if (inName || e.metaKey || e.ctrlKey) return;
    const z = current();
    if (e.key === 'Tab') {
      if (e.target.closest && e.target.closest('.toolbar')) return;
      e.preventDefault();
      if (!zones.length) { say('No boxes yet. Press N to make one.'); return; }
      const i = zones.indexOf(z);
      select(zones[(i + (e.shiftKey ? -1 : 1) + zones.length) % zones.length]);
      return;
    }
    if (/^[1-9]$/.test(e.key)) {
      const target = zones[Number(e.key) - 1];
      if (target) { e.preventDefault(); select(target); }
      return;
    }
    const k = e.key.toLowerCase();
    if (k === 'n') { e.preventDefault(); addZone({ x: 0.375, y: 0.425, w: 0.25, h: 0.15 }); return; }
    if (k === 'w') { e.preventDefault(); say(z ? where(z) : 'No box selected.'); return; }
    if (k === 'r' && z) { e.preventDefault(); $('tbName').focus(); $('tbName').select(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && z) { e.preventDefault(); removeSelected(); return; }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[e.key] && z) {
      e.preventDefault();
      const step = e.shiftKey ? 0.05 : 0.005;
      const [dx, dy] = arrows[e.key];
      const r = z.rect;
      z.rect = e.altKey
        ? fit({ x: r.x, y: r.y, w: r.w + dx * step, h: r.h + dy * step })
        : fit({ ...r, x: r.x + dx * step, y: r.y + dy * step });
      moved(z);
    }
  }

  function startEditor(s) {
    zones = (s.zones || []).map((z, i) => ({ ...z, rect: fit(z.rect || { x: 0.3, y: 0.3, w: 0.4, h: 0.2 }), color: z.color || COLORS[i % COLORS.length] }));
    $('toolbar').hidden = false;
    document.title = 'Reading zones';
    stage.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey);
    $('tbNew').onclick = () => addZone({ x: 0.375, y: 0.425, w: 0.25, h: 0.15 });
    $('tbDelete').onclick = removeSelected;
    $('tbSave').onclick = () => finish(true);
    $('tbCancel').onclick = () => finish(false);
    $('tbMove').onclick = () => $('toolbar').classList.toggle('at-bottom');
    $('tbName').addEventListener('input', () => {
      const z = current();
      if (!z) return;
      z.name = $('tbName').value.slice(0, 40);
      drawEditor();
    });
    select(zones.find((z) => z.id === s.selected) || zones[0] || null, { announce: false });
    say(zones.length
      ? `Editing ${zones.length} reading zone${zones.length === 1 ? '' : 's'}. Tab moves between them, arrow keys move one, N makes a new one. Enter saves, Escape cancels.`
      : 'Draw a box around text to read, or press N for a new box. Enter saves, Escape cancels.');
    window.focus();
  }

  // -------------------------------------------------------------------------

  let started = false;
  api.onState((s) => {
    state = s || {};
    if (api.role === 'editor') {
      if (!started) { started = true; startEditor(state); }
      return;
    }
    drawMarkers();
  });

  if (demo) {
    startEditor({
      zones: [
        { id: 'a', name: 'Subtitles', rect: { x: 0.15, y: 0.78, w: 0.7, h: 0.15 } },
        { id: 'b', name: 'Objective', rect: { x: 0.72, y: 0.12, w: 0.26, h: 0.18 } },
      ],
    });
  }
})();
