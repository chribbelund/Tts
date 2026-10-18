'use strict';

// OBS control over obs-websocket 5 (built into OBS 28 and later: Tools →
// WebSocket Server Settings). The password is kept with the Twitch tokens.

const Obs = Bot.obs = {
  ws: null, state: 'idle', text: '', pending: new Map(), seq: 0, retryTimer: null, wanted: false,
  scenes: [], inputs: [],
};

// OBS's own events, for the Events tab.
Object.assign(Bot.events.types, {
  obsSceneChanged: { name: 'Scene changed', category: 'OBS', fields: [['scene', 'Scene']], text: (u, f) => `OBS switched to ${f.scene}`, sample: { scene: 'Gameplay' } },
  obsStreamStarted: { name: 'OBS started streaming', category: 'OBS', fields: [], text: () => 'OBS started streaming' },
  obsStreamStopped: { name: 'OBS stopped streaming', category: 'OBS', fields: [], text: () => 'OBS stopped streaming' },
  obsRecordingStarted: { name: 'OBS started recording', category: 'OBS', fields: [], text: () => 'OBS started recording' },
  obsRecordingStopped: { name: 'OBS stopped recording', category: 'OBS', fields: [], text: () => 'OBS stopped recording' },
});

function setState(state, text = '') {
  Obs.state = state;
  Obs.text = text;
  Bot.emit('obs', { state, text });
}

