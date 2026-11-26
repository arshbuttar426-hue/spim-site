'use strict';
/*
 * Seam browser test — two real browser contexts, one local relay.
 *
 *   node tools/seam-browser-test.mjs
 *
 * The server below is not a mock of Seam: it imports the exact Pages Functions
 * that deploy (`functions/api/seam/*`) and gives them an in-memory KV. Only auth
 * is stubbed, by minting the same signed session cookie the site uses.
 *
 * Proves the product path a person actually walks:
 *   create identity -> publish prekeys -> invite -> first handshake ->
 *   ratcheted reply -> reload/unlock -> replay refused without duplicating.
 *
 * Playwright is resolved from PLAYWRIGHT_MODULE, a local install, or the npx
 * cache, so this stays runnable without adding a dependency to the site.
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const SECRET = 'seam-browser-test-secret';

/* ------------------------------------------------------------------ relay */

class MockKV {
  constructor() {
    this.map = new Map();
  }
  async get(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  async put(key, value) {
    this.map.set(key, value);
  }
  async delete(key) {
    this.map.delete(key);
  }
  async list({ prefix = '', limit = 1000 } = {}) {
    const keys = [...this.map.keys()]
      .filter((k) => k.startsWith(prefix))
      .slice(0, limit)
      .map((name) => ({ name }));
    return { keys, list_complete: true };
  }
}

const env = { SPIM_KV: new MockKV(), SPIM_AUTH_SECRET: SECRET };

const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);
const lib = await load('functions/api/_lib.js');
const publishPrekeys = await load('functions/api/seam/prekeys.js');
const fetchPrekey = await load('functions/api/seam/prekeys/[id].js');
const lookupUser = await load('functions/api/seam/users/[id].js');
const postEnvelope = await load('functions/api/seam/envelopes.js');
const drainMailbox = await load('functions/api/seam/envelopes/[id].js');
const ackMailbox = await load('functions/api/seam/envelopes/[id]/ack.js');

const posted = [];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  let full = path.join(root, rel);
  if (!full.startsWith(root)) return send(res, 403, {}, 'forbidden');
  if (!fs.existsSync(full) && fs.existsSync(full + '.html')) full += '.html';
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    return send(res, 404, { 'content-type': 'text/plain' }, 'not found');
  }
  const type = MIME[path.extname(full)] || 'application/octet-stream';
  return send(res, 200, { 'content-type': type, 'cache-control': 'no-store' }, fs.readFileSync(full));
}

async function toRequest(req, url) {
  const headers = new Headers();
  for (const name of ['cookie', 'content-type', 'origin', 'user-agent', 'cf-connecting-ip']) {
    if (req.headers[name]) headers.set(name, req.headers[name]);
  }
  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = Buffer.concat(chunks);
  }
  return { request: new Request(url, { method: req.method, headers, body }), raw: body };
}

