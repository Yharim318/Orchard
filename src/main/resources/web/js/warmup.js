// Start-up warm-up (Orchard window only). Once Apple Music is ready, quietly loads every page of your library
// ahead of time: the library lists, home, every playlist (all its songs), album, artist and the Songs list, plus
// their pictures. Clicking something then never waits for the network: the data comes from the API cache
// (store.js) and the pictures from the server's artwork cache (ArtCache.java).
//
// - Data uses the same addresses the pages read (views.js PAGE_PATHS); a copy younger than MAX_AGE_MS is not
//   fetched again, so later starts mostly just check. Pages still refresh what they show (store.js am()).
// - Pictures are handed to the server in batches; it downloads them in the background and stops taking new ones
//   at 85% of its limit, so the warm-up never pushes out pictures that were actually looked at.
// - Two requests at a time with small gaps: Apple's player shares this window's main thread, and Apple limits
//   request rates. Failed requests are tried again a few times, waiting longer each time.
// - Phones don't run it: they'd fetch the whole library through this computer on every start.
// Not warmed: lyrics (one request per song) and the music itself.
import { S, subscribe, prefetch, isHostApp, ROOT, orchardFetch } from './store.js';
import { appleArt, appleArtWide } from './util.js';
import { libraryList, toTrack, toCard } from './components.js';
import { PAGE_PATHS, withLimit } from './views.js';
import { playlistArtwork } from './artwork.js';

const MAX_AGE_MS = 12 * 3600 * 1000;
const WORKERS = 2;
const GAP_MS = 40;
const RETRY_MS = [5000, 20000, 60000];
const PIC_BATCH = 100;
const START_DELAY_MS = 3000; // let the first page and the sidebar load first

// Picture sizes, matching what the pages show (views.js / components.js / app.js).
const SIZE = { row: 96, quick: 120, card: 300, hero: 480, banner: 2000 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = () => !!(S.state.ready && S.state.authorized);
let running = false;

export function initWarmup() {
  if (!isHostApp) return;
  let last = 0;
  const go = () => {
    if (running || !alive() || Date.now() - last < MAX_AGE_MS) return;
    running = true;
    last = Date.now();
    setTimeout(() => run().catch((e) => console.warn('[orchard] warm-up stopped:', e)).finally(() => { running = false; }), START_DELAY_MS);
  };
  subscribe((kind) => { if (kind === 'state') go(); });
  go();
}

// ------------------------------------------------------------------ pictures

const picsSent = new Set();
let pending = [];
let picsFull = false;

function pic(url) {
  if (!url || picsFull || picsSent.has(url) || !/^https:\/\/[a-z0-9-]+\.mzstatic\.com\//i.test(url)) return;
  picsSent.add(url);
  pending.push(url);
  if (pending.length >= PIC_BATCH) flushPics();
}

let sending = Promise.resolve();
function flushPics() {
  if (!pending.length || picsFull) return sending;
  const urls = pending;
  pending = [];
  sending = sending.then(() => sendPics(urls));
  return sending;
}

async function sendPics(urls) {
  for (let i = 0; !picsFull; i++) {
    try {
      const res = await orchardFetch(ROOT + '/api/img/warm', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ urls }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let st = await res.json();
      picsFull = !!st.full;
      // Don't pile up thousands of downloads at once: wait while the server is busy with earlier ones.
      while (!picsFull && st.pending > 300) {
        await sleep(2000);
        st = await (await orchardFetch(ROOT + '/api/img/warm', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"urls":[]}',
        })).json();
        picsFull = !!st.full;
      }
      return;
    } catch (e) {
      if (i >= RETRY_MS.length) return;
      await sleep(RETRY_MS[i]);
    }
  }
}

const cardPics = (r, ...sizes) => {
  const c = toCard(r);
  if (c) sizes.forEach((s) => pic(appleArt(c.artwork, s)));
};
const trackPics = (data) => (data || []).forEach((r) => pic(appleArt(toTrack(r).artwork, SIZE.row)));

// ------------------------------------------------------------------ data

/** prefetch() with retries; null when it can't be had (or Apple has nothing there). */
async function data(path) {
  for (let i = 0; ; i++) {
    if (!alive()) throw new Error('signed out or Apple Music stopped');
    try {
      return await prefetch(path, MAX_AGE_MS);
    } catch (e) {
      if (i >= RETRY_MS.length) return null;
      await sleep(e.status === 429 ? Math.max(30000, RETRY_MS[i]) : RETRY_MS[i]);
    }
  }
}

/** Runs `fn` over `items`, WORKERS at a time, with a small gap between requests. */
async function each(items, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: WORKERS }, async () => {
    while (i < items.length) {
      if (!alive()) return;
      const item = items[i++];
      try { await fn(item); } catch (e) { if (!alive()) return; }
      await sleep(GAP_MS);
    }
  }));
}

