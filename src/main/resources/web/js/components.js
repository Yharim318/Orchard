// Shared building blocks: data mapping, track lists, cards, context menus and play actions.
import { $, esc, art, fmtTime, icon, EQ, toast } from './util.js';
import { S, am, amWrite, cmd, patchState } from './store.js';
import { playlistArtwork, mosaicFor, refreshMosaic } from './artwork.js';
import { openPlaylistEditor, removeFromPlaylist } from './playlists.js';

// ------------------------------------------------------------------ data mapping

const albumIdFromUrl = (url) => {
  const m = (url || '').match(/\/album\/(?:[^/]+\/)?(\d+)/);
  return m ? m[1] : null;
};

export function toTrack(r) {
  const a = r.attributes || {};
  const pp = a.playParams || null;
  const rel = r.relationships || {};
  const catalogId = pp ? (pp.catalogId || (pp.isLibrary ? null : pp.id)) : null;
  return {
    id: r.id,
    type: r.type,
    playId: pp ? pp.id : null,
    catalogId,
    title: a.name || '',
    artist: a.artistName || '',
    album: a.albumName || '',
    artwork: a.artwork,
    duration: (a.durationInMillis || 0) / 1000,
    explicit: a.contentRating === 'explicit',
    albumId: (rel.albums && rel.albums.data && rel.albums.data[0] && rel.albums.data[0].id) || albumIdFromUrl(a.url),
    artistId: (rel.artists && rel.artists.data && rel.artists.data[0] && rel.artists.data[0].id) || null,
    disc: a.discNumber || 1,
    num: a.trackNumber || null,
    playable: !!pp,
    isLibrary: !!(pp && pp.isLibrary),
  };
}

/** The id MusicKit should be given for a track (prefer catalog ids, which work everywhere). */
export const qid = (t) => t.catalogId || t.playId || t.id;

export function toCard(r) {
  if (!r || !r.attributes) return null;
  const a = r.attributes;
  const t = r.type || '';
  const pp = a.playParams;
  const c = {
    id: r.id,
    type: t,
    title: a.name || (a.title && a.title.stringForDisplay) || '',
    artwork: a.artwork,
    sub: '',
    round: false,
    href: null,
    play: pp ? { [pp.kind || 'album']: pp.id } : null,
  };
  if (t.includes('albums')) {
    c.href = `#/album/${r.id}`;
    c.sub = a.artistName || 'Album';
    c.play = c.play || { album: r.id };
  } else if (t.includes('playlists')) {
    c.href = `#/playlist/${r.id}`;
    c.artwork = playlistArtwork(r);
    c.mosaic = mosaicFor(r);
    c.sub = a.curatorName || (t.startsWith('library') ? 'Playlist' : 'Apple Music');
    c.play = c.play || { playlist: r.id };
  } else if (t.includes('artists')) {
    c.href = `#/artist/${r.id}`;
    c.sub = 'Artist';
    c.round = true;
    c.play = null;
  } else if (t === 'stations') {
    c.sub = a.isLive ? 'Live radio' : 'Station';
    c.play = { station: r.id };
  } else if (t === 'songs' || t === 'library-songs') {
    const albumId = albumIdFromUrl(a.url);
    c.href = albumId ? `#/album/${albumId}` : null;
    c.sub = a.artistName || 'Song';
    c.play = { song: (pp && (pp.catalogId || pp.id)) || r.id };
  } else {
    return null;
  }
  return c;
}

// ------------------------------------------------------------------ track lists

const lists = new Map();
let listSeq = 0;

/** Remembers a rendered track list so clicks can play it with the right queue context. */
export function registerList(tracks, ctx = {}) {
  const key = 'L' + (++listSeq);
  lists.set(key, { tracks, ctx });
  if (lists.size > 300) lists.delete(lists.keys().next().value);
  return key;
}
export const getList = (key) => lists.get(key);

