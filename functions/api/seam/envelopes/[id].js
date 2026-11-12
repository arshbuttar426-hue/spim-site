/*
 * Drain a mailbox.
 *
 *   GET /api/seam/envelopes/<mailbox>
 *
 * Requires the account that published the mailbox's prekeys. The relay cannot
 * tell whether a capsule is valid, only that it belongs to this mailbox. A
 * client must ack after it has persisted its ratchet state and refused or
 * accepted each capsule; an unacked message stays for the next poll.
 */

import { currentUser, getJSON, json } from '../../_lib.js';
import { MAX_QUEUE, envelopeKey, ownerKey, validMailbox } from '../_lib.js';

export async function onRequestGet({ request, env, params }) {
  if (!env || !env.SPIM_KV) return json(500, { error: 'storage unavailable' });
  const mailbox = String(params.id || '');
  if (!validMailbox(mailbox)) return json(400, { error: 'bad mailbox' });

  const user = await currentUser(request, env);
  if (!user) return json(401, { error: 'sign in to read this mailbox' });

  const owner = await env.SPIM_KV.get(ownerKey(mailbox));
  if (!owner || owner !== user.id) return json(403, { error: 'not your mailbox' });

  const prefix = `seam:env:${mailbox}:`;
  const page = await env.SPIM_KV.list({ prefix, limit: MAX_QUEUE });
  const messages = [];
  for (const key of page.keys) {
    const value = await getJSON(env, key.name);
    if (!value || typeof value.envelope !== 'string') continue;
    messages.push({
      id: key.name.slice(prefix.length),
      at: value.at,
      envelope: value.envelope,
    });
  }
  messages.sort((a, b) => (a.at || 0) - (b.at || 0));

  return json(200, { mailbox, count: messages.length, messages });
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
