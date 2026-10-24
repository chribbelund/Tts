'use strict';

// Where zones go on a screen of another shape or size, and finding a game's
// HUD in a picture of it. Nothing here captures the screen or reads text
// (screen.js does both), so it can be tried out in Node too.
//
// Games lay their HUD out from the edges of the picture rather than
// stretching it over the picture: on a wider screen the minimap stays in its
// corner and keeps its size, and the game's "HUD size" or "UI scale" setting
// grows each part around its own corner or edge. So a zone has an anchor, the
// corner, edge or middle it keeps its distance from, and its distance and size
// are kept in units of the picture's height. Zones still live in profiles as
// fractions of the screen (rect), like any other zone; this only moves them.
//
//   anchor  'tl' 't' 'tr' 'l' 'c' 'r' 'bl' 'b' 'br'; '' is the third of the
//           screen the zone's middle is in
//   layout  { width, height, aspect, scale }: the screen a profile's zones were
//           placed for, in pixels. aspect > 0 is a game drawn at that shape
//           only (16:9 with black bars on a wider screen). scale is the HUD size
//           found by fitting, 1 as the zones were made.
//
// Fitting (fit): the zones and landmarks a game pack says are always on screen
// are looked for in what text recognition found in a picture of the game. The
// HUD size that best explains where they are, and how tall their text is,
// wins; each corner's HUD can then be a little off from where the pack says
// (safe-zone margins), and each number zone is moved onto its number.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ScreenLayout = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  const ANCHORS = {
    tl: [0, 0], t: [0.5, 0], tr: [1, 0],
    l: [0, 0.5], c: [0.5, 0.5], r: [1, 0.5],
    bl: [0, 1], b: [0.5, 1], br: [1, 1],
  };
  const KEYS = [['tl', 't', 'tr'], ['l', 'c', 'r'], ['bl', 'b', 'br']];
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const median = (list) => {
    if (!list.length) return 0;
    const s = [...list].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  // The part of the screen the game draws in, in pixels.
  function content(layout) {
    const W = layout.width, H = layout.height, a = Number(layout.aspect) || 0;
    if (!(a > 0) || Math.abs(W / H - a) < 0.01) return { x: 0, y: 0, w: W, h: H };
    if (W / H > a) { const w = H * a; return { x: (W - w) / 2, y: 0, w, h: H }; }
    const h = W / a;
    return { x: 0, y: (H - h) / 2, w: W, h };
  }

  // The anchor a zone without one gets: the third of the picture it's in.
  function autoAnchor(rect, layout) {
    const c = content(layout);
    const cx = ((rect.x + rect.w / 2) * layout.width - c.x) / c.w;
    const cy = ((rect.y + rect.h / 2) * layout.height - c.y) / c.h;
    const col = cx < 1 / 3 ? 0 : cx > 2 / 3 ? 2 : 1;
    const row = cy < 1 / 3 ? 0 : cy > 2 / 3 ? 2 : 1;
    return KEYS[row][col];
  }
  const anchorFor = (zone, layout) => (ANCHORS[zone.anchor] ? zone.anchor : autoAnchor(zone.rect, layout));

  // A zone as distances from its anchor, in units of the picture's height,
  // so it no longer depends on the screen's size. A zone across (nearly) the
  // whole width or height, like "Whole screen", keeps covering it instead.
  function toSpace(rect, layout, anchor) {
    const c = content(layout);
    const [ax, ay] = ANCHORS[anchor] || ANCHORS.c;
    const px = rect.x * layout.width - c.x, py = rect.y * layout.height - c.y;
    const pw = rect.w * layout.width, ph = rect.h * layout.height;
    const s = { ax, ay, u: (px - ax * c.w) / c.h, v: (py - ay * c.h) / c.h, w: pw / c.h, h: ph / c.h, fullW: false, fullH: false };
    if (pw >= c.w * 0.9) Object.assign(s, { fullW: true, u: px / c.w, w: pw / c.w });
    if (ph >= c.h * 0.9) Object.assign(s, { fullH: true, v: py / c.h, h: ph / c.h });
    return s;
  }

  // Back to fractions of a screen. scale grows the zone around its anchor;
  // offset and shift move it (units of the picture's height).
  function fromSpace(s, layout, { scale = 1, offset = [0, 0], shift = [0, 0] } = {}) {
    const c = content(layout);
    let px, pw, py, ph;
    if (s.fullW) { px = c.x + s.u * c.w; pw = s.w * c.w; } else {
      px = c.x + s.ax * c.w + (s.u * scale + offset[0] + shift[0]) * c.h;
      pw = s.w * scale * c.h;
    }
    if (s.fullH) { py = c.y + s.v * c.h; ph = s.h * c.h; } else {
      py = c.y + s.ay * c.h + (s.v * scale + offset[1] + shift[1]) * c.h;
      ph = s.h * scale * c.h;
    }
    return fitRect({ x: px / layout.width, y: py / layout.height, w: pw / layout.width, h: ph / layout.height });
  }

  // Inside the screen, keeping its size where it can.
  function fitRect(r) {
    const w = clamp(r.w, 0.002, 1), h = clamp(r.h, 0.002, 1);
    return { x: clamp(r.x, 0, 1 - w), y: clamp(r.y, 0, 1 - h), w, h };
  }

  // A rect placed for one screen, where it goes on another.
  function remap(rect, anchor, from, to, options = {}) {
    return fromSpace(toSpace(rect, from, anchor), to, options);
  }

  const sameLayout = (a, b) => !!a && !!b && a.width === b.width && a.height === b.height && (Number(a.aspect) || 0) === (Number(b.aspect) || 0);

  // ---------------------------------------------------------------------------
  // Text
  // ---------------------------------------------------------------------------

  const squash = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const comparable = (t) => squash(t).toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, '').replace(/\s+/g, ' ').trim();
  function similarity(a, b) {
    if (a === b) return 1;
    if (!a || !b) return 0;
    if (a.length < 3 || b.length < 3) return 0;
    const grams = new Map();
    for (let i = 0; i < a.length - 1; i++) { const g = a.slice(i, i + 2); grams.set(g, (grams.get(g) || 0) + 1); }
    let hits = 0;
    for (let i = 0; i < b.length - 1; i++) {
      const g = b.slice(i, i + 2);
      const n = grams.get(g) || 0;
      if (n) { hits++; grams.set(g, n - 1); }
    }
    return (2 * hits) / (a.length + b.length - 2);
  }
  // A line that's a number on a HUD: "12", "1,250", "3/10", "12:04", "x3".
  const isNumberText = (t) => {
    const s = squash(t).replace(/\s/g, '');
    const digits = (s.match(/\d/g) || []).length;
    return digits > 0 && digits / s.length >= 0.5 && s.length <= 12;
  };
  const letters = (t) => (String(t).match(/\p{L}/gu) || []).length;

  // ---------------------------------------------------------------------------
  // Fitting a profile to a picture of the game
  // ---------------------------------------------------------------------------

  // How well a line of text fits a point the pack expects. 0 is no match.
  //   number  any number near where it should be
  //   text    this text (in any case, a misread letter or two forgiven)
  //   any     any text inside the zone: a quest tracker, an item's name
  // A count on a HUD: "12", "1,250", "3/10", "x3", "75%". Not a time or a
  // date ("13:44"), which is the clock in the corner of a desktop.
  const isCount = (t) => /^[x×]?\d[\d.,/ ]*%?$/i.test(squash(t)) && squash(t).replace(/\D/g, '').length <= 9;

  function kindMatches(point, line) {
    if (point.kind === 'number') return isCount(line.text) ? 1 : 0;
    if (point.kind === 'text') {
      const want = comparable(point.text);
      const got = comparable(line.text);
      if (!want || !got) return 0;
      if (got === want) return 1;
      if (want.length >= 4 && got.includes(want)) return 0.9;
      const sim = similarity(want, got);
      return sim >= 0.7 ? sim : 0;
    }
    return letters(line.text) + (line.text.match(/\d/g) || []).length >= 2 ? 1 : 0;
  }

  // The point of a box to line up: its left edge, middle or right edge, by
  // the anchor (text and numbers grow away from where they're anchored), and
  // its middle from top to bottom.
  function refPoint(box, point) {
    return [box.x + point.space.ax * box.w, box.y + box.h / 2];
  }

  // How far a zone has to move to hold this text with a margin round it: not
  // at all when it does already. Text wider than the zone is centred.
  function containShift(zone, text) {
    const m = text.h * 0.3;
    const axis = (z0, zl, t0, tl) => {
      if (tl + m * 2 >= zl) return t0 + tl / 2 - (z0 + zl / 2);
      if (t0 - m < z0) return t0 - m - z0;
      if (t0 + tl + m > z0 + zl) return t0 + tl + m - (z0 + zl);
      return 0;
    };
    return [axis(zone.x, zone.w, text.x, text.w), axis(zone.y, zone.h, text.y, text.h)];
  }

  const WEIGHT = { text: 2, number: 1.2, any: 0.6 };

  // Pairs each point with at most one line and each line with at most one
  // point, nearest first. Boxes are in units of the picture's height.
  function matchPoints(points, predicted, lines, { scale, loose }) {
    const pairs = [];
    points.forEach((p, i) => {
      const b = predicted[i];
      const [px, py] = refPoint(b, p);
      // How far off a point may be: a pack's own positions are a guess at
      // first (loose), close once the HUD's size is known.
      const tol = (loose ? 0.05 : 0.025) + (p.kind === 'any' ? 0 : 1.5 * b.h);
      lines.forEach((l, j) => {
        const k = kindMatches(p, l);
        if (!k) return;
        if (p.kind === 'any') {
          // Inside the zone (with a little room), its middle anywhere in it.
          const cx = l.box.x + l.box.w / 2, cy = l.box.y + l.box.h / 2;
          const m = loose ? 0.03 : 0.01;
          if (cx < b.x - m || cx > b.x + b.w + m || cy < b.y - m || cy > b.y + b.h + m) return;
          // Any text, but the size the pack says, when it says.
          if (p.lineH > 0 && Math.abs(Math.log(l.box.h / (p.lineH * scale))) > 0.3) return;
          pairs.push({ i, j, d: 0, tol: 1, k });
          return;
        }
        const [lx, ly] = refPoint(l.box, p);
        const d = Math.hypot(lx - px, ly - py);
        if (d < tol) pairs.push({ i, j, d, tol, k });
      });
    });
    pairs.sort((a, b) => a.d / a.tol - b.d / b.tol);
    const usedP = new Set(), usedL = new Set(), out = [];
    for (const pr of pairs) {
      if (usedP.has(pr.i) || usedL.has(pr.j)) continue;
      usedP.add(pr.i); usedL.add(pr.j);
      const p = points[pr.i], l = lines[pr.j];
      let s = WEIGHT[p.kind] * pr.k * (p.kind === 'any' ? 1 : 1 - (pr.d / pr.tol) * 0.7);
      // Text the size the pack says, at this HUD size, counts most of all.
      if (p.lineH > 0) {
        const r = Math.log(l.box.h / (p.lineH * scale));
        s *= 0.4 + 1.2 * Math.exp(-((r / 0.12) ** 2));
      }
      out.push({ point: p, line: l, i: pr.i, d: pr.d, score: s });
    }
    return out;
  }

  // Lines from text recognition ({ text, conf, box } with the box in
  // fractions of the picture) into units of the picture's height, from the
  // top left of where the game draws.
  function linesInSpace(lines, layout) {
    const c = content(layout);
    return lines.filter((l) => l && l.box && squash(l.text)).map((l) => ({
      text: squash(l.text), conf: Number(l.conf) || 0,
      box: { x: (l.box.x * layout.width - c.x) / c.h, y: (l.box.y * layout.height - c.y) / c.h, w: (l.box.w * layout.width) / c.h, h: (l.box.h * layout.height) / c.h },
    }));
  }

  // A point's box in the same units, at a HUD size and with an offset.
  function predict(p, layout, scale, offset = [0, 0]) {
    const c = content(layout);
    const r = fromSpace(p.space, layout, { scale, offset });
    return { x: (r.x * layout.width - c.x) / c.h, y: (r.y * layout.height - c.y) / c.h, w: (r.w * layout.width) / c.h, h: (r.h * layout.height) / c.h };
  }

  const SCALES = [];
  for (let s = 0.5; s <= 2.0001; s += 0.01) SCALES.push(Math.round(s * 100) / 100);

  // points: [{ id, rect, anchor, kind: number | text | any, text, lineH }]
  //   placed for `layout`, the picture's own layout (remap them first).
  //   lineH: how tall the text's box is, in units of the picture's height.
  // lines:  what text recognition found in the picture.
  // Returns { scale, offsets: { anchor: [dx, dy] }, shifts: { id: [dx, dy] },
  //   found, total, matches } or null when nothing was found.
  function fit(points, lines, layout, { scales = SCALES } = {}) {
    const pts = points.filter((p) => p && p.rect && WEIGHT[p.kind]).map((p) => {
      const anchor = anchorFor(p, layout);
      return { ...p, anchor, space: toSpace(p.rect, layout, anchor) };
    });
    const ls = linesInSpace(lines, layout);
    if (!pts.length || !ls.length) return null;
    const search = (lines) => {
      let top = null;
      for (const s of scales) {
        const predicted = pts.map((p) => predict(p, layout, s));
        const matches = matchPoints(pts, predicted, lines, { scale: s, loose: true });
        // A HUD size far from 1 has to explain more to win.
        const score = matches.reduce((a, m) => a + m.score, 0) - 0.35 * Math.abs(Math.log(s));
        if (!top || score > top.score + 1e-9) top = { s, score, matches };
      }
      return top;
    };
    const best = search(ls);
    if (!best) return null;
    // Enough to go on: two numbers or labels, one and two bits of text in
    // their zones, or three bits of text. Less than that could be anything.
    const strong = best.matches.filter((m) => m.point.kind !== 'any').length;
    const weak = best.matches.length - strong;
    if (!(strong >= 2 || (strong >= 1 && weak >= 2) || weak >= 3)) return null;
    // A screen full of text (a web page, a game's menu) has something to
    // match near anywhere. So the same search runs again with all the text
    // moved well away (decoys): where the HUD really is has to do clearly
    // better than that.
    const wide = content(layout).w / content(layout).h;
    let decoy = 0;
    for (const [dx, dy] of [[0.3 * wide, 0], [-0.3 * wide, 0], [0, 0.3], [0, -0.3], [0.3 * wide, 0.3], [-0.3 * wide, -0.3]]) {
      const moved = ls.map((l) => ({ ...l, box: { ...l.box, x: l.box.x + dx, y: l.box.y + dy } }));
      const d = search(moved);
      if (d) decoy = Math.max(decoy, d.score);
    }
    if (best.score < decoy + 1 || best.score < decoy * 1.5) return null;
    // Text boxes come back a percent or two taller or shorter from one look
    // to the next: that close to the size it has, the HUD hasn't changed.
    // The search steps in whole percents and leans towards 1; the text it
    // found says the size more exactly: how tall it is against the pack.
    const ratios = best.matches.filter((m) => m.point.lineH > 0).map((m) => m.line.box.h / m.point.lineH);
    const measured = ratios.length ? median(ratios) : best.s;
    const sized = Math.abs(Math.log(measured / best.s)) < 0.1 ? Math.round(measured * 100) / 100 : best.s;
    const scale = Math.abs(Math.log(sized)) <= 0.02 ? 1 : sized;
    // Each corner and edge of the HUD may sit a little off from where the
    // pack says: the median of the landmarks found there. A zone's own text
    // only says it's somewhere inside the zone, so zones don't count.
    const offsets = {};
    const groups = new Map();
    for (const m of best.matches) {
      if (!m.point.landmark) continue;
      const b = predict(m.point, layout, scale);
      const [px, py] = refPoint(b, m.point);
      const [lx, ly] = refPoint(m.line.box, m.point);
      if (!groups.has(m.point.anchor)) groups.set(m.point.anchor, []);
      groups.get(m.point.anchor).push([lx - px, ly - py]);
    }
    for (const key of Object.keys(ANCHORS)) {
      const g = groups.get(key) || [];
      const d = [median(g.map((x) => x[0])), median(g.map((x) => x[1]))];
      offsets[key] = [clamp(d[0], -0.1, 0.1), clamp(d[1], -0.1, 0.1)];
    }
    // Once more, close: what's left over moves each point onto its own text.
    const predicted = pts.map((p) => predict(p, layout, scale, offsets[p.anchor]));
    const matches = matchPoints(pts, predicted, ls, { scale, loose: false });
    const shifts = {};
    for (const m of matches) {
      if (m.point.kind === 'any' || !m.point.id) continue;
      if (m.point.landmark) {
        // A landmark is the text's own box: right onto it.
        const [px, py] = refPoint(predicted[m.i], m.point);
        const [lx, ly] = refPoint(m.line.box, m.point);
        shifts[m.point.id] = [lx - px, ly - py];
      } else {
        shifts[m.point.id] = containShift(predicted[m.i], m.line.box);
      }
    }
    const found = new Set([...best.matches, ...matches].map((m) => m.i));
    return {
      scale, offsets, shifts,
      found: found.size, total: pts.length,
      matches: matches.map((m) => ({ id: m.point.id, kind: m.point.kind, text: m.line.text })),
      score: best.score, decoy,
    };
  }

  // How far (in units of the picture's height) a zone placed for `layout`
  // has to move to hold this box of text, both as fractions of the screen.
  function holdShift(rect, box, layout) {
    const c = content(layout);
    const units = (r) => ({ x: (r.x * layout.width - c.x) / c.h, y: (r.y * layout.height - c.y) / c.h, w: (r.w * layout.width) / c.h, h: (r.h * layout.height) / c.h });
    return containShift(units(rect), units(box));
  }

  // Moves a list of things with a rect and an anchor (zones, landmarks) by a
  // fit's result: placed for `layout` and staying there.
  function applyFit(items, layout, result, { snap = true } = {}) {
    return items.map((item) => {
      const anchor = anchorFor(item, layout);
      const space = toSpace(item.rect, layout, anchor);
      const shift = snap && result.shifts[item.id] ? result.shifts[item.id] : [0, 0];
      return { ...item, rect: fromSpace(space, layout, { scale: result.scale, offset: result.offsets[anchor] || [0, 0], shift }) };
    });
  }

  // ---------------------------------------------------------------------------
  // Suggesting zones from a picture of a game nobody has made zones for yet
  // ---------------------------------------------------------------------------

  // Lines of text found in the picture become suggestions, by where they are
  // and what they look like:
  //   a block of lines across the bottom middle  subtitles
  //   a block of lines low on the left           chat
  //   a list of lines one above the other        a menu (the highlighted line)
  //   text near the top right                    objectives
  //   a lone number                              a number (potions, ammo)
  //   a short label                              read when it changes
  // Everything is only a suggestion: the zone editor opens on it straight after.
  // Lines that will be there every time (labels, numbers) are kept as
  // landmarks, so the profile can be fitted to the game later.
  function suggest(lines, layout) {
    const all = lines.filter((l) => l && l.box && squash(l.text) && (Number(l.conf) || 0) >= 0.5).map((l, i) => ({
      i, text: squash(l.text), conf: Number(l.conf) || 0, box: { ...l.box },
      cx: l.box.x + l.box.w / 2, cy: l.box.y + l.box.h / 2,
      // Heights in pixels: rows and blocks are judged by how tall text is.
      hp: l.box.h * layout.height,
    }));
    const numbers = all.filter((l) => isNumberText(l.text) && l.text.replace(/\D/g, '').length <= 7);
    // Stray marks read as a letter or two aren't worth a zone.
    const words = all.filter((l) => !numbers.includes(l) && letters(l.text) >= 3);
    const px = (l) => ({ x: l.box.x * layout.width, y: l.box.y * layout.height, w: l.box.w * layout.width, h: l.box.h * layout.height });

    // Evenly spaced along one row, four or more: keybinds, or the mana
    // costs on a row of ability icons.
    const inKeyRow = (n) => {
      const row = numbers.filter((o) => Math.abs(o.cy - n.cy) * layout.height < n.hp * 0.6 && Math.abs(o.hp - n.hp) < n.hp * 0.4).sort((a, b) => a.cx - b.cx);
      if (row.length < 4) return false;
      const gaps = row.slice(1).map((o, i) => o.cx - row[i].cx);
      return Math.max(...gaps) < Math.min(...gaps) * 1.6;
    };

    // Lines one under the other, close together and about as tall, are one block.
    const parent = words.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let a = 0; a < words.length; a++) {
      for (let b = a + 1; b < words.length; b++) {
        const A = px(words[a]), B = px(words[b]);
        const h = Math.max(A.h, B.h);
        if (Math.max(A.h, B.h) > Math.min(A.h, B.h) * 1.7) continue;
        const gapY = Math.max(A.y, B.y) - Math.min(A.y + A.h, B.y + B.h);
        const overlapX = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x);
        const leftAligned = Math.abs(A.x - B.x) < h * 1.5;
        const centred = Math.abs(A.x + A.w / 2 - (B.x + B.w / 2)) < h * 1.5;
        if (gapY < h * 1.1 && gapY > -h * 0.5 && (overlapX > 0 || leftAligned || centred)) parent[find(a)] = find(b);
      }
    }
    const blocks = new Map();
    words.forEach((w, i) => {
      const k = find(i);
      if (!blocks.has(k)) blocks.set(k, []);
      blocks.get(k).push(w);
    });

    const zones = [];
    const union = (list) => {
      const x1 = Math.min(...list.map((l) => l.box.x)), y1 = Math.min(...list.map((l) => l.box.y));
      const x2 = Math.max(...list.map((l) => l.box.x + l.box.w)), y2 = Math.max(...list.map((l) => l.box.y + l.box.h));
      return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    };
    const pad = (r, padX, padY) => fitRect({ x: r.x - padX, y: r.y - padY, w: r.w + padX * 2, h: r.h + padY * 2 });
    const nameOf = (text) => {
      const t = squash(text).replace(/^[^\p{L}\p{N}]+/u, '');
      return (t.length > 24 ? `${t.slice(0, 22).trim()}…` : t) || 'Text';
    };
    const fx = (pxv) => pxv / layout.width, fy = (pyv) => pyv / layout.height;

    for (const list of blocks.values()) {
      list.sort((a, b) => a.box.y - b.box.y);
      const r = union(list);
      const lineH = median(list.map((l) => l.hp));
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      const many = list.length >= 3;
      let z;
      if (cy > 0.68 && Math.abs(cx - 0.5) < 0.12 && (r.w > 0.18 || list.length >= 2)) {
        // Subtitles come in all lengths: the box spans most of the middle.
        const w = Math.max(r.w + fx(lineH * 4), 0.56);
        z = { name: 'Subtitles', mode: 'changes', settle: 300, interrupt: 'self', rect: fitRect({ x: 0.5 - w / 2, y: r.y - fy(lineH * 0.6), w, h: Math.max(r.h + fy(lineH * 1.6), fy(lineH * 4)) }) };
      } else if (many && cx < 0.4 && cy > 0.45) {
        z = { name: 'Chat', mode: 'new-lines', settle: 400, interrupt: 'none', rect: pad(r, fx(lineH), fy(lineH)) };
      } else if (cx > 0.66 && cy < 0.55 && (many || r.w > 0.1)) {
        z = { name: 'Objectives', mode: 'new-lines', settle: 600, interrupt: 'none', rect: pad(r, fx(lineH * 1.5), fy(lineH * 1.5)) };
      } else if (many) {
        z = { name: 'Menu', mode: 'menu', settle: 200, interrupt: 'self', rect: pad(r, fx(lineH * 2), fy(lineH)) };
      } else {
        // A label or a prompt: room for longer text of the same kind, more
        // of it for one in the middle (a prompt: "Open", "Rest at the site of grace").
        const extra = Math.max(r.w * (Math.abs(cx - 0.5) < 0.1 ? 0.8 : 0.25), fx(lineH * 2));
        const x = cx < 0.4 ? r.x - fx(lineH * 0.5) : cx > 0.6 ? r.x - extra : r.x - extra / 2;
        z = { name: nameOf(list[0].text), mode: 'changes', settle: 300, interrupt: 'self', rect: fitRect({ x, y: r.y - fy(lineH * 0.35), w: r.w + extra + fx(lineH * 0.5), h: r.h + fy(lineH * 0.7) }) };
      }
      // A label on its own is the same every time; lines of subtitles, chat
      // or a menu aren't.
      if (list.length === 1 && z.name !== 'Subtitles') list[0].stable = true;
      z.score = list.reduce((a, l) => a + l.text.length * l.conf, 0) + (many ? 40 : 0);
      zones.push(z);
    }

    // Numbers: the label nearest to the left, above or below names them. A
    // label is words, not another value ("FPS: 80").
    const label = (n) => {
      let best = null, bestD = Infinity;
      for (const w of words) {
        if (/\d/.test(w.text)) continue;
        const W = px(w), N = px(n);
        const leftOf = W.x + W.w <= N.x + N.h && Math.abs(W.y + W.h / 2 - (N.y + N.h / 2)) < N.h;
        const aboveOrBelow = (W.y + W.h <= N.y + N.h * 0.3 || W.y >= N.y + N.h * 0.7) && Math.abs(W.x + W.w / 2 - (N.x + N.w / 2)) < Math.max(W.w, N.w);
        if (!leftOf && !aboveOrBelow) continue;
        const d = Math.hypot(W.x + W.w / 2 - (N.x + N.w / 2), W.y + W.h / 2 - (N.y + N.h / 2));
        if (d < N.h * 8 && d < bestD) { bestD = d; best = w; }
      }
      return best && best.text.length <= 20 ? nameOf(best.text) : '';
    };
    // Numbers close together (a panel of stats, the icons on a minimap)
    // are one zone, read when asked, rather than one each. A lone digit
    // read unsurely is more often an icon than a number.
    // The same lone digit four times or more is icons (towers on a minimap).
    const lone = new Map();
    for (const x of numbers) if (x.text.length === 1) lone.set(x.text, (lone.get(x.text) || 0) + 1);
    const loose = numbers.filter((x) => !inKeyRow(x) && !(x.text.length === 1 && lone.get(x.text) >= 4)
      && (x.text.replace(/\D/g, '').length > 1 || x.conf >= 0.9));
    const group = loose.map((_, i) => i);
    const top = (i) => (group[i] === i ? i : (group[i] = top(group[i])));
    for (let a = 0; a < loose.length; a++) {
      for (let b = a + 1; b < loose.length; b++) {
        const A = loose[a], B = loose[b];
        const near = Math.max(A.hp, B.hp) * 5;
        if (Math.abs(A.cx - B.cx) * layout.width < near && Math.abs(A.cy - B.cy) * layout.height < near) group[top(a)] = top(b);
      }
    }
    const clusters = new Map();
    loose.forEach((x, i) => { const k = top(i); if (!clusters.has(k)) clusters.set(k, []); clusters.get(k).push(x); });
    const single = [];
    let panels = 0;
    for (const list of clusters.values()) {
      if (list.length < 4) { single.push(...list); continue; }
      // Mostly unsure: icons read as digits, not worth a zone.
      if (median(list.map((x) => x.conf)) < 0.85) continue;
      const r = union(list);
      const lineH = median(list.map((x) => x.hp));
      zones.push({ name: `Panel ${++panels}`, mode: 'manual', settle: 300, interrupt: 'all', rect: pad(r, fx(lineH), fy(lineH * 0.6)), fit: 'any', score: 30 + list.length });
    }
    let n = 0;
    const numberZones = single.map((x) => {
      // Room for more digits and a margin round it. Near a side of the
      // screen a number grows towards the middle (a counter in the corner
      // gets its new digits on the inside), in the middle both ways.
      const w = Math.max(x.box.w * 1.8, fx(x.hp * 3.5));
      const h = x.box.h * 1.6;
      const m = fx(x.hp * 0.4);
      const left = x.cx > 0.6 ? x.box.x + x.box.w + m - w : x.cx < 0.4 ? x.box.x - m : x.cx - w / 2;
      return { name: label(x), mode: 'count', settle: 150, interrupt: 'self', rect: fitRect({ x: left, y: x.cy - h / 2, w, h }), fit: 'number', score: 20 + x.hp, line: x };
    }).sort((a, b) => b.score - a.score).slice(0, 6);
    for (const z of numberZones) z.name = z.name || `Number ${++n}`;
    zones.push(...numberZones);

    // The biggest things first; a screen full of text makes a few zones, not fifty.
    zones.sort((a, b) => b.score - a.score);
    const kept = zones.slice(0, 12);
    for (const z of kept) { z.anchor = autoAnchor(z.rect, layout); delete z.score; delete z.line; }

    // Landmarks: short, confident labels the game shows every time.
    const landmarks = words
      .filter((w) => w.stable && w.conf >= 0.85 && w.text.length >= 3 && w.text.length <= 32 && letters(w.text) >= 3)
      .sort((a, b) => b.conf * b.hp - a.conf * a.hp)
      .slice(0, 24)
      .map((w) => ({ kind: 'text', text: w.text, rect: fitRect(w.box), anchor: autoAnchor(w.box, layout), lineH: w.box.h * layout.height / content(layout).h }));
    return { zones: kept, landmarks };
  }

  return {
    ANCHORS, content, autoAnchor, anchorFor, toSpace, fromSpace, remap, fitRect, sameLayout,
    fit, applyFit, holdShift, suggest, isNumberText, similarity, comparable,
  };
}));
