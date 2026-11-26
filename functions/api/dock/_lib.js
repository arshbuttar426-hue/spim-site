/*
 * Dock storage rules. Dock rows hold a capsule reference only — links can carry
 * a private key and must never be stored by the server. All writes carry a
 * real KV TTL, and expired rows are treated as absent.
 */
export const DOCK_TTL_SECONDS = 24 * 60 * 60;

export function dockExpired(item, now = Date.now()) {
  return !!(item && item.expires_at && Date.parse(item.expires_at) <= now);
}

export function publicDockItem(item) {
  if (!item) return null;
  const out = Object.assign({}, item);
  delete out.link;
  return out;
}

export async function putDock(env, key, item) {
  await env.SPIM_KV.put(key, JSON.stringify(publicDockItem(item)), {
    expirationTtl: DOCK_TTL_SECONDS
  });
}
