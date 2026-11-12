/*
 * SEAM client — private messaging inside SPIM.
 *
 * Everything cryptographic happens in the Rust/WASM module. This file owns the
 * product surface: a passphrase-derived device key, a sealed local state, a
 * durable outbox, and a poll loop. It never holds a server secret and never
 * sends plaintext.
 *
 * State is sealed with ChaCha20-Poly1305 under a PBKDF2-derived device key. The
 * salt is public; the passphrase is not stored. A wrong passphrase is a
 * `store as sealed not_as readable` refusal, not a silent reset.
 */

import init, {
  WasmIdentity,
  WasmPreKeyStore,
  WasmSession,
  seam_bundle_mailbox,
  seam_derive_device_key,
  seam_generate_prekeys,
  seam_mailbox,
  seam_open,
  seam_peek_init,
  seam_seal,
} from '/pkg/spim_wasm.js';

const DAY = 86_400;
const PREKEY_TTL = 7 * DAY;
const PREKEYS_PER_PUBLISH = 16;
const SALT_KEY = 'spim.seam.salt';
const STATE_KEY = 'spim.seam.state';
const STATE_AAD = 'seam-state-v1';
const POLL_MS = 5000;

const $ = (id) => document.getElementById(id);

let identity = null;
let prekeys = null;
let deviceKey = null;
let state = null;
let live = new Map(); // peer id -> WasmSession
let selected = null;
let pollTimer = null;
let polling = false;
let signedIn = false;

/* ------------------------------------------------------------------ status */

function setStatus(message, kind = '') {
  const el = $('seamStatus');
  if (!el) return;
  el.textContent = message;
  el.hidden = !message;
  el.className = 'spim-note' + (kind ? ' spim-note--' + kind : '');
}

function fail(e) {
  const message = String(e && e.message ? e.message : e);
  setStatus(message, 'error');
}

/* -------------------------------------------------------------- device key */

function b64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(text) {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

async function deriveDeviceKey(passphrase, saltB64) {
  const salt = unb64(saltB64);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    key,
    256
  );
  return seam_derive_device_key(b64(new Uint8Array(bits)), saltB64, STATE_AAD);
}

/* ------------------------------------------------------------------- state */

function snapshotLive() {
  for (const [peer, session] of live) {
    state.sessions[peer] = session.snapshot();
  }
}

function saveState() {
  if (!state || !deviceKey) return;
  snapshotLive();
  const sealed = seam_seal(deviceKey, STATE_AAD, JSON.stringify(state));
  localStorage.setItem(STATE_KEY, sealed);
}

function thread(peer) {
  if (!state.threads[peer]) state.threads[peer] = { messages: [] };
  return state.threads[peer];
}

/** The conversation with the newest message, or null when there are none. */
function latestThread() {
  let best = null;
  let bestAt = -1;
  for (const [peer, t] of Object.entries(state.threads || {})) {
    const at = t.messages.length ? t.messages[t.messages.length - 1].at : 0;
    if (at >= bestAt) {
      bestAt = at;
      best = peer;
    }
  }
  return best;
}

function append(peer, dir, body, at) {
  const t = thread(peer);
  t.messages.push({ dir, body, at });
  if (t.messages.length > 500) t.messages = t.messages.slice(-500);
  renderThreads();
  if (selected === peer) renderMessages();
}

function restoreSessions() {
  live = new Map();
  for (const [peer, snap] of Object.entries(state.sessions || {})) {
    try {
      live.set(peer, WasmSession.restore(identity, snap));
    } catch (e) {
      delete state.sessions[peer];
      console.warn('seam: dropping unreadable session', peer, e);
    }
  }
}

/* --------------------------------------------------------------- auth/relay */

async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'include' });
    signedIn = res.ok;
  } catch {
    signedIn = false;
  }
  const el = $('seamAuthState');
  if (el) {
    el.textContent = signedIn
      ? 'Signed in — prekeys and mailbox are available.'
      : 'Sign in to publish prekeys and read your mailbox.';
    el.className = 'spim-note' + (signedIn ? ' spim-note--ok' : '');
  }
  return signedIn;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const detail = body && (body.error || body.message) ? body.error || body.message : res.status;
    throw new Error(`${detail} (${res.status})`);
  }
  return body;
}

