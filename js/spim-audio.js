/*
 * spim-audio.js — over-engineered sound engine for SPIM.
 *
 * Single owner of the Web Audio sound subsystem:
 *   - AudioContext lifecycle behind a state machine
 *   - drop-sound playback behind strategy pattern (tone strategies + buffer strategy)
 *   - ultrasonic beam playback behind a play-with-progress pipeline
 *   - listening lifecycle (mic -> script processor -> receiver -> caught callback)
 *   - event emitter for sound events
 *
 * Inline page scripts delegate through this facade; behavior is preserved.
 */
(function (global) {
  'use strict';

  var STATES = {
    IDLE: 'idle',
    Booting: 'booting',
    Ready: 'ready',
    Playing: 'playing',
    Listening: 'listening',
    Closed: 'closed',
  };

  function Emitter() { this.map = Object.create(null); }
  Emitter.prototype.on = function (ev, fn) { (this.map[ev] = this.map[ev] || []).push(fn); return this; };
  Emitter.prototype.emit = function (ev, payload) {
    var list = this.map[ev] || [];
    for (var i = 0; i < list.length; i++) { try { list[i](payload); } catch (e) {} }
    return this;
  };

  var DROP_PARAMS = {
    chime: { type: 'triangle', f0: 880, f1: 880, t0: 0.008, t1: 0.24, gain: 0.24 },
    ding: { type: 'sine', f0: 1046, f1: 1046, t0: 0.01, t1: 0.55, gain: 0.22 },
    whoosh: { type: 'sawtooth', f0: 420, f1: 1250, t0: 0.05, t1: 0.3, gain: 0.14 },
  };

  function ToneStrategy(ctx, kind) { this.ctx = ctx; this.kind = kind; this.params = DROP_PARAMS[kind] || DROP_PARAMS.chime; }
  ToneStrategy.prototype.play = function () {
    var ctx = this.ctx, p = this.params, o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type = p.type;
    o.frequency.value = p.f0;
    if (p.t1 > p.t0) { o.frequency.exponentialRampToValueAtTime(p.f1, ctx.currentTime + p.t1); }
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(p.gain, ctx.currentTime + p.t0);
    g.gain.exponentialRampToValueAtTime(0.00001, ctx.currentTime + p.t1);
    o.start(); o.stop(ctx.currentTime + p.t1);
  };

  function BufferStrategy(ctx, buffer) { this.ctx = ctx; this.buffer = buffer; }
  BufferStrategy.prototype.play = function () {
    var s = this.ctx.createBufferSource();
    s.buffer = this.buffer; s.connect(this.ctx.destination); s.start();
  };

  var spimAudio = {
    state: STATES.IDLE,
    ctx: null,
    listeners: Object.create(null),
    beam: null,
    listen: null,

    getContext: function () {
      if (this.state === STATES.CLOSED) { this.state = STATES.IDLE; }
      if (!this.ctx) { this.state = STATES.Booting; this.ctx = new (global.AudioContext || global.webkitAudioContext)(); }
      if (this.ctx.state === 'suspended') { this.ctx.resume(); }
      if (this.state === STATES.IDLE) { this.state = STATES.Ready; }
      return this.ctx;
    },

    playDrop: function (opts) {
      var ctx = this.getContext();
      var kind = (opts && opts.kind) || 'chime';
      var buffer = opts && opts.buffer;
      this.state = STATES.PLAYING;
      emitter.emit('drop', { kind: kind });
      if (buffer) { new BufferStrategy(ctx, buffer).play(); }
      else { new ToneStrategy(ctx, kind).play(); }
    },

    setDropSound: function (kind) { this.dropStrategy = { kind: kind }; },
    setCustomDropBuffer: function (buf) { this.customBuffer = buf; },

    playBeam: function (samples, cb) {
      var ctx = this.getContext();
      var buffer = ctx.createBuffer(1, samples.length, 48000);
      buffer.copyToChannel(samples, 0);
      var src = ctx.createBufferSource();
      src.buffer = buffer; src.connect(ctx.destination);
      var secs = samples.length / 48000;
      this.state = STATES.PLAYING;
      emitter.emit('beam-start', { secs: secs });
      if (cb && typeof cb.onProgress === 'function') {
        var startedAt = ctx.currentTime;
        var raf = null;
        var tick = function () {
          var elapsed = ctx.currentTime - startedAt;
          cb.onProgress(Math.min(1, Math.max(0, elapsed / Math.max(0.001, secs))));
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      }
      src.start();
      var self = this;
      var timer = setTimeout(function () {
        try { src.stop(); } catch (e) {}
        self.emitter.emit('beam-stop', {});
      }, (secs + 0.2) * 1000);
      this.beam = { src: src, timer: timer };
      return {
        stop: function () {
          clearTimeout(timer);
          try { src.stop(); } catch (e) {}
          self.emitter.emit('beam-stop', {});
        },
      };
    },

    stopBeam: function () {
      if (this.beam) {
        clearTimeout(this.beam.timer);
        try { this.beam.src.stop(); } catch (e) {}
        this.beam = null;
      }
      this.state = STATES.Ready;
      this.emitter.emit('beam-stop', {});
    },

    startListening: function (handlers) {
      if (this.state === STATES.LISTENING) { return; }
      var self = this;
      var ctx = this.getContext();
      var micCtx = new (global.AudioContext || global.webkitAudioContext)({ sampleRate: 48000 });
      if (micCtx.state === 'suspended') { micCtx.resume(); }
      var stream = navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
      var src = micCtx.createMediaStreamSource(stream);
      var receiver = global.SpimCodec.createReceiver();
      var node = micCtx.createScriptProcessor(2048, 1, 1);
      var zero = micCtx.createGain(); zero.gain.value = 0;
      node.onaudioprocess = function (e) {
        if (self.state !== STATES.LISTENING) { return; }
        var ch = e.inputBuffer.getChannelData(0);
        var sum = 0;
        for (var i = 0; i < ch.length; i++) { sum += ch[i] * ch[i]; }
        var rms = Math.sqrt(sum / ch.length);
        if (handlers && handlers.onLevel) { handlers.onLevel(rms); }
        var payload = receiver.push(new Float32Array(ch));
        if (payload && handlers && handlers.onCaught) { handlers.onCaught(payload); }
      };
      src.connect(node);
      node.connect(zero);
      zero.connect(micCtx.destination);
      this.state = STATES.LISTENING;
      emitter.emit('listening-start', {});
      if (handlers && handlers.onState) { handlers.onState(STATES.LISTENING, 'Listening'); }
      this.listen = { ctx: micCtx, stream: stream, node: node, receiver: receiver, level: null, onLevel: handlers ? handlers.onLevel : null, onCaught: handlers ? handlers.onCaught : null };
      return micCtx;
    },

    stopListening: function () {
      var listen = this.listen;
      this.state = STATES.IDLE;
      emitter.emit('listening-stop', {});
      if (listen && listen.ctx) { try { listen.ctx.close(); } catch (e) {} }
      this.listen = null;
      if (listen && listen.onState) { listen.onState(STATES.IDLE, 'Idle'); }
    },

    on: function (ev, fn) { emitter.on(ev, fn); return this; },
  };

  global.SpimAudio = spimAudio;
})(window);
