'use strict';
/*
 * Relay isolation test — runs the real Pages Functions against an in-memory KV.
 *
 *   node --experimental-default-type=module tools/seam-api-test.mjs
 *
 * Proves the relay's contract, not its cryptography: shape validation, one-time
 * prekey delivery, mailbox ownership, queue drain, and ack. The cryptographic
 * refusals are proven in the Rust and WASM harnesses.
 */

import assert from 'node:assert/strict';

import { signSession } from '../functions/api/_lib.js';
import { onRequestPost as publishPrekeys } from '../functions/api/seam/prekeys.js';
import { onRequestGet as fetchPrekey } from '../functions/api/seam/prekeys/[id].js';
import { onRequestPost as postEnvelope } from '../functions/api/seam/envelopes.js';
import { onRequestGet as drainMailbox } from '../functions/api/seam/envelopes/[id].js';
import { onRequestPost as ackMailbox } from '../functions/api/seam/envelopes/[id]/ack.js';

class MockKV {
  constructor() {
    this.map = new Map();
  }
  async get(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  async put(key, value, _opts) {
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

const SECRET = 'seam-test-secret';
const env = { SPIM_KV: new MockKV(), SPIM_AUTH_SECRET: SECRET };
const mailbox = '0123456789abcdef0123456789abcdef';
const other = 'fedcba9876543210fedcba9876543210';

const bundle = (n) => ({
  v: 1,
  id: 'a'.repeat(24),
  ed: Buffer.alloc(32, 1).toString('base64'),
  x: Buffer.alloc(32, 2).toString('base64'),
  spk: Buffer.alloc(32, 3).toString('base64'),
  spk_sig: Buffer.alloc(64, 4).toString('base64'),
  opk: [Buffer.alloc(32, 5 + n).toString('base64')],
  created_at: 1_800_000_000,
  expires_at: 1_800_086_400,
  sig: Buffer.alloc(64, 6).toString('base64'),
});

async function cookieFor(user) {
  const { token } = await signSession(user, SECRET);
  return `spim_session=${encodeURIComponent(token)}`;
}

const user1 = { id: 'user_one', email: 'one@example.test' };
const user2 = { id: 'user_two', email: 'two@example.test' };
const cookie1 = await cookieFor(user1);
const cookie2 = await cookieFor(user2);

function req(url, { method = 'GET', cookie = '', body } = {}) {
  const headers = { origin: 'http://localhost' };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return new Request(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

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
  }
}

await check('publish requires a session', async () => {
  const res = await publishPrekeys({
    request: req('http://localhost/api/seam/prekeys', {
      method: 'POST',
      body: { mailbox, bundles: [bundle(0)] },
    }),
    env,
  });
  assert.equal(res.status, 401);
});

await check('publish stores signed bundles', async () => {
  const res = await publishPrekeys({
    request: req('http://localhost/api/seam/prekeys', {
      method: 'POST',
      cookie: cookie1,
      body: { mailbox, bundles: [bundle(0), bundle(1)] },
    }),
    env,
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.stored, 2);
});

await check('publish rejects a malformed bundle', async () => {
  const res = await publishPrekeys({
    request: req('http://localhost/api/seam/prekeys', {
      method: 'POST',
      cookie: cookie1,
      body: { mailbox, bundles: [{ v: 1 }] },
    }),
    env,
  });
  assert.equal(res.status, 400);
});

await check('prekeys are delivered one at a time', async () => {
  const first = await fetchPrekey({
    request: req(`http://localhost/api/seam/prekeys/${mailbox}`),
    env,
    params: { id: mailbox },
  });
  assert.equal(first.status, 200);
  const one = await first.json();
  assert.equal(one.remaining, 1);
  assert.equal(one.bundle.opk[0], bundle(0).opk[0]);

  const second = await fetchPrekey({
    request: req(`http://localhost/api/seam/prekeys/${mailbox}`),
    env,
    params: { id: mailbox },
  });
  assert.equal(second.status, 200);
  const two = await second.json();
  assert.equal(two.remaining, 0);
  assert.equal(two.bundle.opk[0], bundle(1).opk[0]);

  const third = await fetchPrekey({
    request: req(`http://localhost/api/seam/prekeys/${mailbox}`),
    env,
    params: { id: mailbox },
  });
  assert.equal(third.status, 404);
});

await check('envelope post is anonymous but bounded', async () => {
  const envelope = Buffer.from('SMW1' + 'x'.repeat(64)).toString('base64');
  const res = await postEnvelope({
    request: req('http://localhost/api/seam/envelopes', {
      method: 'POST',
      body: { mailbox, envelope },
    }),
    env,
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.ok(body.id);
});

await check('envelope post rejects a non-SEAM body', async () => {
  const res = await postEnvelope({
    request: req('http://localhost/api/seam/envelopes', {
      method: 'POST',
      body: { mailbox, envelope: Buffer.from('not-a-capsule').toString('base64') },
    }),
    env,
  });
  assert.equal(res.status, 400);
});

await check('another account cannot drain the mailbox', async () => {
  const res = await drainMailbox({
    request: req(`http://localhost/api/seam/envelopes/${mailbox}`, { cookie: cookie2 }),
    env,
    params: { id: mailbox },
  });
  assert.equal(res.status, 403);
});

let pending = [];
await check('owner drains the mailbox', async () => {
  const res = await drainMailbox({
    request: req(`http://localhost/api/seam/envelopes/${mailbox}`, { cookie: cookie1 }),
    env,
    params: { id: mailbox },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.count, 1);
  assert.equal(body.messages[0].envelope.startsWith('U01XM'), true);
  pending = body.messages.map((m) => m.id);
});

await check('drain is non-destructive until ack', async () => {
  const res = await drainMailbox({
    request: req(`http://localhost/api/seam/envelopes/${mailbox}`, { cookie: cookie1 }),
    env,
    params: { id: mailbox },
  });
  const body = await res.json();
  assert.equal(body.count, 1);
});

await check('ack removes only the named ids', async () => {
  const res = await ackMailbox({
    request: req(`http://localhost/api/seam/envelopes/${mailbox}/ack`, {
      method: 'POST',
      cookie: cookie1,
      body: { ids: pending },
    }),
    env,
    params: { id: mailbox },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.removed, 1);
  assert.equal(body.remaining, 0);
});

await check('unknown mailbox is refused', async () => {
  const res = await drainMailbox({
    request: req(`http://localhost/api/seam/envelopes/${other}`, { cookie: cookie1 }),
    env,
    params: { id: other },
  });
  assert.equal(res.status, 403);
});

await check('bad mailbox shape is refused', async () => {
  const res = await fetchPrekey({
    request: req('http://localhost/api/seam/prekeys/not-a-mailbox'),
    env,
    params: { id: 'not-a-mailbox' },
  });
  assert.equal(res.status, 400);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
