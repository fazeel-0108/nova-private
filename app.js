/* ============================================================
   Nova — personal AI assistant PWA
   Features: top AI models (OpenRouter/OpenAI/Gemini), modes
   (chat/study/exam/homework), notes, flashcards, quizzes,
   WhatsApp/Gmail/open-app commands, voice input, hands-free
   wake-word listening, spoken replies, offline queue.
   All data stays on this device (localStorage).
   ============================================================ */
"use strict";

/* ---------------- State & storage ---------------- */
const $ = (sel) => document.querySelector(sel);
const LS = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, val) { localStorage.setItem(key, JSON.stringify(val)); },
};

/* ---------------- Where the server routes live ----------------
   Nova is a static bundle; its server-side routes (AI keys, cross-device
   sync, the passcode gate) live on the Nova relay Worker. When this page is
   served by its own server — python serve.py on the laptop, or wrangler dev —
   those routes are same-origin. On a static host (GitHub Pages) they are
   fetched from the relay. The laptop agent (/api/act, /api/ping,
   /api/ollama/*) only ever exists on the laptop itself, so those calls always
   stay same-origin and fail honestly when the agent isn't running. */
const RELAY_ORIGIN = "https://site-b9ba42016ccb480083628abb2dfa4a74.freebuff.page";
function apiBase() {
  const override = LS.get("nova.relay", "");
  if (override) return String(override).replace(/\/+$/, "");
  if (location.protocol === "file:") return RELAY_ORIGIN;
  const host = location.hostname;
  // Served by its own server (serve.py, wrangler dev) → same origin.
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(host) || /\.local$/i.test(host)) return "";
  // Served as the relay project's own assets → same origin, and each
  // environment (preview/production) then talks to its own relay.
  if (/\.freebuff\.page$/i.test(host)) return "";
  // Any other static host (GitHub Pages) → the deployed relay.
  return RELAY_ORIGIN;
}
function apiUrl(path) { return apiBase() + path; }

const state = {
  provider: LS.get("nova.provider", "auto"),          // default brain: Nova Auto (server-routed)
  model: LS.get("nova.model", "auto"),
  apiKey: LS.get("nova.key", ""),
  nickname: LS.get("nova.nickname", "Nova"),
  autospeak: LS.get("nova.autospeak", false),
  studyStrict: LS.get("nova.studyStrict", true),
  handsFree: LS.get("nova.handsFree", false),   // always-on wake word
  mode: LS.get("nova.mode", "chat"),
  theme: LS.get("nova.theme", "system"),
  chats: LS.get("nova.chats", {}),   // { id: {id, title, mode, messages: [{role, content}], ts} }
  currentId: LS.get("nova.currentId", null),
  notes: LS.get("nova.notes", []),
  cards: LS.get("nova.cards", {}),   // { topic: [{q, a}] }
  tasks: LS.get("nova.tasks", []),   // cross-device drafts/actions
  activity: LS.get("nova.activity", []),   // agent action history (what/when/device/status)
  queued: LS.get("nova.queued", []),
  profile: LS.get("nova.profile", { name: "", facts: [], asked: false }), // things Nova knows about you
  syncCode: LS.get("nova.syncCode", ""),   // pairs laptop ↔ phone
  pendingFiles: [],  // attachments waiting to be sent with the next message
  listening: false,
  speaking: false,
  busy: false,
};

function saveAll() {
  LS.set("nova.chats", state.chats);
  LS.set("nova.currentId", state.currentId);
  LS.set("nova.notes", state.notes);
  LS.set("nova.cards", state.cards);
  LS.set("nova.queued", state.queued);
  LS.set("nova.profile", state.profile);
  LS.set("nova.syncCode", state.syncCode);
  LS.set("nova.tasks", state.tasks);
  LS.set("nova.activity", state.activity);
}

/* ---------------- Memory: things Nova knows about you ---------------- */
function addFact(fact) {
  fact = fact.trim();
  if (!fact) return;
  const low = fact.toLowerCase();
  const idx = state.profile.facts.findIndex((f) => f.toLowerCase() === low);
  if (idx >= 0) state.profile.facts[idx] = fact;      // update instead of duplicating
  else state.profile.facts.push(fact);
  if (state.profile.facts.length > 60) state.profile.facts.shift();
  LS.set("nova.profile", state.profile);
  scheduleSync();
}

function memoryBlock() {
  const p = state.profile;
  const facts = p.facts.slice(-20);
  if (!p.name && !facts.length) return "";
  return `\n\n--- WHAT YOU KNOW ABOUT THE USER (use naturally, never list it) ---\n`
    + (p.name ? `Name: ${p.name}\n` : "")
    + facts.map((f) => `- ${f}`).join("\n");
}

/* Commands: remember X / forget X / what do you know about me */
function tryMemoryCommand(text) {
  const t = norm(text);
  const say = (content) => {
    addBubble("ai", content);
    pushMsg("assistant", content);
    speak(content.replace(/\*/g, ""));
    return true;
  };
  let m = t.match(/^(?:remember|note that|keep in mind)\s+(?:that\s+)?(.+)$/);
  if (m) {
    const fact = m[1].replace(/^(?:my|i am|im|i'm|i am called|my name is)\s+/i, "").trim();
    if (/name is|call me|^my name/.test(m[1])) {
      state.profile.name = (m[1].match(/(?:name is|call me)\s+([a-z0-9' -]+)/i) || [])[1] || state.profile.name;
      addFact(`Name: ${state.profile.name}`);
      saveAll();
      return say(`Got it — I'll call you **${state.profile.name}** ✦ I'll remember that everywhere you use Nova.`);
    }
    addFact(fact);
    saveAll();
    return say(`🧠 Remembered: “${fact}”. I'll keep this in mind in all our chats, on this device **and** your paired ones.`);
  }
  m = t.match(/^forget\s+(?:about\s+|that\s+)?(.+)$/);
  if (m) {
    const frag = m[1].toLowerCase().replace(/^my\s+/, ""); // “forget my name” → “name”
    const before = state.profile.facts.length;
    state.profile.facts = state.profile.facts.filter((f) => !f.toLowerCase().includes(frag));
    if (/name/.test(frag)) {
      state.profile.name = "";
      state.profile.facts = state.profile.facts.filter((f) => !/^name\s*:/i.test(f));
    }
    LS.set("nova.profile", state.profile);
    scheduleSync();
    return say(before !== state.profile.facts.length ? `🧹 Done — I've forgotten everything about “${frag}”.` : `I don't have anything stored about “${frag}”.`);
  }
  if (/^(what do you know about me|who am i|tell me about myself|what do you remember)$/.test(t)) {
    const facts = state.profile.facts;
    if (!state.profile.name && !facts.length)
      return say(`I don't know anything about you yet! Tell me things like \`remember my name is Ali\` or \`remember I study at NUST\` — I'll use them in every chat and sync them to your other devices.`);
    return say(`🧠 **Here's what I know about you${state.profile.name ? ", " + state.profile.name : ""}:**\n\n` +
      facts.map((f) => `• ${f}`).join("\n") +
      `\n\n_Say \`forget <thing>\` to remove any of these. This memory syncs across your paired devices._`);
  }
  return false;
}

/* ---------------- Nova Lite: built-in free brain (no API key) ---------------- */
const LITE_KB = [
  { keys: ["photosynthesis"], a: "**Photosynthesis** 🌱 is how plants make their own food.\n\nThey take **sunlight + water + carbon dioxide (CO₂)** and turn them into **glucose (sugar)** and **oxygen**. It happens in the **chloroplasts**, using the green pigment **chlorophyll**.\n\nSimple equation:\n**6CO₂ + 6H₂O + light → C₆H₁₂O₆ + 6O₂**\n\n_Why it matters: it's the source of almost all food AND the oxygen you breathe._" },
  { keys: ["gravity"], a: "**Gravity** 🍎 is the force that pulls objects with mass toward each other.\n\nNewton: every object attracts every other object — heavier and closer = stronger pull. On Earth it accelerates things at **~9.8 m/s²**.\n\nEinstein's upgrade: mass bends **space-time**, and things just follow the curve.\n\n_Quick check: why do astronauts float on the ISS? (They're falling *around* Earth, not outside gravity!)_" },
  { keys: ["newton", "laws of motion"], a: "**Newton's 3 Laws of Motion** 🍏\n\n1. **Inertia** — things stay still or keep moving unless a force acts.\n2. **F = ma** — force = mass × acceleration.\n3. **Action–reaction** — every push gets an equal, opposite push.\n\n_Examples: seatbelts (1), pushing a cart (2), rocket launch (3)._" },
  { keys: ["water cycle"], a: "**The Water Cycle** 💧\n\n1. **Evaporation** — sun turns water into vapor.\n2. **Condensation** — vapor forms clouds.\n3. **Precipitation** — rain/snow falls.\n4. **Collection** — water gathers in rivers, lakes, oceans… and repeats.\n\n_Tip: \"Ev-Cond-Pre-Col\" — Every Cloud Pours Collection._" },
  { keys: ["algebra", "equation", "solve for x"], a: "**Solving equations** ➗ — keep the scales balanced!\n\nWhatever you do to one side, do to the other:\n**2x + 3 = 11** → subtract 3: **2x = 8** → divide by 2: **x = 4** ✅\n\n_Always do the *reverse* operation (opposite of + is −, opposite of × is ÷)._" },
  { keys: ["fraction"], a: "**Fractions** 🍕 — the bottom number (denominator) = total slices, top (numerator) = slices you have.\n\n- **Add/Subtract:** make denominators equal first (1/2 + 1/3 → 3/6 + 2/6 = 5/6).\n- **Multiply:** straight across (2/3 × 3/4 = 6/12 = 1/2).\n- **Divide:** flip the second fraction, then multiply.\n\n_Pizza slices make this click._" },
  { keys: ["recursion", "recursive"], a: "**Recursion** 🔁 is a function that calls itself on a smaller version of the problem, until it hits a **base case** (the stop condition).\n\nLike Russian dolls: open a doll → find a smaller doll → … → smallest doll stops you.\n\n_Keys: (1) base case, (2) make the problem smaller each call._" },
  { keys: ["cell", "biology", "mitochondria"], a: "**Cells** 🧫 are the building blocks of living things.\n\nKey parts:\n- **Nucleus** — the brain, stores DNA\n- **Mitochondria** — the power plant, makes energy\n- **Ribosomes** — build proteins\n- **Cell membrane** — the gatekeeper\n\n_Plant cells add a cell wall + chloroplasts for photosynthesis._" },
  { keys: ["world war", "ww2", "wwii"], a: "**World War II (1939–1945)** 🌍\n\n- Started when **Germany invaded Poland**.\n- Main sides: **Allies** (UK, US, USSR, …) vs **Axis** (Germany, Italy, Japan).\n- Ended in **1945** after Europe (May) and Japan's surrender (Aug, after atomic bombs).\n\n_Biggest turning points: Stalingrad, D-Day, Midway._" },
  { keys: ["solar system", "planet"], a: "**Our Solar System** 🪐 — 8 planets orbiting the Sun:\n\n**Mercury, Venus, Earth, Mars** (rocky) → **Jupiter, Saturn** (gas giants) → **Uranus, Neptune** (ice giants).\n\n_Memory trick: **M**y **V**ery **E**xcellent **M**other **J**ust **S**erved **U**s **N**oodles._" },
  { keys: ["democracy"], a: "**Democracy** 🗳️ = government **by the people**.\n\nCitizens elect leaders by voting; power isn't in one person's hands. Core ideas: **free elections, rule of law, rights & freedoms**.\n\n_Opposite extreme: dictatorship — one person/committee holds all power._" },
  { keys: ["atom", "atomic structure"], a: "**Atoms** ⚛️ — everything is built from them!\n\n- **Protons** (+) and **neutrons** (0) sit in the **nucleus**.\n- **Electrons** (−) zoom around in shells/clouds.\n- Atomic number = number of protons (that's what makes each element unique).\n\n_Atoms bond by sharing or trading electrons._" },
];

function novaLiteReply(text) {
  const t = norm(text);
  const HINT = "\n\n_— Nova Lite (built-in, works offline & free). Add a **free API key** in ⚙️ Settings to unlock GPT-4o, Claude & Gemini for *any* question._";

  if (/^(hi|hello|hey|yo|namaste|hola|good (morning|afternoon|evening))\b/.test(t))
    return `Hey! 👋 I'm **${state.nickname}** — your assistant. I'm running on my built-in **Lite brain** right now, so I can take notes, do math, open apps, quiz you and explain study topics.\n\nFor full AI chat about *anything*, add a free key in ⚙️ Settings — takes 1 minute.`;
  if (/(how are you|kaisi ho|kaise ho)/.test(t)) return "Running great! ✦ Ready when you are. Try `quiz me on photosynthesis` or say `open youtube`.";
  if (/^(who are you|your name|tum kaun ho)/.test(t)) return `I'm **${state.nickname}** ✦ — your personal AI assistant. Right now I'm on my free built-in Lite brain; add an API key in ⚙️ to upgrade me to GPT-4o / Claude / Gemini.`;
  if (/(what.*time|time.*now|^time$|^time\\?$)/.test(t)) return `🕐 It's **${new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}**.`;
  if (/(what.*(date|day)|today.*date|^date$|^date\\?|^day today$)/.test(t)) return `📅 Today is **${new Date().toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" })}**.`;
  if (/(joke|funny|hasao)/.test(t)) {
    const jokes = ["Why do programmers prefer dark mode? Because light attracts bugs! 🐛", "Why did the student eat his homework? The teacher said it was a piece of cake! 🎂", "I told my computer I needed a break… now it won't stop sending kit-kat ads. 🍫", "Why was the math book sad? Too many problems. ➗"];
    return jokes[Math.floor(Math.random() * jokes.length)];
  }
  if (/(thank|shukriya|dhanyavad)/.test(t)) return "Anytime! ✦";

  for (const item of LITE_KB) {
    if (item.keys.some((k) => t.includes(k))) return item.a + HINT;
  }

  return `Good question — that one needs my **full AI brain** 🧠 (GPT-4o / Claude / Gemini), which is locked behind a key.\n\n**Get a FREE key in 1 minute:**\n1. Open **aistudio.google.com/apikey** (sign in with Google — it's free)\n2. Copy the key → ⚙️ **Settings** → paste → **Save**\n\nMeanwhile, I can still: \`note …\`, \`calculate 15% of 200\`, \`open youtube\`, \`whatsapp …\`, \`quiz me on photosynthesis\`, \`review flashcards …\`, and explain: photosynthesis, gravity, Newton's laws, water cycle, algebra, fractions, recursion, cells, WW2, planets, democracy, atoms.`;
}

function streamLite(bub, full) {
  const words = full.split(/(\s+)/);
  let i = 0, acc = "";
  const tick = () => {
    acc += words[i] || "";
    i++;
    bub.innerHTML = renderMd(acc) + (i < words.length ? '<span class="cursor">▍</span>' : "");
    scrollBottom();
    if (i < words.length) setTimeout(tick, 14);
  };
  tick();
}

/* ---------------- Nova Lite end ---------------- */

/* ---------------- Models ---------------- */
const MODELS = {
  pollinations: [
    { id: "openai", label: "GPT (free, no key) — GPT-OSS 20B reasoning" },
  ],
  openrouter: [
    // Live-audited 2026-10-07: nemotron-3-super + ultra verified; ling-3.0 and
    // nemotron-3.5-lightning removed (404 / never verified).
    { id: "nvidia/nemotron-3-ultra-550b-a55b:free", label: "Nemotron 3 Ultra 550B · FREE — huge ⭐" },
    { id: "nvidia/nemotron-3-super-120b-a12b:free", label: "Nemotron 3 Super 120B · FREE" },
  ],
  // Removed the built-in "openai" provider — the shared TH key is not an OpenAI key
  // (live test: HTTP 401 on every model). Use Pollinations for keyless GPT instead.
  openai: [],
  gemini: [
    { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash — reliable ⭐" },
    { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash — solid" },
    { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite — speedy" },
    { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite — lightest" },
    { id: "gemini-3.7-flash", label: "Gemini 3.7 Flash — newest (often busy)" },
  ],
  groq: [
    // Live-audited 2026-09-26 + 2026-10-07 (all three verified again).
    // allam-2-7b removed — not re-verified in the 2026-10-07 audit.
    { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B — smartest, blazing fast ⚡" },
    { id: "openai/gpt-oss-20b", label: "GPT-OSS 20B — instant ⚡" },
    { id: "qwen/qwen3.8-27b", label: "Qwen 3.8 27B — smart" },
  ],
  ollama: [
    // Filled live from /api/ollama/models when the laptop runs Ollama.
    // Fallback shown if discovery hasn't run yet.
    { id: "llama3.2", label: "llama3.2 — local (install via Ollama)" },
  ],
  tokenharbor: [
    // Live-audited 2026-10-07. qwen3.8-flash:free returns HTTP 404 on both
    // keys (retired) — removed from the picker; relay falls back honestly.
    { id: "deepseek-v4.1-flash:free", label: "DeepSeek v4.1 Flash · FREE — default ⭐" },
    { id: "mimo-v2.6-flash:free", label: "MiMo v2.6 Flash · FREE" },
    { id: "mimo-v2.5:free", label: "MiMo v2.5 · FREE" },
    { id: "deepseek-v4-flash:free", label: "DeepSeek v4 Flash · FREE" },
  ],
  cleanapis: [
    // Live-audited 2026-10-07 — all three verified HTTP 200 with real content.
    // Picked to fill real gaps (5M tokens/mo plan, server-secure key only):
    // 1M context for huge documents, cheap vision, built-in web search.
    { id: "deepseek-v4-flash-0731", label: "DeepSeek V4 Flash — 1,000,000-token context ⭐" },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna — sees images (vision) · cheap" },
    { id: "kimi-k2.6", label: "Kimi K2.6 — built-in web search" },
  ],
  bai: [
    // NOTE: B.AI needs its own key; entries hidden from the picker until a key is set.
    { id: "glm-5.3-flash", label: "GLM 5.3 Flash" },
    { id: "qwen3.8-flash", label: "Qwen 3.8 Flash" },
    { id: "mimo-v2.5", label: "MiMo v2.5" },
    { id: "deepseek-v4.1-flash", label: "DeepSeek v4.1 Flash" },
  ],
};

/* Built-in provider keys now live SERVER-SIDE ONLY (Netlify environment
   variables — see nova-keys-netlify.txt locally, delete after setup).
   The browser never sees them: tokenharbor/groq/openrouter requests are
   relayed through /api/chat. Migration 2026-10-07 — keys were previously
   hardcoded here, which shipped them to every visitor. */
function getKey() {
  return state.apiKey;   // user's own keys (Gemini/B.AI) only; server brains need none
}

/* ---------------- Element refs ---------------- */
/* 2026-10-07 audit: models verified BROKEN (HTTP 404) are retired. If a saved
   choice points at one, migrate to the provider's verified default — never
   leave a user stuck on a dead model. */
const RETIRED_MODELS = {
  tokenharbor: ["qwen3.8-flash:free"],
  openrouter: ["inclusionai/ling-3.0-flash-fin:free"],
};
if (RETIRED_MODELS[state.provider] && RETIRED_MODELS[state.provider].includes(state.model)) {
  state.model = (MODELS[state.provider] && MODELS[state.provider][0] && MODELS[state.provider][0].id) || "auto";
  LS.set("nova.model", state.model);
}

const el = {
  menu: $("#btn-menu"), sidebar: $("#sidebar"), scrim: $("#scrim"),
  messages: $("#messages"), input: $("#input"), send: $("#btn-send"),
  mic: $("#btn-mic"), listen: null, speak: null,
  newChat: $("#btn-new-2"), settings: $("#btn-settings"),
  settingsModal: $("#settings-modal"), closeSettings: $("#btn-close-settings"),
  saveSettings: $("#btn-save-settings"), wipe: $("#btn-wipe"),
  setModel: $("#set-model"),
  setNickname: $("#set-nickname"), setAutospeak: $("#set-autospeak"),
  setStudyStrict: $("#set-study-strict"),
  history: $("#history"), install: $("#btn-install"),
  modeChip: $("#mode-chip"), netDot: $("#net-dot"),
  modelDD: $("#model-dd"), modelDDBtn: $("#model-dd-btn"), modelDDMenu: $("#model-dd-menu"),
  home: $("#home"), homeSlot: $("#home-slot"), greetNick: $(".greet-nick"), composer: $(".composer"),
  homeContinue: null, btnHome: null, // bottom-nav Home handler wired in wire()
  attach: $("#btn-attach"), attachMenu: $("#attach-menu"), attachTray: $("#attachments"),
  fileImg: $("#file-img"), fileCam: $("#file-cam"), fileDoc: $("#file-doc"), fileFolder: $("#file-folder"),
  status: $("#status-label"),
  listenBanner: $("#listen-banner"), wakeName: $("#wake-name"),
  listenStop: $("#btn-listen-stop"), queueInfo: $("#queue-info"),
  toasts: $("#toasts"), brand: $("#brand"),
};

/* ---------------- UI helpers ---------------- */
function toast(msg, kind = "", ms = 2600) {
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  t.textContent = msg;
  el.toasts.appendChild(t);
  setTimeout(() => { t.classList.add("hiding"); }, ms);
  setTimeout(() => t.remove(), ms + 400);
}

/* Celebration sparks on the cosmic background (safe no-op if bgfx absent) */
function celebrate(x, y, count) {
  if (window.NovaFX && window.NovaFX.burst) window.NovaFX.burst(x, y, count);
  else if (window.NovaFX && window.NovaFX.pulse) window.NovaFX.pulse();
}

/* Sparks from the send button's screen position (falls back to a plain pulse) */
function celebrateFromSend() {
  const r = el.send.getBoundingClientRect();
  if (r.width) celebrate(r.left + r.width / 2, r.top + r.height / 2, 20);
  else if (window.NovaFX) window.NovaFX.pulse();
}

/* V2: tap ripples retired — CSS :active states give all the feedback needed. */
function wireRipples() { /* kept as a no-op so old call sites stay harmless */ }

/* ---------------- Theme: dark / light / system ---------------- */
const mediaDark = window.matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
  const t = state.theme === "system" ? (mediaDark.matches ? "dark" : "light") : state.theme;
  document.documentElement.dataset.theme = t;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", t === "light" ? "#f7f7f8" : "#0b0d12");
  updateThemeIcons();
}
function updateThemeIcons() {
  const t = document.documentElement.dataset.theme;
  const icon = t === "light"
    ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6"/></svg>'
    : '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z"/></svg>';
  ["#btn-theme", "#btn-theme-2"].forEach((s) => {
    const b = $(s); if (b) b.innerHTML = icon;
  });
}
function cycleTheme() {
  const order = ["dark", "light", "system"];
  state.theme = order[(order.indexOf(state.theme) + 1 + order.length) % order.length];
  LS.set("nova.theme", state.theme);
  applyTheme();
  const sel = $("#set-theme"); if (sel) sel.value = state.theme;
  toast("Theme: " + state.theme, "ok");
}
mediaDark.addEventListener("change", () => { if (state.theme === "system") applyTheme(); });

/* Nova mark: the glass N-orb — dark glass circle, iridescent teal/violet
   rim, bold geometric N. Matches the app icon (make_icons.py). Injected
   into every .nova-mark placeholder. */
const NOVA_MARK_SVG = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">'
  + '<circle cx="12" cy="12" r="10.4" fill="#0A0C14"/>'
  + '<path d="M7.8 21.1 A10 10 0 0 1 16.2 2.9" stroke="#6EE7E0" stroke-width="1.7" stroke-linecap="round"/>'
  + '<path d="M16.2 2.9 A10 10 0 0 1 7.8 21.1" stroke="#966EFA" stroke-width="1.7" stroke-linecap="round"/>'
  + '<path d="M4.6 8.2 A8.6 8.6 0 0 1 8.6 4.7" stroke="#EAF6FF" stroke-width="1.1" stroke-linecap="round" opacity="0.75"/>'
  + '<path d="M8.3 16.6 V7.4 L15.7 16.6 V7.4" stroke="#F6FAFF" stroke-width="2.1" fill="none"/>'
  + '</svg>';
function injectNovaMarks() {
  document.querySelectorAll(".nova-mark").forEach((n) => { if (!n.dataset.mk) { n.dataset.mk = "1"; n.innerHTML = NOVA_MARK_SVG; } });
}

function setStatus(text) {
  if (!text) { el.status.innerHTML = ""; return; }
  el.status.innerHTML = `<span class="status-chip">${text}</span>`;
}

function setNet(online) {
  el.netDot.classList.toggle("offline", !online);
  el.netDot.title = online ? "Online" : "Offline — replies will be queued";
  if (online) flushQueue();
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/* Very small markdown-ish renderer: **bold**, *italic*, `code`,
   line breaks, links, and simple ``` blocks. */
function renderMd(text) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const stash = [];
  const keep = (html) => `\u0001${stash.push(html) - 1}\u0001`;
  let out = esc(text);
  out = out.replace(/```([\s\S]*?)```/g, (_, code) => keep(`<code class="block">${code}</code>`));
  out = out.replace(/`([^`\n]+)`/g, (_, code) => keep(`<code>${code}</code>`));
  out = out.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  out = out.replace(/(^|\s)\*([^*\n]+)\*(?=\s|$|[.,!?])/g, "$1<i>$2</i>");
  // markdown links stashed first so the bare-URL pass can't re-linkify them
  out = out.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_, label, url) =>
    keep(`<a href="${url}" target="_blank" rel="noopener">${label}</a>`));
  out = out.replace(/(^|[\s>])(https?:\/\/[^\s<]+[^\s<.,)])/g, (_, pre, url) =>
    pre + keep(`<a href="${url}" target="_blank" rel="noopener">${url}</a>`));
  out = out.replace(/\u0001(\d+)\u0001/g, (_, i) => stash[+i]);
  return out;
}

/* ---------------- Chats ---------------- */
let chatCount = 0; // ticked on send; used to re-render the history list
function currentChat() {
  if (!state.currentId || !state.chats[state.currentId]) newChatObj();
  return state.chats[state.currentId];
}

function newChatObj() {
  const id = "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  state.chats[id] = { id, title: "New chat", mode: state.mode, messages: [], ts: Date.now() };
  state.currentId = id;
  return state.chats[id];
}

function openChat(id) {
  state.currentId = id;
  LS.set("nova.currentId", id);
  renderHistory();
  renderMessages();
  el.sidebar.classList.remove("open");
  el.scrim.classList.remove("show");
}

function deleteChat(id) {
  delete state.chats[id];
  if (state.currentId === id) { state.currentId = null; newChatObj(); }
  saveAll();
  renderHistory();
  renderMessages();
}

function togglePin(id) {
  const c = state.chats[id];
  if (!c) return;
  c.pinned = !c.pinned;
  saveAll();
  scheduleSync();
  renderHistory();
}

function pushMsg(role, content) {
  const chat = currentChat();
  chat.messages.push({ role, content });
  const userCount = chat.messages.filter((m) => m.role === "user").length;
  if (role === "user" && (userCount === 1 || chat.title === "New chat")) {
    // For commands like "note …" or "open …", drop the verb for a cleaner title.
    const stripped = /^(note|open|whatsapp|email|calculate|find|summarize|explain|quiz|flashcards?)\b\s+/i.test(content)
      ? content.replace(/^\S+\s+/, "")
      : content;
    chat.title = stripped.slice(0, 38) || content.slice(0, 38) || "New chat";
  }
  chat.ts = Date.now();
  chatCount++;
  saveAll();
  scheduleSync();
  return chat.messages.length;
}

/* ---------------- Rendering ---------------- */
const MODE_LABELS = { chat: "Chat", study: "Study", exam: "Exam prep", homework: "Homework" };

function renderHistory() {
  renderHistoryInto(el.history, $("#side-search")?.value || "");
  const sheetHist = $("#sheet-history");
  if (sheetHist && !$("#chats-sheet").classList.contains("hidden")) {
    renderHistoryInto(sheetHist, $("#sheet-search")?.value || "");
  }
}

const DAY_MS = 86400000;
function historyBucket(ts) {
  const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
  const t0 = startToday.getTime();
  if (ts >= t0) return "Today";
  if (ts >= t0 - DAY_MS) return "Yesterday";
  if (ts >= t0 - 7 * DAY_MS) return "Previous 7 days";
  return "Older";
}

function historyGroups(list) {
  const groups = [];
  for (const c of list) {
    if (c.pinned) continue;
    const bucket = historyBucket(c.ts || Date.now());
    let g = groups.find((x) => x.label === bucket);
    if (!g) { g = { label: bucket, chats: [] }; groups.push(g); }
    g.chats.push(c);
  }
  return groups;
}

function renderHistoryInto(container, query) {
  container.innerHTML = "";
  const q = (query || "").trim().toLowerCase();
  let list = Object.values(state.chats).filter((c) => (c.messages || []).length);
  if (q) {
    list = list.filter((c) =>
      (c.title || "").toLowerCase().includes(q) ||
      (c.messages || []).some((m) => (m.content || "").toLowerCase().includes(q))
    ).sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.ts - a.ts);
  } else {
    list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.ts - a.ts);
  }
  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "side-empty";
    empty.textContent = q ? `No chats matching “${query.trim()}”` : "Your conversations will appear here.";
    container.appendChild(empty);
    return;
  }
  const pinIcon = (filled) =>
    `<svg viewBox="0 0 24 24" width="11" height="11" ${filled ? 'fill="currentColor"' : 'fill="none"'} stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M12 17v5M9 3h6l-1 7 3.5 3.5c.4.4.1 1.5-.5 1.5H7c-.6 0-.9-1.1-.5-1.5L10 10z"/></svg>`;
  const pinBtn = (c) => {
    const b = document.createElement("button");
    b.type = "button"; b.innerHTML = pinIcon(!!c.pinned);
    b.title = c.pinned ? "Unpin" : "Pin";
    b.setAttribute("aria-label", b.title);
    b.onclick = (e) => { e.stopPropagation(); togglePin(c.id); };
    return b;
  };
  const renameBtn = (c) => {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = "✎"; b.title = "Rename";
    b.setAttribute("aria-label", "Rename chat");
    b.onclick = (e) => { e.stopPropagation(); renameChat(c.id, container); };
    return b;
  };
  const delBtn = (c) => {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = "✕"; b.title = "Delete";
    b.setAttribute("aria-label", "Delete chat");
    b.onclick = (e) => { e.stopPropagation(); deleteChat(c.id); };
    return b;
  };
  const makeItem = (c) => {
    const div = document.createElement("div");
    div.className = "history-item" + (c.id === state.currentId ? " active" : "");
    div.setAttribute("role", "listitem");
    if (c.pinned) {
      const pin = document.createElement("span");
      pin.className = "h-pin"; pin.innerHTML = pinIcon(true);
      div.appendChild(pin);
    }
    const span = document.createElement("span");
    span.className = "h-title"; span.textContent = c.title;
    const actions = document.createElement("span");
    actions.className = "h-actions";
    actions.append(pinBtn(c), renameBtn(c), delBtn(c));
    div.append(span, actions);
    div.onclick = () => openChat(c.id);
    return div;
  };
  if (q) {
    list.forEach((c) => container.appendChild(makeItem(c)));
    return;
  }
  const pinned = list.filter((c) => c.pinned);
  if (pinned.length) {
    const head = document.createElement("div");
    head.className = "side-title"; head.textContent = "Pinned";
    container.appendChild(head);
    pinned.forEach((c) => container.appendChild(makeItem(c)));
  }
  historyGroups(list).forEach((g) => {
    const head = document.createElement("div");
    head.className = "side-title"; head.textContent = g.label;
    container.appendChild(head);
    g.chats.forEach((c) => container.appendChild(makeItem(c)));
  });
}

function renameChat(id, container) {
  const c = state.chats[id];
  if (!c) return;
  const item = (container || el.history).querySelector(".history-item.active .h-title");
  const host = item ? item.parentElement : null;
  if (!host) return;
  const editor = document.createElement("span");
  editor.className = "h-edit";
  const inp = document.createElement("input");
  inp.type = "text"; inp.value = c.title; inp.maxLength = 60;
  editor.appendChild(inp);
  host.replaceChild(editor, item);
  inp.focus();
  inp.select();
  const commit = () => {
    const v = inp.value.trim();
    if (v) c.title = v;
    saveAll(); scheduleSync();
    renderHistory();
  };
  inp.onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    else if (e.key === "Escape") { renderHistory(); }
  };
  inp.onblur = commit;
}

/* Long chats: rendering hundreds of bubbles at once is what makes big
   conversations feel sluggish. Render the most recent window (50) and add a
   real "Load earlier messages" control — nothing is hidden permanently. */
const MSG_WINDOW = 50;
let renderWindow = { chatId: null, n: MSG_WINDOW };

function renderMessages() {
  el.messages.innerHTML = "";
  const chat = currentChat();
  if (renderWindow.chatId !== chat.id) renderWindow = { chatId: chat.id, n: MSG_WINDOW };
  el.modeChip.textContent = MODE_LABELS[chat.mode] || "Chat";
  if (!chat.messages.length) {
    const hi = document.createElement("div");
    hi.className = "msg sys";
    const knowYou = !state.profile.asked && !state.profile.name && !state.profile.facts.length;
    hi.innerHTML = `${renderMd(
      (knowYou
        ? `Hi! I'm **${state.nickname}** ✦ — your personal AI assistant. Before we dive in, **tell me about yourself** so I can actually be *yours*:\n\n` +
          `1️⃣ \`remember my name is <your name>\`\n` +
          `2️⃣ \`remember I study/work at <place>\`\n` +
          `3️⃣ \`remember my best friend is <name>\` (or anything worth knowing!)\n\n` +
          `_Everything I learn syncs to your phone & laptop, and I use it naturally in every chat._\n\n`
        : `Welcome back${state.profile.name ? ", **" + state.profile.name + "**" : ""}! ✦\n\n`) +
      `I run on **free AI** — no key needed. I can help you **study** (\`quiz me on <topic>\`), take **notes**, ` +
      `open **WhatsApp** (\`whatsapp <number> <msg>\`), draft **emails** (\`email <address> <subject> saying <msg>\`), ` +
      `open **apps** (\`open youtube\`), and work **hands-free** with the 🎧 button.\n\n` +
      `Say \`what do you know about me\` anytime — and pair your devices in ⚙️ **Settings → Sync** so your phone and laptop share one brain.`
    )}</div>`;
    if (knowYou) { state.profile.asked = true; LS.set("nova.profile", state.profile); }
    el.messages.appendChild(hi);
  }
  const msgs = chat.messages;
  const start = Math.max(0, msgs.length - renderWindow.n);
  if (start > 0) {
    const older = document.createElement("button");
    older.className = "load-earlier";
    older.type = "button";
    older.textContent = `Load ${Math.min(MSG_WINDOW, start)} earlier messages (${start} hidden)`;
    older.onclick = () => {
      const prevHeight = el.messages.scrollHeight;
      const prevTop = el.messages.scrollTop;
      renderWindow.n += MSG_WINDOW;
      renderMessages();   // re-anchors to bottom; we restore the reading spot below
      el.messages.scrollTop = el.messages.scrollHeight - prevHeight + prevTop;
    };
    el.messages.appendChild(older);
  }
  msgs.slice(start).forEach((m, i) => {
    const bub = addBubble(m.role, m.content, false);
    bub.parentElement.style.setProperty("--i", i);
  });
  scrollBottom();
}

function addBubble(role, content, animate = true) {
  const wrap = document.createElement("div");
  wrap.className = "msg " + (role === "user" ? "user" : "ai");
  wrap.setAttribute("role", "listitem");
  const meta = document.createElement("div");
  meta.className = "msg-meta";
  if (role === "user") {
    meta.textContent = "You";
  } else {
    meta.innerHTML = '<span class="nova-mark sm" aria-hidden="true"></span>';
    const who = document.createElement("span");
    who.textContent = state.nickname;
    meta.appendChild(who);
  }
  const body = document.createElement("div");
  body.className = "msg-body";
  body.innerHTML = renderMd(content);
  wrap.append(meta, body);
  el.messages.appendChild(wrap);
  if (animate) scrollBottom();
  return body;
}

function scrollBottom() {
  el.messages.scrollTop = el.messages.scrollHeight;
}

/* ---------------- Modes & system prompts ---------------- */
const MODE_PROMPTS = {
  chat: "You are Nova, the user's personal JARVIS — sharp, articulate, highly capable, lightly witty, and loyal. You speak in concise, direct sentences suited for real-time speech (no rambling). You proactively use the available tools (laptop control, email drafts, notes) when they serve the user. Address the user respectfully. Never pad your answers.",
  study: "You are Nova in STUDY mode — a strict but encouraging tutor. Explain concepts clearly with simple examples and analogies, then end with 2-3 quick check questions. If asked for a direct homework answer, guide the reasoning first, then confirm.",
  exam: "You are Nova in EXAM PREP mode. Be rigorous: definitions, key formulas, common mistakes, and a mini practice set. Structured headers and bullets.",
  homework: "You are Nova in HOMEWORK mode. Step-by-step working, stated assumptions, and a short 'how to remember this' tip. Never just the final answer.",
};

/* ═══════ TOOL CALLING (OpenAI-compatible function loop) ═══════
   Nova's models can invoke real local capabilities. Each tool runs client-
   side (or against /api/act on the laptop) and its result is fed back to
   the model for a natural, informed final answer. */
const NOVA_TOOLS = [
  {
    type: "function",
    function: {
      name: "control_laptop",
      description: "Control the user's laptop: open an app or website, set volume, lock it, take a screenshot, show the battery, or fire a Windows notification. Use when the user says things like 'open spotify on my laptop' or 'what's my battery'.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["open", "volume", "lock", "screenshot", "battery", "notify", "clipboard"] },
          arg: { type: "string", description: "e.g. 'spotify', '40', notification text" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "draft_email",
      description: "Open a pre-filled email draft (Gmail on desktop, mail app on phone). Use when the user wants to email someone.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string" },
          subject: { type: "string" },
          body: { type: "string" },
        },
        required: ["to", "subject"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "whatsapp_message",
      description: "Open a WhatsApp chat to a phone number with a pre-filled message (app on phone, WhatsApp Web on desktop).",
      parameters: {
        type: "object",
        properties: {
          number: { type: "string", description: "digits with country code" },
          message: { type: "string" },
        },
        required: ["number"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_memory",
      description: "Persist a lasting fact about the user (name, school, friends, preferences). Use when the user shares something personal worth remembering.",
      parameters: {
        type: "object",
        properties: { fact: { type: "string" } },
        required: ["fact"],
      },
    },
  },
];

async function runTool(name, args) {
  args = args || {};
  if (name === "control_laptop") {
    const r = await actOnLaptop(args.action, args.arg || "");
    return r.ok ? `laptop ${args.action}: ${r.result || "done"}` : "laptop unreachable (is python serve.py running?)";
  }
  if (name === "draft_email") {
    const phone = isPhone();
    const url = phone
      ? `mailto:${encodeURIComponent(args.to)}?subject=${encodeURIComponent(args.subject || "")}${args.body ? "&body=" + encodeURIComponent(args.body) : ""}`
      : `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(args.to)}&su=${encodeURIComponent(args.subject || "")}${args.body ? "&body=" + encodeURIComponent(args.body) : ""}`;
    window.open(url, "_blank");
    return `email draft opened for ${args.to}`;
  }
  if (name === "whatsapp_message") {
    const number = String(args.number || "").replace(/[^\d]/g, "");
    const url = isPhone()
      ? `whatsapp://send?phone=${number}${args.message ? "&text=" + encodeURIComponent(args.message) : ""}`
      : `https://web.whatsapp.com/send?phone=${number}${args.message ? "&text=" + encodeURIComponent(args.message) : ""}`;
    window.open(url, "_blank");
    return `whatsapp opened for +${number}`;
  }
  if (name === "save_memory") {
    const f = String(args.fact || "").trim();
    if (f && !state.profile.facts.includes(f)) {
      state.profile.facts.push(f);
      saveAll(); scheduleSync();
      return `remembered: ${f}`;
    }
    return "already known";
  }
  return `unknown tool ${name}`;
}

/* ---------------- AI calls ---------------- */
function buildApiMessages(chat, files = []) {
  let sys = (MODE_PROMPTS[chat.mode] || MODE_PROMPTS.chat) + memoryBlock();
  if (isPhone()) sys += "\n(The user is on their PHONE — when they ask to message or email someone, prefer app deep-links.)";
  const msgs = [{ role: "system", content: sys }];
  // keep last 24 messages for context
  const recent = chat.messages.slice(-24);
  recent.forEach((m, idx) => {
    const isLastUser = idx === recent.length - 1 && m.role === "user";
    if (isLastUser && files.length && state.provider === "gemini") {
      // multipart message: images inline + doc text + user text
      msgs.push({ role: "user", content: m.content, _files: files });
    } else if (isLastUser && files.length) {
      const note = files.filter((f) => f.textContent).map((f) => `--- file: ${f.name} ---\n${f.textContent}\n--- end ---`).join("\n");
      const imgs = files.filter((f) => f.kind === "image").map((f) => `[image attached: ${f.name}]`).join(" ");
      msgs.push({ role: "user", content: (note ? note + "\n\n" : "") + (imgs ? imgs + "\n" : "") + m.content });
    } else {
      msgs.push({ role: m.role, content: m.content });
    }
  });
  return msgs;
}

async function callAI(messages, onDelta) {
  const { provider, model } = state;
  const apiKey = getKey();
  if (provider !== "pollinations" && provider !== "lite" && provider !== "ollama" &&
      !["tokenharbor", "groq", "openrouter", "cleanapis", "auto"].includes(provider) && !apiKey) throw new Error("NO_KEY");

  if (provider === "pollinations") {
    return await callFreeAI(messages, onDelta, true);
  }
  if (provider === "tokenharbor" || provider === "groq" || provider === "openrouter" || provider === "cleanapis" || provider === "auto") {
    // Server-relayed brains: keys live in Netlify env vars, never in the browser.
    // REAL streaming: /api/chat pipes the upstream SSE through token-by-token;
    // a plain JSON reply (older server or provider hiccup) is handled as fallback.
    const res = await aiFetch(apiUrl("/api/chat"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, model, messages, stream: true }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      throw new Error((j && j.error) || "relay failed");
    }
    const meta = parseNovaMeta(res.headers);
    if (meta && meta.fallbackUsed) toast(`Answered by ${meta.actualProvider || "free fallback"} — ${provider} unavailable`, "warn");
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("text/event-stream")) {
      return await readSSE(res, (json) => json?.choices?.[0]?.delta?.content || "", onDelta);
    }
    const j = await res.json();
    if (j.error) throw new Error(j.error);
    const m2 = j.meta || meta;
    if (m2 && m2.fallbackUsed) toast(`Answered by ${m2.actualProvider || "free fallback"} — ${provider} unavailable`, "warn");
    const txt = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
    if (txt) onDelta(txt);
    return;
  }
  if (provider === "ollama") {
    // Local model served by Ollama on this laptop, proxied via serve.py so
    // the phone can use the laptop's brain too.
    const res = await fetch("/api/ollama/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, stream: true }),
    });
    if (!res.ok) throw new Error(await readErr(res));
    return await readSSE(res, (json) => json?.choices?.[0]?.delta?.content || "", onDelta);
  }
  if (provider === "gemini") {
    if (!apiKey.startsWith("AIza")) throw new Error("NO_KEY"); // real Gemini keys start with AIza (AQ. tokens are revoked) → fall back cleanly
    const sys = messages.find((m) => m.role === "system")?.content || "";
    const contents = messages.filter((m) => m.role !== "system").map((m) => {
      if (m._files?.length) {
        const parts = [];
        for (const f of m._files) {
          if (f.dataBase64) parts.push({ inline_data: { mime_type: f.mime || "image/png", data: f.dataBase64 } });
          if (f.textContent) parts.push({ text: `--- file: ${f.name} ---\n${f.textContent}\n--- end ---` });
        }
        parts.push({ text: m.content });
        return { role: "user", parts };
      }
      return { role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] };
    });
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents,
          systemInstruction: { parts: [{ text: sys }] },
        }),
      }
    );
    if (!res.ok) throw new Error(await readErr(res));
    return await readSSE(res, (json) => {
      const t = json?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
      return t;
    }, onDelta);
  }

  // OpenAI-compatible (groq + openai + openrouter + tokenharbor)
  const endpoint = provider === "openrouter"
    ? "https://openrouter.ai/api/v1/chat/completions"
    : provider === "tokenharbor"
    ? "https://tokenharbor.ai/v1/chat/completions"
    : provider === "groq"
    ? "https://api.groq.com/openai/v1/chat/completions"
    : provider === "bai"
    ? "https://api.b.ai/v1/chat/completions"
    : "https://api.openai.com/v1/chat/completions";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
  if (provider === "openrouter") {
    headers["HTTP-Referer"] = location.origin;
    headers["X-Title"] = "Nova AI Assistant";
  }

  const doCall = (key) => {
    const h = { ...headers, Authorization: `Bearer ${key}` };
    return fetch(endpoint, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ model, messages, stream: true, tools: NOVA_TOOLS }),
    });
  };

  let res = await doCall(apiKey);
  // Built-in key failover removed: server brains relay via /api/chat, where
  // the server owns key rotation + fallback (see netlify/functions/chat.js).
  if (!res.ok) throw new Error(await readErr(res));
  return await readSSE(res, (json) => json?.choices?.[0]?.delta?.content || "", onDelta);
}

