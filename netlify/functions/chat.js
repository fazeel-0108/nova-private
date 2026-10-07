// Netlify Function: /api/chat relay + /api/health.
// Provider keys live ONLY in Netlify environment variables — never in the
// frontend, never in git. Migration 2026-10-07 (keys were previously shipped
// to every browser inside app.js).
//   TOKENHARBOR_KEY_1, TOKENHARBOR_KEY_2, GROQ_KEY, OPENROUTER_KEY
// Fallback chain: requested provider → verified keyless Pollinations.
// meta in the response tells the truth about what actually answered.

const POLLINATIONS = "https://text.pollinations.ai/openai";
const EP = {
  tokenharbor: "https://tokenharbor.ai/v1/chat/completions",
  groq: "https://api.groq.com/openai/v1/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  cleanapis: "https://cleanapis.com/v1/chat/completions",
};
const DEFAULT_MODEL = {
  tokenharbor: "deepseek-v4.1-flash:free",
  groq: "openai/gpt-oss-20b",
  openrouter: "nvidia/nemotron-3-super-120b-a12b:free",
  cleanapis: "deepseek-v4-flash-0731",
  pollinations: "openai",
};

const envKeys = () => ({
  tokenharbor: [process.env.TOKENHARBOR_KEY_1, process.env.TOKENHARBOR_KEY_2].filter(Boolean),
  groq: process.env.GROQ_KEY ? [process.env.GROQ_KEY] : [],
  openrouter: process.env.OPENROUTER_KEY ? [process.env.OPENROUTER_KEY] : [],
  cleanapis: process.env.CLEANAPIS_KEY ? [process.env.CLEANAPIS_KEY] : [],
});

const json = (code, obj) => ({
  statusCode: code,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(obj),
});

async function callOpenAI(endpoint, key, model, messages, extra = {}) {
  const headers = { "Content-Type": "application/json" };
  if (key) headers.Authorization = "Bearer " + key;
  const upstream = await fetch(endpoint, {
    method: "POST",
    headers: { ...headers, ...extra },
    body: JSON.stringify({ model, messages, stream: false }),
  });
  const data = await upstream.json().catch(() => null);
  if (!upstream.ok || !data || data.error) {
    const msg = (data && data.error && (data.error.message || JSON.stringify(data.error))) || "HTTP " + upstream.status;
    throw new Error(String(msg).slice(0, 180));
  }
  return data;
}

// Ordered fallback chain per requested provider. Only verified providers.
function chainFor(provider, model) {
  const k = envKeys();
  const poll = { provider: "pollinations", model: DEFAULT_MODEL.pollinations, endpoint: POLLINATIONS, keys: [""] };
  const pick = (list) => (model && model !== "auto" ? [model] : [DEFAULT_MODEL[list[0].provider]]);
  if (provider === "groq") {
    return [
      ...(k.groq.length ? [{ provider: "groq", model: pick(k.groq)[0], endpoint: EP.groq, keys: k.groq }] : []),
      poll,
    ];
  }
  if (provider === "openrouter") {
    return [
      ...(k.openrouter.length ? [{ provider: "openrouter", model: pick(k.openrouter)[0], endpoint: EP.openrouter, keys: k.openrouter, extra: { "HTTP-Referer": "https://nova.local", "X-Title": "Nova AI Assistant" } }] : []),
      poll,
    ];
  }
  if (provider === "tokenharbor") {
    return [
      ...(k.tokenharbor.length ? [{ provider: "tokenharbor", model: pick(k.tokenharbor)[0], endpoint: EP.tokenharbor, keys: k.tokenharbor }] : []),
      poll,
    ];
  }
  if (provider === "cleanapis") {
    return [
      ...(k.cleanapis.length ? [{ provider: "cleanapis", model: pick(k.cleanapis)[0], endpoint: EP.cleanapis, keys: k.cleanapis }] : []),
      poll,
    ];
  }
  // "auto" + anything unknown: verified keyless brain first, then server keys.
  return [poll, ...(k.groq.length ? [{ provider: "groq", model: pick(k.groq)[0], endpoint: EP.groq, keys: k.groq }] : [])];
}

async function handleChat(body) {
  const requested = body.provider || "auto";
  const chain = chainFor(requested, body.model);
  let lastErr = null;
  for (const hop of chain) {
    for (const key of hop.keys) {
      try {
        const data = await callOpenAI(hop.endpoint, key, hop.model, body.messages || [], hop.extra || {});
        const meta = {
          requestedProvider: requested,
          requestedModel: body.model || null,
          actualProvider: hop.provider,
          actualModel: hop.model,
          fallbackUsed: requested !== "auto" && hop.provider !== requested,
        };
        return json(200, { ...data, meta });
      } catch (e) {
        lastErr = e.message;
      }
    }
  }
  return json(502, { error: "all providers failed" + (lastErr ? ": " + lastErr : "") });
}

/* ---- /api/health: REAL probes, no secrets in the response ---- */
let HCACHE = null, HAT = 0;
const withTimeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms));
async function probe(endpoint, key, model) {
  const t0 = Date.now();
  try {
    await Promise.race([callOpenAI(endpoint, key, model, [{ role: "user", content: "ping" }]), withTimeout(6000)]);
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch {
    return { ok: false, latencyMs: Date.now() - t0 };
  }
}
async function handleHealth() {
  if (HCACHE && Date.now() - HAT < 300000) return json(200, HCACHE);
  const k = envKeys();
  const [pFree, pTH, pGr, pOr, pCa] = await Promise.all([
    probe(POLLINATIONS, "", DEFAULT_MODEL.pollinations),
    k.tokenharbor.length ? probe(EP.tokenharbor, k.tokenharbor[0], DEFAULT_MODEL.tokenharbor) : Promise.resolve(null),
    k.groq.length ? probe(EP.groq, k.groq[0], DEFAULT_MODEL.groq) : Promise.resolve(null),
    k.openrouter.length ? probe(EP.openrouter, k.openrouter[0], DEFAULT_MODEL.openrouter) : Promise.resolve(null),
    k.cleanapis.length ? probe(EP.cleanapis, k.cleanapis[0], DEFAULT_MODEL.cleanapis) : Promise.resolve(null),
  ]);
  const st = (r) => (r === null ? "unconfigured" : r.ok ? (r.latencyMs > 5800 ? "limited" : "working") : "broken");
  const row = (provider, model, r) => ({
    provider, model, status: st(r),
    latencyMs: r ? r.latencyMs : null,
    lastChecked: new Date().toISOString(),
  });
  HCACHE = {
    providers: [
      row("pollinations", DEFAULT_MODEL.pollinations, pFree),
      row("tokenharbor", DEFAULT_MODEL.tokenharbor, pTH),
      row("groq", DEFAULT_MODEL.groq, pGr),
      row("openrouter", DEFAULT_MODEL.openrouter, pOr),
      row("cleanapis", DEFAULT_MODEL.cleanapis, pCa),
    ],
    checkedAt: new Date().toISOString(),
  };
  HAT = Date.now();
  return json(200, HCACHE);
}

export async function handler(event) {
  const path = event.path || "";
  if (path.includes("health")) return handleHealth();
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  let body;
  try {
    body = typeof event.body === "string" ? JSON.parse(event.body || "{}") : event.body || {};
  } catch {
    return json(400, { error: "bad json" });
  }
  return handleChat(body);
}
