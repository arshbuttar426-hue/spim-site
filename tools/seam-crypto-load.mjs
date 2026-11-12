'use strict';
/*
 * SEAM cryptographic concurrency harness.
 *
 *   node tools/seam-crypto-load.mjs
 *
 * Runs the real wasm32 engine in worker threads and measures:
 *   - X3DH handshake + first message
 *   - ratchet encrypt
 *   - ratchet decrypt
 *   - many concurrent sessions in one thread
 *   - cross-session isolation (a capsule for session i must not open in j)
 *
 * This is CPU work, not HTTP. It answers "does the protocol itself stay correct
 * and fast when thousands of sessions exist at once", independent of the relay.
 *
 * Environment:
 *   SEAM_WASM_DIR       nodejs build directory (default $TMPDIR/seam-load-node)
 *   SEAM_CRYPTO_WORKERS worker threads (default: cpus - 1, min 2)
 *   SEAM_CRYPTO_SESSIONS sessions per worker (default 250)
 *   SEAM_CRYPTO_FANOUT  concurrent sessions in the fan-out test (default 2000)
 *
 * Safety: no network access at all.
 */

import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

function num(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function stats(values) {
  if (!values.length) return { n: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    avg_ms: sum / sorted.length,
    p50_ms: at(0.5),
    p95_ms: at(0.95),
    p99_ms: at(0.99),
    max_ms: sorted[sorted.length - 1],
  };
}

function runWorker({ dir, sessions, fanout }) {
  const require = createRequire(import.meta.url);
  const wasm = require(path.join(dir, 'spim_wasm.js'));
  const now = Math.floor(Date.now() / 1000);
  const ttl = 86_400;

  const handshake = [];
  const encrypt = [];
  const decrypt = [];
  const errors = [];

  const bob = new wasm.WasmIdentity();
  const generated = JSON.parse(wasm.seam_generate_prekeys(bob, sessions, now, ttl));
  const store = wasm.WasmPreKeyStore.restore(generated.store);

  for (let i = 0; i < sessions; i += 1) {
    try {
      const alice = new wasm.WasmIdentity();
      const bundle = generated.bundles[i];

      let t = performance.now();
      const aliceSession = wasm.WasmSession.initiate(alice, JSON.stringify(bundle), now);
      const first = aliceSession.encrypt('hello ' + i, now);
      handshake.push(performance.now() - t);

      t = performance.now();
      const bobSession = wasm.WasmSession.accept(bob, store, first);
      if (bobSession.first_body() !== 'hello ' + i) throw new Error('first body mismatch');
      decrypt.push(performance.now() - t);

      t = performance.now();
      const reply = bobSession.encrypt('reply ' + i, now + 1);
      encrypt.push(performance.now() - t);

      t = performance.now();
      const body = aliceSession.decrypt(reply);
      if (body !== 'reply ' + i) throw new Error('reply body mismatch');
      decrypt.push(performance.now() - t);
    } catch (e) {
      errors.push(String((e && e.message) || e));
    }
  }

  // Fan-out: one side holds `fanout` live sessions and talks on each.
  let fanoutOk = 0;
  let fanoutRefused = 0;
  const fanoutErrors = [];
  let fanoutStart = 0;
  try {
    const alice = new wasm.WasmIdentity();
    const bobPre = JSON.parse(wasm.seam_generate_prekeys(bob, fanout, now, ttl));
    const bobStore = wasm.WasmPreKeyStore.restore(bobPre.store);
    const peers = [];
    for (let i = 0; i < fanout; i += 1) {
      const s = wasm.WasmSession.initiate(alice, JSON.stringify(bobPre.bundles[i]), now);
      const c = s.encrypt('f' + i, now);
      const b = wasm.WasmSession.accept(bob, bobStore, c);
      if (b.first_body() !== 'f' + i) throw new Error('fanout first body ' + i);
      peers.push({ s, b });
    }
    fanoutStart = performance.now();
    for (let i = 0; i < fanout; i += 1) {
      const m = peers[i].s.encrypt('x' + i, now + 2);
      const body = peers[i].b.decrypt(m);
      if (body !== 'x' + i) throw new Error('fanout body ' + i);
      fanoutOk += 1;
    }
    // Cross-session isolation: session 0 must not read session 1's capsule.
    const capsule = peers[1].s.encrypt('not yours', now + 3);
    try {
      peers[0].b.decrypt(capsule);
      fanoutErrors.push('cross-session capsule opened in the wrong session');
    } catch {
      fanoutRefused += 1;
    }
  } catch (e) {
    fanoutErrors.push(String((e && e.message) || e));
  }
  const fanoutMs = fanoutStart ? performance.now() - fanoutStart : 0;

  return {
    pid: process.pid,
    sessions,
    fanout,
    errors,
    handshake,
    encrypt,
    decrypt,
    fanout_ok: fanoutOk,
    fanout_refused: fanoutRefused,
    fanout_errors: fanoutErrors,
    fanout_ms: fanoutMs,
    rss_mb: process.memoryUsage().rss / 1024 / 1024,
  };
}

if (!isMainThread) {
  parentPort.postMessage(runWorker(workerData));
} else {
  const dir = process.env.SEAM_WASM_DIR || path.join(process.env.TMPDIR || '/tmp', 'seam-load-node');
  const workers = num('SEAM_CRYPTO_WORKERS', Math.max(2, os.cpus().length - 1));
  const sessions = num('SEAM_CRYPTO_SESSIONS', 250);
  const fanout = num('SEAM_CRYPTO_FANOUT', 1000);

  console.log(`SEAM crypto load — ${workers} workers × ${sessions} sessions, fan-out ${fanout}`);
  console.log(`engine: ${path.join(dir, 'spim_wasm.js')}`);
  console.log('');

  const started = performance.now();
  const results = await Promise.all(
    Array.from({ length: workers }, () => new Promise((resolve, reject) => {
      const w = new Worker(new URL(import.meta.url), {
        workerData: { dir, sessions, fanout },
      });
      w.once('message', resolve);
      w.once('error', reject);
      w.once('exit', (code) => { if (code !== 0) reject(new Error(`worker exit ${code}`)); });
    }))
  );
  const wall = performance.now() - started;

  const merge = (key) => results.flatMap((r) => (Array.isArray(r[key]) ? r[key] : []));
  const handshakes = merge('handshake');
  const encrypts = merge('encrypt');
  const decrypts = merge('decrypt');
  const errors = results.flatMap((r) => r.errors);
  const fanoutErrors = results.flatMap((r) => r.fanout_errors);
  const fanoutOk = results.reduce((a, r) => a + r.fanout_ok, 0);
  const fanoutRefused = results.reduce((a, r) => a + r.fanout_refused, 0);
  const maxRss = Math.max(...results.map((r) => r.rss_mb));

  // Each sample is a phase duration; throughput is samples per wall second.
  const rate = (n) => (n / wall) * 1000;
  const report = {
    workers,
    sessions_per_worker: sessions,
    sessions_total: workers * sessions,
    fanout_per_worker: fanout,
    wall_ms: wall,
    handshake: stats(handshakes),
    encrypt: stats(encrypts),
    decrypt: stats(decrypts),
    handshakes_per_sec: rate(handshakes.length),
    encrypts_per_sec: rate(encrypts.length),
    decrypts_per_sec: rate(decrypts.length),
    fanout_ok: fanoutOk,
    fanout_refused: fanoutRefused,
    fanout_errors: fanoutErrors,
    errors,
    max_rss_mb: maxRss,
  };

  function row(name, s, perSec) {
    console.log(
      `${name.padEnd(12)} n=${String(s.n).padEnd(6)} ` +
      `p50=${s.p50_ms.toFixed(3)}ms p95=${s.p95_ms.toFixed(3)}ms ` +
      `p99=${s.p99_ms.toFixed(3)}ms  ${perSec.toFixed(0)}/s`
    );
  }
  row('handshake', report.handshake, report.handshakes_per_sec);
  row('encrypt', report.encrypt, report.encrypts_per_sec);
  row('decrypt', report.decrypt, report.decrypts_per_sec);
  console.log('');
  console.log(`wall ${wall.toFixed(0)} ms, max worker RSS ${maxRss.toFixed(0)} MiB`);
  console.log(`fan-out ${fanoutOk} sessions correct, ${fanoutRefused} cross-session refusals`);
  console.log(`errors: ${errors.length + fanoutErrors.length}`);
  for (const e of [...errors, ...fanoutErrors].slice(0, 10)) console.log('  ' + e);
  console.log('');
  console.log(JSON.stringify(report));
  process.exit(errors.length + fanoutErrors.length === 0 ? 0 : 1);
}
