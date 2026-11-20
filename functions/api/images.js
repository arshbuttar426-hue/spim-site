import { guard, json, requireUser, getJSON, putJSON, readBody, IMAGE_LIMIT } from './_lib.js';

export async function onRequestGet({ request, env }) {
  const user = await requireUser(request, env);
  if (!user) return json(401, { error: 'not signed in' });
  const quota = (await getJSON(env, 'quota:' + user.id)) || { used: 0, paid: false };
  const remaining = Math.max(0, IMAGE_LIMIT - quota.used);
  return json(200, {
    used: quota.used,
    limit: IMAGE_LIMIT,
    remaining,
    paid: !!quota.paid,
    enabled: quota.paid || remaining > 0,
  });
}

export async function onRequestPost({ request, env }) {
  const blocked = guard(request, env);
  if (blocked) return blocked;
  const user = await requireUser(request, env);
  if (!user) return json(401, { error: 'not signed in' });

  const body = await readBody(request);
  const action = String((body && body.action) || 'use');
  const key = 'quota:' + user.id;
  const quota = (await getJSON(env, key)) || { used: 0, paid: false };

  if (action === 'use') {
    if (!quota.paid && quota.used >= IMAGE_LIMIT) {
      return json(402, { error: 'You have used your 16 free images.', ...quotaView(quota) });
    }
    quota.used += 1;
    await putJSON(env, key, quota);
  } else {
    // Quota is not client-resettable. Only an explicit paid-plan change or a
    // server-side migration may set `used` back to zero.
    return json(400, { error: 'unknown action' });
  }

  return json(200, quotaView(quota));
}

function quotaView(quota) {
  const remaining = Math.max(0, IMAGE_LIMIT - quota.used);
  return {
    used: quota.used,
    limit: IMAGE_LIMIT,
    remaining,
    paid: !!quota.paid,
    enabled: quota.paid || remaining > 0,
  };
}
