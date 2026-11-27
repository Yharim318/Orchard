// Connection to Orchard speakers, live player state and the Apple Music API proxy.
import { toast, store as persist } from './util.js';

export const isHostApp = new URLSearchParams(location.search).has('host');

// The Orchard app window runs at https://music.apple.com/orchard/ (so Apple's player inside it is same-site and
// sign-in works). Orchard itself answers every request under /orchard; events are pushed in over DevTools.
// Phones and other browsers use the plain local address and Server-Sent Events.
export const HOST_PROXY = location.hostname === 'music.apple.com';
export const ROOT = HOST_PROXY ? '/orchard' : '';

export const S = {
  info: null,          // the Orchard instance that served this page
  speaker: null,       // the speaker we are controlling { id, name }
  speakerBase: '',     // '' = the server that served this page, otherwise http://ip:port
  state: { ready: false },
  stateAt: performance.now(),
  speakers: [],
  devices: [],
  connected: false,
};

const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function notify(kind) {
  for (const fn of listeners) {
    try { fn(kind); } catch (e) { console.error(e); }
  }
}

// Goes into Apple API paths; another speaker supplies it, so only a two-letter country code is accepted.
export const sf = () => (/^[a-z]{2}$/i.test(S.state.storefront || '') ? S.state.storefront.toLowerCase() : 'us');

/** Current playback position, interpolated between server updates. */
export function positionNow() {
  const s = S.state;
  let p = s.position || 0;
  if (s.isPlaying) p += (performance.now() - S.stateAt) / 1000;
  const d = s.duration || (s.item && s.item.duration) || 0;
  return d ? Math.min(p, d) : p;
}

let shown = { item: null, pos: 0 };

/**
 * positionNow() for what's on screen (progress bars, lyrics). Each report from the speaker restarts the estimate
 * and can land a little behind it (delivery takes a moment); stepping back by that fraction of a second made the
 * lyrics flick back to the previous line and forward again. While playing, small backward steps are held until
 * the clock catches up; real jumps (a seek, another song) show at once.
 */
export function displayPosition() {
  const s = S.state;
  const p = positionNow();
  const item = s.item ? s.item.id : null;
  if (s.isPlaying && item === shown.item && p < shown.pos && shown.pos - p < 1.5) return shown.pos;
  shown = { item, pos: p };
  return p;
}

// ------------------------------------------------------------------ device identity

export function deviceId() {
  let id = persist('orchard.deviceId');
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
    persist('orchard.deviceId', id);
  }
  return id;
}

export function deviceKind() {
  const ua = navigator.userAgent;
  if (isHostApp) return 'app';
  if (/iPad|Tablet/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'tablet';
  if (/Mobi|iPhone|Android/i.test(ua)) return 'phone';
  return 'computer';
}

export function deviceName() {
  const custom = persist('orchard.deviceName');
  if (custom) return custom;
  const ua = navigator.userAgent;
  if (isHostApp) return S.info ? S.info.hostname : 'This computer';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad'
    : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac'
      : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${os} · ${br}`;
}

// ------------------------------------------------------------------ access (pairing)

// Orchard only answers devices paired by the Apple Music account signed in on that computer (see Access.java).
// The Orchard window on that computer needs no key. Other devices get one by scanning the QR code in the Orchard
// window, or by asking and being allowed there; it works with every computer linked to the same account.
const KEY_STORE = 'orchard.key';

export const deviceKey = () => (HOST_PROXY ? null : persist(KEY_STORE));

export function setDeviceKey(key) {
  persist(KEY_STORE, key || '');
}

/** Headers that identify this device to an Orchard computer (nothing in the Orchard window itself). */
export function authHeaders(headers = {}) {
  const key = deviceKey();
  return key ? { ...headers, 'X-Orchard-Device': deviceId(), 'X-Orchard-Key': key } : headers;
}

/** fetch() to an Orchard computer with this device's key. */
export const orchardFetch = (url, opts = {}) => fetch(url, { ...opts, headers: authHeaders(opts.headers) });

// ------------------------------------------------------------------ HTTP

async function http(url, opts = {}) {
  const res = await orchardFetch(url, opts);
  if (res.status === 401 && !HOST_PROXY) {
    // Not (or no longer) paired: e.g. the computer signed out of Apple Music, which forgets every device.
    if (!S.unpaired) { S.unpaired = true; notify('unpaired'); }
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
  if (!res.ok) {
    const apple = data && data.errors && data.errors[0];
    const msg = (data && data.error) || (apple && (apple.detail || apple.title)) || `Request failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

const memo = new Map();

/** GET from the Apple Music API (through the Orchard server that served this page). */
export function am(path, { fresh = false } = {}) {
  const cacheable = path.startsWith('/v1/catalog/');
  if (cacheable && !fresh && memo.has(path)) return memo.get(path);
  const p = http(ROOT + '/api/am?path=' + encodeURIComponent(path));
  if (cacheable) {
    memo.set(path, p);
    p.catch(() => memo.delete(path));
  }
  return p;
}

export function amWrite(method, path, body) {
  return http(ROOT + '/api/am', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, path, body }),
  });
}