/* Tool-call executor: scans an SSE stream for function calls, runs them,
   returns the collected calls (and lets content stream normally). */
async function runWithTools(endpoint, headers, payload, onDelta, depth = 0) {
  const res = await fetch(endpoint, {
    method: "POST", headers,
    body: JSON.stringify({ ...payload, tools: NOVA_TOOLS }),
  });
  if (!res.ok) throw new Error(await readErr(res));
  const toolCalls = [];
  let content = "";
  await readSSE(res, (json) => {
    const delta = json?.choices?.[0]?.delta || {};
    if (delta.content) { content += delta.content; onDelta(delta.content); }
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const i = tc.index ?? 0;
        toolCalls[i] = toolCalls[i] || { id: tc.id || "call_" + i, type: "function", function: { name: "", arguments: "" } };
        if (tc.id) toolCalls[i].id = tc.id;
        if (tc.function?.name) toolCalls[i].function.name = tc.function.name;
        if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
      }
    }
    return delta.content || "";
  });
  const real = toolCalls.filter(Boolean);
  if (real.length && depth < 3) {
    payload.messages = payload.messages || [];
    payload.messages.push({ role: "assistant", content: content || null, tool_calls: real });
    for (const tc of real) {
      let out;
      try { out = await runTool(tc.function.name, JSON.parse(tc.function.arguments || "{}")); }
      catch (e) { out = "tool error: " + e.message; }
      payload.messages.push({ role: "tool", tool_call_id: tc.id, content: String(out) });
    }
    const r2 = await fetch(endpoint, {
      method: "POST", headers,
      body: JSON.stringify({ ...payload, tools: NOVA_TOOLS }),
    });
    if (!r2.ok) throw new Error(await readErr(r2));
    let final = "";
    await readSSE(r2, (json) => {
      const piece = json?.choices?.[0]?.delta?.content || "";
      if (piece) { final += piece; onDelta(piece); }
      return piece;
    });
    return final;
  }
  return content;
}

/* Free no-key AI (Pollinations). Transport logic:
   - Served over http(s) → use our own /api/chat proxy (server, Netlify or Vercel).
     Pollinations blocks direct browser calls from web origins (Turnstile).
   - Opened as a file (file://) → call Pollinations directly; it allows Origin: null.
   - Proxy unreachable → try direct once, then explain how to start the server. */
async function callFreeAI(messages, onDelta, stream = true) {
  const attempt = async (url, allowStream) => {
    const res = await aiFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openai", messages, stream: allowStream }),
    });
    if (!res.ok) throw new Error(await readErr(res));
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      const j = await res.json();
      const content = j?.choices?.[0]?.message?.content || "";
      if (content) onDelta(content);
      return content;
    }
    return await readSSE(res, (json) => json?.choices?.[0]?.delta?.content || "", onDelta);
  };

  if (location.protocol === "file:") {
    return attempt("https://text.pollinations.ai/openai", false);
  }
  try {
    return await attempt(apiUrl("/api/chat"), stream);
  } catch (proxyErr) {
    try {
      return await attempt("https://text.pollinations.ai/openai", false);
    } catch {
      throw new Error(apiBase()
        ? "Can't reach the AI relay — check your connection and retry."
        : "Can't reach the AI relay — the local server isn't running. Open a terminal in the Nova folder and run: python serve.py — then open http://localhost:8080");
    }
  }
}

function friendlyError(err) {
  if (err instanceof TypeError && /fetch/i.test(err.message || "")) {
    return "Can't reach the AI relay — if you opened Nova as a file, run the server instead: `python serve.py` → open http://localhost:8080. If it's already running, check your internet.";
  }
  return err.message;
}

/* ═══════ REQUEST DISCIPLINE: one in-flight AI request, ever ═══════
   A new AI request aborts the previous one (no abandoned streams burning
   bandwidth/CPU), every request carries a hard timeout, and parseNovaMeta
   reads the server's truthful routing metadata from the response header. */
let novaInflight = null;
function aiFetch(url, opts = {}, timeoutMs = 120000) {
  if (novaInflight) { try { novaInflight.abort(); } catch { /* already dead */ } }
  const ac = new AbortController();
  novaInflight = ac;
  // Timeout abort carries a REASON → surfaces as a real error the user can
  // act on. Superseded aborts (new request takes over) carry no reason.
  const timer = setTimeout(() => {
    try { ac.abort(new Error("The AI didn't respond within " + Math.round(timeoutMs / 1000) + "s — the provider or your connection may be down. Try again.")); } catch { /* already dead */ }
  }, timeoutMs);
  return fetch(url, { ...opts, signal: ac.signal }).finally(() => {
    clearTimeout(timer);
    if (novaInflight === ac) novaInflight = null;
  });
}
function isSupersededRequest(err) {
  return err && (err.name === "AbortError" || String(err.message || "").includes("aborted"));
}
function parseNovaMeta(headers) {
  try {
    const b64 = headers && headers.get("X-Nova-Meta");
    return b64 ? JSON.parse(atob(b64)) : null;
  } catch { return null; }
}

async function readSSE(res, pick, onDelta) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", full = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    buf = buf.replace(/\r\n/g, "\n"); // Google uses CRLF event separators
    const parts = buf.split("\n\n");
    buf = parts.pop() || "";
    for (const part of parts) {
      for (const line of part.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return full;
        try {
          const json = JSON.parse(data);
          const piece = pick(json);
          if (piece) { full += piece; onDelta(piece); }
        } catch { /* keep-alive or partial */ }
      }
    }
  }
  return full;
}

async function readErr(res) {
  let detail = "";
  try { detail = (await res.text()).slice(0, 300); } catch { /* ignore */ }
  if (detail.includes("email_verification_required")) {
    return "Token Harbor needs email verification: open tokenharbor.ai/dashboard, click the verification link they emailed you, then retry.";
  }
  if (res.status === 401) return "Invalid API key. Check Settings (⚙️). " + detail;
  if (detail.includes("insufficient_user_quota") || detail.includes("credit insufficient balance")) {
    return "This key has no credits left — top it up on the provider's dashboard, or switch brains in the composer menu.";
  }
  if (res.status === 402 || res.status === 429) return "Rate limit / credits issue on this key. " + detail;
  return `API error ${res.status}. ` + detail;
}

/* ---------------- Commands (device skills) ---------------- */
function norm(s) { return s.toLowerCase().trim(); }

/* Device detection — phones get app deep-links, desktops get web versions */
function isPhone() {
  const touch = matchMedia("(hover: none) and (pointer: coarse)").matches;
  const small = Math.min(screen.width, screen.height) < 500;
  const ua = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  return ua || (touch && small);
}

