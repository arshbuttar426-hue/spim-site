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
 *
 * Addressing: a mailbox is derived from the peer's public agreement key and
 * the day the capsule is sealed. It must be recomputed on every send — a
 * mailbox frozen on the day a chat started is only polled for seven days.
 */

import init, {
  WasmIdentity,
  WasmPreKeyStore,
  WasmSession,
  blake3_hex_static,
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

const AUTO_CLEAR = [0, 60, 1440, 10080];
const AUTO_CLEAR_LABEL = { 0: 'off', 60: '1 hour', 1440: '24 hours', 10080: '7 days' };

const $ = (id) => document.getElementById(id);
const qsa = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));
const now = () => Math.floor(Date.now() / 1000);

let identity = null;
let prekeys = null;
let deviceKey = null;
let state = null;
let live = new Map(); // peer id -> WasmSession
let selected = null;
let pollTimer = null;
let polling = false;
let publishing = false;
let signedIn = false;
let myUserId = null;
let otherTab = false;
let statusTimer = null;

/* ------------------------------------------------------------------ status */

function setStatus(message, kind = '') {
  const el = $('seamStatus');
  if (!el) return;
  clearTimeout(statusTimer);
  el.textContent = message || '';
  el.hidden = !message;
  el.dataset.kind = kind;
  if (message && kind !== 'error') {
    statusTimer = setTimeout(() => {
      el.hidden = true;
      el.textContent = '';
    }, 6000);
  }
}

/** Turn an engine or relay refusal into something a person can act on. */
function plainError(e) {
  const raw = String(e && e.message ? e.message : e);
  const rules = [
    [/store as sealed not_as readable/i, "That passphrase doesn't open this device's channel."],
    [/no channel at that address/i, 'No channel at that ID yet. Ask them to open Disposable Chats once.'],
    [/sign in to look up/i, 'Sign in to open a channel by ID.'],
    [/sign in/i, 'Sign in to SPIM to send and receive.'],
    [/not your mailbox/i, 'This device is not signed in to that channel.'],
    [/no bundle|not found|no prekeys available|\(404\)/i, 'No invite found at that link. It may have been used or expired.'],
    [/expired/i, 'That invite has expired. Ask for a new one.'],
    [/Failed to fetch|NetworkError|load failed|\(5\d\d\)/i, "Can't reach the server. Messages stay queued."],
  ];
  for (const [re, message] of rules) if (re.test(raw)) return message;
  return raw.replace(/\s*\((4\d\d|5\d\d)\)$/, '');
}

function fail(e) {
  setStatus(plainError(e), 'error');
}

function setConn(kind, text) {
  const el = $('seamConn');
  if (!el) return;
  el.dataset.state = kind;
  const label = el.querySelector('span');
  if (label) label.textContent = text;
}

