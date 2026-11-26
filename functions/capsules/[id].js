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

function fail(status, error, message) {
  return json(status, { error, message });
}

const DESTROYED = "This delivery has already been opened.";

function validId(raw) {
  return /^[A-Za-z0-9_-]{6,16}$/.test(String(raw || ""));
}

async function burned(env, id) {
  if (!env.DB) return null;
  try {
    const legacy = await env.DB
      .prepare("SELECT consumed_at FROM capsule_burn WHERE id = ?1")
      .bind(id)
      .first();
    if (legacy) return true;
    const current = await env.DB
      .prepare("SELECT consumed_at FROM capsule_open WHERE id = ?1")
      .bind(id)
      .first();
    return !!current;
  } catch (e) {
    return null;
  }
}

export async function onRequestGet({ env, params }) {
  const id = String(params.id || "");
  if (!validId(id)) return fail(400, "bad id", "The capsule link is malformed.");
  if (!env || !env.SPIM_KV || !env.DB) return fail(500, "storage unavailable", "Capsule storage is unavailable.");
  const raw = await env.SPIM_KV.get("capsule:" + id);
  if (!raw) return fail(404, "not found", "This delivery does not exist or has expired.");
  let data;
  try { data = JSON.parse(raw); } catch { return fail(500, "corrupt capsule", "The stored capsule could not be read."); }

  if (data.expires_at && Number(data.expires_at) <= Date.now()) {
    return fail(410, "expired", "This delivery has expired.");
  }
  // Capsules burned before the burn store existed still carry the KV flag.
  if (data.consumed) return fail(410, "destroyed", DESTROYED);
  // A consumed capsule keeps a tombstone with no usable payload, so it can
  // still say "destroyed" after the burn row is pruned.
  if (!data.blob) return fail(410, "destroyed", DESTROYED);

  if (data.destroyable) {
    // A single-view capsule never releases bytes here. GET is only a postcard
    // preview; the payload comes from POST /consume, which is the burn fence.
    const state = await burned(env, id);
    if (state === null) return fail(503, "single-view unavailable", "Single-view delivery is temporarily unavailable.");
    if (state) return fail(410, "destroyed", DESTROYED);
    return json(200, { blob: null, destroyable: true, single_view: true });
  }

  return json(200, { blob: data.blob, destroyable: false });
}
