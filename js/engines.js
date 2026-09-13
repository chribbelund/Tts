'use strict';

// Two speech engines behind the same small interface:
//
//   engine.speak(text, voiceOptions, { getVolume }) -> controller
//   controller.done       Promise that resolves when finished or stopped
//   controller.pause()    hold position
//   controller.resume()   continue from the held position
//   controller.stop()     abandon (resolves done)
//   controller.volumeChanged()
//   controller.progress() 0..1

// ---------------------------------------------------------------------------
// System voices (Web Speech API)
// ---------------------------------------------------------------------------

const NOVELTY_VOICES = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Pipe Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Deranged|Hysterical|Junior|Ralph|Fred|Kathy|Eddy|Flo|Grandma|Grandpa|Reed|Rocko|Sandy|Shelley)\b/i;
const NATURAL_VOICES = /natural|neural|online|premium|enhanced|siri|google/i;

class SystemEngine {
  constructor() {
    this.supported = 'speechSynthesis' in window;
    this.id = 'system';
  }

  voices() {
    if (!this.supported) return [];
    return speechSynthesis.getVoices().map((v) => ({
      id: v.voiceURI,
      name: v.name.replace(/^Microsoft\s+/, '').replace(/\s+Online \(Natural\)/, ' (Natural)'),
      lang: v.lang,
      natural: NATURAL_VOICES.test(v.name),
      novelty: NOVELTY_VOICES.test(v.name),
      local: v.localService,
      raw: v,
    }));
  }

  speak(text, { voiceId, rate = 1, pitch = 1 }, { getVolume }) {
    const synth = speechSynthesis;
    const voice = synth.getVoices().find((v) => v.voiceURI === voiceId) || null;
    const chunks = splitIntoChunks(text, 180);
    const total = Math.max(1, text.length);

    let chunkIndex = 0;
    let offset = 0;      // where in the current chunk the active utterance starts
    let boundary = 0;    // start of the last word reached in the current chunk
    let doneChars = 0;   // characters in fully spoken chunks
    let sawBoundary = false;
    let state = 'playing';
    let token = 0;
    let utterance = null; // keep a reference: Chrome drops events for GC'd utterances
    let watchdog = null;
    let resolveDone;
    const done = new Promise((r) => { resolveDone = r; });

    const finish = () => {
      if (state === 'done') return;
      state = 'done';
      token++;
      clearInterval(watchdog);
      resolveDone();
    };

    const advance = () => {
      doneChars += chunks[chunkIndex].length;
      chunkIndex++;
      offset = 0;
      boundary = 0;
      if (chunkIndex >= chunks.length) finish();
      else speakChunk();
    };

    const speakChunk = () => {
      const t = ++token;
      const u = new SpeechSynthesisUtterance(chunks[chunkIndex].slice(offset));
      utterance = u;
      if (voice) { u.voice = voice; u.lang = voice.lang; }
      u.rate = Math.min(10, Math.max(0.1, rate));
      u.pitch = Math.min(2, Math.max(0, pitch));
      u.volume = getVolume();
      u.onboundary = (e) => {
        if (t !== token) return;
        sawBoundary = true;
        boundary = offset + e.charIndex;
      };
      u.onend = () => { if (t === token && state === 'playing') advance(); };
      u.onerror = (e) => {
        if (t !== token || state !== 'playing') return;
        if (e.error !== 'interrupted' && e.error !== 'canceled') console.warn('Speech error:', e.error);
        advance();
      };
      const startedAt = performance.now();
      synth.speak(u);

      // Some browsers occasionally never fire onend; don't let the reader hang.
      clearInterval(watchdog);
      watchdog = setInterval(() => {
        if (t !== token || state !== 'playing') return;
        if (performance.now() - startedAt > 2500 && !synth.speaking && !synth.pending) advance();
      }, 1000);
    };

    // Cancel and restart from the last word boundary (or the chunk start).
    const interruptAndHold = () => {
      token++;
      offset = boundary;
      synth.cancel();
    };
    const restartSoon = () => {
      const t = token;
      setTimeout(() => { if (state === 'playing' && token === t) speakChunk(); }, 80);
    };

    if (synth.speaking || synth.pending) synth.cancel();
    setTimeout(() => { if (state === 'playing') speakChunk(); }, 30);

    return {
      done,
      pause() {
        if (state !== 'playing') return;
        state = 'paused';
        interruptAndHold();
      },
      resume() {
        if (state !== 'paused') return;
        state = 'playing';
        restartSoon();
      },
      stop() {
        if (state === 'done') return;
        finish();
        synth.cancel();
      },
      volumeChanged() {
        // Web Speech can't change volume mid-utterance; restart from the
        // current word if we know where it is, otherwise it applies next chunk.
        if (state !== 'playing' || !sawBoundary) return;
        interruptAndHold();
        restartSoon();
      },
      progress() {
        if (state === 'done') return 1;
        return Math.min(1, (doneChars + boundary) / total);
      },
      get utterance() { return utterance; },
    };
  }

