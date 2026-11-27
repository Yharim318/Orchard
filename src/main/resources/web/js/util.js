// Small DOM / formatting helpers shared by every module.

// Orchard used to be called Juice: carry settings saved under the old names ("juice.*") over, once.
// The engine (engine.js) does the same on music.apple.com; the old keys are left for older builds.
try {
  if (!localStorage.getItem('orchard.migrated')) {
    const old = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('juice.')) old.push(k);
    }
    for (const k of old) {
      const k2 = 'orchard.' + k.slice(6);
      if (localStorage.getItem(k2) === null) localStorage.setItem(k2, localStorage.getItem(k));
    }
    localStorage.setItem('orchard.migrated', '1');
  }
} catch (e) { /* storage unavailable */ }

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const PLACEHOLDER = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#26262c"/>' +
  '<path d="M64 24v36a11 11 0 1 1-6-9.8V36l-20 5v25a11 11 0 1 1-6-9.8V30z" fill="#4a4a52"/></svg>');

/**
 * Only image addresses that are safe to paste into HTML attributes and CSS url(): https, our own paths, and data:
 * or blob: images, without quotes, brackets, parentheses, backslashes or spaces. Artwork can come from another
 * speaker on the network, so a crafted value must not be able to break out of src="…" (the app window runs as
 * music.apple.com). Anything else shows the placeholder.
 */
