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

const state = {
  provider: LS.get("nova.provider", "tokenharbor"),          // default brain: TH free Qwen
  apiKey: LS.get("nova.key", ""),
  model: LS.get("nova.model", "qwen3.8-flash:free"),
  nickname: LS.get("nova.nickname", "Nova"),
  autospeak: LS.get("nova.autospeak", false),
  studyStrict: LS.get("nova.studyStrict", true),
  mode: LS.get("nova.mode", "chat"),
  theme: LS.get("nova.theme", "dark"),
  chats: LS.get("nova.chats", {}),   // { id: {id, title, mode, messages: [{role, content}], ts} }
  currentId: LS.get("nova.currentId", null),
  notes: LS.get("nova.notes", []),
  cards: LS.get("nova.cards", {}),   // { topic: [{q, a}] }
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
  if (/(what.*time|time.*now)/.test(t)) return `🕐 It's **${new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}**.`;
  if (/(what.*(date|day)|today.*date)/.test(t)) return `📅 Today is **${new Date().toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" })}**.`;
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
    // Verified working with the built-in key (2026-09-26). The rerank model
    // (llama-nemotron-rerank-vl) is a search tool, not chat — excluded.
    // TTS models (deepgram/flux-tts, qwen-audio-tts, seed-audio) are blocked
    // from the chat endpoint by OpenRouter — they need a separate TTS route.
    { id: "nvidia/nemotron-3-ultra-550b-a55b:free", label: "Nemotron 3 Ultra 550B · FREE — huge ⭐" },
    { id: "nvidia/nemotron-3-super-120b-a12b:free", label: "Nemotron 3 Super 120B · FREE" },
    { id: "nvidia/nemotron-3.5-lightning:free", label: "Nemotron 3.5 Lightning · FREE — fast ⚡" },
    { id: "inclusionai/ling-3.0-flash-fin:free", label: "Ling 3.0 Flash · FREE" },
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
    // Verified working live (2026-09-26). Groq = OpenAI-compatible, absurdly fast.
    { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B — smartest, blazing fast ⚡" },
    { id: "openai/gpt-oss-20b", label: "GPT-OSS 20B — instant ⚡" },
    { id: "qwen/qwen3.8-27b", label: "Qwen 3.8 27B — smart" },
    { id: "allam-2-7b", label: "ALLAM 2 7B — light" },
  ],
  ollama: [
    // Filled live from /api/ollama/models when the laptop runs Ollama.
    // Fallback shown if discovery hasn't run yet.
    { id: "llama3.2", label: "llama3.2 — local (install via Ollama)" },
  ],
  tokenharbor: [
    // Verified working live (2026-09-26). Paid TH models (gpt-5.5, claude-sonnet-5,
    // gemini-3.6-flash via TH) were removed — the shared TH wallet is $0 → HTTP 402.
    { id: "qwen3.8-flash:free", label: "Qwen 3.8 Flash · FREE — fast & smart ⭐" },
    { id: "deepseek-v4.1-flash:free", label: "DeepSeek v4.1 Flash · FREE" },
    { id: "mimo-v2.6-flash:free", label: "MiMo v2.6 Flash · FREE" },
    { id: "mimo-v2.5:free", label: "MiMo v2.5 · FREE" },
    { id: "deepseek-v4-flash:free", label: "DeepSeek v4 Flash · FREE" },
  ],
  bai: [
    // NOTE: B.AI needs its own key; entries hidden from the picker until a key is set.
    { id: "glm-5.3-flash", label: "GLM 5.3 Flash" },
    { id: "qwen3.8-flash", label: "Qwen 3.8 Flash" },
    { id: "mimo-v2.5", label: "MiMo v2.5" },
    { id: "deepseek-v4.1-flash", label: "DeepSeek v4.1 Flash" },
  ],
};

/* Built-in API keys (the owner's own). Pre-provisioned so the Settings modal
   stays clean — no key fields needed. All verified working 2026-09-26.
   NOTE: the old AQ.… Gemini keys died (Google revokes those OAuth-style tokens;
   real Gemini keys start with AIza). Gemini is now bring-your-own-key. */
const BUILTIN_KEYS = {
  tokenharbor: [
    "thk_live_yDGvE-Z4hkMmDYyXiBjcdPX0TeLLqZ2sLBNSSFL_QHsCLt_s3ZQXebWH7U8SNEBV", // verified
    "thk_live_vsHtKzxRrFCfiP8X9qimjhhAjgwaTvWU6EThu8sTiu5f9krij6XfQeJZQp_o9r6P", // verified
  ],
  groq: "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", // verified
  openrouter: "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", // verified ($0 free-tier)
};
// Ollama runs locally — no key. getKey() needs no entry for provider "ollama".

let TH_KEY_INDEX = 0; // rotates when a key fails (see callAI failover)
function getKey() {
  if (state.apiKey) return state.apiKey;
  if (state.provider === "tokenharbor") {
    const keys = BUILTIN_KEYS.tokenharbor;
    return keys[TH_KEY_INDEX % keys.length];
  }
  if (state.provider === "groq") return BUILTIN_KEYS.groq;
  if (state.provider === "openrouter") return BUILTIN_KEYS.openrouter;
  return "";
}