  preview(text, voiceId, volume) {
    return new Promise((resolve) => {
      const voice = speechSynthesis.getVoices().find((v) => v.voiceURI === voiceId);
      const u = new SpeechSynthesisUtterance(text);
      if (voice) { u.voice = voice; u.lang = voice.lang; }
      u.volume = volume;
      u.onend = u.onerror = () => resolve();
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    });
  }
}

// ---------------------------------------------------------------------------
// Neural voices (Kokoro-82M running locally in a Web Worker)
// ---------------------------------------------------------------------------

const KOKORO_URL = 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js';
const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';

const KOKORO_VOICES = [
  { id: 'af_heart', name: 'Heart', accent: 'US', gender: 'F', grade: 'A' },
  { id: 'af_bella', name: 'Bella', accent: 'US', gender: 'F', grade: 'A-' },
  { id: 'af_nicole', name: 'Nicole', accent: 'US', gender: 'F', grade: 'B-' },
  { id: 'bf_emma', name: 'Emma', accent: 'UK', gender: 'F', grade: 'B-' },
  { id: 'am_fenrir', name: 'Fenrir', accent: 'US', gender: 'M', grade: 'C+' },
  { id: 'am_michael', name: 'Michael', accent: 'US', gender: 'M', grade: 'C+' },
  { id: 'am_puck', name: 'Puck', accent: 'US', gender: 'M', grade: 'C+' },
  { id: 'af_aoede', name: 'Aoede', accent: 'US', gender: 'F', grade: 'C+' },
  { id: 'af_kore', name: 'Kore', accent: 'US', gender: 'F', grade: 'C+' },
  { id: 'af_sarah', name: 'Sarah', accent: 'US', gender: 'F', grade: 'C+' },
  { id: 'bm_george', name: 'George', accent: 'UK', gender: 'M', grade: 'C' },
  { id: 'bm_fable', name: 'Fable', accent: 'UK', gender: 'M', grade: 'C' },
  { id: 'bf_isabella', name: 'Isabella', accent: 'UK', gender: 'F', grade: 'C' },
  { id: 'af_alloy', name: 'Alloy', accent: 'US', gender: 'F', grade: 'C' },
  { id: 'af_nova', name: 'Nova', accent: 'US', gender: 'F', grade: 'C' },
  { id: 'af_sky', name: 'Sky', accent: 'US', gender: 'F', grade: 'C-' },
  { id: 'bm_lewis', name: 'Lewis', accent: 'UK', gender: 'M', grade: 'D+' },
  { id: 'am_echo', name: 'Echo', accent: 'US', gender: 'M', grade: 'D' },
  { id: 'am_eric', name: 'Eric', accent: 'US', gender: 'M', grade: 'D' },
  { id: 'am_liam', name: 'Liam', accent: 'US', gender: 'M', grade: 'D' },
  { id: 'am_onyx', name: 'Onyx', accent: 'US', gender: 'M', grade: 'D' },
  { id: 'bm_daniel', name: 'Daniel', accent: 'UK', gender: 'M', grade: 'D' },
  { id: 'bf_alice', name: 'Alice', accent: 'UK', gender: 'F', grade: 'D' },
  { id: 'bf_lily', name: 'Lily', accent: 'UK', gender: 'F', grade: 'D' },
];
const KOKORO_BEST = KOKORO_VOICES.filter((v) => /^[ABC]/.test(v.grade) && v.grade !== 'C-').map((v) => v.id);