/** Sends a player command to the active speaker. */
export async function cmd(c, { quiet = false } = {}) {
  try {
    const s = await speakerRequest('/api/cmd', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(c),
    });
    // Not proof of a held change: the reply can be taken before the speaker's player has caught up.
    if (s) setState(s);
    return s;
  } catch (e) {
    releaseHeld(true); // the change didn't happen: show the speaker's real state again
    if (!quiet) toast(e.message);
    throw e;
  }
}

/** A request to the speaker being controlled (this computer, or another Orchard speaker). */
function speakerRequest(path, opts = {}) {
  if (!S.speakerBase) return http(ROOT + path, opts);
  // The app window can't reach plain-HTTP addresses directly: Orchard forwards to the (known) speaker for it.
  if (HOST_PROXY) return http(ROOT + path, { ...opts, headers: { ...(opts.headers || {}), 'X-Orchard-Peer': S.speakerBase } });
  return http(S.speakerBase + path, opts);
}

/** Songs [start, start+count) of the speaker's queue: { rev, position, total, start, items }. */
export const queuePage = (start, count) => speakerRequest(`/api/queue?start=${start}&count=${count}`);

export const post = (path, body) => speakerRequest(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
});

/*
 * Values the user just changed (play/pause, shuffle, a seek…). The speaker can still send reports from before
 * the change arrived, and command replies (HTTP) and events (stream) can overtake each other; without this,
 * pausing would flash play → pause → play. A held value overrides any report that disagrees with it until the
 * speaker confirms it, plus a short grace period for older reports still on their way (on a phone over Wi-Fi
 * those can take seconds). It's dropped when the song changes, the command fails, or after HOLD_MS.
 */
const expected = new Map(); // key → {value, at, until, item, confirmed}
const HOLD_MS = 8000;  // longest wait for a confirmation (the engine gives up on a command after 6 s)
const GRACE_MS = 1000; // after the confirmation, keep ignoring stale reports this long
const HELD = new Set(['isPlaying', 'shuffle', 'repeat', 'volume', 'position']); // not the queue: its edits confirm differently
const reported = {};   // the speaker's own latest value for each held key, shown again when a hold ends
let releaseTimer = null;

/** Optimistic local update so controls feel instant; the speaker's next event confirms it. */
export function patchState(partial) {
  if ('position' in partial || 'isPlaying' in partial) {
    S.state.position = positionNow();
    S.stateAt = performance.now();
  }
  const now = performance.now();
  const item = S.state.item ? S.state.item.id : null;
  for (const [k, value] of Object.entries(partial)) {
    if (HELD.has(k)) expected.set(k, { value, at: now, until: now + HOLD_MS, item, confirmed: false });
  }
  Object.assign(S.state, partial);
  scheduleRelease();
  notify('state');
}

function agrees(k, e, s, now) {
  if (k === 'position') {
    // A seek: reports within 2 s of where it should be by now count; older ones still show the old spot.
    const playing = expected.has('isPlaying') ? expected.get('isPlaying').value : s.isPlaying;
    return Math.abs((s.position || 0) - (e.value + (playing ? (now - e.at) / 1000 : 0))) <= 2;
  }
  if (k === 'volume') return Math.abs((s.volume ?? 1) - e.value) < 0.005;
  return s[k] === e.value;
}

