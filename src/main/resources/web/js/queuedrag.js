// Drag-to-reorder for track lists (the queue's "Next up", and your own playlists). Rows that can be
// picked up carry the class "q-row". Pick a song up from anywhere on its row:
//  - mouse: press and move a few pixels (a plain click or double-click still works as before);
//  - touch / pen: press and hold briefly, then drag (a quick swipe still scrolls the list).
// The other rows slide out of the way, and the list scrolls when you drag near its edge.
// Dropping calls onMove(from, to) with positions inside the list.

const HOLD_MS = 280;      // touch: how long to hold before the row lifts
const SLOP_MOUSE = 5;     // mouse: movement that turns a press into a drag
const SLOP_TOUCH = 8;     // touch: movement before the hold completes means "scroll", not "drag"

let active = false;
/** While true, views should hold off re-rendering (it would yank the row from under the pointer). */
export const isRowDragging = () => active;

export function enableRowDrag(list, { onMove, onEnd }) {
  list.addEventListener('dragstart', (e) => e.preventDefault()); // no native image/link dragging
  list.addEventListener('pointerdown', (e) => {
    if (active || e.button !== 0) return;
    const row = e.target.closest('.q-row');
    if (!row || row.parentElement !== list) return;
    track(e, list, row, onMove, onEnd);
  });
}

function scrollParent(el) {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p;
  }
  return document.scrollingElement;
}

function track(e, list, row, onMove, onEnd) {
  const touch = e.pointerType !== 'mouse';
  const rows = [...list.children].filter((r) => r.classList.contains('q-row'));
  const from = rows.indexOf(row);
  const scroller = scrollParent(list);
  const startX = e.clientX;
  const startY = e.clientY;
  const pointerId = e.pointerId;
  let startScroll = scroller.scrollTop;
  let lastY = e.clientY;
  let began = false;
  let to = from;
  let raf = 0;
  let hold = 0;
  let tops = [];
  let heights = [];
  let h = 0;

  const begin = () => {
    began = true;
    active = true;
    startScroll = scroller.scrollTop;
    tops = rows.map((r) => r.getBoundingClientRect().top);
    heights = rows.map((r) => r.getBoundingClientRect().height);
    h = heights[from];
    try { row.setPointerCapture(pointerId); } catch (err) { /* pointer already gone */ }
    row.classList.add('q-dragging');
    list.classList.add('q-sorting');
    document.body.classList.add('q-drag-cursor');
    if (touch && navigator.vibrate) { try { navigator.vibrate(8); } catch (err) { /* not allowed */ } }
    raf = requestAnimationFrame(autoScroll);
  };

  const layout = () => {
    const dy = lastY - startY + (scroller.scrollTop - startScroll);
    row.style.transform = `translateY(${dy}px)`;
    const centre = tops[from] + h / 2 + dy;
    let t = from;
    for (let i = from + 1; i < rows.length; i++) if (centre > tops[i] + heights[i] / 2) t = i;
    for (let i = from - 1; i >= 0; i--) if (centre < tops[i] + heights[i] / 2) t = i;
    to = t;
    rows.forEach((r, i) => {
      if (r === row) return;
      const shift = from < to && i > from && i <= to ? -h : from > to && i >= to && i < from ? h : 0;
      r.style.transform = shift ? `translateY(${shift}px)` : '';
    });
  };

  // Scroll the list while the pointer is held near its top or bottom edge.
  function autoScroll() {
    const r = scroller.getBoundingClientRect();
    const zone = 56;
    let v = 0;
    if (lastY < r.top + zone) v = -Math.ceil((r.top + zone - lastY) / 5);
    else if (lastY > r.bottom - zone) v = Math.ceil((lastY - (r.bottom - zone)) / 5);
    if (v) {
      const before = scroller.scrollTop;
      scroller.scrollTop += v;
      if (scroller.scrollTop !== before) layout();
    }
    raf = requestAnimationFrame(autoScroll);
  }

  const move = (ev) => {
    if (ev.pointerId !== pointerId) return;
    lastY = ev.clientY;
    if (!began) {
      const dist = Math.hypot(ev.clientX - startX, ev.clientY - startY);
      if (touch) {
        if (dist > SLOP_TOUCH) stop(); // it's a scroll/swipe: let the browser have it
        return;
      }
      if (dist < SLOP_MOUSE) return;
      begin();
    }
    ev.preventDefault();
    layout();
  };

  // Once a touch drag has begun, keep the page from scrolling under the finger.
  const blockScroll = (te) => { if (began && te.cancelable) te.preventDefault(); };
  // A long press would otherwise also open the song menu.
  const blockMenu = (ce) => { if (began) { ce.preventDefault(); ce.stopPropagation(); } };

  const finish = () => {
    rows.forEach((r) => { r.style.transition = 'none'; r.style.transform = ''; });
    row.classList.remove('q-dragging');
    list.classList.remove('q-sorting');
    document.body.classList.remove('q-drag-cursor');
    void list.offsetHeight; // apply the reset before transitions come back
    rows.forEach((r) => { r.style.transition = ''; });
    active = false;
    if (to !== from) onMove(from, to);
    if (onEnd) onEnd();
  };

  function stop() {
    clearTimeout(hold);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    window.removeEventListener('touchmove', blockScroll);
    if (!began) window.removeEventListener('contextmenu', blockMenu, true);
  }

  function up(ev) {
    if (ev.pointerId !== pointerId) return;
    stop();
    if (!began) return;
    cancelAnimationFrame(raf);
    // The click that follows a drag must not play or open anything.
    const swallow = (ce) => { ce.stopPropagation(); ce.preventDefault(); };
    window.addEventListener('click', swallow, true);
    setTimeout(() => window.removeEventListener('click', swallow, true), 0);
    // Android fires the long-press menu late; keep blocking it for a moment.
    setTimeout(() => window.removeEventListener('contextmenu', blockMenu, true), 400);
    if (ev.type === 'pointercancel') to = from;
    // Glide the row into its new slot (offsets are within the list, so scrolling doesn't change them),
    // then hand over to the re-render.
    const slot = to > from ? tops[to] + heights[to] - (tops[from] + h) : tops[to] - tops[from];
    row.style.transition = 'transform .14s ease';
    row.style.transform = `translateY(${slot}px)`;
    setTimeout(finish, 140);
  }

  window.addEventListener('pointermove', move, { passive: false });
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
  window.addEventListener('contextmenu', blockMenu, true);
  if (touch) {
    window.addEventListener('touchmove', blockScroll, { passive: false });
    hold = setTimeout(begin, HOLD_MS);
  }
}
