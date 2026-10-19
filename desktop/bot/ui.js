'use strict';

// The pieces every part of the bot's screens uses — form controls, the
// effect list editor, the conditions editor, the variable picker and the item
// editor dialog. The tabs themselves are in ui-tabs.js and the others; the
// window they're shown in (the sections down the side and the Dashboard) is
// shell.js.

const UI = Bot.ui = { tabs: [], rewardsCache: null };
const h = Bot.host.el;
let idSeq = 0;
const nid = () => `bot-f${++idSeq}`;

UI.h = h;

// ---------------------------------------------------------------------------
// Controls. Each one writes straight into `obj[key]` and calls `onChange`.
// ---------------------------------------------------------------------------

UI.field = (label, control, hint = '') => {
  const target = control.matches && control.matches('input, select, textarea') ? control : control.querySelector && control.querySelector('input, select, textarea');
  if (target && !target.id) target.id = nid();
  return h('div', { class: 'field' },
    h('label', { class: 'row-label', for: target ? target.id : null }, label),
    control,
    hint ? h('p', { class: 'hint' }, hint) : null);
};

UI.text = (obj, key, { placeholder = '', onChange = null, multiline = false, rows = 3, vars = false, extraVars = null, type = 'text', list = null, maxlength = null, cls = '' } = {}) => {
  const node = multiline
    ? h('textarea', { rows, spellcheck: 'false', placeholder, class: cls })
    : h('input', { type, spellcheck: 'false', autocomplete: 'off', placeholder, list, maxlength, class: cls });
  node.value = obj[key] === undefined || obj[key] === null ? '' : obj[key];
  node.addEventListener('input', () => { obj[key] = node.value; if (onChange) onChange(node.value); });
  return vars ? UI.withVars(node, extraVars) : node;
};

UI.number = (obj, key, { min = null, max = null, step = 1, onChange = null } = {}) => {
  const node = h('input', { type: 'number', min, max, step });
  node.value = obj[key] ?? '';
  node.addEventListener('change', () => {
    let n = Number(node.value);
    if (!Number.isFinite(n)) n = Number(obj[key]) || 0;
    if (min !== null) n = Math.max(min, n);
    if (max !== null) n = Math.min(max, n);
    obj[key] = n;
    node.value = n;
    if (onChange) onChange(n);
  });
  return node;
};

UI.range = (obj, key, { min = 0, max = 100, step = 1, onChange = null, suffix = '%' } = {}) => {
  const node = h('input', { type: 'range', min, max, step });
  node.value = obj[key] ?? max;
  const out = h('output', {}, `${node.value}${suffix}`);
  node.addEventListener('input', () => {
    obj[key] = Number(node.value);
    out.textContent = `${node.value}${suffix}`;
    if (onChange) onChange(obj[key]);
  });
  return h('div', { class: 'bot-range' }, node, out);
};

// options: [[value, label], …] or [{ group, options: [[value, label]] }, …]
UI.options = (selectEl, options, current) => {
  const make = ([value, label]) => {
    const o = h('option', { value }, label);
    if (String(value) === String(current)) o.selected = true;
    return o;
  };
  selectEl.replaceChildren(...options.map((opt) => (Array.isArray(opt) ? make(opt) : h('optgroup', { label: opt.group }, opt.options.map(make)))));
};

UI.select = (obj, key, options, { onChange = null, label = null } = {}) => {
  const node = h('select', { 'aria-label': label });
  UI.options(node, typeof options === 'function' ? options() : options, obj[key]);
  // A saved value that is no longer offered is kept, not silently replaced.
  if (obj[key] !== undefined && obj[key] !== '' && node.value !== String(obj[key])) {
    node.prepend(h('option', { value: obj[key], selected: true }, `${obj[key]} (missing)`));
  }
  node.addEventListener('change', () => { obj[key] = node.value; if (onChange) onChange(node.value); });
  return node;
};

UI.color = (obj, key, { onChange = null, fallback = '#ffffff' } = {}) => {
  const node = h('input', { type: 'color' });
  node.value = obj[key] || fallback;
  node.addEventListener('input', () => { obj[key] = node.value; if (onChange) onChange(node.value); });
  return node;
};

UI.check = (obj, key, label, { onChange = null } = {}) => {
  const box = h('input', { type: 'checkbox' });
  box.checked = !!obj[key];
  box.addEventListener('change', () => { obj[key] = box.checked; if (onChange) onChange(box.checked); });
  return h('label', { class: 'check' }, box, h('span', {}, label));
};