async function route(req, res, url) {
  const pathname = url.pathname;
  const p = url.pathname;
  if (process.env.SEAM_TEST_LOG && p.startsWith('/api/')) {
    console.log(`     ${req.method} ${p}`);
  }

  if (p === '/api/auth/me') {
    const user = { id: req.spimUser.id, email: req.spimUser.email };
    return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify({ user }));
  }

  // Test-only inspection of the relay's real KV.
  if (p === '/test/posted') {
    const mailbox = url.searchParams.get('mailbox');
    const list = posted.filter((e) => !mailbox || e.mailbox === mailbox);
    return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify(list));
  }
  if (p === '/test/queue') {
    const mailbox = url.searchParams.get('mailbox');
    const page = await env.SPIM_KV.list({ prefix: `seam:env:${mailbox}:`, limit: 500 });
    return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify({ count: page.keys.length }));
  }

  const { request, raw } = await toRequest(req, url);
  let response = null;
  let m;

  if ((m = p.match(/^\/api\/seam\/users\/([^/]+)$/)) && req.method === 'GET') {
    response = await lookupUser.onRequestGet({ request, env, params: { id: m[1] } });
  } else if (p === '/api/seam/prekeys' && req.method === 'POST') {
    response = await publishPrekeys.onRequestPost({ request, env });
  } else if ((m = p.match(/^\/api\/seam\/prekeys\/([^/]+)$/)) && req.method === 'GET') {
    response = await fetchPrekey.onRequestGet({ request, env, params: { id: m[1] } });
  } else if (p === '/api/seam/envelopes' && req.method === 'POST') {
    response = await postEnvelope.onRequestPost({ request, env });
  } else if ((m = p.match(/^\/api\/seam\/envelopes\/([^/]+)\/ack$/)) && req.method === 'POST') {
    response = await ackMailbox.onRequestPost({ request, env, params: { id: m[1] } });
  } else if ((m = p.match(/^\/api\/seam\/envelopes\/([^/]+)$/)) && req.method === 'GET') {
    response = await drainMailbox.onRequestGet({ request, env, params: { id: m[1] } });
  }

  if (response) {
    if (p === '/api/seam/envelopes' && req.method === 'POST' && raw) {
      try {
        const body = JSON.parse(raw.toString('utf8'));
        // Record the real relay verdict, not just that a POST happened.
        posted.push({ mailbox: body.mailbox, envelope: body.envelope, status: response.status });
      } catch {
        // A malformed body is refused by the function; nothing useful to record.
      }
    }
    if (process.env.SEAM_TEST_LOG) {
      console.log(`     ${req.method} ${p} -> ${response.status}`);
    }
    const headers = Object.fromEntries(response.headers);
    return send(res, response.status, headers, Buffer.from(await response.arrayBuffer()));
  }

  if (p.startsWith('/api/')) return send(res, 404, { 'content-type': 'application/json' }, '{"error":"not found"}');
  return serveStatic(req, res, pathname);
}

async function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    // Each browser context carries its own signed session cookie; decode it the
    // same way the site does so /api/auth/me can answer per context.
    lib
      .currentUser(new Request(url.href, { headers: { cookie: req.headers.cookie || '' } }), env)
      .then((user) => {
        req.spimUser = user || { id: 'anonymous', email: null };
        return route(req, res, url);
      })
      .catch((e) => {
        if (process.env.SEAM_TEST_LOG) {
          console.log(`     handler error: ${e && e.stack ? e.stack : e}`);
        }
        send(res, 500, { 'content-type': 'text/plain' }, String(e && e.stack ? e.stack : e));
      });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

/* -------------------------------------------------------------- playwright */

async function loadPlaywright() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_MODULE) candidates.push(process.env.PLAYWRIGHT_MODULE);
  candidates.push('playwright');
  const npx = path.join(os.homedir(), '.npm', '_npx');
  if (fs.existsSync(npx)) {
    for (const dir of fs.readdirSync(npx)) {
      const entry = path.join(npx, dir, 'node_modules', 'playwright', 'index.js');
      if (fs.existsSync(entry)) candidates.push(pathToFileURL(entry).href);
    }
  }
  for (const spec of candidates) {
    try {
      return await import(spec);
    } catch {
      // Try the next location.
    }
  }
  throw new Error('playwright not found; set PLAYWRIGHT_MODULE to its index.js');
}

/* ------------------------------------------------------------------- test */

