# INTEGRATION GUIDE — Nova → JARVIS upgrade

Everything below is already merged into your working app and verified live.
This guide explains what changed, where, and how to switch on the optional
pieces (FastAPI backend, Gmail, OpenRouter models).

---

## 0. What changed in your working files (all live now)

| File | Change |
|---|---|
| `bgfx.js` | Photoreal black hole: photon ring + bloom, lensed halo, Doppler beaming, turbulent silk. **New motion-state engine**: `NovaFX.state("idle"/"listening"/"processing"/"speaking")` + `NovaFX.level(0..1)` drive ripples, amber energy pulses and spin acceleration. |
| `index.html` | Arc Reactor SVG core in the topbar (4 animated states), telemetry readout (`tel-lat`, `tel-fps`, `tel-state`), scanline overlay. ⌂ beside ☰. Quick actions hidden. |
| `styles.css` | Stark palette `#030914` / `#00f0ff` / amber `#ff9900` / red `#ff3300`, glassmorphic panels, scanlines, reactor keyframes, telemetry HUD, mobile fallbacks. |
| `app.js` | `setHudState()` reactor state machine (wraps speak/setBusy/startWave); real FPS + API-latency telemetry; mic-level feed to the vortex; `NOVA_TOOLS` + `runWithTools()` OpenAI function-calling loop (`control_laptop`, `draft_email`, `whatsapp_message`, `save_memory`); JARVIS persona system prompt; `laptop …` command family; SSE instant sync (`openSyncStream()`). |
| `serve.py` | `/api/act` laptop actuator (open/volume/lock/screenshot/battery/notify/clipboard), `/api/ollama/chat` + `/api/ollama/models` (phone uses the laptop's local brain), `/api/sync/events` **SSE instant push**. |
| `sw.js` | Cache bumped → clients auto-update. |

Nothing to merge — refresh `http://localhost:8080` (twice on installed PWAs).

---

## 1. Hands-free voice loop (already in, no setup)

- Tap 🎤 → full duplex conversation loop (already existed, now reactor-driven).
- Say **"Nova, …"** (your wake name) with the 🎙️ hands-free banner — now with
  auto-rearm + reactor LISTENING state + mic-level vortex pulse.
- True offline wake-word (Porcupine/OpenWakeWord) needs a native app shell —
  the web `SpeechRecognition` above is the practical equivalent you have today.

Optional quality upgrade: set Chrome to use `chrome://flags` →
"Experimental Web Platform features" for the best continuous recognition.

---

## 2. Local brain (Ollama) — 3 minutes

    1. Install from https://ollama.com  (Next → Next → done)
    2. In a terminal:  ollama pull llama3.2
    3. Open Nova → model picker → "🦙 Ollama — this laptop, private" appears.

Your phone can use it too: it streams through your laptop's server
(`/api/ollama/chat`), so the phone talks to the laptop's GPU/CPU brain.

---

## 3. Cloud models from the spec (GLM / Solar Mini via OpenRouter)

    1. Get a free key: https://openrouter.ai/keys
    2. Paste it in Nova ⚙️ Settings (it's stored under provider openrouter)
       — or set  OPENROUTER_API_KEY  for the FastAPI backend.
    3. The picker's "OpenRouter" group offers:
         z-ai/glm-5.3-flash · upstage/solar-mini4   (add ids in `MODELS.openrouter` in app.js if you want them pre-listed)

Tool-calling works with any tools-capable model there (GLM supports it).

---

## 4. The FastAPI backend (optional)

Only if you want the WebSocket layer of the spec:

    pip install "fastapi" "uvicorn[standard]" websockets httpx
    uvicorn backend.server:app --host 0.0.0.0 --port 8080

Same UI, same port — plus `/ws/{code}` rooms. Stop `serve.py` first
(both bind 8080). The frontend keeps working unchanged; the WS room is
available for multi-device mirroring as you grow into it.

---

## 5. Real Gmail (unread / draft / send)

The app already opens Gmail drafts by voice ("email mom@gmail.com … saying …").
For **real API access** (reading unread mail, server-side sending):

    1. console.cloud.google.com → New Project → enable "Gmail API"
    2. OAuth consent → External → add yourself as Test user
    3. Credentials → OAuth client ID → Desktop app → download JSON
       → save next to backend/tools/gmail.py as  credentials.json
    4. pip install google-auth google-auth-oauthlib google-api-python-client
    5. Test:  python -c "import sys; sys.path.insert(0,'.');
       from backend.tools.gmail import unread; print(unread(3))"

Then expose it with one route in `backend/server.py`:

    from backend.tools import gmail
    from fastapi import Body

    @app.post("/api/gmail/unread")
    async def gmail_unread(body: dict = Body(default={})):
        return gmail.unread(int(body.get("max", 5)))

    @app.post("/api/gmail/draft")
    async def gmail_draft(body: dict = Body(...)):
        return gmail.draft(body["to"], body["subject"], body.get("body",""))

(Add the same two as NOVA_TOOLS entries in app.js — copy the
`draft_email` pattern — and Nova can read mail by voice.)

Never commit `credentials.json` / `token.json`.

---

## 6. Twilio calling (optional, paid)

Your `call <number>` already opens the native dialer — that's the right
behavior for a phone. Twilio adds server-placed calls:

    pip install twilio
    export TWILIO_SID=ACxxxx  TWILIO_TOKEN=xxxx  TWILIO_FROM=+1xxxx

Add to `backend/tools/system.py`:

    from twilio.rest import Client
    def act_twilio_call(number: str) -> str:
        c = Client(os.environ["TWILIO_SID"], os.environ["TWILIO_TOKEN"])
        c.calls.create(to=number, from_=os.environ["TWILIO_FROM"],
                       url="http://demo.twilio.com/docs/voice.xml")
        return f"placing call to {number}"

Register it in `ACTIONS` and add "call" to the enum in `OPENAI_SCHEMA`.

---

## 7. Piper / ElevenLabs TTS (optional upgrades)

Today Nova speaks with the OS voice (instant, offline, zero setup). Upgrades:

- **Piper (offline, fast):** run their HTTP server, then in `app.js` swap
  `speechSynthesis.speak(u)` in `speak()` for a `fetch("/api/tts", …)` +
  `new Audio(blob).play()` — a 6-line change at one call site.
- **ElevenLabs (streaming, paid):** same swap, endpoint
  `https://api.elevenlabs.io/v1/text-to-speech/{voice}/stream`.

Keep `speechSynthesis` as the fallback path so voices always work offline.

---

## 8. Where things live (map)

    app.js            ← HUD state machine, tools loop, commands, SSE client
    bgfx.js           ← black hole + NovaFX.state()/level()
    styles.css        ← Stark HUD theme (search "STARK HUD")
    index.html        ← reactor SVG, telemetry, scanlines
    serve.py          ← stdlib server: /api/act, /api/ollama/*, /api/sync*
    backend/          ← optional FastAPI + tools modules (this folder)
    backend/tools/    ← system.py (actuator), gmail.py (OAuth2)

## 9. Verify in 60 seconds

    1. Refresh the app → reactor pulses cyan, telemetry shows fps.
    2. Send a message → reactor spins AMBER (processing) → back to cyan.
    3. Say "laptop battery" → chat shows the real level.
    4. Say "laptop notify test" → Windows toast appears.
    5. Open the model picker → Groq/Token Harbor groups glow green/amber;
       Ollama group appears once installed.
    6. Phone (same Wi-Fi + sync code): send a chat on the laptop —
       it appears on the phone within a second (SSE push).