UI.button = (label, onclick, { cls = 'btn small', title = null, aria = null, disabled = false } = {}) => {
  const b = h('button', { type: 'button', class: cls, title, 'aria-label': aria, onclick });
  b.textContent = label;
  if (disabled) b.disabled = true;
  return b;
};

// Runs an async action from a button, with the button disabled meanwhile and
// any error shown in `status`.
UI.busy = async (button, fn, status = null) => {
  const label = button.textContent;
  button.disabled = true;
  try {
    const result = await fn();
    return result;
  } catch (err) {
    if (status) UI.say(status, err.message, true);
    else Bot.log('error', err.message);
    return null;
  } finally {
    button.disabled = false;
    if (button.textContent === '…') button.textContent = label;
  }
};

UI.status = () => h('p', { class: 'hint bot-status', role: 'status' });
UI.say = (node, text, bad = false) => {
  node.textContent = text;
  node.classList.toggle('bad', !!bad);
};

UI.copyButton = (getText, label = 'Copy') => {
  const b = UI.button(label, async () => {
    try { await navigator.clipboard.writeText(getText()); b.textContent = 'Copied'; } catch { b.textContent = 'Couldn’t copy'; }
    setTimeout(() => { b.textContent = label; }, 1500);
  });
  return b;
};

UI.time = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
UI.date = (at) => (at ? new Date(at).toLocaleDateString() : '–');
const trim = (text, n = 70) => {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
UI.trim = trim;

UI.permissionOptions = () => [
  ...Bot.ROLES.map((r) => [r.id, r.name]),
  ...(Bot.data.roles.length ? [{ group: 'Custom roles', options: Bot.data.roles.map((r) => [`role:${r.id}`, r.name]) }] : []),
];

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

UI.file = (obj, key, { kind = 'media', save = false, onChange = null, defaultName = '' } = {}) => {
  const name = h('span', { class: 'file-name' });
  const clear = UI.button('×', () => { obj[key] = ''; render(); if (onChange) onChange(''); }, { cls: 'x', aria: 'Remove the file', title: 'Remove' });
  const play = kind === 'sound' ? UI.button('▶', () => {
    if (!obj[key]) return;
    const a = new Audio(Bot.fileUrl(obj[key]));
    a.volume = (Bot.data.sound.volume ?? 100) / 100;
    if (Bot.data.sound.device && a.setSinkId) a.setSinkId(Bot.data.sound.device).catch(() => {});
    a.play().catch((err) => Bot.log('error', err.message));
  }, { cls: 'x', aria: 'Hear it', title: 'Hear it' }) : null;
  const choose = UI.button(save ? 'Choose where…' : 'Choose…', async () => {
    const r = await Bot.desktop.pickFile({ kind, save, defaultName });
    if (r && r.path) { obj[key] = r.path; render(); if (onChange) onChange(r.path); }
  });
  const render = () => {
    name.textContent = obj[key] ? String(obj[key]).split(/[\\/]/).pop() : 'None';
    name.title = obj[key] || '';
    clear.hidden = !obj[key];
    if (play) play.hidden = !obj[key];
  };
  render();
  return h('div', { class: 'file-row' }, choose, name, play, clear);
};

// ---------------------------------------------------------------------------
// The variable picker: a "$" button by a text field opens a list to insert from
// ---------------------------------------------------------------------------

UI.withVars = (input, extraVars = null) => {
  const panel = h('div', { class: 'var-panel', hidden: true });
  const button = UI.button('$', () => {
    if (!panel.hidden) { panel.hidden = true; button.setAttribute('aria-expanded', 'false'); return; }
    renderPanel();
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    panel.querySelector('input').focus();
  }, { cls: 'btn small var-btn', title: 'Insert a $variable', aria: 'Insert a variable' });
  button.setAttribute('aria-expanded', 'false');

  // Where the caret was when the field was last used; never used means the end.
  let caret = null;
  const remember = () => { caret = [input.selectionStart, input.selectionEnd]; };
  for (const type of ['keyup', 'click', 'select', 'input']) input.addEventListener(type, remember);

  const insert = (usage) => {
    const [start, end] = caret || [input.value.length, input.value.length];
    input.value = input.value.slice(0, start) + usage + input.value.slice(end);
    input.dispatchEvent(new Event('input'));
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    input.focus();
    const at = start + usage.length;
    input.setSelectionRange(at, at);
  };

  function renderPanel() {
    const filter = h('input', { type: 'search', placeholder: 'Find a variable…', 'aria-label': 'Find a variable' });
    const list = h('div', { class: 'var-list' });
    const groups = [];
    const extra = typeof extraVars === 'function' ? extraVars() : extraVars;
    if (extra && extra.length) groups.push(['This trigger', extra.map(([key, label]) => ({ usage: `$${key}`, description: label }))]);
    for (const [group, defs] of Bot.vars.catalog()) groups.push([group, defs]);
    const draw = () => {
      const q = filter.value.trim().toLowerCase();
      list.replaceChildren(...groups.map(([group, defs]) => {
        const hits = defs.filter((d) => !q || d.usage.toLowerCase().includes(q) || d.description.toLowerCase().includes(q));
        if (!hits.length) return null;
        return h('div', { class: 'var-group' }, h('div', { class: 'var-group-name' }, group), hits.map((d) => h('button', {
          type: 'button', class: 'var-item', onclick: () => insert(d.usage),
        }, h('code', {}, d.usage), h('span', {}, d.description))));
      }).filter(Boolean));
    };
    filter.addEventListener('input', draw);
    filter.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); panel.hidden = true; input.focus(); } });
    draw();
    panel.replaceChildren(filter, list);
  }

  return h('div', { class: 'with-vars' }, h('div', { class: 'with-vars-row' }, input, button), panel);
};

