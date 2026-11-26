'use strict';
/*
 * Fix 6 F1 — Dock must never receive or store a private capsule key.
 *
 * Exercises the shipped Pages Functions directly against a KV that records
 * every put option, so both the payload and the real TTL are observable:
 *
 *   node --test tools/gates/dock-privacy.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COOKIE, signSession } from '../../functions/api/_lib.js';
import * as dock from '../../functions/api/dock.js';
import * as dockItem from '../../functions/api/dock/[id].js';
import { MockKV } from '../lib/local-site.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const SECRET = 'dock-privacy-test-secret';
const SECRET_KEY = 'PRIVATEKEY_abcdefghijklmnopqrstuvwxyz123456';
const USER = { id: 'usr_dock_test', email: 'dock@example.test' };
const CAPSULE = 'cap123456';
const CAPSULE_LINK = 'https://example.test/receive#c/' + CAPSULE + '#' + SECRET_KEY;

class TrackingKV extends MockKV {
  constructor() {
    super();
    this.puts = [];
  }
  async put(key, value, options = {}) {
    this.puts.push({ key, value, options });
    return super.put(key, value, options);
  }
}

async function session() {
  const { token } = await signSession(USER, SECRET);
  return COOKIE + '=' + encodeURIComponent(token);
}

function makeRequest(pathname, { method = 'GET', body, cookie } = {}) {
  const headers = { origin: 'http://127.0.0.1', 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  return new Request('http://127.0.0.1' + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function makeEnv() {
  const kv = new TrackingKV();
  return { kv, env: { SPIM_KV: kv, SPIM_AUTH_SECRET: SECRET } };
}

async function body(res) {
  return res.json();
}

function hasSecret(value) {
  return JSON.stringify(value).includes(SECRET_KEY);
}

async function stored(kv, key) {
  const raw = await kv.get(key);
  return raw ? JSON.parse(raw) : null;
}

/* ------------------------------------------------------------ source ------- */

test('client source sends only a reference and keeps keys in browser storage', () => {
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const account = fs.readFileSync(path.join(root, 'account.html'), 'utf8');
  const client = fs.readFileSync(path.join(root, 'js', 'dock-client.js'), 'utf8');

  assert.match(index, /capsule_id:lastCapsule\.id, private:!!privateKey/);
  assert.doesNotMatch(index, /link:lastCapsule\.link/);
  assert.match(client, /spim_dock_keys:/);
  assert.match(client, /localStorage\.setItem/);
  assert.doesNotMatch(account, /esc\(item\.link\)/);
});

/* -------------------------------------------------------------- POST ------- */

test('private POST carries only capsule id; KV stores no link and has a real TTL', async () => {
  const { kv, env } = makeEnv();
  const cookie = await session();
  const res = await dock.onRequestPost({
    request: makeRequest('/api/dock', {
      method: 'POST',
      cookie,
      body: {
        capsule_id: CAPSULE,
        private: true,
        link: CAPSULE_LINK,
        key_b64: SECRET_KEY,
      },
    }),
    env,
  });

  assert.equal(res.status, 201);
  const json = await body(res);
  assert.equal(json.item.capsule_id, CAPSULE);
  assert.equal(json.item.private, true);
  assert.equal(json.item.link, undefined);
  assert.equal(hasSecret(json), false);

  const row = await stored(kv, 'dock:' + USER.id + ':' + json.item.id);
  assert.ok(row, 'dock row must be stored');
  assert.equal(row.link, undefined);
  assert.equal(hasSecret(row), false);
  assert.equal(kv.puts.length, 1);
  assert.equal(kv.puts[0].options.expirationTtl, 24 * 60 * 60);
});

test('public capsules still save and list without a private marker', async () => {
  const { kv, env } = makeEnv();
  const cookie = await session();
  const res = await dock.onRequestPost({
    request: makeRequest('/api/dock', {
      method: 'POST',
      cookie,
      body: { capsule_id: CAPSULE, private: false },
    }),
    env,
  });
  assert.equal(res.status, 201);
  const created = await body(res);
  assert.equal(created.item.private, false);

  const list = await body(await dock.onRequestGet({ request: makeRequest('/api/dock', { cookie }), env }));
  assert.equal(list.items.length, 1);
  assert.equal(list.waiting, 1);
  assert.equal(list.items[0].capsule_id, CAPSULE);
  assert.equal(list.items[0].link, undefined);

  const row = await stored(kv, 'dock:' + USER.id + ':' + created.item.id);
  assert.equal(hasSecret(row), false);
});