/* ---------------- Element refs ---------------- */
const el = {
  menu: $("#btn-menu"), sidebar: $("#sidebar"), scrim: $("#scrim"),
  messages: $("#messages"), input: $("#input"), send: $("#btn-send"),
  mic: $("#btn-mic"), listen: null, speak: null,
  newChat: $("#btn-new-2"), settings: $("#btn-settings"),
  settingsModal: $("#settings-modal"), closeSettings: $("#btn-close-settings"),
  saveSettings: $("#btn-save-settings"), wipe: $("#btn-wipe"),
  setProvider: $("#set-provider"), setKey: $("#set-key"), setModel: $("#set-model"),
  fieldKey: $("#field-key"), fieldModel: $("#field-model"),
  setNickname: $("#set-nickname"), setAutospeak: $("#set-autospeak"),
  setStudyStrict: $("#set-study-strict"), keyHelp: $("#key-help"),
  history: $("#history"), install: $("#btn-install"),
  modeChip: $("#mode-chip"), netDot: $("#net-dot"),
  modelDD: $("#model-dd"), modelDDBtn: $("#model-dd-btn"), modelDDMenu: $("#model-dd-menu"),
  home: $("#home"), homeSlot: $("#home-slot"), greetNick: $(".greet-nick"), composer: $(".composer"),
  homeContinue: null, btnHome: $("#btn-home-4") || $("#btn-home-3") || $("#btn-home-2"),
  attach: $("#btn-attach"), attachMenu: $("#attach-menu"), attachTray: $("#attachments"),
  fileImg: $("#file-img"), fileCam: $("#file-cam"), fileDoc: $("#file-doc"), fileFolder: $("#file-folder"),
  wave: $("#wave"), waveBars: $("#wave-bars"), waveText: $("#wave-text"),
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

/* Soft ripple from the click point on any .icon-btn / .send-btn / .chip */
function addRipple(e) {
  const btn = e.currentTarget;
  if (!btn) return;
  const r = btn.getBoundingClientRect();
  const x = (e.clientX || r.left + r.width / 2) - r.left;
  const y = (e.clientY || r.top + r.height / 2) - r.top;
  const dot = document.createElement("span");
  dot.className = "ripple";
  dot.style.left = x + "px";
  dot.style.top = y + "px";
  btn.appendChild(dot);
  setTimeout(() => dot.remove(), 700);
}
function wireRipples() {
  document.querySelectorAll(".icon-btn, .tool-btn, .send-btn, .chip, .quick-btn, .install-btn, .primary-btn")
    .forEach((b) => { b.classList.add("ripple-host"); b.addEventListener("pointerdown", addRipple); });
}

/* Re-bind ripples after dynamic re-renders (debounced, same frame) */
let rippleTimer = null;
function renderRipplesSoon() {
  if (rippleTimer) return;
  rippleTimer = setTimeout(() => { rippleTimer = null; wireRipples(); }, 80);
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

let lastChatCount = -1;
function renderHistory() {
  if (chatCount !== lastChatCount) { lastChatCount = chatCount; renderRipplesSoon(); }
  el.history.innerHTML = "";
  const chats = Object.values(state.chats).sort((a, b) => b.ts - a.ts);
  for (const c of chats) {
    const div = document.createElement("div");
    div.className = "history-item" + (c.id === state.currentId ? " active" : "");
    const span = document.createElement("span");
    span.className = "h-title";
    span.textContent = `${c.title}`;
    const del = document.createElement("span");
    del.className = "del";
    del.textContent = "✕";
    del.onclick = (e) => { e.stopPropagation(); deleteChat(c.id); };
    div.append(span, del);
    div.onclick = () => openChat(c.id);
    el.history.appendChild(div);
  }
}

function renderMessages() {
  el.messages.innerHTML = "";
  const chat = currentChat();
  el.modeChip.textContent = MODE_LABELS[chat.mode] || "Chat";
  if (!chat.messages.length) {
    const hi = document.createElement("div");
    hi.className = "msg sys";
    const knowYou = !state.profile.asked && !state.profile.name && !state.profile.facts.length;
    hi.innerHTML = `<div class="bubble">${renderMd(
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
  chat.messages.forEach((m, i) => {
    const bub = addBubble(m.role, m.content, false);
    bub.parentElement.style.setProperty("--i", i);
  });
  scrollBottom();
}

function addBubble(role, content, animate = true) {
  const wrap = document.createElement("div");
  wrap.className = "msg " + (role === "user" ? "user" : "ai");
  const av = document.createElement("div");
  av.className = "avatar";
  av.textContent = role === "user" ? "🧑" : "✦";
  const bub = document.createElement("div");
  bub.className = "bubble";
  bub.innerHTML = renderMd(content);
  wrap.append(av, bub);
  el.messages.appendChild(wrap);
  if (animate) scrollBottom();
  return bub;
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
  if (provider !== "pollinations" && provider !== "lite" && provider !== "ollama" && !apiKey) throw new Error("NO_KEY");

  if (provider === "pollinations") {
    return await callFreeAI(messages, onDelta, true);
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
  // Key failover: rotate through spare built-in keys on auth/balance errors
  const spares = BUILTIN_KEYS[provider] || [];
  const rotatable = Array.isArray(spares) && spares.length > 1;
  if (rotatable && !res.ok) {
    const errText = await readErr(res);
    if (/401|403|402|quota|credit|balance|invalid/i.test(errText)) {
      for (const spare of spares) {
        if (spare === apiKey) continue;
        res = await doCall(spare);
        if (res.ok) {
          TH_KEY_INDEX = spares.indexOf(spare); // stick with the working key
          break;
        }
      }
    }
  }
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
    const res = await fetch(url, {
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
    return await attempt("/api/chat", stream);
  } catch (proxyErr) {
    try {
      return await attempt("https://text.pollinations.ai/openai", false);
    } catch {
      throw new Error("Can't reach the AI relay — the local server isn't running. Open a terminal in the Nova folder and run: python serve.py — then open http://localhost:8080");
    }
  }
}

function friendlyError(err) {
  if (err instanceof TypeError && /fetch/i.test(err.message || "")) {
    return "Can't reach the AI relay — if you opened Nova as a file, run the server instead: `python serve.py` → open http://localhost:8080. If it's already running, check your internet.";
  }
  return err.message;
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
  x: "https://twitter.com", facebook: "https://facebook.com",
  chatgpt: "https://chatgpt.com", github: "https://github.com",
  linkedin: "https://linkedin.com", reddit: "https://reddit.com",
  calendar: "https://calendar.google.com", keep: "https://keep.google.com",
  "play store": "https://play.google.com/store",
  amazon: "https://amazon.com", flipkart: "https://flipkart.com",
};

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
      const last = el.messages.lastChild.querySelector(".bubble");
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
      wrap.innerHTML = `<div class="avatar">💻</div><div class="bubble">🖥️ Laptop screenshot:<br><img src="${r.image}" alt="laptop screenshot" style="max-width:100%;border-radius:10px;margin-top:6px"></div>`;
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

  return false; // not a command → send to AI
}

/* ---------------- Study specials: flashcards & quiz ---------------- */
async function callAIOnce(messages) {
  const { provider, model } = state;
  const apiKey = getKey();
  if (provider !== "pollinations" && provider !== "lite" && provider !== "ollama" && !apiKey) throw new Error("NO_KEY");

  if (provider === "pollinations") {
    const res = await fetch("/api/chat", {
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
    row.innerHTML = `<div class="avatar">🃏</div><div class="bubble"><b>Q${idx + 1}.</b> ${renderMd(c.q)}<br><span class="reveal">_tap to reveal_</span></div>`;
    const b = row.querySelector(".bubble");
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

/* ---------------- Home screen (Gemini-style, our theme) ---------------- */
function showHome() {
  el.messages.classList.add("hidden");
  el.home.classList.remove("hidden");
  el.homeSlot.appendChild(el.composer);
  if (el.greetNick) el.greetNick.textContent = state.nickname;
  requestAnimationFrame(() => {
    el.home.classList.add("in");
    replayKineticHeadline();
    el.input.focus();
  });
}

function hideHome() {
  if (el.home.classList.contains("hidden")) return;
  el.home.classList.add("leaving");
  setTimeout(() => {
    el.home.classList.add("hidden");
    el.home.classList.remove("in", "leaving");
    el.messages.classList.remove("hidden");
    el.messages.after(el.composer); // dock composer back BELOW the messages
  }, 170);
}

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
/* ═══════ STARK HUD: Arc Reactor state machine + telemetry ═══════ */
const brandEl = document.getElementById("brand");
const telLat = document.getElementById("tel-lat");
const telFps = document.getElementById("tel-fps");
const telState = document.getElementById("tel-state");

/* Reactor states: idle | listening | processing | speaking | error.
   Drives: SVG animation, background vortex, telemetry label. */
let hudState = "idle";
function setHudState(s) {
  if (s === hudState) return;
  hudState = s;
  if (brandEl) brandEl.dataset.mode = s;
  if (telState) { telState.textContent = s.toUpperCase(); telState.className = ""; if (s !== "idle") telState.id = "tel-state"; }
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

/* ═══════ Motion engine (phone-safe) ═══════ */
const isTouch = matchMedia("(hover: none), (pointer: coarse)").matches;

/* Magnetic buttons: elements lean toward the cursor, spring back on leave. */
(function initMagnetic() {
  if (isTouch) return;
  const STRENGTH = 0.32;
  const magnetize = (elx) => {
    if (elx.dataset.magnetized) return;
    elx.dataset.magnetized = "1";
    elx.classList.add("magnetic");
    elx.addEventListener("pointermove", (e) => {
      const r = elx.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      elx.style.transform = `translate(${dx * STRENGTH}px, ${dy * STRENGTH}px)`;
    });
    elx.addEventListener("pointerleave", () => { elx.style.transform = ""; });
  };
  const wire = () => document.querySelectorAll(".send-btn, .tool-btn, .icon-btn, .primary-btn").forEach(magnetize);
  wire();
  new MutationObserver(wire).observe(document.body, { childList: true, subtree: true });
})();

/* Scroll reveals: any .reveal element fades/rises when it enters the viewport. */
(function initReveals() {
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
  }, { threshold: 0.12 });
  const scan = () => document.querySelectorAll(".reveal:not(.in)").forEach((n) => io.observe(n));
  scan();
  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
})();

/* Re-run the kinetic headline entrance each time the home screen shows. */
function replayKineticHeadline() {
  const words = document.querySelectorAll(".kinetic-headline .k-word");
  words.forEach((w) => {
    w.style.animation = "none";
    void w.offsetWidth; // reflow restarts the animation
    w.style.animation = "";
  });
}

/* ═══════ JARVIS MODE — full-screen voice HUD with a liquid energy orb ═══════ */
let jarvisOverlayOpen = false;
let jarvisRAF = 0;
const jEl = {};
const j$ = (id) => document.getElementById(id);

/* The orb: a 2D metaball-style liquid sphere whose perimeter deforms with
   live mic frequency data — smooth at idle, violent when you speak. */
function startOrb() {
  const cv = jEl.orb;
  const ctx = cv.getContext("2d");
  const W = cv.width, H = cv.height;
  const CXO = W / 2, CYO = H / 2, R = W * 0.185;
  const PTS = 96;
  const noiseSeeds = Array.from({ length: PTS }, () => Math.random() * Math.PI * 2);
  let phase = 0;
  const freq = new Uint8Array(128);

  const draw = (now) => {
    jarvisRAF = requestAnimationFrame(draw);
    if (!waveAnalyser) { /* still draw idle motion */ }
    if (waveAnalyser) waveAnalyser.getByteFrequencyData(freq);
    const t = now / 1000;
    phase += 0.012;

    // live loudness 0..1 from the voice band
    let sum = 0, peakI = 0;
    for (let i = 2; i < 48; i++) { sum += freq[i]; if (freq[i] > freq[peakI]) peakI = i; }
    const level = Math.min(1, (sum / 46) / 120);
    const peakHz = Math.round(peakI * (waveCtx ? waveCtx.sampleRate : 44100) / 256);

    // telemetry
    if (jEl.db) jEl.db.textContent = (level > 0.005 ? (20 * Math.log10(level)).toFixed(0) : "-∞") + " dB";
    if (jEl.peak) jEl.peak.textContent = peakHz + " Hz";

    ctx.clearRect(0, 0, W, H);

    // ambient halo
    const halo = ctx.createRadialGradient(CXO, CYO, R * 0.4, CXO, CYO, R * 2.6);
    halo.addColorStop(0, "rgba(56,189,248,0.16)");
    halo.addColorStop(0.55, "rgba(56,189,248,0.05)");
    halo.addColorStop(1, "rgba(56,189,248,0)");
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, W, H);

    // liquid perimeter: radius modulated by voice + traveling noise waves
    const deform = 1 + level * 0.55;
    ctx.beginPath();
    for (let i = 0; i <= PTS; i++) {
      const a = (i / PTS) * Math.PI * 2;
      const w1 = Math.sin(a * 3 + phase * 2.1 + noiseSeeds[i % PTS]) * 0.030;
      const w2 = Math.sin(a * 5 - phase * 1.4) * 0.018;
      const w3 = Math.sin(a * 8 + phase * 3.2) * 0.010 * (0.4 + level);
      const rr = R * deform * (1 + w1 + w2 + w3 + level * 0.10 * Math.sin(a * 2 + t * 6));
      const x = CXO + Math.cos(a) * rr;
      const y = CYO + Math.sin(a) * rr;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath();

    // glass-liquid fill
    const body = ctx.createRadialGradient(CXO - R * 0.25, CYO - R * 0.35, R * 0.1, CXO, CYO, R * 1.35);
    body.addColorStop(0, "rgba(190,240,255,0.32)");
    body.addColorStop(0.45, "rgba(56,189,248,0.20)");
    body.addColorStop(0.8, "rgba(14,60,110,0.28)");
    body.addColorStop(1, "rgba(3,10,24,0.05)");
    ctx.fillStyle = body;
    ctx.fill();
    ctx.strokeStyle = "rgba(125,211,252,0.85)";
    ctx.lineWidth = 2;
    ctx.stroke();

    // inner core glow reacts to level
    const core = ctx.createRadialGradient(CXO, CYO, 2, CXO, CYO, R * (0.55 + level * 0.5));
    core.addColorStop(0, "rgba(240,252,255,0.95)");
    core.addColorStop(0.35, "rgba(125,211,252,0.55)");
    core.addColorStop(1, "rgba(56,189,248,0)");
    ctx.fillStyle = core;
    ctx.beginPath(); ctx.arc(CXO, CYO, R * (0.62 + level * 0.5), 0, Math.PI * 2); ctx.fill();

    // frequency ring: thin bars orbiting the orb
    const barsN = 64;
    for (let i = 0; i < barsN; i++) {
      const v = freq[2 + Math.floor((i / barsN) * 60)] / 255;
      const a = (i / barsN) * Math.PI * 2 - phase * 0.6;
      const r1 = R * 1.38;
      const r2 = r1 + 4 + v * 46;
      ctx.strokeStyle = `rgba(56,189,248,${(0.10 + v * 0.6).toFixed(3)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(CXO + Math.cos(a) * r1, CYO + Math.sin(a) * r1);
      ctx.lineTo(CXO + Math.cos(a) * r2, CYO + Math.sin(a) * r2);
      ctx.stroke();
    }

    // haptic vibration on strong peaks + ripple spawn
    if (level > 0.55 && !jEl.stage.classList.contains("haptic")) {
      jEl.stage.classList.remove("haptic"); void jEl.stage.offsetWidth;
      jEl.stage.classList.add("haptic");
      spawnJripple();
    }
  };
  jarvisRAF = requestAnimationFrame(draw);
}

function spawnJripple() {
  if (!jEl.ripples) return;
  const i = document.createElement("i");
  jEl.ripples.appendChild(i);
  requestAnimationFrame(() => i.classList.add("go"));
  setTimeout(() => i.remove(), 1500);
}

function setJarvisStatus(txt) {
  if (jEl.status) jEl.status.textContent = txt;
}

/* Cross-device voice-state mirror (throttled, piggybacks the sync layer). */
let lastVoicePush = 0;
function setVoiceState(stateName, transcript) {
  const now = Date.now();
  if (now - lastVoicePush < 700) return;
  lastVoicePush = now;
  if (state.syncCode) {
    fetch("/api/sync", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: state.syncCode, device: deviceName(),
        payload: { voice: { state: stateName, transcript: (transcript || "").slice(0, 120), ts: now } } }),
    }).catch(() => {});
  }
}

