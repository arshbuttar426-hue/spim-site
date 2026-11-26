'use strict';
/*
 * Browser regressions for the pre-commit security findings.
 *
 *   node tools/capsule-security-browser-test.mjs
 *
 * Runs the exact shipped Pages Functions and static pages against a loopback
 * local site, then drives real browsers through the paths an attacker or a
 * normal receiver uses. It covers:
 *   - CAP1 never inheriting a CAP2 id/AAD binding (downgrade)
 *   - wrong ids, altered envelopes, and public/private mode crossing
 *   - CAP1 "integrity-only" vs CAP2 "authentic" Catch labels
 *   - direct GET bypass being unable to retrieve a single-view payload twice
 *   - truthful consume error messages
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { startLocalSite, assertLocal } from './lib/local-site.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'spim-security-browser-'));

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
    try { return await import(spec); } catch { /* try next */ }
  }
  throw new Error('playwright not found; set PLAYWRIGHT_MODULE to its index.js');
}

const FIXTURE_JS = async () => {
  const enc = (s) => window.spimB64EncodeStr(s);
  const h = (s) => window.blake3_hex_static(s);
  const clone = (e) => JSON.parse(JSON.stringify(e));
  const wrap = (blob, id, key, version) => JSON.stringify({
    spim_file: 1,
    version,
    ...(id ? { id } : {}),
    locked: !!key,
    key_b64url: key || null,
    blob
  });
  const baseEnv = (text, magic) => ({
    magic, product_version: 1, spim_version: 1, tokenization_version: 1,
    flags: 0, created_at: '2026-11-25T00:00:00.000Z',
    notes: [{ source_b64: enc(text), source_blake3: h(text) }],
    images: [], spim_b64: '', word_count: text.split(/\s+/).length, blake3: ''
  });
  const cap1 = baseEnv('SECURITY legacy payload', 'CAP1');
  cap1.blake3 = h(JSON.stringify(Object.assign({}, cap1, { blake3: '' })));

  const cap2env = baseEnv('SECURITY authentic payload', 'CAP2');
  await window.spimSealCap2(cap2env);
  const cap2json = window.spimCanonicalJson(cap2env);
  const cap2id = await window.spimCapsuleId(cap2json);
  const cap2blob = enc(cap2json);

  const forgedText = 'FORGED transfer to Mallory';
  const forged = clone(cap2env);
  forged.notes[0].source_b64 = enc(forgedText);
  forged.notes[0].source_blake3 = h(forgedText);
  forged.blake3 = h(window.spimCap2HashJson(forged));

  const key = await window.spimGenerateKey();
  const keyUrl = window.spimB64UrlEncode(key);
  const privateBlob = await window.spimEncryptEnvelope(cap2json, key, 'SPIM-CAP2:' + cap2id);
  const cap1UnderCap2Aad = await window.spimEncryptEnvelope(JSON.stringify(cap1), key, 'SPIM-CAP2:' + cap2id);

  return {
    cap2_id: cap2id,
    cap2_text: 'SECURITY authentic payload',
    cap1_text: 'SECURITY legacy payload',
    forged_text: forgedText,
    fixtures: {
      cap1_legacy: wrap(enc(JSON.stringify(cap1)), null, null, 1),
      cap2_public: wrap(cap2blob, cap2id, null, 2),
      cap2_private: wrap(privateBlob, cap2id, keyUrl, 2),
      downgrade_id: wrap(enc(JSON.stringify(cap1)), cap2id, null, 2),
      downgrade_aad: wrap(cap1UnderCap2Aad, cap2id, keyUrl, 2),
      wrong_id: wrap(cap2blob, 'f'.repeat(16), null, 2),
      altered: wrap(enc(window.spimCanonicalJson(forged)), cap2id, null, 2),
      public_as_private: wrap(cap2blob, cap2id, keyUrl, 2),
      private_as_public: wrap(privateBlob, cap2id, null, 2)
    }
  };
};

const CREATE_SINGLE_JS = async (text) => {
  const enc = (s) => window.spimB64EncodeStr(s);
  const h = (s) => window.blake3_hex_static(s);
  const env = {
    magic: 'CAP2', product_version: 1, spim_version: 1, tokenization_version: 1,
    flags: 0, created_at: new Date().toISOString(),
    notes: [{ source_b64: enc(text), source_blake3: h(text) }],
    images: [], spim_b64: '', word_count: text.split(/\s+/).length, blake3: ''
  };
  await window.spimSealCap2(env);
  const json = window.spimCanonicalJson(env);
  const id = await window.spimCapsuleId(json);
  const blob = window.spimB64EncodeStr(json);
  const res = await fetch('/capsules', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ blob, id, version: 2, destroyable: true })
  });
  return { status: res.status, body: await res.json() };
};

const CATCH_STATE_JS = () => ({
  caught: !document.getElementById('caughtCard').classList.contains('spim-hide'),
  badge: document.getElementById('caughtBadge').textContent.trim(),
  verifiedClass: document.getElementById('caughtBadge').classList.contains('spim-pill--verified'),
  text: document.getElementById('caughtText').textContent.slice(0, 300),
  msg: document.getElementById('fileMsg').classList.contains('spim-hide') ? '' : document.getElementById('fileMsg').textContent.trim()
});

