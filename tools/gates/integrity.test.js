'use strict';
/*
 * Regression for the homepage Catch integrity bypass.
 *
 * The original bug displayed a legacy notes[] capsule as "Caught · verified"
 * without checking its hash. These tests execute the shipped shared verifier
 * against valid and tampered CAP1 envelopes, and assert that both the homepage
 * and /receive are wired to that one verifier before any trusted display.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const root = path.join(__dirname, '..', '..');
const clientSrc = fs.readFileSync(path.join(root, 'js', 'spim-capsule-client.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const receiveHtml = fs.readFileSync(path.join(root, 'receive.html'), 'utf8');

function loadClient(){
  const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
  class FakeWasmSpim {
    constructor(){ this.mem = []; }
    remember(s){ this.mem.push(s); return this.mem.length - 1; }
    verify_reconstruct(id, s){ return this.mem[id] === s; }
    blake3_bytes_hex(b64){ return hash(b64); }
    free(){}
  }
  const ctx = {
    window: {
      wasmReady: true,
      blake3_hex_static: hash,
      WasmSpim: FakeWasmSpim,
      format_delta_apply: (norm) => norm
    },
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    escape,
    unescape,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    crypto,
    console
  };
  vm.createContext(ctx);
  vm.runInContext(clientSrc, ctx);
  return ctx;
}

function note(text, blake3){
  return {
    source_b64: ctxBtoa(text),
    source_blake3: blake3
  };
}
let ctxBtoa = (s) => Buffer.from(s, 'utf8').toString('base64');

function envelopeWith(noteText, imageBytes){
  const ctx = loadClient();
  const hash = ctx.window.blake3_hex_static;
  const n = note(noteText, hash(noteText));
  const env = {
    magic: 'CAP1',
    product_version: 1,
    spim_version: 1,
    tokenization_version: 1,
    flags: 0,
    created_at: '2026-11-23T00:00:00.000Z',
    notes: [n],
    images: imageBytes === undefined ? [] : [{
      kind: 'image',
      source_bytes_b64: ctx.btoa(imageBytes),
      mime: 'image/png',
      filename: 'a.png',
      source_blake3: hash(ctx.btoa(imageBytes))
    }],
    spim_b64: '',
    word_count: 2,
    blake3: ''
  };
  env.blake3 = hash(JSON.stringify(Object.assign({}, env, {blake3: ''})));
  return {ctx, env};
}

test('valid, unmodified envelope verifies', () => {
  const {ctx, env} = envelopeWith('original payload alpha');
  const out = ctx.spimVerifyEnvelope(JSON.stringify(env));
  assert.strictEqual(out.env.magic, 'CAP1');
  assert.strictEqual(out.notes[0].source, 'original payload alpha');
});

test('B: modified text payload is rejected (even with envelope hash recomputed)', () => {
  const {ctx, env} = envelopeWith('original payload alpha');
  env.notes[0].source_b64 = ctxBtoa('TAMPED payload alpha');
  env.blake3 = ctx.window.blake3_hex_static(JSON.stringify(Object.assign({}, env, {blake3: ''})));
  assert.throws(() => ctx.spimVerifyEnvelope(JSON.stringify(env)), /blake3 mismatch/);
});

test('C: modified image payload is rejected', () => {
  const {ctx, env} = envelopeWith('original payload alpha', '\x89PNG\r\n\x1a\nORIGINAL');
  env.images[0].source_bytes_b64 = ctx.btoa('\x89PNG\r\n\x1a\nTAMPED!!');
  env.blake3 = ctx.window.blake3_hex_static(JSON.stringify(Object.assign({}, env, {blake3: ''})));
  assert.throws(() => ctx.spimVerifyEnvelope(JSON.stringify(env)), /blake3 mismatch/);
});

test('D: modified integrity hash is rejected', () => {
  const {ctx, env} = envelopeWith('original payload alpha');
  env.blake3 = '0'.repeat(64);
  assert.throws(() => ctx.spimVerifyEnvelope(JSON.stringify(env)), /blake3 mismatch/);
});

test('E: missing integrity metadata is rejected', () => {
  const {ctx, env} = envelopeWith('original payload alpha');
  delete env.blake3;
  assert.throws(() => ctx.spimVerifyEnvelope(JSON.stringify(env)), /blake3 mismatch/);

  // Even with a recomputed envelope hash, missing per-note/per-image hashes
  // must not count as successful verification.
  const noteCase = envelopeWith('original payload alpha');
  delete noteCase.env.notes[0].source_blake3;
  noteCase.env.blake3 = noteCase.ctx.window.blake3_hex_static(JSON.stringify(Object.assign({}, noteCase.env, {blake3: ''})));
  assert.throws(() => noteCase.ctx.spimVerifyEnvelope(JSON.stringify(noteCase.env)), /blake3 mismatch/);

  const imageCase = envelopeWith('original payload alpha', '\x89PNG\r\n\x1a\nORIGINAL');
  delete imageCase.env.images[0].source_blake3;
  imageCase.env.blake3 = imageCase.ctx.window.blake3_hex_static(JSON.stringify(Object.assign({}, imageCase.env, {blake3: ''})));
  assert.throws(() => imageCase.ctx.spimVerifyEnvelope(JSON.stringify(imageCase.env)), /blake3 mismatch/);
});

test('F: malformed capsule is safely rejected', () => {
  const {ctx} = envelopeWith('original payload alpha');
  assert.throws(() => ctx.spimVerifyEnvelope('{'), err => err && err.name === 'SyntaxError');
  assert.throws(() => ctx.spimVerifyEnvelope(JSON.stringify({magic: 'NOPE', blake3: '0'.repeat(64)})), /bad magic/);
});

test('homepage Catch calls the canonical verifier before showing a verified result', () => {
  const openAt = indexHtml.indexOf('async function openSpimFile');
  assert.ok(openAt > -1, 'openSpimFile must exist');
  const verifyAt = indexHtml.indexOf('await spimAuthenticateEnvelope(jsonStr', openAt);
  const showAt = indexHtml.indexOf('showCaught(token,', openAt);
  assert.ok(verifyAt > openAt, 'openSpimFile must call spimVerifyEnvelope');
  assert.ok(showAt > verifyAt, 'verified display must happen after verification');
  assert.ok(!/spim-pill--verified[^>]*>\s*<i[^>]*><\/i>\s*Caught · verified/.test(indexHtml),
    'the verified badge must not be unconditional');
  assert.match(indexHtml, /Caught · unverified/, 'neutral badge state must exist');
  assert.ok(!indexHtml.includes('spimResolveCatchNotes'), 'tolerant reconstruction must not be used for Catch display');
  assert.match(indexHtml, /showCaught\(token, text, false, text\)/, 'sound catches must be labelled unverified');
});

test('/receive uses the same canonical verifier', () => {
  const at = receiveHtml.indexOf('async function finalizeEnvelope');
  assert.ok(at > -1);
  assert.ok(receiveHtml.indexOf('await spimAuthenticateEnvelope(jsonStr', at) > at,
    'receive must not keep a separate verification procedure');
});