const APPS = {
  youtube: "https://youtube.com", gmail: "https://mail.google.com",
  google: "https://google.com", maps: "https://maps.google.com",
  drive: "https://drive.google.com", photos: "https://photos.google.com",
  spotify: "https://open.spotify.com", netflix: "https://netflix.com",
  instagram: "https://instagram.com", whatsapp: "https://web.whatsapp.com",
  telegram: "https://web.telegram.org", twitter: "https://twitter.com",
  snapchat: "https://web.snapchat.com",
  "snap chat": "https://web.snapchat.com",
  twitch: "https://twitch.tv", discord: "https://discord.com/app",
  coursera: "https://coursera.org", khan: "https://khanacademy.org",
  "khan academy": "https://khanacademy.org", chatgpt: "https://chatgpt.com", github: "https://github.com",
  linkedin: "https://linkedin.com", reddit: "https://reddit.com",
  pinterest: "https://pinterest.com", quora: "https://quora.com",
  "google classroom": "https://classroom.google.com",
  classroom: "https://classroom.google.com", "ms teams": "https://teams.microsoft.com",
  teams: "https://teams.microsoft.com", zoom: "https://zoom.us",
  calendar: "https://calendar.google.com", keep: "https://keep.google.com",
  "play store": "https://play.google.com/store",
  amazon: "https://amazon.com", flipkart: "https://flipkart.com",
};

/* ═══════════════════════════════════════════════════════════════════
   ACTION REGISTRY — the single allowlist of everything Nova's agent
   can do. The AI/model never executes anything directly; every request
   flows: intent → registry lookup → risk check → confirmation →
   validated executor (serve.py actuator) → real result → honest report.
   ═══════════════════════════════════════════════════════════════════ */
const RISK = { SAFE: "SAFE", LOW: "LOW", HIGH: "HIGH" };

const ACTION_REGISTRY = {
  /* ---- SAFE: run immediately ---- */
  open:            { risk: RISK.SAFE, desc: "Open an app or website" },
  open_path:       { risk: RISK.SAFE, desc: "Reveal a file/folder in Explorer" },
  stats:           { risk: RISK.SAFE, desc: "CPU / RAM / GPU / battery readout" },
  storage:         { risk: RISK.SAFE, desc: "Disk usage + biggest folders" },
  processes:       { risk: RISK.SAFE, desc: "Top background processes by RAM" },
  network:         { risk: RISK.SAFE, desc: "Wi-Fi status" },
  find_files:      { risk: RISK.SAFE, desc: "Search files in your personal folders" },
  list_dir:        { risk: RISK.SAFE, desc: "List a folder's contents" },
  battery:         { risk: RISK.SAFE, desc: "Battery level" },
  screenshot:      { risk: RISK.SAFE, desc: "Capture the laptop screen" },
  cleanup_preview: { risk: RISK.SAFE, desc: "Preview cleanable temp files (deletes nothing)" },
  gaming_preview:  { risk: RISK.SAFE, desc: "Read current power state + headroom" },

  /* ---- LOW: confirmation by context ---- */
  create_folder:   { risk: RISK.LOW,  desc: "Create a folder in your personal folders" },
  rename_file:     { risk: RISK.LOW,  desc: "Rename a file/folder" },
  move_file:       { risk: RISK.LOW,  desc: "Move a file/folder" },
  copy_file:       { risk: RISK.LOW,  desc: "Copy a file" },
  volume:          { risk: RISK.LOW,  desc: "Change laptop volume" },
  notify:          { risk: RISK.LOW,  desc: "Show a Windows toast" },

  /* ---- HIGH: typed confirmation ALWAYS ---- */
  cleanup:         { risk: RISK.HIGH, desc: "Delete temp files (24h+, allowlisted dirs)" },
  trash_path:      { risk: RISK.HIGH, desc: "Move a file/folder to NovaTrash (reversible)" },
  empty_trash:     { risk: RISK.HIGH, desc: "Permanently empty NovaTrash" },
  lock:            { risk: RISK.HIGH, desc: "Lock the laptop" },
  type:            { risk: RISK.HIGH, desc: "Type on the laptop" },
  key:             { risk: RISK.HIGH, desc: "Send keystrokes to the laptop" },
  gaming_apply:    { risk: RISK.HIGH, desc: "Switch power mode (settings change)" },
};

function registryAllows(action) {
  return Object.prototype.hasOwnProperty.call(ACTION_REGISTRY, action);
}

/* Every executed action lands in the Activity log — what, when, device, result.
   Synced with the rest of the payload so phone and laptop share one history. */
function logActivity(action, summary, status = "completed") {
  state.activity.unshift({
    id: "a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    action, summary, status, ts: Date.now(), device: deviceName(),
  });
  if (state.activity.length > 100) state.activity.length = 100;
  LS.set("nova.activity", state.activity);
  scheduleSync();
}

function activityToText(limit = 14) {
  const byDay = new Map();
  for (const a of state.activity.slice(0, limit)) {
    const d = new Date(a.ts);
    const key = d.toDateString();
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(a);
  }
  const icons = { completed: "✓", running: "…", failed: "✗", cancelled: "–" };
  let out = "";
  for (const [day, items] of byDay) {
    const label = day === new Date().toDateString() ? "Today" : day;
    out += `**${label}**\n`;
    for (const a of items) {
      const time = new Date(a.ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      out += `${icons[a.status] || "·"} ${a.summary} — ${time}${a.device ? ` · ${a.device}` : ""}\n`;
    }
    out += "\n";
  }
  return out.trim();
}

/* Central executor: registry check → risk → confirmation → act → log → report.
   Returns true if the command was handled (success OR failure — both honest). */
async function runAgentAction(action, arg, opts = {}) {
  if (!registryAllows(action)) {
    addBubble("ai", `I don't have a safe tool for “${escHtml(action)}” — it's not in my action registry, so I won't attempt it.`);
    speak("I don't have a safe tool for that.");
    return true;
  }
  const spec = ACTION_REGISTRY[action];
  const needsConfirm = spec.risk === RISK.HIGH || (opts.confirm === true);
  const doRun = async () => {
    const r = await actOnLaptop(action, arg);
    if (r && r.ok) {
      logActivity(action, opts.activitySummary || spec.desc, "completed");
    } else {
      logActivity(action, opts.activitySummary || spec.desc, "failed");
    }
    return r;
  };

  if (!needsConfirm) {
    const r = await doRun();
    if (!(r && r.ok)) {
      const why = (r && r.error) ? escHtml(String(r.error).slice(0, 160)) : "the laptop didn't respond";
      addBubble("ai", `I couldn't ${spec.desc.toLowerCase()}: ${why}.\n\n_If the laptop is asleep, wake it and make sure \`python serve.py\` is running, then try again._`);
      speak("I couldn't complete that. The laptop didn't respond.");
    }
    return { handled: true, result: r };
  }

  /* HIGH risk → typed confirmation, exactly like the cleanup flow. */
  return { handled: true, result: null, needsConfirm: true, doRun, spec, arg };
}

/* ---------------- Nova Agent: helpers ---------------- */
async function agentStatusReply(text) {
  const r = await actOnLaptop("stats", "");
  if (r && r.ok) {
    const bits = [];
    if (r.cpu != null) bits.push(`CPU **${Math.round(r.cpu)}%**`);
    if (r.ramTotalGb) bits.push(`RAM **${r.ramUsedGb} / ${r.ramTotalGb} GB**`);
    if (r.gpuName) bits.push(`GPU: ${r.gpuName}${r.gpuLoad != null ? ` (${Math.round(r.gpuLoad)}%)` : ""}`);
    if (r.battery != null) bits.push(`Battery **${Math.round(r.battery)}%**`);
    if (r.processes) bits.push(`${r.processes} processes`);
    const content = `💻 **Laptop status**\n${bits.join(" · ")}\n\n_Say “storage” for space, “clean temp files” to free space, or “find <file>” to search._`;
    addBubble("ai", content);
    pushMsg("assistant", content);
    speak("Laptop is healthy. " + bits.slice(0, 2).join(", "));
    return true;
  }
  const msg = "⚠️ The Nova Agent isn't reachable — start it on the laptop with `python serve.py`, then try again.";
  addBubble("ai", msg); pushMsg("assistant", msg);
  return true;
}

function renderFileResults(hits, query) {
  const box = $("#files-list");
  box.innerHTML = "";
  if (!hits || !hits.length) {
    box.innerHTML = '<div class="dev-row muted">No files matching “' + escHtml(query) + '” in your user folders.</div>';
  } else {
    for (const h of hits) {
      const row = document.createElement("div");
      row.className = "dev-row";
      const name = document.createElement("span");
      name.className = "dev-name";
      const t = document.createElement("span"); t.textContent = h.name;
      const sm = document.createElement("small"); sm.textContent = h.path;
      name.append(t, sm);
      const open = document.createElement("button");
      open.className = "dev-revoke"; open.textContent = "Open"; open.title = "Show in folder";
      open.style.width = "auto"; open.style.padding = "0 10px";
      open.onclick = async () => {
        const r = await actOnLaptop("open_path", h.path);
        toast(r && r.ok ? "Opened location" : "Couldn't open that file", r && r.ok ? "ok" : "warn");
      };
      row.append(name, open);
      box.appendChild(row);
    }
  }
  $("#files-modal").classList.remove("hidden");
}

/* JARVIS: run an action on the laptop via the local server's actuator.
   From the phone this reaches the laptop over Wi-Fi (same origin = the laptop). */
async function actOnLaptop(action, arg) {
  try {
    const res = await fetch("/api/act", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, arg }),
    });
    return await res.json();
  } catch {
    return { ok: false, error: "unreachable" };
  }
}