function holdExpected(s) {
  const now = performance.now();
  const item = s.item ? s.item.id : null;
  for (const k of HELD) if (k !== 'position' && k in s) reported[k] = s[k];
  for (const [k, e] of expected) {
    if (now > e.until || e.item !== item) { expected.delete(k); continue; }
    if (agrees(k, e, s, now)) {
      if (!e.confirmed) { e.confirmed = true; e.until = Math.min(e.until, now + GRACE_MS); }
    } else if (k === 'position') {
      const playing = expected.has('isPlaying') ? expected.get('isPlaying').value : s.isPlaying;
      s.position = e.value + (playing ? (now - e.at) / 1000 : 0);
    } else {
      s[k] = e.value;
    }
  }
  scheduleRelease();
}

/** Ends holds that ran out (all of them with `all`); unconfirmed ones show what the speaker last reported. */
function releaseHeld(all = false) {
  const now = performance.now();
  const item = S.state.item ? S.state.item.id : null;
  let changed = false;
  for (const [k, e] of expected) {
    if (!all && now < e.until) continue;
    expected.delete(k);
    // A confirmed value stands (reports after it were stale ones); an unconfirmed one gives way to the speaker.
    if (!e.confirmed && k !== 'position' && e.item === item && k in reported && S.state[k] !== reported[k]) {
      S.state[k] = reported[k];
      changed = true;
    }
  }
  scheduleRelease();
  if (changed) notify('state');
}

function scheduleRelease() {
  clearTimeout(releaseTimer);
  releaseTimer = null;
  if (!expected.size) return;
  const next = Math.min(...[...expected.values()].map((e) => e.until));
  releaseTimer = setTimeout(() => releaseHeld(), Math.max(0, next - performance.now()) + 5);
}

function setState(s) {
  holdExpected(s);
  const prevQueue = S.state.queue;
  S.state = s;
  if (!s.queue && prevQueue) S.state.queue = prevQueue;
  S.stateAt = performance.now();
  notify('state');
}

// ------------------------------------------------------------------ live connection

let es = null;
let failures = 0;

// A speaker address must be http://<IP>:<port>: speaker lists can be relayed from another speaker, and the address
// is where this page then sends commands and opens its event stream.
const SPEAKER_URL = /^http:\/\/(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:.]+\]):\d{1,5}$/i;

export function normalizeSpeakers(list) {
  return (Array.isArray(list) ? list : []).filter((sp) => sp && typeof sp === 'object').map((sp) => ({
    ...sp,
    base: S.info && sp.id === S.info.id ? '' : sp.self ? S.speakerBase : SPEAKER_URL.test(sp.url || '') ? sp.url : null,
  })).filter((sp) => sp.base !== null);
}

const handlers = {
  hello: (d) => {
    S.speaker = d.speaker;
    S.connected = true;
    failures = 0;
    notify('speaker');
  },
  state: (d) => setState(d),
  devices: (d) => { S.devices = d; notify('devices'); },
  speakers: (d) => { S.speakers = normalizeSpeakers(d); notify('speakers'); },
  'engine-ui': (d) => { S.engineUi = d; notify('engine-ui'); },
  'pair-requests': (d) => { S.pairRequests = Array.isArray(d) ? d : []; notify('pair-requests'); },
  'relay-lost': () => {
    toast('Lost the other speaker — switching back to this one');
    useSpeaker('');
  },
};

/** Opens/closes the log window of the Orchard computer (app window only). Resolves to 'shown' / 'hidden' / 'unavailable'. */
export async function toggleConsole() {
  const r = await http(ROOT + '/__host/console', { method: 'POST' });
  return r && r.console;
}

