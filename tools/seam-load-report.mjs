'use strict';
/*
 * Summarize the four load runs.
 *
 *   node tools/seam-load-report.mjs artifacts/load-<stamp>
 *
 * Reads the k6 summary exports and the server-side KV counters, then prints a
 * baseline-vs-seam table. It never reads a network resource.
 */

import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node tools/seam-load-report.mjs <artifacts/load-dir>');
  process.exit(2);
}

const LABELS = ['baseline-open', 'seam-open', 'baseline-closed', 'seam-closed'];

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function metric(summary, name, key) {
  if (!summary) return null;
  const group = summary.metrics || summary;
  const m = group[name];
  if (!m) return null;
  // k6 has shipped two summary shapes: { values: {...} } and a flat metric.
  const values = m.values && typeof m.values === 'object' ? m.values : m;
  if (key) return values[key] ?? null;
  return values;
}

function val(summary, name, key) {
  const v = metric(summary, name, key);
  return typeof v === 'number' ? v : null;
}

function fmt(v, digits = 1) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  if (Math.abs(v) >= 1000) return Math.round(v).toLocaleString('en-US');
  return Number(v).toFixed(digits);
}

function ms(v) {
  return v === null ? '—' : `${fmt(v, 1)} ms`;
}

function pct(v) {
  return v === null ? '—' : `${(v * 100).toFixed(2)}%`;
}

const rows = [];
for (const label of LABELS) {
  const summary = readJSON(path.join(dir, label + '.summary.json'));
  const stats = readJSON(path.join(dir, label + '.stats.json'));
  const dur = 'http_req_duration';
  rows.push({
    label,
    p50: val(summary, dur, 'med') ?? val(summary, dur, 'p(50)'),
    p95: val(summary, dur, 'p(95)'),
    p99: val(summary, dur, 'p(99)'),
    rps: val(summary, 'http_reqs', 'rate'),
    requests: val(summary, 'http_reqs', 'count'),
    failed: val(summary, 'http_req_failed', 'rate'),
    dropped: val(summary, 'dropped_iterations', 'count'),
    iterations: val(summary, 'iterations', 'count'),
    vus: val(summary, 'vus_max', 'max') ?? val(summary, 'vus_max', 'value'),
    errors: val(summary, 'server_errors', 'count'),
    limited: val(summary, 'rate_limited', 'count'),
    correct: val(summary, 'correctness', 'rate'),
    kv: stats ? stats.kv_ops : null,
    keys: stats ? stats.kv_keys : null,
  });
}

const has = rows.some((r) => r.p95 !== null);

console.log('SPIM local load — baseline vs SEAM');
console.log('===================================');
console.log('');
console.log('All targets were 127.0.0.1. The server is one Node process running the');
console.log('real Pages Functions against in-memory KV. This measures the harness and');
console.log('the laptop; it does not measure Cloudflare capacity.');
console.log('');

if (!has) {
  console.log('No k6 summaries found. Files present:');
  for (const f of fs.readdirSync(dir).sort()) console.log('  ' + f);
  process.exit(1);
}

const head = ['profile', 'p50', 'p95', 'p99', 'req/s', 'requests', 'failed', 'dropped', '5xx', '429', 'correct', 'KV ops'];
const widths = [17, 9, 9, 9, 9, 10, 8, 9, 6, 7, 9, 9];
function line(cells) {
  return cells.map((c, i) => String(c).padEnd(widths[i])).join(' ');
}
console.log(line(head));
console.log(line(widths.map((w) => '-'.repeat(w))));
for (const r of rows) {
  console.log(line([
    r.label,
    ms(r.p50),
    ms(r.p95),
    ms(r.p99),
    fmt(r.rps),
    fmt(r.requests, 0),
    pct(r.failed),
    fmt(r.dropped, 0),
    fmt(r.errors, 0),
    fmt(r.limited, 0),
    pct(r.correct),
    r.kv ? Object.entries(r.kv).map(([k, v]) => `${k[0]}${v}`).join('') : '—',
  ]));
}

console.log('');
console.log('Reading the numbers');
console.log('-------------------');
console.log('- p95/p99 include static HTML, auth, and SEAM relay routes; compare like');
console.log('  profiles (open vs open, closed vs closed), not baseline against seam.');
console.log('- `failed` is non-2xx/3xx that k6 did not expect. 429 is expected under');
console.log('  quota and is counted separately, not as failure.');
console.log('- `5xx` must be zero. Any non-zero value is a real defect, not load.');
console.log('- `dropped` is open-model iterations the generator could not start: it');
console.log('  means the target (or the laptop) was saturated at that arrival rate.');
console.log('- A closed run that holds VUs without 5xx proves concurrency safety at');
console.log('  that count on this machine; it does not prove Cloudflare will hold it.');

const open = rows.filter((r) => r.label.endsWith('-open'));
const closed = rows.filter((r) => r.label.endsWith('-closed'));
const any5xx = rows.some((r) => (r.errors || 0) > 0);
const anyDropped = open.some((r) => (r.dropped || 0) > 0);

console.log('');
console.log('Verdict');
console.log('-------');
if (any5xx) {
  console.log('FAIL: at least one profile produced a 5xx. That is a defect to fix.');
} else {
  console.log('PASS: no 5xx under any profile.');
}
if (anyDropped) {
  const worst = open.filter((r) => (r.dropped || 0) > 0)
    .map((r) => `${r.label} dropped ${fmt(r.dropped, 0)}`).join(', ');
  console.log(`CEILING: the open model could not sustain every arrival (${worst}).`);
  console.log('That is the local harness ceiling, not a production limit.');
} else {
  console.log('HEADROOM: every open-model arrival started; the ceiling was not reached.');
}
if (closed.length) {
  const top = Math.max(...closed.map((r) => r.vus || 0));
  console.log(`CONCURRENCY: closed profiles reached ${fmt(top, 0)} VUs without 5xx.`);
}
console.log('');
console.log('Production capacity remains unmeasured. Production was not contacted.');