function todayMailbox() {
  return seam_mailbox(identity.x_pub_b64(), Math.floor(Date.now() / 1000));
}

function mailboxes() {
  const now = Math.floor(Date.now() / 1000);
  const out = [];
  for (let d = 0; d < 7; d++) {
    const m = seam_mailbox(identity.x_pub_b64(), now - d * DAY);
    if (!out.includes(m)) out.push(m);
  }
  return out;
}

async function publishPrekeys({ replenish = false } = {}) {
  if (!signedIn && !(await checkAuth())) {
    throw new Error('sign in to publish prekeys');
  }
  const now = Math.floor(Date.now() / 1000);
  const mailbox = todayMailbox();
  const today = Math.floor(now / DAY);
  const newDay = state.publishedDay && state.publishedDay !== today;

  if (replenish || newDay || (!state.publishedDay && (!state.pendingBundles || state.pendingBundles.length === 0))) {
    const fresh = JSON.parse(
      prekeys.replenish(identity, PREKEYS_PER_PUBLISH, now, PREKEY_TTL)
    );
    state.pendingBundles = fresh;
    state.publishedDay = Math.floor(now / DAY);
    // The store changed; keep the sealed snapshot in step or a reload would
    // restore prekeys that were already handed out.
    state.prekeys = prekeys.snapshot();
    saveState();
  }

  const bundles = state.pendingBundles || [];
  if (bundles.length === 0) return { stored: 0 };

  const result = await api('/api/seam/prekeys', {
    method: 'POST',
    body: JSON.stringify({ mailbox, bundles }),
  });
  state.pendingBundles = [];
  state.publishedDay = Math.floor(now / DAY);
  saveState();
  renderIdentity();
  return result;
}

async function flushOutbox() {
  if (!state.outbox || state.outbox.length === 0) return 0;
  const keep = [];
  for (const item of state.outbox) {
    try {
      await api('/api/seam/envelopes', {
        method: 'POST',
        body: JSON.stringify({ mailbox: item.mailbox, envelope: item.envelope }),
      });
    } catch (e) {
      // Keep it for the next poll. A duplicate is refused by the recipient's
      // replay window, so retrying the exact capsule is safe.
      keep.push(item);
      console.warn('seam: outbox retry', e);
    }
  }
  state.outbox = keep;
  saveState();
  return keep.length;
}

/* --------------------------------------------------------------- messaging */

async function fetchBundle(mailbox) {
  const body = await api(`/api/seam/prekeys/${encodeURIComponent(mailbox)}`, { method: 'GET' });
  return body.bundle;
}

async function startPeer(input) {
  const value = String(input || '').trim();
  if (!value) throw new Error('paste a mailbox or a prekey bundle');

  let bundle;
  if (/^[0-9a-f]{32}$/.test(value)) {
    bundle = await fetchBundle(value);
  } else {
    try {
      bundle = JSON.parse(value);
    } catch {
      throw new Error('that is neither a mailbox nor bundle JSON');
    }
  }

  const peer = bundle.id;
  if (!peer) throw new Error('bundle has no identity id');
  if (peer === identity.id()) throw new Error('that is your own bundle');

  if (!live.has(peer)) {
    const session = WasmSession.initiate(identity, JSON.stringify(bundle), Math.floor(Date.now() / 1000));
    live.set(peer, session);
    state.sessions[peer] = session.snapshot();
  }
  state.peerMailboxes = state.peerMailboxes || {};
  state.peerMailboxes[peer] = seam_bundle_mailbox(
    JSON.stringify(bundle),
    Math.floor(Date.now() / 1000)
  );
  selected = peer;
  thread(peer);
  saveState();
  renderThreads();
  renderMessages();
  setStatus('Conversation ready. The first message carries the handshake.', 'ok');
  return peer;
}

