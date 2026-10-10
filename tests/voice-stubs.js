/* Deterministic fakes for the voice lifecycle tests.
   Loaded BEFORE app.js so the real code boots against a controllable
   recognizer/TTS/microphone instead of the browser's. Nothing here changes
   app behaviour — it only replaces the platform layer. */
(function () {
  "use strict";

  /* ---- SpeechRecognition fake: every instance is recorded ---- */
  class FakeSR {
    constructor() {
      this.lang = "en-US";
      this.continuous = false;
      this.interimResults = false;
      this.onresult = null;
      this.onend = null;
      this.onerror = null;
      this.onspeechstart = null;
      this.started = false;
      this.aborted = false;
      this.stopped = false;
      FakeSR.instances.push(this);
    }
    start() {
      if (this.started) { FakeSR.doubleStarts++; throw new Error("recognizer already started"); }
      this.started = true;
      FakeSR.starts++;
    }
    stop() { this.stopped = true; this.started = false; }
    abort() { this.aborted = true; this.started = false; }

    /* Test helpers — deliver results exactly like Chrome does. */
    say(text, isFinal = true) {
      if (!this.onresult) return false;
      const res = { isFinal: !!isFinal, 0: { transcript: text }, length: 1 };
      /* The real SpeechRecognitionResultList is array-like AND iterable
         (app.js uses both index access and for…of). Mirror both. */
      const list = { length: 1, 0: res };
      list[Symbol.iterator] = function* () { yield res; };
      const evt = { resultIndex: 0, results: list };
      this.onresult(evt);
      return true;
    }
    end() { if (this.onend) this.onend(); }
    fail(code) { if (this.onerror) this.onerror({ error: code }); }
  }
  FakeSR.instances = [];
  FakeSR.starts = 0;
  FakeSR.doubleStarts = 0;
  FakeSR.reset = function () { this.instances = []; this.starts = 0; this.doubleStarts = 0; };

  /* ---- TTS fake: utterances are captured so onend can be fired by hand ---- */
  const spoken = [];
  class FakeUtterance {
    constructor(text) {
      this.text = String(text);
      this.onend = null;
      this.onerror = null;
      this.onstart = null;
      this.voice = null;
      this.lang = "en-US";
      this.rate = 1; this.pitch = 1; this.volume = 1;
    }
  }
  const synth = {
    speaking: false,
    pending: false,
    paused: false,
    speak(u) { spoken.push(u); synth.speaking = true; if (u.onstart) u.onstart(); },
    cancel() { synth.speaking = false; },
    pause() {}, resume() {},
    getVoices() { return []; },
    addEventListener() {}, removeEventListener() {},
  };

  /* ---- AudioContext fake: only what the mic analyser needs ---- */
  class FakeAudioContext {
    constructor() { this.state = "running"; }
    resume() { this.state = "running"; return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {} }; }
    createAnalyser() {
      return {
        fftSize: 256, smoothingTimeConstant: 0.7, frequencyBinCount: 128,
        getByteFrequencyData(arr) { if (arr && arr.fill) arr.fill(0); },
        connect() {},
      };
    }
    close() { return Promise.resolve(); }
  }

  /* ---- Microphone fake: a stable, "live" stream ---- */
  const track = { enabled: true, onended: null, stop() {}, kind: "audio" };
  const stream = {
    active: true,
    getAudioTracks: () => [track],
    getTracks: () => [track],
  };

  window.FakeSR = FakeSR;
  window.voiceTest = {
    spoken,
    utterances: spoken,
    stream,
    track,
    lastUtterance: () => spoken[spoken.length - 1] || null,
    /* Fire the REAL TTS completion the app waits for. */
    finishSpeaking() {
      const u = spoken[spoken.length - 1];
      synth.speaking = false;
      if (u && u.onend) u.onend();
      return !!u;
    },
    reset() { spoken.length = 0; synth.speaking = false; },
  };

  window.SpeechRecognition = FakeSR;
  window.webkitSpeechRecognition = FakeSR;
  window.SpeechSynthesisUtterance = FakeUtterance;

  /* speechSynthesis is a getter-only property in some browsers → define it. */
  Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true, writable: true });

  Object.defineProperty(window, "AudioContext", { value: FakeAudioContext, configurable: true, writable: true });
  Object.defineProperty(window, "webkitAudioContext", { value: FakeAudioContext, configurable: true, writable: true });

  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: () => Promise.resolve(stream) },
    configurable: true,
  });

  /* Network: the app pings its relay on boot. Never touch the real network. */
  window.__realFetch = window.fetch.bind(window);
  window.fetch = (url, opts) =>
    Promise.resolve(new Response(JSON.stringify({ ok: false, providers: [] }), {
      status: 404, headers: { "Content-Type": "application/json" },
    }));
})();
