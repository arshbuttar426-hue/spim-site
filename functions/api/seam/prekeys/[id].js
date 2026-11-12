/*
 * Fetch exactly one signed prekey bundle from a mailbox.
 *
 *   GET /api/seam/prekeys/<mailbox>
 *
 * One bundle per call, removed on delivery. A relay bug or a KV race can hand
 * the same one-time prekey to two senders; the recipient's client refuses the
 * second use (`prekey as one_time not_as reused`), so the failure is a refusal
 * rather than a silent key reuse.
 */

import { getJSON, json } from '../../_lib.js';
import {
  PREKEY_TTL,
  clientIp,
  prekeyKey,
  rateLimit,
  validMailbox,
} from '../_lib.js';

export async function onRequestGet({ request, env, params }) {
  if (!env || !env.SPIM_KV) return json(500, { error: 'storage unavailable' });
  const mailbox = String(params.id || '');
  if (!validMailbox(mailbox)) return json(400, { error: 'bad mailbox' });

  if (!(await rateLimit(env, `prekeys:ip:${clientIp(request)}`, 120, 3600))) {
    return json(429, { error: 'too many prekey fetches; try again later' });
  }

  const record = await getJSON(env, prekeyKey(mailbox));
  if (!record || !Array.isArray(record.bundles) || record.bundles.length === 0) {
    return json(404, { error: 'no prekeys available' });
  }

  const bundle = record.bundles[0];
  record.bundles = record.bundles.slice(1);
  if (record.bundles.length === 0) {
    await env.SPIM_KV.delete(prekeyKey(mailbox));
  } else {
    const now = Math.floor(Date.now() / 1000);
    const ttl = Math.max(60, Math.min(PREKEY_TTL, (record.expires_at || now + PREKEY_TTL) - now));
    await env.SPIM_KV.put(prekeyKey(mailbox), JSON.stringify(record), { expirationTtl: ttl });
  }

  return json(200, { bundle, remaining: record.bundles.length });
}

export async function onRequestPost() {
  return json(405, { error: 'method not allowed' });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': 'same-origin',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'content-type',
    },
  });
}
