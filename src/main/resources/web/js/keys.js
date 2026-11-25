// Keyboard shortcuts: every action, its default keys, the user's own keys (kept in localStorage) and matching.
// An action can have several keys (play / pause is K and Space by default). engine.js reads the same storage
// for the two shortcuts that must also work while Apple's page has focus ('apple' and 'log').
import { esc, store as persist } from './util.js';

/** Every action, in the order Settings lists them. `host`: only in the app window on the playing computer. */
export const ACTIONS = [
  { id: 'toggle', group: 'Playback', label: 'Play / pause', def: ['K', 'Space'] },
  { id: 'prev', group: 'Playback', label: 'Previous song', hint: 'Restarts the song if more than 3 s in', def: ['J', 'Ctrl+ArrowLeft'] },
  { id: 'next', group: 'Playback', label: 'Next song', def: ['L', 'Ctrl+ArrowRight'] },
  { id: 'seekBack', group: 'Playback', label: 'Rewind', def: ['ArrowLeft'] },
  { id: 'seekFwd', group: 'Playback', label: 'Fast-forward', def: ['ArrowRight'] },
  { id: 'mute', group: 'Playback', label: 'Mute / unmute', def: ['M'] },
  { id: 'volUp', group: 'Playback', label: 'Volume up 5%', def: [] },
  { id: 'volDown', group: 'Playback', label: 'Volume down 5%', def: [] },
  { id: 'shuffle', group: 'Playback', label: 'Shuffle on / off', def: [] },
  { id: 'repeat', group: 'Playback', label: 'Repeat (off → all → one)', def: [] },
  { id: 'love', group: 'Playback', label: 'Add to / remove from Favorite Songs', def: [] },
  { id: 'fullPlayer', group: 'Views', label: 'Full-screen player', def: [] },
  { id: 'closeFull', group: 'Views', label: 'Close the full-screen player', def: ['Escape'] },
  { id: 'lyrics', group: 'Views', label: 'Lyrics', def: [] },
  { id: 'queue', group: 'Views', label: 'Queue', def: [] },
  { id: 'sidebar', group: 'Views', label: 'Collapse / expand the sidebar', def: [] },
  { id: 'search', group: 'App', label: 'Search', def: ['Ctrl+K'] },
  { id: 'settings', group: 'App', label: 'Settings', def: ['Ctrl+,'] },
  { id: 'apple', group: 'App', label: 'Show / hide Apple Music’s page', def: ['Ctrl+Shift+A'], host: true },
  { id: 'log', group: 'App', label: 'Show / hide the log window (Windows)', def: ['Ctrl+Shift+T'], host: true },
];

const KEYS = 'orchard.keys';
const STEP = 'orchard.seekStep';
export const DEFAULT_STEP = 10;
export const MAX_KEYS = 3;

const changed = () => document.dispatchEvent(new CustomEvent('keys-changed'));

/** The keys for every action: {id: [combo…]}. */
export function bindings() {
  const saved = persist(KEYS) || {};
  const out = {};
  for (const a of ACTIONS) {
    const v = saved[a.id];
    if (Array.isArray(v)) out[a.id] = v.filter((c) => typeof c === 'string' && c);
    // Older versions stored one key per action, with the extra keys (Space, Ctrl+arrows) fixed: keep those.
    else if (typeof v === 'string') out[a.id] = [...new Set([v, ...a.def.slice(1)].filter(Boolean))];
    else out[a.id] = [...a.def];
  }
  return out;
}

function save(all) {
  persist(KEYS, all);
  changed();
}

/** Adds a key to an action, taking it away from any other action. Returns the action it was taken from, if any. */
export function addBinding(id, combo) {
  const all = bindings();
  let from = null;
  for (const a of ACTIONS) {
    if (a.id !== id && all[a.id].includes(combo)) {
      all[a.id] = all[a.id].filter((c) => c !== combo);
      from = a;
    }
  }
  if (!all[id].includes(combo)) all[id] = [...all[id], combo].slice(-MAX_KEYS);
  save(all);
  return from;
}

export function removeBinding(id, combo) {
  const all = bindings();
  all[id] = all[id].filter((c) => c !== combo);
  save(all);
}

export function resetBindings() {
  try { localStorage.removeItem(KEYS); localStorage.removeItem(STEP); } catch (e) { /* storage unavailable */ }
  changed();
}

/** Seconds the rewind / fast-forward keys move. */
export function seekStep() {
  const n = Number(persist(STEP));
  return Number.isFinite(n) && n >= 1 && n <= 600 ? n : DEFAULT_STEP;
}

export function setSeekStep(n) {
  persist(STEP, Math.min(600, Math.max(1, Math.round(Number(n) || DEFAULT_STEP))));
  changed();
}

/** A keydown event as a combination string like "K", "Shift+L", "Ctrl+ArrowRight"; null for a lone modifier. */
export function comboOf(e) {
  const k = e.key;
  if (!k || ['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Dead', 'Unidentified'].includes(k)) return null;
  const key = k === ' ' ? 'Space' : k === '+' ? 'Plus' : k.length === 1 ? k.toUpperCase() : k;
  const mods = [];
  if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  // Shift counts for letters and named keys; for symbols ("?", "!") it's already part of the character.
  if (e.shiftKey && (/^[A-Z]$/.test(key) || k.length > 1)) mods.push('Shift');
  return [...mods, key].join('+');
}

/** The action bound to a combination, or null. */
export function actionFor(combo) {
  if (!combo) return null;
  const all = bindings();
  return ACTIONS.find((a) => all[a.id].includes(combo))?.id || null;
}

/** Why a combination can't be used, or '' if it can. */
export function reserved(combo) {
  if (combo === 'Tab' || combo === 'Shift+Tab') return 'Tab is needed to move around the page';
  return '';
}

const NAMES = {
  ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc', Space: 'Space',
  PageUp: 'Page Up', PageDown: 'Page Down', Delete: 'Del', Backspace: '⌫', Enter: 'Enter', Plus: '+',
};

/** A combination for display: "Ctrl+ArrowRight" → "Ctrl + →". */
export function label(combo) {
  return combo ? combo.split('+').map((p) => NAMES[p] || p).join(' + ') : '';
}

/** The same as <kbd> keycaps. */
export function keycaps(combo) {
  return combo ? combo.split('+').map((p) => `<kbd>${esc(NAMES[p] || p)}</kbd>`).join('') : '';
}

/** The first key of an action, for hints like "Settings (Ctrl + ,)"; '' if it has none. */
export function firstKey(id) {
  return label((bindings()[id] || [])[0] || '');
}
