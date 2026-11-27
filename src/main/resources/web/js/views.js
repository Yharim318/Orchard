// Page views: home, search, album, playlist, artist, library, songs, queue, lyrics.
import { $, esc, art, artWide, fmtTotal, greeting, icon, debounce, store as persist, toast, hexColor } from './util.js';
import { S, am, sf, subscribe, queuePage, browsable } from './store.js';
import {
  toTrack, toCard, cardHtml, shelf, grid, trackRows, registerList, getList, markPlaying, loading, errorBox,
  libraryList, playList, playQueue, addToLibrary, openMenu, collectionMenuItems, favoritesPlaylist, moveInQueue,
  withRecentEdits,
} from './components.js';
import { enableRowDrag, isRowDragging } from './queuedrag.js';
import { playlistArtwork, mosaicFor, refreshMosaic, scanMosaics } from './artwork.js';
import { openPlaylistEditor, playlistMenuItems, moveInPlaylist } from './playlists.js';

const enc = encodeURIComponent;
const PLACEHOLDER_ART = { url: '' }; // menu header shows the music-note placeholder
export const withLimit = (next, n = 100) => next ? (next.includes('limit=') ? next : `${next}${next.includes('?') ? '&' : '?'}limit=${n}`) : null;

// The Apple Music addresses each page reads. warmup.js loads the same ones ahead of time, so they're shared here:
// a page and the warm-up must ask for exactly the same address to use the same cached copy.
const ARTIST_VIEWS = 'views=top-songs,latest-release,full-albums,singles,appears-on-albums,featured-playlists,similar-artists&extend=artistBio,editorialArtwork';
export const PAGE_PATHS = {
  home: () => ['/v1/me/recent/played?limit=10', '/v1/me/recommendations?limit=10',
    `/v1/catalog/${sf()}/charts?types=songs,albums,playlists&limit=20`],
  album: (id) => (id.startsWith('l.') ? `/v1/me/library/albums/${enc(id)}?include=tracks,artists`
    : `/v1/catalog/${sf()}/albums/${enc(id)}?include=tracks,artists`),
  playlist: (id) => (id.startsWith('p.') ? `/v1/me/library/playlists/${enc(id)}?include=tracks`
    : `/v1/catalog/${sf()}/playlists/${enc(id)}?include=tracks`),
  playlistTracks: (id) => `/v1/me/library/playlists/${enc(id)}/tracks?limit=100`,
  artist: (id) => `/v1/catalog/${sf()}/artists/${enc(id)}?${ARTIST_VIEWS}`,
  libraryArtist: (id) => `/v1/me/library/artists/${enc(id)}?include=catalog`,
  libraryArtistAlbums: (id) => `/v1/me/library/artists/${enc(id)}/albums?limit=100`,
  songs: () => '/v1/me/library/songs?limit=100',
};

export function setHero(color) {
  $('#main').style.setProperty('--hero', hexColor(color) || 'var(--hero-default)');
}

function heroHtml({ artwork, kind, title, meta, round = false, color, mosaic = null, editable = false }) {
  setHero(color);
  const edit = editable ? ' data-a="edit" title="Edit details" role="button" tabindex="0"' : '';
  return `<header class="hero${editable ? ' editable' : ''}">
    <div class="hero-art-wrap"${edit}><img class="hero-art${round ? ' round' : ''}" src="${art(artwork, 480)}"${mosaic ? ` data-mosaic="${esc(mosaic)}"` : ''} alt="">
      ${editable ? `<span class="hero-art-edit">${icon('edit')}<span>Edit</span></span>` : ''}</div>
    <div class="hero-text">
      <div class="kind">${esc(kind)}</div>
      <h1 class="${title.length > 28 ? 'long' : ''}"${edit}>${esc(title)}</h1>
      <div class="meta">${meta}</div>
    </div>
  </header>`;
}

function actionsHtml({ play = true, shuffle = true, add = false, more = true } = {}) {
  return `<div class="actions">
    ${play ? `<button class="big-play" data-a="play" aria-label="Play">${icon('play')}</button>` : ''}
    ${shuffle ? `<button class="icon-btn lg" data-a="shuffle" title="Shuffle play">${icon('shuffle')}</button>` : ''}
    ${add ? `<button class="icon-btn lg" data-a="add" title="Add to library">${icon('plus')}</button>` : ''}
    ${more ? `<button class="icon-btn lg" data-a="more" title="More">${icon('more')}</button>` : ''}
  </div>`;
}

function bindActions(el, handlers) {
  el.querySelectorAll('.actions [data-a], .hero [data-a]').forEach((b) => {
    b.addEventListener('click', (e) => handlers[b.dataset.a] && handlers[b.dataset.a](e, b));
    if (b.getAttribute('role') === 'button') {
      b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); b.click(); } });
    }
  });
}

/** Loads further pages of a track list as the user scrolls. */
function infinite(el, next, onPage) {
  if (!next) return () => {};
  const sentinel = document.createElement('div');
  sentinel.className = 'sentinel';
  el.appendChild(sentinel);
  let busy = false;
  const io = new IntersectionObserver(async (entries) => {
    if (!entries[0].isIntersecting || busy || !next) return;
    busy = true;
    try {
      const r = await am(withLimit(next));
      next = withLimit(r.next);
      onPage(r.data || []);
      markPlaying(el);
    } catch (e) {
      toast(e.message);
      next = null;
    }
    busy = false;
    if (!next) { io.disconnect(); sentinel.remove(); }
  }, { root: $('#main'), rootMargin: '800px' });
  io.observe(sentinel);
  return () => io.disconnect();
}

// ------------------------------------------------------------------ home

// A home page that didn't fully load redraws itself quietly, waiting longer each time (1 s, 2 s, 4 s… up to 30 s).
let homeRetryDelay = 0;

