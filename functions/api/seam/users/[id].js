/*
 * Resolve an address to a mailbox.
 *
 *   GET /api/seam/users/<id>
 *
 * `<id>` is either a public account id (`usr_…`) or a SEAM device identity id.
 * The answer is only a mailbox: the caller still fetches one signed prekey
 * bundle and derives everything else on its own. No key, no message, and no
 * plaintext passes through this route.
 *
 * Sign-in is required so the address space cannot be enumerated anonymously.
 * A binding is written when a device publishes prekeys and expires with them,
 * so an address is live exactly while its owner is using SEAM.
 */

import { currentUser, getJSON, json } from '../../_lib.js';
import { identKey, rateLimit, userKey } from '../_lib.js';

const ADDRESS_RE = /^(?:usr_[0-9a-z]{8,32}|[0-9a-z]{8,32})$/;

export async function onRequestGet({ request, env, params }) {
  if (!env || !env.SPIM_KV) return json(500, { error: 'storage unavailable' });

  const id = String(params.id || '').toLowerCase();
  if (!ADDRESS_RE.test(id)) return json(400, { error: 'bad address' });

  const user = await currentUser(request, env);
  if (!user) return json(401, { error: 'sign in to look up an address' });

  if (!(await rateLimit(env, `users:user:${user.id}`, 120, 3600))) {
    return json(429, { error: 'too many lookups; try again later' });
  }

  const binding = (await getJSON(env, userKey(id))) || (await getJSON(env, identKey(id)));
  if (!binding || !binding.mailbox) {
    return json(404, { error: 'no channel at that address' });
  }

  return json(200, {
    id: binding.user,
    mailbox: binding.mailbox,
    device: binding.device || null,
    expires_at: binding.expires_at,
  });
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
