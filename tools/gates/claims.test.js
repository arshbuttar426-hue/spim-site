'use strict';
/*
 * Claims must match mechanism.
 *
 * A sentence on the homepage is a spec. If the code cannot keep it, the gate
 * fails: either the mechanism moves up to the claim, or the claim comes down
 * to the mechanism. Silently shipping the gap is what this file exists to stop.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const home = read('index.html');

test('"Private by default." implies private is the default', () => {
  if (!/Private by default\./.test(home)) return;
  assert.match(
    home,
    /DEFAULT_VISIBILITY\s*=\s*'private'/,
    'index.html claims "Private by default." but DEFAULT_VISIBILITY is not private'
  );
});

test('"opens once" implies an atomic consume', () => {
  if (!/opens once|link stops working/i.test(home)) return;
  const consume = read('functions/capsules/[id]/consume.js');
  assert.match(
    consume,
    /ON CONFLICT\(id\) DO NOTHING/,
    'consume must be an atomic insert, not a read-modify-write'
  );
  assert.match(
    consume,
    /INSERT INTO capsule_open/,
    'consume must win a serialised D1 insert, not a KV read-modify-write'
  );
  assert.match(
    consume,
    /return json\(200, \{ consumed: true, id, blob \}\)/,
    'the payload must be released only by the consume response'
  );
});

test('no route may be called server-free unless it skips upload', () => {
  // Every capsule is POSTed before the delivery picker appears, so no delivery
  // route is server-free today. The absolute must not come back until one is.
  assert.doesNotMatch(
    home,
    /never touches a server|never reach a server/i,
    'no delivery route skips upload; state the route, not the absolute'
  );
});

test('QR is rendered in the browser', () => {
  assert.match(home, /SpimQR\.render/, 'QR must be rendered client-side');
  assert.match(read('_headers'), /img-src 'self' data: blob:;/, 'CSP still allows a QR host');
  for (const file of ['index.html', 'receive.html', '_headers']) {
    assert.doesNotMatch(
      read(file),
      /qrserver|goqr\.me|chart\.googleapis/,
      file + ' references an external QR service'
    );
  }
});

test('the single-view path is wired to the burn store', () => {
  assert.match(read('functions/capsules/[id]/consume.js'), /capsule_burn/);
  assert.match(read('functions/capsules/[id].js'), /capsule_burn/);
});
