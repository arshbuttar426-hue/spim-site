'use strict';
/*
 * Fix 2 — single-view capsule lifecycle, exercised over real HTTP against the
 * shipped Pages Functions (no mocks of the handlers). Proves the whole chain:
 * create -> postcard GET (not consumption) -> consume (the fence) -> refusal.
 *
 *   node --test tools/gates/single-view.test.mjs
 *
 * The 503 root cause was a missing D1 binding in wrangler.toml. The harness
 * injects the real D1-backed MockD1 as env.DB, so a regression that drops the
 * binding (or the INSERT fence) fails here rather than in production.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { startLocalSite, assertLocal } from '../lib/local-site.mjs';

const site = await startLocalSite({ host: '127.0.0.1', port: 0 });
const BASE = assertLocal(site.base);
after(async () => { await site.close(); });

function req(path, { method = 'GET', body, signal } = {}) {
  return fetch(BASE + path, {
    method,
    signal,
    headers: { origin: BASE, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const payload = () => b64(JSON.stringify({ magic: 'CAP1', notes: [{ source_b64: b64('secret') }] }));

async function create(destroyable) {
  const res = await req('/capsules', { method: 'POST', body: { blob: payload(), destroyable } });
  assert.equal(res.status, 201, 'create must succeed');
  const j = await res.json();
  assert.ok(j.id && typeof j.id === 'string');
  assert.equal(j.destroyable, !!destroyable);
  assert.ok(Number.isFinite(j.expires_at), 'create must report expires_at');
  return j.id;
}

async function burnRows() {
  const r = await fetch(BASE + '/__test/stats');
  return (await r.json()).burn_rows;
}

/* --------------------------------------------------------------- create ---- */

test('POST /capsules creates a single-view capsule with server state', async () => {
  const before = await burnRows();
  const id = await create(true);
  assert.match(id, /^[A-Za-z0-9_-]{6,16}$/);
  const get = await req('/capsules/' + id);
  assert.equal(get.status, 200);
  const j = await get.json();
  assert.equal(j.destroyable, true);
  assert.equal(j.single_view, true);
  assert.equal(j.blob, null, 'a postcard GET must not release the payload');
  assert.equal(await burnRows(), before, 'a postcard GET must not consume');
});

/* ------------------------------------------------- open once, then refuse --- */

test('single view: GET preview -> consume once -> second open and reuse rejected', async () => {
  const id = await create(true);

  const preview = await req('/capsules/' + id);
  assert.equal(preview.status, 200, 'first GET is a preview, not consumption');
  assert.equal((await preview.json()).blob, null, 'GET never carries bytes');

  const consume = await req('/capsules/' + id + '/consume', { method: 'POST' });
  assert.equal(consume.status, 200, 'first consume succeeds');
  const opened = await consume.json();
  assert.equal(opened.consumed, true);
  assert.equal(opened.id, id);
  assert.equal(opened.blob, payload(), 'only consume releases the payload');

  // Direct HTTP reuse: no browser state involved at all.
  const reopen = await req('/capsules/' + id);
  assert.equal(reopen.status, 410);
  assert.equal((await reopen.json()).error, 'destroyed');

  const reuse = await req('/capsules/' + id + '/consume', { method: 'POST' });
  assert.equal(reuse.status, 410);
  assert.equal((await reuse.json()).error, 'already destroyed');

  // The burn row remains authoritative after the short retry window scrubs KV.
  const raw = await site.kv.get('capsule:' + id);
  const stored = JSON.parse(raw);
  assert.equal(stored.consumed, true, 'KV records the burn for GET');
  assert.notEqual(stored.blob, '', 'bytes are kept briefly for a receipt retry only');
  const reopen2 = await req('/capsules/' + id);
  assert.equal(reopen2.status, 410);
});

/* ------------------------------------------- direct GET bypass protection --- */

test('repeated direct GETs cannot retrieve a supposedly single-view payload', async () => {
  const id = await create(true);
  const before = await burnRows();
  for (let i = 0; i < 4; i++) {
    const r = await req('/capsules/' + id);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).blob, null, 'preview ' + i + ' must stay empty');
  }
  assert.equal(await burnRows(), before, 'previews never consume');
  const opened = await req('/capsules/' + id + '/consume', { method: 'POST', body: { receipt: '1'.repeat(16) } });
  assert.equal(opened.status, 200);
  assert.equal((await opened.json()).blob, payload());
});

test('a lost consume response is recoverable only by its own receipt', async () => {
  const id = await create(true);
  const receipt = 'a1b2c3d4e5f60718';
  const first = await req('/capsules/' + id + '/consume', { method: 'POST', body: { receipt } });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).blob, payload());

  const stranger = await req('/capsules/' + id + '/consume', { method: 'POST', body: { receipt: 'f'.repeat(16) } });
  assert.equal(stranger.status, 410, 'a different receipt cannot take a second view');

  const retry = await req('/capsules/' + id + '/consume', { method: 'POST', body: { receipt } });
  assert.equal(retry.status, 200, 'the same receipt recovers the lost response');
  const retryBody = await retry.json();
  assert.equal(retryBody.retry, true);
  assert.equal(retryBody.blob, payload());

  const spent = await req('/capsules/' + id + '/consume', { method: 'POST', body: { receipt } });
  assert.equal(spent.status, 410, 'a spent receipt cannot read the payload again');
});

