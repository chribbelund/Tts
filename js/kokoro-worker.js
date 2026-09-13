// Runs Kokoro TTS off the main thread. Loaded by KokoroEngine in engines.js.

const KOKORO_URL = 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js';
const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';

const describe = (err) => String((err && (err.message || err.reason)) || err || 'Unknown error');

// Anything that escapes the handlers below would otherwise surface on the page
// as a message-less "error" event, so report it explicitly.
self.addEventListener('error', (e) => {
  self.postMessage({ type: 'fatal', error: e.message || 'Uncaught error in voice worker' });
});
self.addEventListener('unhandledrejection', (e) => {
  self.postMessage({ type: 'fatal', error: describe(e.reason) });
});

let tts = null;
let chain = Promise.resolve();

self.onmessage = (event) => {
  const msg = event.data;
  if (msg.type === 'load') {
    (async () => {
      try {
        const { KokoroTTS } = await import(KOKORO_URL);
        tts = await KokoroTTS.from_pretrained(KOKORO_MODEL, {
          dtype: msg.dtype,
          device: msg.device,
          progress_callback: (p) => self.postMessage({ type: 'progress', p }),
        });
        // Warm up so the first real message isn't slow.
        await tts.generate('Hi.', { voice: 'af_heart' });
        self.postMessage({ type: 'ready' });
      } catch (err) {
        self.postMessage({ type: 'loadError', error: describe(err) });
      }
    })();
  } else if (msg.type === 'generate') {
    chain = chain.then(async () => {
      try {
        const out = await tts.generate(msg.text, { voice: msg.voice, speed: msg.speed });
        const samples = out.audio;
        self.postMessage({ type: 'audio', id: msg.id, samples, sampleRate: out.sampling_rate }, [samples.buffer]);
      } catch (err) {
        self.postMessage({ type: 'genError', id: msg.id, error: describe(err) });
      }
    });
  }
};

self.postMessage({ type: 'started' });