async function home(el) {
  setHero(null);
  el.innerHTML = `<div class="page"><h1 class="greet">${greeting()}</h1><div class="home-body">${loading()}</div></div>`;
  const body = el.querySelector('.home-body');
  const [recent, recs, charts] = await Promise.allSettled(PAGE_PATHS.home().map((path) => am(path)));
  let html = '';
  if (recent.status === 'fulfilled') {
    const cards = (recent.value.data || []).map(toCard).filter(Boolean).slice(0, 8);
    if (cards.length) {
      html += `<div class="quick-grid">${cards.map((c) => `
        <div class="quick" ${c.href ? `data-href="${esc(c.href)}"` : `data-act="play-q" data-q="${esc(JSON.stringify(c.play))}"`}>
          <img src="${art(c.artwork, 120)}" alt=""><span>${esc(c.title)}</span>
          ${c.play ? `<button class="card-play" data-act="play-q" data-q="${esc(JSON.stringify(c.play))}" aria-label="Play">${icon('play')}</button>` : ''}
        </div>`).join('')}</div>`;
    }
  }
  if (recs.status === 'fulfilled') {
    for (const rec of recs.value.data || []) {
      const a = rec.attributes || {};
      const title = (a.title && a.title.stringForDisplay) || a.reason?.stringForDisplay || 'For you';
      html += shelf(title, rec.relationships && rec.relationships.contents && rec.relationships.contents.data);
    }
  }
  if (charts.status === 'fulfilled') {
    const r = charts.value.results || {};
    const songChart = r.songs && r.songs[0];
    if (songChart && songChart.data && songChart.data.length) {
      const tracks = songChart.data.map(toTrack);
      const key = registerList(tracks);
      html += `<section class="shelf"><header><h2>${esc(songChart.name || 'Top Songs')}</h2></header>
        <div class="tracks chart-cols">${trackRows(tracks.slice(0, 20), key, { album: false, header: false })}</div></section>`;
    }
    if (r.albums && r.albums[0]) html += shelf(r.albums[0].name || 'Top Albums', r.albums[0].data);
    if (r.playlists && r.playlists[0]) html += shelf(r.playlists[0].name || 'Top Playlists', r.playlists[0].data);
  }
  if (!html) {
    const err = [recent, recs, charts].find((x) => x.status === 'rejected');
    html = err ? errorBox(err.reason, 'your home page') : '<div class="empty"><h3>Nothing here yet</h3><p>Play some music!</p></div>';
  }
  body.innerHTML = html;
  markPlaying(el);
  if (![recent, recs, charts].some((x) => x.status === 'rejected')) { homeRetryDelay = 0; return; }
  // Not signed in / Apple Music not started: the page is redrawn when that changes, nothing to retry yet.
  if (!S.state.ready || !S.state.authorized) return;
  homeRetryDelay = Math.min(homeRetryDelay ? homeRetryDelay * 2 : 1000, 30000);
  const t = setTimeout(() => document.dispatchEvent(new CustomEvent('view-refresh')), homeRetryDelay);
  return () => clearTimeout(t);
}

// ------------------------------------------------------------------ search

function searchShell(el, q) {
  setHero(null);
  el.innerHTML = `<div class="page search-page">
    <div class="search-box">${icon('search')}<input type="search" placeholder="What do you want to listen to?" value="${esc(q)}" autocomplete="off" enterkeyhint="search"></div>
    <div class="search-results"></div></div>`;
  return { input: el.querySelector('input'), out: el.querySelector('.search-results') };
}

async function searchIdle(out) {
  const recent = persist('orchard.recentSearches') || [];
  let html = '';
  if (recent.length) {
    html += `<section class="shelf"><header><h2>Recent searches</h2></header><div class="chips">${recent.map((r) =>
      `<a class="chip" href="#/search/${enc(r)}">${esc(r)}</a>`).join('')}</div></section>`;
  }
  out.innerHTML = html + loading();
  try {
    const charts = await am(`/v1/catalog/${sf()}/charts?types=playlists,albums&limit=20`);
    const r = charts.results || {};
    out.innerHTML = html + (r.playlists && r.playlists[0] ? `<section class="shelf"><header><h2>Browse playlists</h2></header>${grid(r.playlists[0].data)}</section>` : '')
      + (r.albums && r.albums[0] ? shelf(r.albums[0].name || 'Top Albums', r.albums[0].data) : '');
  } catch (e) {
    out.innerHTML = html;
  }
}

function topResultHtml(r) {
  const c = toCard(r);
  if (!c) return '';
  const kind = r.type === 'artists' ? 'Artist' : r.type === 'albums' ? 'Album' : r.type === 'playlists' ? 'Playlist'
    : r.type === 'songs' ? 'Song' : r.type === 'stations' ? 'Station' : '';
  const q = c.play ? esc(JSON.stringify(c.play)) : '';
  return `<div class="top-result" ${c.href ? `data-href="${esc(c.href)}"` : c.play ? `data-act="play-q" data-q="${q}"` : ''}>
    <img class="${c.round ? 'round' : ''}" src="${art(c.artwork, 240)}" alt="">
    <h3>${esc(c.title)}</h3><div class="sub">${kind ? `<span class="pill">${kind}</span>` : ''}${c.round ? '' : esc(c.sub)}</div>
    ${c.play ? `<button class="card-play" data-act="play-q" data-q="${q}" aria-label="Play">${icon('play')}</button>` : ''}
  </div>`;
}

async function searchRun(out, q, seq) {
  out.innerHTML = loading();
  let res;
  try {
    res = await am(`/v1/catalog/${sf()}/search?term=${enc(q)}&types=songs,albums,artists,playlists,stations&limit=20&with=topResults`);
  } catch (e) {
    if (seq()) out.innerHTML = errorBox(e, 'search results');
    return;
  }
  if (!seq()) return;
  const r = res.results || {};
  const top = (r.topResults && r.topResults.data && r.topResults.data[0]) || (r.top && r.top.data && r.top.data[0]) || (r.artists && r.artists.data && r.artists.data[0])
    || (r.albums && r.albums.data && r.albums.data[0]);
  const songs = ((r.songs && r.songs.data) || []).map(toTrack);
  const key = registerList(songs);
  let html = '';
  if (top || songs.length) {
    html += `<div class="search-top">
      ${top ? `<section><h2>Top result</h2>${topResultHtml(top)}</section>` : ''}
      ${songs.length ? `<section class="search-songs"><h2>Songs</h2><div class="tracks">${trackRows(songs.slice(0, 5), key, { album: false, header: false })}</div></section>` : ''}
    </div>`;
  }
  html += shelf('Artists', r.artists && r.artists.data);
  html += shelf('Albums', r.albums && r.albums.data);
  html += shelf('Playlists', r.playlists && r.playlists.data);
  html += shelf('Stations', r.stations && r.stations.data);
  if (songs.length > 5) {
    html += `<section class="shelf"><header><h2>More songs</h2></header><div class="tracks">${trackRows(songs.slice(5), key, { start: 5, header: false })}</div></section>`;
  }
  out.innerHTML = html || `<div class="empty"><h3>No results found for “${esc(q)}”</h3><p>Check the spelling or try different words.</p></div>`;
  markPlaying(out);
  const recent = (persist('orchard.recentSearches') || []).filter((x) => x.toLowerCase() !== q.toLowerCase());
  persist('orchard.recentSearches', [q, ...recent].slice(0, 10));
}