async function sha256b64(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

Obs.connect = async () => {
  Obs.disconnect(true);
  Obs.wanted = true;
  const url = Bot.data.obs.url.trim() || 'ws://127.0.0.1:4455';
  if (!/^wss?:\/\//.test(url)) { setState('error', 'The address has to start with ws://'); return; }
  setState('connecting', 'Connecting to OBS…');
  const password = (await Bot.desktop.getSecret('obs-password')) || '';
  const ws = new WebSocket(url);
  Obs.ws = ws;

  ws.onmessage = async (msg) => {
    if (Obs.ws !== ws) return;
    let data;
    try { data = JSON.parse(msg.data); } catch { return; }
    if (data.op === 0) {
      const identify = { rpcVersion: 1, eventSubscriptions: 1 | 4 | 64 };
      const auth = data.d.authentication;
      if (auth) {
        if (!password) { setState('error', 'OBS asks for a password. Enter it under OBS, in the Stream section.'); ws.close(); return; }
        identify.authentication = await sha256b64((await sha256b64(password + auth.salt)) + auth.challenge);
      }
      ws.send(JSON.stringify({ op: 1, d: identify }));
    } else if (data.op === 2) {
      setState('connected', 'Connected to OBS');
      Obs.refreshLists();
    } else if (data.op === 7) {
      const p = Obs.pending.get(data.d.requestId);
      if (!p) return;
      Obs.pending.delete(data.d.requestId);
      if (data.d.requestStatus.result) p.resolve(data.d.responseData || {});
      else p.reject(new Error(data.d.requestStatus.comment || `OBS said no (${data.d.requestStatus.code})`));
    } else if (data.op === 5) {
      onObsEvent(data.d.eventType, data.d.eventData || {});
    }
  };

  ws.onclose = (event) => {
    if (Obs.ws !== ws) return;
    Obs.ws = null;
    for (const p of Obs.pending.values()) p.reject(new Error('OBS disconnected'));
    Obs.pending.clear();
    if (event.code === 4009) { setState('error', 'Wrong OBS password'); return; }
    if (!Obs.wanted) { setState('idle', ''); return; }
    setState('error', 'Can’t reach OBS. Trying again in 15 s… (Is it open, with the WebSocket server on?)');
    Obs.retryTimer = setTimeout(() => { if (Obs.wanted) Obs.connect(); }, 15000);
  };
};

Obs.disconnect = (keepWanted = false) => {
  if (!keepWanted) Obs.wanted = false;
  clearTimeout(Obs.retryTimer);
  if (Obs.ws) { const ws = Obs.ws; Obs.ws = null; ws.close(); }
  setState('idle', '');
};

Obs.request = (requestType, requestData = {}) => new Promise((resolve, reject) => {
  if (!Obs.ws || Obs.state !== 'connected') { reject(new Error('OBS isn’t connected (see OBS, in the Stream section)')); return; }
  const requestId = `r${++Obs.seq}`;
  Obs.pending.set(requestId, { resolve, reject });
  Obs.ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
  setTimeout(() => {
    if (Obs.pending.has(requestId)) { Obs.pending.delete(requestId); reject(new Error('OBS didn’t answer')); }
  }, 8000);
});

Obs.refreshLists = async () => {
  try {
    const [scenes, inputs] = await Promise.all([Obs.request('GetSceneList'), Obs.request('GetInputList')]);
    Obs.scenes = (scenes.scenes || []).map((s) => s.sceneName).reverse();
    Obs.inputs = (inputs.inputs || []).map((i) => i.inputName);
    Bot.emit('obs', { state: Obs.state, text: Obs.text });
  } catch {}
};

function onObsEvent(type, data) {
  if (type === 'CurrentProgramSceneChanged') Bot.events.fire('obsSceneChanged', { fields: { scene: data.sceneName } });
  else if (type === 'StreamStateChanged' && data.outputState === 'OBS_WEBSOCKET_OUTPUT_STARTED') Bot.events.fire('obsStreamStarted');
  else if (type === 'StreamStateChanged' && data.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED') Bot.events.fire('obsStreamStopped');
  else if (type === 'RecordStateChanged' && data.outputState === 'OBS_WEBSOCKET_OUTPUT_STARTED') Bot.events.fire('obsRecordingStarted');
  else if (type === 'RecordStateChanged' && data.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED') Bot.events.fire('obsRecordingStopped');
  else if (type === 'SceneListChanged' || type === 'InputCreated' || type === 'InputRemoved' || type === 'InputNameChanged') Obs.refreshLists();
}

async function currentScene() {
  const res = await Obs.request('GetCurrentProgramScene');
  return res.sceneName || res.currentProgramSceneName;
}

Obs.run = async (action, { scene = '', source = '', filter = '' } = {}) => {
  switch (action) {
    case 'scene':
      if (!scene) throw new Error('pick a scene');
      return Obs.request('SetCurrentProgramScene', { sceneName: scene });
    case 'show': case 'hide': case 'toggleSource': {
      const sceneName = scene || await currentScene();
      const { sceneItemId } = await Obs.request('GetSceneItemId', { sceneName, sourceName: source });
      let enabled = action === 'show';
      if (action === 'toggleSource') enabled = !(await Obs.request('GetSceneItemEnabled', { sceneName, sceneItemId })).sceneItemEnabled;
      return Obs.request('SetSceneItemEnabled', { sceneName, sceneItemId, sceneItemEnabled: enabled });
    }
    case 'filterOn': case 'filterOff': case 'toggleFilter': {
      let enabled = action === 'filterOn';
      if (action === 'toggleFilter') enabled = !(await Obs.request('GetSourceFilter', { sourceName: source, filterName: filter })).filterEnabled;
      return Obs.request('SetSourceFilterEnabled', { sourceName: source, filterName: filter, filterEnabled: enabled });
    }
    case 'mute': return Obs.request('SetInputMute', { inputName: source, inputMuted: true });
    case 'unmute': return Obs.request('SetInputMute', { inputName: source, inputMuted: false });
    case 'toggleMute': return Obs.request('ToggleInputMute', { inputName: source });
    case 'startStream': return Obs.request('StartStream');
    case 'stopStream': return Obs.request('StopStream');
    case 'startRecord': return Obs.request('StartRecord');
    case 'stopRecord': return Obs.request('StopRecord');
    case 'toggleRecord': return Obs.request('ToggleRecord');
    case 'saveReplay': return Obs.request('SaveReplayBuffer');
    default: throw new Error(`unknown OBS action ${action}`);
  }
};