async function openJarvis() {
  jEl.overlay = jEl.overlay || j$("jarvis");
  jEl.orb = jEl.orb || j$("jarvis-orb");
  jEl.status = jEl.status || j$("jarvis-status-text");
  jEl.transcript = jEl.transcript || j$("jarvis-transcript");
  jEl.ripples = jEl.ripples || j$("jarvis-ripples");
  jEl.stage = jEl.stage || document.querySelector(".jarvis-stage");
  jEl.db = jEl.db || j$("jt-db");
  jEl.peak = jEl.peak || j$("jt-peak");
  jEl.lat = jEl.lat || j$("jt-lat");
  jEl.dev = jEl.dev || j$("jt-dev");

  jarvisOverlayOpen = true;
  jEl.overlay.classList.remove("hidden");
  requestAnimationFrame(() => jEl.overlay.classList.add("open"));
  startOrb();

  // Ask for the mic BEFORE starting the voice loop, and make failures loud
  // with an exact fix instead of a silent dead overlay.
  let micOK = false;
  try {
    await ensureMic();
    micOK = true;
  } catch (err) {
    const name = err && err.name;
    if (name === "NotAllowedError" || name === "SecurityError") {
      setJarvisStatus("Mic blocked");
      if (jEl.transcript) jEl.transcript.textContent = "Click the 🔒 / mic icon in the address bar → allow Microphone → reload. (If you opened Nova via the LAN IP, use localhost instead — browsers block mics on non-secure origins.)";
      toast("Mic blocked — allow it in the address bar, then reload", "err");
    } else if (name === "NotFoundError") {
      setJarvisStatus("No microphone");
      if (jEl.transcript) jEl.transcript.textContent = "No microphone found on this device.";
    } else {
      setJarvisStatus("Mic unavailable");
      if (jEl.transcript) jEl.transcript.textContent = "Mic error: " + (name || "unknown") + " — try reloading.";
    }
    setVoiceState("mic-error");
    return; // do NOT start the voice loop without a mic
  }
  micGate(true);

  if (jEl.dev) {
    const paired = state.syncCode ? 2 : 1;
    jEl.dev.textContent = paired + (paired > 1 ? " synced" : " (pair in Settings)");
  }
  if (jEl.lat) jEl.lat.textContent = (telLat && telLat.textContent) || "--";

  setJarvisStatus("Listening");
  setVoiceState("listening");
  startVoiceChatInJarvis();
}

