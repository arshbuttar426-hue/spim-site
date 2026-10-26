function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export async function onRequestPost({ request, env }) {
  const expected = (env && env.SPIM_UPDATE_TOKEN) || "";
  const token = request.headers.get("x-update-token") || "";
  if (!expected || token !== expected) {
    return json(403, { error: "forbidden" });
  }
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json(400, { error: "invalid json" });
  }
  const origin = String((body && body.origin) || "");
  if (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(origin)) {
    return json(400, { error: "invalid origin" });
  }
  await env.SPIM_KV.put("origin", origin);
  return json(200, { ok: true, origin });
}

export async function onRequestGet() {
  return json(405, { error: "method not allowed" });
}
