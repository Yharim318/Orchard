// Playlist thumbnails, in order of preference:
//  1. a picture chosen in Orchard (kept by the Orchard server: Apple's web API can't upload playlist artwork);
//  2. Apple's own artwork;
//  3. a 2×2 mosaic of the first songs' covers, drawn here (like Apple's apps do) and cached.
// Any <img data-mosaic="p.…"> on the page is filled in automatically once its mosaic is ready: the ones on
// screen first, then the rest of the library in the background. Mosaics are kept in IndexedDB, so they show
// at once on the next start.
import { ROOT, am, orchardFetch } from './store.js';
import { art, PLACEHOLDER } from './util.js';

const enc = encodeURIComponent;
const custom = new Map();   // playlist id -> version
const previews = new Map(); // playlist id -> data URL of a picture just chosen here (shown instantly, no reload)
const mosaics = new Map();  // playlist id -> data URL, or '' when the playlist has no covers to show
const building = new Map(); // playlist id -> Promise
const OLD_STORE_KEY = 'orchard.mosaics'; // where mosaics were kept before (localStorage, 80 at most)

// ---- IndexedDB cache: playlist id -> data URL. Everything degrades to the in-memory map if it's unavailable.
let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve) => {
      try {
        const req = indexedDB.open('orchard-artwork', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('mosaics');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch (e) { resolve(null); }
    });
  }
  return dbp;
}
async function dbWrite(fn) {
  const d = await db();
  if (!d) return;
  try { fn(d.transaction('mosaics', 'readwrite').objectStore('mosaics')); } catch (e) { /* quota or closed */ }
}
const save = (id, url) => dbWrite((st) => (url ? st.put(url, id) : st.delete(id)));

// Building waits until the saved mosaics are in (so nothing is drawn twice), but never long: startup and
// pictures must not depend on IndexedDB answering.
let cacheDone = false;
let cacheWait = null;
function whenCacheReady(fn) {
  if (cacheDone) return fn();
  if (!cacheWait) cacheWait = new Promise((r) => setTimeout(r, 1500));
  cacheWait.then(() => { cacheDone = true; fn(); });
}

/**
 * Loads saved mosaics in the background; resolves when they're in (the app waits briefly for this before the
 * first page draws). Anything already on screen is filled in when they arrive.
 */
export function loadMosaicCache() {
  const p = readMosaicCache().catch(() => {}).then(() => {
    cacheDone = true;
    scan(document.body);
    pump();
  });
  cacheWait = Promise.race([p, new Promise((r) => setTimeout(r, 1500))]);
  return p;
}

async function readMosaicCache() {
  // Move mosaics saved by older versions out of localStorage (it's small, and shared with Apple's site).
  try {
    const old = JSON.parse(localStorage.getItem(OLD_STORE_KEY) || '{}');
    for (const [id, url] of Object.entries(old)) {
      if (typeof url === 'string' && url.startsWith('data:image/')) { mosaics.set(id, url); save(id, url); }
    }
    localStorage.removeItem(OLD_STORE_KEY);
  } catch (e) { /* storage unavailable */ }
  const d = await db();
  if (!d) return;
  await new Promise((resolve) => {
    try {
      const st = d.transaction('mosaics', 'readonly').objectStore('mosaics');
      const req = st.openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve();
        if (typeof c.value === 'string' && !mosaics.has(c.key)) mosaics.set(c.key, c.value);
        c.continue();
      };
      req.onerror = () => resolve();
    } catch (e) { resolve(); }
  });
}

export async function loadCustomArtwork() {
  try {
    const r = await orchardFetch(`${ROOT}/api/artwork`);
    if (!r.ok) return;
    const { items } = await r.json();
    custom.clear();
    for (const [id, v] of Object.entries(items || {})) custom.set(id, v);
  } catch (e) { /* older Orchard server: no custom artwork */ }
}