export async function playList(key, index, { shuffle = false } = {}) {
  const L = lists.get(key);
  if (!L) return;
  if (L.ctx.queueOffset != null) {
    await cmd({ type: 'jump', index: L.ctx.queueOffset + index });
    return;
  }
  const playable = L.tracks.filter((t) => t.playable);
  if (!playable.length) { toast('Nothing playable here'); return; }
  const start = index == null ? undefined : L.tracks.slice(0, index).filter((t) => t.playable).length;
  const queue = L.ctx.collection || { songs: playable.map(qid) };
  await cmd({ type: 'playQueue', queue, startIndex: shuffle ? undefined : start, shuffle });
}

// ------------------------------------------------------------------ queue editing

/** Absolute queue index of a rendered queue row, or -1 when the row isn't part of the queue view. */
export function queueIndexOf(row) {
  const L = row && getList(row.dataset.list);
  return L && L.ctx.queueOffset != null ? L.ctx.queueOffset + Number(row.dataset.i) : -1;
}

/** True when `index` is a song after the one playing (only those can be removed or moved). */
export const isUpcoming = (index) => !!S.state.queue && index > S.state.queue.position;

/** Applies a change to the local copy of the queue straight away; returns a function that undoes it. */
function editLocalQueue(fn) {
  const q = S.state.queue;
  if (!q || !q.items) return () => {};
  const items = q.items.slice();
  const total = fn(items, (i) => i - q.offset);
  patchState({ queue: { ...q, items, total: q.total + total } });
  return () => patchState({ queue: q });
}

export function removeFromQueue(index, t) {
  if (!isUpcoming(index)) return Promise.resolve();
  const undo = editLocalQueue((items, rel) => { items.splice(rel(index), 1); return -1; });
  return cmd({ type: 'remove', index, id: t && t.playId }).catch(() => undo());
}

export function moveInQueue(from, to, t) {
  if (from === to || !isUpcoming(from) || !isUpcoming(to)) return Promise.resolve();
  const undo = editLocalQueue((items, rel) => { items.splice(rel(to), 0, ...items.splice(rel(from), 1)); return 0; });
  return cmd({ type: 'move', from, to, id: t && t.playId }).catch(() => undo());
}

export function playQueue(desc, shuffle = false) {
  return cmd({ type: 'playQueue', queue: desc, shuffle });
}

/**
 * Where a track's artist name links to. Queue / now-playing items from MusicKit rarely carry the
 * artist id, so without one this points at a route that looks the artist up from the song
 * (songArtist in views.js).
 */
export function artistHref(t) {
  if (!t) return '';
  if (t.artistId) return `#/artist/${encodeURIComponent(t.artistId)}`;
  if (!t.artist) return '';
  return `#/song-artist/${encodeURIComponent(t.catalogId || t.id || '-')}/${encodeURIComponent(t.artist)}`;
}

export function artistLink(t) {
  const href = artistHref(t);
  return href ? `<a href="${esc(href)}">${esc(t.artist)}</a>` : esc((t && t.artist) || '');
}

