/* Nova voice lifecycle tests — runs the REAL app.js against the fakes in
   voice-stubs.js. Every assertion reflects a user-visible invariant, and the
   suite reports PASS/FAIL honestly; nothing is stubbed inside the app itself. */
/* global FakeSR, voiceTest */
(function () {
  "use strict";
  const results = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function check(name, cond, detail) {
    results.push({ name, pass: !!cond, detail: detail === undefined ? "" : String(detail) });
  }
  function eq(name, actual, expected) {
    check(name, actual === expected, `expected ${expected}, got ${actual}`);
  }

  function render() {
    const failed = results.filter((r) => !r.pass);
    const html = `<h1>Nova voice lifecycle tests</h1>
      <p class="${failed.length ? "bad" : "good"}">${results.length - failed.length}/${results.length} passed${failed.length ? ` — ${failed.length} FAILED` : ""}</p>
      <ol>${results.map((r) => `<li class="${r.pass ? "ok" : "no"}">${r.pass ? "PASS" : "FAIL"} — ${r.name}${r.pass ? "" : ` <em>(${r.detail})</em>`}</li>`).join("")}</ol>`;
    let box = document.getElementById("voice-test-results");
    if (!box) {
      box = document.createElement("div");
      box.id = "voice-test-results";
      box.style.cssText = "position:fixed;inset:0;z-index:99999;background:#0b0f1a;color:#e8eefc;padding:24px;overflow:auto;font:14px/1.5 monospace";
      document.body.appendChild(box);
    }
    box.innerHTML = html;
    box.style.display = "";
    window.__voiceTestSummary = {
      total: results.length,
      passed: results.length - failed.length,
      failed: failed.map((f) => `${f.name} (${f.detail})`),
    };
    console.log("VOICE TEST SUMMARY", window.__voiceTestSummary);
  }

  async function run() {
    /* ---------- A. startup: no voice UI, no recognition, no greeting ---------- */
    check("app loaded (state exists)", typeof state === "object" && !!state, "state missing");
    check("voice FSM is IDLE at startup", VoiceFSM.phase === "IDLE", VoiceFSM.phase);
    check("Jarvis overlay hidden at startup", document.getElementById("jarvis").classList.contains("hidden"));
    check("no recognizer started at startup", FakeSR.instances.length === 0, `${FakeSR.instances.length} instances`);
    check("nothing spoken at startup", voiceTest.utterances.length === 0, `${voiceTest.utterances.length} utterances`);
    check("handleSend is patchable (real global binding)", typeof window.handleSend === "function");

    /* ---------- B. manual mic with hands-free OFF ---------- */
    state.handsFree = false;
    state.nickname = "Nova";
    FakeSR.reset();
    await openJarvis();
    await sleep(60);
    check("manual mic opens exactly one recognizer", FakeSR.instances.length === 1, `${FakeSR.instances.length}`);
    const manual = FakeSR.instances.at(-1);
    check("manual recognizer is running", manual && manual.started === true);
    check("manual session phase is LISTENING", VoiceFSM.phase === "LISTENING", VoiceFSM.phase);
    check("overlay is visible", !document.getElementById("jarvis").classList.contains("hidden"));

    /* live transcript: interim results show up without creating a message */
    const beforeMsgs = JSON.stringify(state.chats[state.currentId] ? state.chats[state.currentId].messages.length : 0);
    manual.say("what is the time", false);
    await sleep(30);
    const heard = document.getElementById("jarvis-heard").textContent;
    check("interim transcript is shown live", /what is the time/.test(heard), heard);
    check("interim result created no chat message",
      JSON.stringify(state.chats[state.currentId] ? state.chats[state.currentId].messages.length : 0) === beforeMsgs);

    manual.end();
    await sleep(600);            // the app re-arms 350ms after a silent end
    check("silence re-arms listening", FakeSR.instances.length >= 2, `${FakeSR.instances.length} recognizers`);

    /* ---------- C. THE REPORTED BUG: manual mic while hands-free is ON ---------- */
    closeJarvis();
    await sleep(60);
    resetChatState();
    state.handsFree = true;
    FakeSR.reset();
    toggleHandsFree();
    await sleep(60);
    check("hands-free starts one recognizer", FakeSR.instances.length === 1, `${FakeSR.instances.length}`);
    const hf = FakeSR.instances.at(-1);
    check("hands-free reports listening", state.listening === true);
    check("hands-free phase is LISTENING", VoiceFSM.phase === "LISTENING", VoiceFSM.phase);

    await openJarvis();                       // <- the manual mic click
    await sleep(80);
    check("hands-free recognizer yields the mic", !!(hf.aborted || hf.stopped), "old recognizer still running");
    eq("manual session starts exactly one new recognizer", FakeSR.instances.length, 2);
    check("new recognizer is running", FakeSR.instances.at(-1).started === true);
    check("no recognizer was double-started", FakeSR.doubleStarts === 0, `${FakeSR.doubleStarts} double starts`);
    check("manual session is LISTENING with hands-free on", VoiceFSM.phase === "LISTENING", VoiceFSM.phase);
    check("hands-free is suspended (not silently dead)", state.listening === false);

    /* a spoken command in the manual session commits exactly one user message */
    const manual2 = FakeSR.instances.at(-1);
    const sent = [];
    const realHandleSend = window.handleSend;
    window.handleSend = (text, opts) => { sent.push({ text, opts }); return Promise.resolve(); };
    manual2.say("open youtube", true);
    await sleep(20);
    manual2.end();
    await sleep(80);
    eq("one final result → one send", sent.length, 1);
    check("final transcript is kept visible", /open youtube/.test(document.getElementById("jarvis-heard").textContent),
      document.getElementById("jarvis-heard").textContent);
    manual2.say("open youtube", true);        // re-delivered final result
    manual2.end();
    await sleep(60);
    eq("re-delivered final result → no duplicate send", sent.length, 1);
    window.handleSend = realHandleSend;

    /* ---------- D. hands-free is handed back when the manual session closes ---------- */
    closeJarvis();
    await sleep(80);
    check("hands-free resumes after manual session", state.listening === true);
    check("resume phase is LISTENING", VoiceFSM.phase === "LISTENING", VoiceFSM.phase);

    /* ---------- E. one wake event = one activation (with and without a command) ---------- */
    const hf2 = FakeSR.instances.at(-1);
    check("wake recognizer is live", hf2 && hf2.started === true);
    const wakeSends = [];
    const realSend2 = window.handleSend;
    window.handleSend = (text) => { wakeSends.push(text); return Promise.resolve(); };

    hf2.say("Nova, what is the weather", true);
    await sleep(40);
    eq("wake + command → exactly one action", wakeSends.length, 1);
    check("wake text is shown as the live transcript", /weather/.test(document.getElementById("jarvis-heard").textContent));
    hf2.say("Nova, what is the weather", true);   // duplicate delivery of the same final result
    await sleep(40);
    eq("duplicate wake result → still one action", wakeSends.length, 1);
    window.handleSend = realSend2;

    /* The wake loop re-arms from the real TTS cooldown (450ms), not instantly. */
    await sleep(VoiceFSM.cooldownMs + 300);

    /* ---------- F. wake-only greeting happens once, then TTS owns the mic ---------- */
    voiceTest.reset();
    const inst = FakeSR.instances.at(-1);
    check("hands-free re-armed after the command", !!inst && inst.started === true, "no live recognizer");
    if (!inst || !inst.started) { render(); return window.__voiceTestSummary; }
    inst.say("Nova", true);
    await sleep(40);
    eq("bare wake → exactly one greeting", voiceTest.utterances.length, 1);
    check("greeting captures the whole utterance", /^Yes\b/.test(voiceTest.utterances[0].text), voiceTest.utterances[0].text);
    check("recognizer is stopped while Nova speaks", VoiceFSM.ttsActive === true && recogActive === false);

    const duringTTS = FakeSR.instances.length;
    await sleep(300);
    eq("no recognizer starts during TTS playback", FakeSR.instances.length, duringTTS);

    /* ---------- G. real TTS end → cooldown → exactly one clean re-arm ---------- */
    const beforeEnd = FakeSR.instances.length;
    voiceTest.finishSpeaking();
    await sleep(60);
    eq("no re-arm before the cooldown elapses", FakeSR.instances.length, beforeEnd);
    await sleep(VoiceFSM.cooldownMs + 250);
    eq("real TTS end re-arms exactly one recognizer", FakeSR.instances.length, beforeEnd + 1);
    check("re-arm lands in LISTENING", VoiceFSM.phase === "LISTENING", VoiceFSM.phase);
    check("TTS flag cleared after playback", VoiceFSM.ttsActive === false);

    /* ---------- H. Nova's own voice cannot trigger a new activation ---------- */
    const live = FakeSR.instances.at(-1);
    const selfSends = [];
    const realSend3 = window.handleSend;
    window.handleSend = (t) => { selfSends.push(t); return Promise.resolve(); };
    // Simulate the recognizer echoing Nova's own reply while TTS is active.
    VoiceFSM.ttsActive = true;
    live.say("Nova, delete everything", true);
    await sleep(40);
    eq("echo while speaking → no action", selfSends.length, 0);
    VoiceFSM.ttsActive = false;
    window.handleSend = realSend3;

    /* ---------- I. teardown leaves no live recognizer ---------- */
    stopListening();
    await sleep(40);
    eq("stopListening leaves no live recognizer", FakeSR.instances.filter((r) => r.started).length, 0);
    check("no wake UI left behind", document.getElementById("listen-banner").classList.contains("hidden"));

    render();
    return window.__voiceTestSummary;
  }

  function resetChatState() {
    try { state.currentId = null; if (typeof newChatObj === "function") newChatObj(); } catch { /* ignore */ }
  }

  window.__runVoiceLifecycleTests = async () => {
    try {
      return await run();
    } catch (err) {
      check("suite ran to completion", false, (err && err.message) || String(err));
      render();
      return window.__voiceTestSummary;
    }
  };
})();
