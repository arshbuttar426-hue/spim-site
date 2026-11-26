import { guard, json, actor, getJSON, readBody } from '../_lib.js';
import { dockExpired, publicDockItem, putDock } from './_lib.js';

const ACTIONS = new Set(['unload', 'reject']);

async function notFound(env, key, item) {
  if (item && item.link) await env.SPIM_KV.delete(key);
  return json(404, { error: 'dock item not found' });
}

export async function onRequestPost({ request, env, params }) {
  const blocked = guard(request, env);
  if (blocked) return blocked;
  const user = await actor(request, env);
  if (!user) return json(401, { error: 'not signed in' });

  const id = String(params.id || '');
  if (!/^[A-Za-z0-9_]+$/.test(id)) return json(400, { error: 'bad dock id' });
  const body = await readBody(request);
  const action = String((body && body.action) || '').toLowerCase();
  if (!ACTIONS.has(action)) return json(400, { error: 'action must be unload or reject' });

  const key = 'dock:' + user.id + ':' + id;
  const item = await getJSON(env, key);
  if (!item || dockExpired(item)) return notFound(env, key, item);

  item.status = action === 'unload' ? 'unloaded' : 'rejected';
  item[action + '_at'] = new Date().toISOString();
  await putDock(env, key, item);
  return json(200, { item: publicDockItem(item) });
}

export async function onRequestGet({ request, env, params }) {
  const user = await actor(request, env);
  if (!user) return json(401, { error: 'not signed in' });
  const id = String(params.id || '');
  if (!/^[A-Za-z0-9_]+$/.test(id)) return json(400, { error: 'bad dock id' });
  const key = 'dock:' + user.id + ':' + id;
  const item = await getJSON(env, key);
  if (!item || dockExpired(item)) return notFound(env, key, item);
  const safe = publicDockItem(item);
  if (item.link) await putDock(env, key, safe);
  return json(200, { item: safe });
}
