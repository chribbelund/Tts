# Bot: Firebot's features in the desktop app

The goal is that the desktop app is the only Twitch tool a streamer needs: it
keeps reading chat out loud, and also does what Firebot does — commands, event
alerts, timers, loyalty points, games, moderation, an OBS overlay and hotkeys.

**The website doesn't change.** It stays a pure TTS reader with no login. All bot
code lives under `desktop/` and is only loaded when the page runs inside the
Electron shell (`window.chatReaderDesktop.bot` exists). `index.html`,
`style.css` and `js/` gain nothing but a few no-op hooks.

## Why the desktop app can do this and the page couldn't

| Needs | How |
|---|---|
| Logging in to Twitch | OAuth *device code flow* with the streamer's own Client ID (a "Public" app from dev.twitch.tv). No redirect URL or secret is needed, and it gives refresh tokens. `id.twitch.tv` and Helix both answer with CORS, so the page makes the calls itself. |
| Keeping tokens safe | Electron `safeStorage` (Keychain / DPAPI) in the main process. |
| Events (follows, subs, raids, points…) | EventSub over WebSocket (`wss://eventsub.wss.twitch.tv/ws`). |
| Saving a viewer database | JSON files under the app's user data folder, written by the main process. |
| An OBS overlay | A small HTTP server in the main process on `127.0.0.1:7473`, pushing events to the overlay page over Server-Sent Events. |
| HTTP requests, Discord webhooks, writing text files for OBS | Done by the main process, which has no CORS limits. |
| Hotkeys while gaming | The existing global-shortcut code, extended with the bot's own hotkeys. |
| Stream Deck and other tools | `POST /api/run/<id>?key=…` on the overlay server runs an effect list. |

## Architecture

```
desktop/
  main.js            requires bot-main.js
  bot-main.js        store, secrets, overlay + API server, HTTP, files, notifications (IPC)
  multistream-main.js  Google sign-in for YouTube, posting to TikTok
  import-main.js     reads Firebot / Mix It Up files, NeDB, SQLite and zip backups
  preload.js         exposes chatReaderDesktop.bot
  bot/               loaded into the page by app.js, desktop only
    bot.css
    core.js          state, persistence, logging, event bus
    twitch.js        device-flow auth, token refresh, Helix wrapper
    eventsub.js      EventSub WebSocket session and subscriptions
    variables.js     $variables: $user, $arg[1], $counter[deaths], $math[…], …
    effects.js       effect types and the runner (queues, stop, outputs)
    triggers.js      commands, system commands, events, timers, hotkeys, rewards
    community.js     viewers, watch time, currency, quotes, games, moderation
    obs.js           obs-websocket v5 client
    relay.js         multistream: joins the Twitch, YouTube and TikTok chats
    importers.js     Firebot and Mix It Up data -> the bot's own
    ui.js            the workspace's building blocks (forms, effect editor, item editor)
    ui-tabs.js       the workspace's tabs
    ui-multistream.js  the Multistream tab
    start.js         start-up: hooks into the reader, logs back in, starts everything
  overlay/           served to OBS as a browser source
    index.html, overlay.js, overlay.css
```

The page's TTS engine stays where it is. The bot uses a small host API that
`js/app.js` exposes (`window.chatReaderHost`): speak a line, pause, skip, clear,
volume, and hooks for remote (YouTube/TikTok) chat and the reader's filters.

## Features (Firebot → here)

**Accounts.** Streamer account (required) and an optional bot account that
chat replies are sent as. Device-code login for each, automatic refresh,
logout.

**Dashboard.** Live status, title and category (editable), viewer count,
uptime, quick actions (ad break, marker, clip, shoutout), a chat box to post as
the bot or the streamer, and an activity feed of every event with a ↻ button to
replay its alert. An error log.

**Commands.** Custom commands with aliases; trigger at the start of a message,
anywhere in it, or by regex; permission by role (everyone, subs, VIPs, mods,
broadcaster) and/or a list of users; global and per-user cooldowns with an
optional cooldown message; a currency cost; usage counts; hidden from
`!commands`; YouTube and TikTok chat can use them too.
**System commands** (each can be renamed, re-permissioned or switched off):
`!commands`, `!uptime`, `!followage`, `!watchtime`, `!title`, `!game`, `!so`,
`!marker`, `!points` (with give/add/remove for mods), `!top`, `!quote`
(add, delete, number, search, random), `!permit`, and the game commands.

**Events.** Every EventSub event that matters — follow, sub, resub, gifted
subs, cheer, raid, channel point redemption, hype train start/end, poll and
prediction start/end, ad break, shoutout received, ban, stream online/offline,
channel update, charity donation — plus chat-based ones: any chat message,
first message ever, first message this stream, viewer arrived. YouTube Super
Chat and memberships and TikTok gifts too. Each event has filters
(field / operator / value) and an effect list. Every event type can be
simulated from the UI.

