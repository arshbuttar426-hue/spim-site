#!/usr/bin/env node
/*
 * Cross-platform parity check.
 *
 * Reads a WAV recorded or generated on the other platform and decodes it with
 * the web codec, so "a phone chirp is caught by the website" is proven against
 * real bytes rather than by re-encoding on the same platform.
 *
 *   node tools/parity-check.js ../spim-chirp-android/app/build/parity/android-chirp.wav "android to web 123"
 *
 * Exits 0 on a match, 1 otherwise. Prints both the batch decode and the
 * streaming receiver result, because the site uses the streaming one.
 */
'use strict';

const fs = require('fs');
const path = require('path');

global.window = {};
eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'spim-codec.js'), 'utf8'));
const C = global.window.SpimCodec;

/** Minimal WAV reader: 16-bit PCM or 32-bit float, mono or take channel 0. */
function readWav(file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let pos = 12;
  let fmt = null;
  let data = null;
  while (pos + 8 <= b.length) {
    const id = b.toString('ascii', pos, pos + 4);
    const size = b.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      fmt = {
        format: b.readUInt16LE(body),
        channels: b.readUInt16LE(body + 2),
        sampleRate: b.readUInt32LE(body + 4),
        bits: b.readUInt16LE(body + 14)
      };
    } else if (id === 'data') {
      data = b.subarray(body, Math.min(body + size, b.length));
    }
    pos = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('missing fmt or data chunk');
  if (fmt.sampleRate !== C.SAMPLE_RATE) {
    throw new Error('sample rate ' + fmt.sampleRate + ' Hz, codec needs ' + C.SAMPLE_RATE);
  }

  const frames = Math.floor(data.length / (fmt.channels * fmt.bits / 8));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const o = i * fmt.channels * (fmt.bits / 8);
    if (fmt.format === 3 && fmt.bits === 32) out[i] = data.readFloatLE(o);
    else if (fmt.bits === 16) out[i] = data.readInt16LE(o) / 32768;
    else if (fmt.bits === 24) {
      const v = data[o] | (data[o + 1] << 8) | (data[o + 2] << 16);
      out[i] = ((v << 8) >> 8) / 8388608;
    } else if (fmt.bits === 32) out[i] = data.readInt32LE(o) / 2147483648;
    else throw new Error('unsupported ' + fmt.bits + '-bit samples');
  }
  return { fmt, samples: out };
}

function main() {
  const file = process.argv[2];
  const expected = process.argv[3];
  if (!file) {
    console.error('usage: node tools/parity-check.js <file.wav> [expected payload]');
    process.exit(2);
  }

  const { fmt, samples } = readWav(path.resolve(file));
  console.log(
    'wav      ' + fmt.sampleRate + ' Hz, ' + fmt.bits + '-bit, ' +
    fmt.channels + ' ch, ' + (samples.length / fmt.sampleRate).toFixed(2) + ' s'
  );

  // Batch decode: starts anywhere in the buffer.
  const t0 = Date.now();
  const batch = C.decodeSamples(samples);
  const batchMs = Date.now() - t0;
  const batchText = batch ? Buffer.from(batch).toString('utf8') : null;
  console.log('batch    ' + (batchText === null ? '(no frame)' : JSON.stringify(batchText)) + '  ' + batchMs + ' ms');

  // Streaming decode: what the page actually runs, fed in 2048-sample blocks.
  const rx = C.createReceiver();
  let streamed = null;
  for (let i = 0; i < samples.length; i += 2048) {
    const r = rx.push(samples.subarray(i, Math.min(i + 2048, samples.length)));
    if (r) { streamed = r; break; }
  }
  const streamText = streamed ? Buffer.from(streamed).toString('utf8') : null;
  console.log('stream   ' + (streamText === null ? '(no frame)' : JSON.stringify(streamText)));

  if (!expected) {
    console.log('result   ' + (batchText !== null ? 'decoded' : 'FAILED'));
    process.exit(batchText !== null ? 0 : 1);
  }

  const ok = batchText === expected && streamText === expected;
  console.log('expected ' + JSON.stringify(expected));
  console.log('result   ' + (ok ? 'MATCH' : 'MISMATCH'));
  process.exit(ok ? 0 : 1);
}

main();