export function connect() {
  if (es) es.close();
  const base = S.speakerBase;
  const device = { deviceId: deviceId(), name: deviceName(), kind: deviceKind() };
  if (HOST_PROXY) {
    // Events arrive via window.__orchardPush (called by Orchard over DevTools).
    window.__orchardPush = (event, data) => { const h = handlers[event]; if (h) h(data); };
    http(ROOT + '/__host/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...device, speaker: base }),
    }).then((r) => {
      // The remembered speaker isn't on this network (e.g. a different place): Orchard connected us to this
      // computer instead, so stop sending commands to the old one ("Unknown speaker").
      if (base && r && r.remote === false && S.speakerBase === base) {
        S.speakerBase = '';
        persist('orchard.speaker', '');
        notify('speaker');
      }
    }).catch((e) => toast(`Can't connect: ${e.message}`));
    return;
  }
  // EventSource can't send headers: the key goes in the query string.
  const key = deviceKey();
  es = new EventSource(`${base}/api/events?${new URLSearchParams(key ? { ...device, key } : device)}`);
  for (const [event, h] of Object.entries(handlers)) {
    if (event !== 'relay-lost') es.addEventListener(event, (e) => h(JSON.parse(e.data)));
  }
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) checkAccess(base); // refused (401): maybe no longer paired
    S.connected = false;
    notify('connection');
    failures++;
    if (base && failures >= 4) {
      toast('Lost the other speaker — switching back to this one');
      useSpeaker('');
    }
  };
}

function useSpeaker(base) {
  S.speakerBase = base;
  persist('orchard.speaker', base);
  S.state = { ready: false };
  expected.clear(); // holds were for the old speaker
  S.speaker = null;
  notify('state');
  connect();
}

/** Switches which speaker we control; hands over playback like Spotify Connect when something is playing. */
export async function selectSpeaker(sp) {
  if (!sp || sp.base === S.speakerBase) return;
  // sp.url is the address the *current* speaker knows the target by, so it can hand over directly.
  if (S.state.isPlaying && sp.url) {
    try {
      await post('/api/transfer', { to: sp.url });
    } catch (e) {
      toast(`Couldn't move playback: ${e.message}`);
    }
  }
  useSpeaker(sp.base);
}

/** After a refused event stream: if this device isn't paired any more, show the pairing screen. */
async function checkAccess(base) {
  try {
    const a = await http(`${base || ROOT}/api/access`);
    if (a && !a.paired && !S.unpaired) { S.unpaired = true; notify('unpaired'); }
  } catch (e) { /* unreachable: the usual reconnect handling applies */ }
}

/** Opened from the QR code in the Orchard window (…/?pair=CODE): trade the code for this device's key. */
async function claimInvite() {
  const params = new URLSearchParams(location.search);
  const code = params.get('pair');
  if (!code || HOST_PROXY) return;
  params.delete('pair');
  history.replaceState(history.state, '', `${location.pathname}${params.toString() ? `?${params}` : ''}${location.hash}`);
  try {
    const r = await http(ROOT + '/api/pair/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, deviceId: deviceId(), name: deviceName(), kind: deviceKind() }),
    });
    if (r && r.key) setDeviceKey(r.key);
  } catch (e) {
    toast(e.message);
  }
}

export async function init() {
  S.info = await http(ROOT + '/api/info');
  await claimInvite();
  if (!HOST_PROXY) {
    const a = await http(ROOT + '/api/access');
    if (!a.paired) {
      S.unpaired = true;
      notify('unpaired');
      return false;
    }
  }
  const saved = persist('orchard.speaker');
  S.speakerBase = typeof saved === 'string' ? saved : '';
  connect();
  return true;
}

/** Ask the Orchard computer for access; resolves to { id, secret } (see pairing.js). */
export const requestAccess = () => http(ROOT + '/api/pair/request', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ deviceId: deviceId(), name: deviceName(), kind: deviceKind() }),
});

export const accessStatus = (id, secret) => http(`${ROOT}/api/pair/status?${new URLSearchParams({ id, secret })}`);

// The Orchard window: devices asking to be let in, and the QR invite.
export const pendingRequests = () => http(ROOT + '/api/pair/pending');
export const decideRequest = (id, allow) => http(ROOT + '/api/pair/decide', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, allow }),
});
export const pairInvite = () => http(ROOT + '/api/pair/invite', { method: 'POST' });
export const removeAllDevices = () => http(ROOT + '/api/pair/reset', { method: 'POST' });