**Channel rewards.** List the channel's rewards; create, edit, pause,
enable and delete the ones this app manages; attach effects to any reward;
auto-complete or refund redemptions.

**Timers.** Effect lists every N minutes, only after M chat lines, optionally
only while live.

**Effect lists and hotkeys.** Reusable effect lists ("presets") that can take
arguments; global hotkeys that run them; Stream Deck / HTTP API.

**Effects.** Chat message, announcement, speak with TTS (any voice in the
pool), control the reader, play sound (app speakers, any output device, or the
overlay), overlay alert / image / video / text / clear, delay, conditional
(if / else with numeric, text, role and chance checks), random effect, run an
effect list, stop the list, counter, custom variable, currency (one viewer or
everyone watching), timeout / ban / unban / delete message, VIP / unVIP,
shoutout, stream title and category, ad break, marker, clip, poll, prediction,
raid, reward (enable / pause / complete / refund), enable or disable a command,
event or timer, HTTP request (response kept in a variable), Discord webhook,
write to a text file, desktop notification, OBS scene / source / filter /
stream / recording, and a line in the activity feed.

**Variables.** Firebot-style `$name` and `$name[args]`, nestable:
`$user`, `$userId`, `$target`, `$arg[n]`, `$args`, `$count`, `$counter[name]`,
`$var[name]`, `$currency[user]`, `$currencyName`, `$watchTime[user]`,
`$chatMessages[user]`, `$randomNumber[a,b]`, `$randomViewer`, `$pick[a,b,…]`,
`$math[…]`, `$if[a op b,then,else]`, `$upper[…]`, `$lower[…]`, `$urlEncode[…]`,
`$uptime`, `$game`, `$title`, `$viewerCount`, `$followAge[user]`,
`$followCount`, `$accountAge[user]`, `$streamer`, `$bot`, `$date`, `$time`,
`$quote`, `$effectOutput[name]`, and every field of the event that ran it
(`$bits`, `$months`, `$tier`, `$giftCount`, `$viewers`, `$rewardName`,
`$rewardCost`, `$message`, …). The editor lists them.

**Viewers and currency.** A viewer database (first and last seen, messages,
watch minutes, points) that grows from chat and the chatters list. Points per
minute while watching, a bonus for subs, optional accrual while offline. The
table can be searched, edited, and exported to CSV.

**Quotes.** Numbered, with author, game and date; managed from chat or the UI.

**Games.** Slots, heist, coin-flip gamble and raffles (giveaways), all using the
points, with their own messages, odds, payouts and cooldowns.

**Moderation.** Banned words and phrases (and regex), links (with `!permit`),
too many caps, emotes or symbols, too-long messages and repeats. Exempt from a
role up; delete, warn, or time out, escalating on repeat offences.

**OBS.** Overlay browser source with instances, positions, animations,
queued alerts and counters; obs-websocket control.

**Backup.** Save and load the whole bot setup (optionally with the viewer
database) as a file.

**Multistream.** Twitch, YouTube and TikTok chats joined: each message is posted on the
other two after a prefix template (`[$platform] $user: `). Twitch posts through Helix,
YouTube through the YouTube Data API (Google sign-in for desktop apps, with a loopback
redirect and PKCE; 20 quota units a post, so posts are batched), TikTok through Euler
Stream (experimental: a paid API key and the account's session cookies). The relay
recognises its own posts coming back and never relays them again. A combined chat overlay
(`?chat`) shows all three on stream.

**One backup file** for the reader and the bot; logins never go in it.

**Importers.** Firebot (profile folder or `.firebotsetup`; formats taken from its source)
and Mix It Up (`.miubackup` zip, its SQLite database, `.miucommand`; matched by each
object's `$type`, because its source isn't public). Effects without an equal become a
visible placeholder.

## Not done, on purpose

- Firebot's scripting (custom JS plugins): running arbitrary code from a file is a
  security risk for little gain here.
- Twitch extensions, integrations with paid services (Streamlabs, Tipeee…).
- Whispers: Twitch only allows them from accounts with a verified phone, at
  a low rate.

## Order of work

All of it is built; see the README's “Bot (desktop app)” section for how to use it.

1. Main process: store, secrets, overlay/API server, HTTP, files, notifications.
2. Core: persistence, Twitch auth and Helix, EventSub.
3. Variables and the effect runner with every effect type.
4. Commands, events, rewards, timers, hotkeys.
5. Viewers, currency, quotes, games, moderation, OBS.
6. The Bot workspace UI and the overlay page.
7. Hooks in `js/app.js`, packaging (`electron-builder.yml`, CI parse check),
   README, then a run in the real desktop app.
