// Horizontal shelf rows (.shelf-row): Orchard's thin scrollbar under the row (js/scrollbars.js) plus header
// arrows that page by half of the cards that are fully on screen — 8 visible cards scroll 4 over.
// Rows are picked up automatically whenever a view renders one.
import { icon } from './util.js';
import { makeBar, attachBar } from './scrollbars.js';

const resize = new ResizeObserver((entries) => entries.forEach((e) => update(e.target)));

export function initShelves(root = document.getElementById('main') || document.body) {
  scan(root);
  new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) scan(n);
  }).observe(root, { childList: true, subtree: true });
}

function scan(node) {
  if (node.matches('.shelf-row')) setup(node);
  node.querySelectorAll('.shelf-row').forEach(setup);
}

function setup(row) {
  if (row._shelf) return;
  const bar = makeBar('x', 'shelf-bar');
  row.after(bar);

  let nav = null;
  const head = row.closest('.shelf') && row.closest('.shelf').querySelector(':scope > header');
  if (head) {
    nav = document.createElement('div');
    nav.className = 'shelf-nav';
    nav.innerHTML = `<button class="shelf-arrow" data-dir="-1" aria-label="Scroll left">${icon('back')}</button>`
      + `<button class="shelf-arrow" data-dir="1" aria-label="Scroll right">${icon('forward')}</button>`;
    head.appendChild(nav);
    nav.addEventListener('click', (e) => {
      const b = e.target.closest('.shelf-arrow');
      if (b) page(row, Number(b.dataset.dir));
    });
  }

  const s = row._shelf = { bar, nav, target: null, settling: null };
  s.ctl = attachBar(row, bar, 'x', {
    onPress: () => { s.target = null; },
    onDragStart: () => {
      if (s.settling) s.settling();
      row.classList.add('dragging');
    },
    onDragEnd: () => settle(row, s),
    onGlide: (target) => { s.target = target; },
  });
  // Browsers already deliver scroll events at most once per frame, so update straight away.
  row.addEventListener('scroll', () => {
    if (s.target != null && Math.abs(row.scrollLeft - s.target) < 2) s.target = null;
    update(row);
  }, { passive: true });
  row.addEventListener('scrollend', () => { s.target = null; });
  // A wheel or touch gesture takes over from any arrow-started glide.
  row.addEventListener('wheel', () => { s.target = null; }, { passive: true });
  row.addEventListener('touchstart', () => { s.target = null; }, { passive: true });

  resize.observe(row);
  update(row);
}

const maxScroll = (row) => Math.max(0, row.scrollWidth - row.clientWidth);

function update(row) {
  const s = row._shelf;
  if (!s) return;
  s.ctl.update();
  if (s.nav) {
    const max = maxScroll(row);
    s.nav.hidden = max <= 1;
    const [l, r] = s.nav.children;
    l.disabled = row.scrollLeft <= 1;
    r.disabled = row.scrollLeft >= max - 1;
  }
}

/** Scrolls by half of the fully visible cards, landing on a card boundary. */
function page(row, dir) {
  const s = row._shelf;
  const cards = row.children;
  if (!cards.length) return;
  const r0 = cards[0].getBoundingClientRect();
  const pitch = cards.length > 1 ? cards[1].getBoundingClientRect().left - r0.left : r0.width;
  if (pitch <= 0) return;
  const gap = pitch - r0.width;
  const visible = Math.max(1, Math.floor((row.clientWidth + gap) / pitch));
  const step = Math.max(1, Math.floor(visible / 2));
  // Keep counting from where a glide in progress is headed, so quick repeated clicks add up.
  // Anchor on the first fully visible card (the row may rest part-way into one, e.g. at its end).
  const from = s.target != null ? s.target : row.scrollLeft;
  const idx = Math.ceil(from / pitch - 0.02) + dir * step;
  const left = Math.min(maxScroll(row), Math.max(0, idx * pitch));
  s.target = left;
  row.scrollTo({ left, behavior: 'smooth' });
}

/**
 * After a drag, glide to the nearest card edge and only then turn scroll snapping back on —
 * re-enabling it mid-card makes the browser jump to a card instead.
 */
function settle(row, s) {
  const cards = row.children;
  const max = maxScroll(row);
  let left = row.scrollLeft;
  if (cards.length > 1 && left < max - 1) {
    const pitch = cards[1].getBoundingClientRect().left - cards[0].getBoundingClientRect().left;
    if (pitch > 0) left = Math.min(max, Math.round(left / pitch) * pitch);
  }
  let timer = 0;
  const stop = () => {
    clearTimeout(timer);
    row.removeEventListener('scrollend', done);
    s.settling = null;
  };
  function done() {
    stop();
    row.classList.remove('dragging');
  }
  if (Math.abs(left - row.scrollLeft) < 1) { done(); return; }
  s.settling = stop; // a new drag cancels this without turning snapping back on
  row.addEventListener('scrollend', done);
  timer = setTimeout(done, 800); // in case scrollend never comes
  row.scrollTo({ left, behavior: 'smooth' });
}
