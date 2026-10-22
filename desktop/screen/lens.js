'use strict';

// The lens (see lens.html). It captures the screen the reader watches and
// draws a magnified part of it: around what's being read, the middle of the
// screen (where a game's crosshair is), or one zone. Wide lines of text are
// zoomed out just enough to fit, so the whole line can be read.

(() => {
  const api = window.screenOverlay || { onState: () => {} };
  const canvas = document.getElementById('view');
  const ctx = canvas.getContext('2d', { alpha: false });
  const caption = document.getElementById('caption');
  const note = document.getElementById('note');

  const FILTERS = {
    none: 'none',
    invert: 'invert(1) hue-rotate(180deg)',
    contrast: 'contrast(1.7) saturate(1.2)',
    gray: 'grayscale(1) contrast(1.5)',
    'gray-invert': 'grayscale(1) invert(1) contrast(1.5)',
    yellow: 'url(#yellow)',
  };

  let state = {};
  let video = null;
  let stream = null;
  let starting = false;
  // Where the lens is looking now, eased toward where it should look.
  const view = { cx: 0.5, cy: 0.5, zoom: 2, ready: false };

  function showNote(text) {
    note.textContent = text;
    note.hidden = !text;
  }

  function stopCapture() {
    if (stream) for (const track of stream.getTracks()) track.stop();
    stream = null;
    if (video) { video.srcObject = null; video = null; }
  }

  async function startCapture() {
    if (starting) return;
    starting = true;
    stopCapture();
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
      video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();
      showNote('');
    } catch (err) {
      stopCapture();
      showNote(api.platform === 'darwin'
        ? 'The lens can’t see the screen. Allow Chat Reader under System Settings → Privacy & Security → Screen Recording, then restart it.'
        : `The lens can’t see the screen: ${err.message}`);
    } finally {
      starting = false;
    }
  }

  function goal() {
    const t = state.target;
    if (state.follow === 'centre' || !t) return { cx: 0.5, cy: 0.5, t: state.follow === 'centre' ? null : t };
    return { cx: t.x + t.w / 2, cy: t.y + t.h / 2, t };
  }

  function frame() {
    requestAnimationFrame(frame);
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    if (!W || !H) return;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    if (!video || video.readyState < 2 || !video.videoWidth) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }
    const screenW = (state.sourceSize && state.sourceSize.width) || video.videoWidth;
    const screenH = (state.sourceSize && state.sourceSize.height) || video.videoHeight;
    const g = goal();
    const maxZoom = Math.max(1, Number(state.zoom) || 2);
    let zoom = maxZoom;
    if (g.t && state.fit !== false) {
      // Enough room for the whole line, never more than asked for.
      const fitW = (W * 0.94) / Math.max(1, g.t.w * screenW);
      const fitH = (H * 0.8) / Math.max(1, g.t.h * screenH);
      zoom = Math.min(maxZoom, Math.max(1, Math.min(fitW, fitH)));
    }
    const ease = state.smooth === false || !view.ready ? 1 : 0.22;
    view.cx += (g.cx - view.cx) * ease;
    view.cy += (g.cy - view.cy) * ease;
    view.zoom += (zoom - view.zoom) * ease;
    view.ready = true;

    const vw = Math.min(1, W / (view.zoom * screenW));
    const vh = Math.min(1, H / (view.zoom * screenH));
    const sx = Math.min(1 - vw, Math.max(0, view.cx - vw / 2));
    const sy = Math.min(1 - vh, Math.max(0, view.cy - vh / 2));
    ctx.imageSmoothingEnabled = state.smoothPixels !== false;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(video, sx * video.videoWidth, sy * video.videoHeight, vw * video.videoWidth, vh * video.videoHeight, 0, 0, canvas.width, canvas.height);
  }

  api.onState((s) => {
    const restart = !!s.restart || !stream;
    state = s || {};
    document.body.classList.toggle('fill', state.position === 'fill');
    canvas.style.filter = FILTERS[state.filter] || 'none';
    const text = state.caption !== false ? String(state.text || '') : '';
    caption.hidden = !text;
    caption.textContent = text;
    if (state.captionSize) document.documentElement.style.setProperty('--caption-size', `${state.captionSize}px`);
    if (restart) startCapture();
  });

  requestAnimationFrame(frame);
})();
