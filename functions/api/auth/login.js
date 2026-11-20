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
  clientIp,
  rateLimitPeek,
  rateLimitHit,
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
  if (!email || !password || email.length > 254 || password.length > 200) {
    return json(400, { error: 'Email and password are required.' });
  }

  // Two brakes: one per connection, one per address. The address bucket also
  // stops a slow guess against a single account from many IPs. Only failures
  // are counted, so a normal sign-in never uses up the allowance.
  const ipBucket = `login:ip:${clientIp(request)}`;
  const emailBucket = `login:email:${email}`;
  if (
    !(await rateLimitPeek(env, ipBucket, 30, 15 * 60)) ||
    !(await rateLimitPeek(env, emailBucket, 10, 15 * 60))
  ) {
    return json(429, { error: 'Too many attempts. Try again in a few minutes.' });
  }

  const id = await env.SPIM_KV.get('email:' + email);
  const user = id ? await getJSON(env, 'user:' + id) : null;

  // Always run one PBKDF2 derivation so a missing account is not faster than a
  // wrong password, and always give the same message.
  const salt = user ? user.salt : 'AAAAAAAAAAAAAAAAAAAAAA==';
  const expected = user ? user.hash : 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  const ok = await verifyPassword(password, salt, expected);

  if (!user || !ok) {
    await rateLimitHit(env, ipBucket, 15 * 60);
    await rateLimitHit(env, emailBucket, 15 * 60);
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
