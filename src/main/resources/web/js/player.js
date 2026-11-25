// Player bar, mobile mini/full player, device picker ("Connect"), right panel and engine status overlay.
import { $, esc, art, fmtTime, icon, EQ, throttle, toast, store as persist, BACKDROP, backdrop } from './util.js';
import { S, cmd, post, subscribe, positionNow, patchState, selectSpeaker, isHostApp } from './store.js';
import { isLoved, toggleLoved, lovedCached, trackMenuItems, openMenu, markPlaying, artistLink, trackMenuHead } from './components.js';
import { mountLyrics, lyricsViewButtons } from './lyrics.js';
import { seekStep } from './keys.js';
import { renderQueue, fromItem } from './views.js';

let seeking = false;
let loveItemId = null;
let barAnimPending = false;

// ------------------------------------------------------------------ markup

function controlsHtml(cls = '') {
  return `<div class="controls ${cls}">
    <button class="icon-btn" data-c="shuffle" title="Shuffle">${icon('shuffle')}</button>
    <button class="icon-btn" data-c="prev" title="Previous">${icon('prev')}</button>
    <button class="toggle" data-c="toggle" title="Play/Pause">${icon('play', 'i-play')}${icon('pause', 'i-pause')}</button>
    <button class="icon-btn" data-c="next" title="Next">${icon('next')}</button>
    <button class="icon-btn" data-c="repeat" title="Repeat">${icon('repeat', 'i-rep')}${icon('repeatOne', 'i-rep1')}</button>
  </div>`;
}

const seekHtml = (cls = '') => `<div class="progress ${cls}"><span class="t-cur">0:00</span>
  <input type="range" class="seek range" min="0" max="1000" value="0" aria-label="Seek"><span class="t-dur">0:00</span></div>`;

function buildPlayer() {
  $('#player').innerHTML = `
    <div class="bar">
      <div class="np">
        <button class="np-art-btn" data-c="open-full" title="Open full-screen player">
          <img class="np-art" src="" alt="" hidden><span class="np-expand">${icon('up')}</span></button>
        <div class="np-text"><div class="np-title"></div><div class="np-artist"></div></div>
        <button class="icon-btn love" data-c="love" title="Add to Favorite Songs" hidden>${icon('heartOutline', 'i-off')}${icon('heart', 'i-on')}</button>
      </div>
      <div class="center">${controlsHtml()}${seekHtml()}</div>
      <div class="right">
        <button class="icon-btn" data-c="lyrics" title="Lyrics">${icon('lyrics')}</button>
        <button class="icon-btn" data-c="queue" title="Queue">${icon('queue')}</button>
        <button class="icon-btn" data-c="devices" title="Connect to a device">${icon('devices')}</button>
        <button class="icon-btn" data-c="mute" title="Mute">${icon('volume', 'i-vol')}${icon('mute', 'i-mute')}</button>
        <input type="range" class="vol range" min="0" max="100" value="100" aria-label="Volume">
        <label class="vol-pct" title="Volume (type a number, or use ↑/↓)"><input type="text" inputmode="numeric" maxlength="3" value="100" aria-label="Volume percent"><span>%</span></label>
      </div>
    </div>
    <div class="mini">
      <img class="np-art" src="" alt="">
      <div class="mini-text"><div class="np-title"></div><div class="mini-sub"></div></div>
      <button class="icon-btn" data-c="devices" title="Devices">${icon('devices')}</button>
      <button class="icon-btn mini-toggle" data-c="toggle" title="Play/Pause">${icon('play', 'i-play')}${icon('pause', 'i-pause')}</button>
      <div class="mini-progress"><i></i></div>
    </div>
    <div class="remote-banner" data-c="devices" hidden>${icon('speaker')}<span></span></div>`;

  $('#fullplayer').innerHTML = `
    ${BACKDROP}
    <header class="fp-head">
      <button class="icon-btn" data-c="close-full" title="Close (Esc)">${icon('down')}</button>
      <div class="fp-head-r">
        <span class="fp-lyr-views">
          <button class="icon-btn" data-c="lyrics-side" title="Show lyrics in the sidebar">${icon('panel')}</button>
        </span>
        <button class="fp-device" data-c="devices" title="Choose where music plays">
          <span class="fp-device-ic"></span>
          <span class="fp-device-text"><span class="fp-speaker"></span><span class="fp-output"></span></span>
        </button>
        <button class="icon-btn fp-fs" data-c="fp-fullscreen" title="Full screen">${icon('fullscreen', 'i-fs')}${icon('fullscreenExit', 'i-fsx')}</button>
        <button class="icon-btn" data-c="item-menu" title="More">${icon('more')}</button>
      </div>
    </header>
    <div class="fp-stage">
      <div class="fp-art-wrap"><img class="fp-art" src="" alt=""></div>
      <div class="fp-meta">
        <div class="fp-text"><div class="np-title"></div><div class="np-artist"></div><div class="fp-album"></div></div>
        <button class="icon-btn love" data-c="love" title="Favorite">${icon('heartOutline', 'i-off')}${icon('heart', 'i-on')}</button>
      </div>
      ${seekHtml('fp-progress')}
      ${controlsHtml('fp-controls')}
      <div class="fp-bottom">
        <button class="icon-btn fp-btn" data-c="fp-lyrics" title="Lyrics">${icon('lyrics')}</button>
        <button class="icon-btn fp-btn" data-c="fp-queue" title="Queue">${icon('queue')}</button>
        <span class="grow"></span>
        <div class="fp-vol">
          <button class="icon-btn fp-btn" data-c="mute" title="Mute">${icon('volume', 'i-vol')}${icon('mute', 'i-mute')}</button>
          <input type="range" class="vol range" min="0" max="100" value="100" aria-label="Volume">
        </div>
      </div>
      <div class="fp-panel" hidden></div>
    </div>`;
}