function search(el, m) {
  const initial = m[1] ? decodeURIComponent(m[1]) : '';
  const { input, out } = searchShell(el, initial);
  let counter = 0;
  const run = (q) => {
    const my = ++counter;
    history.replaceState(null, '', q ? `#/search/${enc(q)}` : '#/search');
    if (!q) searchIdle(out);
    else searchRun(out, q, () => my === counter);
  };
  const onInput = debounce(() => run(input.value.trim()), 350);
  input.addEventListener('input', onInput);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { input.blur(); run(input.value.trim()); } });
  run(initial);
  if (!initial) input.dataset.autofocus = ''; // focused once the page is on screen (app.js showPage)
}

// ------------------------------------------------------------------ album

async function album(el, m) {
  const id = decodeURIComponent(m[1]);
  const lib = id.startsWith('l.');
  el.innerHTML = loading();
  let res;
  try {
    res = await am(PAGE_PATHS.album(id));
  } catch (e) {
    el.innerHTML = errorBox(e, 'this album');
    return;
  }
  const d = res.data && res.data[0];
  if (!d) { el.innerHTML = errorBox(new Error('Album not found'), 'this album'); return; }
  const a = d.attributes;
  const artistRel = d.relationships && d.relationships.artists && d.relationships.artists.data && d.relationships.artists.data[0];
  const tracks = ((d.relationships && d.relationships.tracks && d.relationships.tracks.data) || []).map(toTrack);
  tracks.forEach((t) => { if (!t.artistId && artistRel && t.artist === a.artistName) t.artistId = artistRel.id; });
  const total = tracks.reduce((s, t) => s + t.duration, 0);
  const year = a.releaseDate ? esc(a.releaseDate.slice(0, 4)) : '';
  const artistHtml = artistRel ? `<a href="#/artist/${esc(artistRel.id)}">${esc(a.artistName)}</a>` : esc(a.artistName || '');
  const kind = a.isSingle ? 'Single' : a.isCompilation ? 'Compilation' : 'Album';
  const play = a.playParams ? { [a.playParams.kind || 'album']: a.playParams.id } : { album: id };
  const key = registerList(tracks, { collection: play });
  el.innerHTML = `<div class="page">${heroHtml({
    artwork: a.artwork, kind, title: a.name, color: a.artwork && a.artwork.bgColor,
    meta: `<b>${artistHtml}</b>${year ? ` • ${year}` : ''} • ${tracks.length} songs, <span class="muted">${fmtTotal(total)}</span>`,
  })}
  ${actionsHtml({ add: !lib })}
  <div class="tracks">${trackRows(tracks, key, { album: false, artwork: false, discs: true })}</div>
  <div class="footnote">${a.releaseDate ? `<div>${esc(new Date(a.releaseDate + 'T00:00:00').toLocaleDateString(undefined, { dateStyle: 'long' }))}</div>` : ''}
    ${a.copyright ? `<div>${esc(a.copyright)}</div>` : ''}${a.recordLabel ? `<div>${esc(a.recordLabel)}</div>` : ''}
    ${a.editorialNotes && a.editorialNotes.standard ? `<div class="notes">${esc(a.editorialNotes.standard.replace(/<[^>]+>/g, ' '))}</div>` : ''}</div>
  </div>`;
  bindActions(el, {
    play: () => playList(key, 0),
    shuffle: () => playList(key, null, { shuffle: true }),
    add: () => addToLibrary('albums', id),
    more: (e, b) => openMenu(b, collectionMenuItems({ id, type: lib ? 'library-albums' : 'albums', play }), a.name),
  });
  markPlaying(el);
}

// ------------------------------------------------------------------ playlist

/** All of a library playlist's tracks (several pages; an empty playlist answers 404). */
async function libraryPlaylistTracks(id) {
  let out = [];
  let next = `/v1/me/library/playlists/${enc(id)}/tracks?limit=100`;
  while (next) {
    let r;
    try { r = await am(next, { fresh: true }); } catch (e) { if (e.status === 404) break; throw e; }
    out = out.concat(r.data || []);
    next = withLimit(r.next);
  }
  return out;
}

