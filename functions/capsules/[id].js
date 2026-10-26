const DEFAULT_ORIGIN = "https://administration-witch-catalogue-characteristic.trycloudflare.com";

function origin(env) {
  return (env && env.SPIM_ORIGIN) || DEFAULT_ORIGIN;
}

async function proxy(request, env, path) {
  const target = origin(env).replace(/\/+$/, "") + path;
  let res;
  try {
    res = await fetch(target, { method: request.method, headers: { accept: "application/json" } });
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

export async function onRequestGet({ request, env, params }) {
  const id = String(params.id || "").replace(/[^A-Za-z0-9_-]/g, "");
  if (!id) {
    return new Response(JSON.stringify({ error: "bad id" }), {
      status: 400,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  return proxy(request, env, "/capsules/" + encodeURIComponent(id));
}
