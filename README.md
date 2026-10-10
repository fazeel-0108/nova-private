# ✦ Nova — Your Personal AI Assistant

One app that installs on your **laptop**, **Android**, and **iPhone** — with the **top AI models**, **hands-free voice control**, **study help**, and **device commands** (WhatsApp, Gmail, open apps). Works **offline and online**.

---

## 🚀 Quick start (2 minutes)

1. **Start the app locally**
   ```
   python serve.py
   ```
2. Open **http://localhost:8080** on your laptop.
3. Click **⚙️ Settings** → paste an **API key** (below) → **Save**.
4. To install on your **phone**: open the LAN URL the server prints (e.g. `http://192.168.1.5:8080`) in Chrome/Safari → menu → **"Add to Home screen" / "Install app"**.

> For installing on many devices and using the microphone anywhere, publish it online (free, below) — HTTPS is required for voice + install prompts.

---

## 🔑 AI brains: works with NO key, or with top models

**⚡ No API key? Nova still works!** Out of the box it uses the **🆓 Free AI** provider (GPT-OSS 20B via Pollinations — no key, no signup) for **any** question, plus **Nova Lite** — a built-in offline brain — and ALL device commands (notes, math, WhatsApp, email, open apps) work offline. Free AI runs through the bundled proxy (`serve.py` locally, the `relay/` Worker when published).

**Want the top models (free or paid)?** Get a key — takes 1 minute:

| Provider | Get key | Cost | Models you get |
|---|---|---|---|
| **🆓 Free AI** ⭐ default | **none needed** | **FREE** | GPT-OSS 20B (reasoning) — via the bundled proxy |
| **Google Gemini** | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | **FREE** | Gemini 1.5 Flash / Pro |
| **OpenRouter** | [openrouter.ai/keys](https://openrouter.ai/keys) | Free tier available | GPT-4o, Claude, Gemini, Llama, DeepSeek — the app auto-lists 🆓 FREE models |
| **OpenAI** | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | Paid | GPT-4o, GPT-4o mini |

**Setup:** ⚙️ Settings → pick provider → paste key → Save. (Nova Lite stays available anytime by picking it in the provider list.)

Your key is stored **only on your device** (localStorage). It never leaves your device except to call the AI provider directly.

---

## 💬 What you can say

**Chat & study**
| Say | What happens |
|---|---|
| *(anything)* | Chat with your chosen brain (Nova Lite free, or GPT-4o / Claude / Gemini with a key) |
| `quiz me on photosynthesis` | 5-question quiz, tap to reveal answers |
| `flashcards on World War 2` | Saves 8 flashcards on your device |
| `review flashcards World War 2` | Offline flashcard drill |
| `explain neural networks simply` | Study-mode explanation |

**Your stuff (works offline)**
| Say | What happens |
|---|---|
| `note buy milk tomorrow` | Saves a note |
| `notes` / `find in notes milk` | Shows / searches notes |
| `calculate 15% of 2400` · `12*(3+4)` | Instant math, offline |

**Device actions**
| Say | What happens |
|---|---|
| `whatsapp 919876543210 hey, party at 6?` | Opens WhatsApp chat with your message pre-filled |
| `email mom@gmail.com Dinner tonight? saying I'll be home by 8` | Opens a ready Gmail draft |
| `open youtube` · `open spotify` · `open maps` · `open instagram` | Opens the app/site |

**Modes** (sidebar): 💬 Chat · 📚 Study · 📝 Exam prep · 🎓 Homework — each changes how Nova answers.

---

## 🎙️ Hands-free

1. Tap the **🎧** button (top bar) → allow microphone.
2. Say **"Nova, open youtube"** or **"Nova, what is photosynthesis"**.
3. Nova answers **out loud** when 🔊 (speak) is on.

- Change the wake name in Settings ("Call me…" → e.g. *Jarvis*) — then say "Jarvis, …".
- **🎤** next to the input box = one-shot dictation into the text field.
- Voice works best in Chrome/Edge and Android Chrome. (iPhone's Safari allows mic only on a published HTTPS site.)

## 📡 Offline & online

- The app **installs and opens offline** (service worker).
- Offline, these keep working: notes, flashcard review, math, opening apps, settings.
- Normal chat messages typed offline are **queued** and auto-sent when you're back online (banner shows the count).

---

## 🌍 Publish it (free, ~5 minutes) so any device can install it

Pick ONE:

**A) Cloudflare project hosting the app + its relay (what this repo uses)**
1. `bash relay/build-site.sh` assembles the static bundle into `.site/`.
2. Deploy it together with the Worker using `relay/deploy-app.json` (Freebuff Sites).
   The app and `/api/*` then share one origin, so every call is same-origin.
3. Open the URL on your phone → **Add to Home screen**. Done — it's an app now.

**A2) GitHub Pages as the frontend** — the same bundle can be served there instead;
`.github/workflows/pages.yml` is committed but **manual-trigger only**, because Pages on a
*private* repo needs a paid GitHub plan. Make the repo public (or upgrade to Pro), re-enable the
`push:` trigger, and the app picks the relay up automatically via `apiBase()`.