export function trackRows(tracks, key, { album = true, artwork = true, start = 0, header = true, discs = false, queue = false, sortable = false } = {}) {
  let out = '';
  if (header) {
    out += `<div class="row head${album ? '' : ' no-album'}"><div class="c-num">#</div><div class="c-main">Title</div>
      ${album ? '<div class="c-album">Album</div>' : ''}<div class="c-dur">${icon('clock')}</div></div>`;
  }
  const multiDisc = discs && new Set(tracks.map((t) => t.disc)).size > 1;
  let lastDisc = null;
  tracks.forEach((t, j) => {
    const i = start + j;
    if (multiDisc && t.disc !== lastDisc) {
      lastDisc = t.disc;
      out += `<div class="disc">Disc ${t.disc}</div>`;
    }
    const n = discs && t.num ? t.num : i + 1;
    out += `<div class="row${album ? '' : ' no-album'}${t.playable ? '' : ' disabled'}${queue || sortable ? ' q-row' : ''}" data-list="${key}" data-i="${i}"
        data-tid="${esc(t.catalogId || t.id)}" data-lid="${esc(t.id)}"${t.catalogId ? ` data-cid="${esc(t.catalogId)}"` : ''}>
      <div class="c-num"><span class="num">${n}</span>${EQ}
        <button class="row-play" data-act="row-play" aria-label="Play ${esc(t.title)}">${icon('play')}</button></div>
      <div class="c-main">${artwork ? `<img loading="lazy" src="${art(t.artwork, 96)}" alt="">` : ''}
        <div class="c-text"><div class="t">${esc(t.title)}</div>
        <div class="s">${t.explicit ? '<span class="explicit" title="Explicit">E</span>' : ''}${artistLink(t)}</div></div></div>
      ${album ? `<div class="c-album">${t.albumId ? `<a href="#/album/${esc(t.albumId)}">${esc(t.album)}</a>` : esc(t.album)}</div>` : ''}
      <div class="c-dur"><span>${t.duration ? fmtTime(t.duration) : ''}</span>
        ${t.catalogId ? `<button class="row-love${loved.get(t.catalogId) ? ' on' : ''}" data-act="row-love" aria-label="Favorite">${icon('heartOutline', 'i-off')}${icon('heart', 'i-on')}</button>` : ''}
        <button class="row-more" data-act="row-menu" aria-label="More options">${icon('more')}</button></div>
    </div>`;
  });
  return out;
}

/** Highlights rows that match the track currently playing. */
export function markPlaying(root = document) {
  const item = S.state.item;
  const ids = item ? [item.id, item.catalogId].filter(Boolean).map(String) : [];
  for (const row of root.querySelectorAll('.row[data-tid]')) {
    const on = ids.includes(row.dataset.tid) || ids.includes(row.dataset.lid);
    row.classList.toggle('playing', on);
  }
  document.body.classList.toggle('is-playing', !!S.state.isPlaying);
  hydrateLoves(root);
}

// ------------------------------------------------------------------ cards & shelves

export function cardHtml(c) {
  const q = c.play ? esc(JSON.stringify(c.play)) : '';
  const click = c.href ? `data-href="${esc(c.href)}"` : c.play ? `data-act="play-q" data-q="${q}"` : '';
  return `<div class="card${c.round ? ' round' : ''}" ${click} data-card="${esc(JSON.stringify({ id: c.id, type: c.type, play: c.play, href: c.href }))}">
    <div class="card-art"><img loading="lazy" src="${art(c.artwork, 300)}"${c.mosaic ? ` data-mosaic="${esc(c.mosaic)}"` : ''} alt="">
      ${c.play ? `<button class="card-play" data-act="play-q" data-q="${q}" aria-label="Play ${esc(c.title)}">${icon('play')}</button>` : ''}
    </div>
    <div class="card-title" title="${esc(c.title)}">${esc(c.title)}</div>
    <div class="card-sub">${esc(c.sub)}</div>
  </div>`;
}

export function shelf(title, resources, { more = null } = {}) {
  const cards = (resources || []).map(toCard).filter(Boolean);
  if (!cards.length) return '';
  return `<section class="shelf"><header><h2>${esc(title)}</h2>${more ? `<a class="more" href="${esc(more)}">Show all</a>` : ''}</header>
    <div class="shelf-row">${cards.map(cardHtml).join('')}</div></section>`;
}

export function grid(resources) {
  const cards = (resources || []).map(toCard).filter(Boolean);
  return `<div class="card-grid">${cards.map(cardHtml).join('')}</div>`;
}

export const loading = () => '<div class="loading"><span></span><span></span><span></span></div>';

