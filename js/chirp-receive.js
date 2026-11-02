/*
 * SPIM chirp receiver — 2-FSK, 48 kHz, 480 samples/symbol.
 *
 * Shared by any page that needs to catch a spoken-into-the-mic capsule. The
 * receiver is continuous: it never tears the mic down after a catch, so the
 * next drop needs no tap. Work per audio callback is O(new samples) plus, at
 * most every 120 ms, one decode over an 8 s window.
 *
 * Exposes window.SpimChirp:
 *   decodeSamples(Float32Array) -> Uint8Array | null   (CRC-verified)
 *   createReceiver({onCatch, onLevel}) -> {start, stop, isListening}
 */
(function () {
  var SAMPLE_RATE = 48000;
  var SYMBOL_SAMPLES = 480;
  var FREQ_BIT0 = 21000;
  var FREQ_BIT1 = 23000;
  var PREAMBLE_LEN = 24;
  var MAGIC = 0x53;
  var MAX_PAYLOAD = 4096;

  var RING_SECONDS = 12;
  var WINDOW_SECONDS = 8;
  var DECODE_MIN_INTERVAL_MS = 120;
  var RMS_GATE = 0.010;
  var MIN_SYMBOLS = PREAMBLE_LEN + 24;

  function crc8(d) {
    var c = 0;
    for (var i = 0; i < d.length; i++) {
      c ^= d[i];
      for (var j = 0; j < 8; j++) {
        if (c & 0x80) c = ((c << 1) ^ 0x07) & 0xFF;
        else c = (c << 1) & 0xFF;
      }
    }
    return c & 0xFF;
  }

  function crc16(d) {
    var c = 0xFFFF;
    for (var i = 0; i < d.length; i++) {
      c ^= (d[i] << 8);
      for (var j = 0; j < 8; j++) {
        if (c & 0x8000) c = ((c << 1) ^ 0x1021) & 0xFFFF;
        else c = (c << 1) & 0xFFFF;
      }
    }
    return c & 0xFFFF;
  }

  function goertzel(pwr, f) {
    var s1 = 0, s2 = 0;
    var c = 2 * Math.cos(2 * Math.PI * f / SAMPLE_RATE);
    for (var i = 0; i < pwr.length; i++) {
      var s0 = pwr[i] + c * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    return s1 * s1 - c * s1 * s2 + s2 * s2;
  }

  function symbolBit(s) {
    return goertzel(s, FREQ_BIT1) > goertzel(s, FREQ_BIT0);
  }

  function decodeSamples(samples) {
    var n = Math.floor(samples.length / SYMBOL_SAMPLES);
    if (n < PREAMBLE_LEN + 20) return null;
    var pre = [];
    for (var i = 0; i < PREAMBLE_LEN; i++) pre.push(i % 2 === 0);

    for (var off = 0; off < SYMBOL_SAMPLES; off += 16) {
      var ns = Math.floor((samples.length - off) / SYMBOL_SAMPLES);
      if (ns < PREAMBLE_LEN + 10) continue;
      var bits = new Array(ns).fill(false);
      var sym = new Float32Array(SYMBOL_SAMPLES);
      for (var s = 0; s < ns; s++) {
        var st = off + s * SYMBOL_SAMPLES;
        for (var i2 = 0; i2 < SYMBOL_SAMPLES; i2++) sym[i2] = samples[st + i2];
        bits[s] = symbolBit(sym);
      }
      for (var w = 0; w < ns - PREAMBLE_LEN + 1; w++) {
        var c = 0;
        for (var k = 0; k < PREAMBLE_LEN; k++) if (bits[w + k] === pre[k]) c++;
        if (c < 22) continue;
        var p = w + PREAMBLE_LEN;
        var fbytes = Math.floor((ns - p) / 8);
        var fbits = [];
        for (var j = p; j < p + fbytes * 8; j++) fbits.push(bits[j]);
        var framed = [];
        for (var x = 0; x < fbits.length; x += 8) {
          var b = 0;
          for (var y = 0; y < 8; y++) b = (b << 1) | (fbits[x + y] ? 1 : 0);
          framed.push(b & 0xFF);
        }
        if (framed.length < 6 || framed[0] !== MAGIC) continue;
        if (crc8([framed[0], framed[1], framed[2]]) !== framed[3]) continue;
        var len = (framed[1] << 8) | framed[2];
        if (len > MAX_PAYLOAD || framed.length < 4 + len + 2) continue;
        var payload = framed.slice(4, 4 + len);
        var crx = (framed[4 + len] << 8) | framed[4 + len + 1];
        if (crx !== crc16(payload)) continue;
        return new Uint8Array(payload);
      }
    }
    return null;
  }

  function createReceiver(opts) {
    opts = opts || {};
    var onCatch = opts.onCatch || function () {};
    var onLevel = opts.onLevel || function () {};
    var listening = false;
    var ctx = null, proc = null, src = null, stream = null;
    var ring = null, pos = 0, len = 0, lastDecode = 0;

    function clearRing() {
      pos = 0;
      len = 0;
      lastDecode = 0;
    }

    function rms(samples) {
      var e = 0;
      for (var i = 0; i < samples.length; i++) e += samples[i] * samples[i];
      return Math.sqrt(e / samples.length);
    }

    // Copy the newest maxLen samples out of the circular buffer, oldest first.
    function windowOf(maxLen) {
      var take = Math.min(len, maxLen);
      var out = new Float32Array(take);
      var cap = ring.length;
      var start = ((pos - take) % cap + cap) % cap;
      for (var i = 0; i < take; i++) out[i] = ring[(start + i) % cap];
      return out;
    }

    function start() {
      if (listening) return Promise.resolve(true);
      ring = new Float32Array(SAMPLE_RATE * RING_SECONDS);
      clearRing();
      try {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        ctx = new Ctx({ sampleRate: SAMPLE_RATE });
        return navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 1
          }
        }).then(function (s) {
          stream = s;
          src = ctx.createMediaStreamSource(stream);
          proc = ctx.createScriptProcessor(2048, 1, 1);
          var zero = ctx.createGain();
          zero.gain.value = 0;
          proc.onaudioprocess = function (e) {
            if (!listening) return;
            var ch = e.inputBuffer.getChannelData(0);
            for (var i = 0; i < ch.length; i++) {
              ring[pos] = ch[i];
              pos = (pos + 1) % ring.length;
              if (len < ring.length) len++;
            }
            onLevel(rms(ch));
            if (len < SYMBOL_SAMPLES * MIN_SYMBOLS) return;

            // Silence cannot contain a preamble, and a decode over the window
            // is the expensive part, so gate and throttle before it.
            var now = performance.now();
            if (now - lastDecode < DECODE_MIN_INTERVAL_MS) return;
            lastDecode = now;
            if (rms(ch) < RMS_GATE) return;

            var payload = decodeSamples(windowOf(SAMPLE_RATE * WINDOW_SECONDS));
            if (payload) {
              // Consume the window but stay armed: the mic, context, and
              // processor are never torn down on a catch.
              clearRing();
              onCatch(payload);
            }
          };
          src.connect(proc);
          proc.connect(zero);
          zero.connect(ctx.destination);
          listening = true;
          return true;
        });
      } catch (err) {
        stop();
        return Promise.reject(err);
      }
    }

    function stop() {
      listening = false;
      try { if (proc) proc.disconnect(); if (src) src.disconnect(); } catch (e) {}
      try { if (stream) stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
      try { if (ctx) ctx.close(); } catch (e) {}
      proc = null;
      src = null;
      stream = null;
      ctx = null;
      ring = null;
      clearRing();
      return Promise.resolve();
    }

    return {
      start: start,
      stop: stop,
      isListening: function () { return listening; }
    };
  }

  window.SpimChirp = {
    decodeSamples: decodeSamples,
    createReceiver: createReceiver
  };
})();
