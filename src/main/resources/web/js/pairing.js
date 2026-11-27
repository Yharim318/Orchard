// Pairing (see Access.java): a phone or browser that isn't paired with this Orchard computer yet asks for access and
// waits; the Orchard window on that computer shows "Allow <device>?". Scanning the QR code in the Orchard window
// skips the question (store.js claimInvite).
import { esc, icon } from './util.js';
import {
  S, HOST_PROXY, subscribe, requestAccess, accessStatus, setDeviceKey, pendingRequests, decideRequest,
} from './store.js';
import { openDialog } from './playlists.js';

// ------------------------------------------------------------------ this device: not paired yet

let screen = null;
let polling = 0;

/** Covers the app with "Waiting for access" until the Orchard computer allows this device. */
export function showPairing() {
  if (HOST_PROXY || screen) return;
  const pc = esc((S.info && S.info.name) || 'the Orchard computer');
  screen = document.createElement('div');
  screen.className = 'pairing';
  screen.innerHTML = `<div class="pairing-card">
      <img class="pairing-logo" src="icon.svg" alt="">
      <h1>Connect to ${pc}</h1>
      <p class="pairing-text"></p>
      <div class="pairing-actions"></div>
      <p class="pairing-hint">Only devices allowed by the Apple Music account signed in on ${pc} can use it.
        Quickest: scan the QR code under ${icon('devices')} in the Orchard window there.</p>
    </div>`;
  document.body.appendChild(screen);
  screen.addEventListener('click', (e) => { if (e.target.closest('[data-ask]')) ask(); });
  ask();
}

function say(html, button = '') {
  if (!screen) return;
  screen.querySelector('.pairing-text').innerHTML = html;
  screen.querySelector('.pairing-actions').innerHTML = button
    ? `<button class="btn primary" data-ask>${esc(button)}</button>` : '<span class="pairing-wait"><i></i><i></i><i></i></span>';
}

async function ask() {
  clearTimeout(polling);
  const pc = esc((S.info && S.info.name) || 'that computer');
  say('Asking for access…');
  let req;
  try {
    req = await requestAccess();
  } catch (e) {
    say(esc(e.message), 'Try again');
    return;
  }
  say(`Waiting for someone to click <b>Allow</b> in the Orchard window on ${pc}…`);
  const poll = async () => {
    let r;
    try {
      r = await accessStatus(req.id, req.secret);
    } catch (e) {
      polling = setTimeout(poll, 4000); // the computer may be busy or restarting
      return;
    }
    if (r.status === 'approved' && r.key) {
      setDeviceKey(r.key);
      say('Allowed. Opening Orchard…');
      location.reload();
    } else if (r.status === 'denied') {
      say(`Access was denied on ${pc}.`, 'Ask again');
    } else if (r.status === 'expired') {
      say('Nobody answered in time.', 'Ask again');
    } else {
      polling = setTimeout(poll, 2000);
    }
  };
  polling = setTimeout(poll, 2000);
}

// ------------------------------------------------------------------ the Orchard window: "Allow this device?"

let prompt = null;
let promptId = null;

function nextPrompt() {
  const list = S.pairRequests || [];
  if (prompt && list.some((r) => r.id === promptId)) return; // still waiting on the one shown
  if (prompt) { prompt.close(); prompt = null; promptId = null; }
  const r = list[0];
  if (!r) return;
  promptId = r.id;
  const what = r.kind === 'phone' ? 'phone' : r.kind === 'tablet' ? 'tablet' : 'device';
  let answered = false;
  prompt = openDialog(`
    <h2 class="dlg-title">Allow “${esc(r.name)}”?</h2>
    <p class="dlg-text">A ${what} on your network wants to use Orchard. If you allow it, it can play music here and see
      and edit your Apple Music library, on every computer signed in to this account. Only allow devices you know.</p>
    <footer class="dlg-foot"><button class="btn ghost" data-deny>Deny</button><button class="btn primary" data-allow>Allow</button></footer>`,
  {
    onClose: () => {
      const id = promptId;
      prompt = null;
      promptId = null;
      if (!answered) decideRequest(id, false).catch(() => {}); // closing the dialog (Esc) counts as Deny
    },
  });
  const decide = (allow) => {
    answered = true;
    decideRequest(r.id, allow).catch(() => {});
    S.pairRequests = (S.pairRequests || []).filter((x) => x.id !== r.id);
    if (prompt) prompt.close();
    setTimeout(nextPrompt, 300);
  };
  prompt.el.querySelector('[data-allow]').addEventListener('click', () => decide(true));
  prompt.el.querySelector('[data-deny]').addEventListener('click', () => decide(false));
}

/** Shows unpaired devices' requests in the Orchard window (the only place that may answer them). */
export function initPairing() {
  subscribe((kind) => {
    if (kind === 'unpaired') showPairing();
    if (kind === 'pair-requests' && HOST_PROXY) nextPrompt();
  });
  if (HOST_PROXY) {
    pendingRequests().then((list) => {
      S.pairRequests = Array.isArray(list) ? list : [];
      nextPrompt();
    }).catch(() => {});
  }
}