export function errorBox(e, what = 'this page') {
  const signedOut = e && (e.status === 401 || e.status === 403);
  return `<div class="empty"><h3>Couldn't load ${esc(what)}</h3><p>${signedOut
    ? 'Sign in to Apple Music to see this.' : esc(e && e.message ? e.message : String(e))}</p></div>`;
}

// ------------------------------------------------------------------ library data

const libCache = {};
const LIB_PATHS = {
  playlists: '/v1/me/library/playlists',
  albums: '/v1/me/library/albums',
  artists: '/v1/me/library/artists',
};

// Apple's library can take a moment to reflect an edit or a delete; until it does, Orchard keeps showing
// what you just did instead of flipping back to the old state.
const RECENT_MS = 30000;
const recentEdits = new Map();   // playlist id -> { attributes, until }
const recentDeletes = new Map(); // playlist id -> until
export function rememberPlaylistEdit(id, attributes) { recentEdits.set(id, { attributes, until: Date.now() + RECENT_MS }); }
export function rememberPlaylistDelete(id) { recentDeletes.set(id, Date.now() + RECENT_MS); }
/** Applies edits made in the last few seconds to a playlist fetched from Apple. */
export function withRecentEdits(p) {
  const e = p && recentEdits.get(p.id);
  if (!e) return p;
  if (e.until < Date.now()) { recentEdits.delete(p.id); return p; }
  p.attributes = { ...p.attributes, ...e.attributes };
  return p;
}
const recentlyDeleted = (id) => {
  const until = recentDeletes.get(id);
  if (until && until < Date.now()) recentDeletes.delete(id);
  return !!until && until >= Date.now();
};

/** Tells open pages that a library playlist changed: { id, added?: [tracks], removed?: [library ids], details?, artwork?, deleted? }. */
export function playlistChanged(detail) {
  document.dispatchEvent(new CustomEvent('playlist-changed', { detail }));
}

export function libraryList(kind, fresh = false) {
  if (libCache[kind] && !fresh) return libCache[kind];
  const p = (async () => {
    let out = [];
    let next = `${LIB_PATHS[kind]}?limit=100`;
    for (let page = 0; next && page < 10; page++) {
      const r = await am(next);
      out = out.concat(r.data || []);
      next = r.next ? (r.next.includes('limit=') ? r.next : r.next + (r.next.includes('?') ? '&' : '?') + 'limit=100') : null;
    }
    if (kind === 'playlists') out = out.filter((x) => !recentlyDeleted(x.id)).map(withRecentEdits);
    return out;
  })();
  libCache[kind] = p;
  p.catch(() => { delete libCache[kind]; });
  return p;
}

export function invalidateLibrary(kind) {
  delete libCache[kind];
  document.dispatchEvent(new CustomEvent('library-changed', { detail: kind }));
}

const libParam = (type, id) => `/v1/me/library?${encodeURIComponent(`ids[${type}]`)}=${encodeURIComponent(id)}`;

export async function addToLibrary(type, id, label = 'Added to your library') {
  try {
    await amWrite('POST', libParam(type, id));
    toast(label);
    invalidateLibrary(type === 'songs' ? 'songs' : type);
  } catch (e) {
    toast(`Couldn't add: ${e.message}`);
  }
}

export async function addToPlaylist(playlist, track) {
  const data = [{ id: track.catalogId || track.id, type: track.catalogId ? 'songs' : 'library-songs' }];
  try {
    await amWrite('POST', `/v1/me/library/playlists/${encodeURIComponent(playlist.id)}/tracks`, { data });
    toast(`Added to ${playlist.attributes.name}`);
    refreshMosaic(playlist.id);
    playlistChanged({ id: playlist.id, added: [track] });
  } catch (e) {
    toast(`Couldn't add to playlist: ${e.message}`);
  }
}