// ------------------------------------------------------------------ updates

function itemLinks(item) {
  const title = item.albumId ? `<a href="#/album/${esc(item.albumId)}">${esc(item.title)}</a>` : esc(item.title);
  const artistName = artistLink(item);
  return { title, artistName };
}

function update() {
  const s = S.state;
  const item = s.item;
  const body = document.body;
  body.classList.toggle('has-item', !!item);
  body.classList.toggle('is-playing', !!s.isPlaying);
  body.classList.toggle('shuffle-on', !!s.shuffle);
  body.classList.toggle('repeat-on', !!s.repeat);
  body.classList.toggle('repeat-one', s.repeat === 1);

  const { title, artistName } = item ? itemLinks(item) : { title: '', artistName: '' };
  document.querySelectorAll('.np-title').forEach((n) => { n.innerHTML = title; });
  document.querySelectorAll('.np-artist').forEach((n) => { n.innerHTML = artistName; });
  document.querySelectorAll('.mini-sub').forEach((n) => {
    n.innerHTML = S.speaker && !isLocalOnly() ? `${icon('speaker')} ${esc(S.speaker.name)}` : esc(item ? item.artist : '');
  });
  const src = item ? art(item.artwork, 120) : '';
  document.querySelectorAll('.np-art').forEach((n) => {
    // The bar's artwork stays put while the bar folds it away (CSS hides it once nothing is queued).
    if (!item && n.closest('.bar')) return;
    if (n.getAttribute('src') !== src) n.src = src;
    n.hidden = !item;
  });
  // Size the bar for the first real state without animating; animate later changes (queued ↔ empty).
  if (s.ready && !body.classList.contains('bar-anim') && !barAnimPending) {
    barAnimPending = true;
    requestAnimationFrame(() => requestAnimationFrame(() => body.classList.add('bar-anim')));
  }
  const big = $('.fp-art');
  const bigSrc = item ? art(item.artwork, 1000) : '';
  if (big.getAttribute('src') !== bigSrc) big.src = bigSrc;
  $('.fp-album').innerHTML = item && item.album
    ? (item.albumId ? `<a href="#/album/${esc(item.albumId)}">${esc(item.album)}</a>` : esc(item.album)) : '';
  if (fullBackdrop) fullBackdrop(item);
  updateDevicePill(s);

  document.querySelectorAll('.vol').forEach((vol) => {
    if (document.activeElement !== vol) setRange(vol, Math.round((s.volume ?? 1) * 100), 100);
  });
  const pct = $('.vol-pct input');
  if (document.activeElement !== pct) pct.value = Math.round((s.volume ?? 1) * 100);
  body.classList.toggle('muted', (s.volume ?? 1) === 0);

  const banner = $('.remote-banner');
  const remote = S.speaker && !isLocalOnly();
  banner.hidden = !remote;
  if (remote) banner.querySelector('span').innerHTML = `Listening on <b>${esc(S.speaker.name)}</b>`;
  body.classList.toggle('remote', !!remote);

  document.title = item ? `${item.title} • ${item.artist}` : 'Orchard';
  updateLove(item);
  tick();
  markPlaying();
}

let fullBackdrop = null;

const isHeadphones = (label) => /head|bud|pods|wh-|wf-|bose|beats|xm\d/i.test(label || '');

