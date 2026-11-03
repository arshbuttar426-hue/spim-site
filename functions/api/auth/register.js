import {
  guard,
  json,
  normalizeEmail,
  validEmail,
  hashPassword,
  publicUser,
  signSession,
  sessionCookie,
  randomId,
  putJSON,
  readBody,
} from '../_lib.js';

export async function onRequestOptions() {
  return new Response(null, { status: 204 });
}

export async function onRequestPost({ request, env }) {
  const blocked = guard(request, env);
  if (blocked) return blocked;

  const body = await readBody(request);
  if (!body) return json(400, { error: 'invalid json' });

  const email = normalizeEmail(body.email);
  const password = String(body.password || '');

  if (!validEmail(email)) return json(400, { error: 'Enter a valid email address.' });
  if (password.length < 8) return json(400, { error: 'Password must be at least 8 characters.' });
  if (password.length > 200) return json(400, { error: 'Password is too long.' });

  const existing = await env.SPIM_KV.get('email:' + email);
  if (existing) return json(409, { error: 'An account with this email already exists.' });

  const id = 'usr_' + randomId(9);
  const { salt, hash } = await hashPassword(password);
  const user = {
    id,
    email,
    salt,
    hash,
    created_at: new Date().toISOString(),
  };

  await putJSON(env, 'user:' + id, user);
  await env.SPIM_KV.put('email:' + email, id);

  const { token, expires_at } = await signSession(user, env.SPIM_AUTH_SECRET);
  return json(
    201,
    {
      user: publicUser(user),
      session: { user: publicUser(user), expires_at },
    },
    { 'set-cookie': sessionCookie(request, token, 604800) }
  );
}

export async function onRequestGet() {
  return json(405, { error: 'method not allowed' });
}
