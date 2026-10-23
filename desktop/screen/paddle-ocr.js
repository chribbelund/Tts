// Text recognition with PaddleOCR (PP-OCRv5 mobile) on ONNX Runtime Web, run
// by ocr-worker.js. Finds the lines of text in a picture with the detection
// model, then reads each one with the recognition model.
//
//   const ocr = await create({ ort, det, rec, dict });   // det, rec: model bytes
//   await ocr.recognize(picture, options) -> [{ text, conf, box: [x, y, w, h] }]
//   await ocr.readLine(picture)           -> { text, conf }, the whole picture as one line
// Boxes are fractions of the picture, from the top left. A picture is
// anything drawImage takes: an ImageBitmap, an OffscreenCanvas.

const DET_MEAN = [0.485, 0.456, 0.406];
const DET_STD = [0.229, 0.224, 0.225];
const REC_H = 48;          // the recognition model reads lines 48 pixels tall
const REC_MAX_W = 3200;

const canvasOf = (w, h) => {
  const c = new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
  return [c, c.getContext('2d', { willReadFrequently: true })];
};

export async function create({ ort, det, rec, dict }) {
  const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
  const detSession = await ort.InferenceSession.create(det, opts);
  const recSession = await ort.InferenceSession.create(rec, opts);
  const chars = dict.replace(/\r/g, '').split('\n');
  if (chars[chars.length - 1] === '') chars.pop();
  // 0 is CTC's blank, then the dictionary, then a space.
  const classes = ['', ...chars, ' '];

  // Lines of text: the areas the detection model marks, as boxes in the
  // picture's pixels. maxSide: the picture is shrunk to this first.
  async function detect(src, { maxSide = 1280, minSide = 64, thresh = 0.3, boxThresh = 0.5, unclip = 1.6 } = {}) {
    const W = src.width, H = src.height;
    let s = Math.min(1, maxSide / Math.max(W, H));
    if (Math.min(W, H) * s < minSide) s = minSide / Math.min(W, H);
    const dw = Math.max(32, Math.round((W * s) / 32) * 32);
    const dh = Math.max(32, Math.round((H * s) / 32) * 32);
    const [, ctx] = canvasOf(dw, dh);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, dw, dh);
    const px = ctx.getImageData(0, 0, dw, dh).data;
    const n = dw * dh;
    const input = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) {
      // BGR: the models were trained on OpenCV's channel order.
      input[i] = (px[i * 4 + 2] / 255 - DET_MEAN[0]) / DET_STD[0];
      input[n + i] = (px[i * 4 + 1] / 255 - DET_MEAN[1]) / DET_STD[1];
      input[2 * n + i] = (px[i * 4] / 255 - DET_MEAN[2]) / DET_STD[2];
    }
    const out = await detSession.run({ [detSession.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, dh, dw]) });
    const prob = out[detSession.outputNames[0]].data;
    // Each connected area above the threshold is a line of text.
    const seen = new Uint8Array(n);
    const stack = new Int32Array(n);
    const boxes = [];
    for (let start = 0; start < n; start++) {
      if (seen[start] || prob[start] <= thresh) continue;
      let top = 0, sum = 0, count = 0;
      let x1 = dw, y1 = dh, x2 = 0, y2 = 0;
      stack[top++] = start; seen[start] = 1;
      while (top) {
        const p = stack[--top];
        const x = p % dw, y = (p - x) / dw;
        sum += prob[p]; count++;
        if (x < x1) x1 = x;
        if (x > x2) x2 = x;
        if (y < y1) y1 = y;
        if (y > y2) y2 = y;
        if (x > 0 && !seen[p - 1] && prob[p - 1] > thresh) { seen[p - 1] = 1; stack[top++] = p - 1; }
        if (x < dw - 1 && !seen[p + 1] && prob[p + 1] > thresh) { seen[p + 1] = 1; stack[top++] = p + 1; }
        if (y > 0 && !seen[p - dw] && prob[p - dw] > thresh) { seen[p - dw] = 1; stack[top++] = p - dw; }
        if (y < dh - 1 && !seen[p + dw] && prob[p + dw] > thresh) { seen[p + dw] = 1; stack[top++] = p + dw; }
      }
      const bw = x2 - x1 + 1, bh = y2 - y1 + 1;
      // A capital I is a box a pixel or two wide: only the height counts.
      if (bh < 3 || bw * bh < 6 || sum / count < boxThresh) continue;
      // The model marks the middle of the text: grow the box back out.
      const d = (bw * bh * unclip) / (2 * (bw + bh));
      const fx = W / dw, fy = H / dh;
      const bx1 = Math.max(0, (x1 - d) * fx), by1 = Math.max(0, (y1 - d) * fy);
      const bx2 = Math.min(W, (x2 + 1 + d) * fx), by2 = Math.min(H, (y2 + 1 + d) * fy);
      boxes.push({ x: bx1, y: by1, w: bx2 - bx1, h: by2 - by1 });
    }
    return joinLines(boxes);
  }

  // The model sometimes splits a line at a wide space between words ("I" |
  // "am here," | "Erik."); a word read on its own is read worse. Boxes side
  // by side on the same line, closer than the text is tall, are one line.
  function joinLines(boxes) {
    const sorted = [...boxes].sort((a, b) => a.x - b.x);
    const out = [];
    for (const b of sorted) {
      const line = out.find((o) => {
        const overlap = Math.min(o.y + o.h, b.y + b.h) - Math.max(o.y, b.y);
        const gap = b.x - (o.x + o.w);
        return overlap > 0.6 * Math.min(o.h, b.h) && gap < 0.9 * Math.max(o.h, b.h) && gap > -0.5 * b.w;
      });
      if (!line) { out.push({ ...b }); continue; }
      const x2 = Math.max(line.x + line.w, b.x + b.w), y2 = Math.max(line.y + line.h, b.y + b.h);
      line.x = Math.min(line.x, b.x); line.y = Math.min(line.y, b.y);
      line.w = x2 - line.x; line.h = y2 - line.y;
    }
    return out;
  }

  // One line of text, in the box b of the picture.
  async function readBox(src, b) {
    const w = Math.min(REC_MAX_W, Math.max(REC_H, Math.round((REC_H * b.w) / b.h)));
    const [, ctx] = canvasOf(w, REC_H);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, b.x, b.y, b.w, b.h, 0, 0, w, REC_H);
    const px = ctx.getImageData(0, 0, w, REC_H).data;
    const n = w * REC_H;
    const input = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) {
      input[i] = px[i * 4 + 2] / 127.5 - 1;
      input[n + i] = px[i * 4 + 1] / 127.5 - 1;
      input[2 * n + i] = px[i * 4] / 127.5 - 1;
    }
    const out = await recSession.run({ [recSession.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, REC_H, w]) });
    const t = out[recSession.outputNames[0]];
    const [, T, C] = t.dims;
    const data = t.data;
    // Greedy CTC: the likeliest class at each step, repeats and blanks dropped.
    let text = '', last = 0, confSum = 0, confN = 0;
    for (let i = 0; i < T; i++) {
      let best = 0, bestP = -Infinity;
      for (let k = 0; k < C; k++) { const v = data[i * C + k]; if (v > bestP) { bestP = v; best = k; } }
      if (best !== 0 && best !== last) { text += classes[best] || ''; confSum += bestP; confN++; }
      last = best;
    }
    return { text: text.trim(), conf: confN ? confSum / confN : 0 };
  }

  return {
    classes: classes.length,
    readLine: (src) => readBox(src, { x: 0, y: 0, w: src.width, h: src.height }),
    async recognize(src, options = {}) {
      const lines = [];
      for (const b of await detect(src, options)) {
        // The detection model can leave out a thin letter at either end
        // (the "I" of "I told you"); reading a little wider brings it back.
        // Not for a lone number, where it picks up more of the icon behind.
        const widen = options.widen === false ? 0 : b.h * 0.4;
        const left = Math.min(widen, b.x);
        const right = Math.min(widen, src.width - b.x - b.w);
        const r = await readBox(src, { x: b.x - left, y: b.y, w: b.w + left + right, h: b.h });
        if (!r.text) continue;
        lines.push({ text: r.text, conf: r.conf, box: [b.x / src.width, b.y / src.height, b.w / src.width, b.h / src.height] });
      }
      return lines;
    },
  };
}
