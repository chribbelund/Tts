'use strict';

// Where the reader and the bot meet:
//  - the chatter dialog (a click on a name in chat) shows the viewer's
//    points, watch time and history, with shoutout, timeout and ban buttons;
//  - the reader's own chat commands (!voice, !tts) get an answer in chat,
//    which the website can't give;
//  - follows, redemptions, polls and the bot's own notes show up in the chat
//    list, between the messages, without being read out;
//  - the reader's channel point rewards are picked from the channel's list
//    instead of being redeemed once to link them;
//  - the Dashboard follows the player, the queue and the chats.
// The effects and variables for the reader are in effects.js and variables.js.

(() => {
  const h = UI.h;
  const host = Bot.host;
  const save = () => Bot.save();

  host.onReaderChange = () => Bot.emit('reader');

  // -------------------------------------------------------------------------
  // The chatter dialog
  // -------------------------------------------------------------------------

  const stat = (label, value, valueEl = h('span', { class: 'chatter-stat-value' }, value)) => h('div', { class: 'chatter-stat' }, h('span', { class: 'chatter-stat-label' }, label), valueEl);
  const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);
  const ROLE_NAMES = ['Viewer', 'Subscriber', 'VIP', 'Mod', 'Broadcaster'];

  host.chatterExtra = (entry) => {
    if (!Bot.data || !entry || !entry.login) return null;
    const platform = entry.platform || 'twitch';
    const login = String(entry.login).toLowerCase();
    const v = Bot.viewersDb.byLogin(login, platform);
    const cur = Bot.data.currency;
    const box = h('section', { class: 'chatter-bot bot-scope', 'aria-label': 'From the bot' });
    const status = UI.status();

    const pointsEl = h('span', { class: 'chatter-stat-value' }, Math.floor((v && v.currency) || 0).toLocaleString());
    const stats = v ? [
      cur.enabled ? stat(capital(cur.name), '', pointsEl) : null,
      stat('Watched', v.minutes >= 60 ? `${Math.floor(v.minutes / 60)} h ${Math.round(v.minutes % 60)} min` : `${Math.round(v.minutes || 0)} min`),
      stat('Messages', (v.messages || 0).toLocaleString()),
      stat('First seen', UI.date(v.firstSeen)),
      v.bits ? stat('Bits', v.bits.toLocaleString()) : null,
      v.giftsGiven ? stat('Subs gifted', String(v.giftsGiven)) : null,
      v.role ? stat('Role', ROLE_NAMES[v.role] || '') : null,
    ].filter(Boolean) : [];
    box.append(stats.length ? h('div', { class: 'chatter-stats' }, stats) : h('p', { class: 'hint' }, 'Not in the viewer list yet: they’re added once they chat while the bot is running.'));

    // Points, by hand.
    if (cur.enabled) {
      const amount = { n: 100 };
      const change = (action) => () => {
        const after = Bot.viewersDb.changeCurrency(login, platform, action, Math.abs(Number(amount.n) || 0), { platform, login, displayName: entry.displayName, id: entry.userId || '' });
        if (!after) { UI.say(status, 'Couldn’t change their points.', true); return; }
        pointsEl.textContent = Math.floor(after.currency).toLocaleString();
        UI.say(status, `${entry.displayName} has ${pointsEl.textContent} ${cur.name} now.`);
      };
      const input = UI.number(amount, 'n', { min: 0, max: 1e9 });
      input.setAttribute('aria-label', `How many ${cur.name}`);
      box.append(h('div', { class: 'bot-actions' }, h('span', { class: 'row-label' }, capital(cur.name)), input, UI.button('Give', change('add')), UI.button('Take', change('remove'))));
    }

    // Twitch moderation and a shoutout, for someone in your Twitch chat.
    const me = Bot.twitch.accounts.streamer;
    if (platform === 'twitch' && me && login !== me.login) {
      const run = (label, typeId, fields) => (e) => UI.busy(e.currentTarget, async () => {
        const effect = { ...Bot.effects.newEffect(typeId), username: login, ...fields };
        const ctx = Bot.effects.newContext({ trigger: { type: 'manual', name: label }, args: [login], user: { platform, login, displayName: entry.displayName, id: entry.userId || '' } });
        await Bot.effects.types.get(typeId).run(effect, ctx);
        UI.say(status, `${label}: done.`);
        Bot.addActivity({ kind: typeId === 'moderate' ? 'mod' : 'note', text: `${label}: ${entry.displayName}` });
      }, status);
      const timeout = { seconds: '600' };
      box.append(h('div', { class: 'bot-actions' },
        UI.button('Shoutout', run('Shoutout', 'shoutout', {})),
        h('span', { class: 'bot-inline' },
          UI.select(timeout, 'seconds', [['60', '1 min'], ['600', '10 min'], ['3600', '1 hour'], ['86400', '1 day']], { label: 'Timeout length' }),
          UI.button('Time out', (e) => run('Time out', 'moderate', { action: 'timeout', seconds: timeout.seconds })(e))),
        UI.button('Ban…', (e) => {
          if (!confirm(`Ban ${entry.displayName} from your channel?`)) return;
          run('Ban', 'moderate', { action: 'ban' })(e);
        }, { cls: 'btn small danger' }),
        UI.button('Unban', run('Unban', 'moderate', { action: 'unban' }), { title: 'Also ends a timeout' })));
    }
    box.append(status);
    return box;
  };

  // -------------------------------------------------------------------------
  // Answers to the reader's !voice and !tts
  // -------------------------------------------------------------------------

  const answeredAt = new Map();

  host.onReaderCommand = (entry, { kind, args, result }) => {
    if (!Bot.ready || !Bot.data.answerReaderCommands || !Bot.twitch.loggedIn()) return;
    if ((entry.platform || 'twitch') !== 'twitch' || entry.sourceLabel !== `#${Bot.twitch.streamerLogin()}`) return;
    // One answer per chatter every few seconds, so flipping through voices
    // doesn't fill the chat.
    const last = answeredAt.get(entry.login) || 0;
    if (Date.now() - last < 8000) return;
    answeredAt.set(entry.login, Date.now());
    const who = `@${entry.displayName || entry.login}`;
    let text = '';
    if (kind === 'voice') {
      if (result.startsWith('voice: ')) text = `${who} your TTS voice is now ${result.slice(7)}.`;
      else if (result === 'no such voice') {
        const names = host.voices().filter((v) => v.inPool).map((v) => v.name.replace(/\s*\(.*\)$/, ''));
        text = `${who} there’s no voice called “${String(args).slice(0, 40)}”. Try: ${names.slice(0, 8).join(', ')}${names.length > 8 ? '…' : ''}`;
      }
    } else if (kind === 'mod') {
      text = { skip: 'TTS: skipped.', pause: 'TTS: paused.', resume: 'TTS: reading again.', clear: 'TTS: cleared the waiting messages.' }[result] || `TTS: ${result}.`;
    }
    if (text) Bot.twitch.say(text).catch((err) => Bot.log('error', `Answering ${kind === 'voice' ? 'the voice command' : 'the TTS command'}: ${err.message}`));
  };

  // -------------------------------------------------------------------------
  // Stream events in the chat list
  // -------------------------------------------------------------------------

  // Only what the reader doesn't show on its own: subs, raids and cheers
  // already come in through Twitch chat.
  const FEED_EVENTS = {
    follow: 'Follow', redemption: 'Redeemed', hypeTrainStart: 'Hype train', hypeTrainEnd: 'Hype train', pollStart: 'Poll', pollEnd: 'Poll',
    predictionStart: 'Prediction', predictionEnd: 'Prediction', adBreak: 'Ad break', shoutoutReceived: 'Shoutout', ban: 'Moderation', unban: 'Moderation',
    streamOnline: 'Stream', streamOffline: 'Stream', charityDonation: 'Charity', channelUpdate: 'Stream',
  };

  Bot.on('activity', (a) => {
    if (!Bot.data.ui.feedActivity) return;
    let label = '';
    if (a.kind === 'event') {
      label = FEED_EVENTS[a.type] || '';
      // A redemption with text is already in chat, with the reward's name on it.
      if (a.type === 'redemption' && a.fields && a.fields.message) label = '';
    } else if (a.kind === 'mod') label = 'Moderation';
    else if (a.kind === 'note') label = 'Bot';
    if (!label) return;
    host.feedNote(a.text, { label, tag: a.simulated ? 'test' : '', platform: a.kind === 'event' ? a.platform : '' });
  });

  // -------------------------------------------------------------------------
  // Viewer controls: rewards from the channel's list, and the answers
  // -------------------------------------------------------------------------

  UI.addTab('readerLinks', 'With the bot', (panel) => {
    const me = Bot.twitch.accounts.streamer;
    panel.append(UI.section('With the bot',
      UI.check(Bot.data, 'answerReaderCommands', 'Answer the voice and TTS commands in Twitch chat (“@alice your TTS voice is now Bella”)', { onChange: save }),
      UI.check(Bot.data.ui, 'feedActivity', 'Show follows, redemptions, polls and the bot’s notes in the chat list (they aren’t read out)', { onChange: save }),
      h('p', { class: 'hint' }, 'For a reward that reaches the reader whatever it asks for, give it effects under ',
        UI.button('Rewards', () => Bot.shell.show('rewards'), { cls: 'link' }),
        ' instead: “Change how a chatter is read” and “Speak with TTS” work there for every reward.')));

    if (!me) {
      panel.append(h('p', { class: 'hint' }, 'Log in under ', UI.button('Accounts', () => Bot.shell.show('account'), { cls: 'link' }), ' to pick the rewards above from your channel’s list, by name, instead of redeeming each one to link it.'));
      return;
    }
    const status = UI.status();
    const listBox = h('div', {});
    const draw = (rewards) => {
      const linked = host.readerRewards();
      const actions = [['', 'Nothing'], ...host.rewardActions().map((a) => [a.id, a.label])];
      listBox.replaceChildren(UI.table(
        [{ label: 'Your reward' }, { label: 'Cost', cls: 'num' }, { label: 'What the reader does' }],
        rewards.map((r) => {
          const current = linked[r.id] ? linked[r.id].action : '';
          const select = h('select', { 'aria-label': `What the reader does for ${r.title}` });
          UI.options(select, actions, current);
          select.addEventListener('change', () => { host.setReaderReward(r.id, r.title, select.value); UI.say(status, select.value ? `“${r.title}” is linked.` : `“${r.title}” is unlinked.`); });
          return {
            off: !r.is_enabled,
            cells: [h('span', {}, r.title, r.is_user_input_required ? null : h('span', { class: 'pill', title: 'Only redemptions with text show up in chat, so the reader can’t see this one' }, 'no text')), String(r.cost), select],
          };
        }),
        { empty: 'Your channel has no channel point rewards.' },
      ));
    };
    panel.append(UI.section('Your channel’s rewards',
      UI.lead('Pick what each reward does. The reader only sees redemptions that ask the viewer to type something; the others are marked.'),
      listBox, status));
    if (UI.rewardsCache) draw(UI.rewardsCache);
    else {
      listBox.append(h('p', { class: 'hint' }, 'Loading your rewards…'));
      UI.loadRewards().then(draw).catch((err) => { listBox.replaceChildren(); UI.say(status, err.message, true); });
    }
  }, { listens: ['accounts'] });
})();
