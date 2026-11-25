// Library playlist management: create / edit details (name, description, picture), delete, remove songs.
// Apple's web API (what music.apple.com itself uses) supports editing names and descriptions (PATCH),
// deleting (DELETE) and removing songs, but not uploading artwork — pictures chosen here are kept by
// Orchard (see artwork.js) and shown on every device that uses this Orchard.
import { esc, art, icon, toast } from './util.js';
import { ROOT, am, amWrite } from './store.js';
import { libraryList, invalidateLibrary, createPlaylist, playlistChanged, rememberPlaylistEdit, rememberPlaylistDelete, withRecentEdits } from './components.js';
import { playlistArtwork, mosaicFor, hasCustomArtwork, setCustomArtwork, refreshMosaic, dropMosaic } from './artwork.js';

const enc = encodeURIComponent;
const description = (a) => (a && a.description && (a.description.standard || a.description.short)) || '';

/** Re-renders the current page (keeping the scroll position) after something on it changed. */
export const refreshView = () => document.dispatchEvent(new CustomEvent('view-refresh'));

/** A library playlist by id, from the library list (or the API when it isn't cached). */
export async function findLibraryPlaylist(id) {
  const list = await libraryList('playlists').catch(() => []);
  const hit = list.find((p) => p.id === id);
  if (hit) return hit;
  const r = await am(`/v1/me/library/playlists/${enc(id)}`);
  return withRecentEdits(r.data && r.data[0]);
}

// ------------------------------------------------------------------ API

export async function updatePlaylistDetails(p, { name, description: desc }) {
  const attributes = { name, description: desc };
  if (p.attributes && typeof p.attributes.isPublic === 'boolean') attributes.isPublic = p.attributes.isPublic;
  await amWrite('PATCH', `/v1/me/library/playlists/${enc(p.id)}`, { attributes });
  rememberPlaylistEdit(p.id, { name, description: desc ? { standard: desc } : undefined });
}

