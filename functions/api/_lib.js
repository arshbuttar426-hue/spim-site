/*
 * Shared helpers for the Pages Functions API.
 *
 * Auth is real: passwords are PBKDF2-SHA256 hashed, sessions are HMAC-signed
 * JWTs delivered in an HttpOnly cookie, and account data lives in KV under the
 * SPIM_KV binding. Nothing here trusts the client for identity.
 */

const enc = new TextEncoder();
const PBKDF2_ITERATIONS = 100000; // Cloudflare Workers rejects PBKDF2 counts above 100,000.
const SESSION_TTL = 60 * 60 * 24 * 7; // 7 days

export const COOKIE = 'spim_session';
export const IMAGE_LIMIT = 16;

export function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

export function randomId(bytes = 10) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return [...b].map((x) => x.toString(36).padStart(2, '0')).join('').slice(0, bytes * 2);
}

function b64urlEncode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64Encode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64Decode(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function constantTimeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function hashPassword(password, saltB64) {
  const salt = saltB64 ? b64Decode(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256
  );
  return { salt: b64Encode(salt), hash: b64Encode(new Uint8Array(bits)) };
}

export async function verifyPassword(password, saltB64, expectedB64) {
  const { hash } = await hashPassword(password, saltB64);
  return constantTimeEqual(b64Decode(hash), b64Decode(expectedB64));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
}

export async function signSession(user, secret) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + SESSION_TTL;
  const header = b64urlEncode(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = b64urlEncode(
    enc.encode(JSON.stringify({ sub: user.id, email: user.email, iat: now, exp }))
  );
  const data = header + '.' + payload;
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(data)));
  return {
    token: data + '.' + b64urlEncode(sig),
    expires_at: new Date(exp * 1000).toISOString(),
  };
}

export async function verifySession(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const data = parts[0] + '.' + parts[1];
  let given;
  let payload;
  try {
    given = b64urlDecode(parts[2]);
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
  } catch {
    return null;
  }
  const expected = new Uint8Array(
    await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(data))
  );
  if (!constantTimeEqual(expected, given)) return null;
  if (!payload || typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }
  return payload;
}

export function readCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return '';
}

export function sessionCookie(request, token, maxAge) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/${secure}; Max-Age=${maxAge}`;
}

/** Resolve the signed-in user from the session cookie, or null. */
export async function currentUser(request, env) {
  const secret = env && env.SPIM_AUTH_SECRET;
  if (!secret) return null;
  const payload = await verifySession(readCookie(request, COOKIE), secret);
  if (!payload) return null;
  return { id: payload.sub, email: payload.email, expires_at: new Date(payload.exp * 1000).toISOString() };
}

export async function requireUser(request, env) {
  const user = await currentUser(request, env);
  return user;
}

export function publicUser(user) {
  return { id: user.id, email: user.email, created_at: user.created_at || null };
}

/** SHA-256 hex of an API key secret. */
export async function hashSecret(secret) {
  const bits = await crypto.subtle.digest('SHA-256', enc.encode(secret));
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Resolve a Bearer API key to the owning user, or null. */
export async function apiKeyUser(request, env) {
  if (!env || !env.SPIM_KV) return null;
  const header = request.headers.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const secret = match[1].trim();
  if (!secret.startsWith('sk_live_')) return null;
  const hash = await hashSecret(secret);
  const index = await getJSON(env, 'keyhash:' + hash);
  if (!index || !index.user_id) return null;
  const record = await getJSON(env, 'key:' + index.user_id + ':' + index.key_id);
  if (!record || record.revoked_at) return null;
  record.last_used_at = new Date().toISOString();
  // Failure-proofing: last_used_at is telemetry — a KV write failure must not
  // turn a successful auth into a 500.
  try {
    await putJSON(env, 'key:' + index.user_id + ':' + index.key_id, record);
  } catch (e) {
    // telemetry only; ignore
  }
  return { id: index.user_id, email: null, via: 'api_key' };
}

export async function getJSON(env, key) {
  const raw = await env.SPIM_KV.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function putJSON(env, key, value) {
  await env.SPIM_KV.put(key, JSON.stringify(value));
}

export async function listJSON(env, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await env.SPIM_KV.list({ prefix, cursor });
    for (const key of page.keys) {
      const value = await getJSON(env, key.name);
      if (value) out.push(value);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

export function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 254;
}

export async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export function badOrigin(request) {
  // Same-origin JSON endpoints: reject cross-site form posts outright.
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).host !== new URL(request.url).host;
  } catch {
    return true;
  }
}

export function guard(request, env) {
  if (!env.SPIM_AUTH_SECRET) return json(503, { error: 'auth is not configured' });
  if (badOrigin(request)) return json(403, { error: 'cross-origin request rejected' });
  return null;
}
