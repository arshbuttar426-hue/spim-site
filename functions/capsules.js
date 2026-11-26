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

// CAP2 clients supply a 16-hex SHA-256 content address; legacy clients get the
// original 8-character random id. Never sanitise an incoming id into a
// different one: "abc123!" must be rejected, not turned into "abc123".
const CAP2_ID = /^[0-9a-f]{16}$/;

function validId(raw) {
  return /^[A-Za-z0-9_-]{6,16}$/.test(String(raw || ""));
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

// For public CAP2 blobs the server can independently check the content address
// before storing. Private blobs are opaque ciphertext: the client proves the
// AAD binding after decryption, and the D1 reservation below stops id swaps.
async function publicContentId(blob) {
  try {
    const bin = atob(blob);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const env = JSON.parse(new TextDecoder().decode(bytes));
    if (!env || env.magic !== "CAP2") return null;
    const d = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
  } catch {
    return null;
  }
}

function blobMagic(blob) {
  try {
    const env = JSON.parse(new TextDecoder().decode(spimBase64Bytes(blob)));
    return env && typeof env === "object" && typeof env.magic === "string" ? env.magic : null;
  } catch {
    return null;
  }
}

function spimBase64Bytes(blob) {
  const bin = atob(blob);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function versionHint(data) {
  const raw = data.version;
  if (raw === 2 || raw === "2") return 2;
  if (raw === 1 || raw === "1") return 1;
  return null;
}

// KV has no compare-and-swap. D1 writes serialise, so this insert is the
// atomic "id is free" fence for both public and private capsules.
async function reserveId(env, id, now, expiresAt) {
  try {
    const row = await env.DB
      .prepare("INSERT INTO capsule_reservation (id, created_at, expires_at) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO NOTHING")
      .bind(id, now, expiresAt)
      .run();
    return !!(row && row.meta && row.meta.changes === 1);
  } catch (e) {
    return null;
  }
}

async function releaseId(env, id) {
  try {
    await env.DB.prepare("DELETE FROM capsule_reservation WHERE id = ?1").bind(id).run();
  } catch (e) {
    // Best effort: an orphaned reservation can be pruned by the next create.
  }
}

async function pruneReservations(env, now) {
  try {
    await env.DB.prepare("DELETE FROM capsule_reservation WHERE expires_at < ?1").bind(now).run();
  } catch (e) {
    // Housekeeping only; reservation insert still fails closed on DB errors.
  }
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env || !env.SPIM_KV || !env.DB) {
      return fail(500, "storage unavailable", "Capsule storage is unavailable.");
    }
    const text = await request.text();
    let data;
    try { data = JSON.parse(text || "{}"); } catch { return fail(400, "invalid json", "The request body must be JSON."); }
    const blob = data.blob;
    const destroyable = !!data.destroyable;
    if (typeof blob !== "string" || blob.length === 0 || blob.length > 2 * 1024 * 1024) {
      return fail(400, "bad blob", "The capsule payload is missing or too large.");
    }
    // validate base64-ish
    if (!/^[A-Za-z0-9+/=]+$/.test(blob)) return fail(400, "blob not base64", "The capsule payload is not valid base64.");

    const now = Date.now();
    const expiresAt = now + CAPSULE_TTL * 1000;
    await pruneReservations(env, now);

    const supplied = data.id === undefined ? null : data.id;
    const hint = versionHint(data);
    let id;

    if (supplied !== null) {
      if (typeof supplied !== "string" || !CAP2_ID.test(supplied)) {
        return fail(400, "bad id", "A supplied capsule id must be a 16-character hex content address.");
      }
      if (hint === 1) {
        return fail(400, "bad id", "CAP1 capsules cannot use a CAP2 content address.");
      }
      const actual = await publicContentId(blob);
      if (actual) {
        if (actual !== supplied) return fail(400, "id mismatch", "The capsule id does not match its payload.");
      } else {
        // A CAP1 blob under a 16-hex id is a downgrade, even if its unkeyed
        // hashes were recomputed. Only an opaque CAP2 ciphertext may omit the
        // server-checkable content address, and it must say so explicitly.
        const magic = blobMagic(blob);
        if (magic === "CAP1") return fail(400, "downgrade rejected", "CAP1 capsules cannot use a CAP2 id.");
        if (hint !== 2) {
          return fail(400, "version required", "Private capsules must declare version 2.");
        }
      }
      const reserved = await reserveId(env, supplied, now, expiresAt);
      if (reserved === null) return fail(503, "reservation unavailable", "Capsule ids cannot be checked right now.");
      if (!reserved) return fail(409, "id exists", "That capsule id has already been used.");
      id = supplied;
    } else {
      if (hint === 2) return fail(400, "missing id", "CAP2 capsules must supply their content address.");
      let reserved = false;
      for (let i = 0; i < 8; i++) {
        const candidate = randomId(8);
        const result = await reserveId(env, candidate, now, expiresAt);
        if (result === null) return fail(503, "reservation unavailable", "Capsule ids cannot be checked right now.");
        if (result) { id = candidate; reserved = true; break; }
      }
      if (!reserved) return fail(503, "reservation unavailable", "No free capsule id could be reserved.");
    }

    try {
      await env.SPIM_KV.put("capsule:" + id, JSON.stringify({
        blob,
        destroyable,
        consumed: false,
        expires_at: expiresAt,
      }), {
        expirationTtl: CAPSULE_TTL,
      });
    } catch (e) {
      await releaseId(env, id);
      return fail(500, "create failed", "The capsule could not be created. Please try again.");
    }
    return json(201, { id, destroyable, expires_at: expiresAt, version: supplied ? 2 : (hint || 1) });
  } catch (e) {
    return fail(500, "create failed", "The capsule could not be created. Please try again.");
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
