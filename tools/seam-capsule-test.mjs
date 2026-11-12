'use strict';
/*
 * Capsule (text + image) lifecycle test — runs the real Pages Functions
 * against an in-memory KV on 127.0.0.1.
 *
 *   node tools/seam-capsule-test.mjs
 *
 * Proves the HTTP contract the image sender uses:
 *   POST /capsules                 { blob, destroyable }  -> { id }
 *   GET  /capsules/<id>           -> { blob, destroyable } / 404 / 410
 *   POST /capsules/<id>/consume   -> { consumed } / 410 / 400
 *
 * The `blob` is base64 of a CAP1 envelope JSON, exactly the shape the browser
 * builds (see makeTextEnvelope/makeImageEnvelope in index.html). This test
 * proves the server accepts text and image envelopes and that consume/destroy
 * semantics hold.
 */

import assert from 'node:assert/strict';
import { startLocalSite, assertLocal } from './lib/local-site.mjs';

const site = await startLocalSite({ host: '127.0.0.1', port: 0 });
const BASE = assertLocal(site.base);
const kv = site.kv;

function b64encode(s) {
  return Buffer.from(s, 'utf8').toString('base64');
}

function makeCapsuleEnvelope(notes, image) {
  // Mirrors the shape built in index.html's makeTextEnvelope/makeImageEnvelope.
  const env = {
    magic: 'CAP1',
    product_version: 1,
    spim_version: 1,
    tokenization_version: 1,
    flags: 0,
    created_at: new Date().toISOString(),
    spim_b64: b64encode('engine-state-for:' + (image ? 'image' : 'text') + ':' + notes.join('|')),
    notes_blake3: notes.map(() => 'pending'),
    fmt_b64: notes.map(() => 'pending'),
    word_count: notes.reduce((a, s) => a + s.split(/\s+/).filter(Boolean).length, 0),
    blake3: 'pending',
    images: image ? [{ kind: 'image', source_bytes_b64: b64encode('image-bytes'), mime: 'image/png', filename: 'shot.png', source_blake3: 'pending' }] : [],
  };
  env.blake3 = 'pending';
  return JSON.stringify(env);
}

function req(path, { method = 'GET', body } = {}) {
  return fetch(BASE + path, {
    method,
    headers: { origin: BASE, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

let pass = 0;
let fail = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass += 1; console.log(`ok   ${name}`); })
    .catch((e) => { fail += 1; console.log(`FAIL ${name}: ${e && e.message ? e.message : e}`); });
}

await check('image capsule: post -> get -> consume -> get(destroyed)', async () => {
  const env = makeCapsuleEnvelope(['shot'], true); // kind = image
  const post = await req('/capsules', { method: 'POST', body: { blob: b64encode(env), destroyable: true } });
  assert.equal(post.status, 201);
  const { id } = await post.json();

  const get1 = await req('/capsules/' + id);
  assert.equal(get1.status, 200);
  const got = await get1.json();
  assert.equal(got.destroyable, true);
  assert.ok(got.blob);

  const consume = await req('/capsules/' + id + '/consume', { method: 'POST' });
  assert.equal(consume.status, 200);
  const cons = await consume.json();
  assert.equal(cons.consumed, true);

  const get2 = await req('/capsules/' + id);
  assert.equal(get2.status, 410);

  const consume2 = await req('/capsules/' + id + '/consume', { method: 'POST' });
  assert.equal(consume2.status, 410);
});

await check('text capsule: post -> get -> consume refused when not destroyable', async () => {
  const env = makeCapsuleEnvelope(['hello image world'], false);
  const post = await req('/capsules', { method: 'POST', body: { blob: b64encode(env), destroyable: false } });
  assert.equal(post.status, 201);
  const { id } = await post.json();
  const get1 = await req('/capsules/' + id);
  assert.equal(get1.status, 200);
  const consume = await req('/capsules/' + id + '/consume', { method: 'POST' });
  assert.equal(consume.status, 400);
});

await check('unknown capsule is 404', async () => {
  const get = await req('/capsules/' + 'zzzzzzzzzzzzzzzz');
  assert.equal(get.status, 404);
});

await check('bad blob is refused', async () => {
  const post = await req('/capsules', { method: 'POST', body: { blob: '!!!not-base64!!!', destroyable: false } });
  assert.equal(post.status, 400);
});

await check('oversized blob is refused', async () => {
  const post = await req('/capsules', { method: 'POST', body: { blob: b64encode('x'.repeat(3 * 1024 * 1024)), destroyable: false } });
  assert.equal(post.status, 400);
});

await site.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
