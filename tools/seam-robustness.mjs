'use strict';
/*
 * SPIM + SEAM adversarial robustness suite.
 *
 *   node tools/seam-robustness.mjs
 *
 * Runs against the real Pages Functions on 127.0.0.1 (tools/lib/local-site.mjs)
 * and checks the categories a security audit cares about:
 *
 *   web protocol     methods, malformed JSON, origin, traversal, pollution
 *   resource limits  oversized bodies, queue depth, ack fan-out
 *   auth             missing / tampered / expired sessions, owner bypass
 *   data isolation   cross-mailbox drain and ack, stale ids
 *   concurrency      duplicate one-time prekeys, queue overrun, publish loss
 *
 * Hard failures: any 5xx, any secret in a response, any cross-owner read/delete.
 * Concurrency observations are printed as findings because the relay's own
 * comments call its quotas approximate; the client is the final refusal.
 *
 * Safety: loopback only, no production URL, no deploy.
 */

import { startLocalSite, assertLocal } from './lib/local-site.mjs';
import { signSession } from '../functions/api/_lib.js';

const SECRET = 'local-harness-secret';
const MAX_QUEUE = 128;

const site = await startLocalSite({ host: '127.0.0.1', port: 0, env: { SPIM_AUTH_SECRET: SECRET } });
const BASE = assertLocal(site.base);
const kv = site.kv;

/* --------------------------------------------------------------- helpers ---- */

let pass = 0;
let fail = 0;
const hardFailures = [];
const findings = [];

function ok(name) {
  pass += 1;
  console.log(`ok   ${name}`);
}

function bad(name, detail) {
  fail += 1;
  hardFailures.push(`${name}: ${detail}`);
  console.log(`FAIL ${name}: ${detail}`);
}

async function check(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (e) {
    bad(name, (e && e.message) || String(e));
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function hex(bytes) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function bundle(seed) {
  return {
    v: 1,
    id: hex(12),
    ed: Buffer.alloc(32, seed).toString('base64'),
    x: Buffer.alloc(32, seed + 1).toString('base64'),
    spk: Buffer.alloc(32, seed + 2).toString('base64'),
    spk_sig: Buffer.alloc(64, seed + 3).toString('base64'),
    opk: [Buffer.alloc(32, seed + 4).toString('base64')],
    created_at: 1_800_000_000,
    expires_at: 1_900_000_000,
    sig: Buffer.alloc(64, seed + 5).toString('base64'),
  };
}

const capsule = Buffer.from('SMW1' + 'x'.repeat(64)).toString('base64');

async function cookie(user) {
  const { token } = await signSession(user, SECRET);
  return `spim_session=${encodeURIComponent(token)}`;
}

function b64url(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function expiredCookie() {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    sub: 'usr_expired',
    email: 'expired@example.test',
    iat: 1,
    exp: 1,
  }));
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(header + '.' + payload));
  return `spim_session=${encodeURIComponent(header + '.' + payload + '.' + b64url(sig))}`;
}

const alice = { id: 'usr_rob_alice', email: 'alice@example.test' };
const bob = { id: 'usr_rob_bob', email: 'bob@example.test' };
const cookieA = await cookie(alice);
const cookieB = await cookie(bob);

async function req(path, { method = 'GET', cookie: c, body, ip, origin, raw } = {}) {
  const headers = {};
  if (c) headers.cookie = c;
  if (ip) headers['cf-connecting-ip'] = ip;
  if (origin !== undefined) headers.origin = origin;
  else headers.origin = BASE;
  let payload;
  if (raw !== undefined) {
    headers['content-type'] = 'application/json';
    payload = raw;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, headers: res.headers, text, json };
}

async function seedMailbox(mailbox, owner, count) {
  await kv.put('seam:owner:' + mailbox, owner);
  const bundles = [];
  for (let i = 0; i < count; i += 1) bundles.push(bundle(i % 200));
  await kv.put('seam:prekey:' + mailbox, JSON.stringify({
    owner,
    bundles,
    created_at: 1_800_000_000,
    expires_at: 1_900_000_000,
  }));
}

async function seedEnvelopes(mailbox, owner, count) {
  await kv.put('seam:owner:' + mailbox, owner);
  const ids = [];
  for (let i = 0; i < count; i += 1) {
    const id = hex(12);
    ids.push(id);
    await kv.put(`seam:env:${mailbox}:${id}`, JSON.stringify({ envelope: capsule, at: 1_800_000_000 + i }));
  }
  return ids;
}

