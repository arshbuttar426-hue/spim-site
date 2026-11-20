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

// Burn rows are kept long enough to cover the life of a capsule link. Pages
// Functions have no cron hook here, so expired rows are pruned opportunistically
// on each consume.
const BURN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const CAPSULE_TTL = 60 * 60 * 24 * 30;

export async function onRequestPost({ env, params }) {
  const id = String(params.id || "").replace(/[^A-Za-z0-9_-]/g, "");
  if (!id) return json(400, { error: "bad id" });
  if (!env || !env.SPIM_KV) return json(500, { error: "storage unavailable" });

  // Fail closed: without the burn store there is no fence, so a single-view
  // capsule must not be handed out as if it could only be opened once.
  if (!env.DB) return json(503, { error: "single-view unavailable" });

  const raw = await env.SPIM_KV.get("capsule:" + id);
  if (!raw) return json(404, { error: "not found" });
  let data;
  try { data = JSON.parse(raw); } catch { return json(500, { error: "corrupt capsule" }); }
  if (!data.destroyable) return json(400, { error: "not destroyable" });
  // Capsules burned before the burn store existed still carry the KV flag.
  if (data.consumed) return json(410, { error: "already destroyed" });

  const now = Date.now();
  // The fence: one row per capsule, and only the insert that creates it counts.
  // Two edges racing here both issue this statement; SQLite serialises them,
  // so exactly one gets changes = 1.
  const row = await env.DB
    .prepare("INSERT INTO capsule_burn (id, consumed_at, expires_at) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO NOTHING")
    .bind(id, now, now + BURN_RETENTION_MS)
    .run();

  if (!row || !row.meta || row.meta.changes !== 1) {
    return json(410, { error: "already destroyed" });
  }

  // The burn row is the authority. Drop the payload so a consumed capsule does
  // not keep its bytes in KV for the rest of the retention window. Do not flip
  // the KV `consumed` flag: KV is eventually consistent, and the D1 row is the
  // only fence.
  try {
    data.blob = "";
    await env.SPIM_KV.put("capsule:" + id, JSON.stringify(data), {
      expirationTtl: CAPSULE_TTL,
    });
  } catch (e) {
    // The burn row already won; a payload-cleanup failure must not unburn it.
  }

  try {
    await env.DB.prepare("DELETE FROM capsule_burn WHERE expires_at < ?1").bind(now).run();
  } catch (e) {
    // Pruning is housekeeping; never fail a successful consume over it.
  }

  return json(200, { consumed: true });
}
