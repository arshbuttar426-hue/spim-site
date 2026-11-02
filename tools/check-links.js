#!/usr/bin/env node
/*
 * Verifies that every internal link and asset reference in the public pages
 * resolves to a file that will exist in the deploy. Catches dead ends before
 * they reach production.
 *
 *   node tools/check-links.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const PAGES = ['index.html', 'app.html', 'receive.html', 'why.html', 'support.html'];
const SKIP = /^(https?:|mailto:|tel:|data:|javascript:|#)/i;

function existsAsRoute(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  if (clean === '' || clean === '/') return fs.existsSync(path.join(root, 'index.html'));

  const rel = clean.replace(/^\//, '');
  const candidates = [
    path.join(root, rel),
    path.join(root, rel + '.html'),
    path.join(root, rel, 'index.html')
  ];
  return candidates.some(p => fs.existsSync(p) && fs.statSync(p).isFile());
}

let bad = 0;
let checked = 0;

for (const page of PAGES) {
  const file = path.join(root, page);
  if (!fs.existsSync(file)) { console.error('missing page ' + page); bad++; continue; }
  const html = fs.readFileSync(file, 'utf8');
  const refs = [...html.matchAll(/(?:href|src)\s*=\s*"([^"]+)"/g)].map(m => m[1]);

  for (const ref of refs) {
    if (SKIP.test(ref)) continue;
    checked++;
    // An absolute path is a site route; a relative one resolves from the page.
    const target = ref.startsWith('/') ? ref : '/' + path.posix.join(path.posix.dirname('/' + page), ref);
    if (!existsAsRoute(target)) {
      console.error(page + ' -> ' + ref + '  (missing)');
      bad++;
    }
  }

  // Inline handlers must call functions that exist somewhere in the page.
  const handlers = [...html.matchAll(/on(?:click|change|input|keydown)\s*=\s*"([a-zA-Z_$][\w$]*)\(/g)].map(m => m[1]);
  const defined = new Set([
    ...[...html.matchAll(/function\s+([a-zA-Z_$][\w$]*)\s*\(/g)].map(m => m[1]),
    ...[...html.matchAll(/(?:const|let|var|window\.)\s*([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()/g)].map(m => m[1]),
    ...['event']
  ]);
  for (const fn of new Set(handlers)) {
    if (!defined.has(fn)) {
      console.error(page + ' -> handler ' + fn + '() is not defined');
      bad++;
    }
  }
}

console.log(checked + ' links checked across ' + PAGES.length + ' pages');
console.log(bad === 0 ? 'all links resolve' : bad + ' problem(s)');
process.exit(bad === 0 ? 0 : 1);
