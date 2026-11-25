// Settings dialog: keyboard shortcuts (every action, several keys each) and how far rewind / fast-forward move.
import { esc, icon, toast } from './util.js';
import { HOST_PROXY } from './store.js';
import { openDialog } from './playlists.js';
import {
  ACTIONS, MAX_KEYS, DEFAULT_STEP, bindings, addBinding, removeBinding, resetBindings, seekStep, setSeekStep,
  comboOf, reserved, label, keycaps,
} from './keys.js';

let open = null;

export function openSettings() {
  if (open) return;
  let recording = null; // action id waiting for a key
  const actions = ACTIONS.filter((a) => !a.host || HOST_PROXY);
  const dlg = openDialog(`
    <header class="dlg-head"><h2 class="dlg-title">Settings</h2>
      <button class="icon-btn" data-x title="Close">${icon('close')}</button></header>
    <section class="set-sec">
      <h3>Rewind and fast-forward</h3>
      <label class="set-step">Move by <input type="number" min="1" max="600" step="1" inputmode="numeric"> seconds</label>
    </section>
    <section class="set-sec">
      <h3>Keyboard shortcuts</h3>
      <p class="set-hint">Press <b>+</b> next to an action, then the key or combination you want (Esc cancels).
        A key can only do one thing: giving it to a new action takes it away from the old one.</p>
      <div class="set-keys"></div>
    </section>
    <footer class="dlg-foot"><button class="btn ghost" data-reset>Reset to defaults</button><button class="btn primary" data-x>Done</button></footer>`,
  { onClose: () => { window.removeEventListener('keydown', onKey, true); open = null; } });
  open = dlg;
  const el = dlg.el;
  el.classList.add('dlg-wide', 'settings');
  const stepInput = el.querySelector('.set-step input');
  stepInput.placeholder = String(DEFAULT_STEP);

  const draw = () => {
    const all = bindings();
    const step = seekStep();
    let group = '';
    el.querySelector('.set-keys').innerHTML = actions.map((a) => {
      const name = a.id === 'seekBack' ? `Rewind ${step} s` : a.id === 'seekFwd' ? `Fast-forward ${step} s` : a.label;
      const keys = all[a.id];
      const head = a.group !== group ? `<h4 class="set-group">${esc((group = a.group))}</h4>` : '';
      const rec = recording === a.id;
      return `${head}<div class="set-row">
        <span class="set-name">${esc(name)}${a.hint ? `<small>${esc(a.hint)}</small>` : ''}</span>
        <span class="set-chips">
          ${keys.map((c) => `<span class="key-chip">${keycaps(c)}<button class="chip-x" data-remove="${a.id}" data-combo="${esc(c)}" title="Remove ${esc(label(c))}">${icon('close')}</button></span>`).join('')}
          ${rec ? '<span class="key-chip rec">Press a key…</span>' : ''}
          ${!rec && keys.length < MAX_KEYS ? `<button class="key-add" data-add="${a.id}" title="Add a shortcut">${icon('plus')}</button>` : ''}
          ${!keys.length && !rec ? '<span class="key-none">None</span>' : ''}
        </span>
      </div>`;
    }).join('');
    if (document.activeElement !== stepInput) stepInput.value = step;
  };

  // Listen on window in the capture phase so this runs before the dialog's own Esc handler and the app's shortcuts.
  const onKey = (e) => {
    if (!recording) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.key === 'Escape') { recording = null; draw(); return; }
    const combo = comboOf(e);
    if (!combo) return; // a modifier on its own: wait for the real key
    const why = reserved(combo);
    if (why) { toast(why); return; }
    const from = addBinding(recording, combo);
    if (from) toast(`${label(combo)} moved from “${from.label}”`);
    recording = null;
    draw();
  };
  window.addEventListener('keydown', onKey, true);

  el.addEventListener('click', (e) => {
    const add = e.target.closest('[data-add]');
    if (add) { recording = add.dataset.add; draw(); return; }
    const rm = e.target.closest('[data-remove]');
    if (rm) { removeBinding(rm.dataset.remove, rm.dataset.combo); draw(); return; }
    if (recording && !e.target.closest('.key-chip.rec')) { recording = null; draw(); }
    if (e.target.closest('[data-reset]')) { resetBindings(); recording = null; draw(); toast('Settings reset'); }
  });
  const commitStep = () => {
    const n = parseInt(stepInput.value, 10);
    if (Number.isNaN(n)) stepInput.value = seekStep();
    else { setSeekStep(n); stepInput.value = seekStep(); draw(); }
  };
  stepInput.addEventListener('change', commitStep);
  stepInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitStep(); stepInput.blur(); } });
  draw();
}