async function artworkRequest(body) {
  const res = await fetch(`${ROOT}/api/artwork`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/** Saves a picture (data URL) as the playlist's artwork in Orchard. Sent in small parts (see ArtworkStore). */
export async function uploadArtwork(id, dataUrl) {
  const CHUNK = 24000;
  const parts = Math.ceil(dataUrl.length / CHUNK);
  const upload = Math.random().toString(36).slice(2) + Date.now().toString(36);
  let r = null;
  for (let part = 0; part < parts; part++) {
    r = await artworkRequest({ op: 'put', id, upload, part, parts, data: dataUrl.slice(part * CHUNK, (part + 1) * CHUNK) });
  }
  setCustomArtwork(id, r && r.version != null ? r.version : Date.now(), dataUrl);
}

export async function removeArtwork(id) {
  await artworkRequest({ op: 'delete', id });
  setCustomArtwork(id, null);
}

export async function deletePlaylist(p) {
  const name = (p.attributes && p.attributes.name) || 'this playlist';
  const mine = !!(p.attributes && p.attributes.canEdit);
  const ok = await confirmDialog({
    title: mine ? 'Delete playlist?' : 'Remove from library?',
    body: mine
      ? `<b>${esc(name)}</b> will be deleted from your library on all your devices. This can't be undone.`
      : `<b>${esc(name)}</b> will be removed from your library. You can add it again from Apple Music.`,
    ok: mine ? 'Delete' : 'Remove',
    danger: true,
  });
  if (!ok) return false;
  try {
    await amWrite('DELETE', `/v1/me/library/playlists/${enc(p.id)}`);
  } catch (e) {
    toast(`Couldn't delete: ${e.message}`);
    return false;
  }
  if (hasCustomArtwork(p.id)) removeArtwork(p.id).catch(() => {});
  dropMosaic(p.id);
  rememberPlaylistDelete(p.id);
  invalidateLibrary('playlists');
  playlistChanged({ id: p.id, deleted: true });
  toast(mine ? `Deleted ${name}` : `Removed ${name}`);
  if (location.hash === `#/playlist/${p.id}`) location.hash = '#/library/playlists';
  return true;
}

/** Removes a song (every copy of it) from a library playlist. */
export async function removeFromPlaylist(pl, t) {
  try {
    await amWrite('DELETE', `/v1/me/library/playlists/${enc(pl.id)}/tracks?ids[library-songs]=${enc(t.id)}&mode=all`);
  } catch (e) {
    toast(`Couldn't remove: ${e.message}`);
    return;
  }
  toast(`Removed from ${pl.name || 'playlist'}`);
  refreshMosaic(pl.id);
  playlistChanged({ id: pl.id, removed: [t.id] });
}

/**
 * Every entry of a library playlist as { id, type }, in order. Only ids, so even long playlists are
 * quick. Throws rather than return a partial list: the list is sent back whole when reordering, and
 * a short one would drop songs.
 */
async function playlistEntries(id) {
  const out = [];
  let next = `/v1/me/library/playlists/${enc(id)}/tracks?limit=100&omit[resource]=autos`;
  let lastOffset = 0;
  while (next) {
    let r;
    try { r = await am(next); } catch (e) { if (e.status === 404 && !out.length) return out; throw e; } // empty playlist: 404
    for (const d of r.data || []) out.push({ id: d.id, type: d.type });
    if (!r.next) break;
    const offset = Number(new URLSearchParams(r.next.split('?')[1] || '').get('offset'));
    if (!(offset > lastOffset)) throw new Error("Couldn't read the whole playlist");
    lastOffset = offset;
    next = r.next + (/[?&]limit=/.test(r.next) ? '' : '&limit=100') + (/[?&]omit/.test(r.next) ? '' : '&omit[resource]=autos');
  }
  return out;
}

/**
 * Moves one song in a library playlist from position `from` to `to`, the way music.apple.com does it:
 * read the playlist's entries, check the song is still where we think, and send the new order.
 * `entries` is the order this page last sent; pass it to skip the read, because Apple's library can
 * take a moment to show the previous change. Resolves to the new order.
 */
export async function moveInPlaylist(pl, from, to, track, entries = null) {
  const items = entries ? entries.slice() : await playlistEntries(pl.id);
  if (!items[from] || items[from].id !== track.id || to < 0 || to >= items.length) {
    throw new Error('the playlist changed elsewhere');
  }
  items.splice(to, 0, ...items.splice(from, 1));
  await amWrite('PUT', `/v1/me/library/playlists/${enc(pl.id)}/tracks`, { data: items });
  return items;
}

/** Extra menu items for a library playlist: edit / delete (own playlists) or remove (added ones). */
export function playlistMenuItems(p) {
  if (!p || !/^p\./.test(p.id || '')) return [];
  const mine = !!(p.attributes && p.attributes.canEdit);
  const items = [{ sep: true }];
  if (mine) items.push({ label: 'Edit details', icon: 'edit', run: () => openPlaylistEditor({ playlist: p }) });
  items.push({ label: mine ? 'Delete playlist' : 'Remove from library', icon: 'trash', danger: true, run: () => deletePlaylist(p) });
  return items;
}

// ------------------------------------------------------------------ dialogs

export function openDialog(html, { onClose } = {}) {
  const back = document.createElement('div');
  back.className = 'dlg-back';
  back.innerHTML = `<div class="dlg" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(back);
  void back.offsetWidth; // start from the closed style so the fade-in runs
  back.classList.add('open');
  const prevFocus = document.activeElement;
  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    back.remove();
    if (prevFocus && prevFocus.focus) prevFocus.focus();
    if (onClose) onClose();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  };
  document.addEventListener('keydown', onKey, true);
  back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
  back.querySelectorAll('[data-x]').forEach((b) => b.addEventListener('click', close));
  return { el: back.firstElementChild, close };
}

export function confirmDialog({ title, body, ok = 'OK', danger = false }) {
  return new Promise((resolve) => {
    let answer = false;
    const d = openDialog(`
      <h2 class="dlg-title">${esc(title)}</h2>
      <p class="dlg-text">${body}</p>
      <footer class="dlg-foot"><button class="btn ghost" data-x>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(ok)}</button></footer>`,
    { onClose: () => resolve(answer) });
    const okBtn = d.el.querySelector('[data-ok]');
    okBtn.addEventListener('click', () => { answer = true; d.close(); });
    okBtn.focus();
  });
}

/** Square-crops and shrinks a picture file to a JPEG data URL. */
async function pictureFromFile(file, size = 600) {
  let src;
  try {
    src = await createImageBitmap(file);
  } catch (e) {
    throw new Error("That file isn't a picture that can be used");
  }
  const s = Math.min(src.width, src.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = Math.min(size, s);
  canvas.getContext('2d').drawImage(src, (src.width - s) / 2, (src.height - s) / 2, s, s, 0, 0, canvas.width, canvas.height);
  if (src.close) src.close();
  return canvas.toDataURL('image/jpeg', 0.86);
}

/**
 * Create (no `playlist`) or edit a library playlist: name, description and picture.
 * `tracks` are added to a new playlist. Resolves to the playlist, or null when cancelled.
 */
export function openPlaylistEditor({ playlist = null, tracks = [] } = {}) {
  const creating = !playlist;
  const a = (playlist && playlist.attributes) || {};
  const startArt = playlist ? playlistArtwork(playlist) : null;
  const startMosaic = playlist ? mosaicFor(playlist) : null;
  let picture = null;      // new data URL chosen in this dialog
  let removePic = false;   // remove the custom picture
  return new Promise((resolve) => {
    let result = null;
    const d = openDialog(`
      <header class="dlg-head"><h2 class="dlg-title">${creating ? 'New playlist' : 'Edit details'}</h2>
        <button class="icon-btn" data-x title="Close">${icon('close')}</button></header>
      <div class="pe">
        <div class="pe-art-wrap">
          <button class="pe-art" type="button" title="Choose a picture">
            <img src="${art(startArt, 400)}"${startMosaic ? ` data-mosaic="${esc(startMosaic)}"` : ''} alt="">
            <span class="pe-art-over">${icon('edit')}<span>Choose picture</span></span>
          </button>
          <button class="pe-art-remove" type="button" hidden>Remove picture</button>
        </div>
        <div class="pe-fields">
          <label class="pe-label">Name<input class="pe-name" maxlength="100" placeholder="My playlist" value="${esc(a.name || '')}"></label>
          <label class="pe-label">Description<textarea class="pe-desc" maxlength="300" rows="4" placeholder="Add an optional description">${esc(description(a))}</textarea></label>
        </div>
      </div>
      <p class="pe-error" hidden></p>
      <p class="pe-note">Pictures are saved on the speaker and show on every device connected to it. Apple's own Music apps keep their own artwork.</p>
      <footer class="dlg-foot"><button class="btn ghost" data-x>Cancel</button><button class="btn primary" data-save>${creating ? 'Create' : 'Save'}</button></footer>
      <input class="pe-file" type="file" accept="image/jpeg,image/png,image/webp,image/*" hidden>`,
    { onClose: () => resolve(result) });
    const el = d.el;
    el.classList.add('dlg-wide');
    const img = el.querySelector('.pe-art img');
    const file = el.querySelector('.pe-file');
    const removeBtn = el.querySelector('.pe-art-remove');
    const nameIn = el.querySelector('.pe-name');
    const descIn = el.querySelector('.pe-desc');
    const err = el.querySelector('.pe-error');
    const save = el.querySelector('[data-save]');
    const showRemove = () => { removeBtn.hidden = !(picture || (!removePic && playlist && hasCustomArtwork(playlist.id))); };
    showRemove();

    let processing = null; // a chosen picture still being cropped/resized (Save waits for it)
    el.querySelector('.pe-art').addEventListener('click', () => file.click());
    file.addEventListener('change', () => {
      const f = file.files && file.files[0];
      file.value = '';
      if (!f) return;
      processing = pictureFromFile(f).then((url) => {
        picture = url;
        removePic = false;
        img.removeAttribute('data-mosaic');
        img.src = picture;
        err.hidden = true;
      }, (e) => {
        err.textContent = e.message;
        err.hidden = false;
      }).finally(() => { processing = null; showRemove(); });
    });
    removeBtn.addEventListener('click', () => {
      picture = null;
      removePic = true;
      const a2 = playlist && playlist.attributes && playlist.attributes.artwork;
      img.src = art(a2 && a2.url ? a2 : null, 400);
      if (playlist && !(a2 && a2.url)) img.dataset.mosaic = playlist.id; // fall back to the mosaic
      showRemove();
    });

    const submit = async () => {
      const name = nameIn.value.trim();
      const desc = descIn.value.trim();
      if (!name) { err.textContent = 'Give the playlist a name.'; err.hidden = false; nameIn.focus(); return; }
      save.disabled = true;
      save.textContent = creating ? 'Creating…' : 'Saving…';
      err.hidden = true;
      if (processing) await processing;
      try {
        let p = playlist;
        let detailsChanged = false;
        if (creating) {
          p = await createPlaylist(name, tracks, { description: desc });
          if (!p) throw new Error('Apple Music did not return the new playlist');
        } else if (name !== (a.name || '') || desc !== description(a)) {
          await updatePlaylistDetails(playlist, { name, description: desc });
          detailsChanged = true;
        }
        const pictureChanged = !!picture || (removePic && hasCustomArtwork(p.id));
        let picErr = null;
        try {
          if (picture) await uploadArtwork(p.id, picture);
          else if (removePic && hasCustomArtwork(p.id)) await removeArtwork(p.id);
        } catch (e) { picErr = e; }
        invalidateLibrary('playlists');
        result = p;
        d.close();
        if (picErr) toast(`Saved, but the picture couldn't be stored: ${picErr.message}`);
        else toast(creating ? `Created ${name}` : 'Saved');
        if (creating) location.hash = `#/playlist/${p.id}`;
        else if (detailsChanged || pictureChanged) {
          playlistChanged({ id: p.id, details: detailsChanged ? { name, description: desc } : null, artwork: pictureChanged && !picErr });
        }
      } catch (e) {
        err.textContent = `Couldn't ${creating ? 'create' : 'save'} the playlist: ${e.message}`;
        err.hidden = false;
        save.disabled = false;
        save.textContent = creating ? 'Create' : 'Save';
      }
    };
    save.addEventListener('click', submit);
    nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    nameIn.focus();
    nameIn.select();
  });
}
