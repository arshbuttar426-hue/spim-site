const DEFAULT_ORIGIN = "https://administration-witch-catalogue-characteristic.trycloudflare.com";

async function origin(env) {
  try {
    if (env && env.SPIM_KV) {
      const current = await env.SPIM_KV.get("origin");
      if (current) return current;
    }
  } catch (e) {}
  return (env && env.SPIM_ORIGIN) || DEFAULT_ORIGIN;
}

export async function onRequestPost({ env, params }) {
  const id = String(params.id || "").replace(/[^A-Za-z0-9_-]/g, "");
  if (!id) {
    return new Response(JSON.stringify({ error: "bad id" }), {
      status: 400,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  const target = (await origin(env)).replace(/\/+$/, "") + "/capsules/" + encodeURIComponent(id) + "/consume";
  let res;
  try {
    res = await fetch(target, { method: "POST", headers: { accept: "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: "upstream unreachable" }), {
      status: 502,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }
  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: {
      "content-type": res.headers.get("content-type") || "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}