function uid() {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
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

function contact(peer) {
  state.contacts = state.contacts || {};
  if (!state.contacts[peer]) {
    state.contacts[peer] = { id: peer, alias: null, verified: false, firstSeen: now() };
  }
  return state.contacts[peer];
}

function thread(peer) {
  state.threads = state.threads || {};
  if (!state.threads[peer]) state.threads[peer] = { messages: [], unread: 0 };
  if (typeof state.threads[peer].unread !== 'number') state.threads[peer].unread = 0;
  return state.threads[peer];
}

function lastAt(peer) {
  const t = state.threads[peer];
  if (!t || !t.messages.length) return 0;
  return t.messages[t.messages.length - 1].at || 0;
}

function latestThread() {
  let best = null;
  let bestAt = -1;
  for (const peer of Object.keys(state.threads || {})) {
    const at = lastAt(peer);
    if (at >= bestAt) {
      bestAt = at;
      best = peer;
    }
  }
  return best;
}

function shortId(id) {
  const text = String(id || '');
  return text.length > 10 ? 'usr_…' + text.slice(-6) : text;
}

function aliasOf(peer) {
  const c = contact(peer);
  if (c.alias) return c.alias;
  if (c.userId) return shortId(c.userId);
  return 'Channel ' + String(peer).slice(0, 6);
}

/** The peer's mailbox for a given day. Recomputed per send — never frozen. */
function mailboxFor(peer, at) {
  const c = state.contacts && state.contacts[peer];
  if (c && c.x) {
    try {
      return seam_mailbox(c.x, at);
    } catch {
      return null;
    }
  }
  // Legacy v1 state: the day-of-start mailbox was all we stored.
  return (state.peerMailboxes && state.peerMailboxes[peer]) || null;
}

function append(peer, dir, body, at, status) {
  const t = thread(peer);
  const msg = {
    id: uid(),
    dir,
    body,
    at,
    status: status || (dir === 'out' ? 'queued' : 'received'),
  };
  t.messages.push(msg);
  if (t.messages.length > 500) t.messages = t.messages.slice(-500);

  if (dir === 'in') {
    if (!selected) {
      // Nothing is open: the first message is the channel opening.
      selected = peer;
      if ($('seamApp').dataset.seamState === 'home') {
        contact(peer).lastSeen = at;
        saveState();
        enterChat(peer);
        return msg;
      }
    } else if (selected !== peer || document.hidden) {
      t.unread += 1;
    }
  }

  contact(peer).lastSeen = at;
  saveState();
  renderThreads();
  if (selected === peer) renderThread();
  return msg;
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

/** Drop local copies older than the conversation's auto-clear window. */
function prune() {
  const minutes = state && state.settings ? state.settings.autoClear : 0;
  if (!minutes) return false;
  const cutoff = now() - minutes * 60;
  let changed = false;
  for (const t of Object.values(state.threads || {})) {
    const kept = t.messages.filter((m) => m.at >= cutoff);
    if (kept.length !== t.messages.length) {
      t.messages = kept;
      changed = true;
    }
  }
  if (changed) saveState();
  return changed;
}

function migrate(parsed) {
  if (!parsed || (parsed.v !== 1 && parsed.v !== 2)) {
    throw new Error('This channel cannot be read on this device.');
  }
  parsed.v = 2;
  parsed.sessions = parsed.sessions || {};
  parsed.threads = parsed.threads || {};
  parsed.outbox = parsed.outbox || [];
  parsed.peerMailboxes = parsed.peerMailboxes || {};
  parsed.contacts = parsed.contacts || {};
  parsed.settings = parsed.settings || { autoClear: 0 };
  for (const [peer, t] of Object.entries(parsed.threads)) {
    t.unread = typeof t.unread === 'number' ? t.unread : 0;
    t.messages = (t.messages || []).map((m) => ({
      id: m.id || uid(),
      dir: m.dir,
      body: m.body,
      at: m.at,
      status: m.status || (m.dir === 'out' ? 'sent' : 'received'),
    }));
    if (!parsed.contacts[peer]) parsed.contacts[peer] = { id: peer, alias: null, verified: false };
  }
  return parsed;
}

/* --------------------------------------------------------------- auth/relay */

async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'include' });
    signedIn = res.ok;
    if (signedIn) {
      const body = await res.json().catch(() => null);
      myUserId = (body && body.user && body.user.id) || null;
    } else {
      myUserId = null;
    }
  } catch {
    signedIn = false;
    myUserId = null;
  }
  const el = $('seamAuthState');
  if (el) {
    el.textContent = signedIn
      ? 'Signed in. Your ID goes live with your first channel.'
      : 'Sign in to create a channel.';
  }
  const foot = $('seamCreateFoot');
  if (foot) foot.hidden = signedIn;
  const create = $('seamCreateBtn');
  if (create && !localStorage.getItem(STATE_KEY)) create.disabled = !signedIn;
  if (!signedIn) setConn('idle', 'Sign in to sync');
  if (state && identity) {
    renderBar();
    renderHome();
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
  return seam_mailbox(identity.x_pub_b64(), now());
}

/** The address or mailbox an invite link asked us to open. */
function inviteTarget() {
  const params = new URLSearchParams(location.search);
  return params.get('to') || params.get('mailbox') || '';
}

function mailboxes() {
  const at = now();
  const today = Math.floor(at / DAY);
  const owned = (state.publishedMailboxes || [])
    .filter((m) => m && m.mailbox && m.day >= today - 6)
    .sort((a, b) => b.day - a.day)
    .map((m) => m.mailbox);
  if (owned.length) return owned;
  // Legacy state: only today's mailbox is known to be ours.
  return [todayMailbox()];
}

