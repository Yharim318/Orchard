// App shell: routing, sidebar library, global click handling and keyboard shortcuts.
import { $, esc, icon, toast, store as persist } from './util.js';
import { S, init, subscribe, toggleConsole, HOST_PROXY } from './store.js';
import {
  getList, playList, playQueue, openMenu, closeMenu, trackMenuItems, collectionMenuItems, libraryList,
  markPlaying, loading, toggleLoved, queueIndexOf, trackMenuHead,
} from './components.js';
import { routes, libraryRow } from './views.js';
import { initPlayer, closeDevices, toggleEngine, hasEngineFrame, playerAction } from './player.js';
import { openSettings } from './settings.js';
import { initUpdates } from './updates.js';
import { comboOf, actionFor, firstKey } from './keys.js';
import { initShelves } from './shelves.js';
import { initVerticalBars } from './scrollbars.js';
import { isRowDragging } from './queuedrag.js';
import { loadCustomArtwork, loadMosaicCache, initMosaics } from './artwork.js';
import { openPlaylistEditor, findLibraryPlaylist, playlistMenuItems } from './playlists.js';

// ------------------------------------------------------------------ shell

// While the window is being resized, CSS transitions are off (body.resizing) so the layout follows the window
// instead of easing into place on every step.
// Width only: a phone's address bar sliding away changes just the height.
let resizeTimer = 0;
let lastWidth = window.innerWidth;
window.addEventListener('resize', () => {
  if (window.innerWidth === lastWidth) return;
  lastWidth = window.innerWidth;
  document.body.classList.add('resizing');
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => document.body.classList.remove('resizing'), 200);
});

function buildShell() {
  $('#nav').innerHTML = `
    <a class="brand" href="#/"><img src="icon.svg" alt=""><span>Orchard</span></a>
    <a href="#/" data-nav="home" title="Home">${icon('home')}<span>Home</span></a>
    <a href="#/search" data-nav="search" title="Search">${icon('search')}<span>Search</span></a>
    <button class="nav-item" id="open-settings">${icon('settings')}<span>Settings</span></button>`;
  $('#open-settings').addEventListener('click', () => openSettings());
  $('#libhead').innerHTML = `
    <a href="#/library" class="lib-title" title="Your Library">${icon('library')}<span>Your Library</span></a>
    <button class="icon-btn" id="new-playlist" title="Create playlist">${icon('plus')}</button>
    <button class="icon-btn" id="side-toggle">${icon('sidebar')}</button>`;
  $('#side-toggle').addEventListener('click', toggleSidebar);
  setSidebar(persist('orchard.sidebar') === 'collapsed');
  shortcutHints();
  document.addEventListener('keys-changed', shortcutHints);
  $('#tabs').innerHTML = `
    <a href="#/" data-nav="home">${icon('home')}<span>Home</span></a>
    <a href="#/search" data-nav="search">${icon('search')}<span>Search</span></a>
    <a href="#/library" data-nav="library">${icon('library')}<span>Your Library</span></a>`;
  $('#back').innerHTML = icon('back');
  $('#back').addEventListener('click', () => history.back());
}

// ------------------------------------------------------------------ sidebar collapse

/** Collapsed = a narrow rail of icons and artwork, leaving more room for the page. */
function setSidebar(collapsed) {
  document.body.classList.toggle('side-collapsed', collapsed);
  const b = $('#side-toggle');
  if (b) b.title = (collapsed ? 'Expand the sidebar' : 'Collapse the sidebar') + keyHint('sidebar');
}

function toggleSidebar() {
  const collapsed = !document.body.classList.contains('side-collapsed');
  persist('orchard.sidebar', collapsed ? 'collapsed' : 'open');
  setSidebar(collapsed);
}

const keyHint = (id) => { const k = firstKey(id); return k ? ` (${k})` : ''; };

/** Tooltips and the Apple-page bar show the current shortcuts. */
function shortcutHints() {
  $('#open-settings').title = 'Settings' + keyHint('settings');
  setSidebar(document.body.classList.contains('side-collapsed'));
  const kbd = $('#engine-back kbd');
  if (kbd) { kbd.textContent = firstKey('apple'); kbd.hidden = !kbd.textContent; }
}

