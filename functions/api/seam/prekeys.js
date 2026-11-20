/*
 * Publish signed SEAM prekey bundles.
 *
 *   POST /api/seam/prekeys
 *   { "mailbox": "<32 hex>", "bundles": [ <signed bundle>, ... ] }
 *
 * The relay cannot verify a signature — it has no business holding keys that
 * could do so. It enforces shape and quota; the recipient's client verifies the
 * signature and the identity binding before the first message is sent.
 */

import { currentUser, getJSON, json, readBody } from '../_lib.js';
import {
  MAX_BUNDLES,
  MAX_BUNDLE_BYTES,
  OWNER_TTL,
  PREKEY_TTL,
  identKey,
  ownerKey,
  prekeyKey,
  rateLimit,
  userKey,
  validMailbox,
} from './_lib.js';

function validBundle(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return false;
  if (b.v !== 1) return false;
  if (typeof b.id !== 'string' || b.id.length < 16 || b.id.length > 64) return false;
  for (const field of ['ed', 'x', 'spk', 'spk_sig', 'sig']) {
    if (typeof b[field] !== 'string' || b[field].length === 0) return false;
  }
  if (!Array.isArray(b.opk) || b.opk.length !== 1) return false;
  if (typeof b.opk[0] !== 'string' || b.opk[0].length === 0) return false;
  if (!Number.isInteger(b.created_at) || !Number.isInteger(b.expires_at)) return false;
  if (b.expires_at <= b.created_at) return false;
  try {
    return JSON.stringify(b).length <= MAX_BUNDLE_BYTES;
  } catch {
    return false;
  }
}

export async function onRequestPost({ request, env }) {
  if (!env || !env.SPIM_KV) return json(500, { error: 'storage unavailable' });
  const origin = request.headers.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host !== new URL(request.url).host) {
        return json(403, { error: 'cross-origin request rejected' });
      }
    } catch {
      return json(403, { error: 'cross-origin request rejected' });
    }
  }

  const user = await currentUser(request, env);
  if (!user) return json(401, { error: 'sign in to publish prekeys' });

  if (!(await rateLimit(env, `prekeys:user:${user.id}`, 20, 3600))) {
    return json(429, { error: 'too many prekey publishes; try again later' });
  }

  const body = await readBody(request);
  if (!body) return json(400, { error: 'invalid json' });
  const mailbox = body.mailbox;
  if (!validMailbox(mailbox)) return json(400, { error: 'bad mailbox' });

  const bundles = body.bundles;
  if (!Array.isArray(bundles) || bundles.length === 0) {
    return json(400, { error: 'bundles must be a non-empty array' });
  }
  if (bundles.length > MAX_BUNDLES) {
    return json(400, { error: `at most ${MAX_BUNDLES} bundles per publish` });
  }
  for (const b of bundles) {
    if (!validBundle(b)) return json(400, { error: 'malformed bundle' });
    if (b.id !== undefined && b.expires_at * 1000 < Date.now()) {
      return json(400, { error: 'bundle already expired' });
    }
  }

  // A mailbox is derived from a device's public agreement key, so it is a
  // capability. Let its first publisher keep it for the life of the binding:
  // otherwise anyone who can resolve an address could replace the bundles and
  // take over the owner record.
  const [currentOwner, existing] = await Promise.all([
    env.SPIM_KV.get(ownerKey(mailbox)),
    getJSON(env, prekeyKey(mailbox)),
  ]);
  if (
    (currentOwner && currentOwner !== user.id) ||
    (existing && existing.owner && existing.owner !== user.id)
  ) {
    return json(409, { error: 'that address belongs to another account' });
  }

  const now = Math.floor(Date.now() / 1000);
  const record = {
    owner: user.id,
    bundles,
    created_at: now,
    expires_at: now + PREKEY_TTL,
  };
  await env.SPIM_KV.put(prekeyKey(mailbox), JSON.stringify(record), {
    expirationTtl: PREKEY_TTL,
  });
  await env.SPIM_KV.put(ownerKey(mailbox), user.id, { expirationTtl: OWNER_TTL });

  // Make this account and this device addressable without exposing a key.
  // Both records live exactly as long as the prekeys they point at. `device`
  // lets the client check that the bundle it fetched is the one this address
  // resolved to, instead of trusting whatever currently sits at the mailbox.
  const deviceId = bundles[0] && bundles[0].id;
  const binding = JSON.stringify({
    user: user.id,
    mailbox,
    device: deviceId || null,
    created_at: now,
    expires_at: record.expires_at,
  });
  await env.SPIM_KV.put(userKey(user.id), binding, { expirationTtl: PREKEY_TTL });
  if (deviceId) {
    await env.SPIM_KV.put(identKey(deviceId), binding, { expirationTtl: PREKEY_TTL });
  }

  return json(201, { mailbox, stored: bundles.length, expires_at: record.expires_at });
}

export async function onRequestGet() {
  return json(405, { error: 'method not allowed' });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': 'same-origin',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    },
  });
}