// Built as a Blob so the app also works when index.html is opened from disk.
const KOKORO_WORKER_SOURCE = `
let tts = null;
let chain = Promise.resolve();
self.onmessage = (event) => {
  const msg = event.data;
  if (msg.type === 'load') {
    (async () => {
      try {
        const { KokoroTTS } = await import(${JSON.stringify(KOKORO_URL)});
        tts = await KokoroTTS.from_pretrained(${JSON.stringify(KOKORO_MODEL)}, {
          dtype: msg.dtype,
          device: msg.device,
          progress_callback: (p) => self.postMessage({ type: 'progress', p }),
        });
        // Warm up so the first real message isn't slow.
        await tts.generate('Hi.', { voice: 'af_heart' });
        self.postMessage({ type: 'ready' });
      } catch (err) {
        self.postMessage({ type: 'loadError', error: String((err && err.message) || err) });
      }
    })();
  } else if (msg.type === 'generate') {
    chain = chain.then(async () => {
      try {
        const out = await tts.generate(msg.text, { voice: msg.voice, speed: msg.speed });
        const samples = out.audio;
        self.postMessage({ type: 'audio', id: msg.id, samples, sampleRate: out.sampling_rate }, [samples.buffer]);
      } catch (err) {
        self.postMessage({ type: 'genError', id: msg.id, error: String((err && err.message) || err) });
      }
    });
  }
};
`;

class KokoroEngine {
  constructor({ onState }) {
    this.id = 'kokoro';
    this.onState = onState;
    this.state = 'unloaded'; // unloaded | loading | ready | error
    this.worker = null;
    this.device = null;
    this.seq = 0;
    this.pending = new Map();
    this.cache = new Map();
    this.ctx = null;
    this.gain = null;
    this.files = new Map();
  }

  voices() {
    return KOKORO_VOICES;
  }

  async load(mode = 'auto') {
    if (this.state === 'loading' || this.state === 'ready') return;
    let device = mode;
    if (mode === 'auto') device = (await this.hasWebGPU()) ? 'webgpu' : 'wasm';
    try {
      await this.loadWith(device);
    } catch (err) {
      if (device === 'webgpu') {
        console.warn('WebGPU load failed, falling back to CPU:', err);
        await this.loadWith('wasm').catch(() => {});
      }
    }
  }

  async hasWebGPU() {
    try {
      return !!(navigator.gpu && await navigator.gpu.requestAdapter());
    } catch {
      return false;
    }
  }