function closeJarvis() {
  jarvisOverlayOpen = false;
  jEl.overlay.classList.remove("open");
  setTimeout(() => jEl.overlay.classList.add("hidden"), 350);
  cancelAnimationFrame(jarvisRAF);
  endVoiceChat("JARVIS mode closed");
  micGate(false);
  setVoiceState("idle");
}

/* The existing voice loop runs inside the overlay; mirror its phases. */
function startVoiceChatInJarvis() {
  if (!SR) { toast("Voice needs Chrome/Edge", "warn"); return; }
  if (!voiceChat) { voiceChat = true; el.mic.classList.add("listening"); listenOnce(); }
  // hook phase updates
  const origSetWave = setWaveText;
  setWaveText = function (t) {
    origSetWave(t);
    if (!jarvisOverlayOpen) return;
    if (/listening/i.test(t)) setJarvisStatus("Listening");
    else if (/thinking/i.test(t)) setJarvisStatus("Analyzing voice");
    else if (t && t.startsWith("\u201c")) { setJarvisStatus("Heard you"); if (jEl.transcript) jEl.transcript.textContent = t.replace(/[\u201c\u201d]/g, ""); }
  };
}

/* ═══════ Telemetry: real FPS + real API latency, updated live ═══════ */
(function initTelemetry() {
  let frames = 0, lastT = performance.now();
  function fpsLoop(t) {
    frames++;
    if (t - lastT >= 1000) {
      if (telFps) telFps.textContent = frames + " fps";
      frames = 0; lastT = t;
    }
    requestAnimationFrame(fpsLoop);
  }
  requestAnimationFrame(fpsLoop);
})();

