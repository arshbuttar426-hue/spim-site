'use strict';
/*
 * Page invariants that a copy edit can quietly break.
 *
 *   - a same-page link must point at an id that exists on that page
 *   - no page may load an asset from a third-party host (fonts excepted)
 *
 * These are cheap to check and expensive to notice by eye: the sidebar links
 * were dead on eight pages for months because nothing looked.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const PAGES = [
  'index.html', 'receive.html', 'seam.html', 'why.html', 'support.html',
  'login.html', 'create-account.html', 'account.html', 'images.html', '404.html'
];
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('every same-page fragment resolves', () => {
  const problems = [];
  for (const page of PAGES) {
    const html = read(page);
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    for (const m of html.matchAll(/href="#([^"]+)"/g)) {
      const target = m[1];
      if (target === '' || ids.has(target)) continue;
      problems.push(page + ' -> #' + target);
    }
  }
  assert.deepStrictEqual(problems, [], 'dead same-page links:\n' + problems.join('\n'));
});

test('the homepage is the studio, not a landing page', () => {
  // The page must fit one screen. Marketing sections and the footer are what
  // pushed it to 3,346px; if they come back, the screen promise is gone.
  const home = read('index.html');
  for (const gone of ['class="hero"', 'id="delivery"', 'id="faq"', 'id="security"', 'spim-footer']) {
    assert.ok(
      !home.includes(gone),
      'index.html still carries ' + gone + ' — the homepage is one screen'
    );
  }
  assert.match(home, /class="spim-main"/, 'index.html lost the one-screen main');
  assert.match(home, /spim-card spim-studio/, 'index.html lost the studio card');
});

test('no third-party asset hosts', () => {
  const allowed = ['fonts.googleapis.com', 'fonts.gstatic.com', 'www.spim.co.in', 'spim.co.in', 'spim-site.pages.dev'];
  const problems = [];
  for (const page of PAGES) {
    for (const m of read(page).matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)) {
      const host = m[1].replace(/^https?:\/\//, '').split('/')[0];
      if (allowed.includes(host)) continue;
      problems.push(page + ' -> ' + host);
    }
  }
  assert.deepStrictEqual(problems, [], 'third-party hosts:\n' + problems.join('\n'));
});

test('every page with the nav resolves the session', () => {
  // The nav renders a logged-out "Account" button until session-nav.js runs.
  // A page that ships the nav without the script shows "Account" to a signed-in
  // user forever — /seam did exactly that.
  const problems = [];
  for (const page of PAGES) {
    const html = read(page);
    if (!html.includes('class="spim-nav"')) continue;
    if (!html.includes('/js/session-nav.js')) problems.push(page);
  }
  assert.deepStrictEqual(problems, [], 'nav without session-nav.js:\n' + problems.join('\n'));
});