// ------------------------------------------------------------------ sidebar library

let libKind = persist('orchard.libKind') || 'playlists';
// A failed load tries again by itself, waiting longer each time (Apple Music can still be starting up).
let libRetry = 0;
let libRetryDelay = 0;

async function renderSidebarLibrary({ retry = false } = {}) {
  clearTimeout(libRetry);
  if (!retry) libRetryDelay = 0;
  const chips = $('#lib-chips');
  chips.innerHTML = ['playlists', 'albums', 'artists'].map((k) =>
    `<button class="chip${k === libKind ? ' on' : ''}" data-k="${k}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('');
  const list = $('#lib-list');
  const songsLink = `<a class="lib-item songs-link" href="#/favorites" title="Favorite Songs"><span class="songs-ic">${icon('heart')}</span><div><div class="t">Favorite Songs</div><div class="s">Synced with Apple Music</div></div></a>
    <a class="lib-item songs-link" href="#/songs" title="Songs"><span class="songs-ic all">${icon('library')}</span><div><div class="t">Songs</div><div class="s">Everything in your library</div></div></a>`;
  if (!S.state.ready || !S.state.authorized) {
    list.innerHTML = '<p class="dev-note">Sign in to see your library.</p>';
    return;
  }
  // Show the loading dots only when switching lists; a refresh of the same list swaps in quietly.
  const shown = list.dataset.kind === libKind && list.querySelector('.lib-item:not(.songs-link)');
  if (!shown && !retry) list.innerHTML = songsLink + loading(); // a retry keeps the error up until it works
  list.dataset.kind = libKind;
  const kind = libKind;
  try {
    const items = await libraryList(kind);
    if (kind !== libKind) return; // switched lists meanwhile
    const html = songsLink + (items.length ? items.map(libraryRow).join('') : `<p class="dev-note">No ${kind} yet.</p>`);
    if (list.dataset.html !== html) {
      list.innerHTML = html;
      list.dataset.html = html;
    }
    highlightNav();
    libRetryDelay = 0;
  } catch (e) {
    if (kind !== libKind) return;
    if (!shown) list.innerHTML = songsLink + `<p class="dev-note">Couldn't load your library (${esc(e.message)}). Trying again…</p>`;
    libRetryDelay = Math.min(libRetryDelay ? libRetryDelay * 2 : 1000, 30000);
    libRetry = setTimeout(() => renderSidebarLibrary({ retry: true }), libRetryDelay);
  }
}

function bindSidebar() {
  $('#lib-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-k]');
    if (!b) return;
    libKind = b.dataset.k;
    persist('orchard.libKind', libKind);
    renderSidebarLibrary();
  });
  $('#new-playlist').addEventListener('click', () => openPlaylistEditor());
  document.addEventListener('library-changed', () => {
    renderSidebarLibrary();
    if ((location.hash || '').startsWith('#/library')) softRefresh();
  });
  // Something on the current page changed: redraw it quietly where you were.
  document.addEventListener('view-refresh', () => softRefresh());
  // A playlist changed. Its own page updates itself in place; other pages showing it redraw quietly.
  document.addEventListener('playlist-changed', (e) => {
    const c = e.detail || {};
    if (location.hash === `#/playlist/${encodeURIComponent(c.id)}`) return;
    if (c.details || c.artwork) softRefresh();
  });
}

// ------------------------------------------------------------------ routing

let cleanup = null;
let routeSeq = 0;

async function route() {
  closeMenu();
  closeDevices();
  const hash = location.hash || '#/';
  const seq = ++routeSeq;
  if (cleanup) { try { cleanup(); } catch (e) { /* ignore */ } cleanup = null; }
  const main = $('#main');
  const view = $('#view');
  for (const [re, fn] of routes) {
    const m = hash.match(re);
    if (!m) continue;
    main.scrollTop = 0;
    document.body.dataset.route = hash.split('/')[1] || 'home';
    highlightNav();
    try {
      const c = await fn(view, m);
      if (seq !== routeSeq) { if (typeof c === 'function') c(); return; }
      cleanup = typeof c === 'function' ? c : null;
    } catch (e) {
      console.error(e);
      if (seq === routeSeq) view.innerHTML = `<div class="empty"><h3>Something went wrong</h3><p>${esc(e.message)}</p></div>`;
    }
    return;
  }
  view.innerHTML = '<div class="empty"><h3>Page not found</h3></div>';
}

