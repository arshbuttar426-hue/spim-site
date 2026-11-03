import { json, currentUser, apiKeyUser, getJSON } from '../_lib.js';

async function actor(request, env) {
  return (await currentUser(request, env)) || (await apiKeyUser(request, env));
}

export async function onRequestDelete({ request, env, params }) {
  const user = await actor(request, env);
  if (!user) return json(401, { error: 'not signed in' });
  const id = String(params.id || '').replace(/[^A-Za-z0-9_]/g, '');
  if (!id) return json(400, { error: 'bad connection id' });
  const key = 'conn:' + user.id + ':' + id;
  const existing = await getJSON(env, key);
  if (!existing) return json(404, { error: 'connection not found' });
  await env.SPIM_KV.delete(key);
  return json(200, { ok: true });
}
