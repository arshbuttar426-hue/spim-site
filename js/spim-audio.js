/*
 * spim-audio.js — sound engine for SPIM (beam/catch/drop).
 * Owns AudioContext lifecycle, beam playback, mic listening, and drop sounds.
 * Exposes window.SpimAudio for the inline page scripts.
 */
(function (global) {
  'use strict';

  var STATES = { IDLE: 'idle', READY: 'ready', PLAYING: 'playing', LISTENING: 'listening' };

  function Emitter() { this.map = Object.create(null); }
  Emitter.prototype.on = function (ev, fn) { (this.map[ev] = this.map[ev] || []).push(fn); return this; };
  Emitter.prototype.emit = function (ev, payload) {
    var list = this.map[ev] || [];
    for (var i = 0; i < list.length; i++) { try { list[i](payload); } catch (e) {} }
  };
  var emitter = new Emitter();

  var DROP_PARAMS = {
    chime:  { type: 'triangle', f0: 880,  f1: 880,  t0: 0.008, t1: 0.24, gain: 0.24 },
    ding:   { type: 'sine',     f0: 1046, f1: 1046, t0: 0.01,  t1: 0.55, gain: 0.22 },
    whoosh: { type: 'sawtooth', f0: 420,  f1: 1250, t0: 0.05,  t1: 0.3,  gain: 0.14 },
  };

  function playTone(ctx, kind) {
    var p = DROP_PARAMS[kind] || DROP_PARAMS.chime;
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type = p.type;
    o.frequency.value = p.f0;
    if (p.f1 !== p.f0) o.frequency.exponentialRampToValueAtTime(p.f1, ctx.currentTime + p.t1);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(p.gain, ctx.currentTime + p.t0);
    g.gain.exponentialRampToValueAtTime(0.00001, ctx.currentTime + p.t1);
    o.start(); o.stop(ctx.currentTime + p.t1);
  }

  function playBuffer(ctx, buffer) {
    var s = ctx.createBufferSource();
    s.buffer = buffer; s.connect(ctx.destination); s.start();
  }

  var spimAudio = {
    state: STATES.IDLE,
    ctx: null,
    customBuffer: null,
    beam: null,
    listen: null,

    getContext: function () {
      if (!this.ctx) this.ctx = new (global.AudioContext || global.webkitAudioContext)();
      if (this.ctx.state === 'suspended') this.ctx.resume();
      if (this.state === STATES.IDLE) this.state = STATES.READY;
      return this.ctx;
    },

    playDrop: function (opts) {
      try {
        var ctx = this.getContext();
        var kind = (opts && opts.kind) || 'chime';
        var buffer = (opts && opts.buffer) || this.customBuffer;
        if (buffer) playBuffer(ctx, buffer); else playTone(ctx, kind);
        emitter.emit('drop', { kind: kind });
      } catch (e) {}
    },

    setCustomDropBuffer: function (buf) { this.customBuffer = buf; },

    playBeam: function (samples, cb) {
      this.stopBeam(true);
      var ctx = this.getContext();
      var buffer = ctx.createBuffer(1, samples.length, 48000);
      buffer.copyToChannel(samples, 0);
      var src = ctx.createBufferSource();
      src.buffer = buffer; src.connect(ctx.destination);
      var secs = samples.length / 48000;
      this.state = STATES.PLAYING;
      emitter.emit('beam-start', { secs: secs });

      var raf = null;
      var finished = false;
      var self = this;
      function finish() {
        if (finished) return;
        finished = true;
        if (raf) cancelAnimationFrame(raf);
        try { src.stop(); } catch (e) {}
        if (self.beam && self.beam.src === src) self.beam = null;
        self.state = self.listen ? STATES.LISTENING : STATES.READY;
        emitter.emit('beam-stop', {});
      }

      if (cb && typeof cb.onProgress === 'function') {
        var startedAt = ctx.currentTime;
        var tick = function () {
          if (finished) return;
          var elapsed = ctx.currentTime - startedAt;
          cb.onProgress(Math.min(1, Math.max(0, elapsed / Math.max(0.001, secs))));
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      }

      src.onended = finish;
      var timer = setTimeout(finish, (secs + 0.3) * 1000);
      this.beam = { src: src, timer: timer, finish: finish };
      src.start();
      return { stop: finish };
    },

    stopBeam: function (silent) {
      if (this.beam) {
        clearTimeout(this.beam.timer);
        try { this.beam.src.stop(); } catch (e) {}
        this.beam = null;
      }
      if (!silent) {
        this.state = this.listen ? STATES.LISTENING : STATES.READY;
        emitter.emit('beam-stop', {});
      }
    },

    playFloat32: function (samples, onEnd) {
      var ctx = this.getContext();
      var buffer = ctx.createBuffer(1, samples.length, 48000);
      buffer.copyToChannel(samples, 0);
      var src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      var done = false;
      function finish() {
        if (done) return;
        done = true;
        try { src.stop(); } catch (e) {}
        if (typeof onEnd === 'function') onEnd();
      }
      src.onended = finish;
      src.start();
      return { stop: finish };
    },

    startListening: function (handlers) {
      var self = this;
      if (self.listen) return Promise.resolve(self.listen.ctx);
      return navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 }
      }).then(function (stream) {
        var micCtx = new (global.AudioContext || global.webkitAudioContext)({ sampleRate: 48000 });
        if (micCtx.state === 'suspended') micCtx.resume();
        var srcNode = micCtx.createMediaStreamSource(stream);
        var receiver = global.SpimCodec.createReceiver();
        var node = micCtx.createScriptProcessor(2048, 1, 1);
        var zero = micCtx.createGain(); zero.gain.value = 0;
        node.onaudioprocess = function (e) {
          if (!self.listen) return;
          var ch = e.inputBuffer.getChannelData(0);
          var sum = 0;
          for (var i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
          var rms = Math.sqrt(sum / ch.length);
          if (handlers && handlers.onLevel) handlers.onLevel(rms);
          var payload = receiver.push(new Float32Array(ch));
          if (payload && handlers && handlers.onCaught) handlers.onCaught(payload);
        };
        srcNode.connect(node);
        node.connect(zero);
        zero.connect(micCtx.destination);
        self.listen = { ctx: micCtx, stream: stream, node: node, srcNode: srcNode, handlers: handlers };
        self.state = STATES.LISTENING;
        emitter.emit('listening-start', {});
        if (handlers && handlers.onState) handlers.onState(STATES.LISTENING, 'Listening');
        return micCtx;
      });
    },

    stopListening: function () {
      var listen = this.listen;
      if (!listen) return;
      this.listen = null;
      try { if (listen.node) listen.node.disconnect(); } catch (e) {}
      try { if (listen.srcNode) listen.srcNode.disconnect(); } catch (e) {}
      try { if (listen.stream) listen.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
      try { if (listen.ctx) listen.ctx.close(); } catch (e) {}
      this.state = this.beam ? STATES.PLAYING : STATES.READY;
      emitter.emit('listening-stop', {});
      if (listen.handlers && listen.handlers.onState) listen.handlers.onState(STATES.IDLE, 'Idle');
    },

    on: function (ev, fn) { emitter.on(ev, fn); return this; }
  };

  global.SpimAudio = spimAudio;
})(window);