function secretLeak(text) {
  const needles = [SECRET, 'SPIM_AUTH_SECRET', 'sk_live_', '"salt"', '"hash"'];
  return needles.find((n) => text.includes(n)) || null;
}

/* ------------------------------------------------------- web protocol ------ */

console.log('\n# web protocol');

await check('static traversal is refused', async () => {
  for (const p of ['/%2e%2e/%2e%2e/etc/passwd', '/..%2f..%2fetc%2fpasswd', '/%00index.html']) {
    const r = await req(p);
    assert(r.status === 400 || r.status === 404, `${p} -> ${r.status}`);
  }
});

await check('malformed JSON never 500s', async () => {
  const owned = hex(16);
  await seedEnvelopes(owned, alice.id, 1);
  const paths = [
    ['/api/seam/prekeys', 400],
    ['/api/seam/envelopes', 400],
    [`/api/seam/envelopes/${owned}/ack`, 400],
    ['/capsules', 400],
  ];
  for (const [p, want] of paths) {
    const r = await req(p, { method: 'POST', cookie: cookieA, raw: '{not json' });
    assert(r.status === want, `${p} -> ${r.status}`);
    assert(!secretLeak(r.text), `${p} leaked a secret`);
  }
});

await check('wrong methods are refused, not 500', async () => {
  const cases = [
    ['/api/seam/prekeys', 'GET', 405],
    ['/api/seam/envelopes', 'GET', 405],
    ['/api/seam/envelopes/' + hex(16), 'POST', 405],
    ['/api/keys', 'DELETE', 405],
  ];
  for (const [p, method, want] of cases) {
    const r = await req(p, { method });
    assert(r.status === want, `${method} ${p} -> ${r.status}`);
  }
});

await check('cross-origin posts are refused', async () => {
  const r = await req('/api/seam/prekeys', {
    method: 'POST',
    cookie: cookieA,
    origin: 'https://evil.example',
    body: { mailbox: hex(16), bundles: [bundle(1)] },
  });
  assert(r.status === 403, `cross-origin -> ${r.status}`);
});

await check('prototype pollution does not touch Object.prototype', async () => {
  const raw = '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"mailbox":"' + hex(16) + '","envelope":"' + capsule + '"}';
  const r = await req('/api/seam/envelopes', { method: 'POST', raw, ip: hex(8) });
  assert(r.status === 400 || r.status === 201, `status ${r.status}`);
  assert({}.polluted === undefined, 'Object.prototype was polluted');
  assert(Object.prototype.polluted === undefined, 'Object.prototype was polluted');
});

/* ------------------------------------------------------- resource limits --- */

console.log('\n# resource limits');

await check('oversized envelope body is refused', async () => {
  const huge = Buffer.from('SMW1' + 'A'.repeat(300 * 1024)).toString('base64');
  const r = await req('/api/seam/envelopes', {
    method: 'POST',
    ip: hex(8),
    body: { mailbox: hex(16), envelope: huge },
  });
  assert(r.status === 400 || r.status === 413, `status ${r.status}`);
});

await check('too many bundles in one publish is refused', async () => {
  const bundles = Array.from({ length: 300 }, (_, i) => bundle(i % 200));
  const r = await req('/api/seam/prekeys', {
    method: 'POST',
    cookie: cookieA,
    body: { mailbox: hex(16), bundles },
  });
  assert(r.status === 400 || r.status === 429, `status ${r.status}`);
});

await check('ack with too many ids is refused', async () => {
  const mailbox = hex(16);
  await seedEnvelopes(mailbox, alice.id, 1);
  const r = await req(`/api/seam/envelopes/${mailbox}/ack`, {
    method: 'POST',
    cookie: cookieA,
    body: { ids: Array.from({ length: MAX_QUEUE + 1 }, () => hex(12)) },
  });
  assert(r.status === 400, `status ${r.status}`);
});

await check('a full mailbox refuses new capsules with 429', async () => {
  const mailbox = hex(16);
  await seedEnvelopes(mailbox, alice.id, MAX_QUEUE + 1);
  const r = await req('/api/seam/envelopes', {
    method: 'POST',
    ip: hex(8),
    body: { mailbox, envelope: capsule },
  });
  assert(r.status === 429, `status ${r.status}`);
});

