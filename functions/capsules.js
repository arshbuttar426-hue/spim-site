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

async function proxy(request, env, path) {
  const target = (await origin(env)).replace(/\/+$/, "") + path;
  const init = { method: request.method, headers: {} };
  const type = request.headers.get("content-type");
  if (type) init.headers["content-type"] = type;
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.text();
  }
  let res;
  try {
    res = await fetch(target, init);
  } catch (e) {
    return json(502, { error: "upstream unreachable", detail: String((e && e.message) || e) });
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

export async function onRequestPost({ request, env }) {
  return proxy(request, env, "/capsules");
}

export async function onRequestGet() {
  return json(405, { error: "method not allowed" });
}