async function sendMessage(body) {
  const text = String(body || '').trim();
  if (!text) throw new Error('write a message first');
  if (!selected) throw new Error('start or select a conversation first');
  if (!live.has(selected)) throw new Error('no live session for this conversation');

  // A capsule is posted to the peer's mailbox for the day it was sealed. Check
  // the address before encrypting: a missing mailbox must not burn a ratchet
  // step on a message that can never be delivered.
  const peerMailbox = state.peerMailboxes && state.peerMailboxes[selected];
  if (!peerMailbox) throw new Error('missing peer mailbox; start the conversation again');

  const at = Math.floor(Date.now() / 1000);
  const session = live.get(selected);
  const envelope = session.encrypt(text, at);

  state.outbox = state.outbox || [];
  state.outbox.push({ peer: selected, mailbox: peerMailbox, envelope, at });
  append(selected, 'out', text, at);
  state.sessions[selected] = session.snapshot();
  saveState();

  const pending = await flushOutbox();
  $('seamBody').value = '';
  if (pending) {
    setStatus('Sealed. Delivery is pending; it will retry.', '');
  } else {
    setStatus('Sealed and sent.', 'ok');
  }
}

async function acceptFirst(envelopeB64, info) {
  const peer = info.peer_id;
  if (live.has(peer)) {
    // A known peer re-initiating is ambiguous with a replay. Do not burn an
    // OPK; try the existing session. A refusal here is final for this capsule,
    // so ack it rather than letting a replay sit in the mailbox forever.
    const session = live.get(peer);
    try {
      const body = session.decrypt(envelopeB64);
      state.sessions[peer] = session.snapshot();
      if (!selected) selected = peer;
      append(peer, 'in', body, Math.floor(Date.now() / 1000));
      return { ack: true };
    } catch (e) {
      return {
        ack: true,
        note:
          `Refused: ${String(e && e.message ? e.message : e)}. ` +
          'If this is a new handshake, forget the session and ask them to resend.',
      };
    }
  }

  const session = WasmSession.accept(identity, prekeys, envelopeB64);
  live.set(peer, session);
  state.sessions[peer] = session.snapshot();
  state.prekeys = prekeys.snapshot();
  state.peerMailboxes = state.peerMailboxes || {};
  // The init carries the sender's public agreement key; their mailbox for the
  // day the capsule was sealed is derivable from it. No extra secret.
  try {
    state.peerMailboxes[peer] = seam_mailbox(info.ik, info.at);
  } catch {
    // If the key is malformed, the accept above already refused.
  }
  const first = session.first_body();
  if (!selected) selected = peer;
  append(peer, 'in', first, Math.floor(Date.now() / 1000));
  return { ack: true };
}

async function processCapsule(envelopeB64) {
  let info = null;
  try {
    const peek = seam_peek_init(envelopeB64);
    info = peek ? JSON.parse(peek) : null;
  } catch (e) {
    // A malformed frame is a refusal, not a crash.
    return { ack: true, note: String(e.message || e) };
  }

  if (info && info.peer_id) {
    return acceptFirst(envelopeB64, info);
  }

  let lastRefusal = null;
  for (const [peer, session] of live) {
    try {
      const body = session.decrypt(envelopeB64);
      state.sessions[peer] = session.snapshot();
      append(peer, 'in', body, Math.floor(Date.now() / 1000));
      return { ack: true };
    } catch (e) {
      // Transactional decrypt restored the session; try the next one. Keep the
      // reason so a capsule no session can read says why, not just "no".
      lastRefusal = String(e && e.message ? e.message : e);
    }
  }
  return {
    ack: true,
    note: lastRefusal
      ? `Refused: ${lastRefusal}`
      : 'No session could read this capsule.',
  };
}