/** The output the speaker plays through, when it isn't the system default: {name, headphones}. */
function currentOutput(s) {
  if (!s.output || !s.outputs) return null;
  const o = s.outputs.find((x) => x.id === s.output);
  if (!o) return null;
  // "Headphones (WH-1000XM6)" → "WH-1000XM6"; "Speakers (Realtek(R) Audio)" → "Realtek(R) Audio".
  const m = o.label.match(/^[^(]+\((.+)\)$/);
  return { name: m ? m[1] : o.label, headphones: isHeadphones(o.label) };
}

/** Full-screen player header: "Playing on <speaker> · <output>", which also opens the device picker. */
function updateDevicePill(s) {
  const out = currentOutput(s);
  const name = S.speaker ? S.speaker.name : 'this device';
  $('.fp-speaker').textContent = name;
  $('.fp-output').textContent = out ? out.name : '';
  const ic = out && out.headphones ? 'headphones' : 'speaker';
  const box = $('.fp-device-ic');
  if (box.dataset.ic !== ic) { box.dataset.ic = ic; box.innerHTML = icon(ic); }
  $('.fp-device').title = `Playing on ${name}${out ? ` (${out.name})` : ''}. Click to change.`;
}

/** True when this window is the app running on the same machine as the speaker. */
function isLocalOnly() {
  return isHostApp && S.info && S.speaker && S.speaker.id === S.info.id;
}

const paintLove = (on) => document.querySelectorAll('.love').forEach((b) => b.classList.toggle('on', !!on));

async function updateLove(item) {
  const id = item && item.catalogId;
  document.querySelectorAll('.love').forEach((b) => { b.hidden = !id || !S.state.authorized; });
  if (!id || !S.state.authorized) return;
  if (loveItemId !== id) {
    loveItemId = id;
    paintLove(lovedCached(id));
    const on = await isLoved(id);
    if (loveItemId === id) paintLove(on);
  }
}

document.addEventListener('loved-changed', (e) => {
  if (e.detail.id === loveItemId) paintLove(e.detail.value);
});

function setRange(input, value, max) {
  input.value = value;
  input.style.setProperty('--p', `${max ? (value / max) * 100 : 0}%`);
}

function tick() {
  const s = S.state;
  const dur = s.duration || (s.item && s.item.duration) || 0;
  const pos = positionNow();
  if (!seeking) {
    document.querySelectorAll('.seek').forEach((r) => setRange(r, dur ? Math.round((pos / dur) * 1000) : 0, 1000));
    document.querySelectorAll('.t-cur').forEach((n) => { n.textContent = fmtTime(pos); });
  }
  document.querySelectorAll('.t-dur').forEach((n) => { n.textContent = fmtTime(dur); });
  const mini = $('.mini-progress i');
  if (mini) mini.style.width = `${dur ? (pos / dur) * 100 : 0}%`;
}

// ------------------------------------------------------------------ controls

const sendVolume = throttle((v) => cmd({ type: 'volume', value: v }, { quiet: true }).catch(() => {}), 150);
let lastVolume = 1;

async function control(c, btn) {
  const s = S.state;
  switch (c) {
    case 'toggle':
      if (!s.item) return;
      patchState({ isPlaying: !s.isPlaying });
      return cmd({ type: 'toggle' });
    case 'next': return cmd({ type: 'next' });
    case 'prev': return cmd({ type: 'prev' });
    case 'shuffle':
      patchState({ shuffle: s.shuffle ? 0 : 1 });
      return cmd({ type: 'shuffle', on: !!S.state.shuffle });
    case 'repeat': {
      // Spotify order: off → all → one → off  (MusicKit: 0 none, 1 one, 2 all)
      const nextMode = s.repeat === 0 ? 2 : s.repeat === 2 ? 1 : 0;
      patchState({ repeat: nextMode });
      return cmd({ type: 'repeat', mode: nextMode });
    }
    case 'mute': {
      const v = s.volume ?? 1;
      if (v > 0) lastVolume = v;
      const nv = v > 0 ? 0 : lastVolume || 1;
      patchState({ volume: nv });
      return cmd({ type: 'volume', value: nv });
    }
    case 'love': {
      const id = s.item && s.item.catalogId;
      if (id) toggleLoved(id).catch(() => {});
      return;
    }
    case 'devices': return openDevices(btn);
    case 'queue':
      closeFull();
      if (window.matchMedia('(min-width: 1100px)').matches) return toggleRight('queue');
      location.hash = location.hash === '#/queue' ? '#/' : '#/queue';
      return;
    case 'lyrics': return toggleLyrics();
    case 'lyrics-side': return showLyrics('side');
    case 'lyrics-widen': return setMainCollapsed(!document.body.classList.contains('main-collapsed'));
    case 'lyrics-full': return showLyrics('full');
    case 'lyrics-close': return closeLyrics();
    case 'seekBack': return seekBy(-seekStep());
    case 'seekFwd': return seekBy(seekStep());
    case 'open-full': return openFull();
    case 'close-full': return closeFull();
    case 'fp-lyrics': return setFullPanel(fullPanel === 'lyrics' ? null : 'lyrics');
    case 'fp-queue': return setFullPanel(fullPanel === 'queue' ? null : 'queue');
    case 'fp-fullscreen':
      if (document.fullscreenElement) return document.exitFullscreen().catch(() => {});
      return document.documentElement.requestFullscreen().catch(() => toast('Full screen isn’t available here'));
    case 'item-menu':
      if (s.item) openMenu(btn, trackMenuItems({ ...fromItem(s.item) }), trackMenuHead(s.item));
      return;
    default:
  }
}

const fullOpen = () => !$('#fullplayer').hidden;

/**
 * Runs a keyboard-shortcut action (see keys.js): toggle, next, prev, mute, seekBack, seekFwd, volUp, volDown,
 * shuffle, repeat, love, lyrics, queue, fullPlayer, closeFull. Returns false when it doesn't apply right now.
 */
export function playerAction(name) {
  let r;
  switch (name) {
    case 'closeFull':
      // Esc by default: leave it to an open menu or popover first.
      if (!fullOpen() || !$('#menu').hidden || !$('#popover').hidden) return false;
      closeFull();
      return true;
    case 'fullPlayer':
      if (fullOpen()) closeFull(); else openFull();
      return true;
    case 'volUp': case 'volDown': {
      if (!S.state.ready) return false;
      const v = Math.min(1, Math.max(0, Math.round(((S.state.volume ?? 1) + (name === 'volUp' ? 0.05 : -0.05)) * 100) / 100));
      patchState({ volume: v });
      sendVolume(v);
      return true;
    }
    case 'love':
      if (!S.state.item || !S.state.item.catalogId) return false;
      r = control('love');
      break;
    case 'lyrics':
      if (fullOpen()) { setFullPanel(fullPanel === 'lyrics' ? null : 'lyrics'); return true; }
      r = control('lyrics');
      break;
    case 'queue':
      if (fullOpen()) { setFullPanel(fullPanel === 'queue' ? null : 'queue'); return true; }
      r = control('queue');
      break;
    default:
      r = control(name);
  }
  if (r && typeof r.catch === 'function') r.catch(() => {}); // errors are already shown as toasts
  return true;
}

function seekBy(delta) {
  const s = S.state;
  if (!s.item) return null;
  const dur = s.duration || s.item.duration || 0;
  const t = Math.max(0, Math.min(dur ? dur - 0.5 : Infinity, positionNow() + delta));
  patchState({ position: t });
  tick();
  return cmd({ type: 'seek', position: t }, { quiet: true });
}

function bindControls() {
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-c]');
    if (!b || !b.closest('#player, #fullplayer, #right, #popover')) return;
    e.preventDefault();
    control(b.dataset.c, b);
  });
  // Following the title/artist link from the full-screen player should reveal that page.
  $('#fullplayer').addEventListener('click', (e) => { if (e.target.closest('.fp-text a, .fp-queue a')) closeFull(); });
  document.addEventListener('fullscreenchange', () => {
    document.body.classList.toggle('doc-fullscreen', !!document.fullscreenElement);
  });
  // Tap on the mini player opens the full-screen player (phones).
  $('.mini').addEventListener('click', (e) => {
    if (e.target.closest('[data-c], a')) return;
    openFull();
  });
  document.querySelectorAll('.seek').forEach((r) => {
    r.addEventListener('input', () => {
      seeking = true;
      const dur = S.state.duration || (S.state.item && S.state.item.duration) || 0;
      r.style.setProperty('--p', `${r.value / 10}%`);
      const t = (r.value / 1000) * dur;
      r.parentElement.querySelector('.t-cur').textContent = fmtTime(t);
    });
    r.addEventListener('change', async () => {
      const dur = S.state.duration || (S.state.item && S.state.item.duration) || 0;
      const t = (r.value / 1000) * dur;
      patchState({ position: t });
      S.state.position = t;
      seeking = false;
      try { await cmd({ type: 'seek', position: t }); } catch (e) { /* toast shown */ }
    });
  });
  const vols = document.querySelectorAll('.vol');
  const pct = $('.vol-pct input');
  const current = () => Math.round((S.state.volume ?? 1) * 100);
  const applyVolume = (percent) => {
    const p = Math.min(100, Math.max(0, Math.round(percent)));
    S.state.volume = p / 100;
    vols.forEach((v) => setRange(v, p, 100));
    if (document.activeElement !== pct || pct.value !== String(p)) pct.value = p;
    document.body.classList.toggle('muted', p === 0);
    sendVolume(p / 100);
  };
  vols.forEach((v) => v.addEventListener('input', () => applyVolume(Number(v.value))));

  // Percent box: type a number (applied on Enter or when leaving the box), ↑/↓ for ±1 (Shift: ±10), or scroll.
  const commit = () => {
    const n = parseInt(pct.value, 10);
    if (Number.isNaN(n)) pct.value = current();
    else if (n !== current()) applyVolume(n);
    else pct.value = n;
  };
  pct.addEventListener('focus', () => pct.select());
  pct.addEventListener('input', () => { pct.value = pct.value.replace(/\D/g, '').slice(0, 3); });
  pct.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); pct.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); pct.value = current(); pct.blur(); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      applyVolume(current() + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1));
      pct.select();
    }
  });
  pct.addEventListener('blur', commit);
  pct.parentElement.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.deltaY) applyVolume(current() + (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 10 : 1));
  }, { passive: false });
}