async function playlist(el, m, opts = {}) {
  const id = decodeURIComponent(m[1]);
  const lib = id.startsWith('p.');
  el.innerHTML = loading();
  let res;
  try {
    res = await am(PAGE_PATHS.playlist(id));
  } catch (e) {
    el.innerHTML = errorBox(e, 'this playlist');
    return;
  }
  const d = lib ? withRecentEdits(res.data && res.data[0]) : res.data && res.data[0];
  if (!d) { el.innerHTML = errorBox(new Error('Playlist not found'), 'this playlist'); return; }
  const a = d.attributes;
  const rel = (d.relationships && d.relationships.tracks) || {};
  let tracks = (rel.data || []).map(toTrack);
  let next = rel.next || null;
  if (lib && !rel.data) {
    try {
      const t = await am(PAGE_PATHS.playlistTracks(id));
      tracks = (t.data || []).map(toTrack);
      next = t.next;
    } catch (e) { /* empty playlist returns 404 */ }
  }
  // A quiet refresh keeps at least as many songs as were showing, so the scroll position survives.
  while (next && opts.minTracks && tracks.length < opts.minTracks) {
    try {
      const r = await am(withLimit(next));
      tracks = tracks.concat((r.data || []).map(toTrack));
      next = r.next;
    } catch (e) { break; }
  }
  const play = a.playParams ? { [a.playParams.kind || 'playlist']: a.playParams.id } : { playlist: id };
  const editable = lib && !!a.canEdit;
  const key = registerList(tracks, { collection: play, playlist: lib ? { id, name: a.name, canEdit: editable } : null });
  const desc = (a.description && (a.description.standard || a.description.short)) || '';
  let count = a.trackCount || tracks.length;
  const durHtml = () => (next ? '' : `, <span class="muted">${fmtTotal(getList(key).tracks.reduce((s, t) => s + (t.duration || 0), 0))}</span>`);
  el.innerHTML = `<div class="page">${heroHtml({
    artwork: playlistArtwork(d), mosaic: mosaicFor(d), editable,
    kind: lib ? 'Playlist · Library' : 'Playlist', title: a.name,
    color: a.artwork && a.artwork.bgColor,
    meta: `<div class="desc"${desc ? '' : ' hidden'}>${esc(desc.replace(/<[^>]+>/g, ''))}</div><b>${esc(a.curatorName || (lib ? 'You' : 'Apple Music'))}</b> • <span class="pl-count">${count} songs${durHtml()}</span>`,
  })}
  ${actionsHtml({ add: !lib })}
  <div class="tracks">${tracks.length ? trackRows(tracks, key, { sortable: editable }) : '<div class="empty"><p>This playlist is empty.</p></div>'}</div></div>`;
  bindActions(el, {
    play: () => playList(key, 0),
    shuffle: () => playList(key, null, { shuffle: true }),
    add: () => addToLibrary('playlists', id),
    edit: () => openPlaylistEditor({ playlist: d }),
    more: (e, b) => openMenu(b, collectionMenuItems({ id, type: lib ? 'library-playlists' : 'playlists', play }).concat(playlistMenuItems(d)),
      { title: a.name, subtitle: a.curatorName || (lib ? 'Playlist' : 'Apple Music'), artwork: playlistArtwork(d) || PLACEHOLDER_ART, mosaic: mosaicFor(d) }),
  });
  markPlaying(el);
  const list = el.querySelector('.tracks');
  const stopInfinite = infinite(el.querySelector('.page'), withLimit(next), (data) => {
    const L = getList(key);
    const more = data.map(toTrack);
    const start = L.tracks.length;
    L.tracks.push(...more);
    list.insertAdjacentHTML('beforeend', trackRows(more, key, { start, header: false, sortable: editable }));
  });
  if (!lib) return stopInfinite;

  // ---- live updates: changes made anywhere in Orchard show up here straight away, without a reload.
  const setCount = (delta) => {
    count = Math.max(0, count + delta);
    el.querySelector('.pl-count').innerHTML = `${count} songs${durHtml()}`;
  };
  const renumber = () => {
    const rows = [...list.querySelectorAll('.row:not(.head)')];
    rows.forEach((r, i) => {
      r.dataset.i = i;
      const n = r.querySelector('.num');
      if (n) n.textContent = i + 1;
    });
    if (!rows.length) list.innerHTML = '<div class="empty"><p>This playlist is empty.</p></div>';
  };
  // Then check with Apple Music (its library can lag a moment behind) and quietly redraw from its data.
  let recTimer = 0;
  const reconcile = (expect) => {
    clearTimeout(recTimer);
    let tries = 0;
    const run = async () => {
      if (!el.isConnected) return;
      let n = null;
      try { n = next ? null : (await libraryPlaylistTracks(id)).length; } catch (e) { /* try again later */ }
      if (n !== null && n !== expect && ++tries < 4) { recTimer = setTimeout(run, [1500, 3000, 6000][tries - 1]); return; }
      refreshMosaic(id);
      if (el.isConnected && location.hash === `#/playlist/${encodeURIComponent(id)}`) document.dispatchEvent(new CustomEvent('view-refresh'));
    };
    recTimer = setTimeout(run, 700);
  };
  const onChange = (e) => {
    const c = e.detail || {};
    if (c.id !== id) return;
    const L = getList(key);
    if ((c.added && c.added.length) || (c.removed && c.removed.length)) sentOrder = null;
    if (c.added && c.added.length) {
      const more = c.added.map((t) => ({ ...t, playable: true }));
      const start = L.tracks.length;
      L.tracks.push(...more);
      const empty = list.querySelector('.empty');
      if (empty) { empty.remove(); list.insertAdjacentHTML('beforeend', trackRows(more, key, { start, sortable: editable })); }
      else list.insertAdjacentHTML('beforeend', trackRows(more, key, { start, header: false, sortable: editable }));
      markPlaying(list);
      setCount(more.length);
      reconcile(L.tracks.length);
    }
    if (c.removed && c.removed.length) {
      let gone = 0;
      for (const lid of c.removed) {
        list.querySelectorAll(`.row[data-lid="${CSS.escape(lid)}"]`).forEach((r) => { r.remove(); gone++; });
        for (let i = L.tracks.length - 1; i >= 0; i--) if (L.tracks[i].id === lid) L.tracks.splice(i, 1);
      }
      renumber();
      setCount(-gone);
      reconcile(L.tracks.length);
    }
    if (c.details) {
      Object.assign(a, { name: c.details.name, description: c.details.description ? { standard: c.details.description } : undefined });
      const h1 = el.querySelector('.hero h1');
      h1.textContent = a.name;
      h1.classList.toggle('long', a.name.length > 28);
      const dEl = el.querySelector('.hero .desc');
      dEl.textContent = c.details.description || '';
      dEl.hidden = !c.details.description;
      L.ctx.playlist.name = a.name;
    }
    if (c.artwork) {
      const img = el.querySelector('.hero-art');
      const artwork = playlistArtwork(d);
      img.src = art(artwork, 480);
      if (artwork) img.removeAttribute('data-mosaic');
      else { img.dataset.mosaic = id; scanMosaics(img); }
    }
  };
  document.addEventListener('playlist-changed', onChange);

  // ---- drag to reorder (your own playlists): the row moves at once, then Apple Music is told.
  let sentOrder = null;          // the order this page last sent (Apple's library may lag behind it)
  let saving = Promise.resolve(); // moves are sent one at a time, in order
  if (editable) {
    enableRowDrag(list, {
      onMove: (from, to) => {
        const L = getList(key);
        const rows = [...list.querySelectorAll('.q-row')];
        const track = L.tracks[from];
        if (!track || !rows[from] || !rows[to]) return;
        rows[to].insertAdjacentElement(to > from ? 'afterend' : 'beforebegin', rows[from]);
        L.tracks.splice(to, 0, ...L.tracks.splice(from, 1));
        renumber();
        saving = saving
          .then(() => moveInPlaylist({ id }, from, to, track, sentOrder))
          .then((order) => {
            sentOrder = order;
            if (Math.min(from, to) < 4) refreshMosaic(id); // the cover is made from the first songs
          }, (e) => {
            // Show Apple's real order again; anything still waiting reads it afresh.
            sentOrder = null;
            toast(`Couldn't move the song: ${e.message}`);
            if (el.isConnected) document.dispatchEvent(new CustomEvent('view-refresh'));
          });
      },
    });
  }
  return () => {
    stopInfinite();
    clearTimeout(recTimer);
    document.removeEventListener('playlist-changed', onChange);
  };
}

