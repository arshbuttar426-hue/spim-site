import { currentUser, json, getJSON, publicUser } from '../_lib.js';

export async function onRequestGet({ request, env }) {
  const user = await currentUser(request, env);
  if (!user) return json(401, { error: 'not signed in' });

  // The JWT is the source of identity. The KV record is used for profile data
  // when it is available; a fresh registration can take a moment to replicate.
  const record = await getJSON(env, 'user:' + user.id);
  const profile = record ? publicUser(record) : { id: user.id, email: user.email, created_at: null };

  return json(200, {
    user: profile,
    session: { user: profile, expires_at: user.expires_at },
  });
}
