#!/usr/bin/env node
'use strict';
/*
 * Static asset budget gate. No packages, no network, no runtime traffic.
 *
 * Run from the repository root:
 *   node .github/architecture/check-budget.cjs
 *
 * Two things are protected:
 *   1. named files stay under their individual cap (seam-client.js is capped
 *      tightly on purpose — growing it is a signal to split the module);
 *   2. a new file added to js/, css/ or pkg/ cannot silently become huge.
 */

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const config = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'budgets.json'), 'utf8')
);

const fmt = (n) => n.toLocaleString('en-US');
let failed = 0;

const rows = [];
for (const [rel, cap] of Object.entries(config.files)) {
  if (rel.startsWith('_')) continue;
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) {
    rows.push(['MISSING', rel, '—', fmt(cap)]);
    failed++;
    continue;
  }
  const size = fs.statSync(abs).size;
  const ok = size <= cap;
  if (!ok) failed++;
  rows.push([ok ? 'ok' : 'OVER', rel, fmt(size), fmt(cap)]);
}

// Any new authored file in these directories gets the generic cap.
const watched = ['js', 'css', 'pkg'];
const unlisted = [];
for (const dir of watched) {
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) unlisted.push(path.relative(root, abs));
    }
  };
  walk(path.join(root, dir));
}
for (const rel of unlisted) {
  if (Object.prototype.hasOwnProperty.call(config.files, rel)) continue;
  const size = fs.statSync(path.join(root, rel)).size;
  const cap = config['unlisted-file-max'];
  const ok = size <= cap;
  if (!ok) failed++;
  rows.push([ok ? 'ok (new)' : 'OVER', rel, fmt(size), fmt(cap)]);
}

// Aggregate budgets catch many small files adding up.
const sum = (rels) =>
  rels.reduce((n, rel) => {
    const abs = path.join(root, rel);
    return n + (fs.existsSync(abs) ? fs.statSync(abs).size : 0);
  }, 0);
const authoredJs = unlisted.filter(
  (rel) => rel.startsWith('js/') && !rel.startsWith('js/vendor/')
);
const totals = [
  ['authored-js', sum(authoredJs), config.totals['authored-js']],
  ['shipped-static', sum(unlisted), config.totals['shipped-static']],
];
for (const [name, size, cap] of totals) {
  const ok = size <= cap;
  if (!ok) failed++;
  rows.push([ok ? 'ok' : 'OVER', `total:${name}`, fmt(size), fmt(cap)]);
}

const width = Math.max(...rows.map((r) => r[1].length));
console.log('status  ' + 'file'.padEnd(width) + '  size'.padStart(10) + '  budget'.padStart(10));
console.log('-'.repeat(width + 32));
for (const [status, rel, size, cap] of rows) {
  console.log(status.padEnd(7) + rel.padEnd(width) + '  ' + size.padStart(10) + '  ' + cap.padStart(10));
}

if (failed) {
  console.error(`\nASSET BUDGET FAILED: ${failed} cap(s) exceeded.`);
  process.exit(1);
}
console.log('\nASSET BUDGET OK');
