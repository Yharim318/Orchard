// Injected by Orchard into music.apple.com. Bridges Apple's MusicKit player to the Orchard server.
// Commands arrive through window.__orchard.* (called via DevTools); state goes back through window.__orchardEmit.
(() => {
  // Where Apple's player runs:
  //  - window mode: the top-level music.apple.com page (but not Orchard's own /orchard page on the same site);
  //  - embedded: the #am-engine iframe inside the Orchard page at https://music.apple.com/orchard/.
  let isEngineFrame = false;
  if (window === window.top) {
    isEngineFrame = !/^\/(orchard|juice)(\/|$)/.test(location.pathname); // /juice: the app page before the rename
  } else if (window.parent === window.top) {
    try { isEngineFrame = !!window.frameElement && window.frameElement.id === 'am-engine'; }
    catch (e) { isEngineFrame = true; } // embedded under a non-Apple page
  }
  if (!isEngineFrame || !/(^|\.)music\.apple\.com$/.test(location.hostname) || window.__orchard) return;

  // Orchard used to be called Juice: carry settings saved under the old names ("juice.*") over, once.
  // The app's util.js does the same; the old keys are left for older builds.
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

  const log = (...a) => { try { console.log('[orchard]', ...a); } catch (e) { /* ignore */ } };
  const emit = (msg) => { try { window.__orchardEmit(JSON.stringify(msg)); } catch (e) { /* binding not ready */ } };
  emit({ type: 'boot', url: location.href });
  window.addEventListener('pagehide', () => emit({ type: 'bye' }));

  // Two shortcuts keep working while this page has keyboard focus: show/hide this page (Ctrl+Shift+A) and the
  // log window (Ctrl+Shift+T), or whatever keys the user chose in Settings. The app window is on this same site,
  // so its saved shortcuts (localStorage 'orchard.keys', see web/js/keys.js) are readable here.
  const keysFor = (id, def) => {
    try {
      const v = JSON.parse(localStorage.getItem('orchard.keys') || '{}')[id];
      if (Array.isArray(v)) return v;
    } catch (e) { /* nothing saved */ }
    return def;
  };
  const comboOf = (e) => { // same format as keys.js comboOf
    const k = e.key;
    if (!k || ['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Dead', 'Unidentified'].includes(k)) return null;
    const key = k === ' ' ? 'Space' : k === '+' ? 'Plus' : k.length === 1 ? k.toUpperCase() : k;
    const mods = [];
    if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey && (/^[A-Z]$/.test(key) || k.length > 1)) mods.push('Shift');
    return [...mods, key].join('+');
  };
  window.addEventListener('keydown', (e) => {
    const combo = comboOf(e);
    if (!combo) return;
    let action = null;
    if (keysFor('apple', ['Ctrl+Shift+A']).includes(combo)) action = 'toggle';
    else if (keysFor('log', ['Ctrl+Shift+T']).includes(combo)) action = 'console';
    if (!action) return;
    // Plain keys (no Ctrl/Alt) would get in the way of typing on Apple's sign-in page.
    if (!(e.ctrlKey || e.metaKey || e.altKey) && e.target.closest && e.target.closest('input, textarea, [contenteditable]')) return;
    e.preventDefault();
    e.stopPropagation();
    emit({ type: 'ui', action });
  }, true);

  // ---------------------------------------------------------------- audio output (which local device plays)
  // Apple's player plays through <audio>/<video> elements. Chromium's setSinkId() sends an element's sound to a
  // chosen output (speakers, Bluetooth headphones…). Device names are only visible because Orchard grants this
  // site microphone permission over DevTools; nothing is ever recorded.
  const OUT_KEY = 'orchard.audioOutput';
  let outputs = [];       // [{id, label}], id '' = the system default
  let wanted = null;      // {id, label} the user picked, or null = system default
  try { wanted = JSON.parse(localStorage.getItem(OUT_KEY) || 'null'); } catch (e) { /* none saved */ }
  const media = new Set();

  /** The sink id to use now: the picked device if it is connected (matched by id, then by name), else default. */
  function sinkId() {
    if (!wanted || !wanted.id) return '';
    const hit = outputs.find((o) => o.id === wanted.id) || outputs.find((o) => o.label && o.label === wanted.label);
    return hit ? hit.id : '';
  }

  function applySink(el) {
    if (!el || typeof el.setSinkId !== 'function') return;
    media.add(el);
    const id = sinkId();
    if (el.sinkId !== id) el.setSinkId(id).catch((e) => log('could not switch audio output', String(e)));
  }

  // Catch every element Apple's player starts, including ones never added to the page.
  const realPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    try { applySink(this); } catch (e) { /* never block playback */ }
    return realPlay.apply(this, args);
  };

  async function refreshOutputs() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
      const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
      const sys = list.find((d) => d.deviceId === 'default');
      outputs = [{ id: '', label: 'System default', detail: sys && sys.label ? sys.label.replace(/^Default\s*-\s*/i, '') : '' }]
        .concat(list.filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications' && d.label)
          .map((d) => ({ id: d.deviceId, label: d.label })));
    } catch (e) {
      log('cannot list audio outputs', String(e));
    }
    media.forEach(applySink); // e.g. the picked headphones just reconnected
    if (mk) schedule(false);
  }
  if (navigator.mediaDevices) navigator.mediaDevices.addEventListener('devicechange', refreshOutputs);

  async function setOutput(id) {
    await refreshOutputs();
    const o = outputs.find((x) => x.id === (id || ''));
    if (!o) throw new Error('That audio output is no longer connected');
    wanted = o.id ? { id: o.id, label: o.label } : null;
    try {
      if (wanted) localStorage.setItem(OUT_KEY, JSON.stringify(wanted)); else localStorage.removeItem(OUT_KEY);
    } catch (e) { /* storage blocked: still applies until reload */ }
    await Promise.all([...media].map((el) => (el.setSinkId ? el.setSinkId(sinkId()) : null)));
  }

  let mk = null;
  // State updates carry a window of the queue around the current song; the rest is read in pages through
  // queueItems(). queueRev changes whenever the queue's contents change (not when it just moves on), so a
  // page read earlier stays valid until then.
  const QUEUE_BEFORE = 15, QUEUE_AFTER = 100;
  let queueRev = 0;

  const relId = (it, rel) => {
    try { return it.relationships[rel].data[0].id; } catch (e) { return null; }
  };

  function itemInfo(it) {
    if (!it) return null;
    const a = it.attributes || {};
    const pp = a.playParams || it.playParams || {};
    const url = a.url || '';
    let albumId = relId(it, 'albums');
    if (!albumId) {
      const m = url.match(/\/album\/(?:[^/]+\/)?(\d+)/);
      if (m) albumId = m[1];
    }
    const artwork = it.artwork || a.artwork || null;
    return {
      id: it.id,
      catalogId: pp.catalogId || (pp.isLibrary ? null : pp.id) || it.songId || null,
      kind: pp.kind || it.type || 'song',
      title: it.title || a.name || '',
      artist: it.artistName || a.artistName || '',
      album: it.albumName || a.albumName || '',
      artwork: artwork && artwork.url ? artwork.url : null,
      bgColor: artwork && artwork.bgColor ? artwork.bgColor : null,
      duration: (it.playbackDuration || a.durationInMillis || 0) / 1000,
      albumId,
      artistId: relId(it, 'artists'),
      explicit: a.contentRating === 'explicit',
      hasLyrics: !!a.hasLyrics,
    };
  }

  function snapshot(full) {
    const m = mk;
    const s = {
      ready: true,
      authorized: !!m.isAuthorized,
      storefront: m.storefrontId || m.storefrontCountryCode || 'us',
      playbackState: m.playbackState,
      isPlaying: !!m.isPlaying,
      position: m.currentPlaybackTime || 0,
      duration: m.currentPlaybackDuration || 0,
      volume: typeof m.volume === 'number' ? m.volume : 1,
      shuffle: m.shuffleMode ? 1 : 0,
      repeat: m.repeatMode || 0,
      item: itemInfo(m.nowPlayingItem),
      outputs,
      output: sinkId(),
      outputWanted: wanted ? wanted.label : null, // set even while that device is disconnected
    };
    if (full) {
      const q = m.queue || {};
      const items = q.items || [];
      const pos = typeof q.position === 'number' ? q.position : -1;
      const start = Math.max(0, pos - QUEUE_BEFORE);
      const end = Math.min(items.length, Math.max(pos, 0) + QUEUE_AFTER);
      s.queue = { position: pos, offset: start, total: items.length, rev: queueRev, items: items.slice(start, end).map(itemInfo) };
    }
    return s;
  }

  // Coalesce bursts of MusicKit events into a single state message.
  let timer = null, pendingFull = false, lastTimeEmit = 0;
  function schedule(full) {
    pendingFull = pendingFull || full;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const f = pendingFull;
      pendingFull = false;
      lastTimeEmit = Date.now();
      try { emit({ type: 'state', state: snapshot(f) }); } catch (e) { log('snapshot failed', String(e)); }
    }, 60);
  }

  function attach(instance) {
    mk = instance;
    const on = (name, full) => {
      try { mk.addEventListener(name, () => schedule(full)); } catch (e) { log('cannot listen to', name); }
    };
    try { mk.addEventListener('queueItemsDidChange', () => { queueRev++; }); } catch (e) { /* no paging guard */ }
    ['nowPlayingItemDidChange', 'queueItemsDidChange', 'queuePositionDidChange', 'authorizationStatusDidChange',
      'storefrontIdentifierDidChange'].forEach((n) => on(n, true));
    ['playbackStateDidChange', 'playbackVolumeDidChange', 'shuffleModeDidChange', 'repeatModeDidChange',
      'playbackDurationDidChange'].forEach((n) => on(n, false));
    mk.addEventListener('playbackTimeDidChange', () => {
      if (Date.now() - lastTimeEmit > 5000) schedule(false);
    });
    mk.addEventListener('mediaPlaybackError', (e) => log('playback error', String(e && (e.message || e.errorCode || e))));
    log('MusicKit attached, authorized =', !!mk.isAuthorized);
    refreshOutputs();
    schedule(true);
  }

  function findInstance() {
    try {
      if (window.MusicKit && typeof MusicKit.getInstance === 'function') return MusicKit.getInstance() || null;
    } catch (e) { /* not configured yet */ }
    return null;
  }

  const poll = setInterval(() => {
    const inst = findInstance();
    if (inst) { clearInterval(poll); attach(inst); }
  }, 300);

  // ---------------------------------------------------------------- commands

  // MusicKit promises (play, setQueue…) can stay pending for a long time while media loads;
  // don't hold the remote's request hostage — give up waiting after a few seconds (errors still propagate).
  const settle = (p, ms = 6000) => Promise.race([Promise.resolve(p), new Promise((r) => setTimeout(r, ms))]);

  const need = () => { if (!mk) throw new Error('MusicKit is not ready yet'); return mk; };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));

  async function playQueue(m, desc, startIndex, shuffle) {
    const d = Object.assign({}, desc);
    if (typeof startIndex === 'number' && startIndex >= 0) d.startWith = startIndex;
    if (shuffle != null) m.shuffleMode = shuffle ? 1 : 0;
    await settle(m.setQueue(d), 15000);
    if (typeof startIndex === 'number' && startIndex > 0 && !shuffle && m.queue && m.queue.position !== startIndex) {
      try { await settle(m.changeToMediaAtIndex(startIndex)); } catch (e) { /* best effort */ }
    }
    await settle(m.play());
  }

  /**
   * Edits the songs after the current one. MusicKit's own "play next" goes through
   * queue.spliceQueueItems (which keeps autoplay flags and makes the player re-prepare the next song);
   * older builds only have queue.splice. Neither moves the current position, so edits before or at
   * the current song are refused.
   */
  function queueEditor(m) {
    const q = m.queue;
    const useQueueItems = q && typeof q.spliceQueueItems === 'function';
    if (!q || (!useQueueItems && typeof q.splice !== 'function')) {
      throw new Error('This version of Apple Music does not allow editing the queue');
    }
    const pos = typeof q.position === 'number' ? q.position : -1;
    const length = () => (q.items || []).length;
    const idAt = (i) => { const it = (q.items || [])[i]; return it ? String(it.id) : null; };
    return {
      pos,
      length,
      splice: (start, count, add = []) => (useQueueItems ? q.spliceQueueItems(start, count, add) : q.splice(start, count, add)),
      /** Index of an upcoming song; `id` guards against the queue having changed since the UI rendered it. */
      upcoming(index, id) {
        let i = Math.trunc(Number(index));
        if (id != null && idAt(i) !== String(id)) {
          i = -1;
          for (let k = pos + 1; k < length(); k++) if (idAt(k) === String(id)) { i = k; break; }
        }
        if (!(i > pos && i < length())) throw new Error('That song is no longer up next');
        return i;
      },
    };
  }

  /**
   * After a queue edit, makes sure the song MusicKit has preloaded is the one that now comes next.
   * With seamless transitions MusicKit buffers the next song ahead of time and plays straight into it
   * when the current one ends. On a queue change it only preloads again if the new next song hasn't been
   * fetched before (prepareToPlayNextItem skips "prepared" songs), and even then the old song stays
   * buffered until the new one has loaded. Either way, the old next song played for a moment before
   * MusicKit noticed and switched. So drop a stale preload straight away (as MusicKit's own clearQueue
   * does) and preload the right song if MusicKit won't. Uses MusicKit internals: if they change, this
   * does nothing and only the old glitch comes back.
   * Preloads that were already loading can still land on a song that's no longer next (quick edits in a
   * row), so check again once ours finishes (only dropping, never preloading again, so this can't loop)
   * and a little later for MusicKit's own.
   */
  let preloadRecheck = [];
  function refreshNextPreload(m, { recheck = true, preload = true } = {}) {
    if (recheck) {
      preloadRecheck.forEach(clearTimeout);
      preloadRecheck = [1500, 5000].map((ms) => setTimeout(() => refreshNextPreload(m, { recheck: false }), ms));
    }
    try {
      const mip = m._mediaItemPlayback;
      const player = mip && (typeof mip.getCurrentPlayer === 'function' ? mip.getCurrentPlayer() : mip._currentPlayer);
      const stale = player && player.nextManifest;
      if (!stale || !stale.mediaItem) return; // nothing buffered yet: MusicKit preloads the right song later
      const next = m.queue && m.queue.nextPlayableItem;
      if (next && (next === stale.mediaItem || String(next.id) === String(stale.mediaItem.id))) return;
      log('dropping preloaded', stale.mediaItem.title, 'next is now', next ? next.title : '(nothing)');
      mip.clearNextManifest(); // empties the buffer's next slot and undoes a transition already under way
      player.nextManifest = undefined;
      if (typeof player.tearDownManifest === 'function') Promise.resolve(player.tearDownManifest(stale)).catch(() => {});
      // MusicKit preloads songs it hasn't fetched yet itself (on queueItemsDidChange); do the rest here.
      if (preload && next && next.isPreparedToPlay && typeof mip.prepareToPlay === 'function') {
        Promise.resolve(mip.prepareToPlay(next))
          .then(() => refreshNextPreload(m, { recheck: false, preload: false }), (e) => log('preload failed', e && e.message));
      }
    } catch (e) {
      log('refreshNextPreload', e && e.message);
    }
  }

  async function cmd(c) {
    const m = need();
    switch (c.type) {
      case 'playQueue':
        await playQueue(m, c.queue, c.startIndex, c.shuffle);
        break;
      case 'toggle':
        if (m.isPlaying) await settle(m.pause()); else await settle(m.play());
        break;
      case 'play': await settle(m.play()); break;
      case 'pause': await settle(m.pause()); break;
      case 'next': await settle(m.skipToNextItem()); break;
      case 'prev':
        if ((m.currentPlaybackTime || 0) > 3) await settle(m.seekToTime(0));
        else await settle(m.skipToPreviousItem());
        break;
      case 'seek': await settle(m.seekToTime(clamp(c.position, 0, 1e6))); break;
      case 'volume': m.volume = clamp(c.value, 0, 1); break;
      case 'shuffle': m.shuffleMode = c.on ? 1 : 0; break;
      case 'repeat': m.repeatMode = clamp(c.mode, 0, 2); break;
      case 'jump': await settle(m.changeToMediaAtIndex(clamp(c.index, 0, 1e6))); break;
      case 'playNext':
      case 'playLater': {
        const empty = !m.queue || !m.queue.items || m.queue.items.length === 0;
        if (empty) await playQueue(m, c.queue);
        else if (c.type === 'playNext') await settle(m.playNext(c.queue));
        else await settle(m.playLater(c.queue));
        refreshNextPreload(m);
        break;
      }
      case 'remove': {
        const ed = queueEditor(m);
        ed.splice(ed.upcoming(c.index, c.id), 1);
        refreshNextPreload(m);
        break;
      }
      case 'move': {
        const ed = queueEditor(m);
        const from = ed.upcoming(c.from, c.id);
        const to = clamp(c.to, ed.pos + 1, ed.length() - 1);
        if (from !== to) ed.splice(to, 0, ed.splice(from, 1));
        refreshNextPreload(m);
        break;
      }
      case 'load': {
        // Playback handed over from another Orchard speaker.
        if (!c.songs || !c.songs.length) throw new Error('Nothing to play');
        m.shuffleMode = 0;
        m.repeatMode = clamp(c.repeat, 0, 2);
        let songs = c.songs.map(String);
        let index = clamp(c.index, 0, songs.length - 1);
        let position = c.position;
        // MusicKit rejects the whole queue if any id can't be resolved here (region, removed track, a video
        // sent by an older Orchard…). Drop the ids it names and try again.
        for (let attempt = 0; ; attempt++) {
          try {
            await settle(m.setQueue({ songs, startWith: index }), 15000);
            break;
          } catch (e) {
            const bad = unresolvedIds(e);
            const keep = songs.filter((id) => !bad.includes(id));
            if (!bad.length || !keep.length || attempt >= 3) throw e;
            log('handoff: skipping items Apple Music could not find:', bad.join(', '));
            if (bad.includes(songs[index])) position = 0;
            index = clamp(songs.slice(0, index).filter((id) => !bad.includes(id)).length, 0, keep.length - 1);
            songs = keep;
          }
        }
        if (m.queue && m.queue.position !== index) {
          try { await settle(m.changeToMediaAtIndex(index)); } catch (e) { /* best effort */ }
        }
        await settle(m.play());
        if (position > 1) { try { await settle(m.seekToTime(position)); } catch (e) { /* ignore */ } }
        if (!c.playing) await settle(m.pause());
        break;
      }
      case 'stop': await settle(m.stop()); break;
      case 'output': await setOutput(c.id); break;
      default: throw new Error('Unknown command: ' + c.type);
    }
    return JSON.stringify(snapshot(true));
  }

  async function api(method, path, body) {
    const m = need();
    if (typeof path !== 'string' || !path.startsWith('/v1/')) throw new Error('Bad API path');
    const headers = { Authorization: 'Bearer ' + m.developerToken, Accept: 'application/json' };
    if (m.musicUserToken) {
      headers['Media-User-Token'] = m.musicUserToken;
      headers['Music-User-Token'] = m.musicUserToken;
    }
    const init = { method: method || 'GET', headers };
    if (body != null) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch('https://amp-api.music.apple.com' + path, init);
    } catch (e) {
      res = await fetch('https://api.music.apple.com' + path, init);
    }
    return JSON.stringify({ status: res.status, body: await res.text() });
  }

  /** Ids listed in MusicKit's "One or more items could not be resolved: 1, 2" error. */
  function unresolvedIds(e) {
    const text = e ? [e.description, e.message, String(e)].filter(Boolean).join(' ') : '';
    const m = text.match(/could not be resolved:\s*([\w.,\s-]+)/i);
    return m ? m[1].split(/[\s,]+/).map((id) => id.replace(/\.+$/, '')).filter(Boolean) : [];
  }

  async function exportQueue() {
    const m = need();
    const items = (m.queue && m.queue.items) || [];
    const pos = Math.max(0, (m.queue && m.queue.position) || 0);
    const songs = [];
    let index = 0;
    let currentSkipped = false;
    items.forEach((it, i) => {
      const info = itemInfo(it);
      const id = info.catalogId || info.id;
      // The other speaker loads the queue as songs, so music videos (e.g. an album's bonus video) can't go along.
      const playable = id && !/video/i.test(info.kind || '');
      if (i === pos) {
        index = songs.length;
        currentSkipped = !playable;
      }
      if (playable) songs.push(id);
    });
    if (!songs.length) throw new Error('Nothing in the queue can be moved to another speaker (music videos only play here)');
    index = Math.min(index, songs.length - 1);
    // Keep the payload bounded: a window around the current track.
    const from = Math.max(0, index - 50);
    return JSON.stringify({
      songs: songs.slice(from, from + 500),
      index: index - from,
      position: currentSkipped ? 0 : m.currentPlaybackTime || 0,
      repeat: m.repeatMode || 0,
      playing: !!m.isPlaying,
    });
  }

  /** One page of the queue: items[start .. start+count), with the revision they belong to. */
  async function queueItems(start, count) {
    const m = need();
    const items = (m.queue && m.queue.items) || [];
    const from = clamp(start, 0, items.length);
    const n = clamp(count, 0, 500);
    return JSON.stringify({
      rev: queueRev,
      position: m.queue ? m.queue.position : -1,
      total: items.length,
      start: from,
      items: items.slice(from, from + n).map(itemInfo),
    });
  }

  window.__orchard = {
    cmd,
    api,
    exportQueue,
    queueItems,
    state: async () => JSON.stringify(snapshot(true)),
    authorize: async () => { await need().authorize(); schedule(true); return 'true'; },
    unauthorize: async () => { await need().unauthorize(); schedule(true); return 'true'; },
  };
})();
