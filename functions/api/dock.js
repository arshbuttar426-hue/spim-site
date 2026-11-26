import {
  guard,
  json,
  actor,
  listJSON,
  getJSON,
  randomId,
  readBody,
} from './_lib.js';
import { dockExpired, publicDockItem, putDock } from './dock/_lib.js';

const CAPSULE_RE = /^[A-Za-z0-9_-]{6,16}$/;

export async function onRequestGet({ request, env }) {
  const user = await actor(request, env);
  if (!user) return json(401, { error: 'not signed in' });
  const items = [];
  for (const raw of await listJSON(env, 'dock:' + user.id + ':')) {
    if (dockExpired(raw)) {
      // Scrub legacy key-bearing rows rather than leaving the secret in KV.
      if (raw.link && raw.id) await env.SPIM_KV.delete('dock:' + user.id + ':' + raw.id);
      continue;
    }
    const item = publicDockItem(raw);
    if (raw.link && item.id) await putDock(env, 'dock:' + user.id + ':' + item.id, item);
    items.push(item);
  }
  items.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return json(200, {
    items,
    waiting: items.filter((i) => i.status === 'docked' || i.status === 'available').length,
  });
}

export async function onRequestPost({ request, env }) {
  const blocked = guard(request, env);
  if (blocked) return blocked;
  const user = await actor(request, env);
  if (!user) return json(401, { error: 'not signed in' });

  const body = await readBody(request);
  const capsuleId = String((body && body.capsule_id) || '');
  const connectionId = String((body && body.connection_id) || '').replace(/[^A-Za-z0-9_]/g, '');
  const sender = String((body && body.sender_name) || user.email || 'You').slice(0, 80);

  if (!CAPSULE_RE.test(capsuleId)) return json(400, { error: 'bad capsule id' });

  let connection = null;
  if (connectionId) {
    connection = await getJSON(env, 'conn:' + user.id + ':' + connectionId);
    if (!connection) return json(404, { error: 'connection not found' });
  }

  const item = {
    id: 'dock_' + randomId(8),
    capsule_id: capsuleId,
    private: !!(body && body.private),
    connection_id: connectionId || null,
    connection_name: connection ? connection.name : null,
    sender_name: sender,
    type: 'capsule',
    status: 'docked',
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
  };
  await putDock(env, 'dock:' + user.id + ':' + item.id, item);
  return json(201, { item: publicDockItem(item) });
}