async function publishPrekeys({ replenish = false } = {}) {
  if (publishing) return { stored: 0 };
  publishing = true;
  try {
    if (!signedIn && !(await checkAuth())) throw new Error('sign in to renew the invite');
    const at = now();
    const mailbox = todayMailbox();
    const today = Math.floor(at / DAY);
    const newDay = state.publishedDay && state.publishedDay !== today;

    if (
      replenish ||
      newDay ||
      (!state.publishedDay && (!state.pendingBundles || state.pendingBundles.length === 0))
    ) {
      const fresh = JSON.parse(prekeys.replenish(identity, PREKEYS_PER_PUBLISH, at, PREKEY_TTL));
      state.pendingBundles = fresh;
      state.publishedDay = today;
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
    state.publishedDay = today;
    // Only a mailbox we published to is ours to drain; the relay records the
    // owner at publish time. Keep a short history for late capsules.
    state.publishedMailboxes = (state.publishedMailboxes || [])
      .filter((m) => m && m.day >= today - 6 && m.mailbox !== mailbox)
      .concat([{ mailbox, day: today }]);
    saveState();
    renderBar();
    renderHome();
    return result;
  } finally {
    publishing = false;
  }
}

async function flushOutbox() {
  if (!state.outbox || state.outbox.length === 0) return 0;
  const keep = [];
  for (const item of state.outbox) {
    try {
      const mailbox = mailboxFor(item.peer, item.at);
      if (!mailbox) throw new Error('This channel is missing its address. Open it again from the invite.');
      await api('/api/seam/envelopes', {
        method: 'POST',
        body: JSON.stringify({ mailbox, envelope: item.envelope }),
      });
      const t = state.threads[item.peer];
      const msg = t && t.messages.find((m) => m.id === item.msgId);
      if (msg) msg.status = 'sent';
    } catch (e) {
      // Keep it for the next poll. A duplicate is refused by the recipient's
      // replay window, so retrying the exact capsule is safe.
      const t = state.threads[item.peer];
      const msg = t && t.messages.find((m) => m.id === item.msgId);
      if (msg) msg.status = (item.tries || 0) >= 3 ? 'failed' : 'queued';
      keep.push({ ...item, tries: (item.tries || 0) + 1 });
      console.warn('seam: outbox retry', e);
    }
  }
  state.outbox = keep;
  saveState();
  if (selected) renderThread();
  return keep.length;
}

/* --------------------------------------------------------------- messaging */

async function fetchBundle(mailbox) {
  const body = await api(`/api/seam/prekeys/${encodeURIComponent(mailbox)}`, { method: 'GET' });
  return body.bundle;
}

/** Accept a full invite link, an account ID, a bare mailbox, or a bundle. */
function parseInvite(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('paste an invite link or ID');
  if (/^usr_[0-9a-z]{8,32}$/i.test(raw)) return { kind: 'address', value: raw.toLowerCase() };
  if (/^[0-9a-f]{32}$/.test(raw)) return { kind: 'mailbox', value: raw };
  if (raw.startsWith('{')) return { kind: 'bundle', value: raw };
  try {
    const url = new URL(raw);
    const to = url.searchParams.get('to');
    if (to && /^usr_[0-9a-z]{8,32}$/i.test(to)) return { kind: 'address', value: to.toLowerCase() };
    const mailbox = url.searchParams.get('mailbox');
    if (mailbox && /^[0-9a-f]{32}$/.test(mailbox)) return { kind: 'mailbox', value: mailbox };
  } catch {
    /* not a URL */
  }
  throw new Error('That does not look like an invite. Paste the whole link.');
}

/** An account or device ID resolves to a mailbox; the bundle still comes from
 *  the prekey route, so one-time use is unchanged. */
async function resolveAddress(id) {
  const body = await api(`/api/seam/users/${encodeURIComponent(id)}`, { method: 'GET' });
  if (body.id && myUserId && body.id === myUserId) throw new Error('That is your own ID.');
  return body;
}

/** Best effort: learn the account behind a device that just messaged us. */
async function lookupPeerUser(peer) {
  if (!signedIn || !peer) return;
  const c = contact(peer);
  if (c.userId) return;
  try {
    const body = await api(`/api/seam/users/${encodeURIComponent(peer)}`, { method: 'GET' });
    if (body && body.id) {
      c.userId = body.id;
      saveState();
      renderThreads();
      if (selected === peer) renderThread();
    }
  } catch {
    /* an address is a convenience, never a requirement */
  }
}

async function startPeer(input) {
  const parsed = parseInvite(input);

  let bundle;
  let accountId = null;
  if (parsed.kind === 'mailbox') {
    bundle = await fetchBundle(parsed.value);
  } else if (parsed.kind === 'address') {
    const resolved = await resolveAddress(parsed.value);
    accountId = resolved.id;
    bundle = await fetchBundle(resolved.mailbox);
  } else {
    try {
      bundle = JSON.parse(parsed.value);
    } catch {
      throw new Error('That invite could not be read.');
    }
  }

  const peer = bundle.id;
  if (!peer) throw new Error('That invite is missing its identity.');
  if (peer === identity.id()) throw new Error('That is your own invite.');

  if (!live.has(peer)) {
    const session = WasmSession.initiate(identity, JSON.stringify(bundle), now());
    live.set(peer, session);
    state.sessions[peer] = session.snapshot();
  }

  const c = contact(peer);
  if (bundle.x) c.x = bundle.x;
  if (accountId) c.userId = accountId;
  c.firstSeen = c.firstSeen || now();
  c.lastSeen = now();
  thread(peer);
  selected = peer;
  saveState();
  enterChat(peer);
  setStatus('Channel open. Say hello.', 'ok');
  return peer;
}

async function sendMessage(text) {
  const body = String(text || '').trim();
  if (!body) return;
  if (!selected) throw new Error('open a channel first');
  if (!live.has(selected)) {
    throw new Error('Ask them to send a message first.');
  }
  if (!signedIn) throw new Error('sign in to send');

  const at = now();
  const session = live.get(selected);
  const envelope = session.encrypt(body, at);

  const t = thread(selected);
  const msg = { id: uid(), dir: 'out', body, at, status: 'queued' };
  t.messages.push(msg);
  if (t.messages.length > 500) t.messages = t.messages.slice(-500);

  state.outbox = state.outbox || [];
  state.outbox.push({ id: uid(), msgId: msg.id, peer: selected, envelope, at, tries: 0 });
  state.sessions[selected] = session.snapshot();
  saveState();

  $('seamBody').value = '';
  renderThread();
  renderThreads();

  const pending = await flushOutbox();
  setConn(pending ? 'queued' : 'online', pending ? `${pending} queued` : 'Online');
  if (pending) setStatus('Queued. It will retry.', '');
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
      append(peer, 'in', body, now());
      lookupPeerUser(peer);
      return { ack: true };
    } catch (e) {
      return {
        ack: true,
        note: `A message could not be opened. If this is a new start, reset the channel and ask them to resend.`,
      };
    }
  }

  const session = WasmSession.accept(identity, prekeys, envelopeB64);
  live.set(peer, session);
  state.sessions[peer] = session.snapshot();
  state.prekeys = prekeys.snapshot();

  const c = contact(peer);
  if (info.ik) c.x = info.ik; // the init carries the sender's public agreement key
  c.firstSeen = c.firstSeen || now();
  c.lastSeen = now();

  const first = session.first_body();
  append(peer, 'in', first, now());
  lookupPeerUser(peer);
  return { ack: true };
}