// ---------------------------------------------------------------------------
// Conditions: "all / any of these", each row "left op right"
// ---------------------------------------------------------------------------

UI.conditions = (cond, { fields = [], onChange = null } = {}) => {
  if (!cond.items) cond.items = [];
  if (!cond.mode) cond.mode = 'all';
  const wrap = h('div', { class: 'cond' });
  const changed = () => { if (onChange) onChange(); };
  const render = () => {
    const rows = cond.items.map((item, i) => {
      const op = UI.select(item, 'op', Bot.effects.CONDITION_OPS, { label: 'Comparison', onChange: () => { changed(); render(); } });
      let right;
      if (item.op === 'role') right = UI.select(item, 'right', UI.permissionOptions(), { label: 'Role', onChange: changed });
      else if (item.op === 'following') right = UI.select(item, 'right', [['yes', 'yes'], ['no', 'no']], { label: 'Following', onChange: changed });
      else right = UI.text(item, 'right', { placeholder: 'value', vars: true, extraVars: fields, onChange: changed });
      const left = UI.text(item, 'left', { placeholder: fields.length ? `e.g. $${fields[0][0]}` : 'e.g. $arg[1]', vars: true, extraVars: fields, onChange: changed });
      return h('li', { class: 'cond-row' },
        Bot.effects.opTakesLeft(item.op || '==') ? left : h('span', { class: 'hint' }, ''),
        op,
        Bot.effects.opTakesRight(item.op || '==') ? right : h('span', {}),
        UI.button('×', () => { cond.items.splice(i, 1); changed(); render(); }, { cls: 'x', aria: 'Remove this condition', title: 'Remove' }));
    });
    wrap.replaceChildren(...[
      cond.items.length > 1 ? h('div', { class: 'cond-mode' }, UI.select(cond, 'mode', [['all', 'All of these must be true'], ['any', 'Any one of these is enough']], { label: 'How conditions combine', onChange: changed })) : null,
      h('ul', { class: 'cond-list' }, rows),
      cond.items.length ? null : h('p', { class: 'hint' }, 'No conditions: always.'),
      UI.button('+ Add a condition', () => {
        cond.items.push({ left: fields.length ? `$${fields[0][0]}` : '', op: fields.length ? '>=' : '==', right: '' });
        changed();
        render();
        const inputs = wrap.querySelectorAll('.cond-row input');
        if (inputs.length) inputs[inputs.length - 2 >= 0 ? inputs.length - 2 : 0].focus();
      }),
    ].filter(Boolean));
  };
  render();
  return wrap;
};

// ---------------------------------------------------------------------------
// The effect list editor
// ---------------------------------------------------------------------------

const openCards = new Set();   // effect ids shown open