export async function createPlaylist(name, trackList = [], { description = '' } = {}) {
  const body = { attributes: { name } };
  if (description) body.attributes.description = description;
  if (trackList.length) {
    body.relationships = { tracks: { data: trackList.map((t) => ({ id: t.catalogId || t.id, type: t.catalogId ? 'songs' : 'library-songs' })) } };
  }
  const r = await amWrite('POST', '/v1/me/library/playlists', body);
  invalidateLibrary('playlists');
  return r && r.data && r.data[0];
}

// ------------------------------------------------------------------ favorites (Apple Music "Favorite" rating)

// Apple Music's heart is a "Favorite" (formerly "Love"): a rating of 1 on the song. Favorited songs show up in
// Apple's auto-updating "Favorite Songs" playlist on every device; like Apple's own apps, Orchard also adds them
// to your library.
const loved = new Map();
const lovedPending = new Set();

async function fetchLoved(ids) {
  const todo = ids.filter((id) => !loved.has(id) && !lovedPending.has(id));
  for (let i = 0; i < todo.length; i += 50) {
    const chunk = todo.slice(i, i + 50);
    chunk.forEach((id) => lovedPending.add(id));
    try {
      const r = await am(`/v1/me/ratings/songs?ids=${chunk.map(encodeURIComponent).join(',')}`);
      const on = new Set(((r && r.data) || []).filter((d) => d.attributes && d.attributes.value === 1).map((d) => d.id));
      chunk.forEach((id) => loved.set(id, on.has(id)));
    } catch (e) {
      // 404 = none of these are rated; anything else (e.g. signed out): treat as not favorited for now
      if (e.status === 404) chunk.forEach((id) => loved.set(id, false));
    } finally {
      chunk.forEach((id) => lovedPending.delete(id));
    }
  }
}

function paintLoves(root = document) {
  root.querySelectorAll('.row[data-cid]').forEach((row) => {
    const on = !!loved.get(row.dataset.cid);
    row.classList.toggle('loved', on);
    const b = row.querySelector('.row-love');
    if (b) b.classList.toggle('on', on);
  });
}

/** Fills in the heart state for every track row under `root` (batched, cached). */
export async function hydrateLoves(root = document) {
  if (!S.state.authorized) return;
  const ids = [...new Set([...root.querySelectorAll('.row[data-cid]')].map((r) => r.dataset.cid))];
  paintLoves(root);
  if (ids.some((id) => !loved.has(id))) {
    await fetchLoved(ids);
    paintLoves(root);
  }
}

export async function isLoved(catalogId) {
  if (!catalogId) return false;
  if (!loved.has(catalogId)) await fetchLoved([catalogId]);
  return !!loved.get(catalogId);
}

export const lovedCached = (catalogId) => loved.get(catalogId);

export async function setLoved(catalogId, value) {
  const path = `/v1/me/ratings/songs/${encodeURIComponent(catalogId)}`;
  const before = loved.get(catalogId);
  loved.set(catalogId, value);
  document.dispatchEvent(new CustomEvent('loved-changed', { detail: { id: catalogId, value } }));
  paintLoves();
  try {
    if (value) {
      await amWrite('PUT', path, { type: 'rating', attributes: { value: 1 } });
      // Apple's apps add favorites to the library too; don't fail the favorite if this part doesn't work.
      amWrite('POST', libParam('songs', catalogId)).catch(() => {});
    } else {
      await amWrite('DELETE', path);
    }
    toast(value ? 'Added to Favorite Songs' : 'Removed from Favorite Songs');
  } catch (e) {
    loved.set(catalogId, before);
    document.dispatchEvent(new CustomEvent('loved-changed', { detail: { id: catalogId, value: !!before } }));
    paintLoves();
    toast(`Couldn't update Favorites: ${e.message}`);
    throw e;
  }
}

export const toggleLoved = (catalogId) => setLoved(catalogId, !loved.get(catalogId));