export const hasCustomArtwork = (id) => custom.has(id);
/** Records a playlist's custom picture (version null = removed); `preview` is the picture itself, if at hand. */
export function setCustomArtwork(id, version, preview = null) {
  previews.delete(id);
  if (version == null) { custom.delete(id); return; }
  custom.set(id, version);
  if (preview) previews.set(id, preview);
}

/** Artwork for art() — custom, Apple's, or a cached mosaic — or null when none is known yet. */
export function playlistArtwork(p) {
  if (!p || !p.id) return null;
  if (custom.has(p.id)) return { url: previews.get(p.id) || `${ROOT}/api/artwork/${enc(p.id)}?v=${custom.get(p.id)}` };
  const a = p.attributes && p.attributes.artwork;
  if (a && a.url) return a;
  const m = mosaics.get(p.id);
  return m ? { url: m } : null;
}

/** Playlist id to build a mosaic for (library playlists without artwork), else null. */
export const mosaicFor = (p) => (p && /^p\./.test(p.id || '') && !playlistArtwork(p) ? p.id : null);

/**
 * Call when a playlist's songs change. Its mosaic (if it has one) is rebuilt in the background while the
 * old one stays on screen; every image showing the old one then switches over in place.
 */
export function refreshMosaic(id) {
  if (!mosaics.has(id) || building.has(id)) return;
  const old = mosaics.get(id);
  building.set(id, true);
  buildMosaic(id)
    .then((url) => {
      mosaics.set(id, url);
      save(id, url);
      if (url === old) return;
      for (const img of document.images) {
        if (old && img.src === old) img.src = url || art(null);
      }
      fill(id, url);
    })
    .catch(() => {})
    .finally(() => building.delete(id));
}

/** Forgets a deleted playlist's mosaic. */
export function dropMosaic(id) {
  mosaics.delete(id);
  save(id, null);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous'; // Apple's image CDN allows this, so the canvas stays exportable
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/**
 * Draws a playlist's mosaic. Resolves to '' when the playlist really has no covers; throws when something
 * failed (network, Apple busy) so the caller can try again rather than settle for no picture.
 */
async function buildMosaic(id) {
  let tracks = [];
  try {
    const r = await am(`/v1/me/library/playlists/${enc(id)}/tracks?limit=12`);
    tracks = r.data || [];
  } catch (e) {
    if (e.status !== 404) throw e; // empty playlists answer 404
  }
  const covers = [];
  const seen = new Set();
  for (const t of tracks) {
    const a = t.attributes && t.attributes.artwork;
    if (!a || !a.url || seen.has(a.url)) continue;
    seen.add(a.url);
    covers.push(a);
    if (covers.length === 4) break;
  }
  if (!covers.length) return '';
  const size = 300;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#26262c';
  ctx.fillRect(0, 0, size, size);
  const one = covers.length < 4; // fewer than four different covers: show the first one whole
  const imgs = await Promise.all((one ? covers.slice(0, 1) : covers).map((a) => loadImage(art(a, one ? size : size / 2)).catch(() => null)));
  if (!imgs.some(Boolean)) throw new Error('covers did not load');
  if (one) {
    ctx.drawImage(imgs[0], 0, 0, size, size);
  } else {
    imgs.forEach((img, i) => { if (img) ctx.drawImage(img, (i % 2) * size / 2, Math.floor(i / 2) * size / 2, size / 2, size / 2); });
  }
  try {
    return canvas.toDataURL('image/jpeg', 0.85);
  } catch (e) {
    return ''; // canvas tainted (shouldn't happen with Apple's CDN)
  }
}

function fill(id, url) {
  if (!url) return;
  document.querySelectorAll(`img[data-mosaic="${CSS.escape(id)}"]`).forEach((img) => {
    img.src = url;
    img.removeAttribute('data-mosaic');
    if (watcher) watcher.unobserve(img);
  });
}

// Two queues: playlists whose picture is on (or near) the screen, then everything else.
const CONCURRENCY = 6;
// Waits between attempts after a failure; the last one repeats, so every picture keeps trying until it loads.
const RETRY_MS = [2000, 8000, 30000, 120000];
const urgent = [];
const later = [];
const tries = new Map(); // playlist id -> failed attempts
let running = 0;

let pumpWaiting = false;
function pump() {
  if (!cacheDone) {
    if (!pumpWaiting) { pumpWaiting = true; whenCacheReady(() => { pumpWaiting = false; pump(); }); }
    return;
  }
  while (running < CONCURRENCY && (urgent.length || later.length)) {
    const id = urgent.length ? urgent.shift() : later.shift();
    if (mosaics.has(id)) { building.delete(id); fill(id, mosaics.get(id)); continue; }
    running++;
    buildMosaic(id)
      .then((url) => {
        mosaics.set(id, url);
        tries.delete(id);
        save(id, url);
        fill(id, url);
        building.delete(id);
      })
      .catch(() => {
        // Try again later (an error never counts as "no picture").
        const n = (tries.get(id) || 0) + 1;
        tries.set(id, n);
        setTimeout(() => { (onScreen.has(id) ? urgent : later).push(id); pump(); }, RETRY_MS[Math.min(n, RETRY_MS.length) - 1]);
      })
      .finally(() => { running--; pump(); });
  }
}

function want(id, soon) {
  if (mosaics.has(id)) { fill(id, mosaics.get(id)); return; }
  if (building.has(id)) {
    // Already waiting: move it to the front if it just came on screen.
    if (soon) { const i = later.indexOf(id); if (i >= 0) { later.splice(i, 1); urgent.push(id); } }
    return;
  }
  building.set(id, true);
  if (soon) { urgent.push(id); pump(); return; }
  later.push(id);
  // Give the on-screen check a moment to sort what's visible to the front before starting on the rest.
  clearTimeout(laterTimer);
  laterTimer = setTimeout(pump, 150);
}
let laterTimer = 0;

// Pictures within a screen or so of the viewport go first.
const onScreen = new Set();
const watcher = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
  for (const e of entries) {
    const id = e.target.dataset.mosaic;
    if (!id || !e.target.isConnected) { watcher.unobserve(e.target); continue; }
    if (e.isIntersecting) { onScreen.add(id); want(id, true); } else onScreen.delete(id);
  }
}, { rootMargin: '800px 0px' }) : null;