function effectTypeOptions() {
  return [['', '+ Add an effect…'], ...Bot.effects.CATEGORIES.map((cat) => ({
    group: cat,
    options: [...Bot.effects.types.values()].filter((t) => t.category === cat && !t.hidden).map((t) => [t.id, `${t.icon || ''} ${t.name}`.trim()]),
  }))];
}

function triggerOptions() {
  const group = (name, list, kind, label) => ({ group: name, options: list.map((x) => [`${kind}:${x.id}`, label(x)]) });
  return [
    ['', 'Pick one…'],
    group('Commands', Bot.data.commands, 'command', (c) => c.trigger),
    group('Events', Bot.data.events, 'event', (e) => e.name || (Bot.events.types[e.type] || {}).name || e.type),
    group('Timers', Bot.data.timers, 'timer', (t) => t.name),
  ];
}

function datalist(id, values) {
  return h('datalist', { id }, values.map((v) => h('option', { value: v })));
}

// One control for an effect's field.
function effectControl(effect, f, changed, rerender, fields) {
  const onChange = () => changed();
  switch (f.type) {
    case 'text': return UI.text(effect, f.key, { placeholder: f.placeholder || '', vars: !!f.vars, extraVars: fields, onChange });
    case 'textarea': return UI.text(effect, f.key, { multiline: true, rows: 3, vars: !!f.vars, extraVars: fields, onChange });
    case 'number': return UI.number(effect, f.key, { min: f.min ?? null, max: f.max ?? null, onChange });
    case 'range': return UI.range(effect, f.key, { min: f.min, max: f.max, onChange });
    case 'select': return UI.select(effect, f.key, f.options, { onChange: () => { changed(); rerender(f.key); } });
    case 'color': return UI.color(effect, f.key, { onChange: changed });
    case 'file': return UI.file(effect, f.key, { kind: f.kind, onChange });
    case 'savefile': return UI.file(effect, f.key, { kind: f.kind, save: true, defaultName: 'chat-reader.txt', onChange });
    case 'voice': return UI.select(effect, f.key, [['', 'The reader’s own voice'], ...Bot.host.voices().map((v) => [v.name, `${v.name}${v.inPool ? '' : ' (not in the pool)'}`])], { onChange });
    case 'counter': {
      const id = nid();
      return h('div', {}, UI.text(effect, f.key, { list: id, placeholder: 'e.g. deaths', onChange }), datalist(id, Bot.data.counters.map((c) => c.name)));
    }
    case 'list': return UI.select(effect, f.key, [['', 'Pick an effect list…'], ...Bot.data.lists.map((l) => [l.id, l.name])], { onChange });
    case 'trigger': return UI.select(effect, f.key, triggerOptions(), { onChange });
    case 'reward': {
      const node = UI.select(effect, f.key, () => [['', UI.rewardsCache ? 'Pick a reward…' : 'Loading rewards…'], ...(UI.rewardsCache || []).filter((r) => r.manageable).map((r) => [r.id, r.title])], { onChange });
      if (!UI.rewardsCache) UI.loadRewards().then(() => rerender(f.key)).catch(() => {});
      return node;
    }
    case 'obsScene': case 'obsSource': {
      const id = nid();
      return h('div', {}, UI.text(effect, f.key, { list: id, vars: true, extraVars: fields, onChange }), datalist(id, f.type === 'obsScene' ? Bot.obs.scenes : Bot.obs.inputs));
    }
    case 'conditions': return UI.conditions(effect[f.key], { fields, onChange });
    case 'effects': return UI.effects(effect[f.key], { fields, onChange });
    default: return h('span', { class: 'hint' }, `(${f.type})`);
  }
}

function effectBody(effect, spec, changed, rerender, fields) {
  const plain = [];
  const advanced = [];
  for (const f of spec.fields) {
    if (f.showIf && !f.showIf(effect)) continue;
    const control = effectControl(effect, f, changed, rerender, fields);
    const row = f.type === 'checkbox'
      ? UI.check(effect, f.key, f.label, { onChange: () => { changed(); rerender(f.key); } })
      : (f.type === 'effects' ? h('div', { class: 'field nested' }, h('div', { class: 'row-label' }, f.label), control) : UI.field(f.label, control));
    row.dataset.key = f.key;
    (f.advanced ? advanced : plain).push(row);
  }
  return [
    spec.description ? h('p', { class: 'hint' }, spec.description) : null,
    ...plain,
    advanced.length ? h('details', { class: 'fx-more' }, h('summary', {}, 'More options'), ...advanced) : null,
  ].filter(Boolean);
}