async function poll() {
  if (!state || polling || !signedIn) return;
  polling = true;
  try {
    await flushOutbox();
    for (const mailbox of mailboxes()) {
      let body;
      try {
        body = await api(`/api/seam/envelopes/${mailbox}`, { method: 'GET' });
      } catch (e) {
        // A mailbox with no owner yet is normal before the first publish.
        continue;
      }
      if (!body || !body.messages || body.messages.length === 0) continue;

      const ack = [];
      for (const message of body.messages) {
        try {
          const result = await processCapsule(message.envelope);
          if (result.ack) ack.push(message.id);
          if (result.note) setStatus(result.note, 'error');
        } catch (e) {
          // A known peer re-initiating, a malformed frame, or a replay: leave
          // the capsule unacked so a reset can retry it.
          setStatus(String(e.message || e), 'error');
        }
      }
      if (ack.length) {
        try {
          await api(`/api/seam/envelopes/${mailbox}/ack`, {
            method: 'POST',
            body: JSON.stringify({ ids: ack }),
          });
        } catch (e) {
          console.warn('seam: ack failed', e);
        }
      }
      saveState();
    }
    renderIdentity();
    renderThreads();
    renderMessages();
  } catch (e) {
    fail(e);
  } finally {
    polling = false;
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(poll, POLL_MS);
  poll();
}

/* ------------------------------------------------------------------- render */

function renderIdentity() {
  if (!state) return;
  $('seamCreateCard').hidden = true;
  $('seamUnlockCard').hidden = true;
  $('seamIdentityCard').hidden = false;
  $('seamWorkspace').hidden = false;

  $('seamFingerprint').textContent = identity.fingerprint();
  $('seamId').textContent = identity.id();
  $('seamMailbox').textContent = todayMailbox();
  $('seamPrekeys').textContent = String(prekeys.remaining());
  $('seamPublished').textContent = state.publishedDay
    ? new Date(state.publishedDay * DAY * 1000).toISOString().slice(0, 10)
    : 'not yet';
  $('seamInvite').value = `${location.origin}/seam?mailbox=${todayMailbox()}`;
}

function renderThreads() {
  if (!state) return;
  const list = $('seamThreads');
  list.innerHTML = '';
  const peers = Object.keys(state.threads || {});
  if (peers.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'spim-body';
    empty.textContent = 'No conversations yet. Paste a mailbox or bundle to begin.';
    list.appendChild(empty);
    return;
  }
  for (const peer of peers) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'spim-thread' + (peer === selected ? ' is-active' : '');
    button.dataset.peer = peer;
    const name = document.createElement('span');
    name.className = 'spim-thread-id';
    name.textContent = peer.slice(0, 12) + '…';
    const meta = document.createElement('span');
    meta.className = 'spim-thread-meta';
    const msgs = state.threads[peer].messages;
    meta.textContent = msgs.length ? `${msgs.length} message${msgs.length === 1 ? '' : 's'}` : 'new';
    button.append(name, meta);
    button.addEventListener('click', () => {
      selected = peer;
      renderThreads();
      renderMessages();
    });
    list.appendChild(button);
  }
}

function renderMessages() {
  const box = $('seamMessages');
  const title = $('seamThreadTitle');
  if (!box) return;
  box.innerHTML = '';
  if (!selected || !state.threads[selected]) {
    title.textContent = 'No conversation selected';
    $('seamCompose').hidden = true;
    return;
  }
  $('seamCompose').hidden = false;
  title.textContent = selected;
  for (const msg of state.threads[selected].messages) {
    const row = document.createElement('div');
    row.className = 'spim-message spim-message--' + msg.dir;
    const text = document.createElement('p');
    text.textContent = msg.body;
    const when = document.createElement('time');
    when.className = 'spim-message-time';
    when.textContent = new Date(msg.at * 1000).toLocaleString();
    row.append(text, when);
    box.appendChild(row);
  }
  box.scrollTop = box.scrollHeight;
}

/* --------------------------------------------------------------------- boot */

function wire() {
  $('seamCreateBtn').addEventListener('click', async () => {
    try {
      const pass = $('seamPass').value;
      if (pass.length < 12) throw new Error('use a passphrase of at least 12 characters');
      if (localStorage.getItem(STATE_KEY) && !confirm('Replace the existing SEAM identity on this device?')) return;
      await createIdentity(pass);
    } catch (e) {
      fail(e);
    }
  });

  $('seamUnlockBtn').addEventListener('click', async () => {
    try {
      await unlock($('seamPassUnlock').value);
    } catch (e) {
      fail(e);
    }
  });

  $('seamPublishBtn').addEventListener('click', async () => {
    try {
      setStatus('Publishing prekeys…');
      const result = await publishPrekeys({ replenish: true });
      setStatus(`Published ${result.stored} one-time prekeys.`, 'ok');
      renderIdentity();
    } catch (e) {
      fail(e);
    }
  });

  $('seamCopyInvite').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('seamInvite').value);
      setStatus('Invite copied. Send it over a channel you already trust.', 'ok');
    } catch {
      $('seamInvite').select();
      setStatus('Select and copy the invite link.', '');
    }
  });

  $('seamPeerStartBtn').addEventListener('click', async () => {
    try {
      await startPeer($('seamPeer').value);
      $('seamPeer').value = '';
    } catch (e) {
      fail(e);
    }
  });

  $('seamSendBtn').addEventListener('click', async () => {
    try {
      await sendMessage($('seamBody').value);
    } catch (e) {
      fail(e);
    }
  });

  $('seamRefreshBtn').addEventListener('click', () => poll());

  $('seamResetBtn').addEventListener('click', () => {
    if (!selected) return;
    if (!confirm('Forget the session with this peer? History stays; a new handshake can be accepted.')) return;
    live.delete(selected);
    delete state.sessions[selected];
    saveState();
    setStatus('Session forgotten. Poll again to accept a fresh handshake.', 'ok');
  });
}