async function processCapsule(envelopeB64) {
  let info = null;
  try {
    const peek = seam_peek_init(envelopeB64);
    info = peek ? JSON.parse(peek) : null;
  } catch (e) {
    return { ack: true, note: `A message could not be read (${plainError(e)}).` };
  }

  if (info && info.peer_id) return acceptFirst(envelopeB64, info);

  let lastRefusal = null;
  for (const [peer, session] of live) {
    try {
      const body = session.decrypt(envelopeB64);
      state.sessions[peer] = session.snapshot();
      append(peer, 'in', body, now());
      return { ack: true };
    } catch (e) {
      lastRefusal = String(e && e.message ? e.message : e);
    }
  }
  return {
    ack: true,
    note: lastRefusal
      ? 'A message could not be opened. Ask them to reset the channel and resend.'
      : 'A message arrived that no channel could open.',
  };
}

async function poll({ manual = false } = {}) {
  if (!state || polling || otherTab) return;
  if (!signedIn) {
    setConn('idle', 'Sign in to sync');
    return;
  }
  polling = true;
  try {
    // A new day needs a mailbox we own before there is anything to read.
    if (state.publishedDay !== Math.floor(now() / DAY)) {
      try {
        await publishPrekeys();
      } catch {
        /* read whatever we already own */
      }
    }

    const pending = await flushOutbox();
    let received = 0;

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
          received += 1;
        } catch (e) {
          setStatus(plainError(e), 'error');
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

    prune();
    setConn(pending ? 'queued' : 'online', pending ? `${pending} queued` : 'Online');
    renderBar();
    renderThreads();
    renderThread();

    if (received && document.hidden) {
      // A tab in the background cannot notify; the badge waits on return.
    }

    if (manual) setStatus(received ? 'Up to date.' : 'Nothing new.', 'ok');
  } catch (e) {
    setConn('offline', 'Offline');
    if (manual) fail(e);
  } finally {
    polling = false;
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => poll(), POLL_MS);
  poll();
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

/* ------------------------------------------------------------------- render */

function setPanel(name) {
  const app = $('seamApp');
  if (!app) return;
  app.dataset.seamState = name;
  for (const panel of qsa('[data-panel]', app)) {
    panel.hidden = panel.dataset.panel !== name;
  }
  $('seamBar').hidden = !(name === 'home' || name === 'chat');
}

function renderBar() {
  if (!state || !identity) return;
  const fp = identity.fingerprint();
  $('seamAvatar').textContent = fp.slice(0, 1).toUpperCase();
  const id = $('seamMyFp');
  id.textContent = myUserId ? shortId(myUserId) : fp.slice(0, 9);
  id.title = myUserId || fp;
  $('seamReadyPill').hidden = false;
}

function renderHome() {
  if (!state || !identity) return;
  const link = myUserId
    ? `${location.origin}/seam?to=${myUserId}`
    : `${location.origin}/seam?mailbox=${todayMailbox()}`;
  $('seamInvite').value = link;
  $('seamFingerprint').textContent = identity.fingerprint();
  $('seamId').textContent = identity.id();
  $('seamMyId').textContent = myUserId || 'sign in to publish an address';
  $('seamMailbox').textContent = todayMailbox();
  $('seamPrekeys').textContent = String(prekeys.remaining());
  $('seamPublished').textContent = state.publishedDay
    ? new Date(state.publishedDay * DAY * 1000).toISOString().slice(0, 10)
    : 'not yet';
  renderQr(link);
}

function renderQr(text) {
  const img = $('seamQr');
  if (!img) return;
  const draw = () => {
    if (window.SpimQR) {
      window.SpimQR.render(img, text).catch(() => {
        img.alt = 'QR code unavailable; use the link';
      });
    }
  };
  if (window.SpimQR) draw();
  else window.addEventListener('load', draw, { once: true });
}

function renderThreads() {
  if (!state) return;
  const list = $('seamThreads');
  if (!list) return;
  list.innerHTML = '';
  const peers = Object.keys(state.threads || {}).sort((a, b) => lastAt(b) - lastAt(a));

  if (peers.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'seam-thread-empty';
    empty.textContent = 'No channels yet. Open one with an invite.';
    list.appendChild(empty);
    return;
  }

  for (const peer of peers) {
    const t = state.threads[peer];
    const c = contact(peer);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'seam-thread' + (peer === selected ? ' is-active' : '');
    button.dataset.peer = peer;

    const name = document.createElement('span');
    name.className = 'seam-thread-name';
    if (c.verified) {
      const tick = document.createElement('i');
      tick.className = 'seam-tick';
      tick.title = 'Safety code verified';
      name.appendChild(tick);
    }
    name.appendChild(document.createTextNode(aliasOf(peer)));

    const time = document.createElement('span');
    time.className = 'seam-thread-time';
    time.textContent = lastAt(peer) ? shortTime(lastAt(peer)) : '';

    const preview = document.createElement('span');
    preview.className = 'seam-thread-preview';
    const last = t.messages[t.messages.length - 1];
    preview.textContent = last
      ? (last.dir === 'out' ? 'You: ' : '') + last.body.replace(/\s+/g, ' ').slice(0, 48)
      : 'No messages yet';

    button.append(name, time, preview);

    if (t.unread) {
      const badge = document.createElement('span');
      badge.className = 'seam-thread-unread';
      badge.textContent = String(t.unread);
      button.appendChild(badge);
    }

    button.addEventListener('click', () => enterChat(peer));
    list.appendChild(button);
  }
}

function shortTime(at) {
  const d = new Date(at * 1000);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function renderThread() {
  if (!state) return;
  const peer = selected;
  const box = $('seamMessages');
  const compose = $('seamCompose');
  if (!box) return;

  if (!peer) {
    $('seamAlias').textContent = 'Channel';
    $('seamThreadSub').textContent = '—';
    box.innerHTML = '';
    compose.hidden = true;
    return;
  }

  const c = contact(peer);
  $('seamAlias').textContent = aliasOf(peer);
  const trust = c.verified ? 'Verified' : 'Unverified';
  $('seamThreadSub').textContent = c.userId
    ? `${c.userId} · ${trust}`
    : `${trust} · compare the safety code`;
  $('seamThreadSub').title = c.userId || '';

  const t = thread(peer);
  box.innerHTML = '';

  if (t.messages.length === 0) {
    const waiting = document.createElement('p');
    waiting.className = 'seam-waiting';
    waiting.textContent = live.has(peer)
      ? 'Channel ready. Say hello.'
      : 'Waiting for their first message.';
    box.appendChild(waiting);
  } else {
    for (const msg of t.messages) {
      const row = document.createElement('div');
      row.className = 'seam-message seam-message--' + msg.dir;

      const text = document.createElement('p');
      text.textContent = msg.body;

      const foot = document.createElement('div');
      foot.className = 'seam-message-foot';
      const when = document.createElement('time');
      when.textContent = shortTime(msg.at);
      foot.appendChild(when);

      if (msg.dir === 'out') {
        const status = document.createElement('span');
        status.className = 'seam-message-status';
        status.dataset.status = msg.status;
        status.textContent =
          msg.status === 'sent' ? 'Sent' : msg.status === 'failed' ? 'Not sent · retrying' : 'Sending…';
        foot.appendChild(status);
      }

      row.append(text, foot);
      box.appendChild(row);
    }
  }

  compose.hidden = false;
  box.scrollTop = box.scrollHeight;
}

function renderAll() {
  renderBar();
  renderHome();
  renderThreads();
  renderThread();
}

/* ---------------------------------------------------------------- surfaces */

function enterHome() {
  setPanel('home');
  $('seamBackToChat').hidden = Object.keys(state.threads || {}).length === 0;
  renderAll();
}

function enterChat(peer) {
  if (!state) return;
  if (!peer) {
    enterHome();
    return;
  }
  selected = peer;
  thread(peer).unread = 0;
  saveState();
  setPanel('chat');
  $('seamApp').dataset.mobile = 'thread';
  renderAll();
  fitChat();
  $('seamBody').focus();
}

function backToList() {
  $('seamApp').dataset.mobile = 'list';
}

/** Size the chat to the space actually left on screen, so the compose row
 *  never falls below the fold. CSS keeps a sane fallback before this runs. */
function fitChat() {
  const chat = document.querySelector('.seam-chat');
  if (!chat || !chat.offsetParent) return;
  const top = chat.getBoundingClientRect().top;
  const room = Math.floor(window.innerHeight - top - 12);
  chat.style.height = Math.max(420, room) + 'px';
}

function safetyCode(peer) {
  const c = state.contacts && state.contacts[peer];
  if (!c || !c.x) return null;
  const mine = identity.id() + ':' + identity.x_pub_b64();
  const theirs = peer + ':' + c.x;
  const digest = blake3_hex_static([mine, theirs].sort().join('|')).slice(0, 8);
  return digest.slice(0, 4) + ' ' + digest.slice(4);
}

/* --------------------------------------------------------------------- boot */

function wire() {
  $('seamCreateBtn').addEventListener('click', async () => {
    const button = $('seamCreateBtn');
    try {
      const pass = $('seamPass').value;
      if (pass.length < 12) throw new Error('Use a passphrase of at least 12 characters.');
      if (localStorage.getItem(STATE_KEY) && !confirm('Replace the existing channel on this device?')) return;
      button.disabled = true;
      button.textContent = 'Creating…';
      await createIdentity(pass);
    } catch (e) {
      fail(e);
    } finally {
      button.disabled = false;
      button.textContent = 'Create channel';
    }
  });

  $('seamUnlockBtn').addEventListener('click', async () => {
    const button = $('seamUnlockBtn');
    try {
      button.disabled = true;
      button.textContent = 'Opening…';
      await unlock($('seamPassUnlock').value);
    } catch (e) {
      fail(e);
    } finally {
      button.disabled = false;
      button.textContent = 'Unlock';
    }
  });

  $('seamForgetBtn').addEventListener('click', () => {
    if (!confirm('Remove the sealed channel from this device? The passphrase cannot recover it afterwards.')) return;
    localStorage.removeItem(STATE_KEY);
    localStorage.removeItem(SALT_KEY);
    location.reload();
  });

  $('seamPublishBtn').addEventListener('click', async () => {
    try {
      setStatus('Renewing the invite…');
      const result = await publishPrekeys({ replenish: true });
      setStatus(result.stored ? 'Invite renewed.' : 'Invite is already fresh.', 'ok');
      renderHome();
    } catch (e) {
      fail(e);
    }
  });

  $('seamCopyInvite').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('seamInvite').value);
      setStatus('Invite copied.', 'ok');
    } catch {
      $('seamInvite').select();
      setStatus('Select and copy the invite link.', '');
    }
  });

  $('seamNewInvite').addEventListener('click', async () => {
    try {
      setStatus('Refreshing the invite…');
      await publishPrekeys({ replenish: true });
      renderHome();
      setStatus('Invite refreshed.', 'ok');
    } catch (e) {
      fail(e);
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

  $('seamPeer').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('seamPeerStartBtn').click();
    }
  });

  $('seamCompose').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await sendMessage($('seamBody').value);
    } catch (e) {
      fail(e);
    }
  });

  $('seamBody').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('seamCompose').requestSubmit();
    }
  });

  $('seamRefreshBtn').addEventListener('click', () => poll({ manual: true }));

  $('seamLockBtn').addEventListener('click', () => {
    if (!confirm('Lock this device? You will need the passphrase to reopen the channel.')) return;
    stopPolling();
    location.reload();
  });

  $('seamDetailsBtn').addEventListener('click', () => {
    enterHome();
    $('seamDetailsBox').open = true;
    $('seamDetailsBox').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });

  $('seamCopyId').addEventListener('click', async () => {
    if (!myUserId) {
      setStatus('Sign in to get an ID you can share.', 'error');
      return;
    }
    try {
      await navigator.clipboard.writeText(myUserId);
      setStatus('Your ID is copied.', 'ok');
    } catch {
      setStatus('Your ID is ' + myUserId, '');
    }
  });

  // A menu that stays open after a choice feels stuck.
  for (const menu of [$('seamMenu'), $('seamThreadMenu')]) {
    if (!menu) continue;
    menu.addEventListener('click', (e) => {
      if (e.target.closest('button')) menu.open = false;
    });
    menu.addEventListener('toggle', () => {
      if (!menu.open) return;
      for (const other of [$('seamMenu'), $('seamThreadMenu')]) {
        if (other && other !== menu) other.open = false;
      }
    });
  }

  $('seamNewBtn').addEventListener('click', enterHome);
  $('seamBackToChat').addEventListener('click', () => enterChat(selected || latestThread()));
  $('seamBackBtn').addEventListener('click', backToList);

  $('seamAlias').addEventListener('click', startRename);

  $('seamVerifyBtn').addEventListener('click', () => {
    if (!selected) return;
    const code = safetyCode(selected);
    $('seamSafety').textContent = code || 'unavailable';
    $('seamVerifyRow').hidden = false;
    $('seamThreadMenu').open = false;
  });

  $('seamVerifyDone').addEventListener('click', () => {
    if (!selected) return;
    contact(selected).verified = true;
    saveState();
    $('seamVerifyRow').hidden = true;
    renderThreads();
    renderThread();
    setStatus('Safety code marked as matched on this device.', 'ok');
  });

  $('seamBurnBtn').addEventListener('click', () => {
    if (!selected) return;
    const current = state.settings.autoClear || 0;
    const next = AUTO_CLEAR[(AUTO_CLEAR.indexOf(current) + 1) % AUTO_CLEAR.length];
    state.settings.autoClear = next;
    saveState();
    $('seamBurnBtn').textContent = 'Auto-clear: ' + AUTO_CLEAR_LABEL[next];
    $('seamThreadMenu').open = false;
    prune();
    renderThread();
    setStatus(
      next ? `This device clears messages after ${AUTO_CLEAR_LABEL[next]}.` : 'Auto-clear is off.',
      'ok'
    );
  });

  $('seamClearBtn').addEventListener('click', () => {
    if (!selected) return;
    if (!confirm('Clear this chat on this device? The other person keeps their copy.')) return;
    thread(selected).messages = [];
    saveState();
    renderThreads();
    renderThread();
    setStatus('Chat cleared on this device.', 'ok');
  });

  $('seamResetBtn').addEventListener('click', () => {
    if (!selected) return;
    if (!confirm('Reset this channel? History stays; their next message starts fresh.')) return;
    live.delete(selected);
    delete state.sessions[selected];
    saveState();
    setStatus('Channel reset. Their next message starts fresh.', 'ok');
    renderThread();
  });

  // A second tab writing the sealed state would fork the ratchet. Stop here.
  window.addEventListener('storage', (e) => {
    if (e.key !== STATE_KEY || !e.newValue) return;
    otherTab = true;
    stopPolling();
    setConn('offline', 'Paused');
    setStatus('This channel is open in another tab. Reload here to continue.', 'error');
  });

  window.addEventListener('visibilitychange', () => {
    if (document.hidden || otherTab) return;
    if (!signedIn) checkAuth().catch(() => {});
    else poll();
  });

  window.addEventListener('resize', fitChat);
}

