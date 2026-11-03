import { json, getJSON, hashSecret, readBody, guard } from '../_lib.js';

/*
 * POST /api/keys/verify  { secret }
 * Also accepts `Authorization: Bearer sk_live_...`.
 * Returns the owning user id and key metadata, never the stored hash.
 */
export async function onRequestPost({ request, env }) {
  const blocked = guard(request, env);
  if (blocked) return blocked;
  const body = await readBody(request);
  const header = request.headers.get('authorization') || '';
  const bearer = (header.match(/^Bearer\s+(.+)$/i) || [])[1];
  const secret = String((body && body.secret) || bearer || '').trim();
  if (!secret.startsWith('sk_live_')) return json(400, { valid: false, error: 'not an API key' });

  const hash = await hashSecret(secret);
  const index = await getJSON(env, 'keyhash:' + hash);
  if (!index) return json(401, { valid: false, error: 'unknown or revoked key' });
  const record = await getJSON(env, 'key:' + index.user_id + ':' + index.key_id);
  if (!record || record.revoked_at) return json(401, { valid: false, error: 'unknown or revoked key' });

  return json(200, {
    valid: true,
    user_id: index.user_id,
    key: { id: record.id, name: record.name, prefix: record.prefix, scopes: record.scopes },
  });
}