const RECEIVE_STATE_JS = () => ({
  actions: !document.getElementById('postcardActions').classList.contains('spim-hide'),
  destroyed: !document.getElementById('postcardDestroyed').classList.contains('spim-hide'),
  error: !document.getElementById('postcardError').classList.contains('spim-hide'),
  errTitle: document.getElementById('postcardErrorTitle').textContent.trim(),
  errMsg: document.getElementById('postcardErrorMsg').textContent.trim(),
  trust: document.getElementById('postcardTrust').textContent.trim(),
  meta: document.getElementById('postcardMeta').textContent.trim(),
  collection: !document.getElementById('collectionView').classList.contains('spim-hide'),
  content: document.getElementById('recContent2') ? document.getElementById('recContent2').textContent.slice(0, 300) : ''
});

const site = await startLocalSite({ host: '127.0.0.1', port: 0 });
const BASE = assertLocal(site.base);
const playwright = await loadPlaywright();
const { chromium, firefox, webkit } = playwright.default || playwright;

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`ok   ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`FAIL ${name}\n     ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n     ') : e}`);
  }
}

async function ready(page) {
  await page.waitForFunction(() => window.wasmReady === true, null, { timeout: 30000 });
}

async function writeFixtures(fixtures) {
  const out = {};
  for (const [name, body] of Object.entries(fixtures)) {
    const file = path.join(TMP, `${name}.spim`);
    fs.writeFileSync(file, body);
    out[name] = file;
  }
  return out;
}

async function openCatchHome(page) {
  await page.goto(BASE + '/', { wait_until: 'domcontentloaded', timeout: 30000 });
  await ready(page);
  await page.click('#tabCatch');
  await page.waitForSelector('#panelCatch:not([hidden])', { state: 'visible', timeout: 10000 });
}

async function runCatchCase(page, files, name, expected) {
  await page.evaluate(`() => {
    document.getElementById('caughtCard').classList.add('spim-hide');
    document.getElementById('fileMsg').classList.add('spim-hide');
    document.getElementById('caughtText').textContent = '';
  }`);
  await page.locator('#spimFile').setInputFiles(files[name]);
  await page.waitForFunction(() => {
    const card = document.getElementById('caughtCard');
    const msg = document.getElementById('fileMsg');
    return !card.classList.contains('spim-hide') || !msg.classList.contains('spim-hide');
  }, null, { timeout: 20000 });
  const state = await page.evaluate(CATCH_STATE_JS);
  if (expected.accept) {
    assert.equal(state.caught, true, `${name}: Catch card was not shown: ${JSON.stringify(state)}`);
    assert.match(state.badge, expected.label, `${name}: wrong trust label`);
    assert.equal(state.verifiedClass, expected.verified, `${name}: wrong verified pill`);
    assert.ok(state.text.includes(expected.marker), `${name}: expected content missing`);
  } else {
    assert.equal(state.caught, false, `${name}: rejected file was displayed`);
    assert.equal(state.verifiedClass, false, `${name}: rejected file got a verified pill`);
    assert.ok(!state.text.includes(expected.marker), `${name}: rejected content leaked`);
    assert.ok(state.msg, `${name}: no rejection message`);
  }
}

async function createSingle(page) {
  const out = await page.evaluate(CREATE_SINGLE_JS, 'SECURITY single-view payload');
  assert.equal(out.status, 201, JSON.stringify(out));
  return out.body.id;
}

async function openReceive(page, id) {
  await page.goto(BASE + '/receive#c/' + id, { wait_until: 'domcontentloaded', timeout: 30000 });
  await ready(page);
  await page.waitForFunction(() => {
    const vis = (x) => !document.getElementById(x).classList.contains('spim-hide');
    return vis('postcardActions') || vis('postcardDestroyed') || vis('postcardError');
  }, null, { timeout: 15000 });
}

async function probe(page, url, method = 'GET', body) {
  return page.evaluate(async ({ url, method, body }) => {
    const res = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, body: json };
  }, { url, method, body });
}

