#!/usr/bin/env node
/*
 * Writes a Web-encoded chirp as a 48 kHz mono WAV, for the Android decoder to
 * eat. This is the opposite direction of tools/parity-check.js:
 *
 *   node tools/make-wav.js "web to android 456" out.wav
 *
 * The lead-in is deliberately not a multiple of the 16-sample search grid, so
 * the Android decoder has to find the symbol clock rather than assume it.
 */
'use strict';

const fs = require('fs');
const path = require('path');

global.window = {};
eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'spim-codec.js'), 'utf8'));
const C = global.window.SpimCodec;

function wav(samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);            // PCM
  buf.writeUInt16LE(1, 22);            // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i])) * 32767;
    buf.writeInt16LE(v < 0 ? Math.round(v) : Math.round(v), 44 + i * 2);
  }
  return buf;
}

const text = process.argv[2];
const out = process.argv[3] || 'web-chirp.wav';
if (!text) {
  console.error('usage: node tools/make-wav.js "<payload>" [out.wav]');
  process.exit(2);
}

const payload = Buffer.from(text, 'utf8');
if (payload.length > C.MAX_PAYLOAD) {
  console.error('payload too large: ' + payload.length + ' > ' + C.MAX_PAYLOAD);
  process.exit(2);
}

const chirp = C.encode(payload);

// 1234 samples of low-level room noise: off the search grid, and low enough
// that it cannot be mistaken for the preamble.
const lead = new Float32Array(1234);
let seed = 99;
for (let i = 0; i < lead.length; i++) {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  lead[i] = (seed / 0x7fffffff * 2 - 1) * 0.01;
}

const all = new Float32Array(lead.length + chirp.length);
all.set(lead, 0);
all.set(chirp, lead.length);

const file = path.resolve(out);
fs.writeFileSync(file, wav(all, C.SAMPLE_RATE));
console.log('wrote ' + file);
console.log('payload ' + JSON.stringify(text) + ' (' + payload.length + ' B)');
console.log('audio   ' + (all.length / C.SAMPLE_RATE).toFixed(2) + ' s, ' + chirp.length + ' chirp samples');