function startRename() {
  if (!selected) return;
  const button = $('seamAlias');
  const c = contact(selected);
  const input = document.createElement('input');
  input.className = 'spim-input';
  input.style.cssText = 'height:32px;padding:4px 8px;font-size:14px;max-width:240px';
  input.value = c.alias || '';
  input.placeholder = 'Channel name';
  input.setAttribute('aria-label', 'Channel name');
  button.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    if (save) {
      c.alias = input.value.trim().slice(0, 40) || null;
      saveState();
    }
    input.replaceWith(button);
    renderThreads();
    renderThread();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
}

async function createIdentity(passphrase) {
  const salt = b64(randomBytes(16));
  localStorage.setItem(SALT_KEY, salt);
  deviceKey = await deriveDeviceKey(passphrase, salt);

  identity = new WasmIdentity();
  const at = now();
  const generated = JSON.parse(seam_generate_prekeys(identity, PREKEYS_PER_PUBLISH, at, PREKEY_TTL));
  prekeys = WasmPreKeyStore.restore(generated.store);

  state = {
    v: 2,
    identity: identity.to_secret_json(),
    prekeys: prekeys.snapshot(),
    sessions: {},
    threads: {},
    outbox: [],
    peerMailboxes: {},
    contacts: {},
    settings: { autoClear: 0 },
    pendingBundles: generated.bundles,
    publishedDay: 0,
  };
  saveState();
  await checkAuth();

  try {
    await publishPrekeys();
    setStatus('Channel created. Invite one person to begin.', 'ok');
  } catch (e) {
    setStatus(`Channel created. ${plainError(e)}`, 'error');
  }

  renderAll();
  enterHome();
  startPolling();

  const to = inviteTarget();
  if (to) {
    $('seamPeer').value = to;
    $('seamPeer').focus();
  }
}

