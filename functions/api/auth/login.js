import {
  guard,
  json,
  normalizeEmail,
  verifyPassword,
  publicUser,
  signSession,
  sessionCookie,
  getJSON,
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
  if (!email || !password) return json(400, { error: 'Email and password are required.' });

  const id = await env.SPIM_KV.get('email:' + email);
  const user = id ? await getJSON(env, 'user:' + id) : null;

  // Always run one PBKDF2 derivation so a missing account is not faster than a
  // wrong password, and always give the same message.
  const salt = user ? user.salt : 'AAAAAAAAAAAAAAAAAAAAAA==';
  const expected = user ? user.hash : 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  const ok = await verifyPassword(password, salt, expected);

  if (!user || !ok) {
    return json(401, { error: 'Email or password is incorrect.' });
  }

  const { token, expires_at } = await signSession(user, env.SPIM_AUTH_SECRET);
  return json(
    200,
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