**B) Local laptop server** — `python serve.py` → open `http://localhost:8080`. Everything is
same-origin here (agent commands, sync, free AI proxy), so this is the mode for device control.
**C) Vercel** — `npm i -g vercel` → `vercel`. The `api/chat.js` function is a standalone relay.

> **Keys are server-side only.** The relay holds `GROQ_KEY`, `TOKENHARBOR_KEY_1/2`,
> `OPENROUTER_KEY`, `CLEANAPIS_KEY` as Worker secrets — never in this repo, never in the browser.

### Voice lifecycle tests (`tests/`)

The voice state machine, microphone ownership and duplicate-event handling are
tested against the real `app.js` with deterministic platform fakes
(SpeechRecognition, TTS, getUserMedia) — no live mic or network needed:

```bash
python -m http.server 8097          # from the repo root
# then open http://127.0.0.1:8097/tests/voice-lifecycle.html
```

The page prints `N/total passed` and sets `window.__voiceTestSummary`. Adding
`?app=../site-dist/old-app.js` runs the same suite against a previous build, to
confirm the tests really catch the regressions they claim to cover.

### Relay (`relay/`)

```bash
cd relay && npx wrangler dev --local --port 8788   # run it locally
bash relay/verify.sh http://127.0.0.1:8788 <passcode>   # 24 checks: chat, streaming, gate, sync, CORS
bash relay/verify.sh https://<your-relay-host> <passcode>  # same checks against a deployment
```

Routes: `POST /api/chat` (keys + retry/backoff on 402/429/5xx), `GET /api/health`,
`GET|POST /api/sync` (D1), `GET|POST /api/gate` (D1 device registry).
Secrets: the five provider keys above, plus `NOVA_PASS` / optional `NOVA_HINT` for the passcode gate.

> **Known limits of the hosted mode.** `/api/act`, `/api/ping` and `/api/ollama/*` live on the
> laptop agent only, so device control works when you open Nova from `serve.py` (same origin),
> not from the hosted page. Browsers also block plain-`http` LAN calls made from an `https` page.
> Sync uses whichever backend the page was loaded from — pair devices on the same one.

All of these give you free HTTPS, which unlocks: install prompts on Android/desktop, microphone on iPhone, and background offline caching.

### Install like a native app
- **Android (Chrome):** open your URL → ⋮ menu → **Install app**.
- **iPhone (Safari):** Share → **Add to Home Screen**.
- **Windows/Mac (Chrome/Edge):** address-bar install icon → **Install**. Nova opens in its own window like a desktop app.

---

## 📁 Files

```
index.html            App shell (UI)
styles.css            Theme (dark glass + light mode — double-click "Nova" to toggle)
app.js                All logic: AI, commands, voice, offline queue
sw.js                 Service worker (offline shell, network-first updates)
manifest.webmanifest  Install metadata (name, icons, shortcuts)
serve.py              Local server + free-AI proxy (shows LAN URL for phone testing)
api/chat.js           Vercel function — free-AI proxy when published on Vercel
relay/                Cloudflare Worker relay + local config + verify.sh (server-side routes)
.github/workflows/    GitHub Actions (Pages deploy, Android APK build)
make_icons.py         Regenerates the app icons (python make_icons.py)
icons/                App icons + SVG source
```

## 🔒 Privacy
Everything (chats, notes, flashcards, API key, settings) lives in your browser storage on each device. Nothing is sent to any server except your chosen AI provider. **Erase all data** in Settings wipes a device clean.

## 🛠 Troubleshooting
- **Free AI says 402/429 or "rate limited"** → the shared free pool is busy. The relay now retries twice before reporting it; if it still fails, wait a minute or pick a keyed brain (Groq / Token Harbor / OpenRouter / CleanAPIS) whose key lives on the relay.
- **Hosted page: every brain says "relay failed"** → the relay is unreachable or the origin isn't allowed (`APP_ORIGINS`). Check `https://<relay-host>/api/health`.
- **Device commands (laptop status, open app, cleanup) do nothing on the hosted page** → expected: the agent routes only exist on the laptop. Open Nova from `python serve.py` (or the APK on the same Wi-Fi) for those.
- **Mic doesn't work** → must be HTTPS (published) or localhost; check browser mic permission; use Chrome/Edge.
- **App didn't update after I changed files** → hard-refresh once (Ctrl+Shift+R); the service worker refreshes itself after that.
- **WhatsApp/Gmail didn't open** → allow pop-ups for the site (browsers block the first one sometimes).