async function unlock(passphrase) {
  if (!passphrase) throw new Error('Enter your passphrase.');
  const sealed = localStorage.getItem(STATE_KEY);
  if (!sealed) throw new Error('No channel on this device.');
  const salt = localStorage.getItem(SALT_KEY);
  if (!salt) throw new Error('This device key is missing. The channel cannot be opened.');

  deviceKey = await deriveDeviceKey(passphrase, salt);
  const plain = seam_open(deviceKey, STATE_AAD, sealed);
  state = migrate(JSON.parse(plain));

  identity = WasmIdentity.from_secret_json(state.identity);
  prekeys = WasmPreKeyStore.restore(state.prekeys);
  restoreSessions();
  prune();

  selected = latestThread();
  renderAll();
  setPanel(selected ? 'chat' : 'home');
  $('seamApp').dataset.mobile = selected ? 'thread' : 'list';
  if (!selected) enterHome();
  else fitChat();

  await checkAuth();
  if (signedIn) {
    try {
      if (!state.publishedDay || state.publishedDay !== Math.floor(now() / DAY)) {
        await publishPrekeys();
      }
    } catch (e) {
      setStatus(plainError(e), 'error');
    }
  }
  startPolling();

  const to = inviteTarget();
  if (to) {
    enterHome();
    $('seamPeer').value = to;
    $('seamPeer').focus();
  }
}

/** Keep an invite alive across sign-in: every account link returns here. */
function carryReturnPath() {
  const here = location.pathname + location.search;
  for (const a of document.querySelectorAll('a[href="/login"], a[href="/create-account"]')) {
    a.href = a.getAttribute('href') + '?next=' + encodeURIComponent(here);
  }
}

async function boot() {
  wire();
  carryReturnPath();
  $('seamCreateBtn').disabled = true;
  $('seamUnlockBtn').disabled = true;

  const sealed = localStorage.getItem(STATE_KEY);
  setPanel(sealed ? 'locked' : 'create');

  try {
    await init();
  } catch (e) {
    setStatus('The app did not load. ' + plainError(e), 'error');
    return;
  }
  $('seamUnlockBtn').disabled = false;

  await checkAuth();
  $('seamCreateBtn').disabled = !signedIn;
  setPanel(sealed ? 'locked' : 'create');

  if (sealed) {
    setStatus('Enter your passphrase to open the channel.', '');
    $('seamPassUnlock').focus();
  } else {
    setStatus('', '');
    $('seamPass').focus();
  }
}

boot().catch(fail);