// `list` is edited in place. `fields` are the trigger's own $variables, for the pickers.
UI.effects = (list, { fields = [], onChange = null } = {}) => {
  const wrap = h('div', { class: 'fx' });
  const ol = h('ol', { class: 'fx-list' });
  const empty = h('p', { class: 'hint fx-empty' }, 'No effects yet. Add one below.');
  const changed = () => { if (onChange) onChange(); };

  const card = (effect, i) => {
    const spec = Bot.effects.types.get(effect.type);
    if (!spec) {
      return h('li', { class: 'fx-card' }, h('div', { class: 'fx-head' }, h('span', {}, `Unknown effect “${effect.type}”`),
        UI.button('Delete', () => { list.splice(i, 1); changed(); render(); }, { cls: 'btn small danger' })));
    }
    const body = h('div', { class: 'fx-body' });
    const summary = h('span', { class: 'fx-summary' });
    const updateSummary = () => { summary.textContent = spec.summary ? trim(spec.summary(effect), 60) : ''; };
    const rerenderBody = (focusKey) => {
      body.replaceChildren(...effectBody(effect, spec, () => { updateSummary(); changed(); }, rerenderBody, fields));
      if (focusKey) {
        const again = body.querySelector(`[data-key="${focusKey}"] select, [data-key="${focusKey}"] input`);
        if (again) again.focus();
      }
    };
    const open = openCards.has(effect.id);
    const toggle = h('button', { type: 'button', class: 'fx-toggle', 'aria-expanded': String(open) },
      h('span', { class: 'fx-icon', 'aria-hidden': 'true' }, spec.icon || '•'),
      h('span', { class: 'fx-name' }, spec.name),
      summary);
    toggle.addEventListener('click', () => {
      const now = !openCards.has(effect.id);
      if (now) openCards.add(effect.id); else openCards.delete(effect.id);
      toggle.setAttribute('aria-expanded', String(now));
      body.hidden = !now;
      if (now && !body.childElementCount) rerenderBody();
    });
    const enabled = h('input', { type: 'checkbox', title: 'On', 'aria-label': `${spec.name} is on` });
    enabled.checked = effect.enabled !== false;
    enabled.addEventListener('change', () => { effect.enabled = enabled.checked; li.classList.toggle('off', !enabled.checked); changed(); });
    const move = (d) => {
      const j = i + d;
      if (j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      changed();
      render();
      const btn = ol.children[j] && ol.children[j].querySelector(d < 0 ? '[data-move="up"]' : '[data-move="down"]');
      if (btn) btn.focus();
    };
    const up = UI.button('↑', () => move(-1), { cls: 'x', aria: `Move ${spec.name} up`, title: 'Move up' });
    up.dataset.move = 'up';
    const down = UI.button('↓', () => move(1), { cls: 'x', aria: `Move ${spec.name} down`, title: 'Move down' });
    down.dataset.move = 'down';
    const copy = UI.button('⧉', () => {
      const dup = reId(Bot.clone(effect));
      list.splice(i + 1, 0, dup);
      openCards.add(dup.id);
      changed();
      render();
    }, { cls: 'x', aria: `Duplicate ${spec.name}`, title: 'Duplicate' });
    const test = UI.button('▶', () => Bot.effects.run([effect], UI.testContext(fields)), { cls: 'x', aria: `Try ${spec.name} now`, title: 'Try this effect now' });
    const del = UI.button('🗑', () => { list.splice(i, 1); changed(); render(); }, { cls: 'x', aria: `Delete ${spec.name}`, title: 'Delete' });
    const li = h('li', { class: `fx-card${effect.enabled === false ? ' off' : ''}` },
      h('div', { class: 'fx-head' }, toggle, h('span', { class: 'fx-tools' }, enabled, test, up, down, copy, del)),
      body);
    body.hidden = !open;
    if (open) rerenderBody();
    updateSummary();
    return li;
  };

  const add = h('select', { class: 'fx-add', 'aria-label': 'Add an effect' });
  UI.options(add, effectTypeOptions(), '');
  add.addEventListener('change', () => {
    if (!add.value) return;
    const effect = Bot.effects.newEffect(add.value);
    openCards.add(effect.id);
    list.push(effect);
    add.value = '';
    changed();
    render();
    const last = ol.lastElementChild && ol.lastElementChild.querySelector('.fx-body input, .fx-body textarea, .fx-body select');
    if (last) last.focus();
  });

  function render() {
    ol.replaceChildren(...list.map(card));
    empty.hidden = list.length > 0;
  }
  render();
  wrap.append(ol, empty, add);
  return wrap;
};

// A copied effect (and anything nested in it) needs new ids.
function reId(effect) {
  effect.id = Bot.uid('e');
  for (const value of Object.values(effect)) {
    if (Array.isArray(value)) value.forEach((x) => { if (x && x.type) reId(x); });
  }
  return effect;
}
UI.reId = reId;

// What "▶ try it" runs with: the streamer as the user, sample event values.
UI.testContext = (fields = [], extra = {}) => {
  const me = Bot.twitch.accounts.streamer;
  const sample = {};
  for (const [key] of fields) sample[key] = `(${key})`;
  return Bot.effects.newContext({
    trigger: { type: 'manual', name: 'test' },
    user: me ? { id: me.id, login: me.login, displayName: me.displayName, platform: 'twitch', role: 4 } : { id: '', login: 'test_viewer', displayName: 'Test_Viewer', platform: 'twitch', role: 4 },
    args: [],
    fields: sample,
    ...extra,
  });
};

// ---------------------------------------------------------------------------
// The item editor: a second dialog for one command, event, timer…
// ---------------------------------------------------------------------------

const editor = h('dialog', { class: 'settings-dialog bot-editor', 'aria-labelledby': 'botEditorTitle' });
document.body.append(editor);

// spec: { title, item, build(item, body, rebuild), onSave(item), onTest?(item), saveLabel? }
UI.edit = (spec) => {
  const item = spec.item;
  const before = JSON.stringify(item);
  const body = h('div', { class: 'bot-editor-body' });
  const rebuild = () => {
    const scroll = body.scrollTop;
    body.replaceChildren(...[spec.build(item, rebuild)].flat().filter(Boolean));
    body.scrollTop = scroll;
  };
  const close = () => editor.close();
  const save = () => {
    spec.onSave(item);
    close();
  };
  const status = UI.status();
  editor.replaceChildren(h('div', { class: 'dialog-box' },
    h('header', { class: 'dialog-head' },
      h('h2', { id: 'botEditorTitle' }, spec.title),
      UI.button('✕', () => maybeClose(), { cls: 'x close-btn', aria: 'Close without saving' })),
    body,
    h('footer', { class: 'bot-editor-foot' },
      status,
      spec.onTest ? UI.button('▶ Try it', async () => {
        UI.say(status, 'Running…');
        try { await spec.onTest(item); UI.say(status, 'Done. Anything that went wrong is in the log, at the bottom of the Dashboard.'); } catch (err) { UI.say(status, err.message, true); }
      }) : null,
      UI.button('Cancel', close),
      UI.button(spec.saveLabel || 'Save', save, { cls: 'btn small primary' }))));
  rebuild();
  const maybeClose = () => {
    if (JSON.stringify(item) !== before && !confirm('Close without saving your changes?')) return;
    close();
  };
  editor.oncancel = (e) => {
    if (JSON.stringify(item) !== before && !confirm('Close without saving your changes?')) e.preventDefault();
  };
  editor.onclose = () => { if (spec.onClose) spec.onClose(); };
  editor.showModal();
  const first = body.querySelector('input, select, textarea');
  if (first) first.focus();
};

// ---------------------------------------------------------------------------
// Tabs: each part of the bot, drawn into the page of the window shell.js
// puts it on. A page can hold a reader section and a bot tab together.
// ---------------------------------------------------------------------------

UI.addTab = (id, label, render, { listens = [], after = '' } = {}) => {
  const at = after ? UI.tabs.findIndex((t) => t.id === after) : -1;
  UI.tabs.splice(at === -1 ? UI.tabs.length : at + 1, 0, { id, label, render, listens });
};

UI.tab = (id) => UI.tabs.find((t) => t.id === id) || null;

// On screen: its page is the one showing.
UI.isShown = (tab) => !!(tab && tab.panel && Bot.shell && Bot.shell.showing(tab.id));

// The box a tab is drawn into, made by shell.js.
UI.mount = (tab, panel) => {
  tab.panel = panel;
  // Tabs append optional parts as `cond ? node : null`; leave the nulls out.
  panel.append = (...nodes) => Element.prototype.append.apply(panel, nodes.filter((n) => n !== null && n !== undefined && n !== false && n !== ''));
  // Things that change on their own (a new follower, the viewer list) redraw
  // the tab, unless the streamer is typing in it. Several changes in a row
  // (a busy chat) are drawn once.
  let redraw = null;
  for (const type of tab.listens) {
    Bot.on(type, () => {
      if (!UI.isShown(tab) || redraw) return;
      redraw = setTimeout(() => {
        redraw = null;
        if (!UI.isShown(tab)) return;
        if (panel.contains(document.activeElement) && document.activeElement.matches('input, textarea, select')) { tab.stale = true; return; }
        UI.renderTab(tab);
      }, 250);
    });
  }
  panel.addEventListener('focusout', () => {
    if (tab.stale) setTimeout(() => { if (!panel.contains(document.activeElement) && UI.isShown(tab)) { tab.stale = false; UI.renderTab(tab); } }, 0);
  });
};

UI.init = () => {
  Bot.shell.init();
  for (const type of ['eventsub', 'accounts', 'live', 'obs', 'overlay', 'relay']) Bot.on(type, () => Bot.shell.renderStatus());
  Bot.shell.renderStatus();
};

UI.renderTab = (tab) => {
  if (!tab.panel) return;
  const scroller = tab.panel.closest('.app-pages, .dash-side');
  const scroll = scroller ? scroller.scrollTop : 0;
  // Redrawing replaces every control, so keyboard focus goes back to the one
  // with the same label.
  const focused = tab.panel.contains(document.activeElement) ? document.activeElement : null;
  const focusLabel = focused && (focused.getAttribute('aria-label') || focused.textContent);
  tab.panel.replaceChildren();
  try {
    tab.render(tab.panel);
  } catch (err) {
    console.error(err);
    tab.panel.append(h('p', { class: 'warn' }, `Something went wrong drawing this part: ${err.message}`));
  }
  if (scroller) scroller.scrollTop = scroll;
  if (focusLabel) {
    const again = [...tab.panel.querySelectorAll('button, input, select, textarea')].find((x) => (x.getAttribute('aria-label') || x.textContent) === focusLabel);
    if (again) again.focus();
  }
};

// Older names for showing a part of the window, used all over the tabs.
UI.select_ = (id) => Bot.shell.show(id);
UI.open = (id) => Bot.shell.show(id || 'dashboard');

UI.rerender = () => {
  for (const tab of UI.tabs) if (UI.isShown(tab)) UI.renderTab(tab);
};

UI.loadRewards = async () => {
  UI.rewardsCache = await Bot.twitch.rewards();
  return UI.rewardsCache;
};

// Lists of items (commands, events, timers…): a table with a row per item.
UI.table = (columns, rows, { empty = 'Nothing here yet.' } = {}) => {
  if (!rows.length) return h('p', { class: 'hint bot-empty' }, empty);
  return h('div', { class: 'bot-table-wrap' }, h('table', { class: 'bot-table' },
    h('thead', {}, h('tr', {}, columns.map((c) => h('th', { scope: 'col', class: c.cls || null }, c.label)))),
    h('tbody', {}, rows.map((row) => h('tr', { class: row.off ? 'off' : null }, row.cells.map((cell, i) => h('td', { class: columns[i].cls || null }, cell)))))));
};

UI.toggle = (obj, key, label, onChange) => {
  const box = h('input', { type: 'checkbox', 'aria-label': label, title: label });
  box.checked = obj[key] !== false;
  box.addEventListener('change', () => { obj[key] = box.checked; Bot.save(); if (onChange) onChange(); });
  return box;
};

UI.section = (title, ...children) => h('section', { class: 'bot-section' }, h('h3', { class: 'sub-head' }, title), ...children);
UI.row = (...children) => h('div', { class: 'bot-row' }, ...children);
UI.grid = (...children) => h('div', { class: 'bot-grid' }, ...children);
UI.lead = (text) => h('p', { class: 'hint bot-lead' }, text);

// Logged out, most tabs can still be set up, but say why nothing happens.
UI.needsLogin = () => (Bot.twitch.loggedIn() ? null : h('p', { class: 'warn bot-login-note' },
  'Log in to Twitch under ', UI.button('Accounts', () => UI.select_('account'), { cls: 'link' }), ' for this to work on your channel.'));
