'use strict';

// The Multistream tab: the three chats joined up (relay.js), the logins it
// needs to post on YouTube and TikTok, and the combined chat overlay.

(() => {
  const h = UI.h;
  const save = () => Bot.save();
  const external = (url) => window.chatReaderDesktop.openExternal(url);
  const ms = () => Bot.data.multistream;
  const R = Bot.relay;

  function statusCard(platform) {
    const name = PLATFORMS[platform].name;
    let reading;
    let readState = '';
    if (platform === 'twitch') {
      reading = Bot.twitch.loggedIn() ? (Bot.eventsub.state === 'connected' ? `Reading #${Bot.twitch.streamerLogin()}` : Bot.eventsub.text || 'Connecting…') : 'Not logged in';
      readState = Bot.eventsub.state === 'connected' ? 'on' : Bot.twitch.loggedIn() ? 'error' : 'off';
    } else {
      const reader = Bot.host.readerChats().find((c) => c.platform === platform && ms()[platform] && String(c.target).toLowerCase() === String((platform === 'youtube' ? normalizeYouTube : normalizeTikTok)(ms()[platform]) || '').toLowerCase());
      const own = R.own[platform];
      if (!ms()[platform].trim()) { reading = 'Not set up'; readState = 'off'; }
      else if (!ms().enabled) { reading = 'Waiting for the relay to be turned on'; readState = 'off'; }
      else if (reader) { reading = `Read by the top bar (${reader.state})`; readState = reader.state === 'connected' ? 'on' : ''; }
      else if (own) { reading = own.text || own.state; readState = own.state === 'connected' ? 'on' : own.state === 'error' ? 'error' : ''; }
      else reading = 'Not connected';
    }
    const st = R.stats[platform];
    const sending = R.canSend(platform);
    const waiting = R.boxes[platform].length;
    return h('div', { class: 'bot-card', 'data-state': readState },
      h('div', { class: 'bot-card-title' }, name),
      h('div', { class: 'bot-card-value' }, reading),
      h('div', { class: 'hint' }, sending
        ? `Posting: ${st.sent} sent${waiting ? `, ${waiting} waiting` : ''}${st.dropped ? `, ${st.dropped} dropped` : ''}`
        : 'Not posting here'),
      st.error ? h('div', { class: 'hint bad' }, st.error) : null);
  }

  // A password-style field whose value is only ever written to the keychain.
  function secretField(label, name, { placeholder = 'Saved', hint = '', onSaved = null } = {}) {
    const box = { v: '' };
    const input = UI.text(box, 'v', { type: 'password', placeholder });
    const status = UI.status();
    Bot.desktop.getSecret(name).then((v) => { input.placeholder = v ? 'Saved — type to replace' : 'Not set'; });
    input.addEventListener('change', async () => {
      await Bot.desktop.setSecret(name, box.v.trim() || null);
      input.value = '';
      input.placeholder = box.v.trim() ? 'Saved — type to replace' : 'Not set';
      UI.say(status, box.v.trim() ? 'Saved in the system keychain.' : 'Removed.');
      box.v = '';
      if (onSaved) onSaved();
    });
    return h('div', { class: 'bot-secret' }, UI.field(label, input, hint), status);
  }

  async function preview() {
    const msg = { platform: 'youtube', user: { login: 'lofilistener', displayName: 'LofiListener', platform: 'youtube', role: 0 }, text: 'hello from YouTube!' };
    const c = ms();
    const ctx = { user: msg.user, fields: { platform: c.labels.youtube || 'YouTube', message: msg.text } };
    const head = await Bot.vars.render(c.prefix || '', ctx);
    return /\$message\b/i.test(c.prefix || '') ? head : `${head}${msg.text}`;
  }

  UI.addTab('multistream', 'Multistream', (panel) => {
    const c = ms();
    const sync = () => { save(); R.sync(); };
    const previewLine = h('p', { class: 'code-box' });
    const showPreview = () => preview().then((t) => { previewLine.textContent = t; });
    const ytStatus = UI.status();
    const testStatus = UI.status();
    const overlayUrl = `${(Bot.overlayStatus && Bot.overlayStatus.url) || `http://127.0.0.1:${Bot.data.overlay.port}/`}?chat&max=12&size=26`;
    const quota = R.quotaToday();

    panel.append(
      UI.lead('Streaming on Twitch, YouTube and TikTok at once? Join the three chats: everything written on one is posted on the other two, after a prefix you choose, so viewers everywhere see the whole conversation. The combined chat can also be shown on stream.'),
      UI.grid(statusCard('twitch'), statusCard('youtube'), statusCard('tiktok')),
      UI.check(c, 'enabled', 'Join the chats', { onChange: () => { sync(); UI.rerender(); } }),

      UI.section('Your channels',
        UI.row(
          h('div', { class: 'field' }, h('span', { class: 'row-label' }, 'Twitch'), h('span', {}, Bot.twitch.loggedIn() ? `#${Bot.twitch.streamerLogin()} (your login)` : 'Log in under Accounts')),
          UI.field('YouTube channel or stream', UI.text(c, 'youtube', { placeholder: '@handle or a link to the stream', onChange: save })),
          UI.field('TikTok username', UI.text(c, 'tiktok', { placeholder: '@username', onChange: save })),
        ),
        h('p', { class: 'hint' }, 'If the top bar already reads the same YouTube or TikTok channel, the relay uses that connection; otherwise it opens its own. Before you go live it waits for the stream to start.')),

      UI.section('How relayed messages look',
        UI.field('Prefix', UI.text(c, 'prefix', { vars: true, extraVars: [['platform', 'Where it was written'], ['message', 'The message (leave it out and it goes at the end)']], onChange: () => { save(); showPreview(); } }),
          'Put before every relayed message. $platform is the name below, $user who wrote it.'),
        h('div', { class: 'field' }, h('span', { class: 'row-label' }, 'Looks like'), previewLine),
        UI.row(
          UI.field('Name for Twitch', UI.text(c.labels, 'twitch', { onChange: () => { save(); showPreview(); } })),
          UI.field('Name for YouTube', UI.text(c.labels, 'youtube', { onChange: () => { save(); showPreview(); } })),
          UI.field('Name for TikTok', UI.text(c.labels, 'tiktok', { onChange: () => { save(); showPreview(); } })),
        ),
        UI.check(c, 'skipCommands', 'Don’t relay !commands', { onChange: save }),
        UI.check(c, 'relayEvents', 'Also relay subs, cheers, raids, Super Chats, memberships and gifts as one short line', { onChange: save }),
        UI.field('Never relay these chatters', UI.text(c, 'ignoreUsers', { onChange: save }), 'Other bots, separated by commas. The relay’s own posts are always recognised and never sent round again.')),

      UI.section('Posting on Twitch',
        UI.check(c, 'sendTwitch', 'Post YouTube and TikTok chat in my Twitch chat', { onChange: save }),
        Bot.twitch.accounts.bot
          ? UI.field('Post as', UI.select(c, 'twitchAs', [['auto', 'Same as the bot’s replies'], ['bot', Bot.twitch.accounts.bot.displayName], ['streamer', 'Me']], { onChange: save }))
          : h('p', { class: 'hint' }, 'Posted as you. Log in a bot account under Accounts to post as the bot instead. Make the bot a mod (/mod name) so Twitch lets it post quickly.')),

      UI.section('Posting on YouTube',
        UI.check(c, 'sendYoutube', 'Post Twitch and TikTok chat in my YouTube chat', { onChange: () => { save(); UI.rerender(); } }),
        h('details', { class: 'fx-more', open: !R.youtube.account ? true : null },
          h('summary', {}, 'Setting up YouTube posting (once)'),
          h('ol', { class: 'bot-steps' },
            h('li', {}, UI.button('Open Google Cloud console', () => external('https://console.cloud.google.com/projectcreate'), { cls: 'link' }), ', make a project, and turn on the ', UI.button('YouTube Data API v3', () => external('https://console.cloud.google.com/apis/library/youtube.googleapis.com'), { cls: 'link' }), '.'),
            h('li', {}, 'Under APIs & Services → OAuth consent screen, choose External, fill in the app name and your e-mail, and add yourself (and your bot’s Google account) as test users. Publishing the app (no review needed for personal use) keeps the sign-in from running out after 7 days.'),
            h('li', {}, 'Under Credentials → Create credentials → OAuth client ID, choose ', h('strong', {}, 'Desktop app'), '. Copy the Client ID and Client secret here.'),
            h('li', {}, 'Sign in with the Google account that should post: your own, or a second one for a bot (it posts as that channel).'))),
        UI.row(
          UI.field('Client ID', UI.text(c, 'youtubeClientId', { placeholder: '….apps.googleusercontent.com', onChange: save })),
          secretField('Client secret', 'youtube-client-secret'),
        ),
        R.youtube.account
          ? h('div', { class: 'bot-account' },
            R.youtube.account.avatar ? h('img', { src: R.youtube.account.avatar, alt: '', width: 40, height: 40 }) : null,
            h('div', {}, h('strong', {}, R.youtube.account.title), h('div', { class: 'hint' }, R.youtube.account.customUrl || 'Posts as this channel')),
            UI.button('Sign out', async () => { await R.youtubeLogout(); UI.rerender(); }))
          : UI.row(UI.button('Sign in with Google', (e) => UI.busy(e.currentTarget, async () => {
            UI.say(ytStatus, 'Finish signing in in your browser…');
            await R.youtubeLogin();
            UI.say(ytStatus, '');
            UI.rerender();
          }, ytStatus), { cls: 'btn small primary' }), UI.button('Cancel', () => Bot.desktop.cancelYoutubeLogin())),
        ytStatus,
        UI.field('Seconds between YouTube posts', UI.number(c, 'youtubeBatch', { min: 2, max: 120, onChange: save }),
          'Messages written in between go out together, up to YouTube’s 200 characters. Each post costs 20 of the 10,000 quota units Google gives a project a day, so at most about 500 posts a day; a longer wait stretches that over a longer stream.'),
        h('div', { class: 'bot-quota' },
          h('span', { class: 'hint' }, `Quota used today: ${quota.toLocaleString()} of ${R.YT_DAILY.toLocaleString()} (about ${Math.max(0, Math.floor((R.YT_DAILY - quota) / R.YT_UNITS.insert))} posts left)`),
          h('progress', { max: R.YT_DAILY, value: Math.min(quota, R.YT_DAILY), 'aria-label': 'YouTube quota used today' }))),

      UI.section('Posting on TikTok (experimental)',
        h('p', { class: 'warn' }, 'TikTok has no way for apps to post in a LIVE chat. This goes through Euler Stream, the service the app already uses to read TikTok chat: it needs an Euler Stream API key that may post (a paid plan there) and your TikTok session cookies, and both are sent to Euler Stream. Use a second TikTok account for this if you can. It may stop working whenever TikTok changes something.'),
        UI.check(c, 'sendTiktok', 'Post Twitch and YouTube chat in my TikTok LIVE chat', { onChange: save }),
        UI.row(
          secretField('Euler Stream API key', 'tiktok-sign-key', { hint: 'From eulerstream.com, under your account’s API keys.' }),
        ),
        tiktokSessionFields(),
        UI.field('Seconds between TikTok posts', UI.number(c, 'tiktokBatch', { min: 2, max: 120, onChange: save }), 'TikTok comments are at most 150 characters; messages in between go out together.')),

      UI.section('Chat on stream',
        UI.check(c, 'overlayChat', 'Show the three chats together in an overlay', { onChange: save }),
        h('p', { class: 'hint' }, 'Add it to OBS as another Browser source. For a vertical TikTok layout, make it narrow and tall. Options: &max= messages shown, &fade= seconds before one disappears, &size= text size in pixels, &badges=0 to hide the platform tags, &platforms=youtube,tiktok to show only some.'),
        UI.row(h('code', { class: 'code-box' }, overlayUrl), UI.copyButton(() => overlayUrl), UI.button('Customize it', () => UI.open('overlay')))),

      UI.section('Try it',
        UI.row(UI.button('Send test messages', () => { R.test(); UI.say(testStatus, 'Sent one made-up message from each platform through the relay. Check your chats and the overlay.'); })),
        testStatus),

      h('details', { class: 'fx-more' }, h('summary', {}, 'Streaming the video to all three'),
        h('p', { class: 'hint' }, 'This app joins the chats; the video itself goes out from OBS. Either add each platform as its own output with the free “Multiple RTMP outputs” plugin (obs-multi-rtmp) — Twitch and YouTube stream keys from their dashboards, TikTok’s server URL and key from TikTok LIVE Producer if your account has LIVE access — or use a restream service. For TikTok’s vertical video, the Aitum Vertical plugin gives OBS a second, vertical canvas.')),
    );
    showPreview();
  }, { listens: ['relay', 'eventsub', 'accounts', 'overlay'], after: 'events' });

  function tiktokSessionFields() {
    const s = { sessionId: '', ttTargetIdc: '' };
    const status = UI.status();
    Bot.desktop.getSecret('tiktok-session').then((v) => { if (v) UI.say(status, 'Session cookies are saved in the system keychain. Type new ones to replace them.'); });
    const saveIt = async () => {
      if (!s.sessionId.trim() || !s.ttTargetIdc.trim()) return;
      await Bot.desktop.setSecret('tiktok-session', JSON.stringify({ sessionId: s.sessionId.trim(), ttTargetIdc: s.ttTargetIdc.trim() }));
      s.sessionId = '';
      s.ttTargetIdc = '';
      for (const input of row.querySelectorAll('input')) input.value = '';
      UI.say(status, 'Saved in the system keychain.');
    };
    const a = UI.text(s, 'sessionId', { type: 'password', placeholder: 'sessionid cookie' });
    const b = UI.text(s, 'ttTargetIdc', { placeholder: 'tt-target-idc cookie, e.g. useast1a' });
    a.addEventListener('change', saveIt);
    b.addEventListener('change', saveIt);
    const row = UI.row(UI.field('sessionid', a), UI.field('tt-target-idc', b),
      UI.button('Forget them', async () => { await Bot.desktop.setSecret('tiktok-session', null); UI.say(status, 'Removed.'); }));
    return h('div', {}, row,
      h('p', { class: 'hint' }, 'Log in to tiktok.com in a browser as the account that should post, open the developer tools (F12) → Application (Storage in Firefox) → Cookies → https://www.tiktok.com, and copy the values of sessionid and tt-target-idc. Logging out of TikTok in that browser ends the session.'),
      status);
  }
})();