/* ------------------------------------------------------------ concurrency --- */

test('two (and eight) simultaneous consumes: exactly one wins', async () => {
  for (const n of [2, 8]) {
    const id = await create(true);
    const before = await burnRows();
    const results = await Promise.all(
      Array.from({ length: n }, () => req('/capsules/' + id + '/consume', { method: 'POST' }))
    );
    const statuses = results.map((r) => r.status).sort();
    assert.equal(statuses.filter((s) => s === 200).length, 1, `one winner out of ${n}`);
    assert.equal(statuses.filter((s) => s === 410).length, n - 1, 'all others refused');
    assert.equal(await burnRows(), before + 1, 'exactly one burn row');
  }
});

/* ------------------------------------------------- failed / interrupted ----- */

test('failed DB request does not destroy the capsule; retry succeeds', async () => {
  const id = await create(true);
  const before = await burnRows();
  const original = site.env.DB;
  site.env.DB = { prepare() { throw new Error('simulated DB outage'); } };
  try {
    const failed = await req('/capsules/' + id + '/consume', { method: 'POST' });
    assert.equal(failed.status, 503);
    assert.equal((await failed.json()).error, 'consume unavailable');
  } finally {
    site.env.DB = original;
  }
  assert.equal(await burnRows(), before, 'a failed consume writes no burn row');
  const stillThere = await req('/capsules/' + id);
  assert.equal(stillThere.status, 200, 'the capsule is still openable');
  const retry = await req('/capsules/' + id + '/consume', { method: 'POST' });
  assert.equal(retry.status, 200, 'retry after failure succeeds');
});

test('interrupted consume (response lost after server commit) cannot be reopened', async () => {
  const id = await create(true);
  const before = await burnRows();
  const original = site.env.DB;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const delayed = {
    prepare(sql) {
      const st = original.prepare(sql);
      const wrapped = {
        bind(...a) { st.bind(...a); return wrapped; },
        async first() { return st.first(); },
        async run() { const r = await st.run(); await gate; return r; },
      };
      return wrapped;
    },
  };
  site.env.DB = delayed;
  const controller = new AbortController();
  const pending = req('/capsules/' + id + '/consume', { method: 'POST', signal: controller.signal })
    .catch(() => null); // client sees the network interruption
  try {
    // Wait until the server has committed the burn row but withheld the response.
    const deadline = Date.now() + 2000;
    while ((await burnRows()) === before && Date.now() < deadline) {
      await new Promise((r) => setImmediate(r));
    }
    assert.equal(await burnRows(), before + 1, 'server committed before the response was lost');
    controller.abort();
    await pending;
  } finally {
    release();
    site.env.DB = original;
  }
  // A retry must see the burn, not hand out a second view.
  assert.equal((await req('/capsules/' + id + '/consume', { method: 'POST' })).status, 410);
  assert.equal((await req('/capsules/' + id)).status, 410);
});

/* ------------------------------------------------------ expiry / bad IDs ---- */

test('expired capsules are rejected by GET and consume', async () => {
  const id = await create(true);
  // Simulate the 30-day TTL elapsing while leaving KV's own TTL intact.
  await site.kv.put('capsule:' + id, JSON.stringify({
    blob: payload(), destroyable: true, consumed: false, expires_at: Date.now() - 1,
  }), { expirationTtl: 7 * 24 * 3600 });

  const get = await req('/capsules/' + id);
  assert.equal(get.status, 410);
  assert.equal((await get.json()).error, 'expired');
  const consume = await req('/capsules/' + id + '/consume', { method: 'POST' });
  assert.equal(consume.status, 410);
  assert.equal((await consume.json()).error, 'expired');
  assert.equal((await req('/capsules/' + id)).status, 410, 'expired capsules never open');
});

test('malformed and sanitised IDs are rejected, never rewritten', async () => {
  for (const bad of ['bad%21id', 'Ab3x9Q%21%21', 'short', '%2Fetc%2Fpasswd', 'a'.repeat(40)]) {
    const get = await req('/capsules/' + bad);
    assert.equal(get.status, 400, `GET ${bad}`);
    assert.equal((await get.json()).error, 'bad id');
    const post = await req('/capsules/' + bad + '/consume', { method: 'POST' });
    assert.equal(post.status, 400, `consume ${bad}`);
  }
  // Well-formed but unknown -> 404, not 400.
  assert.equal((await req('/capsules/zzzzzzzz')).status, 404);
});

/* ------------------------------------------------------ normal regression --- */

test('normal (non-destroyable) capsules still work and are never burned', async () => {
  const id = await create(false);
  const before = await burnRows();
  const get = await req('/capsules/' + id);
  assert.equal(get.status, 200);
  assert.equal((await get.json()).blob, payload());
  const consume = await req('/capsules/' + id + '/consume', { method: 'POST' });
  assert.equal(consume.status, 400);
  assert.equal((await consume.json()).error, 'not destroyable');
  assert.equal(await burnRows(), before, 'normal capsule never writes a burn row');
  assert.equal((await req('/capsules/' + id)).status, 200, 'normal capsule still readable');
});