  loadWith(device) {
    this.terminate();
    this.device = device;
    this.files.clear();
    this.setState('loading', { progress: 0, device });

    const url = URL.createObjectURL(new Blob([KOKORO_WORKER_SOURCE], { type: 'text/javascript' }));
    const worker = new Worker(url, { type: 'module' });
    URL.revokeObjectURL(url);
    this.worker = worker;

    return new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => {
        if (this.worker !== worker) return;
        switch (data.type) {
          case 'progress': this.onProgress(data.p); break;
          case 'ready':
            this.setState('ready', { device });
            resolve();
            break;
          case 'loadError':
            this.setState('error', { error: data.error, device });
            this.terminate();
            reject(new Error(data.error));
            break;
          case 'audio':
          case 'genError': {
            const job = this.pending.get(data.id);
            if (!job) break;
            this.pending.delete(data.id);
            if (data.type === 'audio') job.resolve({ samples: data.samples, sampleRate: data.sampleRate });
            else job.reject(new Error(data.error));
            break;
          }
        }
      };
      worker.onerror = (e) => {
        if (this.worker !== worker) return;
        const error = e.message || 'Worker failed to start';
        this.setState('error', { error, device });
        this.terminate();
        reject(new Error(error));
      };
      worker.postMessage({ type: 'load', device, dtype: device === 'webgpu' ? 'fp32' : 'q8' });
    });
  }

  terminate() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
    for (const job of this.pending.values()) job.reject(new Error('Engine stopped'));
    this.pending.clear();
    this.cache.clear();
  }

  onProgress(p) {
    if (p.status === 'progress' && p.total) {
      this.files.set(p.file, { loaded: p.loaded, total: p.total });
    } else if (p.status === 'done' && this.files.has(p.file)) {
      const f = this.files.get(p.file);
      f.loaded = f.total;
    }
    let loaded = 0, total = 0;
    for (const f of this.files.values()) { loaded += f.loaded; total += f.total; }
    this.setState('loading', { progress: total ? loaded / total : 0, loaded, total, device: this.device });
  }

  setState(state, info = {}) {
    this.state = state;
    this.onState(state, info);
  }

  ensureAudio() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  generate(text, voice, speed) {
    const key = `${voice}|${speed.toFixed(3)}|${text}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const id = ++this.seq;
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    promise.catch(() => this.cache.delete(key));
    this.worker.postMessage({ type: 'generate', id, text, voice, speed });
    this.cache.set(key, promise);
    while (this.cache.size > 24) this.cache.delete(this.cache.keys().next().value);
    return promise;
  }

  /** Start synthesizing upcoming messages so they play without delay. */
  prefetch(items) {
    if (this.state !== 'ready') return;
    for (const { text, voiceId, speed } of items) this.generate(text, voiceId, speed);
  }

  speak(text, { voiceId, speed = 1 }, { getVolume }) {
    const ctx = this.ensureAudio();
    const gain = this.gain;
    gain.gain.value = getVolume();

    let state = 'playing';
    let source = null;
    let startedAt = 0;
    let duration = 0;
    let resolveDone;
    const done = new Promise((r) => { resolveDone = r; });

    const finish = () => {
      if (state === 'done') return;
      state = 'done';
      resolveDone();
    };

    // A previous pause may have left the shared context suspended.
    if (ctx.state === 'suspended') ctx.resume();

    this.generate(text, voiceId, speed).then(({ samples, sampleRate }) => {
      if (state === 'done') return;
      const buffer = ctx.createBuffer(1, samples.length, sampleRate);
      buffer.copyToChannel(samples, 0);
      source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      source.onended = finish;
      duration = buffer.duration;
      startedAt = ctx.currentTime;
      source.start();
    }, (err) => {
      console.warn('Kokoro generation failed:', err);
      finish();
    });

    return {
      done,
      pause() {
        if (state !== 'playing') return;
        state = 'paused';
        ctx.suspend();
      },
      resume() {
        if (state !== 'paused') return;
        state = 'playing';
        ctx.resume();
      },
      stop() {
        if (state === 'done') return;
        const wasPaused = state === 'paused';
        finish();
        if (source) { source.onended = null; try { source.stop(); } catch {} }
        if (wasPaused) ctx.resume();
      },
      volumeChanged() {
        gain.gain.setTargetAtTime(getVolume(), ctx.currentTime, 0.03);
      },
      progress() {
        if (state === 'done') return 1;
        if (!source || !duration) return 0;
        return Math.min(1, (ctx.currentTime - startedAt) / duration);
      },
      get loading() { return !source && state !== 'done'; },
    };
  }

  async preview(text, voiceId, volume) {
    const { samples, sampleRate } = await this.generate(text, voiceId, 1);
    const audio = new Audio(URL.createObjectURL(floatToWav(samples, sampleRate)));
    audio.volume = volume;
    await new Promise((resolve) => {
      audio.onended = audio.onerror = resolve;
      audio.play().catch(resolve);
    });
    URL.revokeObjectURL(audio.src);
  }
}

function floatToWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (offset, s) => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}
