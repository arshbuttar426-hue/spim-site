/*
 * Shared helpers for the SEAM relay.
 *
 * The relay is deliberately dumb: it stores signed prekey bundles and opaque
 * `SMW1` capsules. It cannot read a message, verify a bundle, or learn who is
 * talking to whom beyond the public mailbox. Every cryptographic refusal lives
 * in the Rust client; this file only enforces shape, quota, and ownership.
 *
 * KV layout:
 *   seam:prekey:<mailbox>   JSON { owner, bundles: [bundle...], expires_at }
 *   seam:owner:<mailbox>    user id that published the mailbox
 *   seam:env:<mailbox>:<id> JSON { envelope, at }
 */

export const MAILBOX_RE = /^[0-9a-f]{32}$/;
export const ID_RE = /^[0-9a-z]{8,32}$/;

export const PREKEY_TTL = 60 * 60 * 24 * 7;
export const OWNER_TTL = 60 * 60 * 24 * 30;
export const ENVELOPE_TTL = 60 * 60 * 24 * 7;

export const MAX_BUNDLES = 256;
export const MAX_BUNDLE_BYTES = 4096;
export const MAX_ENVELOPE_BYTES = 128 * 1024;
export const MAX_QUEUE = 128;

export function validMailbox(value) {
  return typeof value === 'string' && MAILBOX_RE.test(value);
}

export function validId(value) {
  return typeof value === 'string' && ID_RE.test(value);
}

export function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || 'unknown';
}

/**
 * Approximate fixed-window limit. KV has no atomic increment, so a burst can
 * exceed the limit by a few; this is a blunt abuse brake, not an accounting
 * system. The real refusal that matters is cryptographic.
 */
export async function rateLimit(env, bucket, limit, windowSec) {
  if (!env || !env.SPIM_KV) return true;
  const now = Math.floor(Date.now() / 1000);
  const slot = Math.floor(now / windowSec);
  const key = `seam:rl:${bucket}:${slot}`;
  const raw = await env.SPIM_KV.get(key);
  const n = raw ? Number(raw) || 0 : 0;
  if (n >= limit) return false;
  try {
    await env.SPIM_KV.put(key, String(n + 1), { expirationTtl: windowSec + 60 });
  } catch {
    // A quota write failure must not turn a valid request into a 500.
  }
  return true;
}

export function prekeyKey(mailbox) {
  return `seam:prekey:${mailbox}`;
}

export function ownerKey(mailbox) {
  return `seam:owner:${mailbox}`;
}

export function envelopeKey(mailbox, id) {
  return `seam:env:${mailbox}:${id}`;
}

/** A base64 body of bounded size, without decoding it. */
export function validBase64Body(value, maxBytes) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.length > Math.ceil((maxBytes * 4) / 3) + 4) return false;
  return /^[A-Za-z0-9+/=]+$/.test(value);
}

/** `SMW1` capsules are base64 of a binary frame whose first four bytes are SMW1. */
export function looksLikeSeamEnvelope(value) {
  if (!validBase64Body(value, MAX_ENVELOPE_BYTES)) return false;
  try {
    const head = atob(value.slice(0, 8));
    return head.startsWith('SMW1') || head.startsWith('SMG1');
  } catch {
    return false;
  }
}
