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

export async function onRequestGet({ env, params }) {
  const id = String(params.id || "").replace(/[^A-Za-z0-9_-]/g, "");
  if (!id) return json(400, { error: "bad id" });
  if (!env || !env.SPIM_KV) return json(500, { error: "storage unavailable" });
  const raw = await env.SPIM_KV.get("capsule:" + id);
  if (!raw) return json(404, { error: "not found" });
  let data;
  try { data = JSON.parse(raw); } catch { return json(500, { error: "corrupt capsule" }); }
  if (data.consumed) return json(410, { error: "destroyed", message: "This delivery has already been opened." });
  return json(200, { blob: data.blob, destroyable: !!data.destroyable });
}