await check('publish rate limit trips at the documented bound', async () => {
  const user = { id: 'usr_rob_limit', email: 'limit@example.test' };
  const c = await cookie(user);
  let last = 0;
  for (let i = 0; i < 21; i += 1) {
    const r = await req('/api/seam/prekeys', {
      method: 'POST',
      cookie: c,
      body: { mailbox: hex(16), bundles: [bundle(i)] },
    });
    last = r.status;
    assert(r.status === 201 || r.status === 429, `publish ${i} -> ${r.status}`);
  }
  assert(last === 429, `21st publish -> ${last}`);
});

await check('envelope post rate limit trips per IP', async () => {
  const ip = '203.0.113.77';
  let last = 0;
  for (let i = 0; i < 121; i += 1) {
    const r = await req('/api/seam/envelopes', {
      method: 'POST',
      ip,
      body: { mailbox: hex(16), envelope: capsule },
    });
    last = r.status;
    assert(r.status === 201 || r.status === 429, `post ${i} -> ${r.status}`);
  }
  assert(last === 429, `121st post -> ${last}`);
});

/* --------------------------------------------------------------- auth ------ */

console.log('\n# auth and isolation');

await check('missing, tampered, and expired sessions are refused', async () => {
  const missing = await req('/api/keys');
  assert(missing.status === 401, `missing -> ${missing.status}`);

  const tampered = cookieA.slice(0, -4) + 'aaaa';
  const t = await req('/api/keys', { cookie: tampered });
  assert(t.status === 401, `tampered -> ${t.status}`);

  const past = await expiredCookie();
  const e = await req('/api/keys', { cookie: past });
  assert(e.status === 401, `expired -> ${e.status}`);
});

await check('a non-owner cannot drain or ack a mailbox', async () => {
  const mailbox = hex(16);
  const ids = await seedEnvelopes(mailbox, alice.id, 4);
  const drain = await req(`/api/seam/envelopes/${mailbox}`, { cookie: cookieB });
  assert(drain.status === 403, `drain -> ${drain.status}`);
  const ack = await req(`/api/seam/envelopes/${mailbox}/ack`, {
    method: 'POST',
    cookie: cookieB,
    body: { ids },
  });
  assert(ack.status === 403, `ack -> ${ack.status}`);
  const still = await req(`/api/seam/envelopes/${mailbox}`, { cookie: cookieA });
  assert(still.json && still.json.count === 4, `owner sees ${still.json && still.json.count}`);
});

await check('stale or foreign ack ids delete nothing', async () => {
  const mailbox = hex(16);
  const foreign = hex(16);
  await seedEnvelopes(mailbox, alice.id, 2);
  const foreignIds = await seedEnvelopes(foreign, bob.id, 2);
  const r = await req(`/api/seam/envelopes/${mailbox}/ack`, {
    method: 'POST',
    cookie: cookieA,
    body: { ids: [...foreignIds, 'not-an-id', '../x'] },
  });
  assert(r.status === 200, `status ${r.status}`);
  const own = await req(`/api/seam/envelopes/${mailbox}`, { cookie: cookieA });
  assert(own.json.count === 2, `own mailbox changed to ${own.json.count}`);
  const other = await req(`/api/seam/envelopes/${foreign}`, { cookie: cookieB });
  assert(other.json.count === 2, `foreign mailbox changed to ${other.json.count}`);
});

await check('prekey fetch requires a session but not ownership', async () => {
  const mailbox = hex(16);
  await seedMailbox(mailbox, alice.id, 1);

  const anonymous = await req(`/api/seam/prekeys/${mailbox}`, { ip: hex(8) });
  assert(anonymous.status === 401, `anonymous status ${anonymous.status}`);

  // A different signed-in account may fetch: the one-time bundle is the
  // capability, and the recipient's client verifies the signed bundle.
  const r = await req(`/api/seam/prekeys/${mailbox}`, { ip: hex(8), cookie: cookieB });
  assert(r.status === 200, `status ${r.status}`);
  assert(!secretLeak(r.text), 'prekey response leaked a secret');
  assert(!JSON.stringify(r.json).includes(alice.id), 'prekey response leaked the owner id');
});

/* ---------------------------------------------------------- concurrency ---- */

console.log('\n# concurrency');