async function tryCommand(text) {
  const t = norm(text);
  if (tryMemoryCommand(text)) { renderHistory(); return true; }
  const say = (content, kind = "sys") => {
    addBubble("user", text);
    pushMsg("user", text);
    addBubble("ai", content);
    pushMsg("assistant", content);
    renderHistory();
    if (kind === "speak") speak(content.replace(/\*/g, ""));
    return true;
  };

  // help
  if (/^(help|what can you do|commands)$/.test(t)) {
    return say(
      `**Here's what I can do** ✦\n\n` +
      `🧠 **AI chat** — ask me anything (top models in ⚙️ Settings)\n` +
      `📚 **Study** — \`quiz me on <topic>\` · \`flashcards on <topic>\` · \`explain <topic>\`\n` +
      `🗒️ **Notes** — \`note <text>\` · \`notes\` · \`find in notes <word>\`\n` +
      `🟢 **WhatsApp** — \`whatsapp <number> <message>\` (opens the chat pre-filled)\n` +
      `✉️ **Email** — \`email <address> <subject> saying <message>\` (opens Gmail draft)\n` +
      `🌐 **Open apps** — \`open youtube\`, \`open spotify\`, \`open maps\`…\n` +
      `🎙️ **Hands-free** — tap 🎧 then say “${state.nickname}, open youtube”\n` +
      `🃏 **Flashcard review** — \`review flashcards <topic>\`\n` +
      `_Offline: notes, flashcards, math, app-opening and queueing still work._`,
      "speak"
    );
  }

  // time / date — instant + spoken on every brain (no AI round-trip, correct timezone)
  if (/^(what(?:'s| is)?( the)? time( now)?|time\??|current time)$/.test(t)) {
    const now = new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return say(`🕐 It's **${now}**.`, "speak");
  }
  if (/^(what(?:'s| is)?( the)? (date|day)( today)?|date\??|today'?s date|what day is (it|today))$/.test(t)) {
    const d = new Date().toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    return say(`📅 Today is **${d}**.`, "speak");
  }

  // notes (match original text to preserve capitalization)
  let  m = text.match(/^note\s+(?:that\s+)?(.+)$/i);
  if (m) {
    state.notes.unshift({ text: m[1], ts: Date.now() });
    saveAll();
    scheduleSync();
    return say(`🗒️ Note saved: “${m[1]}”. You have ${state.notes.length} note(s).`, "speak");
  }
  if (/^(notes|my notes|show notes)$/.test(t)) {
    if (!state.notes.length) return say("🗒️ No notes yet. Say `note <text>` to save one.", "speak");
    return say("🗒️ **Your notes:**\n" + state.notes.slice(0, 20).map((n, i) => `${i + 1}. ${n.text}`).join("\n"), "speak");
  }
  m = text.match(/^find in notes\s+(.+)$/i);
  if (m) {
    const hits = state.notes.filter((n) => n.text.includes(m[1]));
    return say(hits.length ? `🔎 Found:\n` + hits.map((n) => `• ${n.text}`).join("\n") : `No notes matching “${m[1]}”.`, "speak");
  }

  // percentages: "15% of 2400", "what is 20 percent of 300"
  m = t.match(/^(?:calculate\s+)?(?:what(?:'s| is)?\s+)?([\d.]+)\s*(?:%|percent)\s+of\s+([\d.]+)$/);
  if (m) {
    const val = (parseFloat(m[1]) / 100) * parseFloat(m[2]);
    return say(`🧮 ${m[1]}% of ${m[2]} = **${Number.isInteger(val) ? val : val.toFixed(2)}**`, "speak");
  }

  // math (offline-safe)
  m = t.match(/^calculate\s+(.+)$/) || t.match(/^what(?:'s| is)\s+([\d\s().+\-*/%^]+)$/) || t.match(/^([\d\s().+\-*/%^]{3,})\s*[=?]$/);
  if (m) {
    try {
      const expr = m[1].replace(/\^/g, "**").replace(/[^0-9+\-*/().% ]|\*\*/g, (s) => (s === "*" ? "*" : ""));
      // eslint-disable-next-line no-new-func
      const val = Function(`"use strict";return (${expr})`)();
      if (typeof val === "number" && isFinite(val)) return say(`🧮 ${m[1].trim()} = **${val}**`, "speak");
    } catch { /* fall through to AI */ }
  }

  // flashcards & quiz handled by AI, but review is local
  m = t.match(/^review flashcards\s+(.+)$/);
  if (m) {
    const topic = m[1].trim();
    const cards = state.cards[topic] || state.cards[norm(topic)];
    if (!cards || !cards.length) return say(`No flashcards saved for “${topic}” yet. Generate some with \`flashcards on ${topic}\`.`);
    let i = 0;
    const show = () => {
      const c = cards[i % cards.length];
      addBubble("ai", `🃏 **Q:** ${c.q}\n\n_Tap to reveal…_`);
      const last = el.messages.lastChild.querySelector(".msg-body");
      last.style.cursor = "pointer";
      last.title = "Tap to reveal";
      last.onclick = () => {
        last.onclick = null;
        last.innerHTML = renderMd(`🃏 **Q:** ${c.q}\n\n**A:** ${c.a}`);
        speak(`Answer. ${c.a}`);
        i++;
        setTimeout(show, 1200);
      };
    };
    show();
    return true;
  }

  // whatsapp — smart target: WhatsApp app deep-link on phones, WhatsApp Web on desktop.
  m = text.match(/^whatsapp\s+([\d+\s-]{6,})\s*(.*)$/);
  if (m) {
    const number = m[1].replace(/[^\d]/g, "");
    const msg = m[2] || "";
    const phone = isPhone();
    const url = phone
      ? `whatsapp://send?phone=${number}${msg ? "&text=" + encodeURIComponent(msg) : ""}` // opens the installed app
      : `https://web.whatsapp.com/send?phone=${number}${msg ? "&text=" + encodeURIComponent(msg) : ""}`; // WhatsApp Web
    const label = phone ? "WhatsApp app" : "WhatsApp Web";
    addBubble("ai", `🟢 Opening **${label}** for **+${number}**${msg ? ` with your message:\n\n> ${msg}` : ""}\n\n[Open ${label}](${url})`);
    const win = window.open(url, "_blank");
    if (phone && (!win || win.closed)) location.href = url; // app-link fallback if pop-up blocked
    speak(`Opening WhatsApp for ${number}.`);
    return true;
  }

  // call — opens the native dialer with the number pre-filled (phone); on the
  // laptop it hands off to the paired phone's dialer via a tel: link too.
  m = text.match(/^call\s+([\d+\s-]{6,})\s*(.*)$/);
  if (m) {
    const number = m[1].replace(/[^\d+]/g, "");
    const url = "tel:" + number;
    addBubble("ai", `📞 Calling **+${number.replace(/^\+/, "")}**…\n\n[Dial now](${url})`);
    location.href = url;
    speak(`Calling ${number}.`);
    return true;
  }

  // email — Gmail compose on desktop (rich draft), mailto: on phones (opens the mail app)
  m = text.match(/^email\s+([^\s]+@[^\s]+)\s+(?:about\s+|regarding\s+)?(.+?)(?:\s+saying\s+(.*))?$/);
  if (m) {
    const [, to, subject, body] = m;
    const phone = isPhone();
    const url = phone
      ? `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}${body ? "&body=" + encodeURIComponent(body) : ""}`
      : `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${encodeURIComponent(subject)}${body ? "&body=" + encodeURIComponent(body) : ""}`;
    const label = phone ? "your mail app" : "Gmail draft";
    addBubble("ai", `✉️ ${phone ? "Opening your mail app" : "Gmail draft ready"} for **${to}**\n**Subject:** ${subject}${body ? `\n\n> ${body}` : ""}\n\n[Open ${label}](${url})`);
    const win = window.open(url, "_blank");
    if (phone && (!win || win.closed)) location.href = url;
    speak(`Email draft ready for ${to}.`);
    return true;
  }

  // open app / site — on a phone, ALSO command the laptop via /api/act
  m = t.match(/^open\s+(.+)$/);
  if (m) {
    const target = m[1].replace(/\.(com|org|net|in)$/i, "").trim();
    const url = APPS[target] || (/^[\w-]+\.[\w.-]+$/.test(m[1]) ? "https://" + m[1] : null);
    if (url) {
      addBubble("ai", `🌐 Opening **${target}**…\n\n[Open ${target}](${url})`);
      window.open(url, "_blank");
      speak(`Opening ${target}.`);
      if (isPhone()) actOnLaptop("open", target); // mirrored on the laptop too
      return true;
    }
  }

  /* ——— Nova Agent: system, storage, files (real, allowlisted) ——— */
  m = t.match(/^(?:what(?:'s| is)?\s+(?:my\s+)?|show(?:\s+me)?\s+(?:my\s+)?)?(cpu|gpu|ram|memory|battery|system status|laptop status|laptop health|how is my laptop|how is my pc)\??$/i);
  if (m) {
    const say2 = await agentStatusReply(text);
    if (say2) return true;
  }
  m = t.match(/^(storage|disk space|storage usage|check storage|show storage|what.?s taking up my storage|laptop storage)\??$/i);
  if (m) {
    const r = await actOnLaptop("storage", "");
    if (!(r && r.ok)) return say("⚠️ The Nova Agent isn't reachable on the laptop — start it there with `python serve.py`.", "speak");
    const lines = [];
    for (const d of r.disks || []) lines.push(`**${d.drive}** ${d.usedGb} GB used of ${d.totalGb} GB`);
    for (const f of r.topFolders || []) lines.push(`- ${f.folder}: ${f.gb} GB`);
    if (r.tempGb) lines.push(`- Temporary files: ${r.tempGb} GB (say “clean temp files” and I'll ask before deleting)`);
    return say(lines.length ? `💾 **Storage:**\n${lines.join("\n")}` : "💾 I couldn't read the disks.", "speak");
  }
  m = t.match(/^(?:clean|clear|delete) (?:my )?(?:temp|temporary|junk|cache)(?: files)?\??$/i) || t.match(/^laptop (?:clean|cleanup)$/i);
  if (m) {
    const r = await actOnLaptop("cleanup_preview", "");
    if (!(r && r.ok)) return say("⚠️ The Nova Agent isn't reachable on the laptop — start it there with `python serve.py`.", "speak");
    const cats = (r.categories || []).filter((c) => c.gb >= 0.01);
    if (!cats.length) return say("✨ Nothing safe to clean — temp folders are already tiny.", "speak");
    const total = cats.reduce((a, c) => a + c.gb, 0);
    const detail = cats.map((c) => `- ${c.label}: ${c.gb} GB (${c.files} files)`).join("\n");
    openConfirm("Clean temporary files?", `I'll delete files older than 24 hours from these safe folders only:\n\n${detail}\n\nNothing else is touched. Locked files are skipped.`, `Free ${total.toFixed(1)} GB`, async () => {
      let freed = 0, files = 0;
      for (const c of cats) {
        const res = await actOnLaptop("cleanup", c.path);
        if (res && res.ok) { freed += res.freedGb || 0; files += res.files || 0; }
      }
      const done = `🧹 Done — freed **${freed.toFixed(2)} GB** (${files} files).`;
      addBubble("ai", done); pushMsg("assistant", done); speak("Cleaned. Freed " + freed.toFixed(1) + " gigabytes.");
    });
    return true;
  }
  m = t.match(/^(?:laptop\s+)?find (?:the )?(?:file |pdf |photo |video |document )?(?:named |called )?["']?(.+?)["']?$/i) || t.match(/^laptop search (.+)$/i);
  if (m) {
    const q = m[1].replace(/\?+$/, "").replace(/^(?:my |on my laptop )/i, "").trim();
    if (q.length >= 2) {
      const r = await actOnLaptop("find_files", { q });
      if (r && r.ok) {
        renderFileResults(r.hits, q);
        const n = (r.hits || []).length;
        return say(n ? `🔎 Found **${n}** file${n === 1 ? "" : "s"} matching “${q}” on the laptop.` : `No files matching “${q}” on the laptop.`);
      }
    }
  }

  // Continue a cross-device task: "continue that message", "continue that draft"
  m = t.match(/^continue (?:that |the |my )?(message|draft|email|whatsapp|task)?$/i);
  if (m) {
    const kindMap = { message: null, draft: null, email: "email", whatsapp: "whatsapp", task: null };
    const task = latestTask(m[1] ? kindMap[m[1]] : null);
    if (!task) return say("There's nothing in progress right now — everything is synced and wrapped up.");
    const lines = [`📌 **${task.title}**`, task.detail || "", ``, `_Started on ${task.origin} · status: ${task.status}_`];
    return say(lines.filter(Boolean).join("\n"));
  }

  // ——— JARVIS: command the LAPTOP (works from the phone over Wi-Fi) ———
  m = t.match(/^laptop\s+(open|launch|start)\s+(.+)$/i);
  if (m) {
    const r = await actOnLaptop("open", m[2].trim());
    return say(r.ok ? `💻 Laptop: ${r.result}` : `⚠️ Laptop not reachable — is \`python serve.py\` running there?`, "speak");
  }
  m = t.match(/^laptop\s+(?:volume|sound)\s+(mute|unmute|[\d.]+)\s*%?$/i);
  if (m) {
    const r = await actOnLaptop("volume", m[1]);
    return say(r.ok ? `🔊 Laptop: ${r.result}` : "⚠️ Laptop not reachable", "speak");
  }
  m = t.match(/^laptop\s+(?:lock|lock the laptop|lock laptop)$/i);
  if (m) {
    const r = await actOnLaptop("lock", "");
    return say(r.ok ? "🔒 Laptop locked." : "⚠️ Laptop not reachable", "speak");
  }
  m = t.match(/^laptop\s+battery$/i);
  if (m) {
    const r = await actOnLaptop("battery", "");
    return say(r.ok ? `🔋 ${r.result}` : "⚠️ Laptop not reachable", "speak");
  }
  m = t.match(/^laptop\s+(?:screenshot|screen shot)$/i);
  if (m) {
    const r = await actOnLaptop("screenshot", "");
    if (r.ok && r.image) {
      addBubble("user", text); pushMsg("user", text);
      const wrap = document.createElement("div");
      wrap.className = "msg ai";
      wrap.innerHTML = `<div class="msg-meta"><span class="nova-mark sm" aria-hidden="true"></span><span>${state.nickname}</span></div><div class="msg-body">🖥️ Laptop screenshot:<br><img src="${r.image}" alt="laptop screenshot" style="max-width:100%;border-radius:10px;margin-top:6px"></div>`;
      el.messages.appendChild(wrap);
      scrollBottom();
      pushMsg("assistant", "[laptop screenshot]");
      renderHistory();
      speak("Here is your laptop screen.");
      return true;
    }
    return say("⚠️ Laptop not reachable", "speak");
  }
  m = t.match(/^laptop\s+(?:notify|tell me)\s+(.+)$/i);
  if (m) {
    const r = await actOnLaptop("notify", m[1]);
    return say(r.ok ? `🔔 Windows toast sent: “${m[1]}”` : "⚠️ Laptop not reachable", "speak");
  }

  /* ——— Nova Agent v3: file management (sandboxed to your personal folders) ——— */
  m = t.match(/^create (?:a )?folder (?:called |named )?["']?(.+?)["']?(?: in (downloads|documents|desktop|pictures|videos|music))?$/i);
  if (m) {
    const name = m[1].trim().replace(/[\\/:*?"<>|]/g, "").trim();
    if (!name) return say("What should the folder be called?");
    const parent = m[2] ? m[2].charAt(0).toUpperCase() + m[2].slice(1) : "Desktop";
    const r = await runAgentAction("create_folder", `${parent}/${name}`);
    if (r.handled && r.result && r.result.ok) return say(`📁 **Folder created:** ${escHtml(name)} in ${parent}.` , "speak");
    return true; // failure path already reported by runAgentAction
  }
  m = t.match(/^rename\s+["']?(.+?)["']?\s+to\s+["']?(.+?)["']?$/i);
  if (m) {
    const to = m[2].trim().replace(/[\\/:*?"<>|]/g, "");
    const r = await runAgentAction("rename_file", { from: m[1].trim(), to });
    if (r.handled && r.result && r.result.ok) return say(`✏️ **Renamed to** ${escHtml(to)}.`, "speak");
    return true;
  }
  m = t.match(/^(?:move|copy)\s+["']?(.+?)["']?\s+to\s+["']?(.+?)["']?$/i);
  if (m) {
    const action = m[0].toLowerCase().startsWith("move") ? "move_file" : "copy_file";
    const r = await runAgentAction(action, { from: m[1].trim(), to: m[2].trim() });
    if (r.handled && r.result && r.result.ok) {
      logActivity(action, `${action === "move_file" ? "Moved" : "Copied"} ${m[1].trim()} → ${m[2].trim()}`, "completed");
      return say(`${action === "move_file" ? "📦 Moved" : "📄 Copied"} **${escHtml(m[1].trim())}** to **${escHtml(m[2].trim())}**.`, "speak");
    }
    return true;
  }
  m = t.match(/^(?:delete|trash|remove)\s+["']?(.+?)["']?$/i);
  if (m && !/^(temp|temporary|cache|junk)/i.test(m[1])) {
    const target = m[1].trim();
    const r = await runAgentAction("trash_path", target, { activitySummary: `Trashed ${target}` });
    if (r.needsConfirm) {
      openConfirm(`Move “${target}” to NovaTrash?`, `I'll move it to your NovaTrash folder — nothing is permanently deleted, and you can restore it yourself.`, "Move to trash", async () => {
        const res = await actOnLaptop("trash_path", target);
        if (res && res.ok) {
          logActivity("trash_path", `Trashed ${target}`, "completed");
          addBubble("ai", `🗑️ Moved “${escHtml(target)}” to **NovaTrash** — recoverable, nothing was erased permanently.`);
          speak("Moved to trash. You can restore it from the NovaTrash folder.");
        } else {
          logActivity("trash_path", `Trash ${target} failed`, "failed");
          const why = (res && res.error) ? escHtml(String(res.error).slice(0, 160)) : "the laptop didn't respond";
          addBubble("ai", `I couldn't move “${escHtml(target)}”: ${why}.`);
        }
        renderHistory();
      });
    }
    return true;
  }
  m = t.match(/^empty (?:the )?(?:nova ?)?trash$/i);
  if (m) {
    openConfirm("Empty NovaTrash permanently?", `Everything in your NovaTrash folder will be **permanently deleted**. This cannot be undone.`, "Empty trash", async () => {
      const res = await actOnLaptop("empty_trash", "");
      if (res && res.ok) {
        logActivity("empty_trash", `Emptied NovaTrash (${res.freedGb ?? "?"} GB)`, "completed");
        addBubble("ai", `🧹 NovaTrash emptied — **${res.freedGb ?? "?"} GB** permanently freed.`);
        speak("Trash emptied.");
      } else addBubble("ai", "I couldn't empty NovaTrash — is the laptop agent running?");
      renderHistory();
    });
    return true;
  }
  m = t.match(/^(?:show|open|list) (?:my |the )?(downloads|documents|desktop|pictures|videos|music)(?: folder)?$/i);
  if (m) {
    const folder = m[1].charAt(0).toUpperCase() + m[1].slice(1);
    const r = await runAgentAction("list_dir", folder);
    if (r.handled && r.result && r.result.ok) {
      const entries = r.result.entries || [];
      logActivity("list_dir", `Listed ${folder}`, "completed");
      const lines = entries.slice(0, 12).map((e) => `- ${e.type === "folder" ? "📁" : "📄"} ${e.name}${e.sizeMb != null ? ` (${e.sizeMb} MB)` : ""}`);
      return say(`📂 **${folder}:**\n${lines.join("\n")}${entries.length > 12 ? `\n_…and ${entries.length - 12} more._` : ""}`, "speak");
    }
    return true;
  }

  /* ——— Gaming Mode: real measurements first, confirmation before ANY change ——— */
  m = t.match(/^(?:boost (?:my )?laptop (?:for )?gaming|gaming mode|enable gaming mode|game mode)$/i);
  if (m) {
    const pre = await actOnLaptop("gaming_preview", "");
    if (!(pre && pre.ok)) {
      return say("⚠️ The Nova Agent isn't reachable — start it on the laptop with `python serve.py`, then try again.", "speak");
    }
    const bits = [];
    if (pre.currentScheme) bits.push(`Power mode: **${pre.currentScheme}**`);
    if (pre.freeRamGb) bits.push(`Free RAM: **${pre.freeRamGb} GB**`);
    if (pre.processes) bits.push(`Background processes: **${pre.processes}**`);
    if (pre.freeStorageGb != null) bits.push(`Free storage: **${pre.freeStorageGb} GB**`);
    openConfirm("Enable Gaming Mode?", `Current state:\n${bits.join("\n")}\n\nI'll switch the Windows power mode to **High Performance**. No processes will be closed and no other settings change.`, "Apply Gaming Mode", async () => {
      const r = await actOnLaptop("gaming_apply", "");
      if (r && r.ok) {
        logActivity("gaming_apply", `Gaming mode: power → ${r.after || "high performance"}`, "completed");
        addBubble("ai", `🎮 **Gaming Mode applied.**\nPower mode: ${escHtml(r.before || "?")} → **${escHtml(r.after || "?")}**\n\n_${r.note || "No processes were closed."} I won't promise FPS numbers — that depends on your game._`);
        speak("Gaming mode applied. Power mode is now high performance.");
      } else {
        logActivity("gaming_apply", "Gaming mode failed", "failed");
        addBubble("ai", "I couldn't apply Gaming Mode — the power setting didn't change. This can happen on managed/work laptops.");
      }
      renderHistory();
    });
    return true;
  }

  /* ——— Activity / action history ——— */
  m = t.match(/^(?:activity|action history|what did you do(?: today| recently)?|task history|my actions)$/i);
  if (m) {
    if (!state.activity.length) return say("📭 No actions yet. Ask me to open something, check the laptop, or clean temp files — everything I do will be logged here.");
    return say(`📋 **What I've done:**\n\n${activityToText()}`);
  }

  /* ——— Cross-device routing: “open X on my laptop” ——— */
  m = t.match(/^open\s+(.+?)\s+on (?:my )?laptop$/i);
  if (m) {
    const target = m[1].trim();
    const ping = await probeAgent();
    if (!agentOnline) {
      const task = addTask("open", `Open ${target} on laptop`, `act:open → ${target}`, "waiting");
      openConfirm(`Laptop is offline — queue “Open ${target}”?`, `Your laptop isn't reachable right now. I'll save this as a pending task${task.id ? ` (${task.id})` : ""} and it runs the next time the laptop agent connects. Nothing is pretended.`, "Queue task", () => {
        addBubble("ai", `📌 Queued: **Open ${escHtml(target)} on your laptop.** It will run when the agent is back online.`);
        speak("The laptop is offline. I've queued the task.");
        renderHistory();
      });
      return true;
    }
    const r = await actOnLaptop("open", target);
    if (r && r.ok) {
      logActivity("open", `Opened ${target} on laptop (from phone)`, "completed");
      return say(`✅ **${escHtml(target)}** is open on your laptop.`, "speak");
    }
    logActivity("open", `Open ${target} on laptop failed`, "failed");
    return say(`I couldn't open **${escHtml(target)}** on the laptop${r && r.error ? `: ${escHtml(String(r.error).slice(0, 120))}` : ""}.`);
  }

  return false; // not a command → send to AI
}

/* ---------------- Study specials: flashcards & quiz ---------------- */
async function callAIOnce(messages) {
  const { provider, model } = state;
  const apiKey = getKey();
  if (provider !== "pollinations" && provider !== "lite" && provider !== "ollama" &&
      !["tokenharbor", "groq", "openrouter", "cleanapis", "auto"].includes(provider) && !apiKey) throw new Error("NO_KEY");

  if (provider === "tokenharbor" || provider === "groq" || provider === "openrouter" || provider === "cleanapis" || provider === "auto") {
    // Server-relayed brains: keys live in Netlify env vars, never in the browser.
    const j = await fetch(apiUrl("/api/chat"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, model, messages, stream: false }),
    }).then((r) => r.json()).catch(() => null);
    if (!j || j.error) throw new Error((j && j.error) || "relay failed");
    if (j.fallbackUsed) toast(`Answered by ${j.actualProvider || "free fallback"} — ${provider} unavailable`, "warn");
    return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
  }
  if (provider === "pollinations") {
    const res = await fetch(apiUrl("/api/chat"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: model || "openai", messages, stream: false }),
    });
    if (!res.ok) throw new Error(await readErr(res));
    const j = await res.json();
    return j?.choices?.[0]?.message?.content || "";
  }

  if (provider === "ollama") {
    const res = await fetch("/api/ollama/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, stream: false }),
    });
    if (!res.ok) throw new Error(await readErr(res));
    const j = await res.json();
    return j?.choices?.[0]?.message?.content || "";
  }

  if (provider === "gemini") {
    const sys = messages.find((m) => m.role === "system")?.content || "";
    const contents = messages.filter((m) => m.role !== "system").map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents, systemInstruction: { parts: [{ text: sys }] } }) }
    );
    if (!res.ok) throw new Error(await readErr(res));
    const j = await res.json();
    return j?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  }

  const endpoint = provider === "openrouter"
    ? "https://openrouter.ai/api/v1/chat/completions"
    : provider === "tokenharbor"
    ? "https://tokenharbor.ai/v1/chat/completions"
    : provider === "groq"
    ? "https://api.groq.com/openai/v1/chat/completions"
    : provider === "bai"
    ? "https://api.b.ai/v1/chat/completions"
    : "https://api.openai.com/v1/chat/completions";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
  if (provider === "openrouter") { headers["HTTP-Referer"] = location.origin; headers["X-Title"] = "Nova AI Assistant"; }
  const res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ model, messages, stream: false }) });
  if (!res.ok) throw new Error(await readErr(res));
  const j = await res.json();
  return j?.choices?.[0]?.message?.content || "";
}

function parseCards(raw) {
  let s = String(raw).replace(/```json|```/g, "").trim();
  const start = s.indexOf("["), end = s.lastIndexOf("]");
  if (start === -1 || end === -1) return [];
  try {
    return JSON.parse(s.slice(start, end + 1))
      .filter((c) => c && c.q && c.a)
      .map((c) => ({ q: String(c.q), a: String(c.a) }))
      .slice(0, 12);
  } catch { return []; }
}

async function makeFlashcards(topic) {
  state.busy = true; setBusy(true); setStatus("generating flashcards…");
  pushMsg("user", `flashcards on ${topic}`);
  addBubble("user", `flashcards on ${topic}`);
  const bub = newBubbleStream();
  try {
    const raw = await callAIOnce([
      { role: "system", content: "You create study flashcards. Reply ONLY with a JSON array of 8 objects, each with keys \"q\" and \"a\". No markdown, no extra text." },
      { role: "user", content: `Make flashcards about: ${topic}` },
    ]);
    const cards = parseCards(raw);
    if (!cards.length) throw new Error("Couldn't parse flashcards — try again");
    state.cards[norm(topic)] = cards;
    saveAll();
    bub.closest(".msg").remove();
    pushMsg("assistant", `🃏 Saved ${cards.length} flashcards on ${topic}.`);
    addBubble("assistant", `🃏 **${cards.length} flashcards on ${topic}** saved ✅\n_Tap a card to reveal the answer. Review anytime with \`review flashcards ${topic}\` — works offline._`, false);
    renderTappable(cards);
    renderHistory();
  } catch (err) {
    bub.closest(".msg").remove();
    const msg = err.message === "NO_KEY"
      ? "🔑 Flashcards need a real AI key. **FREE:** aistudio.google.com/apikey → ⚙️ Settings → paste → Save. (Nova Lite can still *review* saved decks offline.)"
      : `⚠️ ${err.message}`;
    addBubble("assistant", msg);
    pushMsg("assistant", msg);
  } finally {
    state.busy = false; setBusy(false); setStatus("");
  }
}

async function makeQuiz(topic) {
  state.busy = true; setBusy(true); setStatus("preparing quiz…");
  pushMsg("user", `quiz me on ${topic}`);
  addBubble("user", `quiz me on ${topic}`);
  const bub = newBubbleStream();
  try {
    const raw = await callAIOnce([
      { role: "system", content: "You are a quiz master. Reply ONLY with a JSON array of 5 objects, each with keys \"q\" (question) and \"a\" (short correct answer). Mix difficulty. No markdown, no extra text." },
      { role: "user", content: `Quiz me on: ${topic}` },
    ]);
    const cards = parseCards(raw);
    if (!cards.length) throw new Error("Couldn't build the quiz — try again");
    bub.closest(".msg").remove();
    pushMsg("assistant", `❓ Quiz on ${topic}: ${cards.length} questions.`);
    addBubble("assistant", `❓ **Quiz: ${topic}** — ${cards.length} questions\n_Try answering out loud, then tap a question to check._`, false);
    renderTappable(cards);
    renderHistory();
  } catch (err) {
    bub.closest(".msg").remove();
    const msg = err.message === "NO_KEY"
      ? "🔑 Quizzes need a real AI key. **FREE:** aistudio.google.com/apikey → ⚙️ Settings → paste → Save."
      : `⚠️ ${err.message}`;
    addBubble("assistant", msg);
    pushMsg("assistant", msg);
  } finally {
    state.busy = false; setBusy(false); setStatus("");
  }
}

function renderTappable(cards) {
  cards.forEach((c, idx) => {
    const row = document.createElement("div");
    row.className = "msg ai";
    row.innerHTML = `<div class="msg-meta"><span class="nova-mark sm" aria-hidden="true"></span><span>Flashcards</span></div><div class="msg-body"><b>Q${idx + 1}.</b> ${renderMd(c.q)}<br><span class="reveal">_tap to reveal_</span></div>`;
    const b = row.querySelector(".msg-body");
    b.style.cursor = "pointer";
    b.title = "Tap to reveal";
    b.onclick = () => {
      b.onclick = null;
      b.innerHTML = `<b>Q${idx + 1}.</b> ${renderMd(c.q)}<br><b>A:</b> ${renderMd(c.a)}`;
      speakNow(`Answer: ${c.a}`);
      scrollBottom();
    };
    el.messages.appendChild(row);
  });
  scrollBottom();
}

/* ---------------- Attachments: files, photos, camera, folders, docx ---------------- */
const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8 MB per file

function readFileAs(file, how) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error("read failed"));
    if (how === "dataurl") r.readAsDataURL(file);
    else r.readAsText(file);
  });
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/* Minimal ZIP reader (stored + deflate via DecompressionStream) for .docx. */
async function unzipTextEntries(buf, wantedExts) {
  const dv = new DataView(buf);
  let eof = -1;
  for (let i = buf.byteLength - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eof = i; break; }
  }
  if (eof < 0) return [];
  const count = dv.getUint16(eof + 10, true);
  let p = dv.getUint32(eof + 16, true);
  const dec = new TextDecoder();
  const out = [];
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commLen = dv.getUint16(p + 32, true);
    const lfhOff = dv.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(buf, p + 46, nameLen));
    p += 46 + nameLen + extraLen + commLen;
    if (!wantedExts.some((e) => name.toLowerCase().endsWith(e))) continue;
    const lh = lfhOff;
    const lNameLen = dv.getUint16(lh + 26, true);
    const lExtraLen = dv.getUint16(lh + 28, true);
    const dataStart = lh + 30 + lNameLen + lExtraLen;
    const raw = new Uint8Array(buf, dataStart, compSize);
    try {
      let bytes;
      if (method === 0) bytes = raw;
      else if (method === 8) bytes = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
      else continue;
      out.push({ name, text: dec.decode(bytes) });
      if (out.length >= 12) break;
    } catch { /* skip entry */ }
  }
  return out;
}

function stripXml(xml) {
  return xml
    .replace(/<w:p\b[^>]*>/g, "\n")
    .replace(/<w:tab\b[^>]*\/>/g, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function fileKind(f) {
  const n = f.name.toLowerCase();
  if (f.type.startsWith("image/")) return "image";
  if (n.endsWith(".pdf") || f.type === "application/pdf") return "pdf";
  if (n.endsWith(".docx")) return "docx";
  if (n.endsWith(".doc")) return "doc";
  if (n.endsWith(".pptx") || n.endsWith(".xlsx")) return "office";
  return "text";
}

async function fileToAttachment(f) {
  const kind = fileKind(f);
  if (f.size > MAX_FILE_BYTES) {
    toast(`"${f.name}" is too big (max 8 MB)`, "warn");
    return null;
  }
  const att = { name: f.name, size: f.size, kind };
  try {
    if (kind === "image") {
      const dataUrl = await readFileAs(f, "dataurl");
      att.dataBase64 = dataUrl.split(",")[1];
      att.mime = f.type || "image/png";
    } else if (kind === "docx") {
      const entries = await unzipTextEntries(await f.arrayBuffer(), ["word/document.xml", "word/footnotes.xml"]);
      const text = entries.map((e) => stripXml(e.text)).join("\n\n");
      if (!text) throw 0;
      att.textContent = text.slice(0, 120000);
    } else if (kind === "pdf") {
      att.textContent = `[PDF document: ${f.name} — ${Math.ceil(f.size / 1024)} KB. Ask about its contents in Gemini; text extraction is limited in-app.]`;
    } else if (kind === "doc" || kind === "office") {
      att.textContent = `[Legacy Office file: ${f.name}. Tip: save as .docx or .txt for full text reading.]`;
    } else {
      att.textContent = (await readFileAs(f, "text")).slice(0, 120000);
    }
    return att;
  } catch {
    toast(`Couldn't read "${f.name}"`, "warn");
    return null;
  }
}

function renderAttachments() {
  el.attachTray.innerHTML = "";
  el.attachTray.classList.toggle("hidden", !state.pendingFiles.length);
  for (const a of state.pendingFiles) {
    const chip = document.createElement("div");
    chip.className = "attach-chip";
    const icon = a.kind === "image" ? "🖼️" : a.kind === "docx" || a.kind === "doc" || a.kind === "office" ? "📘" : a.kind === "pdf" ? "📕" : "📄";
    chip.innerHTML = `<span class="chip-ic">${icon}</span><span class="chip-name">${a.name}</span><span class="chip-size">${a.size > 1048576 ? (a.size / 1048576).toFixed(1) + " MB" : Math.ceil(a.size / 1024) + " KB"}</span>`;
    const x = document.createElement("button");
    x.className = "chip-x";
    x.textContent = "✕";
    x.onclick = () => {
      state.pendingFiles = state.pendingFiles.filter((p) => p !== a);
      renderAttachments();
    };
    chip.appendChild(x);
    el.attachTray.appendChild(chip);
  }
}

async function addFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  if (files.length > 6) toast("Reading the first 6 files…", "warn");
  for (const f of files.slice(0, 6)) {
    const att = await fileToAttachment(f);
    if (att) state.pendingFiles.push(att);
  }
  renderAttachments();
  el.input.focus();
}

function clearAttachments() {
  state.pendingFiles = [];
  renderAttachments();
}

function attachBrainContext(files) {
  if (!files.length) return "";
  const lines = files.map((a) => {
    if (a.kind === "image") return `- image: ${a.name}`;
    if (a.textContent) return `- file: ${a.name} (contents below)\n--- BEGIN ${a.name} ---\n${a.textContent}\n--- END ${a.name} ---`;
    return `- file: ${a.name}`;
  });
  return `The user attached these files:\n${lines.join("\n")}\n\nUser message: `;
}

/* ---------------- Home screen ---------------- */
function homeGreeting() {
  const h = new Date().getHours();
  const part = h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : h < 22 ? "Good evening" : "Working late";
  return state.profile.name ? `${part}, ${state.profile.name}` : part;
}
/* UI state machine: EMPTY (search-first) → SUBMITTING → CONVERSATION.
   One composer element lives in two positions; uiMode is the single
   source of truth for which position — never CSS-hack detection. */
let uiMode = "EMPTY";   // EMPTY | SUBMITTING | CONVERSATION
function setUiMode(m) {
  uiMode = m;
  document.body.dataset.ui = m === "CONVERSATION" ? "chat" : "home";
}

function showHome() {
  setUiMode("EMPTY");
  el.messages.classList.add("hidden");
  el.home.classList.remove("hidden");
  el.homeSlot.appendChild(el.composer);
  const greet = $("#home-greet");
  if (greet) greet.textContent = homeGreeting();
  requestAnimationFrame(() => {
    el.home.classList.add("in");
    replayKineticHeadline();
    el.input.focus();
  });
}

/* The dock: same composer, two homes. When the first query is submitted the
   centered search box physically travels down to the bottom composer slot —
   one FLIP-animated transform, 380ms, no teleport, no second component. */
function dockComposer() {
  if (uiMode === "CONVERSATION") return;
  setUiMode("SUBMITTING");
  const c = el.composer, home = el.home;
  const from = c.getBoundingClientRect();
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;";
  c.parentNode.insertBefore(probe, c);
  el.messages.after(c);                       // final docked position
  const to = c.getBoundingClientRect();
  c.style.transform = `translate(0px, ${from.top - to.top}px)`;
  c.style.transition = "none";
  probe.remove();
  home.classList.add("leaving");
  requestAnimationFrame(() => {
    c.style.transition = "transform 380ms cubic-bezier(.32,.72,.24,1), opacity 380ms ease";
    c.style.transform = "";
    c.style.opacity = "1";
    setTimeout(() => {
      c.style.transition = ""; c.style.transform = ""; c.style.opacity = "";
      home.classList.add("hidden");
      home.classList.remove("in", "leaving");
      el.messages.classList.remove("hidden");
      setUiMode("CONVERSATION");
      scrollBottom();
    }, 390);
  });
}
function hideHome() { dockComposer(); }

function isHome() { return !el.home.classList.contains("hidden"); }

const CHIP_HINTS = {
  write: { fill: "", placeholder: "What should I help you write? An essay, email, story…" },
  learn: { fill: "explain ", placeholder: "" },
  image: { fill: "", placeholder: "Attach an image with 📎, then ask me anything about it", attach: true },
  summarize: { fill: "summarize ", placeholder: "" },
  more: null,
};

function handleChip(kind) {
  if (kind === "more") { toast("Try: quiz me on … · flashcards on … · open youtube · note …"); return; }
  const c = CHIP_HINTS[kind];
  if (!c) return;
  if (c.attach) { el.fileImg.click(); return; }
  el.input.value = c.fill;
  if (c.placeholder) el.input.placeholder = c.placeholder;
  el.input.focus();
  autosize();
}

/* ---------------- Send flow ---------------- */
/* Nova state machine: drives the background vortex + voice overlay phases.
   No telemetry — the state itself is communicated through the background. */
const brandEl = document.getElementById("brand");

let hudState = "idle";
function setHudState(s) {
  if (s === hudState) return;
  hudState = s;
  if (window.NovaFX) {
    if (s === "listening" || s === "speaking" || s === "processing" || s === "idle") window.NovaFX.state(s);
    else window.NovaFX.state("idle");
  }
}

/* Speaking state: pulse the reactor + ripples while TTS talks. */
(function wrapSpeak() {
  if (typeof speak !== "function") return;
  const orig = speak;
  speak = function (text) {
    if (state.autospeak || voiceChat) setHudState("speaking");
    return orig(text);
  };
})();

(function wrapSpeakNow() {
  if (typeof speakNow !== "function") return;
  const orig = speakNow;
  speakNow = function (text) {
    setHudState("speaking");
    return orig(text);
  };
})();

/* Processing state around every AI call; back to idle when done. */
(function wrapSetBusy() {
  if (typeof setBusy !== "function") return;
  const orig = setBusy;
  setBusy = function (on) {
    if (on) setHudState("processing");
    else if (hudState === "processing") setHudState(state.speaking ? "speaking" : "idle");
    return orig(on);
  };
})();

/* While listening (any mic mode), feed live mic level into the vortex. */
(function wrapStartWave() {
  if (typeof startWave !== "function") return;
  const orig = startWave;
  startWave = async function () {
    setHudState("listening");
    return orig();
  };
})();
(function wrapStopWave() {
  if (typeof stopWave !== "function") return;
  const orig = stopWave;
  stopWave = function () {
    if (hudState === "listening") setHudState("idle");
    return orig();
  };
})();

/* ═══════ Motion: only what carries meaning (V2) ═══════
   Magnetic buttons, cursor spotlight and scroll-blur reveals were removed:
   decoration, not orientation or feedback. The background vortex + message
   transitions carry the product's life. */
const isTouch = matchMedia("(hover: none), (pointer: coarse)").matches;

/* V2: scroll-reveal observer retired with the reveal effects it fed. */

/* Home screen greeting — quiet by design, no re-animation needed. */
function replayKineticHeadline() { /* retired with the kinetic headline */ }

/* ═══════ NOVA VOICE — mic-activated assistant experience ═══════
   Clicking the mic opens a focused voice layer. Every state shown maps to a
   real operation: preparing → listening → understanding → working → done.
   The canvas is a quiet Nova-star ring that reacts to actual mic amplitude. */
let jarvisOverlayOpen = false;
let jarvisRAF = 0;
const jEl = {};
const j$ = (id) => document.getElementById(id);

let vizLevel = 0;                 // smoothed live mic amplitude 0..1
let vizTarget = 0;

/* ═════════ NOVA CORE — original identity, not a star/orb ═════════
   A precision instrument: a segmented intelligence nucleus with a dial
   of rotating arcs, three tilted orbital rings with traveling nodes, a
   fine tick ring driven by REAL microphone frequencies, orbiting dust,
   and a radar sweep while real work (THINKING/EXECUTING) is happening.
   SPEAKING pulses come from real TTS word-boundary events (corePulse).
   Silence calms everything down. One canvas, zero ctx.shadowBlur —
   gradient glow only, so it stays cheap on CPU/GPU. */
let vizState = "IDLE";
let corePulseV = 0;
function corePulse(strength = 0.5) { corePulseV = Math.min(1, corePulseV + strength); }
function wireTTSPulse(u) {
  u.onboundary = () => corePulse(0.45);   // REAL word events from the speech engine
}

function startVoiceViz() {
  const cv = jEl.viz;
  if (!cv) return;
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  const freq = new Uint8Array(64);
  const TICKS = 96, PARTS = 26;
  const parts = Array.from({ length: PARTS }, (_, i) => ({
    r: 0.34 + (i % 7) * 0.055, a: Math.random() * Math.PI * 2,
    v: (0.0016 + (i % 5) * 0.0009) * (i % 2 ? 1 : -1), s: 0.9 + (i % 4) * 0.5,
  }));
  const node = { a1: 0, v1: 0.011, a2: Math.PI, v2: -0.007 };
  let sweep = 0, level = 0, phase = 0;

  const size = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const css = cv.clientWidth || 320;
    const px = Math.floor(css * dpr);
    if (Math.abs(cv.width - px) > 2) { cv.width = px; cv.height = px; }
  };

  const draw = (now) => {
    jarvisRAF = requestAnimationFrame(draw);
    size();
    const W = cv.width, H = cv.height;
    if (!W) return;
    const C = W / 2, R = W * 0.5;
    const t = now / 1000;
    const busy = vizState === "PROCESSING" || vizState === "THINKING" || vizState === "EXECUTING";
    const speaking = vizState === "SPEAKING";
    const listening = vizState === "LISTENING";
    const error = vizState === "ERROR";

    // REAL mic frequencies only while the mic is actually open + listening.
    if (waveAnalyser && listening) {
      waveAnalyser.getByteFrequencyData(freq);
      let sum = 0;
      for (let i = 2; i < 40; i++) sum += freq[i];
      vizTarget = Math.min(1, (sum / 38) / 110);
    } else vizTarget = 0;
    level += (vizTarget - level) * 0.14;

    ctx.clearRect(0, 0, W, H);
    const hue = error ? 18 : 210, sat = error ? 68 : 90;
    phase += 0.006 + (busy ? 0.012 : 0) + level * 0.01;

    // 1) deep atmosphere (radial, state-tinted)
    const atmo = ctx.createRadialGradient(C, C, 0, C, C, R);
    atmo.addColorStop(0, `hsla(${hue},${sat}%,72%,${(0.14 + level * 0.14 + corePulseV * 0.12).toFixed(3)})`);
    atmo.addColorStop(0.45, `hsla(${hue},${sat}%,60%,${(0.05 + level * 0.05).toFixed(3)})`);
    atmo.addColorStop(1, "hsla(220,60%,50%,0)");
    ctx.fillStyle = atmo;
    ctx.fillRect(0, 0, W, H);

    // 2) three tilted orbital rings — thin, layered depth
    const rings = [
      { tilt: 0.34, rot: 0.5 + Math.sin(t * 0.11) * 0.05, rad: 0.44, alpha: 0.30 },
      { tilt: 0.62, rot: -0.9 - Math.sin(t * 0.09) * 0.04, rad: 0.36, alpha: 0.22 },
      { tilt: 0.22, rot: 2.1 + t * 0.02, rad: 0.50, alpha: 0.16 },
    ];
    ctx.lineWidth = Math.max(1, W * 0.0022);
    for (const rg of rings) {
      ctx.save();
      ctx.translate(C, C);
      ctx.rotate(rg.rot);
      ctx.strokeStyle = `hsla(${hue},${sat}%,75%,${rg.alpha})`;
      ctx.beginPath();
      ctx.ellipse(0, 0, R * rg.rad, R * rg.rad * rg.tilt, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    // traveling nodes on rings 1-2 — the system's real activity level
    node.a1 += node.v1 * (busy ? 2.2 : 1) * (1 + level * 0.8);
    node.a2 += node.v2 * (busy ? 1.8 : 1);
    for (const [rg, ang] of [[rings[0], node.a1], [rings[1], node.a2]]) {
      const rx = R * rg.rad, ry = rx * rg.tilt;
      const x = C + Math.cos(ang) * rx * Math.cos(rg.rot) - Math.sin(ang) * ry * Math.sin(rg.rot);
      const y = C + Math.cos(ang) * rx * Math.sin(rg.rot) + Math.sin(ang) * ry * Math.cos(rg.rot);
      const gl = ctx.createRadialGradient(x, y, 0, x, y, W * 0.02);
      gl.addColorStop(0, `hsla(${hue},${sat}%,85%,0.9)`);
      gl.addColorStop(1, `hsla(${hue},${sat}%,70%,0)`);
      ctx.fillStyle = gl;
      ctx.beginPath(); ctx.arc(x, y, W * 0.02, 0, Math.PI * 2); ctx.fill();
    }

    // 3) fine audio-reactive tick ring (REAL frequencies while listening)
    const baseR = R * 0.26;
    ctx.lineWidth = Math.max(1, W * 0.0028);
    for (let i = 0; i < TICKS; i++) {
      const v = listening ? freq[2 + Math.floor((i / TICKS) * 56)] / 255 : 0;
      const shimmer = speaking ? (0.5 + 0.5 * Math.sin(i * 0.7 + t * 6)) * (0.2 + corePulseV) : 0;
      const idle = 0.05 + 0.03 * Math.sin(i * 0.35 + t * 1.2);
      const amp = listening ? Math.max(v, idle) : Math.max(idle, shimmer);
      const a = (i / TICKS) * Math.PI * 2 + phase * 0.5;
      const r1 = baseR + R * 0.035;
      const r2 = r1 + R * (0.012 + amp * 0.075);
      ctx.strokeStyle = `hsla(${hue},${sat}%,${68 + amp * 22 | 0}%,${(0.22 + amp * 0.6).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(C + Math.cos(a) * r1, C + Math.sin(a) * r1);
      ctx.lineTo(C + Math.cos(a) * r2, C + Math.sin(a) * r2);
      ctx.stroke();
    }

    // 4) the intelligence nucleus: glow + crisp core + segmented dial arcs
    const nucR = R * (0.155 + level * 0.02 + corePulseV * 0.03 + Math.sin(t * 1.4) * 0.006);
    const g = ctx.createRadialGradient(C, C, 0, C, C, nucR * 2.1);
    g.addColorStop(0, `hsla(${hue},${sat}%,88%,0.95)`);
    g.addColorStop(0.35, `hsla(${hue},${sat}%,70%,0.55)`);
    g.addColorStop(1, `hsla(${hue},${sat}%,60%,0)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(C, C, nucR * 2.1, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = `hsla(${hue},${sat}%,92%,0.95)`;
    ctx.beginPath(); ctx.arc(C, C, nucR * 0.52, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = Math.max(1.2, W * 0.004);
    for (let k = 0; k < 3; k++) {
      const a0 = phase * (k % 2 ? -1 : 1) * (1 + k * 0.3) + k * 2.09;
      ctx.strokeStyle = `hsla(${hue},${sat}%,80%,${0.5 - k * 0.1})`;
      ctx.beginPath(); ctx.arc(C, C, nucR * (1.25 + k * 0.16), a0, a0 + 1.5); ctx.stroke();
    }
    ctx.lineWidth = Math.max(1, W * 0.002);
    ctx.strokeStyle = `hsla(${hue},${sat}%,78%,0.35)`;
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2 + phase * 0.25;
      const r1 = nucR * 1.75, r2 = r1 + R * 0.014;
      ctx.beginPath();
      ctx.moveTo(C + Math.cos(a) * r1, C + Math.sin(a) * r1);
      ctx.lineTo(C + Math.cos(a) * r2, C + Math.sin(a) * r2);
      ctx.stroke();
    }

    // 5) radar sweep ONLY while real work runs (never a fake spinner)
    if (busy) {
      sweep += 0.02;
      ctx.lineWidth = Math.max(1, W * 0.004);
      for (let k = 0; k < 10; k++) {
        const a = sweep - k * 0.05;
        ctx.strokeStyle = `hsla(${hue},${sat}%,70%,${(0.16 * (1 - k / 10)).toFixed(3)})`;
        ctx.beginPath(); ctx.arc(C, C, R * 0.58, a, a + 0.06); ctx.stroke();
      }
    }

    // 6) orbiting dust (slightly squashed vertical = depth)
    ctx.fillStyle = `hsla(${hue},${sat}%,80%,${(0.25 + level * 0.4).toFixed(3)})`;
    for (const pt of parts) {
      pt.a += pt.v * (busy ? 2 : 1) * (1 + level * 1.5);
      const x = C + Math.cos(pt.a) * R * pt.r;
      const y = C + Math.sin(pt.a) * R * pt.r * 0.86;
      ctx.beginPath(); ctx.arc(x, y, pt.s * (W * 0.003), 0, Math.PI * 2); ctx.fill();
    }

    corePulseV *= 0.94; if (corePulseV < 0.01) corePulseV = 0;
  };
  jarvisRAF = requestAnimationFrame(draw);
}

function setVoicePhase(txt) {
  if (jEl.state) jEl.state.textContent = txt;
}
function setHeard(txt) {
  if (jEl.heard) jEl.heard.textContent = txt || "";
}

/* ═══════════════════════════════════════════════════════════════════
   VOICE SESSION STATE MACHINE — single source of truth for mic, TTS
   and voice-session lifecycle.

     IDLE → OPENING → REQUESTING_MIC → LISTENING → PROCESSING
          → THINKING → EXECUTING → SPEAKING → COOLDOWN → LISTENING | IDLE

   THE ONE RULE:  SPEAKING ≠ LISTENING.
   While TTS plays, the recognizer is fully STOPPED (not ignored —
   stopped), the raw mic stream is gated, and all buffers are flushed.
   Listening resumes only from the REAL speechSynthesis `onend` event,
   after a short cooldown, in a brand-new recognition session.
   Every session owns a monotonic id: callbacks from older sessions
   are dropped (`vStale`), so echo/repeat can never re-enter.
   ═══════════════════════════════════════════════════════════════════ */
const VoiceFSM = {
  phase: "IDLE",
  session: 1,              // increments on every session start/teardown
  ttsActive: false,        // a TTS utterance is currently playing (or queued)
  cooldownMs: 450,         // settle time after real TTS end before mic re-opens
  lastCommand: { text: "", ts: 0 },   // duplicate-command guard
};
const VOICE_LABELS = {
  IDLE: "", OPENING: "Preparing…", REQUESTING_MIC: "Requesting microphone…",
  LISTENING: "Listening…", PROCESSING: "Understanding…", THINKING: "Thinking…",
  EXECUTING: "Working…", SPEAKING: "Speaking…", COOLDOWN: "One moment…",
  COMPLETED: "Done", ERROR: "Something went wrong",
};
function voicePhase(p) {
  VoiceFSM.phase = p;
  vizState = p;                              // NOVA Core reads this every frame
  setVoicePhase(VOICE_LABELS[p] || p);
  setHudState(p === "LISTENING" ? "listening"
    : p === "SPEAKING" ? "speaking"
    : (p === "PROCESSING" || p === "THINKING" || p === "EXECUTING") ? "processing"
    : "idle");
  // ONE visual state system: background reacts to the same real state.
  if (window.NovaFX) {
    if (p === "LISTENING") NovaFX.state("listening");
    else if (p === "PROCESSING" || p === "THINKING" || p === "EXECUTING") NovaFX.state("processing");
    else if (p === "SPEAKING") NovaFX.state("speaking");
    else if (p === "ERROR") NovaFX.state("error");
    else NovaFX.state("idle");
  }
}
function vSession() { return VoiceFSM.session; }
function vStale(s) { return s !== VoiceFSM.session; }
function vNextSession() { return ++VoiceFSM.session; }   // closes every old session

/* JARVIS overlay state hook (dataset for CSS, sub-text for the human). */
function setVoiceState(s, sub) {
  const ov = jEl.overlay || document.getElementById("jarvis");
  if (ov) ov.dataset.state = s;
  if (sub) setHeard(sub);
}

/* ---- Recognition lifecycle: exactly ONE recognizer may ever exist ---- */
let recogActive = false;
function stopRecog() {
  if (recog) {
    const r = recog;
    recog = null;
    r.onresult = null; r.onend = null; r.onerror = null; r.onspeechstart = null;
    try { r.abort(); } catch { try { r.stop(); } catch { /* already dead */ } }
  }
  recogActive = false;
}
function flushVoiceBuffers() {
  /* Per-session closures die with the recognizer; drop the shared bits too. */
  recog = null;
  VoiceFSM.pendingCommand = "";
}

/* Real-TTS-end driven re-arm: TTS finished → cooldown → flush → LISTENING. */
function ttsCooldownRearm() {
  const s = vNextSession();          // kill every callback from the spoken era
  stopRecog();
  voicePhase("COOLDOWN");
  setTimeout(() => {
    if (vStale(s) || VoiceFSM.ttsActive) return;      // new TTS began meanwhile
    micGate(true);
    flushVoiceBuffers();
    if (voiceChat && !state.busy) {
      voicePhase("LISTENING");
      listenOnce();
    } else if (state.listening) {
      voicePhase("LISTENING");
      restartHandsFreeRecog();
    } else {
      voicePhase("IDLE");
      micGate(false);
    }
  }, VoiceFSM.cooldownMs);
}

/* Duplicate-command protection: the same transcript delivered twice
   (double recognition events, echo, retries) executes once. */
function voiceCommandDuplicate(text) {
  const t = (text || "").trim().toLowerCase();
  if (!t) return false;
  if (t === VoiceFSM.lastCommand.text && Date.now() - VoiceFSM.lastCommand.ts < 4000) return true;
  VoiceFSM.lastCommand = { text: t, ts: Date.now() };
  return false;
}

/* Barge-in: explicit user tap on the voice overlay stops TTS instantly
   and opens a clean listening session. Noise never interrupts Nova. */
function userBargeIn() {
  if (!VoiceFSM.ttsActive && !state.speaking) return;
  try { speechSynthesis.cancel(); } catch { /* nothing playing */ }
  VoiceFSM.ttsActive = false;
  state.speaking = false;
  toast("Interrupted", "ok");
  ttsCooldownRearm();
}

/* Manual mic owns the microphone while its session lasts. Hands-free yields
   it (and is handed back on close) — one microphone, one owner, always. */
let handsFreeYielded = false;
function yieldHandsFreeForManual() {
  if (!state.listening) { handsFreeYielded = false; return; }
  handsFreeYielded = true;       // remember it so the wake loop can be restored
  stopListening();               // single choke point: banner + recognizer + wake lock
  voicePhase("OPENING");
}
function resumeHandsFreeIfYielded() {
  if (!handsFreeYielded) return;
  handsFreeYielded = false;
  if (state.handsFree && !state.listening && !voiceChat) {
    try { toggleHandsFree(); } catch { /* needs SR/permission */ }
  }
}

async function openJarvis() {
  // Re-entry: a second tap re-arms the live session instead of stacking a
  // second overlay/session on top of the first.
  if (jarvisOverlayOpen && voiceChat) {
    if (!recogActive) { voicePhase("LISTENING"); listenOnce(); }
    return;
  }
  // Hands-free must hand the microphone over before we request it ourselves.
  yieldHandsFreeForManual();
  jEl.overlay = jEl.overlay || j$("jarvis");
  jEl.viz = jEl.viz || j$("jarvis-viz");
  jEl.state = jEl.state || j$("jarvis-state");
  jEl.heard = jEl.heard || j$("jarvis-heard");
  jEl.exit = jEl.exit || j$("jarvis-exit");

  jarvisOverlayOpen = true;
  document.body.classList.add("voice-open");   // chat recedes, background deepens
  vNextSession();                    // fresh session; any old callbacks die
  jEl.overlay.classList.remove("hidden");
  requestAnimationFrame(() => jEl.overlay.classList.add("open"));
  voicePhase("OPENING");
  setHeard("");
  startVoiceViz();

  // Real mic first — never show "Listening" without one.
  voicePhase("REQUESTING_MIC");
  try {
    await ensureMic();
  } catch (err) {
    const name = err && err.name;
    if (name === "NotAllowedError" || name === "SecurityError") {
      setVoicePhase("Microphone blocked");
      setHeard("Allow the microphone in your browser's address bar, then try again.");
    } else if (name === "NotFoundError") {
      setVoicePhase("No microphone");
      setHeard("This device doesn't have a microphone Nova can use.");
    } else {
      setVoicePhase("Microphone unavailable");
      setHeard("Try reloading the page.");
    }
    setVoiceState("mic-error");
    return;
  }
  micGate(true);

  voicePhase("LISTENING");
  setVoiceState("listening");
  startVoiceChatInJarvis();
}

function closeJarvis() {
  jarvisOverlayOpen = false;
  document.body.classList.remove("voice-open");
  jEl.overlay.classList.remove("open");
  setTimeout(() => jEl.overlay.classList.add("hidden"), 320);
  cancelAnimationFrame(jarvisRAF);
  vNextSession();                    // orphan every pending voice callback
  stopRecog();
  endVoiceChat("Voice closed");
  try { speechSynthesis.cancel(); } catch { /* nothing playing */ }
  VoiceFSM.ttsActive = false;
  state.speaking = false;
  micGate(false);
  voicePhase("IDLE");
  setVoiceState("idle");
  resumeHandsFreeIfYielded();
}

/* The existing voice loop runs inside the overlay; mirror its phases. */
/* The existing voice loop runs inside the overlay; mirror its phases. */
function startVoiceChatInJarvis() {
  if (!SR && !NATIVE_BRIDGE) {
    setVoicePhase("Voice not available here");
    setHeard("Nova voice needs Chrome, Edge, or the Nova Android app.");
    return;
  }
  if (!voiceChat) { voiceChat = true; el.mic.classList.add("listening"); listenOnce(); }
  // Phases mirror into the voice layer through the setWaveText router —
  // no function monkey-patching, no second interface, one controller.
}

/* Mic level → vortex listening pulse (when the analyser is live). */
setInterval(() => {
  if (waveAnalyser && (voiceChat || state.listening)) {
    const d = new Uint8Array(waveAnalyser.frequencyBinCount);
    waveAnalyser.getByteFrequencyData(d);
    let sum = 0; for (const v of d) sum += v;
    const level = Math.min(1, (sum / d.length) / 140);
    if (window.NovaFX) window.NovaFX.level(level);
  }
}, 90);

function setBusy(on) {
  state.busy = on;
  el.send.disabled = on;
  el.send.classList.toggle("busy", on);
  if (on) {
    if (!el.send.querySelector("span")) el.send.innerHTML = `<span>${el.send.dataset.icon}</span>`;
  } else if (el.send.querySelector("span")) {
    el.send.innerHTML = el.send.dataset.icon;
  }
}

function newBubbleStream() {
  const wrap = document.createElement("div");
  wrap.className = "msg ai thinking";
  wrap.setAttribute("role", "listitem");
  wrap.innerHTML = `<div class="msg-meta"><span class="nova-mark sm" aria-hidden="true"></span><span>${state.nickname}</span></div><div class="msg-body"><span class="typing"><i></i><i></i><i></i></span></div>`;
  el.messages.appendChild(wrap);
  scrollBottom();
  return wrap.querySelector(".msg-body");
}

async function handleSend(text, opts = {}) {
  text = (text || "").trim();
  if ((!text && !state.pendingFiles.length) || state.busy) return;

  hideHome();
  el.messages.querySelector(".msg.sys")?.remove(); // drop stale welcome bubble

  if (await tryCommand(text)) { el.input.value = ""; autosize(); return; }

  let mStudy = text.match(/^flashcards?\s+on\s+(.+)$/i);
  if (mStudy) { await makeFlashcards(mStudy[1].trim()); return; }
  mStudy = text.match(/^quiz\s+me\s+on\s+(.+)$/i);
  if (mStudy) { await makeQuiz(mStudy[1].trim()); return; }

  const files = state.pendingFiles;
  if (files.length && !text) text = "What's in the attached file(s)? Explain simply.";
  state.busy = true;
  setBusy(true);
  celebrateFromSend();
  if (!opts.fromQueue) pushMsg("user", files.length ? text + `\n📎 ${files.map((f) => f.name).join(", ")}` : text);
  addBubble("user", files.length ? `${text}\n\n📎 ${files.map((f) => f.name).join(" · ")}` : text);
  clearAttachments();

  // Lite provider (or no key for a keyed provider)? Use the built-in Nova Lite brain.
  if (state.provider === "lite") {
    setStatus("Nova Lite (no key set)…");
    const bub = newBubbleStream();
    const reply = novaLiteReply(text);
    streamLite(bub, reply);
    setTimeout(() => {
      bub.closest(".msg").remove();
      pushMsg("assistant", reply);
      addBubble("assistant", reply, false);
      speak(reply);
      setStatus("");
      state.busy = false; setBusy(false);
      renderHistory();
    }, Math.min(2500, reply.length * 12 + 400));
    return;
  }
  el.input.value = ""; autosize();
  setStatus("thinking…");
  const bub = newBubbleStream();

  const chat = currentChat();
  if (!navigator.onLine) {
    // queue for later
    state.queued.push({ chatId: chat.id, text, ts: Date.now() });
    saveAll();
    updateQueueInfo();
    bub.innerHTML = renderMd(`📡 You're offline — saved to the queue. I'll send it automatically when you're back online.\n\n_Try offline skills: \`note …\`, \`notes\`, \`open …\`, \`calculate …\`, \`help\`._`);
    setStatus("");
    state.busy = false; setBusy(false);
    return;
  }

  let full = "";
  try {
    await callAI(buildApiMessages(chat, files), (piece) => {
      full += piece;
      renderStream(bub, full);
    });
    if (!full) full = "_(empty response — try another model)_";
    // Pop the typing bubble, then finalize with a landing celebration
    bub.closest(".msg").remove();
    pushMsg("assistant", full);
    const done = addBubble("assistant", full, false);
    if (done) done.classList.add("landed");
    celebrateFromSend();
    speak(full);
  } catch (err) {
    // This request was aborted because a NEWER request superseded it — the
    // newer one owns the UI now; stay quiet instead of painting stale errors.
    if (isSupersededRequest(err)) return;
    // Key problems (no credits / invalid / rate-limited)? Never leave the user
    // stuck: answer with the built-in free AI instead.
    const msgText = friendlyError(err);
    const quotaish = err.message !== "NO_KEY" && state.provider !== "pollinations" &&
      /credits|insufficient_quota|credit_balance|quota|billing|rate limit|401|403|api.?key.?(not valid|invalid|expired|incorrect)|invalid.?api.?key|incorrect.?api.?key|api_key_invalid|unregistered|not authorized|503|high demand|overload|unavailable|email[ _-]?verification|verify your email/i.test(err.message);
    if (quotaish) {
      try {
        setStatus("key issue — answering with free AI…");
        let fb = "";
        await callFreeAI(buildApiMessages(currentChat()), (p) => { fb += p; renderStream(bub, fb); });
        const provName = state.provider === "gemini" ? "Gemini" : state.provider === "tokenharbor" ? "Token Harbor" : state.provider === "openai" ? "OpenAI" : state.provider === "openrouter" ? "OpenRouter" : state.provider === "groq" ? "Groq" : state.provider === "bai" ? "B.AI" : "your AI provider";
        const why = err.message.includes("429") ? "free quota — try again in a minute" : err.message.toLowerCase().includes("verif") ? "email not verified yet" : "key issue";
        const finalText = `⚠️ _${provName}: ${why} — answered with **🆓 Free AI**._\n\n${fb}`;
        bub.closest(".msg").remove();
        pushMsg("assistant", finalText);
        addBubble("assistant", finalText, false);
        speak(fb);
        toast("Answered with free AI (your key had an issue)", "warn");
        return;
      } catch { /* fall through to the normal error message */ }
    }
    bub.closest(".msg").remove();
    const msg = err.message === "NO_KEY"
      ? "🔑 This brain needs your own API key. **FREE keys:** Groq console.groq.com/keys · Gemini aistudio.google.com/apikey · OpenRouter openrouter.ai/keys → ⚙️ Settings → paste → Save. Or stay on the free built-in brains (Groq / Token Harbor / Free AI)."
      : `⚠️ ${msgText}`;
    addBubble("assistant", msg);
    pushMsg("assistant", msg);
    toast(err.message === "NO_KEY" ? "This brain needs your key — free keys listed above" : "AI request failed", "err");
  } finally {
    state.busy = false;
    setBusy(false);
    setStatus("");
    renderHistory();
  }
}

let streamText = "";
/* Streaming render: markdown re-parse is O(full length) per call, so raw
   per-token calls made it O(n²) over a response. Paint at most ~11×/s
   (beyond human perception) with a trailing flush, then the completed
   message is painted once more by addBubble — identical end state. */
let lastStreamPaint = 0, streamPaintTimer = null;
function paintStream(bub, full) {
  bub.classList.add("streaming");
  bub.innerHTML = renderMd(full) + '<span class="cursor">▍</span>';
  scrollBottom();
}
function renderStream(bub, full) {
  streamText = full;
  const now = performance.now();
  if (now - lastStreamPaint >= 90) {
    lastStreamPaint = now;
    if (streamPaintTimer) { clearTimeout(streamPaintTimer); streamPaintTimer = null; }
    paintStream(bub, full);
  } else if (!streamPaintTimer) {
    streamPaintTimer = setTimeout(() => {
      streamPaintTimer = null;
      lastStreamPaint = performance.now();
      paintStream(bub, streamText);
    }, 90);
  }
}

function updateQueueInfo() {
  const n = state.queued.length;
  el.queueInfo.classList.toggle("hidden", n === 0);
  if (n) el.queueInfo.textContent = `📡 ${n} message(s) queued offline`;
}

async function flushQueue() {
  if (!state.queued.length || state.busy || !navigator.onLine) return;
  const pending = [...state.queued];
  state.queued = [];
  saveAll();
  updateQueueInfo();
  for (const item of pending) {
    toast("Sending queued message…", "ok");
    state.currentId = item.chatId in state.chats ? item.chatId : state.currentId;
    await handleSend(item.text, { fromQueue: true });
  }
}

/* ---------------- Voice: STT, TTS, hands-free ---------------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const NATIVE_BRIDGE = typeof window !== "undefined" && window.NovaNative; // inside the Android APK
let recog = null, recogForCommand = false;

/* Android APK bridge: wraps the NATIVE recognizer in the web-SR interface so
   the whole voice stack (voice chat, hands-free, echo guard) works unchanged
   inside the app — where window.SpeechRecognition doesn't exist. */
class NativeSR {
  constructor() {
    this.lang = "en-US"; this.continuous = false; this.interimResults = false;
    this.onresult = null; this.onend = null; this.onerror = null; this.onspeechstart = null;
    this._open = false;
  }
  _evt(text, isFinal) {
    const res = { isFinal: !!isFinal, 0: { transcript: text } };
    const evt = { resultIndex: 0, results: [res] };
    evt.results[Symbol.iterator] = function* () { yield res; };
    return evt;
  }
  start() {
    this._open = true;
    window.NovaSpeechResult = (text, isFinal) => {
      if (!this._open) return;
      this._open = false;
      if (this.onresult) this.onresult(this._evt(text, true));
      setTimeout(() => this.onend && this.onend(), 30);
    };
    window.NovaSpeechPartial = (text) => {
      if (!this._open || !this.interimResults || !this.onresult) return;
      this.onresult(this._evt(text, false));
    };
    window.NovaSpeechError = (code) => {
      if (!this._open) return;
      this._open = false;
      if (this.onerror) this.onerror({ error: code });
      setTimeout(() => this.onend && this.onend(), 30);
    };
    window.NovaSpeechReady = () => { if (this.onspeechstart) this.onspeechstart(); };
    try { window.NovaNative.start(); }
    catch { this._open = false; if (this.onerror) this.onerror({ error: "unknown" }); }
  }
  stop() { this._open = false; try { window.NovaNative.stop(); } catch { /* ignore */ } }
  abort() { this.stop(); }
}
function createRecog() { return NATIVE_BRIDGE ? new NativeSR() : new SR(); }

/* ═══════ TTS text sanitizer: Nova speaks only natural human words ═══════
   Strips emojis (and their names), markdown, code blocks, URLs and junk. */
const EMOJI_RE = /([\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{27BF}]|[\u{FE00}-\u{FE0F}]|[\u{1F000}-\u{1F0FF}]|[\u{2190}-\u{21FF}]|[\u{2B00}-\u{2BFF}]|[\u{1F1E6}-\u{1F1FF}]|[\u{2700}-\u{27BF}]|[\u{2B50}\u{203C}\u{2049}]|[\u{E000}-\u{F8FF}])/gu;

function cleanForSpeech(text) {
  let t = String(text || "");
  t = t.replace(/```[\s\S]*?```/g, " code block omitted. ");
  t = t.replace(/`([^`]+)`/g, "$1");
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, "");              // images
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");           // links → text
  t = t.replace(/https?:\/\/\S+/g, "");                     // bare urls
  t = t.replace(EMOJI_RE, "");
  t = t.replace(/[\u{1F900}-\u{1F9FF}]/gu, "");
  t = t.replace(/[*_#>|~]/g, "");                           // markdown residue
  t = t.replace(/\s*\([^)]*\)\s*/g, (m) => (/^[a-z ]+$/i.test(m) ? m : " ")); // keep (real asides)
  t = t.replace(/\n+/g, ". ");
  t = t.replace(/\s{2,}/g, " ").trim();
  return t.slice(0, 700);
}

/* ---- JARVIS voice engine: deep male EN-GB voice, pitch-shifted down.
   Persists the choice; falls back to any en-GB male, then any voice. ---- */
let jarvisVoice = null;
function pickJarvisVoice() {
  if (!("speechSynthesis" in window)) return;
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return;
  const saved = LS.get("nova.ttsVoice", "");
  if (saved) {
    const v = voices.find((x) => x.name === saved);
    if (v) { jarvisVoice = v; return; }
  }
  const score = (v) => {
    let s = 0;
    if (/en[-_]GB/i.test(v.lang)) s += 6;
    if (/Google UK English Male/i.test(v.name)) s += 6;
    if (/male|daniel|arthur|oliver|george|ryan/i.test(v.name)) s += 3;
    if (/natural|neural|online/i.test(v.name)) s += 2;
    if (/en/i.test(v.lang)) s += 1;
    return s;
  };
  jarvisVoice = voices.slice().sort((a, b) => score(b) - score(a))[0] || voices[0];
  if (jarvisVoice) LS.set("nova.ttsVoice", jarvisVoice.name);
}
if ("speechSynthesis" in window) {
  pickJarvisVoice();
  speechSynthesis.onvoiceschanged = pickJarvisVoice;
}

function speak(text) {
  if ((!state.autospeak && !voiceChat && !jarvisOverlayOpen) || state.speaking || !("speechSynthesis" in window)) return;
  const clean = cleanForSpeech(text);
  if (!clean) return;
  speechSynthesis.cancel();
  VoiceFSM.ttsActive = true;                 // mic lock begins BEFORE audio starts
  pauseRecognitionForTTS();                  // stop capture — the one rule
  const u = new SpeechSynthesisUtterance(clean);
  if (jarvisVoice) u.voice = jarvisVoice;
  u.rate = 1.0; u.pitch = 0.82; u.volume = 1.0;   // the JARVIS depth
  u.onstart = () => {
    state.speaking = true;
    voicePhase("SPEAKING");
    setHudState("speaking");
    setVoiceState("speaking", clean.slice(0, 120));
  };
  wireTTSPulse(u);                           // real word boundaries → core pulses
  u.onend = () => {
    if (!VoiceFSM.ttsActive) return;         // cancel() also fires onend — ignore ghosts
    state.speaking = false;
    VoiceFSM.ttsActive = false;
    setTimeout(() => { if (!state.speaking && !state.busy) setHudState("idle"); }, 300);
    resumeRecognitionAfterTTS();             // real TTS end → cooldown → clean LISTENING
  };
  speechSynthesis.speak(u);
}

function speakNow(text) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  VoiceFSM.ttsActive = true;
  pauseRecognitionForTTS();
  const u = new SpeechSynthesisUtterance(cleanForSpeech(text));
  if (jarvisVoice) u.voice = jarvisVoice;
  u.rate = 1.0; u.pitch = 0.82;
  wireTTSPulse(u);
  u.onstart = () => { state.speaking = true; voicePhase("SPEAKING"); setHudState("speaking"); };
  u.onend = () => {
    if (!VoiceFSM.ttsActive) return;         // ghost onend from cancel()
    state.speaking = false;
    VoiceFSM.ttsActive = false;
    setTimeout(() => { if (!state.speaking && !state.busy) setHudState("idle"); }, 300);
    resumeRecognitionAfterTTS();
  };
  speechSynthesis.speak(u);
}

/* ECHO KILL: micGate() mutes the raw stream, but SpeechRecognition (Chrome's
   engine) keeps its own tap on the mic — so it still heard Nova's replies.
   While Nova speaks we go further: the recognizer is fully STOPPED and its
   session closed, so no callback can ever fire. Restart happens only from
   the REAL TTS onend → cooldown → clean new session. */
function pauseRecognitionForTTS() {
  VoiceFSM.ttsActive = true;
  vNextSession();            // close the listening session for good
  stopRecog();               // stop capture — not ignore, STOP
  micGate(false);            // mute the raw stream too
}
function resumeRecognitionAfterTTS() {
  VoiceFSM.ttsActive = false;
  ttsCooldownRearm();        // real-TTS-end driven: cooldown → flush → LISTENING
}

/* ═══════ PERSISTENT MICROPHONE ═══════
   getUserMedia runs ONCE; every listener reuses the same stream. Tracks are
   only disabled (enabled=false) when idle — no permission pop-ups, ever. */
let waveCtx = null, waveAnalyser = null, waveStream = null;   // mic stream + analyser (shared with the NOVA Core viz)
let micOpening = null;   // single in-flight getUserMedia promise
let micDenied = false;   // a hard "no" this session — don't nag again

async function ensureMic() {
  if (micDenied) throw Object.assign(new Error("Microphone permission was denied — allow it in the address bar, then reload"), { name: "NotAllowedError" });
  if (waveStream && waveStream.active) return waveStream;
  if (micOpening) return micOpening;
  micOpening = (async () => {
    // Browser/OS audio processing ON — but the app-level FSM (stop-while-speaking)
    // is the real fix; these constraints are a supporting layer, never the answer.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    waveStream = stream;
    // Bluetooth/wired device pulled out mid-session → stop cleanly, show real error.
    for (const t of stream.getAudioTracks()) {
      t.onended = () => {
        if (voiceChat || state.listening) endVoiceChat("Audio device disconnected — voice stopped");
      };
    }
    if (!waveCtx) waveCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (waveCtx.state === "suspended") await waveCtx.resume();
    const src = waveCtx.createMediaStreamSource(stream);
    waveAnalyser = waveCtx.createAnalyser();
    waveAnalyser.fftSize = 256;                 // enough resolution for the orb
    waveAnalyser.smoothingTimeConstant = 0.72;
    src.connect(waveAnalyser);
    return stream;
  })();
  try { return await micOpening; }
  catch (err) {
    if (err && (err.name === "NotAllowedError" || err.name === "SecurityError" || err.name === "PermissionDeniedError")) {
      micDenied = true;   // remember the refusal — no repeat pop-ups this session
    }
    throw err;
  }
  finally { micOpening = null; }
}

/* Echo gate: while Nova speaks, drop the mic input so it can't hear itself.
   Reopened by the caller after onend + a 300ms buffer. */
function micGate(open) {
  if (!waveStream) return;
  for (const t of waveStream.getAudioTracks()) t.enabled = open;
}

/* Legacy #wave bar system REMOVED — it rendered a second voice interface
   underneath the #jarvis overlay (root cause of the double-UI bug).
   All voice status now flows through ONE interface: #jarvis. */
function setWaveText(t) {
  // Single-interface router: quoted text → live transcript, labels → state.
  if (t && t.startsWith("\u201c")) setHeard(t.replace(/[\u201c\u201d]/g, ""));
  else setVoicePhase(t || "");
}

let voiceChat = false;      // loop master switch
let voiceThinking = false;  // a reply is being fetched/spoken
let dictation = false;      // plain type-into-box mode

async function startMicDictation() {
  if (!SR && !NATIVE_BRIDGE) { toast("Voice input not supported in this browser", "warn"); return; }
  if (voiceChat) return endVoiceChat("Voice chat ended");
  if (state.busy || voiceThinking) { toast("One moment — still answering…", "warn"); return; }
  voiceChat = true;
  el.mic.classList.add("listening");
  await listenOnce();
}

/* One listen→think→speak cycle; re-arms itself while voiceChat is true.
   Session-guarded: every callback captures its session id and is dropped
   the moment a new session begins (SPEAKING, closeJarvis, teardown). */
async function listenOnce() {
  if (!voiceChat || state.busy || voiceThinking) return;
  /* Exactly one recognizer, ever — but a LIVE one (the hands-free wake loop)
     must YIELD here, never block the manual session. Bailing out while
     recogActive was true is why the mic button looked dead with hands-free on. */
  if (recogActive) stopRecog();
  const my = vSession();
  return new Promise((resolve) => {
    stopListening();                             // hands-free yields the mic
    stopRecog();                                 // clean slate — no stale listeners
    const r = createRecog();
    recog = r;
    r.lang = navigator.language || "en-US";
    r.interimResults = true;
    r.continuous = false;
    let finalText = "";
    const alive = () => !vStale(my) && recog === r && voiceChat;   // session-owner check

    micGate(true);
    voicePhase("LISTENING");

    r.onspeechstart = () => { if (alive()) setWaveText("I'm listening…"); };
    r.onresult = (e) => {
      if (!alive()) return;                              // old session → ignore
      if (VoiceFSM.ttsActive || state.speaking) return;  // belt & braces echo guard
      let interim = "";
      for (const res of e.results) {
        if (res.isFinal) finalText += res[0].transcript + " ";
        else interim += res[0].transcript;
      }
      if (interim || finalText) setWaveText("“" + (finalText + interim).trim().slice(-42) + "”");
    };
    r.onend = async () => {
      recogActive = false;                               // recognizer is done by definition
      if (!alive()) return resolve();                    // session closed → do NOTHING
      const said = finalText.trim();
      if (said) setHeard(said);                          // final transcript persists
      if (!said) {
        if (VoiceFSM.ttsActive || state.speaking) return resolve();  // TTS owns the mic
        setWaveText(VOICE_LABELS.LISTENING);
        resolve();
        setTimeout(() => { if (alive()) listenOnce(); }, 350);
        return;
      }
      if (voiceCommandDuplicate(said)) {                 // same command twice → run once
        setWaveText(VOICE_LABELS.LISTENING);
        resolve();
        setTimeout(() => { if (alive()) listenOnce(); }, 400);
        return;
      }
      /* USER SPEECH → PROCESSING: mic OFF before anything else can run. */
      vNextSession();            // this listening session is closed
      stopRecog();
      micGate(false);
      voiceThinking = true;
      setWaveText(VOICE_LABELS.PROCESSING);
      voicePhase("PROCESSING");
      try {
        voicePhase("THINKING");
        await handleSend(said, { fromVoice: true });   // speaking starts inside speak()
        voicePhase(state.speaking ? "SPEAKING" : "COOLDOWN");
      } catch {
        voicePhase("ERROR");
      }
      voiceThinking = false;
      resolve();
      /* Re-arm belongs to speak()'s REAL onend → ttsCooldownRearm().
         This fallback only fires if nothing was spoken (autospeak off). */
      setTimeout(() => {
        if (!voiceChat || VoiceFSM.ttsActive || state.speaking || voiceThinking) return;
        micGate(true);
        voicePhase("LISTENING");
        listenOnce();
      }, 500);
    };
    r.onerror = (ev) => {
      recogActive = false;
      const code = ev && ev.error;
      if (!alive()) return resolve();
      if (code === "not-allowed" || code === "service-not-allowed") {
        voicePhase("ERROR");
        endVoiceChat("Mic blocked — click the 🔒 in the address bar → allow Microphone → reload");
        toast("Mic blocked — allow it in the address bar, then reload", "err");
        setVoiceState("mic-error");
      } else if (code === "no-speech") {
        setWaveText(VOICE_LABELS.LISTENING);
        setTimeout(() => { if (alive()) listenOnce(); }, 700);
      } else if (code === "network") {
        voicePhase("ERROR");
        endVoiceChat("Voice needs internet — check your connection");
      } else if (code === "audio-capture") {
        voicePhase("ERROR");
        endVoiceChat("No microphone found");
      } else {
        setWaveText(VOICE_LABELS.LISTENING);
        setTimeout(() => { if (alive()) listenOnce(); }, 900);
      }
      resolve();
    };
    try { r.start(); recogActive = true; } catch { stopRecog(); resolve(); }
  });
}

function endVoiceChat(msg) {
  voiceChat = false;
  voiceThinking = false;
  vNextSession();            // orphan any pending voice callbacks
  el.mic.classList.remove("listening");
  stopListening();
  if (msg) toast(msg);
  /* Hands-free is handed back by closeJarvis only — resuming here would
     re-open the mic on error paths (blocked mic, device unplugged). */
}

/* Hands-free: continuous listening for "<Nickname>, <command>".
   One session owns the recognizer. While Nova speaks the recognizer is
   STOPPED (pauseRecognitionForTTS) and restarted only from the real TTS
   end via ttsCooldownRearm → restartHandsFreeRecog. */
function toggleHandsFree() {
  if (state.listening) { stopListening(); setHudState("idle"); voicePhase("IDLE"); return; }
  if (!SR && !NATIVE_BRIDGE) { toast("Hands-free needs Chrome/Edge — or the Nova app", "warn"); return; }
  vNextSession();
  state.listening = true;
  const nick = norm(state.nickname).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  el.listenBanner.classList.remove("hidden");
  el.wakeName.textContent = state.nickname;
  setHudState("listening");
  voicePhase("LISTENING");
  startHandsFreeRecog(nick);
  toast(`Hands-free on — say “${state.nickname}, …”`, "ok");
  keepAwake(true);
}

function startHandsFreeRecog(nick) {
  stopRecog();
  const my = vSession();
  const r = createRecog();
  recog = r;
  r.lang = navigator.language || "en-US";
  r.continuous = true;
  r.interimResults = false;
  const alive = () => !vStale(my) && recog === r && state.listening;

  r.onresult = (e) => {
    if (!alive()) return;
    if (VoiceFSM.ttsActive || state.speaking || voiceThinking) return;   // never while Nova talks
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (!e.results[i].isFinal) continue;
      const heard = norm(e.results[i][0].transcript);
      // Wake triggers: "Nova", "Hi Nova", "Hey Nova", "Ok Nova", "Yo Nova".
      const rx = new RegExp(`(?:^|\\b)(?:(?:hey|hi|ok|okay|yo)\\s+)?${nick}\\b[,!\\s]*(.*)`);
      const m = heard.match(rx);
      if (!m) continue;
      const cmd = m[1].trim();
      const raw = e.results[i][0].transcript.trim();
      /* ONE wake event → at most ONE action. The claim is atomic: a repeated
         final result (Chrome re-delivery) hits the duplicate guard, and the
         wake-only branch is guarded too — it used to be un-guarded, which is
         how a repeated event produced a second activation and a second beep. */
      if (voiceCommandDuplicate(cmd.length > 1 ? cmd : "__wake_only__")) {
        setHeard(raw);       // keep the live transcript, take no action
        continue;
      }
      setHeard(raw);         // final transcript stays visible while Nova answers
      addBubble("user", `🎙️ “${raw}”`);
      if (cmd.length <= 1) {
        const greeting = `Yes ${state.nickname === "Nova" ? "sir" : ""}, how can I help you today?`.replace(/\s+/g, " ");
        vNextSession(); stopRecog(); micGate(false);         // mic OFF before Nova speaks
        speakNow(greeting);
        addBubble("ai", `✦ ${greeting}`);
        voicePhase("SPEAKING");
        return;                       // one accepted wake per event, no double beep
      } else {
        vNextSession(); stopRecog(); micGate(false);         // mic OFF before processing
        voiceThinking = true;
        voicePhase("PROCESSING");
        Promise.resolve(handleSend(cmd))
          .catch(() => voicePhase("ERROR"))
          .finally(() => {
            voiceThinking = false;
            if (VoiceFSM.ttsActive || state.speaking) return; // speak() owns the re-arm
            ttsCooldownRearm();                               // nothing was spoken → re-arm
          });
        return;                       // one accepted wake per event
      }
    }
  };
  r.onend = () => {
    // Legit silence-restart — NEVER while TTS is active or the session is closed.
    if (alive() && !VoiceFSM.ttsActive && !state.speaking && !voiceThinking) {
      setTimeout(() => { if (alive() && !VoiceFSM.ttsActive) startHandsFreeRecog(nick); }, 250);
    }
  };
  r.onerror = (ev) => {
    if (!alive()) return;
    if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
      toast("Mic blocked — click 🔒 in the address bar → allow Microphone → reload", "err");
      stopListening();
    } else if (ev.error === "network") {
      toast("Voice needs internet — retrying", "warn");
    }
  };
  try { r.start(); recogActive = true; } catch { stopRecog(); }
}

/* Fresh hands-free session after TTS cooldown (called by ttsCooldownRearm). */
function restartHandsFreeRecog() {
  if (!state.listening || voiceChat) return;
  const nick = norm(state.nickname).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  startHandsFreeRecog(nick);
  voicePhase("LISTENING");
}

function stopListening() {
  state.listening = false;
  el.listenBanner.classList.add("hidden");
  el.mic.classList.remove("listening");
  stopRecog();                 // single choke point: no recognizer survives
  keepAwake(false);
  setHudState("idle");
}

/* ---------------- Confirm dialog (typed, for destructive actions) ---------------- */
let confirmState = null;
function openConfirm(title, message, actionLabel, onConfirm) {
  confirmState = { onConfirm };
  $("#confirm-title").textContent = title;
  $("#confirm-text").textContent = message;
  $("#confirm-input").value = "";
  $("#confirm-go").disabled = true;
  $("#confirm-go").textContent = actionLabel || "Confirm";
  $("#confirm-modal").classList.remove("hidden");
  setTimeout(() => $("#confirm-input").focus(), 60);
}
function closeConfirm() {
  $("#confirm-modal").classList.add("hidden");
  confirmState = null;
}
function wireConfirm() {
  $("#confirm-cancel").onclick = closeConfirm;
  $("#confirm-cancel-2").onclick = closeConfirm;
  $("#confirm-modal").addEventListener("click", (e) => { if (e.target === $("#confirm-modal")) closeConfirm(); });
  $("#confirm-input").addEventListener("input", (e) => {
    $("#confirm-go").disabled = e.target.value.trim().toUpperCase() !== "YES";
  });
  $("#confirm-input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !$("#confirm-go").disabled) $("#confirm-go").click(); });
  $("#confirm-go").onclick = () => {
    if (!confirmState) return;
    const fn = confirmState.onConfirm;
    closeConfirm();
    fn();
  };
}

/* ---------------- Settings UI ---------------- */
let freeModelsCache = [];
async function refreshFreeModels() {
  if (state.provider !== "openrouter" || freeModelsCache.length) return;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models");
    const j = await res.json();
    freeModelsCache = (j?.data || [])
      .filter((m) => typeof m.id === "string" && m.id.endsWith(":free"))
      .slice(0, 10)
      .map((m) => ({ id: m.id, label: "🆓 FREE — " + (m.name || m.id) }));
    if (freeModelsCache.length && state.provider === "openrouter") { fillModelSelect(); updateModelSelect(); }
  } catch { /* offline — static list stays */ }
}

function fillModelSelect() {
  el.setModel.innerHTML = "";
  const list = [...(MODELS[state.provider] || [])];
  for (const m of list) {
    const opt = document.createElement("option");
    opt.value = m.id; opt.textContent = m.label;
    el.setModel.appendChild(opt);
  }
  if (state.model && !list.some((o) => o.id === state.model)) {
    const opt = document.createElement("option");
    opt.value = state.model; opt.textContent = state.model + " (saved)";
    el.setModel.appendChild(opt);
  }
  if ([...el.setModel.options].some((o) => o.value === state.model)) el.setModel.value = state.model;
}

function openSettings(page) {
  el.setNickname.value = state.nickname;
  el.setAutospeak.checked = state.autospeak;
  el.setStudyStrict.checked = state.studyStrict;
  const hf = $("#set-handsfree"); if (hf) hf.checked = state.handsFree;
  $("#set-memory").value = state.profile.facts.join("\n");
  $("#set-sync-code").value = state.syncCode;
  const themeSel = $("#set-theme"); if (themeSel) themeSel.value = state.theme;
  updateSyncStatus();
  refreshDevices();
  fillModelSelect();
  refreshTHModels();
  el.settingsModal.classList.remove("hidden");
  showSettingsPage(page || "general");
}

function showSettingsPage(page) {
  document.querySelectorAll("#settings-modal .settings-nav button").forEach((b) =>
    b.classList.toggle("active", b.dataset.page === page));
  document.querySelectorAll("#settings-modal .settings-page").forEach((p) =>
    p.classList.toggle("hidden", p.dataset.page !== page));
}

/* ---------------- Nova Memory: clear with a human confirmation ---------------- */
function clearMemory() {
  openConfirm("Clear Nova Memory?", "Nova will forget everything you've shared — name, city, preferences, all of it. You can teach it again anytime.", "Clear memory", () => {
    state.profile = { name: "", facts: [], asked: true };
    LS.set("nova.profile", state.profile);
    scheduleSync();
    const ta = $("#set-memory"); if (ta) ta.value = "";
    toast("Memory cleared", "ok");
  });
}

/* ---------------- Command palette (Ctrl/Cmd + K) ---------------- */
const PALETTE_ICONS = {
  chat: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-8 8H4l2.4-2.4A8 8 0 1 1 21 12z"/></svg>',
  sparkle: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/></svg>',
  note: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3h9l5 5v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5"/><path d="M8 13h8M8 17h5"/></svg>',
  mic: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v1a7 7 0 0 0 14 0v-1"/><path d="M12 18v4"/></svg>',
  search: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  gear: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/></svg>',
  lock: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.4-3 7.4-7 9-4-1.6-7-4.6-7-9V6z"/></svg>',
};
function paletteItems() {
  const items = [
    { label: "New chat", icon: "chat", run: () => { closePalette(); animateNewChat(); } },
    { label: "Start voice mode", icon: "mic", run: () => { closePalette(); openJarvis(); } },
    { label: "Toggle hands-free listening", icon: "mic", run: () => { closePalette(); toggleHandsFree(); } },
    { label: "Open notes", icon: "note", run: () => { closePalette(); openNotes(); } },
    { label: "Search chats", icon: "search", run: () => { closePalette(); if (window.innerWidth <= 640) openChatsSheet(); else { $("#side-search").focus(); } } },
    { label: "Switch theme", icon: "sparkle", run: () => { closePalette(); cycleTheme(); } },
    { label: "Open settings", icon: "gear", run: () => { closePalette(); openSettings(); } },
    { label: "Privacy Center", icon: "lock", run: () => { closePalette(); openSettings("privacy"); } },
    { label: "Study mode", icon: "sparkle", run: () => { closePalette(); setMode("study"); } },
    { label: "Exam prep mode", icon: "sparkle", run: () => { closePalette(); setMode("exam"); } },
    { label: "Homework mode", icon: "sparkle", run: () => { closePalette(); setMode("homework"); } },
  ];
  const task = latestTask();
  if (task) items.splice(1, 0, { label: `Continue: ${task.title}`, icon: "sparkle", run: () => { closePalette(); handleSend("continue that task"); } });
  return items;
}
let paletteSel = 0;
function renderPalette(filter = "") {
  const list = $("#palette-list");
  const q = filter.trim().toLowerCase();
  const items = paletteItems().filter((it) => it.label.toLowerCase().includes(q));
  paletteSel = Math.min(paletteSel, Math.max(0, items.length - 1));
  list.innerHTML = "";
  if (!items.length) {
    list.innerHTML = '<div class="palette-empty">Nothing matches — try another word</div>';
    return;
  }
  items.forEach((it, i) => {
    const b = document.createElement("button");
    b.className = "palette-item" + (i === paletteSel ? " sel" : "");
    b.setAttribute("role", "option");
    b.innerHTML = `<span class="pi-ic">${PALETTE_ICONS[it.icon] || ""}</span><span>${it.label}</span>`;
    b.onclick = () => it.run();
    b.onmousemove = () => { if (paletteSel !== i) { paletteSel = i; renderPalette(filter); } };
    list.appendChild(b);
  });
}
function openPalette() {
  paletteSel = 0;
  renderPalette();
  const p = $("#palette");
  p.classList.remove("hidden");
  const inp = $("#palette-input");
  inp.value = "";
  setTimeout(() => inp.focus(), 30);
}
function closePalette() {
  $("#palette").classList.add("hidden");
}
function paletteKey(e) {
  const items = paletteItems().filter((it) => it.label.toLowerCase().includes($("#palette-input").value.trim().toLowerCase()));
  if (e.key === "ArrowDown") { e.preventDefault(); paletteSel = Math.min(paletteSel + 1, items.length - 1); renderPalette($("#palette-input").value); }
  else if (e.key === "ArrowUp") { e.preventDefault(); paletteSel = Math.max(paletteSel - 1, 0); renderPalette($("#palette-input").value); }
  else if (e.key === "Enter") { e.preventDefault(); const it = items[paletteSel]; if (it) it.run(); }
  else if (e.key === "Escape") { e.preventDefault(); closePalette(); }
}

/* ---------------- Bottom sheets (mobile chats) + bottom nav ---------------- */
function openChatsSheet() {
  renderHistoryInto($("#sheet-history"), $("#sheet-search")?.value || "");
  $("#chats-sheet").classList.remove("hidden");
}
function closeChatsSheet() { $("#chats-sheet").classList.add("hidden"); }

/* ---------------- Notes workspace ---------------- */
function openNotes() {
  renderNotes();
  $("#notes-modal").classList.remove("hidden");
}
function renderNotes() {
  const box = $("#notes-list");
  const q = ($("#notes-search")?.value || "").trim().toLowerCase();
  const notes = state.notes.filter((n) => !q || (n.text || "").toLowerCase().includes(q));
  box.innerHTML = "";
  if (!notes.length) {
    box.innerHTML = `<div class="dev-row muted">${q ? "No notes matching “" + q + "”" : "No notes yet. Create your first note above — or say “note …” in chat."}</div>`;
    return;
  }
  for (const n of notes) {
    const row = document.createElement("div");
    row.className = "dev-row";
    const body = document.createElement("span");
    body.className = "dev-name";
    const txt = document.createElement("span");
    txt.textContent = n.text;
    const when = document.createElement("small");
    when.textContent = new Date(n.ts).toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " · " + new Date(n.ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    body.append(txt, when);
    const x = document.createElement("button");
    x.className = "dev-revoke"; x.textContent = "✕"; x.title = "Delete note";
    x.setAttribute("aria-label", "Delete note");
    x.onclick = () => {
      state.notes = state.notes.filter((m) => m !== n);
      saveAll(); scheduleSync();
      renderNotes();
    };
    row.append(body, x);
    box.appendChild(row);
  }
}

function updateSyncStatus() {
  const s = $("#sync-status");
  if (!s) return;
  s.textContent = state.syncCode ? `connected as “${state.syncCode}” · ${deviceName()}` : "not connected";
}

/* ---- Device dashboard: every device that unlocked this site (name · IP · last seen) ---- */
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && "wakeLock" in navigator) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* unsupported / screen off — hands-free just pauses */ }
}

async function refreshDevices() {
  const box = document.getElementById("devices-list");
  if (!box) return;
  box.innerHTML = `<div class="dev-row muted">checking…</div>`;
  const token = LS.get("nova.lockToken", "");
  if (!token) { box.innerHTML = `<div class="dev-row muted">unlock first</div>`; return; }
  try {
    const r = await fetch(apiUrl("/api/gate"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, listAll: 1 }) });
    const j = await r.json();
    if (!j.ok || !j.devices?.length) { box.innerHTML = `<div class="dev-row muted">no devices yet</div>`; return; }
    const myId = LS.get("nova.devId", "");
    box.innerHTML = "";
    for (const d of j.devices) {
      const row = document.createElement("div");
      row.className = "dev-row";
      const mins = Math.max(0, Math.round((Date.now() - d.seen) / 60000));
      const seen = mins < 1 ? "online now" : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
      row.innerHTML = `<span class="dev-dot${mins < 5 ? " live" : ""}"></span>
        <span class="dev-name">${d.name || "Device"}${d.id === myId ? " <b class=\"dev-you\">· this device</b>" : ""}
        <small>${d.ip || ""} · ${seen}</small></span>`;
      const btn = document.createElement("button");
      btn.className = "dev-revoke"; btn.textContent = "✕"; btn.title = "Remove access (device must log in again)";
      btn.onclick = async () => {
        await fetch(apiUrl("/api/gate"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, revoke: d.id }) });
        if (d.id === myId) { LS.set("nova.lockToken", ""); location.reload(); }
        else { toast("Access removed — that device must log in again", "ok"); refreshDevices(); }
      };
      row.appendChild(btn);
      box.appendChild(row);
    }
  } catch {
    box.innerHTML = `<div class="dev-row muted">offline — showing local info only</div>`;
  }
}

/* Auto-discover the full live Token Harbor model list (silent). */
async function refreshTHModels() {
  if (state.provider !== "tokenharbor") return;
  try {
    const r = await fetch("https://tokenharbor.ai/v1/models", { headers: { Authorization: `Bearer ${getKey()}` } });
    if (!r.ok) return;
    const j = await r.json();
    const ids = (j?.data || []).map((m) => m.id).filter(Boolean);
    if (!ids.length) return;
    const free = ids.filter((i) => i.endsWith(":free"));
    const rest = ids.filter((i) => !i.endsWith(":free") && i !== "th-orchestra");
    MODELS.tokenharbor = free.concat(rest).slice(0, 20).map((id) => ({ id, label: id.endsWith(":free") ? id.replace(":free", " · FREE") : id }));
    fillModelSelect();
    updateModelSelect();
  } catch { /* offline — defaults remain */ }
}

/* Verify a key against its provider (returns true/false, null = couldn't check). */
async function validateKey(provider, key) {
  try {
    if (provider === "gemini") {
      if (!key.startsWith("AIza") && !key.startsWith("AQ.")) return false;
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${encodeURIComponent(key)}`);
      return r.ok;
    }
    if (provider === "groq") {
      if (!key.startsWith("gsk_")) return false;
      const r = await fetch("https://api.groq.com/openai/v1/models", { headers: { Authorization: `Bearer ${key}` } });
      return r.ok;
    }
    if (provider === "openai") {
      const r = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${key}` } });
      return r.ok;
    }
    if (provider === "openrouter") {
      const r = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${key}` } });
      return r.ok;
    }
    if (provider === "tokenharbor") {
      if (!key.startsWith("thk_")) return false;
      const r = await fetch("https://tokenharbor.ai/v1/models", { headers: { Authorization: `Bearer ${key}` } });
      if (r.ok) {
        // discover the full live model list and add anything new to the menu
        try {
          const j = await r.json();
          const ids = (j?.data || []).map((m) => m.id).filter(Boolean);
          if (ids.length) {
            const free = ids.filter((i) => i.endsWith(":free"));
            const rest = ids.filter((i) => !i.endsWith(":free") && i !== "th-orchestra");
            MODELS.tokenharbor = free.concat(rest).slice(0, 16).map((id) => ({ id, label: id.endsWith(":free") ? id.replace(":free", " · FREE") : id }));
            updateModelSelect();
          }
        } catch { /* keep defaults */ }
        return true;
      }
      try {
        const j = await r.json();
        if (j?.error?.code === "email_verification_required") return "verify";
      } catch { /* ignore */ }
      return false;
    }
    if (provider === "bai") {
      const r = await fetch("https://api.b.ai/v1/models", { headers: { Authorization: `Bearer ${key}` } });
      if (r.ok) {
        // discover the full live model list and add anything new to the menu
        try {
          const j = await r.json();
          const ids = (j?.data || []).map((m) => m.id).filter(Boolean);
          if (ids.length) {
            const known = new Set(MODELS.bai.map((m) => m.id));
            const extra = ids.filter((id) => !known.has(id)).slice(0, 10).map((id) => ({ id, label: id }));
            if (extra.length) { MODELS.bai = MODELS.bai.concat(extra); updateModelSelect(); }
          }
        } catch { /* keep defaults */ }
        return true;
      }
      return false;
    }
    return true;
  } catch { return null; }
}

function saveSettings() {
  state.model = el.setModel.value;
  const nick = el.setNickname.value.trim() || "Nova";
  state.nickname = nick;
  state.autospeak = el.setAutospeak.checked;
  state.studyStrict = el.setStudyStrict.checked;
  el.wakeName.textContent = nick;
  // Memory editor: one fact per line; a “Name: X” line sets the name
  const memLines = $("#set-memory").value.split("\n").map((s) => s.trim()).filter(Boolean);
  const nameLine = memLines.find((l) => /^name\s*:/i.test(l));
  if (nameLine) state.profile.name = nameLine.replace(/^name\s*:\s*/i, "").trim();
  state.profile.facts = memLines.filter((l) => l !== nameLine);
  LS.set("nova.profile", state.profile);
  scheduleSync();
  const hfBox = $("#set-handsfree");
  state.handsFree = !!(hfBox && hfBox.checked);
  LS.set("nova.handsFree", state.handsFree);
  if (state.handsFree && !state.listening) { try { toggleHandsFree(); } catch { /* needs SR */ } }
  if (!state.handsFree && state.listening) stopListening();
  LS.set("nova.model", state.model);
  LS.set("nova.nickname", state.nickname);
  LS.set("nova.autospeak", state.autospeak);
  LS.set("nova.studyStrict", state.studyStrict);
  updateModelSelect();
  el.settingsModal.classList.add("hidden");
  toast("Settings saved ✓", "ok");
  renderMessages(); // refresh greeting (name may have changed)
}

/* ---------------- Mode switching & wiring ---------------- */
/* Composer model menu (custom, opens upward, dark glass). */
const BRAIN_GROUPS = () => [
  {
    label: "Nova Auto — server-routed, always available",
    items: [
      { id: "auto", label: "✦ Nova Auto — picks the best working brain", provider: "auto", model: "auto" },
    ],
  },
  {
    label: "Online · free",
    items: [
      { id: "free", label: "🆓 Free AI — GPT-OSS 20B, no key", provider: "pollinations", model: "openai" },
    ],
  },
  {
    label: "Groq — built-in key ⚡ fastest cloud",
    items: (MODELS.groq || []).map((m) => ({ id: "gr:" + m.id, label: "⚡ " + m.label, provider: "groq", model: m.id })),
  },
  ...(OLLAMA_MODELS.length ? [{
    label: "Ollama — this laptop, private 🦙",
    items: OLLAMA_MODELS.map((m) => ({ id: "ol:" + m.id, label: "🦙 " + m.label, provider: "ollama", model: m.id })),
  }] : []),
  {
    label: "Offline",
    items: [
      { id: "lite", label: "🧠 Nova Lite — works offline, no key", provider: "lite", model: "lite" },
    ],
  },
  {
    label: "Token Harbor — free · built-in key ◇",
    items: (MODELS.tokenharbor || []).map((m) => ({ id: "th:" + m.id, label: "◇ " + m.label, provider: "tokenharbor", model: m.id })),
  },
  ...(state.apiKey ? [{
    label: "Gemini — your key",
    items: (MODELS.gemini || []).map((m) => ({ id: "g:" + m.id, label: "✦ " + m.label, provider: "gemini", model: m.id })),
  }] : []),
  {
    label: "CleanApis — 5M tokens/mo · server-secure",
    items: (MODELS.cleanapis || []).map((m) => ({ id: "cl:" + m.id, label: "◆ " + m.label, provider: "cleanapis", model: m.id })),
  },
  // (all picker groups are freely clickable — every built-in-key provider works instantly)
  {
    label: "OpenRouter — free · built-in key ◈",
    items: (MODELS.openrouter || []).map((m) => ({ id: "or:" + m.id, label: "◈ " + m.label, provider: "openrouter", model: m.id })),
  },
  ...(state.apiKey ? [{
    label: "B.AI — your key",
    items: (MODELS.bai || []).map((m) => ({ id: "b:" + m.id, label: "◆ " + m.label, provider: "bai", model: m.id, locked: state.provider !== "bai" })),
  }] : []),
];

function currentBrainId() {
  if (state.provider === "auto") return "auto";
  if (state.provider === "pollinations") return "free";
  if (state.provider === "lite") return "lite";
  if (state.provider === "tokenharbor") return "th:" + state.model;
  if (state.provider === "openrouter") return "or:" + state.model;
  if (state.provider === "groq") return "gr:" + state.model;
  if (state.provider === "cleanapis") return "cl:" + state.model;
  if (state.provider === "ollama") return "ol:" + state.model;
  if (state.provider === "bai") return "b:" + state.model;
  return "g:" + state.model;
}

/* Premium brain selector: provider dot + name + subtitle on the button,
   searchable two-line menu rows. */
let OLLAMA_MODELS = [];
async function discoverOllama() {
  try {
    const r = await fetch("/api/ollama/models");
    const j = await r.json();
    if (j.ok && j.models.length) {
      OLLAMA_MODELS = j.models;
      updateModelSelect();
    }
  } catch { /* not running locally — hide the group */ }
}

function escHtml(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
const PROV_META = {
  auto: { name: "Nova Auto", tag: "AUTO", cls: "dd-p-free" },
  free: { name: "Free AI", tag: "NO KEY", cls: "dd-p-free" },
  lite: { name: "Nova Lite", tag: "OFFLINE", cls: "dd-p-lite" },
  gemini: { name: "Gemini", tag: "YOUR KEY", cls: "dd-p-gemini" },
  tokenharbor: { name: "Token Harbor", tag: "SERVER-SECURE", cls: "dd-p-th" },
  bai: { name: "B.AI", tag: "KEY", cls: "dd-p-bai" },
  openrouter: { name: "OpenRouter", tag: "SERVER-SECURE", cls: "dd-p-or" },
  groq: { name: "Groq", tag: "SERVER-SECURE", cls: "dd-p-groq" },
  cleanapis: { name: "CleanApis", tag: "SERVER-SECURE · 5M", cls: "dd-p-oa" },
  ollama: { name: "Ollama", tag: "LOCAL · PRIVATE", cls: "dd-p-ollama" },
  openai: { name: "OpenAI", tag: "KEY", cls: "dd-p-oa" },
};

function currentBrain() {
  const id = currentBrainId();
  for (const g of BRAIN_GROUPS()) {
    const hit = g.items.find((it) => it.id === id && !it.locked) ||
      g.items.find((it) => it.provider === state.provider && it.model === state.model);
    if (hit) {
      const m = PROV_META[hit.provider] || { name: hit.provider, tag: "", cls: "" };
      return {
        name: hit.label.replace(/^[✦◇◆🆓🧠]\s*/, "").split("—")[0].trim(),
        sub: m.name + (m.tag ? " · " + m.tag : ""),
        cls: m.cls || "",
      };
    }
  }
  const m = PROV_META[state.provider] || { name: state.provider, tag: "", cls: "" };
  return { name: state.model || m.name, sub: m.name + (m.tag ? " · " + m.tag : ""), cls: m.cls || "" };
}

function updateModelSelect() {
  const b = currentBrain();
  el.modelDDBtn.innerHTML =
    `<span class="dd-swatch ${b.cls}"></span>` +
    `<span class="dd-names"><span class="dd-name">${escHtml(b.name)}</span>` +
    `<span class="dd-sub">${escHtml(b.sub)}</span></span>` +
    `<svg class="dd-chev" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>`;
  renderModelMenu();
}

/* Real provider health from our own server (/api/health) — never fake status. */
let HEALTH = null, HEALTH_AT = 0;
function healthDot(provider) {
  const h = HEALTH && Array.isArray(HEALTH.providers) && HEALTH.providers.find((p) => p.provider === provider);
  return h ? `<span class="dd-status ${h.status}" title="${h.status}${h.latencyMs ? " · " + h.latencyMs + "ms" : ""}"></span>` : "";
}
async function refreshHealth() {
  if (HEALTH && Date.now() - HEALTH_AT < 120000) return;
  try {
    const r = await fetch(apiUrl("/api/health"));
    HEALTH = await r.json();
    HEALTH_AT = Date.now();
    if (el.modelDD && !el.modelDD.classList.contains("hidden")) renderModelMenu();
  } catch { /* offline — dots stay neutral */ }
}

function renderModelMenu(filter = "") {
  const q = filter.trim().toLowerCase();
  el.modelDDMenu.innerHTML = "";
  refreshHealth();
  const search = document.createElement("div");
  search.className = "dd-search";
  search.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg><input id="dd-search-input" type="text" placeholder="Search models…" autocomplete="off" />`;
  el.modelDDMenu.appendChild(search);
  let shown = 0;
  for (const group of BRAIN_GROUPS()) {
    if (!group.items.length) continue;
    const items = group.items.filter((it) =>
      !q || it.label.toLowerCase().includes(q) ||
      (PROV_META[it.provider] ? PROV_META[it.provider].name.toLowerCase().includes(q) : false));
    if (!items.length) continue;
    shown += items.length;
    const head = document.createElement("div");
    head.className = "model-dd-head";
    head.textContent = group.label;
    el.modelDDMenu.appendChild(head);
    for (const item of items) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "model-dd-item" + (item.id === currentBrainId() ? " active" : "") + (item.locked ? " locked" : "");
      row.setAttribute("role", "option");
      const meta = PROV_META[item.provider] || { name: "", tag: "", cls: "" };
      row.innerHTML =
        `<span class="dd-swatch ${meta.cls || ""}"></span>` +
        `<span class="dd-names"><span class="mi-label">${escHtml(item.label)}</span>` +
        (meta.name ? `<span class="dd-sub">${escHtml(meta.name)}</span>` : "") +
        `</span>` +
        healthDot(item.provider) +
        (item.id === currentBrainId() ? '<span class="mi-check">✓</span>' : item.locked ? '<span class="mi-lock">🔑</span>' : "");
      row.onclick = () => {
        closeModelMenu();
        if (item.locked) { openSettings(); return; }
        if (item.provider !== state.provider) {
          // Keys are per-provider: keep each provider's user key in its own slot
          // so hopping brains never loses a pasted Gemini/OpenRouter key.
          const byProv = LS.get("nova.keysByProvider", {});
          byProv[state.provider] = state.apiKey || "";           // save current
          state.provider = item.provider;
          state.apiKey = byProv[state.provider] || "";           // load target's
          LS.set("nova.provider", state.provider);
          LS.set("nova.keysByProvider", byProv);
          LS.set("nova.key", state.apiKey);
        }
        state.model = item.model;
        LS.set("nova.model", state.model);
        updateModelSelect();
        toast("Brain: " + item.label.split("—")[0].trim(), "ok");
      };
      el.modelDDMenu.appendChild(row);
    }
  }
  if (!shown) {
    const empty = document.createElement("div");
    empty.className = "dd-empty";
    empty.textContent = "No models match — try another word";
    el.modelDDMenu.appendChild(empty);
  }
  const foot = document.createElement("button");
  foot.type = "button";
  foot.className = "model-dd-item more";
  foot.innerHTML = `<span class="mi-label">⚙️ Manage keys & providers…</span>`;
  foot.onclick = () => { closeModelMenu(); openSettings(); };
  el.modelDDMenu.appendChild(foot);
  const inp = el.modelDDMenu.querySelector("#dd-search-input");
  if (inp) {
    inp.value = filter;
    inp.oninput = () => renderModelMenu(inp.value);
    setTimeout(() => {
      inp.focus();
      const len = inp.value.length;
      try { inp.setSelectionRange(len, len); } catch (_) {}
    }, 60);
  }
}

function openModelMenu() {
  renderModelMenu();
  el.modelDDMenu.classList.remove("hidden");
  el.modelDDBtn.classList.add("open");
  requestAnimationFrame(() => el.modelDDMenu.classList.add("show"));
}

function closeModelMenu() {
  el.modelDDMenu.classList.remove("show");
  el.modelDDBtn.classList.remove("open");
  setTimeout(() => el.modelDDMenu.classList.add("hidden"), 180);
}

function handleModelChange() { /* replaced by menu item handlers */ }

/* Animated new chat: bubbles drift out, then a fresh session slides in. */
function animateNewChat() {
  if (state.busy) { toast("Wait for the reply to finish…", "warn"); return; }
  const msgs = [...el.messages.children];
  if (!msgs.length) { el.newChat.click(); return; }
  msgs.forEach((m, i) => {
    setTimeout(() => m.classList.add("msg-out"), i * 45);
  });
  setTimeout(() => {
    newChatObj(); saveAll(); renderHistory(); renderMessages();
    el.messages.classList.remove("chat-in");
    void el.messages.offsetWidth; // restart animation
    el.messages.classList.add("chat-in");
    el.sidebar.classList.remove("open"); el.scrim.classList.remove("show");
    el.input.focus();
  }, msgs.length * 45 + 260);
}

function setMode(mode) {
  state.mode = mode;
  LS.set("nova.mode", mode);
  const chat = currentChat();
  chat.mode = mode;
  saveAll();
  el.modeChip.textContent = MODE_LABELS[mode] || "Chat";
  document.querySelectorAll(".side-item[data-mode]").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === mode));
  if (chat.messages.length) addBubble("sys", `Switched to **${MODE_LABELS[mode]}** mode.`);
}

function autosize() {
  el.input.style.height = "auto";
  el.input.style.height = Math.min(el.input.scrollHeight, 140) + "px";
}

function wire() {
  el.menu.onclick = () => { el.sidebar.classList.toggle("open"); el.scrim.classList.toggle("show"); };
  const aboutBtn = $("#btn-about-template");
  if (aboutBtn) aboutBtn.onclick = () => {
    const ta = $("#set-memory");
    if (!ta.value.trim()) {
      ta.value = "Name: \nCity: \nCollege / Job: \nClass / Role: \nBest friend: \nBirthday: \nFavourite food: \nMother tongue: ";
    } else {
      // add only missing template lines
      const lines = ["Name: ", "City: ", "College / Job: ", "Best friend: ", "Birthday: "];
      for (const l of lines) if (!ta.value.split("\n").some((x) => x.split(":")[0].trim() === l.split(":")[0].trim())) ta.value += "\n" + l;
    }
    ta.focus();
    toast("Fill in the blanks — Nova will know you ✦", "ok");
  };
  const hfNick = $("#hf-nick"); if (hfNick) hfNick.textContent = state.nickname;
  const hfNick2 = $("#hf-nick2"); if (hfNick2) hfNick2.textContent = state.nickname;
  const goHome = () => {
    el.sidebar.classList.remove("open"); el.scrim.classList.remove("show");
    closeChatsSheet();
    state.currentId = null; // always land on the greeting screen
    LS.set("nova.currentId", null);
    renderMessages();
  };
  el.brand.onclick = goHome;
  document.querySelectorAll(".bn-btn").forEach((b) => {
    b.onclick = () => {
      const nav = b.dataset.nav;
      if (nav === "home") goHome();
      else if (nav === "chats") openChatsSheet();
      else if (nav === "new") animateNewChat();
      else if (nav === "notes") openNotes();
      else if (nav === "settings") openSettings();
    };
  });
  $("#btn-close-chats").onclick = closeChatsSheet;
  $("#chats-sheet").addEventListener("click", (e) => { if (e.target === $("#chats-sheet")) closeChatsSheet(); });
  $("#sheet-search").addEventListener("input", () => renderHistoryInto($("#sheet-history"), $("#sheet-search").value));
  $("#btn-close-notes").onclick = () => $("#notes-modal").classList.add("hidden");
  $("#notes-modal").addEventListener("click", (e) => { if (e.target === $("#notes-modal")) $("#notes-modal").classList.add("hidden"); });
  $("#btn-note-save").onclick = () => {
    const v = $("#note-input").value.trim();
    if (!v) return;
    state.notes.unshift({ text: v, ts: Date.now() });
    saveAll(); scheduleSync();
    $("#note-input").value = "";
    renderNotes();
    toast("Note saved", "ok");
  };
  $("#notes-search").addEventListener("input", renderNotes);
  $("#nav-notes").onclick = () => { closeChatsSheet(); openNotes(); };
  $("#btn-theme").onclick = cycleTheme;
  $("#btn-theme-2").onclick = cycleTheme;
  $("#btn-settings-2").onclick = () => openSettings();
  $("#nav-palette").onclick = openPalette;
  $("#nav-settings-foot").onclick = () => openSettings();
  $("#side-search").addEventListener("input", () => renderHistoryInto(el.history, $("#side-search").value));
  el.scrim.onclick = () => { el.sidebar.classList.remove("open"); el.scrim.classList.remove("show"); };

  el.send.onclick = () => handleSend(el.input.value);
  el.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(el.input.value); }
  });
  el.input.addEventListener("input", autosize);

  el.mic.onclick = () => openJarvis();
  el.listenStop.onclick = stopListening;
  const jExit = j$("jarvis-exit");
  if (jExit) {
    jExit.onclick = closeJarvis;
    jExit.addEventListener("click", (e) => e.stopPropagation());   // exit never doubles as barge-in
  }
  // Barge-in: an explicit tap on the voice screen while Nova speaks stops TTS
  // instantly and opens a clean listening session. Silence/noise never does.
  const jOverlay = j$("jarvis");
  if (jOverlay) jOverlay.addEventListener("click", () => {
    if (!jarvisOverlayOpen) return;
    if (VoiceFSM.ttsActive || state.speaking) userBargeIn();
  });
  // Voice-mode bottom controls: every button is a REAL action.
  const jMic = j$("jarvis-mic"), jType = j$("jarvis-type");
  let micMuted = false;
  if (jMic) jMic.onclick = () => {
    micMuted = !micMuted;
    jMic.classList.toggle("is-muted", micMuted);
    jMic.classList.toggle("is-on", !micMuted);
    if (micMuted) {
      micGate(false); stopRecog();
      setVoicePhase("Mic muted"); setHeard("Tap Mic again to keep talking.");
    } else {
      micGate(true);
      setVoicePhase("Listening…"); setHeard("");
      if (voiceChat && !voiceThinking && !VoiceFSM.ttsActive) listenOnce();
    }
  };
  if (jType) jType.onclick = () => { closeJarvis(); setTimeout(() => el.input && el.input.focus(), 380); };

  /* Command palette + global keyboard shortcuts */
  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); $("#palette").classList.contains("hidden") ? openPalette() : closePalette(); return; }
    if (mod && e.key.toLowerCase() === "n") { e.preventDefault(); animateNewChat(); return; }
    if (mod && e.shiftKey && e.key.toLowerCase() === "o") { e.preventDefault(); openSettings("privacy"); return; }
    const paletteOpen = !$("#palette").classList.contains("hidden");
    if (paletteOpen) { paletteKey(e); return; }
    if (e.key === "Escape") {
      if (!$("#chats-sheet").classList.contains("hidden")) closeChatsSheet();
      else if (!$("#notes-modal").classList.contains("hidden")) $("#notes-modal").classList.add("hidden");
      else if (!el.settingsModal.classList.contains("hidden")) closeSettingsAnimated();
      else if (jarvisOverlayOpen) closeJarvis();
    }
  });
  $("#palette").addEventListener("click", (e) => { if (e.target === $("#palette")) closePalette(); });
  $("#palette-input").addEventListener("input", () => { paletteSel = 0; renderPalette($("#palette-input").value); });

  el.home.querySelectorAll(".chip").forEach((b) => { b.onclick = () => handleChip(b.dataset.chip); });
  // Home navigation lives on the bottom nav + brand click (goHome) — no legacy topbar button.

  const origRenderMessages = renderMessages;
  renderMessages = function () {
    const fresh = !currentChat().messages.length;
    if (fresh) showHome(); else hideHome();
    origRenderMessages();
  };

  const origAnimate = animateNewChat;
  animateNewChat = function () {
    if (isHome()) { el.input.focus(); return; }
    const msgs = [...el.messages.children];
    if (!msgs.length) { el.input.focus(); return; }
    msgs.forEach((m, i) => setTimeout(() => m.classList.add("msg-out"), i * 45));
    setTimeout(() => {
      newChatObj(); saveAll(); renderHistory();
      el.messages.classList.remove("chat-in");
      void el.messages.offsetWidth;
      el.messages.classList.add("chat-in");
      showHome();
      origRenderMessages();
      el.sidebar.classList.remove("open"); el.scrim.classList.remove("show");
    }, msgs.length * 45 + 260);
  };
  el.newChat.onclick = animateNewChat;
  el.modelDDBtn.onclick = () => el.modelDDMenu.classList.contains("hidden") ? openModelMenu() : closeModelMenu();
  document.addEventListener("click", (e) => {
    if (!el.modelDD.contains(e.target) && !el.modelDDMenu.classList.contains("hidden")) closeModelMenu();
    if (!el.attach.contains(e.target) && !el.attachMenu.classList.contains("hidden")) el.attachMenu.classList.add("hidden");
  });

  /* 📎 attach menu → hidden file inputs */
  const pick = (inputEl) => { el.attachMenu.classList.add("hidden"); inputEl.value = ""; inputEl.click(); };
  el.attach.onclick = (e) => { e.stopPropagation(); el.attachMenu.classList.toggle("hidden"); };
  el.attachMenu.querySelectorAll("button").forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const what = b.dataset.attach;
      if (what === "photos") pick(el.fileImg);
      else if (what === "camera") pick(el.fileCam);
      else if (what === "docs") pick(el.fileDoc);
      else if (what === "folder") pick(el.fileFolder);
    };
  });
  el.fileImg.onchange = (e) => addFiles(e.target.files);
  el.fileCam.onchange = (e) => addFiles(e.target.files);
  el.fileDoc.onchange = (e) => addFiles(e.target.files);
  el.fileFolder.onchange = (e) => addFiles(e.target.files);

  /* Modes: sidebar buttons carry data-mode. */
  document.querySelectorAll(".side-item[data-mode]").forEach((b) => {
    b.onclick = () => setMode(b.dataset.mode);
  });
  if (window.matchMedia("(hover: none)").matches) {
    document.querySelectorAll(".history-item").forEach((b) => b.classList.add("touch"));
  }
  el.settings.onclick = () => openSettings();
  const closeSettingsAnimated = () => {
    if (el.settingsModal.classList.contains("hidden")) return;
    el.settingsModal.classList.add("hidden");
  };
  el.closeSettings.onclick = closeSettingsAnimated;
  el.saveSettings.onclick = saveSettings;
  document.querySelectorAll("#settings-modal .settings-nav button").forEach((b) => {
    b.onclick = () => showSettingsPage(b.dataset.page);
  });
  $("#btn-clear-memory").onclick = clearMemory;
  /* Erase-all: typed confirmation — never a one-click accident */
  const openWipe = () => {
    $("#wipe-modal").classList.remove("hidden");
    $("#wipe-confirm-input").value = "";
    $("#btn-wipe-confirm").disabled = true;
    setTimeout(() => $("#wipe-confirm-input").focus(), 60);
  };
  const closeWipe = () => $("#wipe-modal").classList.add("hidden");
  el.wipe.onclick = openWipe;
  $("#btn-wipe-cancel").onclick = closeWipe;
  $("#btn-wipe-cancel-2").onclick = closeWipe;
  $("#wipe-modal").addEventListener("click", (e) => { if (e.target === $("#wipe-modal")) closeWipe(); });
  $("#wipe-confirm-input").addEventListener("input", (e) => {
    $("#btn-wipe-confirm").disabled = e.target.value.trim().toUpperCase() !== "ERASE";
  });
  $("#btn-wipe-confirm").onclick = () => {
    if ($("#wipe-confirm-input").value.trim().toUpperCase() !== "ERASE") return;
    closeWipe();
    localStorage.clear();
    location.reload();
  };

  el.settingsModal.addEventListener("click", (e) => {
    if (e.target === el.settingsModal) closeSettingsAnimated();
  });

  /* Sync pairing */
  $("#btn-sync-connect").onclick = () => {
    const code = ($("#set-sync-code").value || "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 8);
    if (code.length < 4) { toast("Use 4–8 letters/digits, e.g. ALI-2026", "warn"); return; }
    state.syncCode = code;
    LS.set("nova.syncCode", code);
    updateSyncStatus();
    lastSeenRev = -1;
    openSyncStream();
    doSync();
  };
  $("#btn-sync-now").onclick = () => doSync();

  document.querySelectorAll(".quick-btn").forEach((b) => {
    b.onclick = () => { el.input.value = b.dataset.fill; el.input.focus(); autosize(); };
  });

  window.addEventListener("online", () => setNet(true));
  window.addEventListener("offline", () => setNet(false));
  setNet(navigator.onLine);

  /* Theme select in Settings → General */
  const themeSel = $("#set-theme");
  if (themeSel) themeSel.onchange = () => { state.theme = themeSel.value; LS.set("nova.theme", state.theme); applyTheme(); };

  /* Performance mode in Settings → Performance — changes REAL behavior:
     the background canvas render scale + frame caps (see bgfx.js). */
  state.perfMode = LS.get("nova.perfMode", "balanced");
  const perfSel = $("#set-perfmode");
  if (perfSel) {
    perfSel.value = state.perfMode;
    perfSel.onchange = () => {
      state.perfMode = perfSel.value;
      LS.set("nova.perfMode", state.perfMode);
      if (window.NovaFX && window.NovaFX.setPerf(state.perfMode)) {
        toast("Performance mode: " + state.perfMode, "ok");
      }
    };
  }

  // PWA install prompt — hide the button entirely once installed
  const standalone = matchMedia("(display-mode: standalone)").matches ||
    matchMedia("(display-mode: window-controls-overlay)").matches ||
    navigator.standalone === true;
  if (standalone && el.install) el.install.classList.add("hidden");
  let deferredPrompt = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    if (standalone) return;             // already an app — never show again
    deferredPrompt = e;
    el.install.classList.remove("hidden");
  });
  window.addEventListener("appinstalled", () => {
    if (el.install) el.install.classList.add("hidden");
    toast("Nova installed 🎉 — find it in your Start menu / home screen", "ok");
  });
  el.install.onclick = async () => {
    if (!deferredPrompt) {
      // No browser prompt available (e.g. already installed): guide the user.
      toast("Already installed — look for “Nova” in your Start menu or home screen", "warn");
      return;
    }
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === "accepted") { el.install.classList.add("hidden"); }
    deferredPrompt = null;
  };

  // URL actions (from app shortcuts)
  const action = new URLSearchParams(location.search).get("action");
  if (action === "new-chat") { newChatObj(); saveAll(); renderMessages(); }
  if (action === "study") setMode("study");

  // Gemini-style: always land on the centered home screen.
  if (!action) {
    state.currentId = null;
    LS.set("nova.currentId", null);
  }

  // Service worker
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  // Relay reachability, once per load, so a dead relay surfaces clearly.
  if (apiBase()) { fetch(apiUrl("/api/health"), { cache: "no-store" }).catch(() => {}); }

  // Auto-sync on start & when the tab regains focus (paired devices only)
  if (state.syncCode) {
    doSync(true);
    openSyncStream();
    document.addEventListener("visibilitychange", () => { if (!document.hidden) doSync(true); });
  }

  wireAgentPanels();
}

/* ---------------- Connections / Performance / Diagnostics — real state only ---------------- */
let agentOnline = null;   // null = unknown, true/false = last real probe result

async function probeAgent(silent = true) {
  try {
    const r = await fetch("/api/ping", { cache: "no-store" });
    const j = await r.json();
    agentOnline = !!(j && j.ok);
    return j;
  } catch {
    agentOnline = false;
    return null;
  }
}

function wireAgentPanels() {
  const openPerf = async () => {
    const body = $("#perf-body");
    body.innerHTML = '<div class="dev-row muted">Reading live numbers…</div>';
    const [ping, stats] = await Promise.all([probeAgent(), actOnLaptop("stats", "")]);
    if (!(stats && stats.ok)) {
      body.innerHTML = '<div class="dev-row muted">The Nova Agent isn\u2019t running. On the laptop, open the Nova folder and run <b>python serve.py</b>, then refresh.</div>';
    } else {
      body.innerHTML = "";
      const add = (label, value) => {
        const row = document.createElement("div");
        row.className = "dev-row";
        row.innerHTML = `<span style="min-width:86px;color:var(--text-3)">${label}</span><span>${value}</span>`;
        body.appendChild(row);
      };
      add("CPU", stats.cpu != null ? Math.round(stats.cpu) + "%" : "—");
      add("RAM", stats.ramTotalGb ? `${stats.ramUsedGb} / ${stats.ramTotalGb} GB` : "—");
      add("GPU", stats.gpuName ? escHtml(stats.gpuName) + (stats.gpuLoad != null ? ` · ${Math.round(stats.gpuLoad)}%` : "") : "—");
      add("Battery", stats.battery != null ? Math.round(stats.battery) + "%" : "—");
      if (stats.processes) add("Processes", String(stats.processes));
    }
    const connSub = $("#conn-agent-sub"), connState = $("#conn-agent-state");
    if (connSub) connSub.textContent = agentOnline ? "Listening on this network — system stats, files, safe cleanup" : "Start with python serve.py on the laptop";
    if (connState) { connState.textContent = agentOnline ? "Connected" : "Offline"; connState.className = agentOnline ? "conn-state ok" : "conn-state"; }
    const da = $("#diag-agent");
    if (da) da.textContent = agentOnline ? "Connected (v2)" : "Offline — python serve.py";
  };
  const openDiag = () => {
    const brain = currentBrain();
    const db = $("#diag-brain"); if (db) db.textContent = brain ? `${brain.name} — ${brain.sub}` : "—";
    const dl = $("#diag-latency"); if (dl) dl.textContent = window.__novaLastLatency ? Math.round(window.__novaLastLatency) + " ms round-trip" : "No request yet";
    const ds = $("#diag-sync"); if (ds) ds.textContent = state.syncCode ? `Paired as “${state.syncCode}” · ${deviceName()}` : "Not paired";
    const dv = $("#diag-voice"); if (dv) dv.textContent = NATIVE_BRIDGE ? "Native (Android app)" : SR ? "Browser speech recognition" : "Not supported in this browser";
  };
  // Re-render performance/diagnostics whenever their page is opened
  document.querySelectorAll('#settings-modal .settings-nav button').forEach((b) => {
    const orig = b.onclick;
    b.addEventListener("click", () => {
      if (b.dataset.page === "performance") openPerf();
      if (b.dataset.page === "diagnostics") openDiag();
    });
  });
  const refresh = $("#btn-perf-refresh");
  if (refresh) refresh.onclick = openPerf;
  // probe agent once at startup for the Connections panel
  probeAgent().then((j) => {
    const connSub = $("#conn-agent-sub"), connState = $("#conn-agent-state");
    if (connSub && agentOnline) connSub.textContent = (j && j.device ? j.device + " · " : "") + "system stats, files, safe cleanup";
    if (connState && agentOnline) { connState.textContent = "Connected"; connState.className = "conn-state ok"; }
  });
  // Real latency probe: wrap the free-AI path once for Diagnostics.
  if (!window.__novaLatencyWrapped) {
    window.__novaLatencyWrapped = true;
    const origCallAI = callAI;
    callAI = async function (messages, onDelta) {
      const t0 = performance.now();
      try { return await origCallAI(messages, onDelta); }
      finally { window.__novaLastLatency = performance.now() - t0; }
    };
  }
}

/* ---------------- Device sync (laptop <-> phone) ----------------
   One sync code pairs your devices. Each device pushes its local data and
   pulls the merged copy — newest-wins per item, so nothing is lost. */
function syncPayload() {
  return {
    chats: state.chats,
    notes: state.notes,
    cards: state.cards,
    profile: state.profile,
    nickname: state.nickname,
    handsFree: !!state.handsFree,
    tasks: state.tasks,
    activity: state.activity.slice(0, 40),
    _ts: Date.now(),
  };
}

/* ---------------- Cross-device tasks (drafts & actions with a life) ----------------
   A task = {id, kind, title, detail, status, ts, updatedTs, origin}. Created on
   one device, continued/finished on another — through the existing sync code. */
function addTask(kind, title, detail, status = "waiting") {
  const task = {
    id: "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    kind, title, detail, status,
    ts: Date.now(), updatedTs: Date.now(),
    origin: deviceName(),
  };
  state.tasks = state.tasks.filter((t) => t.status !== "done" && t.status !== "cancelled").slice(-9);
  state.tasks.push(task);
  saveAll();
  scheduleSync();
  return task;
}
function latestTask(kind) {
  for (let i = state.tasks.length - 1; i >= 0; i--) {
    const t = state.tasks[i];
    if ((!kind || t.kind === kind) && t.status !== "done" && t.status !== "cancelled") return t;
  }
  return null;
}
function updateTask(id, patch) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  Object.assign(t, patch, { updatedTs: Date.now() });
  saveAll();
  scheduleSync();
}

function applySynced(data) {
  if (!data || typeof data !== "object") return;
  let changed = false;
  if (data.chats && typeof data.chats === "object") {
    for (const [id, c] of Object.entries(data.chats)) {
      const mine = state.chats[id];
      if (!mine || (c.ts || 0) > (mine.ts || 0)) { state.chats[id] = c; changed = true; }
    }
  }
  if (Array.isArray(data.notes)) {
    const seen = new Set(state.notes.map((n) => n.ts + "|" + n.text));
    for (const n of data.notes) {
      const k = n.ts + "|" + n.text;
      if (!seen.has(k)) { state.notes.push(n); seen.add(k); changed = true; }
    }
    state.notes.sort((a, b) => b.ts - a.ts);
  }
  if (typeof data.handsFree === "boolean" && data.handsFree !== state.handsFree) {
    state.handsFree = data.handsFree;
    LS.set("nova.handsFree", state.handsFree);
    const hf = $("#set-handsfree"); if (hf) hf.checked = state.handsFree;
    if (state.handsFree && !state.listening) { try { toggleHandsFree(); } catch { /* no SR */ } }
    if (!state.handsFree && state.listening) stopListening();
    changed = true;
  }
  if (data.cards && typeof data.cards === "object") {
    for (const [topic, cards] of Object.entries(data.cards)) {
      const mine = state.cards[topic] || [];
      const seen = new Set(mine.map((c) => c.q));
      for (const c of cards || []) if (!seen.has(c.q)) { mine.push(c); changed = true; }
      if (mine.length) state.cards[topic] = mine;
    }
  }
  if (data.profile && typeof data.profile === "object") {
    const facts = new Set(state.profile.facts || []);
    for (const f of data.profile.facts || []) if (!facts.has(f)) { facts.add(f); changed = true; }
    state.profile.facts = [...facts].slice(-60);
    if (data.profile.name && !state.profile.name) { state.profile.name = data.profile.name; changed = true; }
  }
  if (data.nickname && data.nickname !== state.nickname) { state.nickname = data.nickname; LS.set("nova.nickname", state.nickname); changed = true; }
  if (Array.isArray(data.tasks)) {
    const byId = new Map(state.tasks.map((t) => [t.id, t]));
    for (const t of data.tasks) {
      const mine = byId.get(t.id);
      if (!mine || (t.updatedTs || t.ts || 0) >= (mine.updatedTs || mine.ts || 0)) { byId.set(t.id, t); changed = true; }
    }
    state.tasks = [...byId.values()]
      .filter((t) => t.status !== "done" && t.status !== "cancelled" || Date.now() - (t.updatedTs || t.ts || 0) < 86400000)
      .sort((a, b) => (b.updatedTs || b.ts) - (a.updatedTs || a.ts))
      .slice(0, 10);
  }
  if (Array.isArray(data.activity)) {
    const byId = new Map(state.activity.map((a) => [a.id, a]));
    for (const a of data.activity) if (a && a.id) byId.set(a.id, a);
    state.activity = [...byId.values()].sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 100);
    LS.set("nova.activity", state.activity);
    changed = true;
  }
  if (changed) { saveAll(); renderHistory(); renderMessages(); }
  return changed;
}

function deviceName() {
  const ph = isPhone();
  const ua = navigator.userAgent;
  const os = /Android/i.test(ua) ? "Android" : /iPhone|iPad|iPod/i.test(ua) ? "iPhone" : /Mac/i.test(ua) ? "Mac" : /Win/i.test(ua) ? "Windows" : /Linux/i.test(ua) ? "Linux" : "Device";
  return `${os} ${ph ? "(phone)" : "(laptop)"}`;
}

async function doSync(pushOnly = false) {
  if (!state.syncCode) { toast("Pair a code first (Settings → Sync)", "warn"); return; }
  const dev = deviceName();
  try {
    const res = await fetch(apiUrl("/api/sync?code=" + encodeURIComponent(state.syncCode)));
    if (!res.ok) throw new Error("sync fetch failed");
    const remote = await res.json();
    applySynced(remote.data);
    if (!pushOnly) toast("⇅ Synced" + (remote.rev ? ` (rev ${remote.rev})` : ""), "ok");
  } catch { /* pull failed; still push below */ }
  try {
    const res = await fetch(apiUrl("/api/sync"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: state.syncCode, device: dev, payload: syncPayload() }),
    });
    if (!res.ok) throw new Error("sync push failed");
    const j = await res.json();
    if (j && j.data) applySynced(j.data);
    if (pushOnly) return;
    toast("☁️ Pushed to your devices", "ok");
    const btn = document.getElementById("btn-sync-now");
    if (btn) { btn.textContent = "✓ Synced"; setTimeout(() => (btn.textContent = "⇅ Sync now"), 1600); }
  } catch {
    toast("Sync failed — sync store unreachable", "err");
  }
}

let syncTimer = null;
function scheduleSync() {
  if (!state.syncCode) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => doSync(true), 2500); // debounced push after activity
}

/* Real-time-ish sync: SSE gives instant push; the poll is the backup.
   While SSE is healthy, poll at a relaxed 15s instead of 4s — same
   freshness, a quarter of the requests. */
let lastSeenRev = -1;
let syncSSE = null;
let lastSSEEventAt = 0;

/* Instant push: a live SSE stream fires the moment another device pushes.
   Falls back to 4s polling if SSE is unavailable. */
function openSyncStream() {
  if (!state.syncCode || typeof EventSource === "undefined") return;
  // The relay has no SSE events route — polling is the transport there.
  if (apiBase()) { if (syncSSE) { syncSSE.close(); syncSSE = null; } return; }
  if (syncSSE) { syncSSE.close(); syncSSE = null; }
  try {
    syncSSE = new EventSource(apiUrl("/api/sync/events?code=" + encodeURIComponent(state.syncCode)));
    syncSSE.addEventListener("rev", (e) => {
      try {
        const { rev } = JSON.parse(e.data);
        lastSSEEventAt = Date.now();
        if (lastSeenRev !== -1 && rev !== lastSeenRev) {
          fetch(apiUrl("/api/sync?code=" + encodeURIComponent(state.syncCode))).then((r) => r.json()).then((remote) => {
            if (remote.data) applySynced(remote.data);
          }).catch(() => {});
        }
        lastSeenRev = rev;
      } catch { /* malformed event */ }
    });
    syncSSE.onerror = () => { /* keep polling as backup */ };
  } catch { /* SSE unsupported */ }
}

async function watchSync() {
  if (!state.syncCode || document.hidden) return;
  // SSE connected and recently alive → it already pushed us everything.
  if (syncSSE && syncSSE.readyState === 1 && Date.now() - lastSSEEventAt < 15000) return;
  try {
    const res = await fetch(apiUrl("/api/sync?code=" + encodeURIComponent(state.syncCode)));
    if (!res.ok) return;
    const remote = await res.json();
    if (lastSeenRev === -1) { lastSeenRev = remote.rev || 0; return; }
    if ((remote.rev || 0) !== lastSeenRev) {
      lastSeenRev = remote.rev || 0;
      if (remote.data) applySynced(remote.data);
    }
  } catch { /* server asleep; try again next tick */ }
}
setInterval(watchSync, 4000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) { lastSeenRev = -1; openSyncStream(); watchSync(); } });

/* ---------------- Init ---------------- */
/* Self-heal: a key whose format can't belong to the chosen provider (e.g. an
   sk- OpenAI key saved under the Gemini provider) can never work. Auto-switch
   to the free provider so the user is never stuck with API errors. */
function healProviderMismatch() {
  const k = state.apiKey || "";
  const fits = {
    gemini: (x) => x.startsWith("AIza") || x.startsWith("AQ."),
    openai: (x) => x.startsWith("sk-") && !x.startsWith("sk-or-"),
    openrouter: (x) => x.startsWith("sk-or-"),
    tokenharbor: (x) => x.startsWith("thk_live_") || x.startsWith("thk_test_"),
    bai: (x) => x.startsWith("sk-") && x.length > 20,
  };
  if (state.provider === "lite" || state.provider === "pollinations") return;
  const check = fits[state.provider];
  if (k && check && !check(k)) {
    state.provider = "pollinations";
    state.model = "openai";
    LS.set("nova.provider", state.provider);
    LS.set("nova.model", state.model);
    setTimeout(() => toast("Key didn't match the provider — switched to 🆓 Free AI. Fix the key in ⚙️ Settings if you meant to use it.", "warn"), 800);
  }
}

/* ═══════ PRIVATE-MODE LOCK ═══════
   Only active on hosted deploys (not localhost/file). If NOVA_PASS is set in
   Netlify, the site stays behind a passcode; a correct unlock is remembered
   on this device (token in localStorage), so you type it once per device. */
async function privateGate() {
  const hosted = location.protocol === "https:" &&
    !/^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(location.hostname) &&
    !/\.local$/i.test(location.hostname);
  if (!hosted) return true;                       // local dev — no lock
  const token = LS.get("nova.lockToken", "");
  if (token) {
    try {
      const r = await fetch(apiUrl("/api/gate"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
      if (r.status === 500) return true;          // gate not configured → fail open
      if (r.ok) {
        const j = await r.json();
        if (j.ok || j.configured) { if (j.devId) LS.set("nova.devId", j.devId); return true; }    // token still valid
      }
    } catch { /* offline: trust the stored token */ return true; }
  } else {
    // no token yet — is the gate even configured?
    try {
      const probe = await fetch(apiUrl("/api/gate"), { method: "GET" });
      if (probe.status === 500) return true;      // NOVA_PASS not set → open site
      const pj = await probe.json().catch(() => null);
      if (pj && pj.configured === false) return true;   // relay has no passcode → nothing to unlock
    } catch { /* offline hosted: fall through to lock */ }
  }
  // show lock screen
  const lock = document.getElementById("lock"), inp = document.getElementById("lock-pass"),
    go = document.getElementById("lock-go"), err = document.getElementById("lock-err"),
    hint = document.getElementById("lock-hint");
  if (!lock) return true;
  lock.classList.remove("hidden");
  try {
    const r = await fetch(apiUrl("/api/gate"), { method: "GET" });
    const j = await r.json();
    if (j.hint) hint.textContent = "Hint: " + j.hint;
  } catch { /* hint optional */ }
  const attempt = async () => {
    err.textContent = "";
    try {
      const r = await fetch(apiUrl("/api/gate"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pass: inp.value }) });
      if (r.status === 500) {
        // Gate not configured — don't trap the user; open with a hint.
        lock.classList.add("hidden");
        toast("Private gate not configured — set NOVA_PASS in the relay's secrets to lock this site", "warn");
        init();
        return;
      }
      if (!r.ok) { err.textContent = "Wrong passcode — try again"; inp.value = ""; inp.focus(); return; }
      const j = await r.json();
      if (j.token) LS.set("nova.lockToken", j.token);
      if (j.devId) LS.set("nova.devId", j.devId);
      lock.classList.add("hidden");
      init();
    } catch {
      err.textContent = "Can't reach the gate — check your connection";
    }
  };
  go.onclick = attempt;
  inp.onkeydown = (e) => { if (e.key === "Enter") attempt(); };
  setTimeout(() => inp.focus(), 60);
  return false; // app stays locked until unlocked
}

function init() {
  injectNovaMarks();
  applyTheme();
  wireConfirm();
  healProviderMismatch();
  // Retired/limited saved models → snap to a working one.
  if (state.provider === "gemini" && !MODELS.gemini.some((m) => m.id === state.model)) {
    state.model = "gemini-3.6-flash";
    LS.set("nova.model", state.model);
  }
  // Reflect the persisted mode on the sidebar buttons.
  document.querySelectorAll(".side-item[data-mode]").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === state.mode));
  el.messages.classList.add("chat-in");
  // Wake/check the AI relay once so problems surface with clear guidance, not mid-chat.
  if (location.protocol !== "file:" && state.provider === "pollinations") {
    fetch(apiUrl("/api/chat"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openai", messages: [{ role: "user", content: "ping" }], stream: false }),
    }).then((r) => { if (!r.ok) throw 0; }).catch(() => {        setTimeout(() => toast(apiBase()
          ? "⚠️ AI relay unreachable — check your connection. Nova Lite still works offline."
          : "⚠️ AI relay unreachable — run `python serve.py` in the Nova folder, then use http://localhost:8080. Nova Lite still works offline.", "warn"), 1200);
    });
  }
  applyTheme();
  updateModelSelect();
  wire();
  renderHistory();
  renderMessages(); // after wire() so the home-screen wrapper is active
  updateQueueInfo();
  wireRipples();
  discoverOllama();
  // Always-on hands-free: resume automatically on every launch.
  if (state.handsFree) {
    setTimeout(() => {
      if (state.listening || (!SR && !NATIVE_BRIDGE)) return;
      try { toggleHandsFree(); keepAwake(true); } catch { /* mic not granted yet */ }
    }, 1800);
  }
  const sendIcon = el.send.innerHTML; // remember the SVG arrow for busy-spin swaps
  el.send.dataset.icon = sendIcon;
  el.input.focus();
}

privateGate().then((open) => { if (open) init(); });
