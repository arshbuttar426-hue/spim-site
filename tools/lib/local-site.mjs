/*
 * Local SPIM site harness.
 *
 * Runs the exact Pages Functions that deploy (`functions/`) against an
 * in-memory KV, and serves the static surface a deploy tree would contain.
 * Nothing here is a mock of the product logic: the handlers, auth, quotas,
 * rate limits, and refusals are the real ones.
 *
 * Safety: this module only ever listens on 127.0.0.1. `startLocalSite` refuses
 * any other host. Load and robustness scripts additionally call `assertLocal`.
 *
 * Used by tools/seam-load-server.mjs, tools/seam-load-prepare.mjs, and
 * tools/seam-robustness.mjs.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SITE_ROOT = path.resolve(here, '..', '..');

/* ------------------------------------------------------------------ KV ---- */

/** The subset of Workers KV the Functions use, with operation counters. */
export class MockKV {
  constructor() {
    this.map = new Map();
    this.ops = { get: 0, put: 0, delete: 0, list: 0 };
  }

  async get(key) {
    this.ops.get += 1;
    const rec = this.map.get(key);
    if (!rec) return null;
    if (rec.expiresAt && rec.expiresAt <= Date.now()) {
      this.map.delete(key);
      return null;
    }
    return rec.value;
  }

  async put(key, value, options = {}) {
    this.ops.put += 1;
    const expiresAt = options.expirationTtl
      ? Date.now() + options.expirationTtl * 1000
      : options.expiration
        ? new Date(options.expiration).getTime()
        : null;
    this.map.set(key, { value, expiresAt: Number.isFinite(expiresAt) ? expiresAt : null });
  }

  async delete(key) {
    this.ops.delete += 1;
    this.map.delete(key);
  }

  async list({ prefix = '', limit = 1000, cursor } = {}) {
    this.ops.list += 1;
    const all = [...this.map.keys()].filter((k) => k.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    const keys = all.slice(start, start + limit).map((name) => ({ name }));
    const next = start + keys.length;
    const done = next >= all.length;
    return {
      keys,
      list_complete: done,
      cursor: done ? undefined : String(next),
    };
  }

  size(prefix = '') {
    let n = 0;
    for (const key of this.map.keys()) if (key.startsWith(prefix)) n += 1;
    return n;
  }

  reset() {
    this.map.clear();
    this.ops = { get: 0, put: 0, delete: 0, list: 0 };
  }
}

/** The subset of D1 the burn fence uses, backed by in-memory SQLite. */
export class MockD1 {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    const dir = path.join(SITE_ROOT, 'migrations');
    for (const file of fs.readdirSync(dir).filter((f) => /\.sql$/.test(f)).sort()) {
      this.db.exec(fs.readFileSync(path.join(dir, file), 'utf8'));
    }
  }

  prepare(sql) {
    const db = this.db;
    let args = [];
    const statement = {
      bind(...values) {
        args = values;
        return statement;
      },
      async first() {
        const row = db.prepare(sql).get(...args);
        return row || null;
      },
      async run() {
        const info = db.prepare(sql).run(...args);
        return { meta: { changes: Number(info.changes) } };
      },
    };
    return statement;
  }

  count() {
    const burn = Number(this.db.prepare('SELECT COUNT(*) AS n FROM capsule_burn').get().n);
    const open = Number(this.db.prepare('SELECT COUNT(*) AS n FROM capsule_open').get().n);
    return burn + open;
  }

  reset() {
    this.db.prepare('DELETE FROM capsule_burn').run();
    this.db.prepare('DELETE FROM capsule_open').run();
    this.db.prepare('DELETE FROM capsule_reservation').run();
  }

  close() {
    this.db.close();
  }
}

/* --------------------------------------------------------------- static ---- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/* Files a deploy tree never contains, or that must never be served. */
const NEVER_SERVE = [
  '.git',
  '.wrangler',
  'node_modules',
  'artifacts',
  'tools',
  'functions',
  'wrangler.toml',
  'deploy.sh',
  'README.md',
  '.gitignore',
  'landing-proto.html',
  'prima-four.html',
  'spim-chirp.html',
  'spim-field.html',
  'spim-quiet.html',
  'spim-textfield.html',
  'spim-typography.html',
  'js/chirp-receive.js',
];