/* ------------------------------------------------------- legacy / read ----- */

test('legacy stored links are stripped from responses and rewritten out of KV', async () => {
  const { kv, env } = makeEnv();
  const cookie = await session();
  const id = 'dock_legacy1';
  const key = 'dock:' + USER.id + ':' + id;
  await kv.put(key, JSON.stringify({
    id,
    capsule_id: CAPSULE,
    private: true,
    link: CAPSULE_LINK,
    status: 'docked',
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60000).toISOString(),
  }));

  const listRes = await dock.onRequestGet({ request: makeRequest('/api/dock', { cookie }), env });
  const listText = await listRes.text();
  assert.equal(hasSecret(listText), false);
  assert.equal(listRes.headers.get('cache-control'), 'no-store');

  const row = await stored(kv, key);
  assert.equal(row.link, undefined);
  assert.equal(hasSecret(row), false);
  assert.equal(kv.puts.at(-1).options.expirationTtl, 24 * 60 * 60);
});

/* --------------------------------------------------- expiry / deletion ----- */

test('expired rows are unavailable and real KV expiry is used on writes', async () => {
  const { kv, env } = makeEnv();
  const cookie = await session();
  const id = 'dock_expired';
  const key = 'dock:' + USER.id + ':' + id;
  await kv.put(key, JSON.stringify({
    id,
    capsule_id: CAPSULE,
    private: true,
    link: CAPSULE_LINK,
    status: 'docked',
    created_at: new Date(Date.now() - 172800000).toISOString(),
    expires_at: new Date(Date.now() - 1000).toISOString(),
  }));

  const list = await body(await dock.onRequestGet({ request: makeRequest('/api/dock', { cookie }), env }));
  assert.equal(list.items.length, 0);
  assert.equal(await kv.get(key), null, 'expired legacy row must be scrubbed');
  const get = await dockItem.onRequestGet({
    request: makeRequest('/api/dock/' + id, { cookie }),
    env,
    params: { id },
  });
  assert.equal(get.status, 404);
  const unload = await dockItem.onRequestPost({
    request: makeRequest('/api/dock/' + id, { method: 'POST', cookie, body: { action: 'unload' } }),
    env,
    params: { id },
  });
  assert.equal(unload.status, 404);
});

test('unload and reject keep status and never return or persist the key', async () => {
  for (const [action, status] of [['unload', 'unloaded'], ['reject', 'rejected']]) {
    const { kv, env } = makeEnv();
    const cookie = await session();
    const created = await body(await dock.onRequestPost({
      request: makeRequest('/api/dock', {
        method: 'POST',
        cookie,
        body: { capsule_id: CAPSULE, private: true, link: CAPSULE_LINK },
      }),
      env,
    }));
    const id = created.item.id;

    const res = await dockItem.onRequestPost({
      request: makeRequest('/api/dock/' + id, { method: 'POST', cookie, body: { action } }),
      env,
      params: { id },
    });
    assert.equal(res.status, 200);
    const json = await body(res);
    assert.equal(json.item.status, status);
    assert.equal(json.item.link, undefined);
    assert.equal(hasSecret(json), false);

    const row = await stored(kv, 'dock:' + USER.id + ':' + id);
    assert.equal(row.status, status);
    assert.equal(row.link, undefined);
    assert.equal(hasSecret(row), false);
    assert.equal(kv.puts.at(-1).options.expirationTtl, 24 * 60 * 60);
  }
});

test('malformed dock ids fail safely without reading a key-bearing row', async () => {
  const { env } = makeEnv();
  const cookie = await session();
  const get = await dockItem.onRequestGet({
    request: makeRequest('/api/dock/bad%2Fid', { cookie }),
    env,
    params: { id: 'bad/id' },
  });
  assert.equal(get.status, 400);
  const post = await dockItem.onRequestPost({
    request: makeRequest('/api/dock/bad%2Fid', { method: 'POST', cookie, body: { action: 'unload' } }),
    env,
    params: { id: 'bad/id' },
  });
  assert.equal(post.status, 400);
  const badCapsule = await dock.onRequestPost({
    request: makeRequest('/api/dock', {
      method: 'POST',
      cookie,
      body: { capsule_id: '../' + CAPSULE, private: true, link: CAPSULE_LINK },
    }),
    env,
  });
  assert.equal(badCapsule.status, 400);
});
