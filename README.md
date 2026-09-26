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

**⚡ No API key? Nova still works!** Out of the box it uses the **🆓 Free AI** provider (GPT-OSS 20B via Pollinations — no key, no signup) for **any** question, plus **Nova Lite** — a built-in offline brain — and ALL device commands (notes, math, WhatsApp, email, open apps) work offline. Free AI runs through the bundled proxy (`serve.py` locally, `netlify/` or `api/` when published).

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

**A) Netlify (easiest, free AI works out of the box)**
1. Go to [app.netlify.com](https://app.netlify.com) → sign up free → **Add new site → Import an existing project** (or drag-and-drop the folder with the Netlify desktop/dashboard option)
2. Netlify auto-reads `netlify.toml` and wires up `/api/chat` (the free-AI proxy) automatically
3. Open your live URL on your phone → **Add to Home screen**. Done — it's an app now.

**B) Vercel** — `npm i -g vercel` → run `vercel` in this folder → deploy. The `api/chat.js` function makes the free AI work automatically.
**C) GitHub Pages** — push this folder to a repo → Settings → Pages → deploy from branch. *(Note: GitHub Pages can't run the `/api/chat` proxy, so use provider **Gemini free key** or **OpenRouter** in Settings there — or keep using Nova Lite.)*
**D) Cloudflare Pages** — [pages.cloudflare.com](https://pages.cloudflare.com) → upload the folder. *(Same note as GitHub Pages.)*

> With Netlify or Vercel, everything works with **zero keys**: the 🆓 Free AI provider streams real AI answers through your site's own `/api/chat` proxy.

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
netlify/              Netlify function + config — free-AI proxy on Netlify
make_icons.py         Regenerates the app icons (python make_icons.py)
icons/                App icons + SVG source
```

## 🔒 Privacy
Everything (chats, notes, flashcards, API key, settings) lives in your browser storage on each device. Nothing is sent to any server except your chosen AI provider. **Erase all data** in Settings wipes a device clean.

## 🛠 Troubleshooting
- **Free AI says 402/429 or "rate limited"** → the shared free pool is busy; try again in a minute, switch provider to **Nova Lite**, or add a free Gemini key. Heavy use deserves your own (free) Gemini key.
- **Published on GitHub Pages/Cloudflare and Free AI fails** → those hosts can't run the proxy; use Nova Lite or a free Gemini key there.
- **Mic doesn't work** → must be HTTPS (published) or localhost; check browser mic permission; use Chrome/Edge.
- **App didn't update after I changed files** → hard-refresh once (Ctrl+Shift+R); the service worker refreshes itself after that.
- **WhatsApp/Gmail didn't open** → allow pop-ups for the site (browsers block the first one sometimes).
