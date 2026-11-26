/*
 * SPIM offline service worker.
 *
 * Scope: '/'. Only same-origin GETs for the static application shell are
 * intercepted. Nothing that can carry capsule content or identity is cached:
 * /capsules*, /api/*, /__test/*, /sw.js itself, and all non-GET requests are
 * left to the network. There is no runtime caching of HTML navigations, so a
 * private capsule page can never enter the cache.
 *
 * Versioned cache: a new install populates a new cache before activation, and
 * the old cache is deleted only after the new one is confirmed non-empty. An
 * install that fails (e.g. WASM fetch failure) therefore leaves the previous
 * working offline version intact.
 */
const VERSION = 'v1';
const CACHE = 'spim-offline-' + VERSION;

/* Must succeed for the offline shell to be usable. A failure aborts install. */
const CORE = [
  '/',
  '/receive',
  '/css/spim-theme.css',
  '/favicon.svg',
  '/js/session-nav.js',
  '/js/spim-capsule-client.js',
  '/js/spim-codec.js',
  '/js/spim-audio.js',
  '/js/supabaseClient.js',
  '/js/qr.js',
  '/js/spim-analytics.js',
  '/pkg/spim_wasm.js',
  '/pkg/spim_wasm_bg.wasm'
];

/* Useful, but their absence must not break the core offline promise. */
const EXTRA = ['/why', '/support', '/404'];

const ASSET = /\.(?:js|mjs|css|wasm|svg|png|jpe?g|webp|ico|json|woff2?)$/i;

const OFFLINE_PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>Offline — SPIM</title>' +
  '<style>body{font:15px/1.6 system-ui,sans-serif;background:#0b0c0e;color:#e7e9ee;' +
  'display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}' +
  'main{max-width:34rem}h1{font-size:20px}p{color:#9aa3b2}</style></head><body><main>' +
  '<h1>You are offline.</h1><p>This page has not been saved for offline use. ' +
  'Local <code>.spim</code> files can still be opened from the ' +
  '<a href="/" style="color:#8ab4ff">homepage</a> or ' +
  '<a href="/receive" style="color:#8ab4ff">receive page</a>. ' +
  'Server features (accounts, capsules, disposable chats) need a connection.</p>' +
  '</main></body></html>';

function privatePath(pathname) {
  return pathname === '/sw.js' ||
    /^\/(api|capsules|__test|functions|tools|migrations)(\/|$)/.test(pathname) ||
    pathname === '/wrangler.toml' || pathname === '/deploy.sh' ||
    pathname === '/README.md';
}

self.addEventListener('install', function (event) {
  event.waitUntil((async function () {
    const cache = await caches.open(CACHE);
    try {
      await cache.addAll(CORE);
      await Promise.all(EXTRA.map(function (url) {
        return cache.add(url).catch(function () {});
      }));
    } catch (e) {
      // Remove any partial entries so a failed upgrade cannot leave a broken
      // cache that a later activate would adopt. Re-throw to abort install:
      // the previous SW and its cache remain untouched and fully usable.
      await caches.delete(CACHE);
      throw e;
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    const cache = await caches.open(CACHE);
    const entries = await cache.keys();
    if (entries.length) {
      const names = await caches.keys();
      await Promise.all(names.filter(function (name) {
        return name.indexOf('spim-offline-') === 0 && name !== CACHE;
      }).map(function (name) { return caches.delete(name); }));
    }
    await self.clients.claim();
  })());
});

async function navigation(request) {
  try {
    return await fetch(request);
  } catch (e) {
    const cached = await caches.match(request);
    if (cached) return cached;
    // Tolerate a trailing slash or an explicit .html variant of a cached page.
    const u = new URL(request.url);
    const base = u.pathname.replace(/\/+$/, '') || '';
    const candidates = [base + '.html', (base || '/') + '/index.html'];
    if (base.endsWith('.html')) candidates.push(base.slice(0, -5));
    for (const candidate of candidates) {
      const alt = await caches.match(new URL(candidate, u.origin).href);
      if (alt) return alt;
    }
    return new Response(OFFLINE_PAGE, {
      status: 503,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
    });
  }
}

async function asset(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  try {
    const response = await fetch(request);
    if (response && response.ok && response.type === 'basic') {
      await cache.put(request, response.clone());
    }
    return response;
  } catch (e) {
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

self.addEventListener('fetch', function (event) {
  const request = event.request;
  if (request.method !== 'GET') return;
  let url;
  try { url = new URL(request.url); } catch (e) { return; }
  if (url.origin !== self.location.origin || privatePath(url.pathname)) return;

  if (request.mode === 'navigate') {
    event.respondWith(navigation(request));
  } else if (ASSET.test(url.pathname)) {
    event.respondWith(asset(request));
  }
});
