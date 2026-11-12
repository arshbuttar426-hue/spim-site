'use strict';
/*
 * Start the local SPIM site for a load run.
 *
 *   node tools/seam-load-server.mjs <data.json> [port-file]
 *
 * Runs the real Pages Functions (see tools/lib/local-site.mjs) on 127.0.0.1,
 * seeds the in-memory KV with prepared data, prints the base URL, and waits.
 * The port is written to <port-file> when given so a shell driver can read it.
 *
 * Safety: binds loopback only. `assertLocal` re-checks the base URL before the
 * URL is used anywhere else.
 */

import fs from 'node:fs';
import { startLocalSite, seedLoadData, assertLocal } from './lib/local-site.mjs';

const dataFile = process.argv[2];
const portFile = process.argv[3];
if (!dataFile) {
  console.error('usage: node tools/seam-load-server.mjs <data.json> [port-file]');
  process.exit(2);
}

const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
const site = await startLocalSite({
  host: '127.0.0.1',
  port: 0,
  env: { SPIM_AUTH_SECRET: data.auth_secret || 'local-harness-secret' },
});
assertLocal(site.base);

const seeded = await seedLoadData(site.kv, data);
console.log(JSON.stringify({ base: site.base, seeded }));

if (portFile) fs.writeFileSync(portFile, site.base);

const stop = async () => {
  try { await site.close(); } catch {}
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

// Keep the process alive; the HTTP server holds the loop open, but an explicit
// interval makes the intent obvious and keeps the driver's health check honest.
setInterval(() => {}, 1 << 30).unref();