async function createIdentity(passphrase) {
  const salt = b64(randomBytes(16));
  localStorage.setItem(SALT_KEY, salt);
  deviceKey = await deriveDeviceKey(passphrase, salt);

  identity = new WasmIdentity();
  const now = Math.floor(Date.now() / 1000);
  const generated = JSON.parse(
    seam_generate_prekeys(identity, PREKEYS_PER_PUBLISH, now, PREKEY_TTL)
  );
  prekeys = WasmPreKeyStore.restore(generated.store);

  state = {
    v: 1,
    identity: identity.to_secret_json(),
    prekeys: prekeys.snapshot(),
    sessions: {},
    threads: {},
    outbox: [],
    peerMailboxes: {},
    pendingBundles: generated.bundles,
    publishedDay: 0,
  };
  saveState();
  await checkAuth();
  try {
    await publishPrekeys();
    setStatus('Identity created and prekeys published.', 'ok');
  } catch (e) {
    setStatus(
      `Identity created. ${e.message} — sign in, then press Publish prekeys.`,
      'error'
    );
  }
  renderIdentity();
  startPolling();
}

async function unlock(passphrase) {
  if (!passphrase) throw new Error('enter your passphrase');
  const sealed = localStorage.getItem(STATE_KEY);
  if (!sealed) throw new Error('no SEAM identity on this device');
  const salt = localStorage.getItem(SALT_KEY);
  if (!salt) throw new Error('device salt is missing; the state cannot be opened');

  deviceKey = await deriveDeviceKey(passphrase, salt);
  const plain = seam_open(deviceKey, STATE_AAD, sealed);
  const parsed = JSON.parse(plain);
  if (!parsed || parsed.v !== 1) throw new Error('unknown SEAM state version');

  state = parsed;
  state.sessions = state.sessions || {};
  state.threads = state.threads || {};
  state.outbox = state.outbox || [];
  state.peerMailboxes = state.peerMailboxes || {};

  identity = WasmIdentity.from_secret_json(state.identity);
  prekeys = WasmPreKeyStore.restore(state.prekeys);
  restoreSessions();
  if (!selected) selected = latestThread();
  renderIdentity();
  renderThreads();
  renderMessages();
  setStatus('Unlocked on this device.', 'ok');

  await checkAuth();
  try {
    const now = Math.floor(Date.now() / 1000);
    if (!state.publishedDay || state.publishedDay !== Math.floor(now / DAY)) {
      await publishPrekeys();
    }
  } catch (e) {
    setStatus(`Unlocked. ${e.message}`, 'error');
  }
  startPolling();
}

async function boot() {
  wire();
  $('seamCreateBtn').disabled = true;
  $('seamUnlockBtn').disabled = true;
  const params = new URLSearchParams(location.search);
  const to = params.get('mailbox');
  if (to) $('seamPeer').value = to;

  try {
    await init();
  } catch (e) {
    setStatus('The SEAM engine did not load: ' + (e.message || e), 'error');
    return;
  }
  $('seamCreateBtn').disabled = false;
  $('seamUnlockBtn').disabled = false;

  await checkAuth();
  const sealed = localStorage.getItem(STATE_KEY);
  $('seamCreateCard').hidden = !!sealed;
  $('seamUnlockCard').hidden = !sealed;
  if (!sealed) {
    setStatus('Create an identity on this device to begin.', '');
  } else {
    setStatus('Enter your passphrase to open the sealed state.', '');
  }
}

boot().catch(fail);
