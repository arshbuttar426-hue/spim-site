import { guard, json, actor, getJSON, putJSON, readBody } from '../_lib.js';

const ACTIONS = new Set(['unload', 'reject']);

export async function onRequestPost({ request, env, params }) {
  const blocked = guard(request, env);
  if (blocked) return blocked;
  const user = await actor(request, env);
  if (!user) return json(401, { error: 'not signed in' });

  const id = String(params.id || '').replace(/[^A-Za-z0-9_]/g, '');
  if (!id) return json(400, { error: 'bad dock id' });
  const body = await readBody(request);
  const action = String((body && body.action) || '').toLowerCase();
  if (!ACTIONS.has(action)) return json(400, { error: 'action must be unload or reject' });

  const key = 'dock:' + user.id + ':' + id;
  const item = await getJSON(env, key);
  if (!item) return json(404, { error: 'dock item not found' });

  item.status = action === 'unload' ? 'unloaded' : 'rejected';
  item[action + '_at'] = new Date().toISOString();
  await putJSON(env, key, item);
  return json(200, { item });
}

export async function onRequestGet({ request, env, params }) {
  const blocked = guard(request, env);
  if (blocked) return blocked;
  const user = await actor(request, env);
  if (!user) return json(401, { error: 'not signed in' });
  const id = String(params.id || '').replace(/[^A-Za-z0-9_]/g, '');
  const item = await getJSON(env, 'dock:' + user.id + ':' + id);
  if (!item) return json(404, { error: 'dock item not found' });
  return json(200, { item });
}
