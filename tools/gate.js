#!/usr/bin/env node
/*
 * The repo gate. One command that must pass before a deploy.
 *
 *   node tools/gate.js
 *
 * Every check here encodes a promise the site makes. If a check fails, the
 * tree is not allowed to ship: either the code is wrong or the promise is.
 *
 *   chrome    the nav/footer partial is the only place chrome is written
 *   links     every internal link resolves inside the tree
 *   pages     same-page fragments resolve; no third-party asset hosts
 *   claims    every absolute claim has a mechanism behind it
 *   burn      "opens once" is an atomic write, not a read-modify-write
 */
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');

/* node:sqlite is unflagged on new Node, flag-gated on older ones. */
let sqliteFlags = [];
try {
  require('node:sqlite');
} catch (e) {
  sqliteFlags = ['--experimental-sqlite'];
}

const checks = [
  {
    name: 'chrome in sync',
    args: [path.join(__dirname, 'stamp-chrome.js'), '--check']
  },
  {
    name: 'links resolve',
    args: [path.join(__dirname, 'check-links.js')]
  },
  {
    name: 'page invariants',
    args: ['--test', path.join(__dirname, 'gates', 'pages.test.js')]
  },
  {
    name: 'claims match mechanism',
    args: ['--test', path.join(__dirname, 'gates', 'claims.test.js')]
  },
  {
    name: 'burn is atomic',
    args: sqliteFlags.concat(['--test', path.join(__dirname, 'gates', 'burn.test.js')])
  }
];

let failed = 0;
for (const check of checks) {
  const r = spawnSync(process.execPath, check.args, { cwd: root, encoding: 'utf8' });
  if (r.status === 0) {
    console.log('ok    ' + check.name);
    continue;
  }
  failed++;
  console.log('FAIL  ' + check.name);
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  if (out) console.log(out.split('\n').map((l) => '      ' + l).join('\n'));
}

console.log(failed ? '\nGATE FAILED (' + failed + ')' : '\nGATE OK');
process.exit(failed ? 1 : 0);
