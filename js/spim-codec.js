/*
 * SPIM sonic codec — one wire format for Android and web.
 *
 * Spec (must match app/src/main/java/com/prima/spimchirp/not_as/MicrochirpAtoms.kt):
 *   48 000 Hz mono, 280 samples per symbol, 8-FSK (3 bits/symbol)
 *   tones      16 700 … 20 200 Hz, 500 Hz spacing (band "Standard")
 *   preamble   24 symbols alternating 0, 7 (lowest/highest tone)
 *   frame      magic 0x53 | len_hi | len_lo | crc8(first 3 bytes)
 *              | payload | crc16(payload) big-endian
 *   packing    3 bits per symbol, MSB first, zero padded
 *   taper      2 ms raised cosine on each end
 *
 * There is no per-device variant. A chirp beamed by either platform decodes on
 * the other because both ends implement exactly this.
 */
(function () {
  'use strict';

  var SAMPLE_RATE = 48000;
  var SYMBOL_SAMPLES = 280;
  var PREAMBLE_LEN = 24;
  var MAGIC = 0x53;
  var MAX_PAYLOAD = 16384;
  var TAPER_SAMPLES = Math.round(SAMPLE_RATE * 2 / 1000);
  var TONES = [16700, 17200, 17700, 18200, 18700, 19200, 19700, 20200];

  // Goertzel coefficients, computed once.
  var COEFF = TONES.map(function (f) { return 2 * Math.cos(2 * Math.PI * f / SAMPLE_RATE); });

  function crc8(d) {
    var c = 0;
    for (var i = 0; i < d.length; i++) {
      c ^= d[i] & 0xFF;
      for (var j = 0; j < 8; j++) c = (c & 0x80) ? ((c << 1) ^ 0x07) & 0xFF : (c << 1) & 0xFF;
    }
    return c & 0xFF;
  }

  function crc16(d) {
    var c = 0xFFFF;
    for (var i = 0; i < d.length; i++) {
      c ^= (d[i] & 0xFF) << 8;
      for (var j = 0; j < 8; j++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF;
    }
    return c & 0xFFFF;
  }

  function preambleSymbols() {
    var p = new Int8Array(PREAMBLE_LEN);
    for (var i = 0; i < PREAMBLE_LEN; i++) p[i] = i % 2 === 0 ? 0 : 7;
    return p;
  }
  var PREAMBLE = preambleSymbols();

  function symbolCount(bytes) {
    return Math.ceil(bytes * 8 / 3);
  }

  function symbolsToBytes(symbols, byteCount, offset, count) {
    var out = new Uint8Array(byteCount);
    var bit = 0;
    var total = byteCount * 8;
    for (var i = 0; i < count; i++) {
      var sym = symbols[offset + i];
      for (var b = 2; b >= 0; b--) {
        if (bit < total) {
          if ((sym >> b) & 1) out[bit >> 3] |= 1 << (7 - (bit & 7));
          bit++;
        }
      }
    }
    return out;
  }

  function bytesToSymbols(bytes) {
    var total = bytes.length * 8;
    var n = symbolCount(bytes.length);
    var out = new Int8Array(n);
    var bit = 0;
    for (var i = 0; i < n; i++) {
      var sym = 0;
      for (var b = 0; b < 3; b++) {
        var idx = bit + b;
        var v = 0;
        if (idx < total) {
          var byte = bytes[idx >> 3];
          v = (byte >> (7 - (idx & 7))) & 1;
        }
        sym = (sym << 1) | v;
      }
      out[i] = sym;
      bit += 3;
    }
    return out;
  }

  // --- encode -------------------------------------------------------------

  function frameBytes(payload) {
    var len = payload.length;
    var framed = new Uint8Array(4 + len + 2);
    framed[0] = MAGIC;
    framed[1] = (len >> 8) & 0xFF;
    framed[2] = len & 0xFF;
    framed[3] = crc8([MAGIC, framed[1], framed[2]]);
    framed.set(payload, 4);
    var c = crc16(payload);
    framed[4 + len] = (c >> 8) & 0xFF;
    framed[5 + len] = c & 0xFF;
    return framed;
  }

  function encode(payload) {
    if (payload.length > MAX_PAYLOAD) throw new Error('payload exceeds ' + MAX_PAYLOAD + ' bytes');
    var framed = frameBytes(payload);
    var dataSymbols = bytesToSymbols(framed);
    var total = PREAMBLE_LEN + dataSymbols.length;
    var out = new Float32Array(total * SYMBOL_SAMPLES);

    var phase = 0;
    var twoPi = 2 * Math.PI;
    var n = 0;
    for (var s = 0; s < total; s++) {
      var tone = s < PREAMBLE_LEN ? PREAMBLE[s] : dataSymbols[s - PREAMBLE_LEN];
      var step = twoPi * TONES[tone] / SAMPLE_RATE;
      for (var i = 0; i < SYMBOL_SAMPLES; i++) {
        out[n++] = Math.sin(phase);
        phase += step;
      }
      phase = phase % twoPi;
    }

    // Raised-cosine taper, same 2 ms as Android, so speakers do not click.
    var taper = Math.min(TAPER_SAMPLES, out.length);
    for (var k = 0; k < taper; k++) {
      var w = (1 - Math.cos(Math.PI * k / taper)) * 0.5;
      out[k] *= w;
      out[out.length - 1 - k] *= w;
    }
    return out;
  }

  // --- decode primitives --------------------------------------------------

  function symbolAt(samples, start) {
    var best = 0;
    var bestPower = -1;
    for (var t = 0; t < TONES.length; t++) {
      var coeff = COEFF[t];
      var s1 = 0, s2 = 0;
      for (var i = 0; i < SYMBOL_SAMPLES; i++) {
        var s0 = samples[start + i] + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      var power = s1 * s1 - coeff * s1 * s2 + s2 * s2;
      if (power > bestPower) { bestPower = power; best = t; }
    }
    return best;
  }

  /** Payload length if a valid header begins at `start`, else -1. */
  function payloadLengthAt(samples, start) {
    if (start < 0 || samples.length < start + (PREAMBLE_LEN + 11) * SYMBOL_SAMPLES) return -1;
    var syms = new Int8Array(11);
    for (var k = 0; k < 11; k++) syms[k] = symbolAt(samples, start + (PREAMBLE_LEN + k) * SYMBOL_SAMPLES);
    var h = symbolsToBytes(syms, 4, 0, 11);
    if (h[0] !== MAGIC) return -1;
    if (crc8([h[0], h[1], h[2]]) !== h[3]) return -1;
    var len = (h[1] << 8) | h[2];
    if (len <= 0 || len > MAX_PAYLOAD) return -1;
    return len;
  }

  /** Decode the frame whose preamble starts at `start`; null unless both CRCs pass. */
  function decodeFrameAt(samples, start) {
    var len = payloadLengthAt(samples, start);
    if (len <= 0) return null;
    var totalBytes = 4 + len + 2;
    var n = symbolCount(totalBytes);
    if (samples.length < start + (PREAMBLE_LEN + n) * SYMBOL_SAMPLES) return null;

    var syms = new Int8Array(n);
    for (var k = 0; k < n; k++) syms[k] = symbolAt(samples, start + (PREAMBLE_LEN + k) * SYMBOL_SAMPLES);
    var framed = symbolsToBytes(syms, totalBytes, 0, n);

    var payload = framed.subarray(4, 4 + len);
    var expected = crc16(payload);
    var got = (framed[4 + len] << 8) | framed[5 + len];
    if (expected !== got) return null;
    return new Uint8Array(payload);
  }

  /** Batch decode over a buffer that starts anywhere. Used by tests and files. */
  function decodeSamples(samples) {
    var phases = SYMBOL_SAMPLES / 16;
    for (var p = 0; p < phases; p++) {
      var off = p * 16;
      var count = Math.floor((samples.length - off) / SYMBOL_SAMPLES);
      if (count < PREAMBLE_LEN + 12) continue;
      var syms = new Int8Array(count);
      for (var i = 0; i < count; i++) syms[i] = symbolAt(samples, off + i * SYMBOL_SAMPLES);
      for (var w = 0; w <= count - PREAMBLE_LEN; w++) {
        var match = 0;
        for (var k = 0; k < PREAMBLE_LEN; k++) if (syms[w + k] === PREAMBLE[k]) match++;
        if (match < 22) continue;
        // Try the exact sample offset first, then the neighbours the 16-sample
        // grid could have skipped.
        for (var d = -8; d <= 8; d++) {
          var r = decodeFrameAt(samples, off + w * SYMBOL_SAMPLES + d);
          if (r) return r;
        }
      }
    }
    return null;
  }

  // --- continuous receiver ------------------------------------------------

  var SEARCH_STRIDE = 4096;
  var OFFSET_STEP = 16;
  var MAX_LOCK_LEAD = SYMBOL_SAMPLES / 2;
  var LOCK_LEAD_STEP = 4;
  var ENERGY_FLOOR = 0.002;

  function hasSignal(buf, size) {
    var n = Math.min(size, 3 * SYMBOL_SAMPLES);
    if (n <= 0) return false;
    var e = 0;
    for (var i = size - n; i < size; i++) e += buf[i] * buf[i];
    return Math.sqrt(e / n) >= ENERGY_FLOOR;
  }

  function findPreambleStart(buf, size) {
    var earliestFull = -1;
    var bestOffset = -1;
    var bestMatches = 0;
    for (var phase = 0; phase < SYMBOL_SAMPLES; phase += OFFSET_STEP) {
      var count = Math.floor((size - phase) / SYMBOL_SAMPLES);
      if (count < PREAMBLE_LEN) continue;
      var vals = new Int8Array(count);
      for (var i = 0; i < count; i++) vals[i] = symbolAt(buf, phase + i * SYMBOL_SAMPLES);
      for (var w = 0; w <= count - PREAMBLE_LEN; w++) {
        var m = 0;
        for (var k = 0; k < PREAMBLE_LEN; k++) if (vals[w + k] === PREAMBLE[k]) m++;
        if (m === PREAMBLE_LEN) {
          var at = phase + w * SYMBOL_SAMPLES;
          if (earliestFull < 0 || at < earliestFull) earliestFull = at;
        } else if (m > bestMatches) {
          bestMatches = m;
          bestOffset = phase + w * SYMBOL_SAMPLES;
        }
      }
    }
    return earliestFull >= 0 ? earliestFull : (bestMatches >= 22 ? bestOffset : -1);
  }

  /**
   * Continuous receiver. Mirrors StreamingChirpDecoder.kt so the two platforms
   * behave identically: bounded preamble search while unlocked, CRC-verified
   * decode at nearby offsets once locked, never stops on a catch.
   */
  function createReceiver(onPayload) {
    var buf = new Float32Array(48000 * 4); // grows as needed
    var size = 0;
    var locked = false;
    var sinceSearch = 0;

    function ensure(required) {
      if (required <= buf.length) return;
      var cap = buf.length;
      while (cap < required) cap *= 2;
      var next = new Float32Array(cap);
      next.set(buf.subarray(0, size));
      buf = next;
    }

    function dropFront(count) {
      if (count <= 0) return;
      if (count >= size) { size = 0; return; }
      buf.copyWithin(0, count, size);
      size -= count;
    }

    function trimUnlocked() {
      var keep = (PREAMBLE_LEN + 2) * SYMBOL_SAMPLES;
      if (size > keep) dropFront(size - keep);
    }

    function decodeLocked() {
      var waiting = false;
      for (var off = 0; off <= MAX_LOCK_LEAD; off += LOCK_LEAD_STEP) {
        var len = payloadLengthAt(buf.subarray(0, size), off);
        if (len <= 0) continue;
        var need = off + (PREAMBLE_LEN + symbolCount(4 + len + 2)) * SYMBOL_SAMPLES;
        if (size < need) { waiting = true; continue; }
        var payload = decodeFrameAt(buf.subarray(0, size), off);
        if (payload) {
          dropFront(need);
          locked = false;
          sinceSearch = SEARCH_STRIDE;
          return payload;
        }
      }
      if (waiting) return undefined;
      // Candidate was false: skip one symbol and keep looking.
      locked = false;
      sinceSearch = SEARCH_STRIDE;
      dropFront(SYMBOL_SAMPLES);
      return undefined;
    }

    return {
      /** Feed microphone samples. Returns a payload when one completes. */
      push: function (chunk) {
        ensure(size + chunk.length);
        buf.set(chunk, size);
        size += chunk.length;
        sinceSearch += chunk.length;

        if (!locked) {
          if (size < (PREAMBLE_LEN + 1) * SYMBOL_SAMPLES) return undefined;
          if (sinceSearch < SEARCH_STRIDE) return undefined;
          sinceSearch = 0;
          if (!hasSignal(buf, size)) { trimUnlocked(); return undefined; }
          var start = findPreambleStart(buf, size);
          if (start < 0) { trimUnlocked(); return undefined; }
          dropFront(start);
          locked = true;
        }
        if (size < MAX_LOCK_LEAD + (PREAMBLE_LEN + 11) * SYMBOL_SAMPLES) return undefined;
        return decodeLocked();
      },
      reset: function () { size = 0; locked = false; sinceSearch = 0; },
      pending: function () { return size; }
    };
  }

  window.SpimCodec = {
    SAMPLE_RATE: SAMPLE_RATE,
    SYMBOL_SAMPLES: SYMBOL_SAMPLES,
    PREAMBLE_LEN: PREAMBLE_LEN,
    MAX_PAYLOAD: MAX_PAYLOAD,
    TONES: TONES,
    crc8: crc8,
    crc16: crc16,
    encode: encode,
    decodeSamples: decodeSamples,
    decodeFrameAt: decodeFrameAt,
    createReceiver: createReceiver
  };
})();
