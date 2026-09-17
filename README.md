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

## Browser support

| Browser | System voices | Neural voices | Tested |
|---|---|---|---|
| Chrome, Edge, Brave, Opera (recent) | ✓ | GPU (WebGPU) or CPU | Chrome, in automated tests |
| Safari 16+ | ✓ | CPU. GPU on Safari 26+, with automatic fallback to CPU if it fails | Code review only |
| Firefox 115+ | ✓ | CPU. GPU where Firefox supports WebGPU | Code review only |

Notes:
- Voice quality depends on the browser. Edge's "Natural" voices are the best free option. Firefox on Linux needs `speech-dispatcher` installed for system voices.
- The ⏯ media-key option works most reliably in Chrome and Edge.
- If a shortcut clashes with your browser, rebind it in the Keys section. Some browsers use Alt+letter shortcuts for their own menus on Windows.

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
- **Nicknames:** map a Twitch username to the name you want spoken. It applies to their messages, to replies to them, to @mentions and to their sub/raid events. Click a name in chat to add one quickly.
- **Moderation aware:** messages deleted by mods, and messages from banned or timed-out users, are removed from the queue.
- **Filters:** skip `!commands`, links and specific chatters. You can also cap message length and skip old messages when chat is too fast.
- **Cleanup:** emojis are stripped, links become "link", and spam like `loooooool` or repeated words is shortened.
- **Emotes:** Twitch marks its own emotes in the message, but 7TV, BetterTTV and FrankerFaceZ ones arrive as ordinary words, so the channel's emote names are fetched from those three services when you connect. Under *Reading → Emotes* you can skip everything (the default), skip only Twitch's own emotes and make no third-party requests, or have emote names read out loud. A message that is nothing but emotes is skipped instead of read.
  - Channel emote sets contain names that are also everyday words (`Chat`, `Stare`, `Timer`). Those are never taken out of a sentence: a name that could be a word someone typed is only dropped when the whole message is emotes.

## Voice engines

| | Neural (Kokoro) | System |
|---|---|---|
| Sound | Very natural | Depends on browser/OS |
| Voices | 24 (US/UK English) | Whatever is installed |
| Languages | English only | Many |
| Setup | One-time download: 92 MB (CPU) or 326 MB (GPU), cached afterwards | None |

The neural engine runs [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) locally via [kokoro-js](https://www.npmjs.com/package/kokoro-js). Nothing is sent to a TTS service. Upcoming messages are synthesized ahead of time so playback keeps up. System voices are used while it loads.

GPU mode needs graphics (hardware) acceleration. If it's turned off, or the browser has no WebGPU, the app shows a warning with steps for your browser and uses the CPU model instead.

For system voices, Microsoft Edge offers the most natural free options, the "… Online (Natural)" voices. On macOS you can download higher-quality "Enhanced" or "Premium" voices under System Settings → Accessibility → Spoken Content.

## Files

- `index.html`, `style.css`: UI
- `favicon.svg`, `favicon.ico`, `apple-touch-icon.png`: tab and bookmark icons
- `js/irc.js`: anonymous Twitch chat connection (IRC over WebSocket)
- `js/emotes.js`: 7TV, BetterTTV and FrankerFaceZ emote names for the connected channel
- `js/speech-text.js`: turns chat messages into natural spoken sentences
- `js/engines.js`: the neural and system speech engines, both supporting pause and resume
- `js/kokoro-worker.js`: runs the neural voice model in the background
- `Caddyfile`: server config with a CSP that allows the neural voices
- `js/app.js`: queue, pause logic, settings, keybindings