// ------------------------------------------------------------------ full-screen player

let fullPanel = null;      // what the full-screen player shows beside the artwork: 'lyrics', 'queue' or null
let fullPanelStop = null;
const isPhone = () => window.matchMedia('(max-width: 760px)').matches;

function openFull({ lyrics = false } = {}) {
  if (!S.state.item) return;
  const fp = $('#fullplayer');
  if (fp.hidden) {
    closeDevices();
    fp.hidden = false;
    requestAnimationFrame(() => requestAnimationFrame(() => fp.classList.add('open')));
    history.pushState({ full: true }, '');
    if (lyrics) setFullPanel('lyrics', false);
  } else if (lyrics) {
    setFullPanel('lyrics');
  }
}

/** Hides the player (after its closing animation) and resets lyrics and browser full screen. */
function hideFull() {
  const fp = $('#fullplayer');
  fp.classList.remove('open');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  setTimeout(() => {
    if (fp.classList.contains('open')) return; // reopened meanwhile
    fp.hidden = true;
    setFullPanel(null, false);
  }, 300);
}

function closeFull() {
  if ($('#fullplayer').hidden) return;
  hideFull();
  if (history.state && history.state.full) history.back();
}

/**
 * The panel beside the artwork: lyrics, the queue, or nothing. On a wide screen the artwork, text and controls
 * slide into a left column and the panel fills the right; on a phone the artwork shrinks to a thumbnail above
 * it. The move is animated with a View Transition where the browser has them.
 */
