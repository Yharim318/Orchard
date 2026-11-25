// Orchard's own scrollbars: a hairline that thickens when you reach for it, the same in both directions.
//  - Horizontal: under each shelf row (js/shelves.js adds the paging arrows and card snapping).
//  - Vertical: an overlay on the right edge of the page, side panels, menus and dialogs (desktop only;
//    touch screens keep the system's own auto-hiding bars).
// The whole bar is the handle: press on the thumb to drag it (held where you grabbed it); press beside it
// and move to grab it by the middle; a plain click beside it glides there.

const AXES = {
  x: { pos: 'scrollLeft', client: 'clientWidth', scroll: 'scrollWidth', size: 'width', start: 'left', end: 'right', coord: 'clientX', move: 'translateX', delta: 'left' },
  y: { pos: 'scrollTop', client: 'clientHeight', scroll: 'scrollHeight', size: 'height', start: 'top', end: 'bottom', coord: 'clientY', move: 'translateY', delta: 'top' },
};
const MIN_THUMB = 40;

export function makeBar(axis, extraClass = '') {
  const bar = document.createElement('div');
  bar.className = `sbar sbar-${axis}${extraClass ? ` ${extraClass}` : ''}`;
  bar.innerHTML = '<i></i>';
  return bar;
}

/**
 * Drives `bar` (from makeBar) for `scroller` along `axis`. Returns { update } — call it when the
 * scroll position or sizes change. Optional hooks:
 *   enabled()          false hides the bar (e.g. the scroller isn't scrollable right now)
 *   onPress()          a press on the bar started
 *   onDragStart()      a drag started
 *   onDragEnd()        a drag ended (shelves glide to a card edge here)
 *   onGlide(target)    a click beside the thumb is gliding to `target`
 */
export function attachBar(scroller, bar, axis, hooks = {}) {
  const A = AXES[axis];
  const thumb = bar.firstElementChild;
  const maxScroll = () => Math.max(0, scroller[A.scroll] - scroller[A.client]);

  function update() {
    const max = maxScroll();
    const on = max > 1 && (!hooks.enabled || hooks.enabled());
    bar.classList.toggle('off', !on);
    if (!on) return;
    const track = bar[A.client];
    const len = Math.max(MIN_THUMB, (track * scroller[A.client]) / scroller[A.scroll]);
    const at = (track - len) * Math.min(1, Math.max(0, scroller[A.pos] / max));
    thumb.style[A.size] = `${len}px`;
    thumb.style.transform = `${A.move}(${at}px)`;
  }

  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try { bar.setPointerCapture(e.pointerId); } catch (err) { /* not a live pointer */ }
    if (hooks.onPress) hooks.onPress();
    const rect = bar.getBoundingClientRect();
    const t = thumb.getBoundingClientRect();
    const range = Math.max(1, rect[A.size] - t[A.size]);
    const max = maxScroll();
    const p0 = e[A.coord];
    const onThumb = p0 >= t[A.start] - 4 && p0 <= t[A.end] + 4;
    const grab = onThumb ? Math.min(t[A.size], Math.max(0, p0 - t[A.start])) : t[A.size] / 2;
    const scrollFor = (p) => Math.min(1, Math.max(0, (p - rect[A.start] - grab) / range)) * max;
    let dragging = false;
    const begin = () => {
      dragging = true;
      bar.classList.add('active');
      document.body.classList.add('sbar-dragging');
      if (hooks.onDragStart) hooks.onDragStart();
    };
    if (onThumb) begin();
    const move = (ev) => {
      if (!dragging) {
        if (Math.abs(ev[A.coord] - p0) < 4) return;
        begin();
      }
      scroller[A.pos] = scrollFor(ev[A.coord]);
    };
    const end = (ev) => {
      bar.removeEventListener('pointermove', move);
      bar.removeEventListener('pointerup', end);
      bar.removeEventListener('pointercancel', end);
      if (dragging) {
        bar.classList.remove('active');
        document.body.classList.remove('sbar-dragging');
        if (hooks.onDragEnd) hooks.onDragEnd();
      } else if (ev.type === 'pointerup') {
        const target = scrollFor(ev[A.coord]);
        if (hooks.onGlide) hooks.onGlide(target);
        scroller.scrollTo({ [A.delta]: target, behavior: 'smooth' });
      }
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);
  });

  // The bar sits over the scroller's edge; wheel/trackpad gestures on it should still scroll.
  bar.addEventListener('wheel', (e) => {
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? scroller[A.client] : 1;
    scroller.scrollBy({ left: e.deltaX * k, top: e.deltaY * k });
    e.preventDefault();
  }, { passive: false });

  return { update };
}

// ------------------------------------------------------------------ vertical overlays

const VERTICAL = '#main, #right, .library .lib-list, #menu, #popover, .dlg';
const INSET = 4; // keep the bar clear of rounded corners
const live = new Set();

export function initVerticalBars() {
  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  const scan = (n) => {
    if (n.matches && n.matches(VERTICAL)) vertical(n);
    if (n.querySelectorAll) n.querySelectorAll(VERTICAL).forEach(vertical);
  };
  scan(document.body);
  new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) scan(n);
  }).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('resize', () => {
    for (const c of live) {
      if (c.scroller.isConnected) c.soon();
      else live.delete(c);
    }
  });
}

function vertical(scroller) {
  if (scroller._sbar || !scroller.parentElement) return;
  const parent = scroller.parentElement;
  if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
  scroller.classList.add('sbar-host');
  const bar = makeBar('y');
  scroller.after(bar);
  let scrollable = true;
  const inner = attachBar(scroller, bar, 'y', { enabled: () => scrollable });
  // .sbar-on lets tightly padded scrollers (menus) make room for the bar while it shows.
  const ctl = { update: () => { inner.update(); scroller.classList.toggle('sbar-on', !bar.classList.contains('off')); } };
  let timer = 0;
  const refresh = () => {
    timer = 0;
    const ov = getComputedStyle(scroller).overflowY;
    scrollable = ov === 'auto' || ov === 'scroll';
    place(scroller, bar);
    ctl.update();
  };
  const soon = () => { if (!timer) timer = setTimeout(refresh, 30); };
  const c = { scroller, soon };
  scroller._sbar = c;
  live.add(c);
  scroller.addEventListener('scroll', ctl.update, { passive: true });
  scroller.addEventListener('load', soon, true);          // images change the content height
  scroller.addEventListener('transitionend', soon);        // dialogs slide in
  new ResizeObserver(soon).observe(scroller);
  new MutationObserver(soon).observe(scroller, { childList: true, subtree: true });
  new MutationObserver(soon).observe(scroller, { attributes: true, attributeFilter: ['style', 'hidden', 'class'] });
  refresh();
}

/** Lays the bar over the scroller's right edge, in its parent's coordinates. */
function place(scroller, bar) {
  const p = scroller.parentElement;
  const pr = p.getBoundingClientRect();
  const r = scroller.getBoundingClientRect();
  const top = r.top - pr.top - p.clientTop + p.scrollTop + INSET;
  const left = r.right - pr.left - p.clientLeft + p.scrollLeft - bar.offsetWidth;
  bar.style.top = `${top}px`;
  bar.style.left = `${left}px`;
  bar.style.height = `${Math.max(0, r.height - INSET * 2)}px`;
  const z = getComputedStyle(scroller).zIndex;
  bar.style.zIndex = z === 'auto' ? '3' : String(Number(z) + 1);
}