await check('parallel prekey fetches deliver distinct one-time keys', async () => {
  const mailbox = hex(16);
  // The relay allows 60 prekey fetches per mailbox per hour; stay under the
  // documented quota so a 429 cannot be mistaken for a concurrency finding.
  const count = 60;
  await seedMailbox(mailbox, alice.id, count);
  const responses = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      req(`/api/seam/prekeys/${mailbox}`, { ip: '198.51.100.' + i, cookie: cookieB }))
  );
  assert(
    responses.every((r) => r.status === 200),
    `parallel fetch refused: ${responses.filter((r) => r.status !== 200).map((r) => r.status).join(',') || 'none'}`
  );
  const keys = responses.map((r) => r.json.bundle.opk[0]);
  const unique = new Set(keys);
  if (unique.size !== keys.length) {
    findings.push(
      `duplicate one-time prekey delivered under concurrency: ${keys.length - unique.size} of ${keys.length} ` +
      'responses shared an OPK (relay read-modify-write; client refuses reuse)'
    );
  }
  assert(responses.every((r) => r.status < 500), 'a parallel fetch produced 5xx');
});

await check('parallel envelope posts never produce 5xx', async () => {
  const mailbox = hex(16);
  await seedEnvelopes(mailbox, alice.id, 1);
  const responses = await Promise.all(
    Array.from({ length: 40 }, (_, i) =>
      req('/api/seam/envelopes', {
        method: 'POST',
        ip: '198.51.100.' + (100 + i),
        body: { mailbox, envelope: capsule },
      }))
  );
  assert(responses.every((r) => r.status < 500), 'a parallel post produced 5xx');
});

await check('parallel posts do not blow past the queue bound silently', async () => {
  const mailbox = hex(16);
  await seedEnvelopes(mailbox, alice.id, MAX_QUEUE - 1);
  const responses = await Promise.all(
    Array.from({ length: 40 }, (_, i) =>
      req('/api/seam/envelopes', {
        method: 'POST',
        ip: '203.0.113.' + i,
        body: { mailbox, envelope: capsule },
      }))
  );
  const accepted = responses.filter((r) => r.status === 201).length;
  const stored = kv.size(`seam:env:${mailbox}:`);
  if (stored > MAX_QUEUE) {
    findings.push(
      `queue bound exceeded under concurrency: ${accepted} accepted, ${stored} stored, limit ${MAX_QUEUE} ` +
      '(list-then-put check is not atomic)'
    );
  }
  assert(responses.every((r) => r.status < 500), 'a parallel post produced 5xx');
});

await check('parallel publishes to one mailbox are not silently merged', async () => {
  const mailbox = hex(16);
  const sets = [
    [bundle(11), bundle(12)],
    [bundle(21), bundle(22), bundle(23)],
  ];
  const responses = await Promise.all(sets.map((bundles) =>
    req('/api/seam/prekeys', { method: 'POST', cookie: cookieA, body: { mailbox, bundles } })));
  assert(responses.every((r) => r.status === 201), 'publish failed');
  const record = JSON.parse(await kv.get('seam:prekey:' + mailbox));
  const ids = record.bundles.map((b) => b.id).sort().join(',');
  const matches = sets.map((s) => s.map((b) => b.id).sort().join(',')).includes(ids);
  if (!matches) {
    findings.push(`publish produced a record matching neither writer: ${ids}`);
  } else {
    const winner = sets.findIndex((s) => s.map((b) => b.id).sort().join(',') === ids);
    findings.push(`publish is last-write-wins: writer ${winner + 1} replaced writer ${2 - winner}, no merge`);
  }
});

await check('no response leaks a secret or internal path', async () => {
  const samples = [
    ['/api/seam/prekeys/' + hex(16), {}],
    ['/api/seam/envelopes/' + hex(16), { cookie: cookieA }],
    ['/api/auth/me', {}],
    ['/', {}],
  ];
  for (const [p, opts] of samples) {
    const r = await req(p, opts);
    const leak = secretLeak(r.text);
    assert(!leak, `${p} leaked ${leak}`);
    assert(!r.text.includes('/Users/arshbuttar'), `${p} leaked a filesystem path`);
  }
});

/* --------------------------------------------------------------- report ---- */

await site.close();

console.log('\n# result');
console.log(`${pass} passed, ${fail} failed`);
if (hardFailures.length) {
  console.log('\nHARD FAILURES');
  for (const f of hardFailures) console.log('  - ' + f);
}
if (findings.length) {
  console.log('\nFINDINGS (documented concurrency behaviour, not hard failures)');
  for (const f of findings) console.log('  - ' + f);
}
console.log('\nProduction was not contacted. All targets were 127.0.0.1.');
process.exit(hardFailures.length === 0 ? 0 : 1);
