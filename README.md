# Chat Reader: Twitch TTS

Reads a Twitch channel's chat out loud in the browser. No login, no install, no server-side code.
The [desktop app](#desktop-app) can also read YouTube and TikTok live chat, together with
Twitch, in one queue: see [YouTube and TikTok](#youtube-and-tiktok).

## Run it

Serve the folder with any static web server. Opening `index.html` straight from disk isn't recommended, because browsers restrict workers and caching on `file://` pages.

```bash
cd /path/to/Tts && python3 -m http.server 8765
```

Then open http://localhost:8765. You can also put the folder on any static host, such as GitHub Pages or Netlify, and use it from any computer.

Add `?channel=name` to the URL to prefill a channel, e.g. `http://localhost:8765/?channel=shroud`.

Chrome or Edge is recommended. Neural voices need HTTPS, or `localhost`.

## Desktop app

The desktop app is this same page in a small Electron shell, with two things a
browser can't do: the shortcuts are registered with the operating system, so they
work while a game, Discord or anything else is focused, and it can read
[YouTube and TikTok](#youtube-and-tiktok) chat as well as Twitch.

Download the build for your system from the
[releases page](https://github.com/chribbelund/Tts/releases).

| System | File |
|---|---|
| macOS (Intel and Apple silicon) | `chat-reader-<version>-mac-universal.dmg`, or the `.zip` |
| Windows | `...-setup.exe`, or `...-portable.exe` to run it without installing |

There's no Linux build; run the page in a browser there, or build it yourself with
`npx electron-builder --linux` after adding a `linux` section to
`desktop/electron-builder.yml`.

The builds aren't code-signed, so the first launch needs one extra step: on macOS
right-click the app and choose *Open*, on Windows choose *More info* → *Run anyway*.

### Keys

Every action can be rebound: click a shortcut under *Settings → Keys* and press the keys
you want. Backspace clears one, Esc keeps the old one.

| Action | Default |
|---|---|
| Pause / resume | `Alt+P` (`⌥P`) |
| Skip message | `Alt+S` (`⌥S`) |
| Volume up / down, in steps of 5 | `Alt+↑` / `Alt+↓` |
| Clear waiting messages | `Alt+Shift+C` |
| Show / hide the window | `Alt+Shift+H` |

- An ordinary key needs at least one modifier, because a global shortcut takes that
  key away from every other app. Function keys (F1–F24) can stand on their own.
- If another app already holds a combination, the row says so and nothing is bound to
  it — pick different keys.
- On macOS the Settings menu opens the settings with ⌘, and saves and loads the settings
  file with ⌘S and ⌘O. Elsewhere the app has no menu bar, so use the *Settings* button
  and its *Backup* tab.
- Turning off *Let these work while another app is focused* makes the shortcuts behave
  like the web version: only inside the window.
- *Use the keyboard's ⏯ media key* adds ⏯ and ⏭ on top of your own shortcuts. macOS
  only sends media keys to apps allowed under System Settings → Privacy & Security →
  Accessibility, and the app offers a button that asks for it.

Closing the window asks whether to minimize to the tray or quit. Minimizing leaves the
reader running: the app sits in the tray (menu bar on macOS), which has pause, skip,
clear and quit. Reading also keeps its normal speed while the window is hidden or
behind a game.

### Building it yourself

```bash
cd desktop
npm install
npm start      # run it from the checkout
npm run dist   # build for the system you're on, into desktop/dist/
```

`npm start` copies the page into `desktop/web/` for packaging but then loads the files
in the project root, so ⌘R / Ctrl+R picks up your edits. `npm run icons` re-renders
`desktop/build/icon.png` from `favicon.svg` if you change the icon.

### Releasing

`.github/workflows/desktop.yml` builds macOS and Windows and attaches the binaries to
a GitHub release when a tag starting with `v` is pushed. Set the version in
`desktop/package.json` first — the file names come from it:

```bash
git tag v1.0.0
git push origin v1.0.0
```

The same workflow builds (without publishing) on pull requests that touch the app, and
can be started by hand from the Actions tab.

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
- The ⏯ media-key option works most reliably in Chrome and Edge. The desktop app registers it with the OS instead, so it doesn't depend on the browser.
- If a shortcut clashes with your browser, rebind it under *Settings → Keys*. Some browsers use Alt+letter shortcuts for their own menus on Windows.

## Features

- **Any channel:** type a name or paste a `twitch.tv/...` link. It reconnects automatically if the connection drops.
- **Replies:** read as *"Alice, replying to Bob: …"*. You can optionally include the message being replied to.
- **Pause on a message:** press **Alt+P** (⌥P on Mac) or the big button. Reading stops mid-message and new messages keep queueing. Pressing it again continues that same message.
  - Neural voices resume at the exact point.
  - System voices resume from the last word spoken, or from the start of the sentence if the voice doesn't report word positions.
- **Skip:** Alt+S. You can remove waiting messages with ×. Both shortcuts can be rebound under *Settings → Keys*.
- **Media key:** turn on *Use the keyboard's ⏯ media key* to pause and resume while a game or another app is focused. Normal shortcuts only work while the tab is focused, which is a browser limitation — the [desktop app](#desktop-app) has no such limit and makes every shortcut work from any app.
- **Volume and speed:** with neural voices, volume changes apply instantly.
- **Multiple voices:** each chatter gets a consistent voice from the pool, with a slight per-chatter pitch and pace variation. Click the voice tag on a message to give that chatter a different voice.
- **Nicknames:** map a Twitch username to the name you want spoken. It applies to their messages, to replies to them, to @mentions and to their sub/raid events. Click a name in chat to add one quickly.
- **Moderation aware:** messages deleted by mods, and messages from banned or timed-out users, are removed from the queue.
- **Filters:** skip `!commands`, links and specific chatters. You can also cap message length and skip old messages when chat is too fast.
- **Cleanup:** emojis are stripped, links become "link", and spam like `loooooool` or repeated words is shortened.
- **Emotes:** Twitch marks its own emotes in the message, but 7TV, BetterTTV and FrankerFaceZ ones arrive as ordinary words, so the channel's emote names are fetched from those three services when you connect. Under *Reading → Emotes* you can skip everything (the default), skip only Twitch's own emotes and make no third-party requests, or have emote names read out loud.
  - **Messages that are nothing but emotes** are read out by name — `KEKW`, `catJAM` — because staying silent on them makes the reader look broken. Turn off *Still read a message that is nothing but emotes* to skip those instead. Either way, emotes inside a sentence are still taken out, so `Kappa that was close` reads as "that was close".
  - Channel emote sets contain names that are also everyday words (`Chat`, `Stare`, `Timer`). Those are never taken out of a sentence: a name that could be a word someone typed is only dropped when the whole message is emotes.
- **Viewer interactions:** bits, channel point rewards and chat commands can change how chat is read — viewers can pick their own voice, put a chipmunk or robot effect on a message, or skip the line, and mods can pause or skip from chat. See [Viewer interactions](#viewer-interactions).
- **Readable at any size:** a light, dark or system theme, a stronger-contrast mode, and a *size of everything* setting that scales the whole page up to 200% without a sideways scrollbar. See [Accessibility](#accessibility).
- **Backup:** save every setting to a file and load it back, on this computer or another one. See [Your settings](#your-settings).

## YouTube and TikTok

Desktop app only. Twitch's field is always there; press **+** next to it to add a
YouTube or TikTok field, fill in what you want and press *Connect*. Messages from every
chat go into the same queue and are read in the order they arrive, each with a small
tag saying where it came from. The × on a field takes that chat away again.

| Field | What it takes |
|---|---|
| YouTube | `@handle`, a channel link, a channel id (`UC…`), or a link to the stream itself (`watch?v=…`, `youtu.be/…`, `/live/…`) |
| TikTok | `@username` or a `tiktok.com/@username` link |

- **Before you go live:** a channel or username that isn't live yet is fine. The field
  waits, checking every 30 seconds, and starts reading when the stream starts. It goes
  back to waiting when the stream ends. A link to one particular YouTube stream stops
  when that stream ends.
- **Each field has its own dot:** green while reading, blinking while connecting or
  waiting, red when something is wrong. Hover over the field for the details. The status
  line names every chat being read.
- **Changing one chat leaves the others alone:** after editing a field the button says
  *Connect* again and only reconnects what changed. When nothing has changed, it says
  *Disconnect* and stops them all.
- **YouTube:** Super Chats and Super Stickers are read as *"Alice sent a Super Chat of
  $5.00: …"*, and never skipped to catch up. New members and gifted memberships are
  events, like Twitch subs. Channel emotes are handled like Twitch emotes. Messages a
  moderator removes, and everything from someone who is timed out or banned, come out of
  the queue.
- **TikTok:** gifts are events, *"Alice sent 5 Roses"*, said once at the end of a
  streak. Deleted comments come out of the queue.
- **Nicknames, voices and ignoring** work the same way: click a name in chat. A YouTube
  or TikTok chatter is kept apart from a Twitch chatter with the same name.
- **Chat commands** (`!voice`, `!tts`) work from every chat. YouTube and TikTok
  moderators count as mods, members and TikTok subscribers as subscribers. Bits and
  channel points are Twitch-only.

How it works: neither site lets a web page read its chat (they send no CORS headers), so
the app's main process reads them and hands each message to the page.
- **YouTube** is read the same way youtube.com's own chat pop-out reads it. No API key,
  sign-in or quota.
- **TikTok** has no public chat API. The app uses
  [tiktok-live-connector](https://github.com/zerodytrash/TikTok-Live-Connector), which
  connects through Euler Stream's free signing service. It is unofficial, so it can break
  when TikTok changes something, and a busy sign server shows up as *"retrying in …"*.

## Viewer interactions

Under *Settings → Viewers*. The page reads chat without logging in, so it can only
react to what Twitch puts in chat, and it can't reply there: viewers hear the result
instead.

**Bits**

| Setting | What it does |
|---|---|
| Say who cheered and how many bits | *"Alice cheered 500 bits: …"*. A cheer with no message is still read |
| Cheers of at least *N* bits are read before everything else | They go to the front of the queue, behind earlier cheers that also did |
| Cheers of at least *N* bits can pick a voice effect | The first word after the cheer picks it: `Cheer200 robot hello chat` |

Cheermotes (`Cheer100`, `Kappa50`) are never read out. Messages that cost bits or
channel points are never dropped by *Skip old messages*.

**Voice effects:** chipmunk, giant, robot and echo. Neural voices play them through
Web Audio. System voices can only change pitch and pace, so chipmunk and giant still
work, robot is a lower pitch, and echo does nothing.

**Channel points.** Twitch only shows a redemption in chat when the reward has
*Require Viewer to Enter Text* turned on, so only those rewards can be used. Twitch
doesn't send the reward's title, so a reward is linked by redeeming it once:

1. Create the reward on Twitch, with *Require Viewer to Enter Text* on.
2. Under *Channel points*, pick what it should do and press *Link the next redemption*.
3. Redeem it on your channel. The page links that reward, and you can give it a name.

A linked reward can let the viewer pick their voice (they type the voice name), read
the message before everything else, or read it with one of the effects. *Highlight
My Message* redemptions can also jump the queue.

**Chat commands.** Both command words can be changed, and set to *Nobody* if another
bot already uses them.

| Command | Who (default) | What it does |
|---|---|---|
| `!voice Bella` | Everyone | Picks a voice from your voice pool by name. On its own, moves to the next one. Kept like clicking a voice tag, and announced as *"… now sounds like this"* in the new voice (at most every 15 seconds per chatter) |
| `!tts skip`, `pause`, `resume`, `clear` | Mods | Same as the buttons |
| `!tts volume 40`, `volume +10`, `speed 1.2` | Mods | Sets the volume (0–100) or speed (0.6–2), absolute or relative |

The broadcaster can use both. A command that did something isn't read out; the feed
shows what it did in place of the status.

## Accessibility

The page is meant to be usable with a screen reader, with the keyboard alone, or
simply made bigger. Under *Settings → Display*:

| Setting | What it does |
|---|---|
| Theme | Light, dark, or whatever the system asks for (the default) |
| Size of everything | Scales the page: 100%, 115%, 130%, 150%, 175% or 200% |
| Stronger contrast | Black-on-white or white-on-black text, thicker borders and focus rings, and no dimming of messages that have been read. Chatters' own name colours, which are often unreadable, are dropped |
| Stop animations | Also happens on its own when the system asks for less motion |
| Say what happened | Short screen-reader notices when reading pauses, resumes, skips, the queue is cleared or the volume changes — the things a hotkey can do while you're looking at something else |

New chat messages are deliberately *not* announced: they are read out loud
anyway, and a live region would say everything twice.

Beyond those settings:

- Links at the top of the page jump straight to the player or the chat. The
  *Settings* button opens a dialog with one tab per section; the arrow keys move
  between tabs and Esc closes it.
- The window fits without scrolling: only the chat scrolls, inside its own panel.
  The line under the player shows which voices are in use and how far the neural
  model has loaded; click it to open the voice settings.
- Everything can be reached with Tab and has a visible focus ring. Every
  icon-sized button — the voice tag, ▶, × — says what it does and to whom.
- All of it keeps working with the browser's own zoom, and nothing depends on
  colour alone.

## Your settings

Settings live in this browser's local storage, per site: they are not synced,
and clearing site data clears them. Under *Backup*:

- **Save settings to a file…** writes `chat-reader-settings-<date>.json` — voices,
  reading options, filters, nicknames, viewer interactions and linked rewards,
  shortcuts and the display settings above.
  The desktop app opens a normal save dialog (on macOS also from the Settings menu,
  ⌘S); a browser downloads the file.
- **Load settings from a file…** reads one back. Every value is checked before it
  is used, anything unrecognisable is left alone, and the page updates without a
  reload. A file from an older version is fine: the settings it doesn't mention
  keep their current values.
- **Reset everything to defaults** clears the lot after asking first.

Voice names differ between computers, so a system voice that doesn't exist on the
machine you load the file on is quietly dropped from the pool; neural voices are
the same everywhere.

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
- `js/sources.js`: the page's side of YouTube and TikTok chat: reading the fields, and messages from the desktop app
- `js/emotes.js`: 7TV, BetterTTV and FrankerFaceZ emote names for the connected channel
- `js/speech-text.js`: turns chat messages into natural spoken sentences
- `js/engines.js`: the neural and system speech engines, both supporting pause and resume
- `js/kokoro-worker.js`: runs the neural voice model in the background
- `Caddyfile`: server config with a CSP that allows the neural voices
- `js/app.js`: queue, pause logic, settings, keybindings
- `desktop/`: the Electron shell — window, tray, global hotkeys (`main.js`, `accelerator.js`, `preload.js`) and the packaging config
- `desktop/sources/`: YouTube (`youtube.js`) and TikTok (`tiktok.js`) chat, read in the app's main process
- `.github/workflows/desktop.yml`: builds the desktop binaries and publishes them on a `v*` tag
