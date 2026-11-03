import {
  guard,
  json,
  requireUser,
  listJSON,
  putJSON,
  randomId,
  hashSecret,
  readBody,
} from './_lib.js';

const SCOPES = ['capsule:send', 'capsule:receive'];

export async function onRequestGet({ request, env }) {
  const user = await requireUser(request, env);
  if (!user) return json(401, { error: 'not signed in' });
  const keys = await listJSON(env, 'key:' + user.id + ':');
  keys.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return json(200, {
    keys: keys.map(({ hash, ...safe }) => safe),
  });
}

export async function onRequestPost({ request, env }) {
  const blocked = guard(request, env);
  if (blocked) return blocked;
  const user = await requireUser(request, env);
  if (!user) return json(401, { error: 'not signed in' });

  const body = await readBody(request);
  const name = String((body && body.name) || '').trim();
  if (!name) return json(400, { error: 'Enter a key name.' });
  if (name.length > 80) return json(400, { error: 'Key name is too long.' });

  const keyId = 'key_' + randomId(8);
  const secret = 'sk_live_' + randomId(32);
  const prefix = secret.slice(0, 12);
  const hash = await hashSecret(secret);
  const record = {
    id: keyId,
    name,
    prefix,
    scopes: SCOPES,
    created_at: new Date().toISOString(),
    revoked_at: null,
    last_used_at: null,
  };

  await putJSON(env, 'key:' + user.id + ':' + keyId, { ...record, hash });
  await putJSON(env, 'keyhash:' + hash, { user_id: user.id, key_id: keyId });

  return json(201, { key: record, secret });
}

export async function onRequestDelete() {
  return json(405, { error: 'use /api/keys/:id' });
}
