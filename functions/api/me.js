import { json, currentUser, apiKeyUser } from './_lib.js';

export async function onRequestGet({ request, env }) {
  const bearer = request.headers.get('authorization');
  const user = (bearer ? await apiKeyUser(request, env) : null) || (await currentUser(request, env));
  if (!user) return json(401, { error: 'not signed in' });
  return json(200, {
    user: { id: user.id, email: user.email || null },
    via: user.via || 'session',
  });
}
