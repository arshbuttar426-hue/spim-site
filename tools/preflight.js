#!/usr/bin/env node
/*
 * Pre-deploy gate. Runs against a build tree (normally a clean `git archive`
 * export) and refuses to let a broken or accidental tree go live.
 *
 *   node tools/preflight.js /path/to/export
 *
 * Checks:
 *   - every required route and asset exists
 *   - no prototype/test pages are present
 *   - the home page is the real workspace, not a standalone test view
 *   - no engineering jargon (2-FSK, band names) is visible in the UI
 *   - every internal link resolves inside the tree
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const problems = [];
const notes = [];

function must(rel) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) problems.push('missing required file: ' + rel);
  else notes.push(rel + '  ' + fs.statSync(full).size + ' B');
  return full;
}

function mustNot(rel) {
  if (fs.existsSync(path.join(root, rel))) problems.push('prototype/test file in build tree: ' + rel);
}

/* --- required surface ---------------------------------------------------- */
for (const f of [
  'index.html', 'receive.html', 'seam.html', 'why.html', 'support.html',
  'login.html', 'create-account.html', 'account.html', 'images.html',
  'css/spim-theme.css', 'js/spim-codec.js', 'js/seam-client.js', 'js/supabaseClient.js', 'js/session-nav.js',
  'pkg/spim_wasm.js', 'favicon.svg',
  'functions/capsules.js',
  'functions/api/_lib.js', 'functions/api/auth/register.js', 'functions/api/auth/login.js',
  'functions/api/auth/logout.js', 'functions/api/auth/me.js',
  'functions/api/keys.js', 'functions/api/connections.js', 'functions/api/dock.js',
  'functions/api/images.js',
  'functions/api/seam/_lib.js', 'functions/api/seam/prekeys.js',
  'functions/api/seam/prekeys/[id].js', 'functions/api/seam/envelopes.js',
  'functions/api/seam/envelopes/[id].js', 'functions/api/seam/envelopes/[id]/ack.js',
  '404.html', '_headers', '_redirects'
]) must(f);

/* --- the shipped WASM build actually carries Seam ------------------------ */
const wasmJs = fs.existsSync(path.join(root, 'pkg/spim_wasm.js'))
  ? fs.readFileSync(path.join(root, 'pkg/spim_wasm.js'), 'utf8')
  : '';
for (const [needle, why] of [
  ['WasmIdentity', 'Seam identity'],
  ['WasmPreKeyStore', 'Seam prekey store'],
  ['WasmSession', 'Seam session'],
  ['seam_generate_prekeys', 'Seam prekey generation'],
  ['seam_peek_init', 'Seam handshake peek'],
  ['seam_seal', 'Seam sealed store']
]) {
  if (!wasmJs.includes(needle)) problems.push('pkg/spim_wasm.js lost ' + why + ' (' + needle + ')');
}
must('pkg/spim_wasm_bg.wasm');

/* --- seam page is wired to the real engine ------------------------------- */
const seam = fs.existsSync(path.join(root, 'seam.html'))
  ? fs.readFileSync(path.join(root, 'seam.html'), 'utf8')
  : '';
for (const [needle, why] of [
  ['/js/seam-client.js', 'Seam client'],
  ['id="seamPeer"', 'conversation start field'],
  ['id="seamMessages"', 'message list'],
  ['id="seamInvite"', 'invite link']
]) {
  if (!seam.includes(needle)) problems.push('seam.html lost ' + why + ' (' + needle + ')');
}

/* --- nothing experimental ------------------------------------------------ */
for (const f of [
  'landing-proto.html', 'prima-four.html', 'spim-chirp.html',
  'spim-field.html', 'spim-quiet.html', 'spim-textfield.html', 'spim-typography.html',
  'js/chirp-receive.js'
]) mustNot(f);

/* --- home is the product, not a stub ------------------------------------- */
const index = fs.existsSync(path.join(root, 'index.html'))
  ? fs.readFileSync(path.join(root, 'index.html'), 'utf8')
  : '';
const capsuleClient = fs.existsSync(path.join(root, 'js/spim-capsule-client.js'))
  ? fs.readFileSync(path.join(root, 'js/spim-capsule-client.js'), 'utf8')
  : '';

for (const [needle, why] of [
  ['id="panelText"', 'Text panel'],
  ['id="panelImage"', 'Image panel'],
  ['id="panelBeam"', 'Beam panel'],
  ['id="panelCatch"', 'Catch panel'],
  ['WasmSpim', 'WASM capsule engine'],
  ["/capsules", 'capsule API call'],
  ['createText', 'text create flow'],
  ['createImage', 'image create flow'],
  ['data-share="dock"', 'Dock share action'],
  ['data-share="beam"', 'Beam share action'],
  ['SpimCodec', 'shared sound codec'],
  ['spim-nav', 'shared navigation'],
  ['spim-footer', 'shared footer']
]) {
  // C3: the capsule API call may live in the shared capsule client module
  // (/js/spim-capsule-client.js) now that index.html delegates delivery there.
  let found = index.includes(needle);
  if (!found && needle === '/capsules') found = capsuleClient.includes('/capsules');
  if (!found) problems.push('index.html lost ' + why + ' (' + needle + ')');
}

/* --- no jargon in anything a person can read ----------------------------- */
const PAGES = ['index.html', 'receive.html', 'seam.html', 'why.html', 'support.html', 'login.html', 'create-account.html', 'account.html', 'images.html'];
const jargon = /2-FSK|8-FSK|symbol rate|preamble|baud/i;
for (const page of PAGES) {
  const full = path.join(root, page);
  if (!fs.existsSync(full)) continue;
  const html = fs.readFileSync(full, 'utf8');
  if (jargon.test(html)) problems.push(page + ' exposes engineering jargon');
  if (!html.includes('spim-theme.css')) problems.push(page + ' does not load the shared theme');
}

/* --- links resolve inside the tree --------------------------------------- */
function resolves(ref) {
  const clean = decodeURIComponent(ref.split('?')[0].split('#')[0]);
  if (clean === '' || clean === '/') return fs.existsSync(path.join(root, 'index.html'));
  const rel = clean.replace(/^\//, '');
  return [rel, rel + '.html', path.posix.join(rel, 'index.html')]
    .some(c => {
      const f = path.join(root, c);
      return fs.existsSync(f) && fs.statSync(f).isFile();
    });
}

const SKIP = /^(https?:|mailto:|tel:|data:|javascript:|#)/i;
let linkCount = 0;
for (const page of PAGES) {
  const full = path.join(root, page);
  if (!fs.existsSync(full)) continue;
  const html = fs.readFileSync(full, 'utf8');
  for (const m of html.matchAll(/(?:href|src)\s*=\s*"([^"]+)"/g)) {
    const ref = m[1];
    if (SKIP.test(ref)) continue;
    if (/['<>`]|\$\{| \+ /.test(ref)) continue;
    linkCount++;
    const target = ref.startsWith('/') ? ref : '/' + path.posix.join(path.posix.dirname('/' + page), ref);
    if (!resolves(target)) problems.push(page + ' -> dead link ' + ref);
  }
}

console.log('tree: ' + root);
for (const n of notes) console.log('  ' + n);
console.log('links: ' + linkCount + ' checked');

if (problems.length) {
  console.error('\nPREFLIGHT FAILED');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('\nPREFLIGHT OK');
