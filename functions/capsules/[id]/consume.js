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

// Burn rows are kept long enough to cover the life of a capsule link. Pages
// Functions have no cron hook here, so expired rows are pruned opportunistically
// on each successful consume.
const BURN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const CAPSULE_TTL = 60 * 60 * 24 * 30;
// A consumed capsule keeps its bytes only long enough for a client to retry a
// lost response with its receipt. GET never sees them; the D1 row stays authority.
const RETRY_WINDOW_MS = 10 * 60 * 1000;

function validId(raw) {
  return /^[A-Za-z0-9_-]{6,16}$/.test(String(raw || ""));
}

function validReceipt(raw) {
  return typeof raw === "string" && /^[0-9a-f]{16}$/i.test(raw);
}

function randomReceipt() {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function readReceipt(request) {
  try {
    const text = await request.text();
    if (!text) return randomReceipt();
    const body = JSON.parse(text);
    if (!body || body.receipt === undefined) return randomReceipt();
    return validReceipt(body.receipt) ? body.receipt.toLowerCase() : null;
  } catch {
    return null;
  }
}

/*
 * A single-view capsule is consumed exactly when this handler's INSERT wins.
 * The payload is returned only from that response (or from one retry carrying
 * the same client receipt). D1 writes serialise, so two edges racing here get
 * exactly one winner. GET never carries the bytes.
 */
export async function onRequestPost({ request, env, params }) {
  const id = String(params.id || "");
  if (!validId(id)) return fail(400, "bad id", "The capsule link is malformed.");
  if (!env || !env.SPIM_KV || !env.DB) return fail(500, "storage unavailable", "Capsule storage is unavailable.");
  const receipt = await readReceipt(request);
  if (!receipt) return fail(400, "bad receipt", "The retry receipt is malformed.");

  const raw = await env.SPIM_KV.get("capsule:" + id);
  if (!raw) return fail(404, "not found", "This delivery does not exist or has expired.");
  let data;
  try { data = JSON.parse(raw); } catch { return fail(500, "corrupt capsule", "The stored capsule could not be read."); }

  if (data.expires_at && Number(data.expires_at) <= Date.now()) {
    return fail(410, "expired", "This delivery has expired.");
  }
  if (!data.destroyable) return fail(400, "not destroyable", "This delivery is not single-view.");

  const now = Date.now();

  // Legacy burn rows have no receipt and can never be reopened.
  try {
    const legacy = await env.DB
      .prepare("SELECT consumed_at FROM capsule_burn WHERE id = ?1")
      .bind(id)
      .first();
    if (legacy) return fail(410, "already destroyed", "This delivery has already been opened.");
  } catch (e) {
    return fail(503, "consume unavailable", "This delivery could not be opened. Please try again.");
  }

  // The fence is authoritative. A matching receipt is a retry of the same
  // open, not a second view; any other receipt is refused.
  let existing;
  try {
    existing = await env.DB
      .prepare("SELECT receipt FROM capsule_open WHERE id = ?1")
      .bind(id)
      .first();
  } catch (e) {
    return fail(503, "consume unavailable", "This delivery could not be opened. Please try again.");
  }

  if (existing) {
    if (!validReceipt(existing.receipt) || existing.receipt.toLowerCase() !== receipt) {
      return fail(410, "already destroyed", "This delivery has already been opened.");
    }
    if (!data.blob) return fail(410, "already destroyed", "This delivery has already been opened.");
    const blob = data.blob;
    try {
      data.blob = "";
      await env.SPIM_KV.put("capsule:" + id, JSON.stringify(data), { expirationTtl: RETRY_WINDOW_MS / 1000 });
    } catch (e) {
      // The row already won; a cleanup failure must not unburn the capsule.
    }
    return json(200, { consumed: true, id, blob, retry: true });
  }

  // Capsules burned before the burn store existed still carry the KV flag.
  if (data.consumed) return fail(410, "already destroyed", "This delivery has already been opened.");

  let row;
  try {
    row = await env.DB
      .prepare("INSERT INTO capsule_open (id, receipt, consumed_at, expires_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(id) DO NOTHING")
      .bind(id, receipt, now, now + BURN_RETENTION_MS)
      .run();
  } catch (e) {
    return fail(503, "consume unavailable", "This delivery could not be opened. Please try again.");
  }

  if (!row || !row.meta || row.meta.changes !== 1) {
    return fail(410, "already destroyed", "This delivery has already been opened.");
  }

  // Keep the bytes briefly under `consumed` so the same receipt can recover a
  // lost response. GET checks `consumed` first and never serves them.
  if (!data.blob) return fail(410, "already destroyed", "This delivery has already been opened.");
  const blob = data.blob;
  try {
    data.consumed = true;
    data.receipt = receipt;
    await env.SPIM_KV.put("capsule:" + id, JSON.stringify(data), { expirationTtl: RETRY_WINDOW_MS / 1000 });
  } catch (e) {
    // The burn row already won; a cleanup failure must not unburn it. The
    // response still carries the one payload the client is allowed to see.
  }

  try {
    await env.DB.prepare("DELETE FROM capsule_open WHERE expires_at < ?1").bind(now).run();
    await env.DB.prepare("DELETE FROM capsule_burn WHERE expires_at < ?1").bind(now).run();
  } catch (e) {
    // Pruning is housekeeping; never fail a successful consume over it.
  }

  return json(200, { consumed: true, id, blob });
}