// ------------------------------------------------------------------ artist

async function artist(el, m) {
  const id = decodeURIComponent(m[1]);
  el.innerHTML = loading();
  if (id.startsWith('r.')) return libraryArtist(el, id);
  let res;
  try {
    res = await am(PAGE_PATHS.artist(id));
  } catch (e) {
    el.innerHTML = errorBox(e, 'this artist');
    return;
  }
  const d = res.data && res.data[0];
  if (!d) { el.innerHTML = errorBox(new Error('Artist not found'), 'this artist'); return; }
  const a = d.attributes;
  const v = d.views || {};
  const viewData = (k) => (v[k] && v[k].data) || [];
  const top = viewData('top-songs').map(toTrack);
  const key = registerList(top);
  const ed = a.editorialArtwork || {};
  const banner = ed.bannerUber || ed.centeredFullscreenBackground || ed.fullscreenBackground;
  setHero(a.artwork && a.artwork.bgColor);
  const latest = viewData('latest-release')[0];
  el.innerHTML = `<div class="page">
    <header class="artist-hero${banner ? ' has-banner' : ''}" ${banner ? `style="background-image:url('${artWide(banner, 2000).replace(/'/g, '%27')}')"` : ''}>
      ${banner ? '' : `<img class="hero-art round" src="${art(a.artwork, 480)}" alt="">`}
      <div class="hero-text"><div class="kind">Artist</div><h1 class="${a.name.length > 20 ? 'long' : ''}">${esc(a.name)}</h1>
      ${a.genreNames && a.genreNames.length ? `<div class="meta">${esc(a.genreNames.join(', '))}</div>` : ''}</div>
    </header>
    ${actionsHtml({ shuffle: !!top.length, play: !!top.length, more: false })}
    ${top.length ? `<section class="shelf"><header><h2>Popular</h2></header>
      <div class="tracks popular">${trackRows(top.slice(0, 10), key, { album: true, header: false })}</div>
      ${top.length > 5 ? '<button class="text-btn see-more">See more</button>' : ''}</section>` : ''}
    ${latest ? `<section class="shelf"><header><h2>Latest release</h2></header><div class="shelf-row">${cardHtml(toCard(latest))}</div></section>` : ''}
    ${shelf('Albums', viewData('full-albums'))}
    ${shelf('Singles & EPs', viewData('singles'))}
    ${shelf('Featured playlists', viewData('featured-playlists'))}
    ${shelf('Appears on', viewData('appears-on-albums'))}
    ${shelf('Fans also like', viewData('similar-artists'))}
    ${a.artistBio ? `<section class="shelf about"><header><h2>About</h2></header><p>${esc(a.artistBio)}</p></section>` : ''}
  </div>`;
  const pop = el.querySelector('.popular');
  const seeMore = el.querySelector('.see-more');
  if (seeMore) seeMore.addEventListener('click', () => {
    pop.classList.toggle('expanded');
    seeMore.textContent = pop.classList.contains('expanded') ? 'Show less' : 'See more';
  });
  bindActions(el, {
    play: () => playList(key, 0),
    shuffle: () => playList(key, null, { shuffle: true }),
  });
  markPlaying(el);
}

/** Resolves "the artist of this song" (used when the now-playing item has no artist id). */
async function songArtist(el, m) {
  const songId = decodeURIComponent(m[1]);
  const name = decodeURIComponent(m[2] || '');
  el.innerHTML = loading();
  const firstArtist = (r) => {
    const d = r && r.data && r.data[0];
    const a = d && d.relationships && d.relationships.artists && d.relationships.artists.data;
    return a && a[0] ? a[0].id : null;
  };
  let id = null;
  try {
    if (/^\d+$/.test(songId)) id = firstArtist(await am(`/v1/catalog/${sf()}/songs/${enc(songId)}?include=artists`));
    else if (songId.startsWith('i.')) id = firstArtist(await am(`/v1/me/library/songs/${enc(songId)}?include=artists`));
  } catch (e) { /* fall back to a name search */ }
  if (!id && name) {
    try {
      const r = await am(`/v1/catalog/${sf()}/search?term=${enc(name)}&types=artists&limit=5`);
      const list = (r.results && r.results.artists && r.results.artists.data) || [];
      const exact = list.find((a) => a.attributes && a.attributes.name.toLowerCase() === name.toLowerCase());
      id = (exact || list[0] || {}).id || null;
    } catch (e) { /* handled below */ }
  }
  if (id) { location.replace(`#/artist/${enc(id)}`); return; }
  el.innerHTML = errorBox(new Error('Artist not found'), 'this artist');
}

async function libraryArtist(el, id) {
  try {
    const r = await am(PAGE_PATHS.libraryArtist(id));
    const d = r.data && r.data[0];
    const cat = d && d.relationships && d.relationships.catalog && d.relationships.catalog.data && d.relationships.catalog.data[0];
    if (cat) { location.replace(`#/artist/${cat.id}`); return; }
    const albums = await am(PAGE_PATHS.libraryArtistAlbums(id));
    setHero(null);
    el.innerHTML = `<div class="page">${heroHtml({ artwork: null, kind: 'Artist · Library', title: d ? d.attributes.name : 'Artist', meta: '', round: true })}
      <section class="shelf"><header><h2>Albums in your library</h2></header>${grid(albums.data)}</section></div>`;
  } catch (e) {
    el.innerHTML = errorBox(e, 'this artist');
  }
}

// ------------------------------------------------------------------ library

export function libraryRow(r) {
  const c = toCard(r);
  if (!c) return '';
  const kind = r.type.includes('playlist') ? 'Playlist' : r.type.includes('album') ? 'Album' : 'Artist';
  return `<a class="lib-item" href="${esc(c.href)}" title="${esc(c.title)}" data-card="${esc(JSON.stringify({ id: c.id, type: c.type, play: c.play, href: c.href }))}">
    <img class="${c.round ? 'round' : ''}" loading="lazy" src="${art(c.artwork, 96)}"${c.mosaic ? ` data-mosaic="${esc(c.mosaic)}"` : ''} alt="">
    <div><div class="t">${esc(c.title)}</div><div class="s">${kind}${c.round || !c.sub || c.sub === kind ? '' : ` • ${esc(c.sub)}`}</div></div></a>`;
}

