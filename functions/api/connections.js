import { guard, json, requireUser, listJSON, putJSON, randomId, readBody } from './_lib.js';

const KINDS = new Set(['person', 'team', 'agent', 'self']);

export async function onRequestGet({ request, env }) {
  const user = await requireUser(request, env);
  if (!user) return json(401, { error: 'not signed in' });
  const connections = await listJSON(env, 'conn:' + user.id + ':');
  connections.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return json(200, { connections });
}

export async function onRequestPost({ request, env }) {
  const blocked = guard(request, env);
  if (blocked) return blocked;
  const user = await requireUser(request, env);
  if (!user) return json(401, { error: 'not signed in' });

  const body = await readBody(request);
  const name = String((body && body.name) || '').trim();
  const kind = String((body && body.kind) || 'person').trim().toLowerCase();
  if (!name) return json(400, { error: 'Enter a name.' });
  if (name.length > 80) return json(400, { error: 'Name is too long.' });
  if (!KINDS.has(kind)) return json(400, { error: 'Unknown connection kind.' });

  const existing = await listJSON(env, 'conn:' + user.id + ':');
  if (existing.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
    return json(409, { error: 'That connection already exists.' });
  }

  const connection = {
    id: 'conn_' + randomId(8),
    name,
    kind,
    created_at: new Date().toISOString(),
  };
  await putJSON(env, 'conn:' + user.id + ':' + connection.id, connection);
  return json(201, { connection });
}
