function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

function randomId(len = 8) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  // Rejection sampling: 256 is not a multiple of 62, so taking `byte % 62`
  // would make the first 8 characters slightly more likely.
  const max = 256 - (256 % chars.length);
  let out = "";
  while (out.length < len) {
    const bytes = new Uint8Array(len * 2);
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b >= max) continue;
      out += chars[b % chars.length];
      if (out.length === len) break;
    }
  }
  return out;
}

// Capsules are disposable. Keep the blob long enough for a delayed open, then
// let KV reclaim it even if nobody ever consumes it.
const CAPSULE_TTL = 60 * 60 * 24 * 30;

export async function onRequestPost({ request, env }) {
  try {
    if (!env || !env.SPIM_KV) return json(500, { error: "storage unavailable" });
    const text = await request.text();
    let data;
    try { data = JSON.parse(text || "{}"); } catch { return json(400, { error: "invalid json" }); }
    const blob = data.blob;
    const destroyable = !!data.destroyable;
    if (typeof blob !== "string" || blob.length === 0 || blob.length > 2 * 1024 * 1024) {
      return json(400, { error: "bad blob" });
    }
    // validate base64-ish
    if (!/^[A-Za-z0-9+/=]+$/.test(blob)) return json(400, { error: "blob not base64" });
    const id = randomId(8);
    await env.SPIM_KV.put("capsule:" + id, JSON.stringify({ blob, destroyable, consumed: false }), {
      expirationTtl: CAPSULE_TTL,
    });
    return json(201, { id });
  } catch (e) {
    return json(500, { error: "create failed" });
  }
}

export async function onRequestGet() {
  return json(405, { error: "method not allowed" });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    },
  });
}
