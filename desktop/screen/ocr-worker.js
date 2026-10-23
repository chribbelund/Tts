// Runs PaddleOCR (paddle-ocr.js) off the page's thread, for desktop/bot/screen.js.
//
// In:  { type: 'init', ortUrl, wasm, det, rec, dict }   once, the files from screen-main.js
//      { id, picture: ImageBitmap, line: false, options }  read a picture
// Out: { type: 'ready', ms } or { type: 'error', error }
//      { id, lines: [{ text, conf, box }], ms } or { id, error }
// With line: true the whole picture is read as one line (a box around a
// number) and lines has at most one, its box the whole picture.

import { create } from './paddle-ocr.js';

let ocr = null;
let ready = null;

async function init({ ortUrl, wasm, det, rec, dict }) {
  const started = performance.now();
  const ort = await import(ortUrl);
  // Given the bytes, ONNX Runtime doesn't fetch its WebAssembly (fetch can't
  // read file:// URLs). One thread: the page isn't cross-origin isolated.
  ort.env.wasm.wasmBinary = wasm;
  ort.env.wasm.numThreads = 1;
  ocr = await create({ ort, det, rec, dict });
  return Math.round(performance.now() - started);
}

self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    ready = init(data);
    try { self.postMessage({ type: 'ready', ms: await ready }); } catch (err) { self.postMessage({ type: 'error', error: err.message || String(err) }); }
    return;
  }
  const { id, picture, line, options } = data;
  const started = performance.now();
  try {
    await ready;
    let lines;
    if (line) {
      const r = await ocr.readLine(picture);
      lines = r.text ? [{ text: r.text, conf: r.conf, box: [0, 0, 1, 1] }] : [];
    } else {
      lines = await ocr.recognize(picture, options || {});
    }
    self.postMessage({ id, lines, ms: Math.round(performance.now() - started) });
  } catch (err) {
    self.postMessage({ id, error: err.message || String(err) });
  } finally {
    if (picture && picture.close) picture.close();
  }
};
