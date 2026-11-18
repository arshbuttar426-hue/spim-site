'use strict';
/*
 * "Opens once" is a database invariant, not a copy line.
 *
 * Runs the real migration against an in-memory SQLite database and proves the
 * fence: the first consume wins, the second is a no-op, and the winning
 * timestamp is the one that survives. No network, no cloud account.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const root = path.join(__dirname, '..', '..');
const migration = fs.readFileSync(path.join(root, 'migrations', '0001_capsule_burn.sql'), 'utf8');
const consumeSrc = fs.readFileSync(path.join(root, 'functions', 'capsules', '[id]', 'consume.js'), 'utf8');

const INSERT =
  'INSERT INTO capsule_burn (id, consumed_at, expires_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING';

function fresh() {
  const db = new DatabaseSync(':memory:');
  db.exec(migration);
  return db;
}

test('migration applies and is idempotent', () => {
  const db = fresh();
  db.exec(migration); /* a second deploy must not fail */
  const cols = db.prepare('PRAGMA table_info(capsule_burn)').all().map((c) => c.name);
  assert.deepStrictEqual(cols, ['id', 'consumed_at', 'expires_at']);
});

test('first consume wins, second loses, winner timestamp survives', () => {
  const db = fresh();
  const first = db.prepare(INSERT).run('abc123', 1000, 2000);
  const second = db.prepare(INSERT).run('abc123', 2000, 3000);
  assert.strictEqual(Number(first.changes), 1, 'first consume must win');
  assert.strictEqual(Number(second.changes), 0, 'second consume must be a no-op');
  const row = db.prepare('SELECT consumed_at FROM capsule_burn WHERE id = ?').get('abc123');
  assert.strictEqual(Number(row.consumed_at), 1000);
});

test('distinct capsules do not collide', () => {
  const db = fresh();
  assert.strictEqual(Number(db.prepare(INSERT).run('a', 1, 9).changes), 1);
  assert.strictEqual(Number(db.prepare(INSERT).run('b', 1, 9).changes), 1);
});

test('the shipped consume statement is this statement', () => {
  assert.match(consumeSrc, /ON CONFLICT\(id\) DO NOTHING/);
  assert.match(consumeSrc, /INSERT INTO capsule_burn/);
  assert.match(consumeSrc, /meta\.changes/);
});