// The library page has its own layout (header, filters, search, sort, grid or list); it shares nothing with the
// sidebar's compact list, so collapsing the sidebar doesn't touch it.
const LIB_KINDS = { playlists: 'Playlists', albums: 'Albums', artists: 'Artists' };
const LIB_SORTS = { recent: 'Recently added', alpha: 'Alphabetical', creator: 'Creator' };
let libQuery = ''; // the filter text survives switching tabs and quiet refreshes

const libSingular = (kind) => ({ playlists: 'Playlist', albums: 'Album', artists: 'Artist' }[kind]);

function libEntry(r, kind) {
  const c = toCard(r);
  if (!c) return null;
  const a = r.attributes || {};
  const creator = kind === 'albums' ? a.artistName || '' : kind === 'playlists' ? a.curatorName || '' : '';
  c.creator = creator;
  c.sub = kind === 'artists' ? 'Artist' : kind === 'albums' ? creator || 'Album' : creator ? `Playlist • ${creator}` : 'Playlist';
  c.added = a.dateAdded ? Date.parse(a.dateAdded) : 0;
  return c;
}

function libSorted(list, sort) {
  const by = (f) => list.slice().sort((x, y) => f(x, y) || x.title.localeCompare(y.title, undefined, { sensitivity: 'base' }));
  if (sort === 'alpha') return by(() => 0);
  if (sort === 'creator') return by((x, y) => (x.creator || '￿').localeCompare(y.creator || '￿', undefined, { sensitivity: 'base' }));
  // Recently added; entries without a date keep Apple's order, after the dated ones.
  return list.map((c, i) => [c, i]).sort((x, y) => (y[0].added - x[0].added) || (x[1] - y[1])).map((x) => x[0]);
}

