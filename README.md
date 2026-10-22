# Chat Reader: Twitch TTS

Reads Twitch chat out loud in the browser, from one channel or several at once. No login,
no install, no server-side code. The [desktop app](#desktop-app) can also read YouTube and
TikTok live chat, in the same queue: see [Several chats at once](#several-chats-at-once).
It also has a [Twitch bot](#bot-desktop-app) — commands, alerts, timers, points, games,
moderation, an OBS overlay — so it can be the only Twitch app you need. The website stays a
reader only.

## Run it

Serve the folder with any static web server. Opening `index.html` straight from disk isn't recommended, because browsers restrict workers and caching on `file://` pages.

```bash
cd /path/to/Tts && python3 -m http.server 8765
```

Then open http://localhost:8765. You can also put the folder on any static host, such as GitHub Pages or Netlify, and use it from any computer.

Add `?channel=name` to the URL to put a Twitch channel in the top bar, e.g. `http://localhost:8765/?channel=shroud`.

Chrome or Edge is recommended. Neural voices need HTTPS, or `localhost`.

## Desktop app

The desktop app is this same page in a small Electron shell, with three things a
browser can't do: the shortcuts are registered with the operating system, so they
work while a game, Discord or anything else is focused; it can read
[YouTube and TikTok](#youtube-and-tiktok) chat as well as Twitch; and it has a
[bot](#bot-desktop-app) for your own channel.

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
| Replay (press again to go further back) | `Alt+R` (`⌥R`) |
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
- *Use the keyboard's media keys* adds ⏯, ⏭ and ⏮ (replay) on top of your own shortcuts. macOS
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

## Bot (desktop app)

Desktop app only. It does what [Firebot](https://firebot.app) does, in the same window as
the reader: chat commands, alerts for follows, subs, cheers, raids and redemptions, timers,
loyalty points, games, moderation, an OBS overlay, hotkeys and a Stream Deck API.
Everything runs on your computer; nothing goes through a server of ours.

In the desktop app the window has its sections down the side, grouped by what they're for
rather than by which half of the app they belong to:

| Group | Sections |
|---|---|
| | **Dashboard**: the player and chat, with the stream next to them |
| Reader | Voices, Reading, Nicknames, Filters, Viewer controls (the website's Settings, as pages) |
| Bot | Commands, Events, Rewards, Timers, Effect lists, Counters |
| Community | Viewers, Points & games, Quotes, Moderation |
| Stream | Multistream, Overlay, OBS |
| App | Accounts, Shortcuts & API (the reader's keys and the bot's hotkeys), Display, Backup & import |

A dot next to a section shows when something there needs you: logged out, OBS not
connected, the overlay's port taken. The website is unchanged: just the reader, with its
Settings dialog.

### Setting it up

The first time the app opens, a setup guide walks through these steps one at a time (plus
the chats to read, the voice, OBS's WebSocket, the shortcuts and a few starter alerts).
Every step can be skipped. Run it again from *Accounts → Run the setup guide*, or on macOS
from *Settings → Setup guide…*.

1. **Make a Twitch application** (once, free): on
   [dev.twitch.tv/console/apps/create](https://dev.twitch.tv/console/apps/create) give it any
   name, `http://localhost` as the OAuth Redirect URL, category *Chat Bot* and Client Type
   **Public**. Copy its Client ID into *Accounts*.
2. **Log in**: press *Log in to Twitch*, open twitch.tv/activate and type the code shown.
   No password goes through the app, and the login is kept encrypted by the system keychain
   and renewed on its own.
3. **Optionally log in a bot account** (a second Twitch account such as *YourNameBot*), so
   replies come from it instead of from you. Open the activation link in a private window
   logged in as that account.
4. **Add the overlay to OBS**: a Browser source with the URL under *Overlay*
   (`http://127.0.0.1:7473/` by default), 1920 × 1080.

### What's in it

| Section | What it does |
|---|---|
| Dashboard | The reader's player and chat, and beside them: a card per thing that can be on, off or broken (the reader, your chats, Twitch, events, multistream, overlay, OBS), each opening its section; one box to write in chat (as the bot or you, on Twitch or in every multistream chat) or to have the reader say it; run an ad, add a marker, clip, open a raffle, test the overlay, run an effect list; an activity feed where ↻ re-runs an event's effects; the error log; the title and category |
| Commands | Your own commands, with aliases, start-of-message / anywhere / regex triggers, who may use them (roles, custom roles, named users), cooldowns, a points cost and usage counts. Built-in commands that can be renamed, re-permissioned or switched off: `!commands`, `!uptime`, `!followage`, `!watchtime`, `!title`, `!game`, `!so`, `!marker`, `!points` (give / add / remove / set), `!top`, `!quote`, `!permit`, `!raffle` |
| Multistream | Joins your Twitch, YouTube and TikTok chats: see [Multistream](#multistream) |
| Events | Effects for follows, subs, resubs, gifted subs, cheers, raids, channel point redemptions, hype trains, polls, predictions, ad breaks, shoutouts, bans, going live and offline, title changes, charity donations, chat messages, a viewer's first message ever or this stream, YouTube Super Chats and memberships, TikTok gifts, and OBS scene and stream changes. Each can be filtered (*bits is at least 100*) and simulated |
| Rewards | Your channel point rewards: create, change, pause and delete them, give each its own effects, and have redemptions completed or refunded automatically |
| Timers | Effects every N minutes, only after enough chat, optionally only while live |
| Effect lists | Reusable effects with arguments, run from anywhere |
| Counters | Counters with min / max, shown on stream as an overlay or written to a text file; custom variables |
| Viewers | Everyone who chatted or watched, with messages, watch time and points; search, edit, export to CSV; custom roles |
| Points & games | Points for watching, with a sub bonus; slots, gamble, heist and raffles |
| Quotes | Numbered quotes, from chat or added here |
| Moderation | Banned words and regex, links (with `!permit`), caps, symbols, emotes, length and repeats; delete, warn and time out, stricter with repeat offenders |
| Overlay | The OBS browser source; its style (font, colours, text shadow, boxes, size) and custom CSS, sent live to open overlays; instances with their own style; link builders with live previews for the combined chat and counter widgets |
| OBS | Connects to OBS's WebSocket server (Tools → WebSocket Server Settings) |
| Accounts | Logins, who replies, the sound output device |
| Shortcuts & API | The reader's shortcuts, global hotkeys that run effects, and an HTTP API for Stream Deck and the like |
| Backup & import | One file with the reader and the whole bot, and importing from Firebot and Mix It Up |

**Effects.** Chat message, announcement, speak with TTS (any voice, read before waiting
chat), control the reader, change how a chatter is read (their voice, nickname, or
ignoring them), play a sound (on any output device, or in the overlay), overlay
alert / picture or video / text / clear, wait, if-then-else, random effect, run an effect
list, stop, counter, variable, points, time out / ban / unban / delete / VIP / clear chat,
shoutout, title and category, ad break, marker, clip, poll, prediction, raid, channel point
reward, turn a command, event or timer on or off, raffle, activity note, desktop
notification, HTTP request, Discord webhook, write to a text file, and OBS (scenes,
sources, filters, mute, stream, recording, replay buffer). Every effect can be tried on its
own with ▶.

**Variables.** Text in effects can use `$variables`, in Firebot's style: `$user`,
`$target`, `$arg[1]`, `$count`, `$bits`, `$message`, `$counter[deaths]`, `$var[name]`,
`$currency`, `$followAge`, `$uptime`, `$game`, `$randomNumber[1,6]`, `$pick[a,b]`,
`$math[$bits / 100]`, `$if[$bits >= 100,big,small]`, `$effectOutput[http]`, the reader's
`$ttsVoice`, `$nickname`, `$ttsVoices`, `$ttsWaiting` and `$ttsPaused`, and more. The
**$** button next to a text field lists them all, with what each event brings along.

**The reader and the bot together.**

- **A click on a name in chat** opens the chatter's card: their nickname and voice as
  before, and now also their points (give or take some), watch time, messages, bits and
  role, with Shoutout, Time out, Ban and Unban for Twitch chatters. *Viewers* has a
  *Card* button per viewer and shows the nickname and voice the reader uses for each.
- **`!voice` and `!tts` get an answer in chat** (*@alice your TTS voice is now Bella*, or
  the voices to choose from), which the website can't do. It's switched under *Viewer
  controls*.
- **Rewards by name**: *Viewer controls* lists your channel point rewards so you pick what
  each does for the reader, instead of redeeming each one to link it. For a reward without
  text, give it effects under *Rewards*: *Change how a chatter is read* and *Speak with TTS*
  work for any reward.
- **Stream events in the chat list**: follows, redemptions, polls, predictions, hype trains,
  ad breaks and the bot's own notes show up between the messages, without being read out.
- The reader doesn't read the bot's own replies, nor commands meant for the bot in your
  channel (both can be switched under *Accounts*). Commands also work from YouTube and
  TikTok chat; the replies go to Twitch chat.

**Stream Deck.** Use the *Website* action with *Access in background* and the link from
*Effect lists → Copy API link*: `http://127.0.0.1:7473/api/run/<list>?key=…`. Add
`&arg=…` to hand over `$listArg[1]`.

**Where it's kept.** The setup and the viewer list are JSON files in the app's data folder
(`bot/` under `~/Library/Application Support/Chat Reader` on macOS,
`%APPDATA%\Chat Reader` on Windows). One backup file holds everything — the reader's
settings and the whole bot, saved under *Backup & import* (the viewer list can be left
out). The logins (Twitch, Google, TikTok, OBS) are kept apart, encrypted by the system
keychain, and never go into a backup.

### Multistream

For streaming on Twitch, YouTube and TikTok at the same time. *Multistream* joins
the three chats: every message written on one is posted on the other two, after a prefix
you choose, so viewers everywhere see the whole conversation.

- **The prefix** is any text with `$variables`: the default `[$platform] $user: ` posts
  *[YouTube] Alice: hello*. Put `$message` in it to place the message somewhere other
  than the end. The platform names can be changed (*YT*, *TT*…).
- **Reading**: Twitch over your login; YouTube and TikTok from the same connections the
  reader uses — the top bar's, when it reads the same channel, or the relay's own. A channel
  that isn't live yet is waited for.
- **Posting on Twitch**: as the bot account (make it a mod so Twitch lets it post quickly),
  or as you.
- **Posting on YouTube**: through the YouTube Data API, signed in with Google as yourself or
  as a second account for a bot. It needs a free Google Cloud project with an OAuth client
  of type *Desktop app*; the tab walks through it. Each post costs 20 of the 10,000 quota
  units a project gets a day, so messages written close together go out as one post (every
  8 seconds by default, up to YouTube's 200 characters), and the tab shows what's left.
- **Posting on TikTok (experimental)**: TikTok has no way for apps to post in a LIVE chat.
  It goes through Euler Stream, the service already used to read TikTok chat, which needs an
  Euler Stream API key that may post (a paid plan there) and your TikTok session cookies —
  and both are sent to Euler Stream. A second TikTok account is safer.
- **Never in a loop**: the relay recognises its own posts when they come back in and skips
  them, as does the reader. `!commands` and other bots (Nightbot, StreamElements…) aren't
  relayed. Subs, cheers, raids, Super Chats, memberships and gifts can be relayed as one line.
- **On stream**: a combined chat overlay shows the three chats together, each message
  tagged with its platform — `http://127.0.0.1:7473/?chat`, with `&max=`, `&fade=`, `&size=`,
  `&badges=0` and `&platforms=youtube,tiktok`. Handy for a vertical TikTok layout.

The video itself goes out from OBS: with the *Multiple RTMP outputs* plugin (one output
per platform) or a restream service, and the *Aitum Vertical* plugin for TikTok's vertical
format.

### Importing from Firebot and Mix It Up

*Backup & import → Import from another bot* brings over commands (with subcommands),
events and their filters, channel point reward effects, timers, effect lists, hotkeys,
counters, custom roles, quotes, the points settings and every viewer with their watch time
and points. You see what was found and choose what to take before anything is added;
nothing that's already here is replaced, and importing twice doesn't double anything.

| From | Pick |
|---|---|
| Firebot | Its profile folder: `%APPDATA%\Firebot\v5\profiles` on Windows, `~/Library/Application Support/Firebot/v5/profiles` on macOS (the most recently used profile is taken), or a `.firebotsetup` file |
| Mix It Up | A backup (*Settings → Advanced → Backup Settings* in Mix It Up, a `.miubackup`), its settings database, or exported `.miucommand` files |

Firebot's `$variables` are almost all the same as here and are carried over; Mix It Up's
special identifiers (`$username`, `$arg1text`, `$targetusername`…) are translated. An effect
with no equal here — a Firebot plugin, a Mix It Up external program — becomes a
*From another bot (not converted)* placeholder that says what it was, so nothing goes
missing silently. Mix It Up's file format isn't documented and its source is no longer
public, so its importer works from the shape of the data and is best effort.

**Not included, on purpose:** Firebot's custom scripts (running code from files), whispers
(Twitch restricts them heavily), and integrations with paid services.

## Screen reader (desktop app)

Ordinary screen readers and magnifiers follow the mouse. In a game like Cyberpunk 2077
the mouse is locked in the middle of the screen, so they read and magnify the same
spot forever. The desktop app's screen reader never looks at the mouse. It has three
ways in, all under *Accessibility → Screen reader*:

- **Reading zones.** Boxes on the screen, drawn once per game (a *profile*). Each
  is watched, and its text is read out loud when it changes, in a voice of its
  own: subtitles in one voice, the objective in another, the menu in a third.
  What a zone reads:

  | Mode | For | Reads |
  |---|---|---|
  | When it changes | Subtitles, dialogue, objectives | The whole text, once, when it's new. Text typed out a letter at a time is read once it settles, and only the new part |
  | New lines | Logs, notifications, game chat | Only lines that weren't there before |
  | Highlighted line | Menus, dialogue choices | The line that stands out by colour or brightness, each time it moves |
  | When I ask | Anything | Only with its number key or *Read now* |

  A zone can *leave out* words, or *only read* text that matches: a word such as
  your name, or a regular expression (`/whispers:/i`). A zone over a game's chat
  can then read only the messages that mention you. The zone editor has
  ready-made rules (whispers, party, raid and guild chat in WoW, questions), a
  box to try a line against them, and a link to [regex101.com](https://regex101.com/)
  for building your own.

  Each profile can be given the programs it's for (e.g. `eldenring.exe`, picked
  from the open programs or typed in). When one of them comes to the front, its
  profile is used by itself and its name is said; any other program, like chat
  or Discord, leaves the profile as it is.

- **Reading cursor.** Hotkeys that work inside the game. `Ctrl+Alt+C` (`⌃⌥C`)
  reads the text nearest the middle of the screen, where the crosshair is: the
  game's equivalent of hovering. `Ctrl+Alt+↓`/`↑` step through the lines on
  screen, `Ctrl+Alt+←`/`→` jump to the nearest text to the side (for menus laid
  out in columns), `Ctrl+Alt+S` reads the whole screen and `Ctrl+Alt+X` stops.
  While the cursor is in use the screen is read again in the background, so each
  step answers straight away.
- **Lens.** A magnifier window in a corner of any screen, or filling a second
  screen. It follows what's being read, the middle of the screen or one zone,
  zooms out just enough to fit a whole line, can recolour (inverted, grey,
  yellow on black) and writes the text under the picture in large letters.

Zones are drawn on top of the game (`Ctrl+Alt+E`, or *Draw zones on screen*) with
the mouse or entirely by keyboard: `N` for a new box, arrows to move it, `Alt` +
arrows to resize, `Tab` to the next one, `W` says where it is, `Enter` saves. Or
start from a template (subtitles, dialogue choices, objective…), or type in where a
zone goes. `Ctrl+Alt+1`…`9` read zone 1…9 on request. Every key can be changed.

- Text is recognised by the system itself: Apple Vision on macOS, Windows OCR on
  Windows 10 and 11. Nothing is sent anywhere.
- Chat pauses while screen text is read and carries on where it stopped.
- The lens, the outlines and the editor are hidden from screen capture, so they're
  never read, magnified or streamed.
- macOS has to allow Chat Reader under *Privacy & Security → Screen Recording*.
  Games need borderless or windowed full screen: exclusive full screen hides the
  game from capture and covers the lens.

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

- **Any channel, or several:** type a name or paste a `twitch.tv/...` link, and press **+** to read more channels at the same time. Each one reconnects automatically if its connection drops. See [Several chats at once](#several-chats-at-once).
- **Presets:** save the chats you read as a named preset and switch between streamers in one click.
- **Replies:** read as *"Alice, replying to Bob: …"*. You can optionally include the message being replied to.
- **Pause on a message:** press **Alt+P** (⌥P on Mac) or the big button. Reading stops mid-message and new messages keep queueing. Pressing it again continues that same message.
  - Neural voices resume at the exact point.
  - System voices resume from the last word spoken, or from the start of the sentence if the voice doesn't report word positions.
- **Replay:** press **Alt+R** (⌥R) or *↻ Replay* to hear the last message again. Each press goes one message further back, then reading carries on in order up to where it was, so three quick presses replay the last three messages. While a replay runs:
  - The player turns teal and says *Replaying 2 of 3*, with a *Stop replay* link. In chat, the message being replayed is highlighted and the ones still to come have a dashed edge.
  - New messages wait. A message that was being read when you pressed it goes back to the front of the queue and is read in full afterwards.
  - Replays always say who wrote the message, and play even while reading is paused. Reading pauses again once the replay is over.
  - The ↻ next to a read message replays just that one. Messages removed by a mod are never replayed.

  Under *Settings → Reading → Replay* you can turn it off, which also frees the key for other apps. You can also change what is said when a replay starts (*"Replaying."*) and ends (*"Back to live chat."*), or have nothing said.
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

## Several chats at once

Each field in the top bar is one chat. Press **+** to add another: in a browser that's
another Twitch channel, and in the desktop app you choose Twitch, YouTube or TikTok. Any
mix works, up to 12: two Twitch channels and a TikTok live, or five Twitch channels and two
YouTube streams. Fill them in and press *Connect*. Every message goes into the same queue
and is read in the order it arrives. The × on a field removes that chat.

- **Where a message came from:** with more than one chat, each message carries a tag. The
  tag names the platform, plus the channel when a platform has more than one chat:
  *TWITCH #shroud*, *YOUTUBE*.
- **Each field has its own dot:** green while reading, blinking while connecting or
  waiting, red when something is wrong. Hover over the field for the details. The status
  line names every chat being read.
- **Changing one chat leaves the others alone:** after editing a field the button says
  *Connect* again and only reconnects what changed. When nothing has changed, it says
  *Disconnect* and stops them all.
- **Moderation stays per chat:** a timeout or a cleared chat on one channel only takes
  that channel's messages out of the queue.
- **Names:** a chatter keeps the same voice and nickname in every Twitch channel. Back-to-back
  messages only drop the name when they come from the same chat.

### Presets

A preset is a saved set of chats, for switching between streamers. Open **Presets** next
to the title:

- **Save:** type a name and press *Save* to keep the chats that are in the top bar now.
  Saving under an existing name updates that preset.
- **Switch:** click a preset. The top bar takes its chats and connects them. Chats in both
  the old and new set keep running without reconnecting, and the others stop. Messages
  already waiting stay in the queue (*Clear queue* drops them).
- **Delete:** the × next to a preset.

The button shows the preset's name while the top bar matches it. Presets are saved with
the rest of the settings, backups included. A preset with YouTube or TikTok chats still
opens in a browser, but those fields say they need the desktop app.

### YouTube and TikTok

Desktop app only.

| Field | What it takes |
|---|---|
| YouTube | `@handle`, a channel link, a channel id (`UC…`), or a link to the stream itself (`watch?v=…`, `youtu.be/…`, `/live/…`) |
| TikTok | `@username` or a `tiktok.com/@username` link |

- **Before you go live:** a channel or username that isn't live yet is fine. The field
  waits, checking every 30 seconds, and starts reading when the stream starts. It goes
  back to waiting when the stream ends. A link to one particular YouTube stream stops
  when that stream ends.
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
  the chats in the top bar and your presets,
  shortcuts and the display settings above. In the desktop app the same file also holds
  the [bot](#bot-desktop-app), and loading it asks before replacing the bot's setup.
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
- `desktop/bot-main.js`: the bot's main-process side — its files, the encrypted logins, the overlay and API server, HTTP requests
- `desktop/multistream-main.js`: signing in to YouTube with Google, and posting to TikTok, for the multistream relay
- `desktop/import-main.js`: reading Firebot and Mix It Up data (JSON, NeDB, SQLite, zip backups) for the importer
- `desktop/bot/`: the bot itself, loaded into the page by the desktop app only — Twitch login and API (`twitch.js`), EventSub (`eventsub.js`), `$variables` (`variables.js`), effects (`effects.js`), commands, events and timers (`triggers.js`), viewers, points, games and moderation (`community.js`), OBS (`obs.js`), the multistream relay (`relay.js`), importing from other bots (`importers.js`), the controls and tabs (`ui.js`, `ui-tabs.js`, `ui-multistream.js`), the Dashboard's side column (`dashboard.js`), where the reader and the bot meet (`integrations.js`) and the window's sections (`shell.js`)
- `desktop/overlay/`: the OBS overlay page
- `desktop/screen-main.js`, `desktop/screen/`: the screen reader's main-process side — screen capture without a picker, the text recognition helpers (`ocr-mac.js` for Apple Vision, `ocr-win.ps1` for Windows OCR), the helpers that notice which program is in front (`apps-mac.js`, `apps-win.ps1`), and the windows over the game: the zone editor and outlines (`overlay.*`) and the lens (`lens.*`); `desktop/bot/screen.js` and `ui-screen.js` are its page side
- `docs/bot-plan.md`: how the bot is put together, and why
- `.github/workflows/desktop.yml`: builds the desktop binaries and publishes them on a `v*` tag
