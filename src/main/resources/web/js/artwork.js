// Playlist thumbnails, in order of preference:
//  1. a picture chosen in Orchard (kept by the Orchard server: Apple's web API can't upload playlist artwork);
//  2. Apple's own artwork;
//  3. a 2×2 mosaic of the first songs' covers, drawn here (like Apple's apps do) and cached.
// Any <img data-mosaic="p.…"> on the page is filled in automatically once its mosaic is ready.
import { ROOT, am } from './store.js';
import { art } from './util.js';

const enc = encodeURIComponent;
const custom = new Map();   // playlist id -> version
const previews = new Map(); // playlist id -> data URL of a picture just chosen here (shown instantly, no reload)
const mosaics = new Map();  // playlist id -> data URL, or '' when the playlist has no covers to show
const building = new Map(); // playlist id -> Promise
const STORE_KEY = 'orchard.mosaics';
const STORE_MAX = 80;

try {
  const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
  for (const [id, url] of Object.entries(saved)) if (typeof url === 'string' && url.startsWith('data:image/')) mosaics.set(id, url);
} catch (e) { /* storage unavailable */ }

function persist() {
  try {
    const keep = [...mosaics].filter(([, url]) => url).slice(-STORE_MAX);
    localStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(keep)));
  } catch (e) { /* full or unavailable: the in-memory copy still works */ }
}

export async function loadCustomArtwork() {
  try {
    const r = await fetch(`${ROOT}/api/artwork`);
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
      persist();
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
  if (mosaics.delete(id)) persist();
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

async function buildMosaic(id) {
  let tracks = [];
  try {
    const r = await am(`/v1/me/library/playlists/${enc(id)}/tracks?limit=12`);
    tracks = r.data || [];
  } catch (e) { /* empty playlists answer 404 */ }
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
  if (one) {
    if (!imgs[0]) return '';
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
  });
}

let running = 0;
const queue = [];
function pump() {
  while (running < 3 && queue.length) {
    const id = queue.shift();
    running++;
    buildMosaic(id)
      .then((url) => {
        mosaics.set(id, url);
        if (url) persist();
        fill(id, url);
      })
      .catch(() => mosaics.set(id, ''))
      .finally(() => { running--; building.delete(id); pump(); });
  }
}

function want(id) {
  if (mosaics.has(id)) { fill(id, mosaics.get(id)); return; }
  if (building.has(id)) return;
  building.set(id, true);
  queue.push(id);
  pump();
}

/** Fills in mosaics for playlist images under `node` (normally automatic when images are added). */
export function scanMosaics(node) { scan(node); }

function scan(node) {
  if (node.matches && node.matches('img[data-mosaic]')) want(node.dataset.mosaic);
  if (node.querySelectorAll) node.querySelectorAll('img[data-mosaic]').forEach((img) => want(img.dataset.mosaic));
}

/** Watches the page for playlist images that need a mosaic. */
export function initMosaics() {
  scan(document.body);
  new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) scan(n);
  }).observe(document.body, { childList: true, subtree: true });
}