function safeImageUrl(url) {
  if (typeof url !== 'string' || /["'<>()\\\s`]/.test(url)) return null;
  return /^(https:\/\/|\/(?!\/)|data:image\/|blob:)/i.test(url) ? url : null;
}

// In the Orchard window, Apple's pictures come through the Orchard server's artwork cache (ArtCache.java, up to
// 1 GB on disk), so anything seen before shows at once even on a bad connection. Phones load them from Apple
// directly and keep them in their own browser cache. (Same tests as store.js isHostApp / ROOT; util.js can't
// import store.js, which imports this module.)
const CACHE_ART = new URLSearchParams(location.search).has('host');
const ART_ROOT = location.hostname === 'music.apple.com' ? '/orchard' : '';
const viaCache = (url) => (CACHE_ART && /^https:\/\/[a-z0-9-]+\.mzstatic\.com\//i.test(url)
  ? `${ART_ROOT}/api/img?u=${encodeURIComponent(url)}` : url);

/** Apple's own address for a picture at a given pixel size (or null): what art() shows, before the cache. */
export function appleArt(artwork, size = 300) {
  const url = safeImageUrl(typeof artwork === 'string' ? artwork : artwork && artwork.url);
  return url ? url.replace('{w}', size).replace('{h}', size).replace('{c}', 'bb').replace('{f}', 'jpg') : null;
}

/** Resolves an Apple artwork template ({w}x{h}) at a given pixel size. */
export function art(artwork, size = 300) {
  const url = appleArt(artwork, size);
  return url ? viaCache(url) : PLACEHOLDER;
}

// ------------------------------------------------------------------ redraws without blinking pictures

/** What a picture shows: its playlist mosaic, or its address. */
export const pictureKey = (img) => (img.dataset.mosaic ? `m:${img.dataset.mosaic}` : img.getAttribute('src'));

/**
 * Before `fresh` replaces the content of `current`: each new <img> showing the same picture as one already in
 * `current` is swapped for that existing element (moved over, taking the new one's attributes). Pictures that
 * are already decoded stay on screen, instead of new elements blinking grey while they load again.
 */
export function keepPictures(current, fresh) {
  const pool = new Map();
  for (const img of current.querySelectorAll('img')) {
    const k = pictureKey(img);
    if (!k) continue;
    if (!pool.has(k)) pool.set(k, []);
    pool.get(k).push(img);
  }
  if (!pool.size) return;
  for (const img of fresh.querySelectorAll('img')) {
    const old = (pool.get(pictureKey(img)) || []).shift();
    if (!old) continue;
    for (const a of [...old.attributes]) if (a.name !== 'src' && !img.hasAttribute(a.name)) old.removeAttribute(a.name);
    for (const a of [...img.attributes]) if (a.name !== 'src') old.setAttribute(a.name, a.value);
    img.replaceWith(old);
  }
}

/** el.innerHTML = html, keeping the pictures already shown (see keepPictures). */
export function setHtml(el, html) {
  const fresh = document.createElement('div'); // in this document: moved pictures keep their decoded image
  fresh.innerHTML = html;
  keepPictures(el, fresh);
  el.replaceChildren(...fresh.childNodes);
}

/** A CSS colour from Apple's "bgColor" (hex digits), or '' if it is anything else. */
export const hexColor = (c) => (typeof c === 'string' && /^[0-9a-f]{3,8}$/i.test(c) ? `#${c}` : '');

/** Markup for a blurred-artwork backdrop (full-screen player, lyrics page and sidebar); drive it with backdrop(). */
export const BACKDROP = '<div class="fp-bg"><canvas class="fp-bg-art" width="64" height="64"></canvas><canvas class="fp-bg-art" width="64" height="64"></canvas></div>';

/**
 * Returns update(item) for a BACKDROP element: the artwork, heavily blurred, cross-faded on track change.
 * The blur is drawn once into a tiny canvas that CSS stretches over the screen. A CSS blur on the huge, slowly
 * turning layer instead had to be recomputed for every frame, which at full-screen size can starve the page of
 * frames (song changes in the full-screen player showed up late).
 */
export function backdrop(bg) {
  let shown;
  const [a, b] = bg.querySelectorAll('.fp-bg-art');
  return (item) => {
    bg.style.setProperty('--fp-color', item ? hexColor(item.bgColor) : '');
    const url = item && item.artwork ? art(item.artwork, 120) : null; // the size the player bar already loaded
    if (url === shown) return;
    shown = url;
    const next = a.classList.contains('on') ? b : a;
    (next === a ? b : a).classList.remove('on');
    next.classList.remove('on');
    if (!url) return;
    const img = new Image();
    img.onload = () => {
      if (shown !== url) return; // the song changed again meanwhile
      const ctx = next.getContext('2d');
      const n = next.width;
      // Tone (e.g. "saturate(1.7) brightness(.8)") comes from CSS so each place can set its own.
      const tone = getComputedStyle(next).getPropertyValue('--fp-tone').trim();
      ctx.clearRect(0, 0, n, n);
      ctx.filter = `blur(${n / 28}px) ${tone}`;
      ctx.drawImage(img, -n / 8, -n / 8, n * 1.25, n * 1.25); // overdraw so the blur doesn't fade the edges
      next.classList.add('on');
    };
    img.src = url;
  };
}

/** Apple's own address for a wide picture (keeping its aspect ratio), or null. */
export function appleArtWide(artwork, width = 1600) {
  const url = safeImageUrl(artwork && artwork.url);
  if (!url) return null;
  const h = artwork.width && artwork.height ? Math.round((width * artwork.height) / artwork.width) : width;
  return url.replace('{w}', width).replace('{h}', h).replace('{c}', 'bb').replace('{f}', 'jpg');
}

/** Like art() but keeps the artwork's aspect ratio (for wide banners). */
export function artWide(artwork, width = 1600) {
  const url = appleArtWide(artwork, width);
  return url ? viaCache(url) : PLACEHOLDER;
}

export function fmtTime(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function fmtTotal(sec) {
  sec = Math.round(sec || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  if (h) return `${h} hr ${m} min`;
  return `${m} min ${sec % 60} sec`;
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** Rate-limits fn but always delivers the last call. */
export function throttle(fn, ms) {
  let last = 0, t = null, args = null;
  return (...a) => {
    args = a;
    const wait = ms - (Date.now() - last);
    if (wait <= 0) { last = Date.now(); fn(...args); }
    else if (!t) t = setTimeout(() => { t = null; last = Date.now(); fn(...args); }, wait);
  };
}

let toastTimer;
export function toast(msg) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

export function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key));
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) { /* storage unavailable */ }
  return value === undefined ? null : value;
}

export function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

// Material Design icon paths (Apache 2.0).
const P = {
  // Optically centred: halfway between centring its box (looks too far left) and its centre of mass (too far right).
  play: 'M6.75 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 6.75 5.14z',
  pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
  next: 'M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z',
  prev: 'M6 6h2v12H6zm3.5 6l8.5 6V6z',
  shuffle: 'M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z',
  repeat: 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z',
  repeatOne: 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-2V9h-1l-2 1v1h1.5v4H13z',
  volume: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
  mute: 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z',
  devices: 'M4 6h18V4H4c-1.1 0-2 .9-2 2v11H0v3h14v-3H4V6zm19 2h-6c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h6c.55 0 1-.45 1-1V9c0-.55-.45-1-1-1zm-1 9h-4v-7h4v7z',
  speaker: 'M17 2H7c-1.1 0-2 .9-2 1.99v16c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-5 2c1.1 0 2 .9 2 2s-.9 2-2 2c-1.11 0-2-.9-2-2s.89-2 2-2zm0 16c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z',
  phone: 'M17 1.01L7 1c-1.1 0-2 .9-2 2v18c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V3c0-1.1-.9-1.99-2-1.99zM17 19H7V5h10v14z',
  computer: 'M20 18c1.1 0 1.99-.9 1.99-2L22 6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z',
  queue: 'M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z',
  lyrics: 'M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z',
  home: 'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z',
  search: 'M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
  library: 'M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 5h-3v5.5a2.5 2.5 0 0 1-5 0 2.5 2.5 0 0 1 2.5-2.5c.57 0 1.08.19 1.5.51V5h4v2zM4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6z',
  plus: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
  grid: 'M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 0h7v7h-7v-7z',
  list: 'M3 5h2v2H3V5zm4 0h14v2H7V5zM3 11h2v2H3v-2zm4 0h14v2H7v-2zm-4 6h2v2H3v-2zm4 0h14v2H7v-2z',
  sort: 'M3 18h6v-2H3v2zM3 6v2h18V6H3zm0 7h12v-2H3v2z',
  widen: 'M17.59 18L19 16.59 14.42 12 19 7.41 17.59 6l-6 6zM11 18l1.41-1.41L7.83 12l4.58-4.59L11 6l-6 6z',
  narrow: 'M6.41 6L5 7.41 9.58 12 5 16.59 6.41 18l6-6zM13 6l-1.41 1.41L16.17 12l-4.58 4.59L13 18l6-6z',
  heart: 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z',
  heartOutline: 'M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3zm-4.4 15.55l-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5 0 2.89-3.14 5.74-7.9 10.05z',
  more: 'M6 10c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm12 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm-6 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z',
  back: 'M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z',
  forward: 'M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z',
  down: 'M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z',
  playNext: 'M3 10h11v2H3zM3 6h11v2H3zM3 14h7v2H3zM16 13v8l6-4z',
  queueAdd: 'M3 10h11v2H3zM3 6h11v2H3zM3 14h7v2H3zM17 9h2v5h3l-4 5-4-5h3z',
  queueRemove: 'M14 10H3v2h11v-2zm0-4H3v2h11V6zM3 16h7v-2H3v2zm11.41 6L17 19.41 19.59 22 21 20.59 18.41 18 21 15.41 19.59 14 17 16.59 14.41 14 13 15.41 15.59 18 13 20.59z',
  moveTop: 'M8 11h3v10h2V11h3l-4-4-4 4zM4 3v2h16V3H4z',
  playlistAdd: 'M14 10H2v2h12v-2zm0-4H2v2h12V6zm4 8v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zM2 16h8v-2H2v2z',
  libraryAdd: 'M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H8V4h12v12zm-7-2h2v-3h3V9h-3V6h-2v3h-3v2h3z',
  edit: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM5.92 19H5v-.92l9.06-9.06.92.92L5.92 19zM20.71 5.63l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83a1 1 0 0 0 0-1.41z',
  trash: 'M16 9v10H8V9h8m-1.5-6h-5l-1 1H5v2h14V4h-3.5l-1-1zM18 7H6v12c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7z',
  open: 'M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z',
  person: 'M12 5.9c1.16 0 2.1.94 2.1 2.1s-.94 2.1-2.1 2.1S9.9 9.16 9.9 8s.94-2.1 2.1-2.1m0 9c2.97 0 6.1 1.46 6.1 2.1v1.1H5.9V17c0-.64 3.13-2.1 6.1-2.1M12 4C9.79 4 8 5.79 8 8s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm0 9c-2.67 0-8 1.34-8 4v3h16v-3c0-2.66-5.33-4-8-4z',
  album: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-12.5c-2.49 0-4.5 2.01-4.5 4.5s2.01 4.5 4.5 4.5 4.5-2.01 4.5-4.5-2.01-4.5-4.5-4.5zm0 5.5c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1z',
  close: 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  check: 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
  update: 'M21 10.12h-6.78l2.74-2.82c-2.73-2.7-7.15-2.8-9.88-.1-2.73 2.71-2.73 7.08 0 9.79s7.15 2.71 9.88 0C18.32 15.65 19 14.08 19 12.1h2c0 1.98-.88 4.55-2.64 6.29-3.51 3.48-9.21 3.48-12.72 0-3.5-3.47-3.53-9.11-.02-12.58s9.14-3.47 12.65 0L21 3v7.12zM12.5 8v4.25l3.5 2.08-.72 1.21L11 13V8h1.5z',
  up: 'M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z',
  fullscreen: 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z',
  fullscreenExit: 'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z',
  page: 'M14 17H4v2h10v-2zm6-8H4v2h16V9zM4 15h16v-2H4v2zM4 5v2h16V5H4z',
  settings: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.488.488 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.63-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z',
  sidebar: 'M19 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zM9 18H5V6h4v12zm10 0h-8V6h8v12z',
  headphones: 'M12 3a9 9 0 0 0-9 9v7c0 1.1.9 2 2 2h4v-8H5v-1a7 7 0 0 1 14 0v1h-4v8h4c1.1 0 2-.9 2-2v-7a9 9 0 0 0-9-9z',
  clock: 'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z',
  panel: 'M3 5v14h18V5H3zm16 12h-5V7h5v10z',
  logout: 'M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z',
  radio: 'M3.24 6.15C2.51 6.43 2 7.17 2 8v12a2 2 0 0 0 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2H8.3l8.26-3.34L15.88 1 3.24 6.15zM7 20c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm13-8h-2v-2h-2v2H4V8h16v4z',
};

export function icon(name, cls = '') {
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${P[name] || ''}"/></svg>`;
}

export const EQ = '<span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>';