/** Apple's auto-updating "Favorite Songs" library playlist (name is localized), if it exists yet. */
export async function favoritesPlaylist(fresh = false) {
  const pls = await libraryList('playlists', fresh);
  return pls.find((p) => /^favou?rite songs$/i.test((p.attributes && p.attributes.name) || '')) || null;
}

// ------------------------------------------------------------------ context menus

let menuCleanup = null;

export function closeMenu() {
  const m = $('#menu');
  m.hidden = true;
  m.innerHTML = '';
  if (menuCleanup) { menuCleanup(); menuCleanup = null; }
}

/** items: [{ label, icon, run }] | { sep: true } | { label, icon, submenu: async () => items } */
/** The picture at the start of a menu item: a thumbnail (`image`), a tile with an icon (`tile`), or an icon. */
function menuGlyph(it) {
  if (it.image !== undefined) {
    return `<img class="mi-img" src="${art(it.image, 80)}"${it.mosaic ? ` data-mosaic="${esc(it.mosaic)}"` : ''} alt="">`;
  }
  if (it.tile) return `<span class="mi-tile">${icon(it.tile)}</span>`;
  return it.icon ? icon(it.icon) : '<span class="ic"></span>';
}

/** Menu header for a song: artwork, title and artist. */
export const trackMenuHead = (t) => ({ title: t.title, subtitle: t.artist, artwork: t.artwork });

/**
 * Opens the pop-up menu. `head` is a plain title, or { title, subtitle, artwork } for a richer header.
 * Items: { label, icon, run } | { label, icon, submenu: async () => items } | { sep: true }.
 */
export function openMenu(anchor, items, head = '') {
  closeMenu();
  const m = $('#menu');
  const h = typeof head === 'string' ? { title: head } : head || {};
  const headHtml = !h.title ? '' : h.artwork || h.subtitle
    ? `<div class="menu-head">${h.artwork ? `<img src="${art(h.artwork, 96)}"${h.mosaic ? ` data-mosaic="${esc(h.mosaic)}"` : ''} alt="">` : ''}<div><b>${esc(h.title)}</b>${h.subtitle ? `<small>${esc(h.subtitle)}</small>` : ''}</div></div>`
    : `<div class="menu-title">${esc(h.title)}</div>`;
  const render = (list, back) => {
    const top = back ? `<button class="menu-back" data-back>${icon('back')}<span>${esc(back)}</span></button><hr>` : headHtml;
    m.innerHTML = top + list.map((it, i) => it.sep
      ? '<hr>'
      : `<button data-mi="${i}"${it.danger ? ' class="danger"' : ''}>${menuGlyph(it)}<span>${esc(it.label)}</span>${it.submenu ? icon('forward', 'sub') : ''}</button>`).join('');
    m.onclick = async (e) => {
      if (e.target.closest('[data-back]')) { e.stopPropagation(); render(items); return; }
      const b = e.target.closest('[data-mi]');
      if (!b) return;
      e.stopPropagation();
      const it = list[+b.dataset.mi];
      if (it.submenu) {
        m.innerHTML = loading();
        try { render(await it.submenu(), it.label); } catch (err) { closeMenu(); toast(err.message); }
        return;
      }
      closeMenu();
      try { await it.run(); } catch (err) { toast(err.message); }
    };
  };
  render(items);
  m.hidden = false;
  if (window.matchMedia('(max-width: 760px)').matches) {
    m.style.left = m.style.top = '';
  } else {
    const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, bottom: anchor.y, top: anchor.y, right: anchor.x };
    const w = m.offsetWidth, h = m.offsetHeight;
    let left = Math.min(r.right - w, window.innerWidth - w - 8);
    if (left < 8) left = Math.min(r.left, window.innerWidth - w - 8);
    let top = r.bottom + 4;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
    m.style.left = `${Math.max(8, left)}px`;
    m.style.top = `${top}px`;
  }
  const away = (e) => { if (!m.contains(e.target)) closeMenu(); };
  const esc_ = (e) => { if (e.key === 'Escape') closeMenu(); };
  setTimeout(() => {
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc_);
  });
  menuCleanup = () => {
    document.removeEventListener('pointerdown', away, true);
    document.removeEventListener('keydown', esc_);
  };
}

