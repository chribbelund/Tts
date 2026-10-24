'use strict';

// The window the screen reader puts over a game (see overlay.html).
//   markers: the zone outlines and the box around what's being read
//   editor:  drawing, moving and resizing zones, by mouse or by keyboard,
//            over the screen or over a screenshot of a game
// Positions are fractions of the screen (or of the screenshot), so a zone
// stays put when the game's resolution changes.

(() => {
  // Opened on its own (overlay.html?demo) it shows the editor with a pretend
  // bridge, for working on it in a browser.
  const demo = !window.screenOverlay && /[?&]demo\b/.test(location.search);
  const api = window.screenOverlay || {
    role: demo ? 'editor' : 'markers',
    onState: () => {},
    onFrame: () => {},
    done: (zones) => { console.log('done', zones); },
    say: (text) => { console.log('say:', text); },
  };

  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const live = $('live');
  const COLORS = ['#4fc3ff', '#ff8a3d', '#7dff6b', '#ff5fd2', '#ffe14d', '#b18cff', '#3dffd8', '#ff6b6b'];
  const MIN_PX = 6;          // the smallest a zone can be, in pixels: a cooldown number is tiny
  const CLICK_PX = 5;        // a press that moves less than this is a click, not a drag
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  // Small boxes get a decimal, or a 12-pixel box would be "1% wide".
  const pct = (v) => `${v < 0.1 ? Math.round(v * 1000) / 10 : Math.round(v * 100)}%`;

  // The screen, inside this window. Zones are fractions of the screen, and
  // the window may not cover all of it (or may start above it), so the stage
  // is sized and placed as the screen itself. Over a screenshot, the stage is
  // the screenshot, as big as fits on the screen.
  let frame = null;
  let picture = null;   // { url, width, height }
  function layoutStage() {
    let { x, y, width, height } = frame || { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
    if (!(width > 0) || !(height > 0)) return;
    if (picture) {
      const s = Math.min(width / picture.width, height / picture.height);
      const w = picture.width * s, h = picture.height * s;
      x += (width - w) / 2; y += (height - h) / 2; width = w; height = h;
    }
    Object.assign(stage.style, { inset: 'auto', left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` });
  }
  function applyFrame(f) {
    if (!f || !(f.width > 0) || !(f.height > 0)) return;
    frame = f;
    layoutStage();
  }
  api.onFrame(applyFrame);
  window.addEventListener('resize', () => { if (picture && !frame) layoutStage(); });
  const stageSize = () => {
    const r = stage.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? r : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  };
  const minW = () => MIN_PX / stageSize().width;
  const minH = () => MIN_PX / stageSize().height;

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

  // A box too small for a thick border inside it (it would hide the number
  // it's around) gets a thin line outside instead.
  const TINY_PX = 44;
  const isTiny = (r) => {
    const s = stageSize();
    return r.w * s.width < TINY_PX || r.h * s.height < TINY_PX;
  };

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
        if (isTiny(z.rect)) node.classList.add('tiny');
        else if (z.rect.y < 0.05) node.classList.add('label-inside');
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
    const w = clamp(r.w, minW(), 1);
    const h = clamp(r.h, minH(), 1);
    return { x: clamp(r.x, 0, 1 - w), y: clamp(r.y, 0, 1 - h), w, h };
  }

  function drawEditor() {
    document.body.className = picture ? 'editor picture' : 'editor';
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
      const tiny = isTiny(z.rect);
      node.classList.toggle('tiny', tiny);
      node.classList.toggle('label-inside', !tiny && z.rect.y < 0.05);
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
    const mode = $('tbMode');
    mode.disabled = !z;
    mode.value = z ? z.mode || 'changes' : 'changes';
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
    const z = { id: uid(), name: `Zone ${n}`, rect: fit(rect), color: COLORS[(n - 1) % COLORS.length], mode: 'changes', isNew: true };
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
    const r = stageSize();
    return { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1) };
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
      drag = { kind: e.target.dataset.h || 'move', z, start: p, from: { ...z.rect }, px: [e.clientX, e.clientY], moved: false };
    } else {
      const z = addZone({ x: p.x, y: p.y, w: 0, h: 0 }, { announce: false });
      drag = { kind: 'se', z, start: p, from: { x: p.x, y: p.y, w: 0, h: 0 }, creating: true, px: [e.clientX, e.clientY], moved: false };
    }
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp, { once: true });
  }

  function onPointerMove(e) {
    if (!drag) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.px[0], e.clientY - drag.px[1]) < CLICK_PX) return;
    drag.moved = true;
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
      if (drag.kind.includes('w')) left = clamp(f.x + dx, 0, right - minW());
      if (drag.kind.includes('e')) right = clamp(f.x + f.w + dx, left + minW(), 1);
      if (drag.kind.includes('n')) top = clamp(f.y + dy, 0, bottom - minH());
      if (drag.kind.includes('s')) bottom = clamp(f.y + f.h + dy, top + minH(), 1);
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
    // Only a click: a small box drawn on purpose (around a cooldown number)
    // stays as small as it was drawn.
    if (d.creating && !d.moved) d.z.rect = fit({ x: d.start.x - 0.1, y: d.start.y - 0.04, w: 0.2, h: 0.08 });
    // A box that was clicked but not dragged hasn't moved.
    if (!d.creating && !d.moved) { drawEditor(); return; }
    d.z.rect = fit(d.z.rect);
    drawEditor();
    say(d.creating ? `New box, ${d.z.name}. ${where(d.z)}` : where(d.z));
  }

  function onKey(e) {
    const inName = e.target === $('tbName');
    if (e.target === $('tbMode') && e.key !== 'Escape' && e.key !== 'Enter') return;
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
    if (s.picture && s.picture.url) {
      picture = s.picture;
      const img = el('img', 'stage-picture');
      img.alt = '';
      img.src = picture.url;
      stage.prepend(img);
      layoutStage();
      $('tbTitle').textContent = 'Zones on a screenshot';
      $('tbHelp').textContent = 'These boxes are suggestions from the text found in the screenshot. Move, resize, rename or delete them, and draw more. Saving makes them a new profile.';
    }
    zones = (s.zones || []).map((z, i) => ({ ...z, rect: fit(z.rect || { x: 0.3, y: 0.3, w: 0.4, h: 0.2 }), color: z.color || COLORS[i % COLORS.length] }));
    $('toolbar').hidden = false;
    document.title = picture ? 'Zones on a screenshot' : 'Reading zones';
    stage.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey);
    $('tbNew').onclick = () => addZone({ x: 0.375, y: 0.425, w: 0.25, h: 0.15 });
    $('tbDelete').onclick = removeSelected;
    const modes = Array.isArray(s.modes) && s.modes.length ? s.modes : [['changes', 'Text when it changes']];
    $('tbMode').replaceChildren(...modes.map(([value, label]) => {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      return o;
    }));
    $('tbMode').addEventListener('change', () => {
      const z = current();
      if (!z) return;
      z.mode = $('tbMode').value;
      drawEditor();
    });
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
    const what = picture ? `A screenshot with ${zones.length} suggested zone${zones.length === 1 ? '' : 's'}.` : `Editing ${zones.length} reading zone${zones.length === 1 ? '' : 's'}.`;
    say(zones.length
      ? `${what} Tab moves between them, arrow keys move one, N makes a new one. Enter saves, Escape cancels.`
      : `${picture ? 'No text was found in the screenshot. ' : ''}Draw a box around text to read, or press N for a new box. Enter saves, Escape cancels.`);
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
        { id: 'c', name: 'Estus', mode: 'count', rect: { x: 0.08, y: 0.86, w: 0.012, h: 0.025 } },
      ],
      modes: [['changes', 'Text when it changes'], ['new-lines', 'New lines'], ['cooldown', 'Cooldown'], ['count', 'A number'], ['manual', 'When I ask']],
    });
  }
})();
