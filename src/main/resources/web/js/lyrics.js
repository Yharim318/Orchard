// Time-synced lyrics from Apple Music TTML, shown in the sidebar, as a page, or in the full-screen player.
import { esc, icon } from './util.js';
import { S, am, sf, displayPosition, cmd, subscribe } from './store.js';

const cache = new Map();
/** A break between sung lines at least this long (seconds) shows the animated "…" dots. */
const INTERLUDE = 4;
/** After the user scrolls the lyrics, stop following the song (and un-blur) for this long (ms). */
const HANDS_OFF = 3000;
/** Stiffness of the scroll spring (rad/s): higher settles faster. Critically damped, so it never overshoots. */
const SPRING = 7.5;

function parseTime(v) {
  if (!v) return null;
  if (/^[\d.]+s$/.test(v)) return parseFloat(v);
  const parts = v.split(':').map(Number);
  if (parts.some(isNaN)) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function parseTTML(ttml) {
  const doc = new DOMParser().parseFromString(ttml, 'application/xml');
  const raw = [];
  for (const div of doc.getElementsByTagName('div')) {
    if (raw.length) raw.push({ gap: true }); // a new verse/chorus
    for (const p of div.getElementsByTagName('p')) {
      // Word-timed lyrics put each word in a span; keep primary vocals, skip background-vocal spans.
      const text = [...p.childNodes]
        .map((n) => (n.nodeType === 1 && /x-bg/.test(n.getAttribute('ttm:role') || '') ? '' : n.textContent))
        .join('').replace(/\s+/g, ' ').trim();
      raw.push({ t: parseTime(p.getAttribute('begin')), end: parseTime(p.getAttribute('end')), text });
    }
  }
  const synced = raw.some((l) => l.t != null);
  // Long instrumental breaks (and a long intro) get an "interlude" entry that lights up while nobody sings.
  const lines = [];
  let prevEnd = 0;
  for (const l of raw) {
    if (synced && !l.gap && l.t != null) {
      if (l.t - prevEnd >= INTERLUDE) lines.push({ t: prevEnd, end: l.t, interlude: true });
      prevEnd = l.end != null ? l.end : l.t;
    }
    lines.push(l);
  }
  const writers = [...doc.getElementsByTagName('songwriter')].map((n) => n.textContent.trim()).filter(Boolean);
  return { lines, synced, writers };
}

async function load(id) {
  if (cache.has(id)) return cache.get(id);
  const p = (async () => {
    let r;
    try {
      r = await am(`/v1/catalog/${sf()}/songs/${encodeURIComponent(id)}/lyrics`);
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
    const ttml = r && r.data && r.data[0] && r.data[0].attributes && r.data[0].attributes.ttml;
    return ttml ? parseTTML(ttml) : null;
  })();
  cache.set(id, p);
  p.catch(() => cache.delete(id));
  return p;
}

const joinNames = (a) => (a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} & ${a[a.length - 1]}`);

function lineHtml(l, i, synced) {
  if (l.gap) return '<div class="lyric-gap"></div>';
  if (l.interlude) {
    // The three dots fill one after another over the length of the break.
    return `<div class="lyric interlude" data-i="${i}" data-t="${l.t}" style="--step:${((l.end - l.t) / 3).toFixed(2)}s"
      aria-hidden="true"><span></span><span></span><span></span></div>`;
  }
  return `<div class="lyric${synced ? '' : ' static'}" data-i="${i}"${l.t != null ? ` data-t="${l.t}"` : ''}>${esc(l.text) || '♪'}</div>`;
}

/**
 * The lyrics sidebar's header buttons: widen the lyrics over the page (collapses the middle column; the same
 * button brings the page back), open the full-screen player, close.
 */
export function lyricsViewButtons() {
  const btn = (c, ic, title, cls = '') => `<button class="icon-btn${cls}" data-c="${c}" title="${title}">${icon(ic)}</button>`;
  return `<div class="lyr-views">
    ${btn('lyrics-widen', 'widen', 'Expand lyrics over the page', ' lyr-widen')}
    ${btn('lyrics-widen', 'narrow', 'Show the page again', ' lyr-narrow')}
    ${btn('lyrics-full', 'fullscreen', 'Full-screen player')}
    ${btn('lyrics-close', 'close', 'Close lyrics')}</div>`;
}

/**
 * Renders lyrics for whatever is playing into `el`, following along in time. Returns a cleanup function.
 * `variant` ('side', 'full') picks the text size; `compact` is the phone size.
 */
export function mountLyrics(el, { compact = false, variant = 'full' } = {}) {
  let currentId = null, data = null, raf = 0, activeIdx = -1, userScrolledAt = 0, jump = true;
  let activeNode = null, lastFrame = 0, scrollPos = 0, velocity = 0;
  el.classList.add('lyrics', `lyr-v-${variant}`);
  if (compact) el.classList.add('compact');

  const onScroll = () => { userScrolledAt = Date.now(); };
  el.addEventListener('wheel', onScroll, { passive: true });
  el.addEventListener('touchmove', onScroll, { passive: true });
  el.addEventListener('click', (e) => {
    const line = e.target.closest('[data-t]');
    if (!line || !data || !data.synced) return;
    userScrolledAt = 0; // follow the song again from the clicked line
    cmd({ type: 'seek', position: parseFloat(line.dataset.t) }).catch(() => {});
  });

  const message = (html) => { el.innerHTML = `<div class="lyrics-msg">${html}</div>`; };

  async function refresh() {
    const item = S.state.item;
    const id = item && (item.catalogId || item.id);
    if (id === currentId) return;
    currentId = id;
    data = null;
    activeIdx = -1;
    activeNode = null;
    jump = true;
    el.scrollTop = 0;
    if (!id) { message('Play something to see lyrics.'); return; }
    message('<span class="lyrics-loading"><i></i><i></i><i></i></span>');
    try {
      const d = await load(id);
      if (id !== currentId) return;
      data = d;
      if (!d || !d.lines.length) { message(`No lyrics for “${esc(item.title)}”.`); return; }
      el.innerHTML = d.lines.map((l, i) => lineHtml(l, i, d.synced)).join('')
        + (d.synced ? '' : '<div class="lyrics-note">These lyrics aren’t time-synced.</div>')
        + (d.writers.length ? `<div class="lyrics-credits">Written by ${esc(joinNames(d.writers))}</div>` : '');
    } catch (e) {
      if (id === currentId) message(`Couldn’t load lyrics: ${esc(e.message)}`);
    }
  }

  /**
   * Glide the current line to about a third of the way down. A critically damped spring eases in and out and
   * re-aims every frame, so it stays smooth when lines change height (an interlude opening or closing).
   * The position is tracked as a float because scrollTop may be rounded to whole pixels.
   */
  function follow(dt) {
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    const node = activeNode && activeNode.isConnected ? activeNode : null;
    const target = Math.min(max, Math.max(0, node ? node.offsetTop - el.clientHeight * 0.32 : 0));
    if (jump) {
      el.scrollTop = scrollPos = target;
      velocity = 0;
      jump = false;
      return;
    }
    if (Math.abs(el.scrollTop - scrollPos) > 2) { scrollPos = el.scrollTop; velocity = 0; } // moved by someone else
    const t = dt / 1000;
    velocity += (-SPRING * SPRING * (scrollPos - target) - 2 * SPRING * velocity) * t;
    scrollPos += velocity * t;
    if (Math.abs(scrollPos - target) < 0.5 && Math.abs(velocity) < 4) { scrollPos = target; velocity = 0; }
    el.scrollTop = scrollPos;
  }

  function tick(now = performance.now()) {
    raf = requestAnimationFrame(tick);
    const dt = lastFrame ? Math.min(50, now - lastFrame) : 16;
    lastFrame = now;
    const following = Date.now() - userScrolledAt > HANDS_OFF;
    el.classList.toggle('following', following && !!data && data.synced);
    if (!data || !data.synced) return;
    const pos = displayPosition() + 0.25;
    let idx = -1;
    for (let i = 0; i < data.lines.length; i++) {
      const l = data.lines[i];
      if (l.t == null) continue;
      if (l.t <= pos) idx = i;
      else break;
    }
    if (idx !== activeIdx) {
      activeIdx = idx;
      el.querySelectorAll('.lyric.active, .lyric.past').forEach((n) => n.classList.remove('active', 'past'));
      el.querySelectorAll('.lyric').forEach((n) => { if (+n.dataset.i < idx) n.classList.add('past'); });
      activeNode = el.querySelector(`.lyric[data-i="${idx}"]`);
      if (activeNode) activeNode.classList.add('active');
    }
    if (following) follow(dt);
    else velocity = 0;
  }

  const unsub = subscribe((kind) => { if (kind === 'state') refresh(); });
  refresh();
  tick();
  return () => { unsub(); cancelAnimationFrame(raf); };
}