function blocked(rel) {
  const clean = rel.replace(/^\/+/, '');
  return NEVER_SERVE.some((p) => clean === p || clean.startsWith(p + '/'));
}

function readSecurityHeaders() {
  const out = {};
  const file = path.join(SITE_ROOT, '_headers');
  if (!fs.existsSync(file)) return out;
  let current = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      current = line.trim() === '/*' ? out : null;
      continue;
    }
    if (!current) continue;
    const i = line.indexOf(':');
    if (i > 0) current[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function loadStatic() {
  const cache = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(SITE_ROOT, full).split(path.sep).join('/');
      if (blocked(rel)) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name !== '.DS_Store') {
        cache.set(rel, fs.readFileSync(full));
      }
    }
  };
  walk(SITE_ROOT);
  return cache;
}

/* ----------------------------------------------------------------- auth ---- */

const load = (rel) => import(pathToFileURL(path.join(SITE_ROOT, rel)).href);

export async function loadSiteModules() {
  return {
    lib: await load('functions/api/_lib.js'),
    authMe: await load('functions/api/auth/me.js'),
    authLogin: await load('functions/api/auth/login.js'),
    authRegister: await load('functions/api/auth/register.js'),
    authLogout: await load('functions/api/auth/logout.js'),
    keys: await load('functions/api/keys.js'),
    connections: await load('functions/api/connections.js'),
    dock: await load('functions/api/dock.js'),
    dockItem: await load('functions/api/dock/[id].js'),
    images: await load('functions/api/images.js'),
    capsules: await load('functions/capsules.js'),
    seamPrekeys: await load('functions/api/seam/prekeys.js'),
    seamPrekey: await load('functions/api/seam/prekeys/[id].js'),
    seamEnvelopes: await load('functions/api/seam/envelopes.js'),
    seamDrain: await load('functions/api/seam/envelopes/[id].js'),
    seamAck: await load('functions/api/seam/envelopes/[id]/ack.js'),
    capsuleGet: await load('functions/capsules/[id].js'),
    capsuleConsume: await load('functions/capsules/[id]/consume.js'),
  };
}

/* --------------------------------------------------------------- server ---- */

const ROUTES = [
  ['/api/auth/me', 'authMe'],
  ['/api/auth/login', 'authLogin'],
  ['/api/auth/register', 'authRegister'],
  ['/api/auth/logout', 'authLogout'],
  ['/api/keys', 'keys'],
  ['/api/connections', 'connections'],
  ['/api/dock', 'dock'],
  ['/api/images', 'images'],
  ['/capsules', 'capsules'],
  ['/api/seam/prekeys', 'seamPrekeys'],
  ['/api/seam/envelopes', 'seamEnvelopes'],
];

const DYNAMIC = [
  [/^\/api\/dock\/([^/]+)$/, 'dockItem'],
  [/^\/api\/seam\/prekeys\/([^/]+)$/, 'seamPrekey'],
  [/^\/api\/seam\/envelopes\/([^/]+)\/ack$/, 'seamAck'],
  [/^\/api\/seam\/envelopes\/([^/]+)$/, 'seamDrain'],
  [/^\/capsules\/([^/]+)$/, 'capsuleGet'],
  [/^\/capsules\/([^/]+)\/consume$/, 'capsuleConsume'],
];

function methodHandler(mod, method) {
  const name = {
    GET: 'onRequestGet',
    POST: 'onRequestPost',
    OPTIONS: 'onRequestOptions',
    DELETE: 'onRequestDelete',
    PUT: 'onRequestPut',
    PATCH: 'onRequestPatch',
  }[method];
  return mod[name] || null;
}