/**
 * Redraws the current page off-screen and swaps it in once it's ready: no loading flash, same scroll
 * position. Several requests in quick succession are combined into one.
 */
let softTimer = 0;
function softRefresh() {
  clearTimeout(softTimer);
  // Not while a song is being dragged: the redraw would pull the row out from under the pointer.
  softTimer = setTimeout(() => (isRowDragging() ? softRefresh() : doSoftRefresh()), isRowDragging() ? 300 : 60);
}

async function doSoftRefresh() {
  const hash = location.hash || '#/';
  const seq = ++routeSeq;
  const main = $('#main');
  const view = $('#view');
  for (const [re, fn] of routes) {
    const m = hash.match(re);
    if (!m) continue;
    const next = document.createElement('div');
    let c;
    try {
      c = await fn(next, m, { soft: true, minTracks: view.querySelectorAll('.tracks .row:not(.head)').length });
    } catch (e) {
      console.error(e);
      return;
    }
    if (seq !== routeSeq || (location.hash || '#/') !== hash) { if (typeof c === 'function') c(); return; }
    if (next.querySelector('.loading') && !view.querySelector('.loading')) { if (typeof c === 'function') c(); return; } // not ready: keep what's shown
    const top = main.scrollTop;
    if (cleanup) { try { cleanup(); } catch (e) { /* ignore */ } }
    cleanup = typeof c === 'function' ? c : null;
    // Swap the whole container (not just its contents): the page keeps references to the element it drew into.
    next.id = 'view';
    view.replaceWith(next);
    main.scrollTop = top;
    markPlaying();
    return;
  }
}

function highlightNav() {
  const hash = location.hash || '#/';
  const section = hash.startsWith('#/search') ? 'search' : hash.startsWith('#/library') || hash === '#/songs' || hash === '#/favorites' ? 'library' : hash === '#/' || hash === '' ? 'home' : '';
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === section));
  document.querySelectorAll('#lib-list .lib-item').forEach((a) => a.classList.toggle('on', a.getAttribute('href') === hash));
}

// ------------------------------------------------------------------ global clicks

function parseJson(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

const isTouch = () => window.matchMedia('(pointer: coarse)').matches;

function bindGlobalClicks() {
  document.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (act) {
      e.preventDefault();
      e.stopPropagation();
      const a = act.dataset.act;
      if (a === 'play-q') {
        const q = parseJson(act.dataset.q);
        if (q) playQueue(q).catch(() => {});
      } else if (a === 'row-play') {
        const row = act.closest('.row');
        playRow(row);
      } else if (a === 'row-love') {
        const row = act.closest('.row');
        if (row && row.dataset.cid) toggleLoved(row.dataset.cid).catch(() => {});
      } else if (a === 'row-menu') {
        const row = act.closest('.row');
        const L = getList(row.dataset.list);
        const t = L && L.tracks[+row.dataset.i];
        if (t) openMenu(act, trackMenuItems(t, { queueIndex: queueIndexOf(row), playlist: L.ctx.playlist }), trackMenuHead(t));
      }
      return;
    }
    const href = e.target.closest('[data-href]');
    if (href && !e.target.closest('a')) {
      location.hash = href.dataset.href;
      return;
    }
    // On touch screens a single tap on a track plays it (desktop uses double-click like Spotify).
    const row = e.target.closest('.row[data-list]');
    if (row && isTouch() && !e.target.closest('a, button')) playRow(row);
  });

  document.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.row[data-list]');
    if (row && !e.target.closest('a, button')) playRow(row);
  });

  document.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.row[data-list]');
    const card = e.target.closest('[data-card]');
    if (row) {
      const L = getList(row.dataset.list);
      const t = L && L.tracks[+row.dataset.i];
      if (!t) return;
      e.preventDefault();
      openMenu({ x: e.clientX, y: e.clientY, getBoundingClientRect: () => ({ left: e.clientX, right: e.clientX + 220, top: e.clientY, bottom: e.clientY }) }, trackMenuItems(t, { queueIndex: queueIndexOf(row), playlist: L.ctx.playlist }), trackMenuHead(t));
    } else if (card) {
      const c = parseJson(card.dataset.card);
      if (!c) return;
      e.preventDefault();
      const at = { getBoundingClientRect: () => ({ left: e.clientX, right: e.clientX + 220, top: e.clientY, bottom: e.clientY }) };
      const items = collectionMenuItems(c);
      if (/^p\./.test(c.id || '')) {
        // Library playlist: add Edit / Delete (needs its details).
        findLibraryPlaylist(c.id).then((p) => openMenu(at, items.concat(playlistMenuItems(p)), p ? p.attributes.name : ''))
          .catch(() => items.length && openMenu(at, items));
        return;
      }
      if (items.length) openMenu(at, items);
    }
  });
}