export function trackMenuItems(t, { queueIndex = -1, playlist = null } = {}) {
  const items = [];
  // Queue
  if (isUpcoming(queueIndex)) {
    const q = S.state.queue;
    if (queueIndex > q.position + 1) items.push({ label: 'Move to top of queue', icon: 'moveTop', run: () => moveInQueue(queueIndex, q.position + 1, t) });
    items.push({ label: 'Remove from queue', icon: 'queueRemove', run: () => removeFromQueue(queueIndex, t) });
  } else {
    items.push(
      { label: 'Play next', icon: 'playNext', run: () => cmd({ type: 'playNext', queue: { song: qid(t) } }).then(() => toast('Playing next')) },
      { label: 'Add to queue', icon: 'queueAdd', run: () => cmd({ type: 'playLater', queue: { song: qid(t) } }).then(() => toast('Added to queue')) },
    );
  }
  // Keep
  items.push({ sep: true });
  if (t.catalogId) {
    const fav = !!loved.get(t.catalogId);
    items.push({ label: fav ? 'Remove from Favorites' : 'Add to Favorites', icon: fav ? 'heart' : 'heartOutline', run: () => setLoved(t.catalogId, !fav) });
  }
  items.push({
    label: 'Add to playlist',
    icon: 'playlistAdd',
    submenu: async () => {
      const pls = (await libraryList('playlists')).filter((p) => p.attributes && p.attributes.canEdit);
      const out = [{ label: 'New playlist…', tile: 'plus', run: () => openPlaylistEditor({ tracks: [t] }) }];
      if (pls.length) out.push({ sep: true });
      return out.concat(pls.map((p) => ({ label: p.attributes.name, image: playlistArtwork(p), mosaic: mosaicFor(p), run: () => addToPlaylist(p, t) })));
    },
  });
  if (playlist && playlist.canEdit && /^i\./.test(t.id || '')) {
    items.push({ label: 'Remove from this playlist', icon: 'queueRemove', run: () => removeFromPlaylist(playlist, t) });
  }
  if (t.catalogId) items.push({ label: 'Add to library', icon: 'libraryAdd', run: () => addToLibrary('songs', t.catalogId) });
  // Go to
  items.push({ sep: true });
  const artistTo = artistHref(t);
  if (artistTo) items.push({ label: 'Go to artist', icon: 'person', run: () => { location.hash = artistTo; } });
  if (t.albumId) items.push({ label: 'Go to album', icon: 'album', run: () => { location.hash = `#/album/${t.albumId}`; } });
  if (items[items.length - 1].sep) items.pop();
  return items;
}

export function collectionMenuItems(c) {
  const items = [];
  if (c.play) {
    items.push({ label: 'Play', icon: 'play', run: () => playQueue(c.play) });
    items.push({ label: 'Shuffle play', icon: 'shuffle', run: () => playQueue(c.play, true) });
    items.push({ label: 'Play next', icon: 'playNext', run: () => cmd({ type: 'playNext', queue: c.play }).then(() => toast('Playing next')) });
    items.push({ label: 'Add to queue', icon: 'queueAdd', run: () => cmd({ type: 'playLater', queue: c.play }).then(() => toast('Added to queue')) });
  }
  const libType = c.type === 'albums' ? 'albums' : c.type === 'playlists' ? 'playlists' : null;
  if (libType || c.href) items.push({ sep: true });
  if (libType) items.push({ label: 'Add to library', icon: 'libraryAdd', run: () => addToLibrary(libType, c.id) });
  if (c.href) items.push({ label: 'Open', icon: 'open', run: () => { location.hash = c.href; } });
  return items;
}