const server = await startServer();
const base = `http://127.0.0.1:${server.address().port}`;
const playwright = await loadPlaywright();
const { chromium } = playwright.default || playwright;
const browser = await chromium.launch();

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`ok   ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`FAIL ${name}: ${e && e.message ? e.message : e}`);
    for (const [label, page] of [['A', a], ['B', b]]) {
      try {
        if (page) {
          console.log(`     ${label} status: ${await statusText(page)}`);
          const cards = await page.evaluate(() => ({
            state: document.getElementById('seamApp')?.dataset.seamState,
            panels: [...document.querySelectorAll('[data-panel]')]
              .filter((el) => !el.hidden)
              .map((el) => el.dataset.panel),
          }));
          console.log(`     ${label} cards: ${JSON.stringify(cards)}`);
        }
      } catch {
        // A closed page has nothing to report.
      }
    }
    if (mailboxA) {
      try {
        const q = await (await fetch(`${base}/test/queue?mailbox=${mailboxA}`)).json();
        const seen = await (await fetch(`${base}/test/posted?mailbox=${mailboxA}`)).json();
        console.log(`     A queue=${q.count} posted=${seen.length}`);
      } catch {
        // Diagnostics must never mask the real failure.
      }
    }
  }
}

async function contextFor(user) {
  const context = await browser.newContext({ baseURL: base });
  const { token } = await lib.signSession(user, SECRET);
  await context.addCookies([{ name: 'spim_session', value: token, url: base }]);
  return context;
}

const statusText = (page) => page.$eval('#seamStatus', (el) => el.textContent || '');
const visible = (page, sel) => page.$eval(sel, (el) => !el.hidden && el.offsetParent !== null);
const panel = (page, name) =>
  page.$eval(`[data-panel="${name}"]`, (el) => !el.hidden && el.offsetParent !== null);

/** "Check now" lives inside a collapsed menu in the current UI. */
async function refresh(page) {
  await page.evaluate(() => {
    document.getElementById('seamMenu').open = true;
  });
  await page.click('#seamRefreshBtn');
}

async function createIdentity(page, passphrase) {
  await page.goto('/seam.html');
  await page.waitForFunction(() => !document.getElementById('seamCreateBtn').disabled, null, {
    timeout: 30_000,
  });
  await page.fill('#seamPass', passphrase);
  await page.click('#seamCreateBtn');
  await page.waitForFunction(
    () => /Channel created/.test(document.getElementById('seamStatus').textContent || ''),
    null,
    { polling: 100, timeout: 30_000 }
  );
}

async function waitForText(page, text, timeout = 20_000, selector = '.seam-message') {
  await page.waitForFunction(
    (args) =>
      [...document.querySelectorAll(args.selector)].some((m) =>
        (m.textContent || '').includes(args.text)
      ),
    { text, selector },
    { polling: 100, timeout }
  );
}

// Real account ids match functions/api/seam/users/[id].js:ADDRESS_RE.
const ctxA = await contextFor({ id: 'usr_aaaaaaaa01', email: 'a@example.test' });
const ctxB = await contextFor({ id: 'usr_bbbbbbbb01', email: 'b@example.test' });
const a = await ctxA.newPage();
const b = await ctxB.newPage();
if (process.env.SEAM_TEST_LOG) {
  a.on('console', (m) => console.log(`     [A console] ${m.text()}`));
  b.on('console', (m) => console.log(`     [B console] ${m.text()}`));
}

let mailboxA = '';
let inviteA = '';
let passA = 'correct horse battery staple';

await check('A creates an identity and publishes prekeys', async () => {
  await createIdentity(a, passA);
  assert.equal(await panel(a, 'home'), true);
  mailboxA = (await a.textContent('#seamMailbox')).trim();
  assert.match(mailboxA, /^[0-9a-f]{32}$/);
  const published = (await a.textContent('#seamPublished')).trim();
  assert.notEqual(published, 'not yet');
  const invite = await a.inputValue('#seamInvite');
  assert.match(invite, /\/seam\?to=usr_[0-9a-z]{8,32}$/);
  inviteA = invite;
});

let mailboxB = '';
await check('B creates an identity from A’s invite', async () => {
  await createIdentity(b, 'another long passphrase here');
  mailboxB = (await b.textContent('#seamMailbox')).trim();
  assert.match(mailboxB, /^[0-9a-f]{32}$/);
  assert.notEqual(mailboxA, mailboxB);
});

const relayPosted = async (mailbox) => (await (await fetch(`${base}/test/posted?mailbox=${mailbox}`)).json());

await check('B opens the conversation and the first capsule carries the handshake', async () => {
  const beforeRelay = (await relayPosted(mailboxA)).length;
  await b.fill('#seamPeer', inviteA);
  await b.click('#seamPeerStartBtn');
  await b.waitForFunction(
    () => /Channel open/.test(document.getElementById('seamStatus').textContent || ''),
    null,
    { polling: 100, timeout: 15_000 }
  );
  await b.fill('#seamBody', 'hello from B');
  await b.click('#seamSendBtn');
  await waitForText(b, 'hello from B', 15_000, '.seam-message--out');
  const delivered = (await relayPosted(mailboxA)).slice(beforeRelay);
  assert.ok(delivered.length > 0, 'relay must receive the sent capsule');
  assert.ok(delivered.some((e) => e.status === 201), 'relay must accept the sent capsule');
  assert.equal((await b.textContent('#seamPrekeys')).trim(), '16');
});

await check('A accepts the handshake and reads the first message', async () => {
  await refresh(a);
  await waitForText(a, 'hello from B');
  assert.equal(await panel(a, 'chat'), true);
});

await check('A replies across the ratchet', async () => {
  const beforeRelay = (await relayPosted(mailboxB)).length;
  await a.click('.seam-thread');
  await a.fill('#seamBody', 'hello from A');
  await a.click('#seamSendBtn');
  await waitForText(a, 'hello from A', 15_000, '.seam-message--out');
  const delivered = (await relayPosted(mailboxB)).slice(beforeRelay);
  assert.ok(delivered.length > 0, 'relay must receive A’s reply');
  assert.ok(delivered.some((e) => e.status === 201), 'relay must accept A’s reply');
});

await check('B reads the reply', async () => {
  await refresh(b);
  await waitForText(b, 'hello from A');
});

await check('a wrong passphrase cannot open the sealed state', async () => {
  await a.reload();
  await a.waitForFunction(() => !document.getElementById('seamUnlockBtn').disabled, null, {
    timeout: 30_000,
  });
  await a.fill('#seamPassUnlock', 'definitely the wrong passphrase');
  await a.click('#seamUnlockBtn');
  await a.waitForFunction(
    () => /doesn't open this device/.test(document.getElementById('seamStatus').textContent || ''),
    null,
    { polling: 100, timeout: 20_000 }
  );
  assert.equal(await panel(a, 'locked'), true);
});

await check('the right passphrase restores history and the session', async () => {
  await a.fill('#seamPassUnlock', passA);
  await a.click('#seamUnlockBtn');
  await a.waitForFunction(
    () => ['home', 'chat'].includes(document.getElementById('seamApp').dataset.seamState),
    null,
    { timeout: 30_000 }
  );
  await waitForText(a, 'hello from B');
  await waitForText(a, 'hello from A');
});

await check('a replayed capsule is refused and does not duplicate', async () => {
  const before = await a.$$eval('.seam-message', (els) => els.length);
  const seen = await (await fetch(`${base}/test/posted?mailbox=${mailboxA}`)).json();
  assert.ok(seen.some((e) => e.status === 201), 'relay recorded A’s inbound capsule');
  const replaySeen = seen.find((e) => e.status === 201) || seen[0];
  const replay = { mailbox: replaySeen.mailbox, envelope: replaySeen.envelope };

  const status = await a.evaluate(async (item) => {
    const res = await fetch('/api/seam/envelopes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(item),
    });
    return res.status;
  }, replay);
  assert.equal(status, 201);

  // Do not refresh: a manual refresh overwrites the refusal note. The normal
  // poll must surface the client's direct replay-refusal status.
  await a.waitForFunction(
    () => /could not be opened/.test(document.getElementById('seamStatus').textContent || ''),
    null,
    { polling: 100, timeout: 20_000 }
  );
  const after = await a.$$eval('.seam-message', (els) => els.length);
  assert.equal(after, before, 'a refused replay must not append a message');

  const queue = await (await fetch(`${base}/test/queue?mailbox=${mailboxA}`)).json();
  assert.equal(queue.count, 0, 'a refused replay is acknowledged, not left to clog');
});

await check('a third ratchet step still flows after the refusal', async () => {
  const beforeRelay = (await relayPosted(mailboxB)).length;
  await a.fill('#seamBody', 'still here');
  await a.click('#seamSendBtn');
  const delivered = (await relayPosted(mailboxB)).slice(beforeRelay);
  assert.ok(delivered.length > 0, 'relay must receive the post-refusal message');
  assert.ok(delivered.some((e) => e.status === 201), 'relay must accept the post-refusal message');
  await refresh(b);
  await waitForText(b, 'still here');
});

await browser.close();
await new Promise((resolve) => server.close(resolve));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