function libDate(ms) {
  if (!ms) return '';
  const days = Math.floor((Date.now() - ms) / 86400000);
  if (days < 1) return 'Today';
  if (days < 2) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 28) return `${Math.floor(days / 7)} week${days < 14 ? '' : 's'} ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

const libCardData = (c) => esc(JSON.stringify({ id: c.id, type: c.type, play: c.play, href: c.href }));

function libGridHtml(list, pinned) {
  const pin = pinned ? `
    <a class="lib-pin fav" href="#/favorites"><span class="lib-pin-ic">${icon('heart')}</span><span class="lib-pin-t">Favorite Songs</span><span class="lib-pin-s">Synced with Apple Music</span></a>
    <a class="lib-pin all" href="#/songs"><span class="lib-pin-ic">${icon('library')}</span><span class="lib-pin-t">Songs</span><span class="lib-pin-s">Everything in your library</span></a>` : '';
  return `<div class="lib-grid">${pin}${list.map(cardHtml).join('')}</div>`;
}

function libListHtml(list, pinned, kind) {
  const dated = list.some((c) => c.added);
  const row = (c, i) => `<a class="lib-tr" href="${esc(c.href)}" data-card="${libCardData(c)}">
      <span class="lib-td-n">${i + 1}</span>
      <span class="lib-td-title"><img class="${c.round ? 'round' : ''}" loading="lazy" src="${art(c.artwork, 96)}"${c.mosaic ? ` data-mosaic="${esc(c.mosaic)}"` : ''} alt="">
        <span><b>${esc(c.title)}</b><small>${esc(c.sub)}</small></span></span>
      <span class="lib-td-kind">${libSingular(kind)}</span>
      <span class="lib-td-date">${dated ? libDate(c.added) : ''}</span></a>`;
  const pin = (href, cls, ic, t, sub) => `<a class="lib-tr pinned" href="${href}">
      <span class="lib-td-n"></span>
      <span class="lib-td-title"><span class="lib-pin-sq ${cls}">${icon(ic)}</span><span><b>${t}</b><small>${sub}</small></span></span>
      <span class="lib-td-kind">Collection</span><span class="lib-td-date"></span></a>`;
  return `<div class="lib-table${dated ? '' : ' undated'}">
    <div class="lib-tr lib-th"><span class="lib-td-n">#</span><span>Title</span><span class="lib-td-kind">Type</span><span class="lib-td-date">${dated ? 'Date added' : ''}</span></div>
    ${pinned ? pin('#/favorites', 'fav', 'heart', 'Favorite Songs', 'Synced with Apple Music') + pin('#/songs', 'all', 'library', 'Songs', 'Everything in your library') : ''}
    ${list.map(row).join('')}</div>`;
}

async function library(el, m) {
  setHero('3d2f5c');
  const kind = LIB_KINDS[m[1]] ? m[1] : 'playlists';
  let view = persist('orchard.libView') === 'list' ? 'list' : 'grid';
  let sort = LIB_SORTS[persist('orchard.libSort')] ? persist('orchard.libSort') : 'recent';
  if (kind === 'artists' && sort === 'creator') sort = 'alpha';
  el.innerHTML = `<div class="page lib-page">
    <header class="lib-head">
      <h1>Your Library</h1>
      <button class="lib-new" data-lp="new">${icon('plus')}<span>Create playlist</span></button>
    </header>
    <div class="lib-tools">
      <nav class="lib-tabs">${Object.entries(LIB_KINDS).map(([k, label]) =>
        `<a class="lib-tab${k === kind ? ' on' : ''}" href="#/library/${k}">${label}</a>`).join('')}<a class="lib-tab" href="#/songs">Songs</a></nav>
      <div class="lib-ctl">
        <label class="lib-find">${icon('search')}<input type="search" placeholder="Search in ${LIB_KINDS[kind]}" value="${esc(libQuery)}" aria-label="Search in ${LIB_KINDS[kind]}"></label>
        <button class="lib-sort" data-lp="sort"><span>${LIB_SORTS[sort]}</span>${icon('sort')}</button>
        <div class="lib-views" role="group" aria-label="View">
          <button data-view="grid" title="Grid" class="${view === 'grid' ? 'on' : ''}">${icon('grid')}</button>
          <button data-view="list" title="List" class="${view === 'list' ? 'on' : ''}">${icon('list')}</button>
        </div>
      </div>
    </div>
    <div class="lib-body">${loading()}</div></div>`;
  const page = el.querySelector('.lib-page');
  const body = page.querySelector('.lib-body');
  const input = page.querySelector('.lib-find input');
  let entries = null;

  const draw = () => {
    if (!entries) return;
    const q = libQuery.trim().toLowerCase();
    const list = libSorted(entries, sort).filter((c) => !q || c.title.toLowerCase().includes(q) || c.sub.toLowerCase().includes(q));
    const pinned = kind === 'playlists' && !q;
    if (!list.length && !pinned) {
      body.innerHTML = q ? `<div class="empty"><h3>No matches for "${esc(libQuery.trim())}"</h3><p>Try a different word.</p></div>`
        : `<div class="empty"><h3>No ${kind} yet</h3><p>${kind === 'artists' ? 'Artists' : LIB_KINDS[kind]} you add to your library show up here.</p></div>`;
      return;
    }
    body.innerHTML = view === 'grid' ? libGridHtml(list, pinned) : libListHtml(list, pinned, kind);
  };

  page.addEventListener('click', (e) => {
    const v = e.target.closest('[data-view]');
    if (v) {
      view = v.dataset.view;
      persist('orchard.libView', view);
      page.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', b === v));
      draw();
      return;
    }
    const b = e.target.closest('[data-lp]');
    if (!b) return;
    if (b.dataset.lp === 'new') openPlaylistEditor();
    if (b.dataset.lp === 'sort') {
      const keys = Object.keys(LIB_SORTS).filter((k) => kind !== 'artists' || k !== 'creator');
      openMenu(b, keys.map((k) => ({
        label: LIB_SORTS[k], icon: k === sort ? 'check' : undefined,
        run: () => {
          sort = k;
          persist('orchard.libSort', k);
          b.querySelector('span').textContent = LIB_SORTS[k];
          draw();
        },
      })), 'Sort by');
    }
  });
  input.addEventListener('input', debounce(() => { libQuery = input.value; draw(); }, 120));

  if (!browsable()) {
    body.innerHTML = `<div class="empty"><h3>Sign in to see your library</h3><p>Your playlists, albums and artists from Apple Music show up here.</p></div>`;
    return;
  }
  try {
    entries = (await libraryList(kind)).map((r) => libEntry(r, kind)).filter(Boolean);
    draw();
  } catch (e) {
    body.innerHTML = errorBox(e, 'your library');
  }
}

/** Apple Music's own "Favorite Songs" playlist: everything you've hearted, in Orchard or any Apple device. */
async function favorites(el) {
  setHero('5b2ee0');
  el.innerHTML = loading();
  let p = null;
  try {
    p = await favoritesPlaylist(true);
  } catch (e) {
    el.innerHTML = errorBox(e, 'your Favorite Songs');
    return;
  }
  if (p) return playlist(el, [null, p.id]);
  el.innerHTML = `<div class="page">
    <header class="hero"><div class="hero-art songs-art">${icon('heart')}</div><div class="hero-text"><div class="kind">Playlist</div>
    <h1>Favorite Songs</h1></div></header>
    <div class="empty"><h3>Songs you favorite will appear here</h3>
    <p>Tap the heart on any song. Favorites sync to Apple Music's <b>Favorite Songs</b> playlist on all your devices.
    Apple creates that playlist after your first favorite; it can take a minute to show up.</p></div></div>`;
}

async function songs(el) {
  setHero('4a2a7a');
  el.innerHTML = loading();
  let r;
  try {
    r = await am(PAGE_PATHS.songs());
  } catch (e) {
    el.innerHTML = errorBox(e, 'your songs');
    return;
  }
  const tracks = (r.data || []).map(toTrack);
  const key = registerList(tracks);
  el.innerHTML = `<div class="page">
    <header class="hero"><div class="hero-art songs-art all">${icon('library')}</div><div class="hero-text"><div class="kind">Library</div><h1>Songs</h1>
    <div class="meta">${r.meta && r.meta.total ? `${r.meta.total} songs` : ''}</div></div></header>
    ${actionsHtml({ more: false })}
    <div class="tracks">${tracks.length ? trackRows(tracks, key) : '<div class="empty"><p>Songs you add to your library show up here.</p></div>'}</div></div>`;
  bindActions(el, { play: () => playList(key, 0), shuffle: () => playList(key, null, { shuffle: true }) });
  markPlaying(el);
  const list = el.querySelector('.tracks');
  return infinite(el.querySelector('.page'), withLimit(r.next), (data) => {
    const L = getList(key);
    const more = data.map(toTrack);
    const start = L.tracks.length;
    L.tracks.push(...more);
    list.insertAdjacentHTML('beforeend', trackRows(more, key, { start, header: false }));
  });
}

// ------------------------------------------------------------------ queue

export const fromItem = (it) => ({ ...it, playable: true, playId: it.id, type: 'songs' });

export function renderQueue(el, { compact = false } = {}) {
  let sig = '';
  let deferred = false;
  // The state carries the queue around the current song; songs further down are read page by page as you
  // scroll (any length). `more` holds them by queue index, valid while the queue's revision stays the same.
  let more = new Map();
  let moreRev = null;
  let busy = false;
  let pagingFailed = false;
  let refetching = 0;
  let refetchRev; // the revision a running refetch is for
  let ctx = null; // what the last full draw rendered: { q, list, key, nextItems, end }
  const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) loadMore(); });
  const PAGE_SIZE = 200;

  const sentinelHtml = (q, end) => (end < q.total
    ? (pagingFailed ? `<p class="muted small q-more">+ ${q.total - end} more</p>` : '<div class="sentinel q-more"></div>')
    : '');

  /** Songs at queue indexes from..: the state's window first, then pages loaded earlier. */
  function collect(q, from) {
    const out = [];
    for (let i = from; i < q.total; i++) {
      const it = i - q.offset < q.items.length ? q.items[i - q.offset] : more.get(i);
      if (!it) break;
      out.push(fromItem(it));
    }
    return out;
  }

  async function pages(start, count) {
    const items = [];
    let rev = null;
    while (items.length < count) {
      const r = await queuePage(start + items.length, Math.min(PAGE_SIZE, count - items.length));
      if (rev !== null && r.rev !== rev) throw new Error('queue changed');
      rev = r.rev;
      if (!r.items || !r.items.length) break;
      items.push(...r.items);
    }
    return { rev, items };
  }

  // The queue was edited (here or elsewhere) while songs further down were showing: read them again, then
  // redraw once, so the list doesn't shrink and jump while they reload.
  async function refetch(q) {
    if (refetchRev === q.rev) return; // already on it
    refetchRev = q.rev;
    const token = ++refetching;
    const end = q.offset + q.items.length;
    let last = -1;
    for (const k of more.keys()) if (k > last) last = k;
    const want = Math.max(0, last + 1 - end);
    let fresh = new Map();
    let rev = q.rev;
    try {
      const r = await pages(end, want);
      rev = r.rev;
      r.items.forEach((it, k) => fresh.set(end + k, it));
    } catch (e) { fresh = new Map(); }
    if (token !== refetching) return;
    refetchRev = undefined;
    more = fresh;
    moreRev = rev;
    sig = '';
    draw();
  }

  async function loadMore() {
    const c = ctx;
    if (!c || busy || pagingFailed || c.end >= c.q.total) return;
    busy = true;
    try {
      const r = await queuePage(c.end, PAGE_SIZE);
      const now = S.state.queue;
      // Only keep it if nothing changed meanwhile; otherwise the next state update redraws and asks again.
      if (c === ctx && now && r.rev === now.rev && (moreRev === null || moreRev === r.rev) && r.start === c.end) {
        moreRev = r.rev;
        (r.items || []).forEach((it, k) => more.set(r.start + k, it));
        const added = (r.items || []).map(fromItem);
        if (added.length) {
          const L = getList(c.key);
          const start = c.nextItems.length;
          c.nextItems.push(...added); // the registered list's own array, so clicks and drags see them
          c.end += added.length;
          c.list.insertAdjacentHTML('beforeend', trackRows(added, c.key, { album: !compact, header: false, artwork: true, queue: true, start }));
          if (L && L.tracks !== c.nextItems) L.tracks.push(...added);
          markPlaying(c.list);
        }
        const s = el.querySelector('.q-more');
        if (s) { io.unobserve(s); s.remove(); }
        c.list.insertAdjacentHTML('afterend', sentinelHtml(c.q, c.end));
        const s2 = el.querySelector('.sentinel.q-more');
        if (s2) io.observe(s2);
      }
    } catch (e) {
      // An older speaker without paging (or a network problem): show the count instead.
      pagingFailed = true;
      const s = el.querySelector('.q-more');
      if (s && ctx) { io.unobserve(s); s.outerHTML = sentinelHtml(ctx.q, ctx.end); }
    } finally {
      busy = false;
    }
  }

  const draw = () => {
    if (isRowDragging()) { deferred = true; return; }
    const q = S.state.queue;
    if (q && q.rev !== moreRev) {
      if (more.size && q.rev != null) { refetch(q); return; } // keep what's shown until the new pages are in
      more = new Map();
      moreRev = q.rev;
    }
    const s = q ? `${q.position}|${q.offset}|${q.total}|${q.rev}|${(q.items || []).map((i) => i && i.id).join(',')}` : 'none';
    if (s === sig) { markPlaying(el); return; }
    sig = s;
    io.disconnect();
    ctx = null;
    if (!q || !q.items || !q.items.length || q.position < 0) {
      el.innerHTML = `${compact ? '' : '<h1 class="page-title">Queue</h1>'}<div class="empty"><h3>Your queue is empty</h3><p>Find something to play in Search or your Library.</p></div>`;
      return;
    }
    const rel = q.position - q.offset;
    const cur = q.items[rel] ? [fromItem(q.items[rel])] : [];
    const nextItems = collect(q, q.position + 1);
    const end = q.position + 1 + nextItems.length;
    const k1 = registerList(cur, { queueOffset: q.position });
    const k2 = registerList(nextItems, { queueOffset: q.position + 1 });
    const opts = { album: !compact, header: false, artwork: true };
    el.innerHTML = `${compact ? '' : '<h1 class="page-title">Queue</h1>'}
      <h2 class="queue-h">Now playing</h2><div class="tracks">${trackRows(cur, k1, opts)}</div>
      ${nextItems.length ? `<h2 class="queue-h">Next up</h2><div class="tracks q-next">${trackRows(nextItems, k2, { ...opts, queue: true })}</div>` : ''}
      ${nextItems.length ? sentinelHtml(q, end) : ''}`;
    const list = el.querySelector('.q-next');
    if (list) {
      ctx = { q, list, key: k2, nextItems, end };
      const sentinel = el.querySelector('.sentinel.q-more');
      if (sentinel) io.observe(sentinel);
      enableRowDrag(list, {
        onMove: (a, b) => {
          const from = q.position + 1 + a;
          const to = q.position + 1 + b;
          const t = nextItems[a];
          // Songs past the state's window aren't edited locally: move the row here until the speaker answers.
          const local = from - q.offset < q.items.length && to - q.offset < q.items.length;
          if (!local) {
            const rows = [...list.querySelectorAll('.q-row')];
            rows[b].insertAdjacentElement(b > a ? 'afterend' : 'beforebegin', rows[a]);
            nextItems.splice(b, 0, ...nextItems.splice(a, 1));
            [...list.querySelectorAll('.q-row')].forEach((r, i) => {
              r.dataset.i = i;
              const n = r.querySelector('.num');
              if (n) n.textContent = i + 1;
            });
          }
          moveInQueue(from, to, t);
        },
        // Catch up on any update that arrived mid-drag.
        onEnd: () => { if (deferred) { deferred = false; draw(); } },
      });
    }
    markPlaying(el);
  };
  draw();
  const unsub = subscribe((kind) => { if (kind === 'state') draw(); });
  return () => { unsub(); io.disconnect(); refetching++; refetchRev = undefined; };
}

function queue(el) {
  setHero(null);
  el.innerHTML = '<div class="page queue-page"></div>';
  return renderQueue(el.firstChild);
}

// ------------------------------------------------------------------ router table

export const routes = [
  [/^#?\/?$/, home],
  [/^#\/home$/, home],
  [/^#\/search(?:\/(.*))?$/, search],
  [/^#\/album\/([^/?]+)/, album],
  [/^#\/playlist\/([^/?]+)/, playlist],
  [/^#\/artist\/([^/?]+)/, artist],
  [/^#\/song-artist\/([^/?]+)\/([^/?]*)/, songArtist],
  [/^#\/library(?:\/(\w+))?$/, library],
  [/^#\/songs$/, songs],
  [/^#\/favorites$/, favorites],
  [/^#\/queue$/, queue],
];

export { playQueue };
