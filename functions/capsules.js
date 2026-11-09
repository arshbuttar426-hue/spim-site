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
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

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
    await env.SPIM_KV.put("capsule:" + id, JSON.stringify({ blob, destroyable, consumed: false }));
    return json(201, { id });
  } catch (e) {
    return json(500, { error: "create failed", detail: String((e && e.message) || e) });
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
