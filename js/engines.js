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
// Graphics acceleration check (GPU neural voices need it)
// ---------------------------------------------------------------------------

const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|lavapipe|software|basic render/i;
let graphicsCheck = null;

/**
 * Resolves (once, cached) to:
 *   gpuUsable    WebGPU with a real hardware adapter
 *   accelerated  false = graphics acceleration is off / software rendering,
 *                true = hardware rendering, null = couldn't tell
 *   webgpu       the browser exposes a WebGPU adapter at all
 *   renderer     WebGL renderer name, for debugging
 */
function detectGraphics() {
  if (graphicsCheck) return graphicsCheck;
  graphicsCheck = (async () => {
    let webgpu = false;
    let fallbackAdapter = false;
    try {
      const adapter = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
      if (adapter) {
        webgpu = true;
        fallbackAdapter = !!((adapter.info && adapter.info.isFallbackAdapter) ?? adapter.isFallbackAdapter);
      }
    } catch {}

    let accelerated = null;
    let renderer = '';
    try {
      // Browsers refuse a context with this flag when WebGL would run in software.
      const fast = document.createElement('canvas').getContext('webgl', { failIfMajorPerformanceCaveat: true });
      const gl = fast || document.createElement('canvas').getContext('webgl');
      if (gl) {
        // Firefox reports the real renderer directly (and warns if the debug
        // extension is used); Chromium and Safari mask it as "WebKit WebGL".
        renderer = String(gl.getParameter(gl.RENDERER) || '');
        if (/^webkit webgl$/i.test(renderer)) {
          const info = gl.getExtension('WEBGL_debug_renderer_info');
          if (info) renderer = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) || renderer);
        }
        const lose = gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      }
      accelerated = !!fast && !SOFTWARE_RENDERER.test(renderer);
    } catch {}

    const gpuUsable = webgpu && !fallbackAdapter;
    if (fallbackAdapter) accelerated = false;
    if (gpuUsable && accelerated === null) accelerated = true;
    return { gpuUsable, accelerated, webgpu, renderer };
  })();
  return graphicsCheck;
}

// ---------------------------------------------------------------------------
// Neural voices (Kokoro-82M running locally in a Web Worker)
// ---------------------------------------------------------------------------

// Resolved against this script so it works when the app lives in a subfolder.
const KOKORO_WORKER_URL = new URL('kokoro-worker.js', (document.currentScript && document.currentScript.src) || location.href).href;
// Generous: jobs run one at a time, so a request can wait behind prefetches on slow CPUs.
const GENERATE_TIMEOUT_MS = 120000;
// Give up on a load that goes silent (e.g. a GPU backend hanging) so load()
// can fall back to the CPU model. Downloads report progress constantly.
const LOAD_STALL_MS = 120000;

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
    return (await detectGraphics()).gpuUsable;
  }

  loadWith(device) {
    this.terminate();
    this.device = device;
    this.files.clear();
    this.setState('loading', { progress: 0, device });

    if (!window.isSecureContext) {
      const error = 'neural voices need the page to be served over HTTPS';
      this.setState('error', { error, device });
      return Promise.reject(new Error(error));
    }

    let worker;
    try {
      worker = new Worker(KOKORO_WORKER_URL, { type: 'module' });
    } catch (err) {
      const error = `voice worker could not be created (${err.message})`;
      this.setState('error', { error, device });
      return Promise.reject(new Error(error));
    }
    this.worker = worker;
    let started = false;
    let stallTimer = null;

    return new Promise((resolve, reject) => {
      const fail = (rawError) => {
        clearTimeout(stallTimer);
        let error = rawError;
        if (/Content Security Policy/i.test(rawError) && /WebAssembly|unsafe-eval/i.test(rawError)) {
          console.warn(rawError);
          error = "the site's Content-Security-Policy blocks WebAssembly. Add 'wasm-unsafe-eval' to script-src (see Caddyfile)";
        }
        this.setState('error', { error, device });
        this.terminate();
        reject(new Error(error));
      };

      const armStallTimer = () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          if (this.worker === worker && this.state === 'loading') fail('loading stalled with no progress');
        }, LOAD_STALL_MS);
      };
      armStallTimer();

      worker.onmessage = ({ data }) => {
        if (this.worker !== worker) return;
        if (this.state === 'loading') armStallTimer();
        switch (data.type) {
          case 'started': started = true; break;
          case 'progress': this.onProgress(data.p); break;
          case 'ready':
            clearTimeout(stallTimer);
            this.setState('ready', { device });
            resolve();
            break;
          case 'loadError':
            fail(data.error);
            break;
          case 'fatal':
            console.warn('Voice worker error:', data.error);
            // Before ready this is a load failure. After, stray errors are
            // logged only; a failed generation rejects or times out on its own.
            if (this.state !== 'ready') fail(data.error);
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
        e.preventDefault();
        if (e.message) fail(e.message);
        else if (!started) fail(`voice worker script didn't load. Check that ${KOKORO_WORKER_URL} opens in the browser as JavaScript, and that no Content-Security-Policy blocks workers or cdn.jsdelivr.net`);
        else fail('voice worker stopped unexpectedly');
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
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('Speech generation timed out'));
      }, GENERATE_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
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
