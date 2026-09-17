'use strict';

// Third-party emotes (7TV, BetterTTV, FrankerFaceZ) are not in Twitch's
// `emotes` tag: they reach us as ordinary words, so a voice reads "FeelsBadMan"
// or "OMEGALUL" out loud. Keeping them out of the speech means knowing the
// channel's emote names, which these three public APIs give us without a key.

const EMOTE_APIS = {
  global: [
    ['https://api.betterttv.net/3/cached/emotes/global', bttvNames],
    ['https://7tv.io/v3/emote-sets/global', seventvNames],
    ['https://api.frankerfacez.com/v1/set/global', ffzNames],
  ],
  channel: [
    ['https://api.betterttv.net/3/cached/users/twitch/', bttvNames],
    ['https://7tv.io/v3/users/twitch/', seventvNames],
    ['https://api.frankerfacez.com/v1/room/id/', ffzNames],
  ],
};

function bttvNames(data) {
  const list = Array.isArray(data) ? data : [...(data.channelEmotes || []), ...(data.sharedEmotes || [])];
  return list.map((e) => e && e.code);
}

function seventvNames(data) {
  const set = data.emotes ? data : data.emote_set;
  return ((set && set.emotes) || []).map((e) => e && e.name);
}

function ffzNames(data) {
  const names = [];
  for (const set of Object.values(data.sets || {})) {
    for (const e of set.emoticons || []) names.push(e && e.name);
  }
  return names;
}

// Channel emote sets happily contain names that are also everyday words
// ("mods", "hi", "lol", "Chat", "Stare", "Timer"). Stripping those blindly
// would eat real speech, so names are handled in two tiers: see classify().
const PLAIN_WORDS = new Set(`a able about above after again against all almost also always am an and animal another answer any are around as ask at away baby back bad bag ball band bank base be beautiful because bed been before begin behind being believe below best better between big bit black blue boat body book both box boy bread break bring brother build business busy but buy by call came can car care carry case cat catch cause center certain chair chance change check cheese child city class clean clear close cold color come common could country course cover cry cut dad dance dancer dark day dead dear deep did die different do does dog done door down draw dream drink drive drop dry during each ear early earth east easy eat egg eight either end enough enter even ever every eye face fact fall family far fast fat father fear feel feet few field fight find fine fire first fish five floor fly follow food foot for force form found four free friend from front full fun funny game gave get girl give glad go god gold gone good got great green grew ground group grow guess guy had hair half hand happen happy hard has hat hate have he head hear heard heart heavy held hello help her here hey high him his hit hold home hope horse hot hour house how huge huh human hundred hurt i ice idea if in inside into is it its job join joy jump just keep kept key kid kill kind king knew know lady land language large last late laugh law lay lead learn leave led left leg less let letter lie life light like line list listen little live lol long look lord lose lost lot loud love low mad made make man many map mark may maybe me mean meat meet men might mile milk mind mine minute miss mod mods moment money month moon more morning most mother mountain mouth move much music must my name near need never new news next nice night nine no none nor north nose not note nothing notice now number of off often oh oil ok okay old on once one only open or order other our out over own page paper part party pass past pay peace pen people perhaps person pick picture piece place plan plant play please point poor possible power press pretty print probably problem pull push put question quick quiet quite rain ran reach read ready real really reason red remember rest rich ride right ring rise river road rock roll room round rule run sad safe said sail salt same sand sat save saw say school sea search season seat second see seem seen self sell send sense sent serve set seven several shall shape she ship shoe shop short should show side sign silver simple since sing sir sister sit six size sky sleep slow small smile snow so soft some son song soon sorry sound south space speak special spell spend sport spot spring stand star start state stay step still stone stood stop store story straight strange street strong study such sudden sugar summer sun sure surprise sweet swim table tail take talk tall teach team tell ten test than thank that the their them then there these they thick thin thing think third this those though thought three through throw thus tie time tiny tire to today together told tomorrow tone too took top touch toward town track trade train travel tree trip trouble true try turn twelve two under until up upon us use usual very view visit voice wait walk wall want war warm was wash watch water wave way we wear week weight welcome well went were west what wheel when where whether which while white who whole whose why wide wife wild will win wind window wine winter wish with within without woman women wonder wood word work world would write wrong yes yet you young your
ah aw bro dude eh guys ha hi hm ho oof ow uh um ya yay yo
alarm alright android anime assist aura awake aware awkward bald balls banned beta bird blink blood blush bought brick british bruh burger candle caught cease ceiling cereal chad chat cinema classic clown colors comfy cooked cool cope corn cough crazy cringe damage damn dance deal death dies disgust dots drama drill drool eating emote eyeroll finally focus folk freaky freedom frog fries gaming gasp genius going golive greedy gross helped hole hollow holy howdy insane jail joker judge kneel knife leak lemon lion lions loading lockin login looking lore loser lurk malding massive medals meds melon mewing moron motion muted nails nerd nice noted nope norway notepad nuke offline panic pain pardon picture pinned pissed police popcorn pout potato praying pussy quack rave retail rising riot roach saved saying scam scared scream shock shrug sitting skip slap slay sleep smash smelly smug sneak society spank splash spray squad squish stare staring steve stonks stripped sus sway sweat system talking tasty tears thanks thick thighs thug timeout timer tired title twerk twin twisted twitch unlucky vibe voted waiting washed weird wicked wink wire wisdom yawn yeah yep yikes`.split(/\s+/));