async function readRaw(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return null;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function toRequest(req, url, raw) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else headers.set(name, value);
  }
  const body = raw && raw.length ? raw : undefined;
  return new Request(url.href, {
    method: req.method,
    headers,
    body,
    // Node needs this for a streamed body; a Buffer is fine without it.
    duplex: 'half',
  });
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function staticResponse(res, cache, pathname, method, security) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return send(res, 400, { 'content-type': 'text/plain' }, 'bad path');
  }
  if (rel.includes('\0') || rel.includes('\\') || rel.split('/').includes('..')) {
    return send(res, 400, { 'content-type': 'text/plain' }, 'bad path');
  }
  if (rel === '/') rel = '/index.html';
  rel = rel.replace(/^\/+/, '');
  if (blocked(rel)) return send(res, 404, { 'content-type': 'text/plain' }, 'not found');

  let key = rel;
  if (!cache.has(key) && !path.extname(key)) key += '.html';
  if (!cache.has(key) && path.extname(key) === '') key = rel + '/index.html';
  const bytes = cache.get(key);
  if (!bytes) return send(res, 404, { 'content-type': 'text/plain' }, 'not found');

  const ext = path.extname(key);
  const headers = {
    ...security,
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': ext === '.html' ? 'public, max-age=0, must-revalidate' : 'public, max-age=300',
    'content-length': String(bytes.length),
  };
  // Mirror the /sw.js rule in _headers so local browser tests behave like Pages.
  if (rel === 'sw.js') {
    headers['cache-control'] = 'no-cache, must-revalidate';
    headers['service-worker-allowed'] = '/';
    headers['content-type'] = 'application/javascript';
  }
  if (method === 'HEAD') return send(res, 200, headers, '');
  return send(res, 200, headers, bytes);
}

/**
 * Start the local site. Always loopback.
 *
 * @param {object} opts
 * @param {string} [opts.host] must be 127.0.0.1 or localhost
 * @param {number} [opts.port] 0 = ephemeral
 * @param {object} [opts.env] extra env (SPIM_KV is supplied)
 * @param {boolean} [opts.log] log handler errors
 */
