'use strict';

// Puts what the screen reader's own text recognition needs into screen/:
//   screen/models/  PaddleOCR (PP-OCRv5) models, downloaded once and checked
//                   against the hashes below
//   screen/ort/     ONNX Runtime Web, copied from node_modules
// Both folders are left out of git; this runs before start, pack and dist.
// The models are Apache-2.0, from https://github.com/PaddlePaddle/PaddleOCR
// converted to ONNX.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCREEN = path.join(__dirname, '..', 'screen');
const MODELS = path.join(SCREEN, 'models');
const ORT = path.join(SCREEN, 'ort');

const FILES = [
  {
    // PP-OCRv5 mobile detection: finds the lines of text.
    name: 'det.onnx',
    url: 'https://huggingface.co/webnn/PP-OCRv5-ONNX/resolve/006b4419a415072fbb16a1d7d0d8548f789a8fae/ch_PP-OCRv5_det.onnx',
    sha256: 'd7fe3ea74652890722c0f4d02458b7261d9f5ae6c92904d05707c9eb155c7924',
  },
  {
    // PP-OCRv5 mobile recognition for Latin script (English, Swedish, German,
    // French, Spanish and 27 more): reads each line.
    name: 'rec.onnx',
    url: 'https://huggingface.co/monkt/paddleocr-onnx/resolve/7b02d0a30a07ba2b92ad1ff5a8941ae2c633de65/languages/latin/rec.onnx',
    sha256: '614ffc2d6d3902d360fad7f1b0dd455ee45e877069d14c4e51a99dc4ef144409',
  },
  {
    name: 'dict.txt',
    url: 'https://huggingface.co/monkt/paddleocr-onnx/resolve/7b02d0a30a07ba2b92ad1ff5a8941ae2c633de65/languages/latin/dict.txt',
    sha256: '3c0a8a79b612653c25f765271714f71281e4e955962c153e272b7b8c1d2b13ff',
  },
];

// The runtime, the WebAssembly it runs, and the loader it imports in a worker.
const ORT_FILES = ['ort.wasm.bundle.min.mjs', 'ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs'];

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function fetchModel({ name, url, sha256: want }) {
  const dest = path.join(MODELS, name);
  if (fs.existsSync(dest) && sha256(dest) === want) return false;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${name}: ${res.status} ${res.statusText} from ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = crypto.createHash('sha256').update(buf).digest('hex');
  if (got !== want) throw new Error(`${name}: downloaded file doesn't match its hash (got ${got})`);
  fs.writeFileSync(dest, buf);
  return true;
}

async function main() {
  fs.mkdirSync(MODELS, { recursive: true });
  fs.mkdirSync(ORT, { recursive: true });
  let fetched = 0;
  for (const f of FILES) if (await fetchModel(f)) fetched++;

  const dist = path.join(__dirname, '..', 'node_modules', 'onnxruntime-web', 'dist');
  for (const f of ORT_FILES) fs.copyFileSync(path.join(dist, f), path.join(ORT, f));

  console.log(`fetch-ocr: ${fetched ? `downloaded ${fetched} model file(s)` : 'models up to date'}, ONNX Runtime copied`);
}

main().catch((err) => {
  console.error(`fetch-ocr: ${err.message}`);
  process.exit(1);
});
