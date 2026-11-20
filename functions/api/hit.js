/*
 * POST /api/hit — first-party visit counter.
 *
 * Stores daily aggregates in Cloudflare KV under stats:day:<YYYY-MM-DD>:
 *   { since, views, visitors: { <id>: 1 }, paths: { <path>: n }, refs: { <host>: n } }
 *
 * - Requires a client-generated visitor id (js/spim-analytics.js), so
 *   non-JS bots and scanners never reach the counter.
 * - Known crawler user-agents are ignored.
 * - No IP addresses or cookies are stored; the visitor id is a random UUID
 *   kept in the browser's localStorage.
 * - Always returns 204 so analytics can never surface an error to the page.
 */
var BOT = /(bot|crawl|spider|slurp|curl|wget|python|headless|lighthouse|monitor|uptime|scanner|zgrab|masscan|nmap|semrush|ahrefs|dataprovider)/i;

// One day is one KV value. Without caps a script can grow it until every put
// fails, which silently stops the counter for the rest of the day.
var MAX_VISITORS = 20000;
var MAX_PATHS = 500;
var MAX_REFS = 200;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function done() {
  return new Response(null, { status: 204 });
}

function cleanPath(value) {
  var p = String(value || '');
  if (!p || p.charAt(0) !== '/') return '/';
  p = p.split('?')[0].split('#')[0];
  return p.slice(0, 120) || '/';
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env || !env.SPIM_KV) return done();

    var ua = request.headers.get('user-agent') || '';
    if (!ua || BOT.test(ua)) return done();

    var data = {};
    var rawBody = '';
    try {
      rawBody = await request.text();
      data = JSON.parse(rawBody || '{}');
    } catch (e) {
      // Keep a small breadcrumb so malformed beacons are diagnosable.
      try {
        await env.SPIM_KV.put('stats:debug:last', JSON.stringify({
          at: new Date().toISOString(),
          contentType: request.headers.get('content-type') || '',
          length: rawBody.length,
          body: rawBody.slice(0, 300),
          ua: ua.slice(0, 160)
        }), { expirationTtl: 60 * 60 * 24 * 7 });
      } catch (e2) {}
      return done();
    }

    var sid = String(data.s || '').slice(0, 64);
    if (!sid) return done();

    var now = new Date();
    var day = now.toISOString().slice(0, 10);
    var path = cleanPath(data.p);
    var ref = String(data.r || '').slice(0, 100);
    var visitor = 's:' + sid;
    var key = 'stats:day:' + day;
    var stats = { since: now.toISOString(), views: 0, visitors: {}, paths: {}, refs: {} };
    try {
      var raw = await env.SPIM_KV.get(key);
      if (raw) {
        var parsed = JSON.parse(raw);
        stats.since = parsed.since || stats.since;
        stats.views = Number(parsed.views) || 0;
        stats.visitors = parsed.visitors || {};
        stats.paths = parsed.paths || {};
        stats.refs = parsed.refs || {};
      }
    } catch (e) {}

    stats.views += 1;
    if (stats.visitors[visitor] || Object.keys(stats.visitors).length < MAX_VISITORS) {
      stats.visitors[visitor] = 1;
    }
    if (stats.paths[path] || Object.keys(stats.paths).length < MAX_PATHS) {
      stats.paths[path] = (Number(stats.paths[path]) || 0) + 1;
    }
    if (ref && (stats.refs[ref] || Object.keys(stats.refs).length < MAX_REFS)) {
      stats.refs[ref] = (Number(stats.refs[ref]) || 0) + 1;
    }

    await env.SPIM_KV.put(key, JSON.stringify(stats), { expirationTtl: 60 * 60 * 24 * 400 });
    return done();
  } catch (e) {
    return done();
  }
}

export async function onRequestGet() {
  return json(405, { error: 'method not allowed' });
}
