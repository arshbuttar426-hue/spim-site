import {
  guard,
  json,
  actor,
  getJSON,
  putJSON,
  readBody,
} from '../_lib.js';

export async function onRequestDelete({ request, env, params }) {
  const blocked = guard(request, env);
  if (blocked) return blocked;
  const user = await actor(request, env);
  if (!user) return json(401, { error: 'not signed in' });
  const id = String(params.id || '').replace(/[^A-Za-z0-9_]/g, '');
  if (!id) return json(400, { error: 'bad key id' });
  const record = await getJSON(env, 'key:' + user.id + ':' + id);
  if (!record) return json(404, { error: 'key not found' });
  if (!record.revoked_at) {
    record.revoked_at = new Date().toISOString();
    await putJSON(env, 'key:' + user.id + ':' + id, record);
    if (record.hash) {
      await env.SPIM_KV.delete('keyhash:' + record.hash);
    }
  }
  return json(200, { ok: true, key: { ...record, hash: undefined } });
}

export async function onRequestPost({ request, env, params }) {
  const blocked = guard(request, env);
  if (blocked) return blocked;
  const body = await readBody(request);
  if (body && body.action === 'revoke') {
    return onRequestDelete({ request, env, params });
  }
  return json(400, { error: 'unknown action' });
}

export async function onRequestGet({ request, env, params }) {
  const user = await actor(request, env);
  if (!user) return json(401, { error: 'not signed in' });
  const id = String(params.id || '').replace(/[^A-Za-z0-9_]/g, '');
  const record = await getJSON(env, 'key:' + user.id + ':' + id);
  if (!record) return json(404, { error: 'key not found' });
  return json(200, { key: { ...record, hash: undefined } });
}