async function runForEngine(name, launcher) {
  const browser = await launcher.launch();
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await ctx.newPage();
  let files, info;
  try {
    await check(`${name}: fixture generation`, async () => {
      await openCatchHome(page);
      info = await page.evaluate(FIXTURE_JS);
      files = await writeFixtures(info.fixtures);
      assert.match(info.cap2_id, /^[0-9a-f]{16}$/);
    });

    assert.ok(files && info, `${name}: fixtures were not generated`);

    await check(`${name}: CAP1 Catch shows integrity-only, CAP2 shows authentic`, async () => {
      await openCatchHome(page);
      await runCatchCase(page, files, 'cap1_legacy', { accept: true, label: /integrity-only/, verified: false, marker: info.cap1_text });
      await runCatchCase(page, files, 'cap2_public', { accept: true, label: /authentic/, verified: true, marker: info.cap2_text });
      await runCatchCase(page, files, 'cap2_private', { accept: true, label: /authentic/, verified: true, marker: info.cap2_text });
    });

    await check(`${name}: CAP1 downgrade under a CAP2 id or AAD is refused`, async () => {
      await openCatchHome(page);
      await runCatchCase(page, files, 'downgrade_id', { accept: false, marker: info.cap1_text });
      await runCatchCase(page, files, 'downgrade_aad', { accept: false, marker: info.cap1_text });
    });

    await check(`${name}: wrong ids and altered envelopes are refused`, async () => {
      await openCatchHome(page);
      await runCatchCase(page, files, 'wrong_id', { accept: false, marker: info.cap2_text });
      await runCatchCase(page, files, 'altered', { accept: false, marker: info.forged_text });
    });

    await check(`${name}: public/private mode crossing fails closed`, async () => {
      await openCatchHome(page);
      await runCatchCase(page, files, 'public_as_private', { accept: false, marker: info.cap2_text });
      await runCatchCase(page, files, 'private_as_public', { accept: false, marker: info.cap2_text });
    });

    await check(`${name}: direct GET bypass cannot retrieve a single-view payload repeatedly`, async () => {
      await openCatchHome(page);
      const id = await createSingle(page);
      const before = await (await fetch(BASE + '/__test/stats')).json();
      await openReceive(page, id);
      let state = await page.evaluate(RECEIVE_STATE_JS);
      assert.equal(state.actions, true, JSON.stringify(state));
      assert.match(state.trust, /Not opened/);
      assert.ok(!state.content.includes('SECURITY single-view payload'), 'content visible before consume');

      for (let i = 0; i < 4; i++) {
        const r = await probe(page, '/capsules/' + id);
        assert.equal(r.status, 200);
        assert.equal(r.body.blob, null, `direct GET ${i} released bytes`);
        assert.equal(r.body.single_view, true);
      }
      const afterPreviews = await (await fetch(BASE + '/__test/stats')).json();
      assert.equal(afterPreviews.burn_rows, before.burn_rows, 'direct GETs consumed the capsule');

      const opened = await probe(page, '/capsules/' + id + '/consume', 'POST', { receipt: 'a1b2c3d4e5f60718' });
      assert.equal(opened.status, 200, JSON.stringify(opened));
      assert.equal(opened.body.blob !== null, true, 'consume did not release bytes');

      const reused = await probe(page, '/capsules/' + id);
      assert.equal(reused.status, 410);
      assert.equal(reused.body.error, 'destroyed');
      // One retry with the same receipt is the lost-response recovery path;
      // a third attempt with it must be refused.
      const retry = await probe(page, '/capsules/' + id + '/consume', 'POST', { receipt: 'a1b2c3d4e5f60718' });
      assert.equal(retry.status, 200, 'the receipt could not recover a lost response');
      assert.equal(retry.body.retry, true);
      const spent = await probe(page, '/capsules/' + id + '/consume', 'POST', { receipt: 'a1b2c3d4e5f60718' });
      assert.equal(spent.status, 410, 'the receipt allowed more than one recovery');

      const fresh = await ctx.newPage();
      try {
        await openReceive(fresh, id);
        state = await fresh.evaluate(RECEIVE_STATE_JS);
        assert.equal(state.destroyed, true, JSON.stringify(state));
        assert.equal(state.collection, false, 'fresh open revealed content');
        assert.ok(!state.content.includes('SECURITY single-view payload'));
      } finally {
        await fresh.close();
      }
    });

    await check(`${name}: failed consume reports that the capsule is still closed`, async () => {
      await openCatchHome(page);
      const id = await createSingle(page);
      await openReceive(page, id);
      await page.route('**/capsules/*/consume', (route) => route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'consume unavailable' })
      }));
      await page.locator('text=Read it here').first().click();
      await page.waitForFunction(() => !document.getElementById('postcardError').classList.contains('spim-hide'), null, { timeout: 10000 });
      let state = await page.evaluate(RECEIVE_STATE_JS);
      assert.equal(state.collection, false, 'content revealed after a failed consume');
      assert.match(state.errMsg, /has not been opened/, JSON.stringify(state));

      await page.unroute('**/capsules/*/consume');
      await page.locator('text=Read it here').first().click();
      await page.waitForSelector('#collectionView:not(.spim-hide)', { timeout: 10000 });
      state = await page.evaluate(RECEIVE_STATE_JS);
      assert.ok(state.content.includes('SECURITY single-view payload'), JSON.stringify(state));
    });
  } finally {
    await browser.close();
  }
}

try {
  const engines = [
    ['chromium', chromium],
    ['firefox', firefox],
    ['webkit', webkit],
  ];
  for (const [name, launcher] of engines) {
    try {
      await runForEngine(name, launcher);
    } catch (e) {
      fail += 1;
      console.log(`FAIL ${name}: engine unavailable or setup failed\n     ${e && e.message ? e.message : e}`);
    }
  }
} finally {
  await site.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`browser security tests: ${pass} pass, ${fail} fail`);
if (fail) process.exitCode = 1;
