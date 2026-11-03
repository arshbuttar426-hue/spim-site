import {
  guard,
  json,
  currentUser,
  apiKeyUser,
  listJSON,
  putJSON,
  getJSON,
  randomId,
  readBody,
} from './_lib.js';

const CAPSULE_RE = /^[A-Za-z0-9_-]{6,16}$/;

async function actor(request, env) {
  return (await currentUser(request, env)) || (await apiKeyUser(request, env));
}

export async function onRequestGet({ request, env }) {
  const user = await actor(request, env);
  if (!user) return json(401, { error: 'not signed in' });
  const items = await listJSON(env, 'dock:' + user.id + ':');
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
  const capsuleId = String((body && body.capsule_id) || '').replace(/[^A-Za-z0-9_-]/g, '');
  const link = String((body && body.link) || '').trim();
  const connectionId = String((body && body.connection_id) || '').replace(/[^A-Za-z0-9_]/g, '');
  const sender = String((body && body.sender_name) || user.email || 'You').slice(0, 80);

  if (!CAPSULE_RE.test(capsuleId)) return json(400, { error: 'bad capsule id' });
  if (!/^https?:\/\/[^\s]+\/receive#c\//.test(link)) return json(400, { error: 'bad capsule link' });

  let connection = null;
  if (connectionId) {
    connection = await getJSON(env, 'conn:' + user.id + ':' + connectionId);
    if (!connection) return json(404, { error: 'connection not found' });
  }

  const item = {
    id: 'dock_' + randomId(8),
    capsule_id: capsuleId,
    link,
    connection_id: connectionId || null,
    connection_name: connection ? connection.name : null,
    sender_name: sender,
    type: 'capsule',
    status: 'docked',
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
  };
  await putJSON(env, 'dock:' + user.id + ':' + item.id, item);
  return json(201, { item });
}
