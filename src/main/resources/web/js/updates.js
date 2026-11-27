// Automatic updates of orchard.exe (see Updater.java): the Settings section and the "Restart to update" button.
// Always talks to the Orchard computer that served this page, never to a speaker this page is controlling.
import { $, esc, icon, toast } from './util.js';
import { ROOT, orchardFetch } from './store.js';

let status = null;
const listeners = new Set();

async function request(method, body) {
  const res = await orchardFetch(`${ROOT}/api/update`, method === 'GET' ? {} : {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

function set(s) {
  status = s;
  listeners.forEach((fn) => fn(s));
  // While it's working, look again soon; otherwise every few minutes.
  clearTimeout(set.timer);
  const busy = s && (s.status === 'checking' || s.status === 'downloading');
  set.timer = setTimeout(refresh, busy ? 1500 : 5 * 60 * 1000);
}

export async function refresh() {
  try { set(await request('GET')); } catch (e) { /* an older Orchard without updates: nothing to show */ }
  return status;
}

export const onUpdate = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const setAutoUpdate = async (enabled) => set(await request('POST', { enabled }));
export const checkForUpdate = async () => set(await request('POST', { action: 'check' }));

export async function restartToUpdate() {
  await request('POST', { action: 'restart' });
  toast('Restarting Orchard…');
}

/** One line describing where updates stand. */
export function describe(s) {
  if (!s) return '';
  if (!s.supported) return s.message;
  const parts = [`Version ${s.current}.`];
  if (s.blocked) parts.push('Turned off for this run (--no-update or ORCHARD_NO_UPDATE).');
  else if (s.dev && !['checking', 'downloading', 'ready', 'error'].includes(s.status)) {
    parts.push('This is a development build (made with build.cmd), so it doesn’t update itself; release builds from GitHub do. “Check now” replaces it with the latest release.');
  }
  else if (s.status === 'off') parts.push('Automatic updates are off. “Check now” still looks for a new version.');
  else if (s.message) parts.push(s.message);
  if (s.checkedAt && !['checking', 'downloading'].includes(s.status)) {
    parts.push(`Last checked ${new Date(s.checkedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}.`);
  }
  return parts.join(' ');
}

/** The sidebar button that appears once an update is installed and waiting for a restart. */
export function initUpdates() {
  const nav = $('#nav');
  const btn = document.createElement('button');
  btn.className = 'nav-item update-ready';
  btn.hidden = true;
  btn.innerHTML = `${icon('update')}<span>Restart to update</span>`;
  nav.appendChild(btn);
  btn.addEventListener('click', () => restartToUpdate().catch((e) => toast(e.message)));
  onUpdate((s) => {
    btn.hidden = !(s && s.ready);
    if (s && s.ready) btn.title = `Orchard ${s.ready} is installed. Restart Orchard to start using it.`;
  });
  refresh();
}

/** Markup for the Settings dialog's Updates section; wire it up with bindUpdateSettings(). */
export const updateSettingsHtml = () => `
  <section class="set-sec set-updates" hidden>
    <h3>Updates</h3>
    <label class="set-switch"><input type="checkbox"><span class="sw" aria-hidden="true"></span>
      <span>Update Orchard automatically</span></label>
    <p class="set-hint">New versions are downloaded from GitHub and installed in the background. They start the
      next time Orchard does, or by themselves once nothing has played for 30 minutes.</p>
    <p class="set-status"></p>
    <div class="set-actions">
      <button class="btn small" data-upd-check>Check now</button>
      <button class="btn small primary" data-upd-restart hidden>Restart now</button>
    </div>
  </section>`;

/** Fills in and wires the Updates section; returns a function that stops listening. */
export function bindUpdateSettings(el) {
  const sec = el.querySelector('.set-updates');
  const box = sec.querySelector('input[type=checkbox]');
  const draw = (s) => {
    sec.hidden = !s;
    if (!s) return;
    box.checked = !!s.enabled && !s.blocked;
    box.disabled = !s.supported || s.blocked;
    sec.querySelector('.set-status').innerHTML = esc(describe(s));
    const busy = s.status === 'checking' || s.status === 'downloading';
    const check = sec.querySelector('[data-upd-check]');
    check.hidden = !s.supported || !!s.ready;
    check.disabled = busy;
    check.textContent = busy ? (s.status === 'downloading' ? 'Downloading…' : 'Checking…') : 'Check now';
    sec.querySelector('[data-upd-restart]').hidden = !s.ready;
  };
  box.addEventListener('change', () => {
    setAutoUpdate(box.checked).catch((e) => { toast(e.message); refresh(); });
  });
  sec.querySelector('[data-upd-check]').addEventListener('click', () => checkForUpdate().catch((e) => toast(e.message)));
  sec.querySelector('[data-upd-restart]').addEventListener('click', () => restartToUpdate().catch((e) => toast(e.message)));
  const stop = onUpdate(draw);
  draw(status);
  refresh();
  return stop;
}