export async function startLocalSite(opts = {}) {
  const host = opts.host || '127.0.0.1';
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error(`refusing non-loopback host: ${host}`);
  }

  const kv = opts.kv || new MockKV();
  const db = opts.db || new MockD1();
  const env = {
    ...(opts.env || {}),
    SPIM_KV: kv,
    DB: db,
    SPIM_AUTH_SECRET: (opts.env && opts.env.SPIM_AUTH_SECRET) || 'local-harness-secret',
    SEAM_TEST_MODE: '1',
  };
  const mods = opts.modules || (await loadSiteModules());
  const staticCache = loadStatic();
  const security = readSecurityHeaders();
  const started = Date.now();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || host}`);
    const pathname = url.pathname;

    // Test-only control surface. Loopback + this module's bind guard are the
    // boundary; it is never part of the deployed tree.
    if (pathname.startsWith('/__test/')) {
      if (pathname === '/__test/health') {
        return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify({
          ok: true,
          uptime_ms: Date.now() - started,
          kv_ops: kv.ops,
          kv_keys: kv.map.size,
        }));
      }
      if (pathname === '/__test/stats') {
        return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify({
          kv_ops: kv.ops,
          kv_keys: kv.map.size,
          burn_rows: db.count(),
          reservations: Number(db.db.prepare('SELECT COUNT(*) AS n FROM capsule_reservation').get().n),
          mailboxes: kv.size('seam:env:'),
          prekeys: kv.size('seam:prekey:'),
        }));
      }
      if (pathname === '/__test/reset' && req.method === 'POST') {
        kv.reset();
        db.reset();
        return send(res, 200, { 'content-type': 'application/json' }, '{"ok":true}');
      }
      if (pathname === '/__test/kv') {
        const prefix = url.searchParams.get('prefix') || '';
        const rows = [...kv.map.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, rec]) => ({ key, value: rec.value, expiresAt: rec.expiresAt }));
        return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify({ rows }));
      }
      if (pathname === '/__test/kv/put' && req.method === 'POST') {
        return readRaw(req).then(async (raw) => {
          let body = null;
          try { body = JSON.parse(raw.toString('utf8')); } catch {}
          if (!body || typeof body.key !== 'string' || typeof body.value !== 'string') {
            return send(res, 400, { 'content-type': 'application/json' }, '{"error":"bad kv put"}');
          }
          await kv.put(body.key, body.value, body.options || {});
          return send(res, 200, { 'content-type': 'application/json' }, '{"ok":true}');
        }).catch(() => send(res, 400, { 'content-type': 'application/json' }, '{"error":"bad kv put"}'));
      }
      return send(res, 404, { 'content-type': 'application/json' }, '{"error":"unknown test route"}');
    }

    readRaw(req)
      .then(async (raw) => {
        const request = toRequest(req, url, raw);
        let mod = null;
        let params = {};
        for (const [route, name] of ROUTES) {
          if (pathname === route) {
            mod = mods[name];
            break;
          }
        }
        if (!mod) {
          for (const [re, name] of DYNAMIC) {
            const m = pathname.match(re);
            if (m) {
              mod = mods[name];
              params = { id: m[1] };
              break;
            }
          }
        }

        if (!mod) {
          if (pathname.startsWith('/api/')) {
            return send(res, 404, { 'content-type': 'application/json' }, '{"error":"not found"}');
          }
          return staticResponse(res, staticCache, pathname, req.method, security);
        }

        const handler = methodHandler(mod, req.method);
        if (!handler) {
          return send(res, 405, { 'content-type': 'application/json' }, '{"error":"method not allowed"}');
        }
        const response = await handler({ request, env, params });
        const headers = {};
        for (const [k, v] of response.headers) headers[k] = v;
        const body = req.method === 'HEAD' ? '' : Buffer.from(await response.arrayBuffer());
        return send(res, response.status, headers, body);
      })
      .catch((e) => {
        if (opts.log) console.error('handler error:', e);
        send(res, 500, { 'content-type': 'application/json' }, JSON.stringify({
          error: 'handler error',
          detail: opts.log ? String((e && e.stack) || e) : undefined,
        }));
      });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port || 0, host, resolve);
  });

  const base = `http://${host === '::1' ? '[::1]' : host}:${server.address().port}`;
  return {
    server,
    base,
    env,
    kv,
    db,
    mods,
    async close() {
      if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/* ----------------------------------------------------------------- seed ---- */

/**
 * Seed the KV with load-test data produced by tools/seam-load-prepare.mjs.
 *
 * This writes the same records the real handlers would write: user rows,
 * mailbox ownership, signed prekey bundles, and queued capsules. No handler is
 * bypassed; the seeded state is simply what a busy site would already hold.
 *
 * @param {MockKV} kv
 * @param {object} data
 */
export async function seedLoadData(kv, data) {
  if (!kv || typeof kv.put !== 'function') throw new Error('seedLoadData needs a KV');
  if (!data || typeof data !== 'object') throw new Error('seedLoadData needs data');

  let users = 0;
  for (const user of data.users || []) {
    await kv.put('user:' + user.id, JSON.stringify({
      id: user.id,
      email: user.email,
      salt: user.salt || 'seed-salt',
      hash: user.hash || 'seed-hash',
      created_at: user.created_at || new Date().toISOString(),
    }));
    await kv.put('email:' + user.email, user.id);
    users += 1;
  }

  let prekeys = 0;
  for (const box of data.fetchMailboxes || []) {
    await kv.put('seam:owner:' + box.mailbox, box.owner, { expirationTtl: 60 * 60 * 24 * 30 });
    await kv.put('seam:prekey:' + box.mailbox, JSON.stringify({
      owner: box.owner,
      bundles: box.bundles,
      created_at: data.generated_at,
      expires_at: data.generated_at + 60 * 60 * 24 * 7,
    }), { expirationTtl: 60 * 60 * 24 * 7 });
    prekeys += 1;
  }

  let envelopes = 0;
  for (const box of data.drainMailboxes || []) {
    await kv.put('seam:owner:' + box.mailbox, box.owner, { expirationTtl: 60 * 60 * 24 * 30 });
    for (const message of box.messages || []) {
      await kv.put(`seam:env:${box.mailbox}:${message.id}`, JSON.stringify({
        envelope: message.envelope,
        at: message.at,
      }), { expirationTtl: 60 * 60 * 24 * 7 });
      envelopes += 1;
    }
  }

  for (const box of data.ackMailboxes || []) {
    await kv.put('seam:owner:' + box.mailbox, box.owner, { expirationTtl: 60 * 60 * 24 * 30 });
    for (const message of box.messages || []) {
      await kv.put(`seam:env:${box.mailbox}:${message.id}`, JSON.stringify({
        envelope: message.envelope,
        at: message.at,
      }), { expirationTtl: 60 * 60 * 24 * 7 });
      envelopes += 1;
    }
  }

  return { users, prekeys, envelopes };
}

/** Refuse to run against anything that is not loopback. */
export function assertLocal(base) {
  const u = new URL(base);
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname)) {
    throw new Error(`refusing non-local target: ${base} (production must stay untouched)`);
  }
  return base;
}
