/*
 * SPIM load profile for k6.
 *
 *   k6 run tools/seam-load.k6.js
 *
 * Environment:
 *   SEAM_DATA      absolute path to the data file from seam-load-prepare.mjs
 *   BASE_URL       loopback base URL printed by seam-load-server.mjs
 *   TARGET         baseline | seam
 *   MODE           open | closed
 *   RATE_START     open: initial iterations/sec        (default 10)
 *   RATE_END       open: peak iterations/sec           (default 300)
 *   RAMP           open: ramp duration                 (default 60s)
 *   VUS            closed: peak virtual users          (default 2000)
 *   HOLD           closed: hold duration at peak       (default 30s)
 *   PRE_VUS        open: pre-allocated VUs             (default 200)
 *   MAX_VUS        open: maximum VUs                   (default 4000)
 *
 * The mix is deliberately different for the two modes. The open model measures
 * sustained arrival against the write paths; the closed model holds thousands
 * of simultaneous clients against the repeatable read paths, where per-user and
 * per-IP quotas would otherwise turn the run into a quota test.
 *
 * Safety: BASE_URL is checked here and the server checks again. This script
 * refuses any non-loopback host.
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://127.0.0.1:8788';
const TARGET = __ENV.TARGET || 'seam';
const MODE = __ENV.MODE || 'open';
const DATA = JSON.parse(open(__ENV.SEAM_DATA));

function num(name, fallback) {
  const n = Number(__ENV[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const RATE_START = num('RATE_START', 10);
const RATE_END = num('RATE_END', 300);
const RAMP = __ENV.RAMP || '60s';
const VUS = num('VUS', 2000);
const HOLD = __ENV.HOLD || '30s';
const PRE_VUS = num('PRE_VUS', 200);
const MAX_VUS = num('MAX_VUS', 4000);

if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(BASE)) {
  throw new Error(`refusing non-loopback BASE_URL: ${BASE}`);
}

const serverErrors = new Counter('server_errors');
const rateLimited = new Counter('rate_limited');
const unexpected = new Counter('unexpected_status');
const correctness = new Rate('correctness');

http.setResponseCallback(http.expectedStatuses(200, 201, 204, 400, 401, 403, 404, 405, 429));

export const options = {
  scenarios: MODE === 'closed'
    ? {
        mix: {
          executor: 'ramping-vus',
          startVUs: 0,
          stages: [
            { target: VUS, duration: RAMP },
            { target: VUS, duration: HOLD },
          ],
          gracefulRampDown: '5s',
        },
      }
    : {
        mix: {
          executor: 'ramping-arrival-rate',
          startRate: RATE_START,
          timeUnit: '1s',
          preAllocatedVUs: PRE_VUS,
          maxVUs: MAX_VUS,
          stages: [
            { target: RATE_END, duration: RAMP },
            { target: RATE_END, duration: HOLD },
          ],
        },
      },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'server_errors': ['count==0'],
    'http_req_duration': ['p(95)<1000', 'p(99)<2500'],
  },
};

const USERS = DATA.users;
const PUBLISH = DATA.publishJobs;
const FETCH = DATA.fetchMailboxes;
const DRAIN = DATA.drainMailboxes;
const ACK = DATA.ackMailboxes;
const CAPSULE = DATA.envelope;
const BLOB = DATA.baseline.capsule_blob;

function pick(list, salt) {
  return list[(__VU * salt + __ITER) % list.length];
}

function headers(cookie) {
  const h = { origin: BASE, 'content-type': 'application/json' };
  if (cookie) h.cookie = 'spim_session=' + encodeURIComponent(cookie);
  return h;
}

function ip() {
  return `load-${__VU}-${__ITER}-${Math.floor(Math.random() * 1e9)}`;
}

function record(res, name, okStatuses) {
  if (res.status >= 500) serverErrors.add(1);
  if (res.status === 429) rateLimited.add(1);
  const ok = okStatuses.includes(res.status);
  if (!ok) unexpected.add(1);
  check(res, { [name]: () => ok });
  correctness.add(ok);
}

function baseline() {
  const roll = Math.random();
  if (roll < 0.4) {
    const res = http.get(`${BASE}/`, { tags: { route: 'static' } });
    record(res, 'static 200', [200]);
    return;
  }
  if (roll < 0.7) {
    const res = http.get(`${BASE}/api/auth/me`, { headers: headers(), tags: { route: 'auth' } });
    record(res, 'auth/me 200/401', [200, 401]);
    return;
  }
  const user = pick(USERS, 17);
  const res = http.get(`${BASE}/api/keys`, {
    headers: headers(user.token),
    tags: { route: 'keys' },
  });
  record(res, 'keys 200', [200]);
}

function seamOpen() {
  const roll = Math.random();
  if (roll < 0.10) {
    const res = http.get(`${BASE}/`, { tags: { route: 'static' } });
    record(res, 'static 200', [200]);
    return;
  }
  if (roll < 0.20) {
    const res = http.get(`${BASE}/api/auth/me`, { headers: headers(), tags: { route: 'auth' } });
    record(res, 'auth/me 200/401', [200, 401]);
    return;
  }
  if (roll < 0.35) {
    const job = pick(PUBLISH, 23);
    const res = http.post(`${BASE}/api/seam/prekeys`, JSON.stringify({
      mailbox: job.mailbox,
      bundles: job.bundles,
    }), { headers: headers(job.token), tags: { route: 'prekey-publish' } });
    record(res, 'publish 201', [201, 429]);
    return;
  }
  if (roll < 0.50) {
    const box = pick(FETCH, 29);
    const res = http.get(`${BASE}/api/seam/prekeys/${box.mailbox}`, {
      headers: { origin: BASE, 'cf-connecting-ip': ip() },
      tags: { route: 'prekey-fetch' },
    });
    record(res, 'fetch 200', [200, 404, 429]);
    return;
  }
  if (roll < 0.75) {
    const box = pick(DRAIN, 31);
    const res = http.post(`${BASE}/api/seam/envelopes`, JSON.stringify({
      mailbox: box.mailbox,
      envelope: CAPSULE,
    }), { headers: { origin: BASE, 'content-type': 'application/json', 'cf-connecting-ip': ip() }, tags: { route: 'envelope-post' } });
    record(res, 'post 201', [201, 429]);
    return;
  }
  if (roll < 0.90) {
    const box = pick(DRAIN, 37);
    const res = http.get(`${BASE}/api/seam/envelopes/${box.mailbox}`, {
      headers: headers(box.token),
      tags: { route: 'drain' },
    });
    record(res, 'drain 200', [200]);
    return;
  }
  const box = pick(ACK, 41);
  const res = http.post(`${BASE}/api/seam/envelopes/${box.mailbox}/ack`, JSON.stringify({
    ids: box.messages.map((m) => m.id),
  }), { headers: headers(box.token), tags: { route: 'ack' } });
  record(res, 'ack 200', [200]);
}

function seamClosed() {
  const roll = Math.random();
  if (roll < 0.35) {
    const res = http.get(`${BASE}/`, { tags: { route: 'static' } });
    record(res, 'static 200', [200]);
    return;
  }
  if (roll < 0.65) {
    const res = http.get(`${BASE}/api/auth/me`, { headers: headers(), tags: { route: 'auth' } });
    record(res, 'auth/me 200/401', [200, 401]);
    return;
  }
  const box = pick(DRAIN, 43);
  const res = http.get(`${BASE}/api/seam/envelopes/${box.mailbox}`, {
    headers: headers(box.token),
    tags: { route: 'drain' },
  });
  record(res, 'drain 200', [200]);
}

export default function () {
  if (TARGET === 'baseline') baseline();
  else if (MODE === 'closed') seamClosed();
  else seamOpen();
  sleep(0.01);
}