function setFullPanel(mode, animate = true) {
  mode = mode || null;
  if (mode === fullPanel) return;
  const fp = $('#fullplayer');
  const box = $('.fp-panel');
  const apply = () => {
    if (fullPanelStop) { fullPanelStop(); fullPanelStop = null; }
    box.className = 'fp-panel';
    box.innerHTML = '';
    box.scrollTop = 0;
    box.hidden = !mode;
    if (mode === 'lyrics') {
      fullPanelStop = mountLyrics(box, { compact: isPhone() });
    } else if (mode === 'queue') {
      box.classList.add('fp-queue');
      box.innerHTML = '<h2 class="fp-panel-title">Up next</h2><div class="fp-queue-list"></div>';
      fullPanelStop = renderQueue(box.querySelector('.fp-queue-list'), { compact: true });
    }
    fullPanel = mode;
    fp.classList.toggle('panel-on', !!mode);
    fp.classList.toggle('lyrics-on', mode === 'lyrics');
    fp.classList.toggle('queue-on', mode === 'queue');
  };
  const motion = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (animate && motion && document.startViewTransition && !fp.hidden) document.startViewTransition(apply);
  else apply();
}

window.addEventListener('popstate', () => {
  if (!$('#fullplayer').hidden && !(history.state && history.state.full)) hideFull();
});

// ------------------------------------------------------------------ lyrics: sidebar (optionally widened) or full screen

const wide = () => window.matchMedia('(min-width: 1100px)').matches;

/** The bar's lyrics button: open or close the lyrics sidebar (full-screen player on windows too narrow for it). */
function toggleLyrics() {
  if (rightMode === 'lyrics') return closeLyrics();
  return showLyrics('side');
}

/** 'full' opens the full-screen player (a feature of its own, never remembered); 'side' the lyrics sidebar. */
async function showLyrics(view) {
  if (view === 'full' || !wide()) {
    if (rightMode === 'lyrics') toggleRight('lyrics');
    return openFull({ lyrics: true });
  }
  await leaveFull(); // picked from the full-screen player's header
  if (rightMode !== 'lyrics') toggleRight('lyrics');
  return null;
}

/** Closes the full-screen player and waits until its history entry is gone. */
async function leaveFull() {
  if ($('#fullplayer').hidden) return;
  const viaHistory = history.state && history.state.full;
  hideFull();
  if (viaHistory) {
    await new Promise((resolve) => {
      window.addEventListener('popstate', () => resolve(), { once: true });
      history.back();
    });
  }
}

