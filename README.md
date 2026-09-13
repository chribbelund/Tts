# Chat Reader: Twitch TTS

Reads a Twitch channel's chat out loud in the browser. No login, no install, no server-side code.

## Run it

Serve the folder with any static web server. Opening `index.html` straight from disk isn't recommended, because browsers restrict workers and caching on `file://` pages.

```bash
cd /path/to/Tts && python3 -m http.server 8765
```

Then open http://localhost:8765. You can also put the folder on any static host, such as GitHub Pages or Netlify, and use it from any computer.

Add `?channel=name` to the URL to prefill a channel, e.g. `http://localhost:8765/?channel=shroud`.

Chrome or Edge is recommended. Neural voices need HTTPS, or `localhost`.

## Deploying (Coolify, Railway, any static host)

The server's Content-Security-Policy must allow three things:
- WebAssembly (`'wasm-unsafe-eval'` in `script-src`)
- workers (`worker-src 'self' blob:`)
- `blob:` audio (`media-src`)

Coolify and Railway build static sites with Railpack. Railpack's default Caddy config sends a CSP that blocks all three, which shows up as "Couldn't load … Using system voices". The `Caddyfile` in this folder replaces that default: Railpack picks it up automatically from the project root. On other hosts, copy the `Content-Security-Policy` value from it.

## Features

- **Any channel:** type a name or paste a `twitch.tv/...` link. It reconnects automatically if the connection drops.
- **Replies:** read as *"Alice, replying to Bob: …"*. You can optionally include the message being replied to.
- **Pause on a message:** press **Alt+P** (⌥P on Mac) or the big button. Reading stops mid-message and new messages keep queueing. Pressing it again continues that same message.
  - Neural voices resume at the exact point.
  - System voices resume from the last word spoken, or from the start of the sentence if the voice doesn't report word positions.
- **Skip:** Alt+S. You can remove waiting messages with ×. Both shortcuts can be rebound in the Keys section.
- **Media key:** turn on *Use the keyboard's ⏯ media key* to pause and resume while a game or another app is focused. Normal shortcuts only work while the tab is focused, which is a browser limitation.
- **Volume and speed:** with neural voices, volume changes apply instantly.
- **Multiple voices:** each chatter gets a consistent voice from the pool, with a slight per-chatter pitch and pace variation. Click the voice tag on a message to give that chatter a different voice.
- **Moderation aware:** messages deleted by mods, and messages from banned or timed-out users, are removed from the queue.
- **Filters:** skip `!commands`, links and specific chatters. You can also cap message length and skip old messages when chat is too fast.
- **Cleanup:** emotes and emojis are stripped, links become "link", and spam like `loooooool` or repeated words is shortened.

## Voice engines

| | Neural (Kokoro) | System |
|---|---|---|
| Sound | Very natural | Depends on browser/OS |
| Voices | 24 (US/UK English) | Whatever is installed |
| Languages | English only | Many |
| Setup | One-time download: 92 MB (CPU) or 326 MB (GPU), cached afterwards | None |

The neural engine runs [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) locally via [kokoro-js](https://www.npmjs.com/package/kokoro-js). Nothing is sent to a TTS service. Upcoming messages are synthesized ahead of time so playback keeps up. System voices are used while it loads.

For system voices, Microsoft Edge offers the most natural free options, the "… Online (Natural)" voices. On macOS you can download higher-quality "Enhanced" or "Premium" voices under System Settings → Accessibility → Spoken Content.

## Files

- `index.html`, `style.css`: UI
- `js/irc.js`: anonymous Twitch chat connection (IRC over WebSocket)
- `js/speech-text.js`: turns chat messages into natural spoken sentences
- `js/engines.js`: the neural and system speech engines, both supporting pause and resume
- `js/kokoro-worker.js`: runs the neural voice model in the background
- `Caddyfile`: server config with a CSP that allows the neural voices
- `js/app.js`: queue, pause logic, settings, keybindings