function playRow(row) {
  if (!row || row.classList.contains('disabled')) return;
  playList(row.dataset.list, +row.dataset.i).catch(() => {});
}

/** Runs a shortcut's action. Returns false when it doesn't apply here, so the key keeps its normal job. */
function runAction(action) {
  switch (action) {
    case 'apple':
      if (!hasEngineFrame()) return false;
      toggleEngine();
      return true;
    case 'log':
      if (!HOST_PROXY) return false;
      toggleConsole()
        .then((r) => { if (r === 'unavailable') toast('The log window is only available on Windows'); })
        .catch((err) => toast(err.message));
      return true;
    case 'settings': openSettings(); return true;
    case 'search': location.hash = '#/search'; return true;
    case 'sidebar': toggleSidebar(); return true;
    default: return playerAction(action);
  }
}

const REPEATS = new Set(['seekBack', 'seekFwd', 'volUp', 'volDown']); // keep going while the key is held

function bindKeys() {
  document.addEventListener('keydown', (e) => {
    const action = actionFor(comboOf(e));
    if (!action) return;
    // In a text box only Ctrl/Alt shortcuts count (typing letters, arrows or Esc does its normal thing).
    // Sliders don't count as text boxes: the shortcuts win there.
    const typing = e.target.closest('input:not([type="range"]), textarea, select, [contenteditable]');
    if (typing && !(e.ctrlKey || e.metaKey || e.altKey)) return;
    // A dialog is open (it has its own keys): only the Apple page / log window shortcuts get through.
    if (document.querySelector('.dlg-back') && action !== 'apple' && action !== 'log') return;
    if (e.repeat && !REPEATS.has(action)) { e.preventDefault(); return; }
    if (runAction(action)) e.preventDefault();
  });
}

// ------------------------------------------------------------------ boot

async function boot() {
  buildShell();
  initUpdates();
  initPlayer();
  initShelves();
  initVerticalBars();
  bindSidebar();
  bindGlobalClicks();
  bindKeys();
  initMosaics();
  window.addEventListener('hashchange', route);
  let wasReady = false;
  subscribe((kind) => {
    const ready = !!(S.state.ready && S.state.authorized);
    if (kind === 'state' && ready !== wasReady) {
      wasReady = ready;
      renderSidebarLibrary();
      if (ready) route();
    }
    if (kind === 'state') markPlaying();
  });
  // Saved mosaics usually load in a few ms; don't hold up startup if the browser's storage is slow.
  await Promise.all([loadCustomArtwork(), Promise.race([loadMosaicCache(), new Promise((r) => setTimeout(r, 250))])]);
  try {
    await init();
  } catch (e) {
    $('#view').innerHTML = `<div class="empty"><h3>Can't connect</h3><p>${esc(e.message)}</p></div>`;
    return;
  }
  renderSidebarLibrary();
  route();
}

boot();