function closeLyrics() {
  if (rightMode === 'lyrics') toggleRight('lyrics');
}

function markLyricsButton() {
  document.querySelectorAll('#player [data-c="lyrics"]').forEach((b) => b.classList.toggle('active', rightMode === 'lyrics'));
}

/**
 * Collapses the middle column so the lyrics sidebar spreads over it (like the left sidebar collapses), or brings
 * it back. Only while lyrics are in the sidebar; going anywhere else brings the page back.
 */
function setMainCollapsed(on) {
  document.body.classList.toggle('main-collapsed', !!on && rightMode === 'lyrics');
}
window.addEventListener('hashchange', () => setMainCollapsed(false));
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="#"]');
  if (a && !a.closest('#right')) setMainCollapsed(false);
});

// ------------------------------------------------------------------ right panel (desktop)

let rightMode = null;
let rightCleanup = null;

function toggleRight(mode) {
  rightMode = rightMode === mode ? null : mode;
  persist('orchard.right', rightMode);
  renderRight();
}

function renderRight() {
  const el = $('#right');
  if (rightCleanup) { rightCleanup(); rightCleanup = null; }
  document.body.classList.toggle('right-open', !!rightMode);
  el.hidden = !rightMode;
  el.classList.toggle('lyrics-mode', rightMode === 'lyrics');
  document.querySelectorAll('[data-c="queue"]').forEach((b) => b.classList.toggle('active', rightMode === 'queue'));
  markLyricsButton();
  if (rightMode !== 'lyrics') setMainCollapsed(false);
  if (!rightMode) { el.innerHTML = ''; return; }
  if (rightMode === 'lyrics') {
    el.innerHTML = `${BACKDROP}<header class="right-head"><h2>Lyrics</h2>${lyricsViewButtons()}</header><div class="right-body"></div>`;
    const paint = backdrop(el.querySelector('.fp-bg'));
    paint(S.state.item);
    const stop = mountLyrics(el.querySelector('.right-body'), { variant: 'side' });
    const unsub = subscribe((k) => { if (k === 'state') paint(S.state.item); });
    rightCleanup = () => { stop(); unsub(); };
    return;
  }
  el.innerHTML = `<header class="right-head"><h2>Queue</h2><button class="icon-btn" data-c="queue" title="Close">${icon('close')}</button></header><div class="right-body"></div>`;
  rightCleanup = renderQueue(el.querySelector('.right-body'), { compact: true });
}

// ------------------------------------------------------------------ devices ("Connect")

const kindIcon = (k) => (k === 'phone' || k === 'tablet' ? 'phone' : 'computer');

function devicesHtml() {
  const current = S.speaker;
  const others = S.speakers.filter((sp) => !current || sp.id !== current.id);
  const remotes = S.devices;
  return `<div class="dev-head"><h3>Connect to a device</h3></div>
    ${current ? `<div class="dev current">${EQ}<div><b>${esc(current.name)}</b><small>${S.state.isPlaying ? 'Playing' : 'Current device'}</small></div></div>` : ''}
    ${outputsHtml()}
    ${others.length ? '<h4>Select a device</h4>' + others.map((sp) => `
      <button class="dev" data-speaker="${esc(sp.id)}">${icon('speaker')}<div><b>${esc(sp.name)}</b><small>Speaker</small></div></button>`).join('')
    : '<p class="dev-note">Run Orchard on another computer on this network and it will show up here as a speaker.</p>'}
    ${remotes.length ? `<h4>Remotes connected</h4>${remotes.map((d) => `
      <div class="dev remote">${icon(kindIcon(d.kind))}<div><b>${esc(d.name)}</b>${d.kind === 'app' ? '<small>App window</small>' : ''}</div></div>`).join('')}` : ''}
    ${pairingHtml()}
    ${S.state.ready && S.state.authorized ? `<button class="text-btn signout" data-a="signout">${icon('logout')} Sign out of Apple Music</button>` : ''}`;
}

/** The sound outputs of the speaker being controlled (its speakers, headphones…), reported by its engine. */
function outputsHtml() {
  const outs = S.state.outputs || [];
  if (outs.length < 2) return '';
  const cur = S.state.output || '';
  const away = S.state.outputWanted && !cur
    ? `<p class="dev-note">${esc(S.state.outputWanted)} isn’t connected. Playing on the system default until it is.</p>` : '';
  return `<h4>Audio output${S.speaker ? ` on ${esc(S.speaker.name)}` : ''}</h4>${away}${outs.map((o) => `
    <button class="dev out${o.id === cur ? ' on' : ''}" data-output="${esc(o.id)}">
      ${icon(isHeadphones(o.label + ' ' + (o.detail || '')) ? 'headphones' : 'speaker')}
      <div><b>${esc(o.label)}</b>${o.detail ? `<small>${esc(o.detail)}</small>` : ''}</div>
      ${o.id === cur ? icon('check', 'tick') : ''}</button>`).join('')}`;
}

