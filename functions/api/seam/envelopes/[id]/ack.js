/*
 * Acknowledge capsules after the client has persisted its state.
 *
 *   POST /api/seam/envelopes/<mailbox>/ack
 *   { "ids": ["<id>", ...] }
 *
 * Only the mailbox owner can ack. Deleting an id that is not in this mailbox is
 * a no-op, so a stale ack cannot remove someone else's message.
 */

import { currentUser, json, readBody } from '../../../_lib.js';
import { MAX_QUEUE, envelopeKey, ownerKey, validId, validMailbox } from '../../_lib.js';

export async function onRequestPost({ request, env, params }) {
  if (!env || !env.SPIM_KV) return json(500, { error: 'storage unavailable' });
  const mailbox = String(params.id || '');
  if (!validMailbox(mailbox)) return json(400, { error: 'bad mailbox' });

  const user = await currentUser(request, env);
  if (!user) return json(401, { error: 'sign in to acknowledge this mailbox' });

  const owner = await env.SPIM_KV.get(ownerKey(mailbox));
  if (!owner || owner !== user.id) return json(403, { error: 'not your mailbox' });

  const body = await readBody(request);
  if (!body || !Array.isArray(body.ids)) return json(400, { error: 'ids must be an array' });
  if (body.ids.length > MAX_QUEUE) return json(400, { error: 'too many ids in one ack' });

  let removed = 0;
  for (const id of body.ids) {
    if (!validId(id)) continue;
    await env.SPIM_KV.delete(envelopeKey(mailbox, id));
    removed += 1;
  }

  const page = await env.SPIM_KV.list({ prefix: `seam:env:${mailbox}:`, limit: MAX_QUEUE });
  return json(200, { removed, remaining: page.keys.length });
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
