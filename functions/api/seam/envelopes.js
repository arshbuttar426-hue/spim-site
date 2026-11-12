/*
 * Post an opaque SEAM capsule to a public mailbox.
 *
 *   POST /api/seam/envelopes
 *   { "mailbox": "<32 hex>", "envelope": "<base64 SMW1>" }
 *
 * Anyone holding a published prekey bundle can compute the mailbox, so this
 * endpoint is unauthenticated by design. It is bounded by IP rate limit, body
 * size, and queue depth. The envelope is opaque: the relay never sees a
 * recipient, a sender, or a plaintext.
 */

import { json, readBody } from '../_lib.js';
import {
  ENVELOPE_TTL,
  MAX_QUEUE,
  clientIp,
  envelopeKey,
  looksLikeSeamEnvelope,
  rateLimit,
  validMailbox,
} from './_lib.js';

function randomId(bytes = 12) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
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

  if (!(await rateLimit(env, `env:ip:${clientIp(request)}`, 120, 3600))) {
    return json(429, { error: 'too many messages; try again later' });
  }

  const body = await readBody(request);
  if (!body) return json(400, { error: 'invalid json' });
  const mailbox = body.mailbox;
  if (!validMailbox(mailbox)) return json(400, { error: 'bad mailbox' });
  if (!looksLikeSeamEnvelope(body.envelope)) {
    return json(400, { error: 'envelope is not an SMW1 capsule' });
  }

  const prefix = `seam:env:${mailbox}:`;
  const page = await env.SPIM_KV.list({ prefix, limit: MAX_QUEUE + 1 });
  if (page.keys.length > MAX_QUEUE) {
    return json(429, { error: 'mailbox is full' });
  }

  const id = randomId();
  const at = Math.floor(Date.now() / 1000);
  await env.SPIM_KV.put(
    envelopeKey(mailbox, id),
    JSON.stringify({ envelope: body.envelope, at }),
    { expirationTtl: ENVELOPE_TTL }
  );

  return json(201, { id, at });
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