const outputsKey = () => JSON.stringify([S.state.outputs, S.state.output, S.state.outputWanted]);

let qrLib = null;
function loadQr() {
  if (!qrLib) {
    qrLib = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/qrcode.js';
      s.onload = () => resolve(window.qrcode);
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  return qrLib;
}

const PAIR_HINTS = {
  lan: 'Your phone must be on the <b>same Wi-Fi/network</b> as this computer.',
  tailscale: 'Works from anywhere: install the <b>Tailscale</b> app on your phone and sign in with the same Tailscale account as this computer.',
  public: 'This computer’s public address. Only works if your network lets other devices connect to it (campus and work networks often block this, and Windows Firewall must allow Orchard on this network).',
};
const PAIR_LABEL = { lan: 'Wi-Fi / LAN', tailscale: 'Tailscale', public: 'Public IP' };
let pairIdx = 0;

function pairingHtml() {
  const list = (S.info && S.info.remotes) || [];
  if (!list.length) {
    return `<h4>Use your phone as a remote</h4><p class="dev-note">No network address found that a phone could reach.
      Connect this computer to Wi-Fi/Ethernet (or Tailscale) and restart Orchard.</p>`;
  }
  if (pairIdx >= list.length) pairIdx = 0;
  const cur = list[pairIdx];
  return `<h4>Use your phone as a remote</h4>
    ${list.length > 1 ? `<div class="pair-tabs">${list.map((r, i) =>
      `<button class="chip${i === pairIdx ? ' on' : ''}" data-pair="${i}">${PAIR_LABEL[r.kind] || r.kind}</button>`).join('')}</div>` : ''}
    <div class="pair"><div class="qr" data-url="${esc(cur.url)}"></div><div><p>Scan with your phone's camera, or open:</p>
      <code>${esc(cur.url)}</code></div></div>
    <p class="pair-hint">${PAIR_HINTS[cur.kind] || ''} No app needed: it opens in your phone's browser. Use “Add to Home screen” for an app icon.</p>`;
}

function renderQr(root) {
  const box = root.querySelector('.qr');
  if (!box) return;
  loadQr().then((qrcode) => {
    const qr = qrcode(0, 'M');
    qr.addData(box.dataset.url);
    qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }).catch(() => box.remove());
}

let devUnsub = null;
function openDevices(anchor) {
  const pop = $('#popover');
  if (!pop.hidden) { closeDevices(); return; }
  const draw = () => { pop.innerHTML = devicesHtml(); renderQr(pop); };
  draw();
  pop.hidden = false;
  if (!window.matchMedia('(max-width: 760px)').matches && anchor && anchor.getBoundingClientRect) {
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(r.left + r.width / 2 - pop.offsetWidth / 2, window.innerWidth - pop.offsetWidth - 8))}px`;
    const above = r.top - pop.offsetHeight - 10;
    pop.style.top = `${above >= 8 ? above : Math.min(r.bottom + 10, window.innerHeight - pop.offsetHeight - 8)}px`;
  } else {
    pop.style.left = pop.style.top = '';
  }
  let outs = outputsKey();
  devUnsub = subscribe((k) => {
    if (k === 'speakers' || k === 'devices' || k === 'speaker') draw();
    else if (k === 'state' && outputsKey() !== outs) { outs = outputsKey(); draw(); }
  });
  pop.onclick = async (e) => {
    const tab = e.target.closest('[data-pair]');
    if (tab) { pairIdx = +tab.dataset.pair; draw(); return; }
    const out = e.target.closest('[data-output]');
    if (out) {
      if (!out.classList.contains('on')) {
        try { await cmd({ type: 'output', id: out.dataset.output }); } catch (err) { /* cmd shows the error */ }
      }
      return;
    }
    const b = e.target.closest('[data-speaker]');
    if (b) {
      const sp = S.speakers.find((x) => x.id === b.dataset.speaker);
      closeDevices();
      if (sp) { toast(`Connecting to ${sp.name}…`); await selectSpeaker(sp); }
      return;
    }
    if (e.target.closest('[data-a="signout"]')) {
      if (!confirm('Sign out of Apple Music on this speaker?')) return;
      try { await post('/api/signout'); } catch (err) { toast(err.message); }
      closeDevices();
    }
  };
  setTimeout(() => document.addEventListener('pointerdown', awayDevices, true));
}

function awayDevices(e) {
  const pop = $('#popover');
  if (!pop.contains(e.target) && !e.target.closest('[data-c="devices"]')) closeDevices();
}

export function closeDevices() {
  const pop = $('#popover');
  pop.hidden = true;
  pop.innerHTML = '';
  if (devUnsub) { devUnsub(); devUnsub = null; }
  document.removeEventListener('pointerdown', awayDevices, true);
}

// ------------------------------------------------------------------ embedded Apple Music page (host app)

let engineForSignIn = false;

export const hasEngineFrame = () => !!document.getElementById('am-engine');

/** Shows/hides Apple's page inside the Orchard window. `forSignIn` auto-hides it once signed in. */
export function setEngineVisible(show, forSignIn = false) {
  if (!hasEngineFrame()) return;
  engineForSignIn = show && (forSignIn || engineForSignIn);
  document.body.classList.toggle('engine-visible', show);
  if (show) closeFull();
  if (!show) document.getElementById('am-engine').blur();
}

export function toggleEngine() {
  setEngineVisible(!document.body.classList.contains('engine-visible'));
}

function onEngineUi(ui) {
  if (!hasEngineFrame()) return;
  if (ui.toggle) toggleEngine();
  else setEngineVisible(!!ui.show, !!ui.show && !S.state.authorized);
}

// ------------------------------------------------------------------ engine status overlay

function updateOverlay() {
  const el = $('#overlay');
  const s = S.state;
  let html = '';
  if (!S.connected && !S.speaker) {
    html = `<div class="ov-card"><div class="spinner"></div><h2>Connecting…</h2></div>`;
  } else if (!s.ready) {
    html = `<div class="ov-card"><div class="spinner"${s.offline ? ' hidden' : ''}></div>
      <h2>${s.offline ? 'Playback unavailable' : 'Starting Apple Music…'}</h2>
      <p>${esc(s.message || 'Loading the Apple Music player.')}</p>${otherSpeakersHtml()}</div>`;
  } else if (!s.authorized) {
    const here = isHostApp && S.speaker && S.info && S.speaker.id === S.info.id;
    html = `<div class="ov-card"><div class="logo-big">${icon('library')}</div>
      <h2>Sign in to Apple Music</h2>
      <p>${here ? 'Music plays through your Apple Music subscription. Apple’s sign-in page opens right here: click its <b>Sign In</b> button and log in with your Apple ID. It closes again as soon as you’re signed in, and you stay signed in next time.'
        : `Sign in on <b>${esc(S.speaker ? S.speaker.name : 'the speaker')}</b>. Pressing the button opens Apple’s sign-in page there.`}</p>
      <button class="btn primary" data-a="signin">Sign in</button>${otherSpeakersHtml()}</div>`;
  }
  el.hidden = !html;
  if (html && el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
  if (!html) el.dataset.html = '';
}

function otherSpeakersHtml() {
  const others = S.speakers.filter((sp) => !S.speaker || sp.id !== S.speaker.id);
  if (!others.length) return '';
  return `<div class="ov-others"><small>Or control another speaker</small>${others.map((sp) =>
    `<button class="dev" data-speaker="${esc(sp.id)}">${icon('speaker')}<div><b>${esc(sp.name)}</b></div></button>`).join('')}</div>`;
}

function bindOverlay() {
  $('#overlay').addEventListener('click', async (e) => {
    const a = e.target.closest('[data-a]');
    const sp = e.target.closest('[data-speaker]');
    try {
      if (a && a.dataset.a === 'signin') {
        if (hasEngineFrame()) setEngineVisible(true, true);
        await post('/api/signin');
        if (!hasEngineFrame()) toast('Opening Apple sign-in…');
      }
      if (sp) await selectSpeaker(S.speakers.find((x) => x.id === sp.dataset.speaker));
    } catch (err) {
      toast(err.message);
    }
  });
}

// ------------------------------------------------------------------ init

export function initPlayer() {
  buildPlayer();
  fullBackdrop = backdrop($('#fullplayer .fp-bg'));
  bindControls();
  bindOverlay();
  // The right panel holds the queue or lyrics ('now' was the old Now-playing panel).
  const savedRight = persist('orchard.right');
  rightMode = wide() && (savedRight === 'queue' || savedRight === 'lyrics') ? savedRight : null;
  renderRight();
  subscribe((kind) => {
    if (kind === 'state' || kind === 'speaker') update();
    if (kind === 'engine-ui') onEngineUi(S.engineUi || {});
    if (kind === 'state' && S.state.authorized && engineForSignIn) setEngineVisible(false);
    updateOverlay();
  });
  $('#engine-back').addEventListener('click', () => setEngineVisible(false));
  setInterval(tick, 250);
  update();
  updateOverlay();
}
