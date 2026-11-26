'use strict';
/*
 * Fix 4 — offline support invariants.
 *
 * These tests encode the safety promises of the service worker: only the
 * static shell is cached, private paths never are, a failed install cannot
 * destroy a working version, and version bumps migrate cleanly.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const sw = read('sw.js');
const nav = read('js/session-nav.js');
const headers = read('_headers');
const harness = read('tools/lib/local-site.mjs');

test('service worker is versioned and root-scoped', () => {
  assert.match(sw, /const VERSION = 'v\d+';/);
  assert.match(sw, /const CACHE = 'spim-offline-' \+ VERSION;/);
  assert.match(nav, /navigator\.serviceWorker\.register\('\/sw\.js',\s*\{ scope: '\/' \}\)/);
  assert.match(headers, /\/sw\.js\s*\n\s*Cache-Control: no-cache, must-revalidate\s*\n\s*Service-Worker-Allowed: \//);
  assert.match(harness, /rel === 'sw\.js'[\s\S]{0,200}service-worker-allowed/);
});

test('core cache contains only the static application shell', () => {
  const core = sw.match(/const CORE = \[([\s\S]*?)\];/);
  assert.ok(core, 'CORE list must exist');
  const urls = [...core[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  for (const required of [
    '/', '/receive', '/css/spim-theme.css', '/favicon.svg',
    '/js/session-nav.js', '/js/spim-capsule-client.js', '/js/spim-codec.js',
    '/js/spim-audio.js', '/js/spim-analytics.js',
    '/pkg/spim_wasm.js', '/pkg/spim_wasm_bg.wasm'
  ]) {
    assert.ok(urls.includes(required), 'missing core asset: ' + required);
  }
  // Nothing private or dynamic may ever be precached.
  for (const url of urls) {
    assert.ok(!/^\/(api|capsules|__test|functions|tools|migrations)(\/|$)/.test(url),
      'private path in CORE: ' + url);
    assert.ok(!/\?/.test(url), 'cache key must not carry a query string: ' + url);
  }
  assert.match(sw, /const EXTRA = \['\/why', '\/support', '\/404'\];/);
});

test('private paths and non-GET requests bypass the service worker', () => {
  assert.match(sw, /if \(request\.method !== 'GET'\) return;/);
  assert.match(sw, /if \(url\.origin !== self\.location\.origin \|\| privatePath\(url\.pathname\)\) return;/);
  assert.match(sw, /pathname === '\/sw\.js'/);
  const privateFn = sw.match(/function privatePath\(pathname\) \{([\s\S]*?)\n\}/);
  assert.ok(privateFn, 'privatePath helper must exist');
  assert.ok(privateFn[1].includes('(api|capsules|__test'),
    'privatePath must ignore /api, /capsules and /__test');
});

test('HTML navigations are never written to the cache', () => {
  const navFn = sw.match(/async function navigation\(request\) \{([\s\S]*?)\n\}/);
  assert.ok(navFn, 'navigation strategy must exist');
  assert.ok(!/cache\.put\(/.test(navFn[1]), 'navigations must not be runtime-cached');
  assert.ok(!/cache\.add\(/.test(navFn[1]), 'navigations must not be runtime-cached');
  assert.match(navFn[1], /caches\.match\(request\)/, 'network-first then cache fallback');
  assert.match(navFn[1], /status: 503/, 'offline notice for uncached pages');

  const assetFn = sw.match(/async function asset\(request\) \{([\s\S]*?)\n\}/);
  assert.ok(assetFn, 'asset strategy must exist');
  assert.match(assetFn[1], /response\.type === 'basic'/, 'only same-origin basic responses cached');
});

test('failed installs roll back and successful upgrades migrate cleanly', () => {
  const install = sw.match(/self\.addEventListener\('install', function \(event\) \{([\s\S]*?)\n\}\);/);
  assert.ok(install, 'install handler must exist');
  assert.match(install[1], /await cache\.addAll\(CORE\)/, 'core must be awaited in install');
  assert.match(install[1], /catch \(e\)/, 'install must handle precache failure');
  assert.match(install[1], /await caches\.delete\(CACHE\)/, 'partial cache is removed on failure');
  assert.match(install[1], /throw e/, 'install must abort on failure');
  assert.match(install[1], /self\.skipWaiting\(\)/);

  const activate = sw.match(/self\.addEventListener\('activate', function \(event\) \{([\s\S]*?)\n\}\);/);
  assert.ok(activate, 'activate handler must exist');
  const keysAt = activate[1].indexOf('const entries = await cache.keys();');
  const deleteAt = activate[1].indexOf('caches.delete(name)');
  assert.ok(keysAt > -1 && deleteAt > keysAt,
    'old caches may only be deleted after the new cache is confirmed non-empty');
  assert.match(activate[1], /name !== CACHE/, 'active cache must never be deleted');
  assert.match(activate[1], /self\.clients\.claim\(\)/);
});

test('offline notice never promises server features', () => {
  assert.match(nav, /data-spim-offline/, 'offline banner must be rendered');
  assert.match(nav, /Local \.spim files still open/, 'local files must be called out');
  assert.match(nav, /need a connection/, 'server features must be marked unavailable');
  assert.match(sw, /You are offline/, 'SW must provide an offline notice page');
  assert.match(sw, /Server features \(accounts, capsules, disposable chats\) need a connection/);
});