/* Wrap callAIOnce to measure true round-trip latency shown in the HUD. */
(function wrapLatency() {
  if (typeof callAI !== "function") return;
  const orig = callAI;
  callAI = async function (messages, onDelta) {
    const t0 = performance.now();
    try { return await orig(messages, onDelta); }
    finally { if (telLat) telLat.textContent = Math.round(performance.now() - t0) + " ms"; }
  };
})();

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
  wrap.innerHTML = `<div class="avatar">✦</div><div class="bubble"><span class="typing"><i></i><i></i><i></i></span></div>`;
  el.messages.appendChild(wrap);
  scrollBottom();
  return wrap.querySelector(".bubble");
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
function renderStream(bub, full) {
  streamText = full;
  bub.classList.add("streaming");
  bub.innerHTML = renderMd(full) + '<span class="cursor">▍</span>';
  scrollBottom();
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
let recog = null, recogForCommand = false;

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
  const u = new SpeechSynthesisUtterance(clean);
  if (jarvisVoice) u.voice = jarvisVoice;
  u.rate = 1.0; u.pitch = 0.82; u.volume = 1.0;   // the JARVIS depth
  u.onstart = () => { state.speaking = true; setHudState("speaking"); setVoiceState("speaking", clean.slice(0, 120)); };
  u.onend = () => {
    state.speaking = false;
    setTimeout(() => { if (!state.speaking && !state.busy) setHudState("idle"); }, 300); // echo-gate buffer
  };
  speechSynthesis.speak(u);
}

function speakNow(text) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(cleanForSpeech(text));
  if (jarvisVoice) u.voice = jarvisVoice;
  u.rate = 1.0; u.pitch = 0.82;
  u.onstart = () => { state.speaking = true; setHudState("speaking"); };
  u.onend = () => { state.speaking = false; setTimeout(() => { if (!state.speaking && !state.busy) setHudState("idle"); }, 300); };
  speechSynthesis.speak(u);
}

/* ═══════ PERSISTENT MICROPHONE ═══════
   getUserMedia runs ONCE; every listener reuses the same stream. Tracks are
   only disabled (enabled=false) when idle — no permission pop-ups, ever. */
let waveCtx = null, waveAnalyser = null, waveStream = null, waveRAF = 0;
const BAR_COUNT = 28;
let micOpening = null;   // single in-flight getUserMedia promise
let micDenied = false;   // a hard "no" this session — don't nag again

