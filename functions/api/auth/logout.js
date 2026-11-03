import { json, sessionCookie } from '../_lib.js';

export async function onRequestOptions() {
  return new Response(null, { status: 204 });
}

export async function onRequestPost({ request }) {
  return json(200, { ok: true }, { 'set-cookie': sessionCookie(request, '', 0) });
}

export async function onRequestGet() {
  return json(405, { error: 'method not allowed' });
}
