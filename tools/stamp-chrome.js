#!/usr/bin/env node
/*
 * Stamps the shared nav and footer into every page between marker comments.
 *
 * The partials are the only place the chrome is written. Pages keep generated
 * markup, so the deployed site stays static (no JS-built navigation) while the
 * four pages still cannot drift apart.
 *
 *   node tools/stamp-chrome.js          # rewrite pages
 *   node tools/stamp-chrome.js --check  # exit 1 if any page is out of sync
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const nav = fs.readFileSync(path.join(__dirname, 'chrome', 'nav.html'), 'utf8').trim();
const footer = fs.readFileSync(path.join(__dirname, 'chrome', 'footer.html'), 'utf8').trim();

// page file -> which nav item is the current page
const PAGES = {
  'index.html': '',
  'receive.html': '',
  'seam.html': 'seam',
  'why.html': 'why',
  'support.html': 'support',
  'login.html': '',
  'create-account.html': '',
  'account.html': ''
};

// The homepage is a single screen: it carries the nav, not the footer.
const NO_FOOTER = new Set(['index.html']);

function markCurrent(html, current) {
  return html.replace(/<a\b([^>]*\bdata-nav="([^"]+)"[^>]*)>/g, (match, attrs, key) => {
    const cleaned = attrs.replace(/\s*aria-current="[^"]*"/g, '');
    const active = key === current ? ' aria-current="page"' : '';
    return '<a' + cleaned + active + '>';
  });
}

function replaceBlock(html, name, content) {
  const open = '<!-- chrome:' + name + ' -->';
  const close = '<!-- /chrome:' + name + ' -->';
  const start = html.indexOf(open);
  const end = html.indexOf(close);
  if (start < 0 || end < 0 || end < start) {
    throw new Error('missing ' + name + ' markers');
  }
  return html.slice(0, start + open.length) + '\n' + content + '\n' + html.slice(end);
}

const check = process.argv.includes('--check');
let dirty = 0;

for (const [file, current] of Object.entries(PAGES)) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) {
    console.error('missing page: ' + file);
    dirty++;
    continue;
  }
  const before = fs.readFileSync(full, 'utf8');
  let after;
  try {
    after = replaceBlock(before, 'nav', markCurrent(nav, current));
    if (!NO_FOOTER.has(file)) after = replaceBlock(after, 'footer', footer);
  } catch (err) {
    console.error(file + ': ' + err.message);
    dirty++;
    continue;
  }

  if (after === before) {
    console.log('ok    ' + file);
  } else if (check) {
    console.log('drift ' + file);
    dirty++;
  } else {
    fs.writeFileSync(full, after);
    console.log('wrote ' + file);
  }
}

process.exit(dirty === 0 ? 0 : 1);