async function ensureMic() {
  if (micDenied) throw Object.assign(new Error("Microphone permission was denied — allow it in the address bar, then reload"), { name: "NotAllowedError" });
  if (waveStream && waveStream.active) return waveStream;
  if (micOpening) return micOpening;
  micOpening = (async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    waveStream = stream;
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

function buildWaveBars() {
  el.waveBars.innerHTML = "";
  for (let i = 0; i < BAR_COUNT; i++) {
    const b = document.createElement("i");
    b.style.setProperty("--d", `${(i % 7) * 60}ms`);
    el.waveBars.appendChild(b);
  }
}

async function startWave() {
  try {
    await ensureMic();
    micGate(true);
    const data = new Uint8Array(waveAnalyser.frequencyBinCount);
    const bars = el.waveBars.children;
    const loop = () => {
      if (!waveAnalyser) return;
      waveAnalyser.getByteFrequencyData(data);
      for (let i = 0; i < BAR_COUNT; i++) {
        const idx = 1 + Math.floor((i / BAR_COUNT) * (data.length - 2));
        const v = data[idx] / 255;
        const boosted = Math.pow(v, 0.75);
        const h = 18 + boosted * 78;
        bars[i].style.height = h.toFixed(1) + "%";
        bars[i].style.opacity = (0.55 + boosted * 0.45).toFixed(2);
      }
      waveRAF = requestAnimationFrame(loop);
    };
    loop();
  } catch { /* no mic permission — bars just idle-animate */ }
}

function stopWave() {
  cancelAnimationFrame(waveRAF);
  waveRAF = 0;
  micGate(false);                    // keep the stream, just mute it
  el.wave.classList.add("closing");
  setTimeout(() => { el.wave.classList.add("hidden"); el.wave.classList.remove("closing"); }, 220);
}

/* ---- Full voice conversation: talk → auto-send → spoken reply → listen again ---- */
let voiceChat = false;      // loop master switch
let voiceThinking = false;  // a reply is being fetched/spoken
let dictation = false;      // plain type-into-box mode

function setWaveText(t) { el.waveText.textContent = t; }

function startVoiceUI(phase) {
  buildWaveBars();
  el.wave.classList.remove("hidden");
  el.input.style.visibility = "hidden";
  el.send.style.visibility = "hidden";
  requestAnimationFrame(() => el.wave.classList.add("open"));
  setWaveText(phase);
  startWave();
}

function stopVoiceUI() {
  stopWave();
  el.input.style.visibility = "";
  el.send.style.visibility = "";
  el.mic.classList.remove("listening");
}

async function startMicDictation() {
  if (!SR) { toast("Voice input not supported in this browser", "warn"); return; }
  if (voiceChat) return endVoiceChat("Voice chat ended");
  if (state.busy || voiceThinking) { toast("One moment — still answering…", "warn"); return; }
  voiceChat = true;
  el.mic.classList.add("listening");
  await listenOnce();
}

/* One listen→think→speak cycle; re-arms itself while voiceChat is true. */
async function listenOnce() {
  if (!voiceChat || state.busy || voiceThinking) return;
  return new Promise((resolve) => {
    stopListening();
    recog = new SR();
    recog.lang = navigator.language || "en-US";
    recog.interimResults = true;
    recog.continuous = false;
    let finalText = "";
    let gotSpeech = false;

    startVoiceUI("Listening…");

    recog.onspeechstart = () => setWaveText("I'm listening…");
    recog.onresult = (e) => {
      gotSpeech = true;
      let interim = "";
      for (const r of e.results) {
        if (r.isFinal) finalText += r[0].transcript + " ";
        else interim += r[0].transcript;
      }
      if (interim || finalText) setWaveText("“" + (finalText + interim).trim().slice(-42) + "”");
    };
    recog.onend = async () => {
      const said = finalText.trim();
      if (!voiceChat) { stopVoiceUI(); return resolve(); }
      if (!said) {
        // silence — loop back to listening (unless Nova is mid-reply)
        if (voiceThinking || state.speaking) { resolve(); return; }
        setWaveText("Listening…");
        resolve();
        setTimeout(() => voiceChat && listenOnce(), 350);
        return;
      }
      // send it hands-free — gate the mic so Nova never hears itself
      voiceThinking = true;
      micGate(false);
      setWaveText("Thinking…");
      await handleSend(said, { fromVoice: true });
      voiceThinking = false;
      if (voiceChat) {
        // resume AFTER the reply finished speaking + a 300ms safety buffer
        const resume = () => { if (voiceChat) { micGate(true); setWaveText("Listening…"); listenOnce(); } };
        if (state.speaking) {
          const waitEnd = setInterval(() => {
            if (!state.speaking) { clearInterval(waitEnd); setTimeout(resume, 300); }
          }, 150);
          setTimeout(() => clearInterval(waitEnd), 30000); // hard cap
        } else {
          setTimeout(resume, 300);
        }
      }
      resolve();
    };
    recog.onerror = (ev) => {
      const code = ev && ev.error;
      if (code === "not-allowed" || code === "service-not-allowed") {
        // Permission denied for SpeechRecognition — tell the user exactly what to do.
        endVoiceChat("Mic blocked — click the 🔒 in the address bar → allow Microphone → reload");
        toast("Mic blocked — allow it in the address bar, then reload", "err");
        setVoiceState("mic-error");
      } else if (code === "no-speech") {
        if (voiceChat) { setWaveText("Listening…"); setTimeout(() => voiceChat && listenOnce(), 700); }
      } else if (code === "network") {
        endVoiceChat("Voice needs internet — check your connection");
      } else if (code === "audio-capture") {
        endVoiceChat("No microphone found");
      } else {
        if (voiceChat) { setWaveText("Listening…"); setTimeout(() => voiceChat && listenOnce(), 900); }
      }
      resolve();
    };
    try { recog.start(); } catch { resolve(); }
  });
}

function endVoiceChat(msg) {
  voiceChat = false;
  stopVoiceUI();
  stopListening();
  if (msg) toast(msg);
}

el.waveText.onclick = () => endVoiceChat("Voice chat ended ✓");

/* Hands-free: continuous listening for "<Nickname>, <command>"
   Upgraded: auto-rearms forever, routes the reactor, and can auto-start. */
function toggleHandsFree() {
  if (state.listening) { stopListening(); setHudState("idle"); return; }
  if (!SR) { toast("Hands-free needs Chrome/Edge (or Android Chrome)", "warn"); return; }
  recog = new SR();
  recog.lang = navigator.language || "en-US";
  recog.continuous = true;
  recog.interimResults = false;
  const nick = norm(state.nickname).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  el.listenBanner.classList.remove("hidden");
  el.wakeName.textContent = state.nickname;
  state.listening = true;
  setHudState("listening");

  recog.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (!e.results[i].isFinal) continue;
      const heard = norm(e.results[i][0].transcript);
      const rx = new RegExp(`(?:^|\\b)(?:hey\\s+)?${nick}\\b[,!\\s]*(.*)`);
      const m = heard.match(rx);
      if (m && m[1].trim().length > 1) {
        addBubble("user", `🎙️ “${e.results[i][0].transcript.trim()}”`);
        handleSend(m[1].trim());
      }
    }
  };
  recog.onend = () => {
    if (state.listening) { try { recog.start(); } catch { /* restarting */ } }
  };
  recog.onerror = (ev) => {
    if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
      toast("Mic blocked — click 🔒 in the address bar → allow Microphone → reload", "err");
      stopListening();
    } else if (ev.error === "network") {
      toast("Voice needs internet — retrying", "warn");
    }
  };
  try { recog.start(); toast(`Hands-free on — say “${state.nickname}, …”`, "ok"); }
  catch { stopListening(); }
}

