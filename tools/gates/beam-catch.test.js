'use strict';
/*
 * Fix 5 — software-only Beam/Catch integrity invariants.
 *
 * No physical speaker or microphone is involved here. What this gate promises:
 *   - the shipped sonic codec round-trips short and larger capsule links;
 *   - CRC8 header and CRC16 payload checks reject corrupted or truncated audio;
 *   - the continuous receiver emits nothing for a corrupt frame;
 *   - sound-caught text is always shown unverified and is de-duplicated in the UI;
 *   - Beam rejects empty/invalid/oversize input before any audio is played, and
 *     mic permission failure is reported instead of silently continuing.
 *
 * Physical speaker-to-microphone behaviour remains untested and is not claimed.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..');
const codecSrc = fs.readFileSync(path.join(root, 'js', 'spim-codec.js'), 'utf8');
const audioSrc = fs.readFileSync(path.join(root, 'js', 'spim-audio.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function loadCodec() {
  const ctx = { window: {} };
  ctx.window.window = ctx.window;
  vm.createContext(ctx);
  vm.runInContext(codecSrc, ctx);
  return ctx.window.SpimCodec;
}

const C = loadCodec();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function roundTrip(text) {
  const enc = C.encode(encoder.encode(text));
  const batch = C.decodeSamples(enc);
  const receiver = C.createReceiver();
  let streamed = null;
  for (let i = 0; i < enc.length; i += 2048) {
    const p = receiver.push(enc.subarray(i, i + 2048));
    if (p) streamed = p;
  }
  return {
    batch: batch ? decoder.decode(batch) : null,
    streamed: streamed ? decoder.decode(streamed) : null
  };
}

function receiverPayloads(samples) {
  const receiver = C.createReceiver();
  const out = [];
  for (let i = 0; i < samples.length; i += 2048) {
    const p = receiver.push(samples.subarray(i, i + 2048));
    if (p) out.push(decoder.decode(p));
  }
  return out;
}

// Force a different tone into one symbol slot, leaving every other symbol intact.
function corruptSymbol(samples, symbolIndex) {
  const out = new Float32Array(samples);
  const start = (C.PREAMBLE_LEN + symbolIndex) * C.SYMBOL_SAMPLES;
  for (let i = 0; i < C.SYMBOL_SAMPLES; i++) {
    out[start + i] = Math.sin(i * 2 * Math.PI * C.TONES[7] / C.SAMPLE_RATE);
  }
  return out;
}

const SHORT_LINK = 'https://www.spim.co.in/receive#c/fix5short';
const LARGE_LINK = 'https://www.spim.co.in/receive#c/' + 'L'.repeat(2048);

test('codec round-trips short and larger capsule links (batch and streaming)', () => {
  for (const text of [SHORT_LINK, LARGE_LINK]) {
    const r = roundTrip(text);
    assert.equal(r.batch, text, 'batch decode must match for ' + text.length + ' B');
    assert.equal(r.streamed, text, 'stream decode must match for ' + text.length + ' B');
  }
});

test('corrupted header or payload symbols are rejected, never decoded', () => {
  const clean = C.encode(encoder.encode(SHORT_LINK));
  // 11 symbols carry magic/length/CRC8; later symbols carry payload/CRC16.
  for (const idx of [0, 3, 11, 20]) {
    const bad = corruptSymbol(clean, idx);
    assert.equal(C.decodeSamples(bad), null, 'batch must reject corrupted symbol ' + idx);
    assert.deepEqual(receiverPayloads(bad), [], 'receiver must emit nothing for symbol ' + idx);
  }
});

test('truncated audio is rejected and benign lead-in noise is tolerated', () => {
  const clean = C.encode(encoder.encode(SHORT_LINK));
  assert.equal(C.decodeSamples(clean.subarray(0, Math.floor(clean.length / 2))), null);
  const lead = new Float32Array(1234);
  for (let i = 0; i < lead.length; i++) lead[i] = Math.sin(i) * 0.01;
  const withLead = new Float32Array(lead.length + clean.length);
  withLead.set(lead, 0);
  withLead.set(clean, lead.length);
  assert.equal(decoder.decode(C.decodeSamples(withLead)), SHORT_LINK);
});

test('CRC primitives change on any single-byte mutation', () => {
  const header = [C.encode(encoder.encode(SHORT_LINK))[0], 0, SHORT_LINK.length & 0xFF];
  const crc8 = C.crc8(header);
  header[1] ^= 0x01;
  assert.notEqual(C.crc8(header), crc8);
  const payload = encoder.encode(SHORT_LINK);
  const crc16 = C.crc16(payload);
  payload[0] ^= 0x01;
  assert.notEqual(C.crc16(payload), crc16);
});

test('oversize payloads are refused before encoding', () => {
  assert.throws(() => C.encode(new Uint8Array(C.MAX_PAYLOAD + 1)), /exceeds/);
});

test('the codec does not de-duplicate replays; the UI must do so', () => {
  const one = C.encode(encoder.encode(SHORT_LINK));
  const two = new Float32Array(one.length * 2);
  two.set(one, 0);
  two.set(one, one.length);
  assert.equal(receiverPayloads(two).length, 2);
  assert.match(html, /if\(text === lastCaught && now - lastCaughtAt < 2500\) return;/);
  assert.match(html, /const token = \+\+catchDisplaySeq;/);
});

test('sound-caught text is always displayed unverified', () => {
  assert.match(html, /showCaught\(token, text, false, text\)/);
  assert.match(html, /trust === 'integrity' \? 'integrity-only'/);
  assert.match(html, /badge\.classList\.toggle\('spim-pill--verified', authentic\)/);
  const onCaught = html.match(/function onCaught\(payload\)\{([\s\S]*?)\n\}/);
  assert.ok(onCaught, 'onCaught must exist');
  assert.ok(!/spimVerifyEnvelope/.test(onCaught[1]), 'sound path must not self-verify');
  assert.ok(html.includes('id="caughtBadge"'), 'caught badge must exist');
  assert.ok(html.includes('Caught · unverified</span>'), 'badge must start unverified');
});

test('CAP1 Catch files are labelled integrity-only, never verified', () => {
  const showCaught = html.match(/function showCaught\(token, text, verified, href, trust\)\{([\s\S]*?)\n\}/);
  assert.ok(showCaught, 'showCaught must exist');
  assert.match(showCaught[1], /trust === 'authentic' \? 'authentic' : trust === 'integrity' \? 'integrity-only'/);
  assert.match(showCaught[1], /toggle\('spim-pill--verified', authentic\)/);
  assert.match(html, /showCaught\(token, display \|\| '\(empty capsule\)', true, null, verified\.trust\)/);
});

test('caught links are gated to http(s)/receive URLs only', () => {
  const showCaught = html.match(/function showCaught\(token, text, verified, href, trust\)\{([\s\S]*?)\n\}/);
  assert.ok(showCaught, 'showCaught must exist');
  assert.ok(showCaught[1].includes('/^https?:\\/\\//i.test(href)'), 'http(s) links allowed');
  assert.ok(showCaught[1].includes('/^\\/receive#c\\//.test(href)'), 'receive path must be anchored');
  assert.ok(!showCaught[1].includes('| /\\/receive#c\\//.test(href)'),
    'unanchored substring match would allow javascript:/data: URLs');
});

test('Beam refuses empty, malformed and oversize input before playback', () => {
  assert.match(html, /if\(!value\)\{ err\.textContent = 'Create a capsule or paste its link first\.'/);
  assert.match(html, /err\.textContent = 'That does not look like a capsule link\.'/);
  assert.match(html, /if\(bytes\.length > window\.SpimCodec\.MAX_PAYLOAD\)\{/);
  assert.match(html, /err\.textContent = 'Too much data for a sound beam\.'/);
  assert.match(html, /err\.textContent = 'Could not encode the beam\.'/);
  const beam = html.match(/function startBeam\(text\)\{([\s\S]*?)\n\}/);
  assert.ok(beam, 'startBeam must exist');
  assert.ok(beam[1].indexOf('MAX_PAYLOAD') < beam[1].indexOf('playBeam'),
    'oversize check must precede playback');
});

test('mic errors are reported and the mic stream stays signal-clean', () => {
  assert.match(html, /e && e\.name === 'NotAllowedError' \? 'Mic blocked' : 'Mic unavailable'/);
  assert.match(audioSrc, /echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1/);
  assert.match(audioSrc, /var receiver = global\.SpimCodec\.createReceiver\(\);/);
  assert.match(audioSrc, /var payload = receiver\.push\(new Float32Array\(ch\)\);/);
});