// Worth keeping in the set at all: anything but a word we recognise, which we
// never want to take out of someone's sentence ("lol", "mods", "cheese").
function worthTracking(name) {
  if (!name || name.length < 2) return false;
  if (!/^[A-Za-z]+$/.test(name)) return true;   // ":tf:", "4Head", "D:" — never typed as speech
  if (/[a-z][A-Z]/.test(name)) return true;     // "catJAM", "peepoHappy"
  return !PLAIN_WORDS.has(name.toLowerCase());
}

// A single-case word that isn't in the list above could still be something a
// person typed ("taw", "Sadge", "Stare"), so it only gets dropped when the
// whole message is emotes. Mixed caps, symbols and SHOUTING are safe to drop
// anywhere, since none of them read as speech.
const AMBIGUOUS_RE = /^[A-Z]?[a-z]+$/;

/** The emote names in use in one channel. `onChange()` fires when a load ends. */
class ThirdPartyEmotes {
  constructor(onChange) {
    this.onChange = onChange || (() => {});
    this.names = new Set();
    this.globals = null;   // fetched once per page load
    this.roomId = null;
    this.loading = null;
    this.loaded = false;
    this.failed = 0;
  }

  get size() {
    return this.names.size;
  }

  clear() {
    this.names = new Set();
    this.roomId = null;
    this.loading = null;
    this.loaded = false;
    this.failed = 0;
  }

  /** Load the global sets plus this channel's. Safe to call repeatedly. */
  load(roomId) {
    if (!roomId || (roomId === this.roomId && this.loading)) return this.loading;
    this.roomId = roomId;
    this.loading = this.fetchAll(roomId);
    return this.loading;
  }

  async fetchAll(roomId) {
    let failed = 0;
    const collect = async (url, pick) => {
      try {
        const res = await fetch(url, { cache: 'force-cache' });
        // 404 is how these services say "this channel has nothing here".
        if (res.status === 404) return [];
        if (!res.ok) throw new Error(res.status);
        return pick(await res.json()) || [];
      } catch {
        failed++;
        return [];
      }
    };

    if (!this.globals) {
      const lists = await Promise.all(EMOTE_APIS.global.map(([url, pick]) => collect(url, pick)));
      this.globals = lists.flat().filter(worthTracking);
    }
    const lists = await Promise.all(EMOTE_APIS.channel.map(([base, pick]) => collect(base + roomId, pick)));
    const channel = lists.flat().filter(worthTracking);

    // A channel switch mid-flight wins; drop this result.
    if (this.roomId !== roomId) return;
    this.names = new Set([...this.globals, ...channel]);
    this.failed = failed;
    this.loaded = true;
    this.onChange();
  }

  /** 'emote' — safe to drop anywhere, 'maybe' — only in an all-emote message. */
  classify(word) {
    // Trailing punctuation is common ("catJAM!", "OMEGALUL,").
    const bare = this.names.has(word) ? word : word.replace(/[.,!?;:]+$/, '');
    if (!this.names.has(bare)) return null;
    return AMBIGUOUS_RE.test(bare) ? 'maybe' : 'emote';
  }

  /**
   * Blank out whole words that are emote names. Third-party emotes only render
   * when they stand alone, so whole-word, case-sensitive matching is both
   * enough and the safe choice for the surrounding text.
   */
  strip(text) {
    if (!text || !this.names.size) return text;
    const words = text.match(/\S+/g) || [];
    const kinds = words.map((w) => this.classify(w));
    const nothingElse = kinds.length > 0 && kinds.every(Boolean);
    let i = 0;
    return text.replace(/\S+/g, (word) => {
      const kind = kinds[i++];
      return kind === 'emote' || (kind && nothingElse) ? ' ' : word;
    });
  }
}
