'use strict';
/*
 * Fix 3 — file-input lifecycle.
 *
 * WebKit detaches a File when its input's .value is cleared. The handlers must
 * therefore read the bytes first and only release the input afterwards, on
 * every exit path (success, failure, stale result). These gates encode that
 * ordering so a future "cleanup" cannot reintroduce the race.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const flat = (s) => s.replace(/\s+/g, ' ');

const home = flat(read('index.html'));
const receive = flat(read('receive.html'));

function section(src, start, end) {
  const a = src.indexOf(start);
  const b = src.indexOf(end, a);
  assert.ok(a > -1 && b > a, `missing section ${start} .. ${end}`);
  return src.slice(a, b);
}

test('homepage input is cleared only after the File is read', () => {
  const m = home.match(/fileInput\.onchange\s*=\s*function\([^)]*\)\s*\{[^}]*\}/);
  assert.ok(m, 'homepage fileInput.onchange must exist');
  const handler = flat(m[0]);
  assert.ok(!/e\.target\.value\s*=\s*''/.test(handler),
    'the input must not be cleared synchronously in onchange');
  assert.match(handler, /openSpimFile\([^;]*function\(\)\{[^\}]*input\.value\s*=\s*''/,
    'a deferred release callback must be passed to openSpimFile');

  const body = section(home, 'async function openSpimFile', 'const drop = document.getElementById');
  assert.match(body, /await file\.text\(\)/, 'the File must actually be read');
  const readAt = body.indexOf('await file.text()');
  const releaseAfterRead = body.indexOf('release();', readAt);
  assert.ok(releaseAfterRead > readAt, 'release must follow a successful read');
  assert.match(body, /finally\s*\{\s*release\(\);\s*\}/, 'release must also run on failure');
  assert.match(body, /file read failed/, 'interrupted reads must have an explicit error');
  assert.ok(body.indexOf('catchDisplaySeq') > -1, 'stale async results must be ignored');
});

test('receive input is cleared only after the File is read', () => {
  assert.match(receive, /id="spimFileInput"[^>]*onchange="spimOpenLocalFile\(this\)"/,
    'receive must route input changes through the deferred-release wrapper');
  assert.ok(!/id="spimFileInput"[^>]*onchange="openSpimFile\(/.test(receive),
    'receive must not call openSpimFile directly from onchange');

  const wrapper = receive.match(/function spimOpenLocalFile\(input\)\s*\{[^}]*\}/);
  assert.ok(wrapper, 'deferred-release wrapper must exist');
  assert.match(flat(wrapper[0]), /openSpimFile\([^;]*function\(\)\{[^\}]*input\.value\s*=\s*''/,
    'the wrapper must clear the input only from the release callback');

  const body = section(receive, 'async function openSpimFile', 'let currentWasm2');
  assert.match(body, /await file\.text\(\)/, 'the File must actually be read');
  const readAt = body.indexOf('await file.text()');
  assert.ok(body.indexOf('release();', readAt) > readAt, 'release must follow a successful read');
  assert.match(body, /finally\s*\{\s*release\(\);\s*\}/, 'release must also run on failure');
  assert.match(body, /localFileSeq/, 'stale local-file results must be ignored');
  assert.match(body, /file read failed/, 'interrupted reads must have an explicit error');
});