/** Fills in mosaics for playlist images under `node` (normally automatic when images are added). */
export function scanMosaics(node) { scan(node); }

function scanImg(img) {
  const id = img.dataset.mosaic;
  if (mosaics.has(id)) { fill(id, mosaics.get(id)); return; }
  if (watcher) watcher.observe(img);
  want(id, !watcher);
}

function scan(node) {
  if (node.matches && node.matches('img[data-mosaic]')) scanImg(node);
  if (node.querySelectorAll) node.querySelectorAll('img[data-mosaic]').forEach(scanImg);
}

// A thumbnail that fails to load (network hiccup, Apple's CDN busy) shows the placeholder instead of a broken
// image and keeps trying in the background, waiting longer each time, until it loads or leaves the page.
const IMG_RETRY_MS = [1000, 4000, 15000, 60000];
function onImageError(e) {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !/^https?:/.test(img.src)) return;
  const src = img.src;
  img.src = PLACEHOLDER;
  let n = 0;
  const attempt = () => {
    if (!img.isConnected || img.src !== PLACEHOLDER) return; // gone, or showing something else now
    const probe = new Image();
    probe.onload = () => { if (img.isConnected && img.src === PLACEHOLDER) img.src = probe.src; };
    probe.onerror = () => setTimeout(attempt, IMG_RETRY_MS[Math.min(++n, IMG_RETRY_MS.length - 1)]);
    probe.src = src;
  };
  setTimeout(attempt, IMG_RETRY_MS[0]);
}

/** Watches the page for playlist images that need a mosaic. */
export function initMosaics() {
  document.addEventListener('error', onImageError, true); // image errors don't bubble; catch them on the way down
  scan(document.body);
  new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) scan(n);
  }).observe(document.body, { childList: true, subtree: true });
}
