/*
 * spim-analytics.js — first-party, cookie-free visit counter.
 *
 * Sends one same-origin beacon per page load to /api/hit. The server stores
 * daily aggregates in Cloudflare KV (views, unique visitors, paths, referrers).
 * No third-party script, no cookies, no IPs: the visitor id is a random UUID
 * kept in the browser's localStorage.
 *
 * Respects Do Not Track. Failures are silent: analytics must never break the site.
 */
(function () {
  'use strict';

  try {
    if (navigator.doNotTrack === '1' || window.doNotTrack === '1') return;

    var KEY = 'spim_sid';
    var sid = '';
    try { sid = localStorage.getItem(KEY) || ''; } catch (e) {}
    if (!sid) {
      sid = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : String(Date.now()) + '-' + Math.random().toString(16).slice(2);
      try { localStorage.setItem(KEY, sid); } catch (e) {}
    }

    var ref = '';
    if (document.referrer) {
      try { ref = new URL(document.referrer).hostname; } catch (e) {}
    }

    var body = JSON.stringify({
      p: location.pathname,
      r: ref,
      s: sid
    });

    fetch('/api/hit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body,
      keepalive: true,
      credentials: 'omit'
    }).catch(function () {});
  } catch (e) {}
})();