function stopListening() {
  state.listening = false;
  el.listenBanner.classList.add("hidden");
  el.mic.classList.remove("listening");
  if (recog) { try { recog.stop(); } catch { /* ignore */ } recog = null; }
  setHudState("idle");
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

function openSettings() {
  el.setNickname.value = state.nickname;
  el.setAutospeak.checked = state.autospeak;
  el.setStudyStrict.checked = state.studyStrict;
  $("#set-memory").value = state.profile.facts.join("\n");
  $("#set-sync-code").value = state.syncCode;
  updateSyncStatus();
  fillModelSelect();
  refreshTHModels();
  el.settingsModal.classList.remove("hidden");
}

function updateSyncStatus() {
  const s = $("#sync-status");
  if (!s) return;
  s.textContent = state.syncCode ? `connected as “${state.syncCode}” · ${deviceName()}` : "not connected";
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
  if (state.provider === "pollinations") return "free";
  if (state.provider === "lite") return "lite";
  if (state.provider === "tokenharbor") return "th:" + state.model;
  if (state.provider === "openrouter") return "or:" + state.model;
  if (state.provider === "groq") return "gr:" + state.model;
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
  free: { name: "Free AI", tag: "NO KEY", cls: "dd-p-free" },
  lite: { name: "Nova Lite", tag: "OFFLINE", cls: "dd-p-lite" },
  gemini: { name: "Gemini", tag: "YOUR KEY", cls: "dd-p-gemini" },
  tokenharbor: { name: "Token Harbor", tag: "FREE", cls: "dd-p-th" },
  bai: { name: "B.AI", tag: "KEY", cls: "dd-p-bai" },
  openrouter: { name: "OpenRouter", tag: "FREE · BUILT-IN", cls: "dd-p-or" },
  groq: { name: "Groq", tag: "BUILT-IN", cls: "dd-p-groq" },
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

function renderModelMenu(filter = "") {
  const q = filter.trim().toLowerCase();
  el.modelDDMenu.innerHTML = "";
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
  el.modeChip.classList.remove("pop");
  void el.modeChip.offsetWidth; // restart the pop animation
  el.modeChip.classList.add("pop");
  document.querySelectorAll(".mode-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  if (chat.messages.length) addBubble("sys", `Switched to **${MODE_LABELS[mode]}** mode.`);
}

function autosize() {
  el.input.style.height = "auto";
  el.input.style.height = Math.min(el.input.scrollHeight, 140) + "px";
}

function wire() {
  el.menu.onclick = () => { el.sidebar.classList.toggle("open"); el.scrim.classList.toggle("show"); };
  const topHome = $("#btn-home-4");
  if (topHome) topHome.onclick = () => {
    el.sidebar.classList.remove("open"); el.scrim.classList.remove("show");
    state.currentId = null; // always land on the greeting screen
    LS.set("nova.currentId", null);
    renderMessages();
  };
  el.scrim.onclick = () => { el.sidebar.classList.remove("open"); el.scrim.classList.remove("show"); };
  el.brand.onclick = () => window.scrollTo(0, 0);

  el.send.onclick = () => handleSend(el.input.value);
  el.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(el.input.value); }
  });
  el.input.addEventListener("input", autosize);

  el.mic.onclick = () => openJarvis();
  el.listenStop.onclick = stopListening;
  const jExit = j$("jarvis-exit");
  if (jExit) jExit.onclick = closeJarvis;

  el.home.querySelectorAll(".chip").forEach((b) => { b.onclick = () => handleChip(b.dataset.chip); });
  el.btnHome.onclick = () => {
    el.sidebar.classList.remove("open"); el.scrim.classList.remove("show");
    state.currentId = null; // always land on the greeting screen
    LS.set("nova.currentId", null);
    renderMessages();
  };

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

  /* Mobile: mode buttons select on first tap (no hover flicker). */
  if (window.matchMedia("(hover: none)").matches) {
    document.querySelectorAll(".mode-btn, .quick-btn, .history-item").forEach((b) => b.classList.add("touch"));
  }
  el.settings.onclick = openSettings;
  const closeSettingsAnimated = () => {
    if (el.settingsModal.classList.contains("hidden")) return;
    el.settingsModal.classList.add("closing");
    setTimeout(() => {
      el.settingsModal.classList.add("hidden");
      el.settingsModal.classList.remove("closing");
    }, 200);
  };
  el.closeSettings.onclick = closeSettingsAnimated;
  el.saveSettings.onclick = saveSettings;
  el.wipe.onclick = () => {
    if (confirm("Erase all chats, notes, flashcards and settings on this device?")) {
      localStorage.clear(); location.reload();
    }
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

  document.querySelectorAll(".mode-btn").forEach((b) => {
    b.onclick = () => setMode(b.dataset.mode);
  });
  document.querySelectorAll(".quick-btn").forEach((b) => {
    b.onclick = () => { el.input.value = b.dataset.fill; el.input.focus(); autosize(); };
  });

  window.addEventListener("online", () => setNet(true));
  window.addEventListener("offline", () => setNet(false));
  setNet(navigator.onLine);

  // theme toggle on brand double-click
  let lastTap = 0;
  el.brand.ondblclick = () => {
    state.theme = state.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = state.theme;
    LS.set("nova.theme", state.theme);
  };

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

  // Auto-sync on start & when the tab regains focus (paired devices only)
  if (state.syncCode) {
    doSync(true);
    openSyncStream();
    document.addEventListener("visibilitychange", () => { if (!document.hidden) doSync(true); });
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
    _ts: Date.now(),
  };
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
    const res = await fetch("/api/sync?code=" + encodeURIComponent(state.syncCode));
    if (!res.ok) throw new Error("sync fetch failed");
    const remote = await res.json();
    applySynced(remote.data);
    if (!pushOnly) toast("⇅ Synced" + (remote.rev ? ` (rev ${remote.rev})` : ""), "ok");
  } catch { /* pull failed; still push below */ }
  try {
    const res = await fetch("/api/sync", {
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
    toast("Sync failed — is the server running? (python serve.py)", "err");
  }
}

let syncTimer = null;
function scheduleSync() {
  if (!state.syncCode) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => doSync(true), 2500); // debounced push after activity
}

/* Real-time-ish sync: poll the shared revision every 4s while the app is
   visible; if another device pushed, pull + merge instantly. Cheap: one
   tiny GET. */
let lastSeenRev = -1;
let syncSSE = null;

/* Instant push: a live SSE stream fires the moment another device pushes.
   Falls back to 4s polling if SSE is unavailable. */
function openSyncStream() {
  if (!state.syncCode || typeof EventSource === "undefined") return;
  if (syncSSE) { syncSSE.close(); syncSSE = null; }
  try {
    syncSSE = new EventSource("/api/sync/events?code=" + encodeURIComponent(state.syncCode));
    syncSSE.addEventListener("rev", (e) => {
      try {
        const { rev } = JSON.parse(e.data);
        if (lastSeenRev !== -1 && rev !== lastSeenRev) {
          fetch("/api/sync?code=" + encodeURIComponent(state.syncCode)).then((r) => r.json()).then((remote) => {
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
  try {
    const res = await fetch("/api/sync?code=" + encodeURIComponent(state.syncCode));
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
  const hosted = /^https?:\/\//.test(location.protocol) &&
    !/^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(location.hostname) &&
    !/\.local$/i.test(location.hostname);
  if (!hosted) return true;                       // local dev — no lock
  const token = LS.get("nova.lockToken", "");
  if (token) {
    try {
      const r = await fetch("/api/gate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
      if (r.status === 500) return true;          // gate not configured → fail open
      if (r.ok) {
        const j = await r.json();
        if (j.ok || j.configured) return true;    // token still valid
      }
    } catch { /* offline: trust the stored token */ return true; }
  } else {
    // no token yet — is the gate even configured?
    try {
      const probe = await fetch("/api/gate", { method: "GET" });
      if (probe.status === 500) return true;      // NOVA_PASS not set → open site
    } catch { /* offline hosted: fall through to lock */ }
  }
  // show lock screen
  const lock = document.getElementById("lock"), inp = document.getElementById("lock-pass"),
    go = document.getElementById("lock-go"), err = document.getElementById("lock-err"),
    hint = document.getElementById("lock-hint");
  if (!lock) return true;
  lock.classList.remove("hidden");
  try {
    const r = await fetch("/api/gate", { method: "GET" });
    const j = await r.json();
    if (j.hint) hint.textContent = "Hint: " + j.hint;
  } catch { /* hint optional */ }
  const attempt = async () => {
    err.textContent = "";
    try {
      const r = await fetch("/api/gate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pass: inp.value }) });
      if (r.status === 500) {
        // Gate not configured — don't trap the user; open with a hint.
        lock.classList.add("hidden");
        toast("Private gate not configured — set NOVA_PASS in Netlify to lock this site", "warn");
        init();
        return;
      }
      if (!r.ok) { err.textContent = "Wrong passcode — try again"; inp.value = ""; inp.focus(); return; }
      const j = await r.json();
      if (j.token) LS.set("nova.lockToken", j.token);
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
  healProviderMismatch();
  // Retired/limited saved models → snap to a working one.
  if (state.provider === "gemini" && !MODELS.gemini.some((m) => m.id === state.model)) {
    state.model = "gemini-3.6-flash";
    LS.set("nova.model", state.model);
  }
  el.messages.classList.add("chat-in");
  // Wake/check the AI relay once so problems surface with clear guidance, not mid-chat.
  if (location.protocol !== "file:" && state.provider === "pollinations") {
    fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openai", messages: [{ role: "user", content: "ping" }], stream: false }),
    }).then((r) => { if (!r.ok) throw 0; }).catch(() => {
      setTimeout(() => toast("⚠️ AI relay unreachable — run `python serve.py` in the Nova folder, then use http://localhost:8080. Nova Lite still works offline.", "warn"), 1200);
    });
  }
  document.documentElement.dataset.theme = state.theme;
  updateModelSelect();
  wire();
  renderHistory();
  renderMessages(); // after wire() so the home-screen wrapper is active
  updateQueueInfo();
  wireRipples();
  discoverOllama();
  const sendIcon = el.send.innerHTML; // remember the SVG arrow for busy-spin swaps
  el.send.dataset.icon = sendIcon;
  el.input.focus();
}

privateGate().then((open) => { if (open) init(); });