/** Follows a list's "next" links to the end (the pages ask for further pages with withLimit, so this does too). */
async function allPages(next, onPage) {
  for (let path = withLimit(next); path && alive(); ) {
    const r = await data(path);
    if (!r) return;
    onPage(r.data || []);
    path = withLimit(r.next);
    await sleep(GAP_MS);
  }
}

const first = (r) => (r && r.data && r.data[0]) || null;

async function playlistPage(id) {
  const d = first(await data(PAGE_PATHS.playlist(id)));
  if (!d) return;
  const art = playlistArtwork(d);
  if (art) pic(appleArt(art, SIZE.hero));
  const rel = (d.relationships && d.relationships.tracks) || {};
  if (rel.data) {
    trackPics(rel.data);
    await allPages(rel.next, trackPics);
  } else if (id.startsWith('p.')) {
    const t = await data(PAGE_PATHS.playlistTracks(id)); // an empty playlist answers 404 (null)
    if (t) {
      trackPics(t.data);
      await allPages(t.next, trackPics);
    }
  }
}

async function albumPage(id) {
  const d = first(await data(PAGE_PATHS.album(id)));
  if (d && d.attributes) pic(appleArt(d.attributes.artwork, SIZE.hero));
}

/** Pictures further down artist pages (their album shelves): least likely to be needed, so sent last. */
const laterPics = [];

async function catalogArtistPage(id) {
  const d = first(await data(PAGE_PATHS.artist(id)));
  if (!d || !d.attributes) return;
  const a = d.attributes;
  const ed = a.editorialArtwork || {};
  const banner = ed.bannerUber || ed.centeredFullscreenBackground || ed.fullscreenBackground;
  pic(banner ? appleArtWide(banner, SIZE.banner) : appleArt(a.artwork, SIZE.hero));
  const v = d.views || {};
  trackPics(((v['top-songs'] && v['top-songs'].data) || []).slice(0, 10));
  for (const k of ['latest-release', 'full-albums', 'singles', 'featured-playlists', 'appears-on-albums', 'similar-artists']) {
    for (const r of (v[k] && v[k].data) || []) {
      const c = toCard(r);
      if (c) laterPics.push(appleArt(c.artwork, SIZE.card));
    }
  }
}

async function libraryArtistPage(r) {
  const d = first(await data(PAGE_PATHS.libraryArtist(r.id)));
  const cat = d && d.relationships && d.relationships.catalog && d.relationships.catalog.data && d.relationships.catalog.data[0];
  if (cat) return catalogArtistPage(cat.id);
  const albums = await data(PAGE_PATHS.libraryArtistAlbums(r.id));
  ((albums && albums.data) || []).forEach((x) => cardPics(x, SIZE.card));
}

// ------------------------------------------------------------------ the run

async function run() {
  const t0 = performance.now();
  // 1. The library lists (sidebar and Library page) and their thumbnails.
  const [playlists, albums, artists] = await Promise.all(['playlists', 'albums', 'artists']
    .map((k) => libraryList(k).catch(() => [])));
  for (const r of [...playlists, ...albums, ...artists]) cardPics(r, SIZE.row, SIZE.card);
  flushPics();

  // 2. Home.
  const home = await Promise.all(PAGE_PATHS.home().map((p) => data(p)));
  const [recent, recs, charts] = home;
  ((recent && recent.data) || []).forEach((r) => cardPics(r, SIZE.quick));
  const homeItems = [];
  for (const rec of (recs && recs.data) || []) {
    const items = (rec.relationships && rec.relationships.contents && rec.relationships.contents.data) || [];
    items.forEach((r) => { cardPics(r, SIZE.card); homeItems.push(r); });
  }
  const ch = (charts && charts.results) || {};
  if (ch.songs && ch.songs[0]) trackPics(ch.songs[0].data);
  for (const k of ['albums', 'playlists']) {
    ((ch[k] && ch[k][0] && ch[k][0].data) || []).forEach((r) => { cardPics(r, SIZE.card); homeItems.push(r); });
  }
  flushPics();

  // 3. Every playlist, album and artist in the library, then all songs.
  await each(playlists, (r) => playlistPage(r.id));
  flushPics();
  await each(albums, (r) => albumPage(r.id));
  flushPics();
  // Songs: the same pages the Library page's Songs tab reads (libraryList), so they land in the same cache entries.
  const songs = await libraryList('songs').catch(() => []);
  trackPics(songs);
  flushPics();
  await each(artists, (r) => libraryArtistPage(r));
  flushPics();

  // 4. Albums and playlists shown on Home, then the rest of the artist pages' pictures.
  await each(homeItems.filter((r) => /albums|playlists/.test(r.type || '')),
    (r) => ((r.type || '').includes('playlists') ? playlistPage(r.id) : albumPage(r.id)));
  laterPics.forEach(pic);
  await flushPics();
  console.info(`[orchard] warm-up done in ${Math.round((performance.now() - t0) / 1000)} s: ${playlists.length} playlists, `
    + `${albums.length} albums, ${artists.length} artists, ${picsSent.size} pictures${picsFull ? ' (artwork cache nearly full)' : ''}`);
}
