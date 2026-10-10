/* ═══════════════════════════════════════════════════════════════════
   Nova relay — Cloudflare Worker (replaces the three Netlify functions).

   Serves the server-side routes the static frontend needs:
     POST /api/chat    AI relay. Provider keys live in Worker secrets —
                       they are NEVER sent to the browser.
     GET  /api/health  real provider probes (status + latency)
     GET/POST /api/sync  pairing store (D1) — merges chats/notes/memory
     GET/POST /api/gate  passcode gate + device registry (D1)

   Secrets (Freebuff Sites → Secrets):
     TOKENHARBOR_KEY_1, TOKENHARBOR_KEY_2, GROQ_KEY, OPENROUTER_KEY,
     CLEANAPIS_KEY, NOVA_PASS, (optional) NOVA_HINT

   Bindings: DB (D1) for sync + the device registry.
   ═══════════════════════════════════════════════════════════════════ */

const POLLINATIONS = "https://text.pollinations.ai/openai";
const EP = {
  tokenharbor: "https://tokenharbor.ai/v1/chat/completions",
  groq: "https://api.groq.com/openai/v1/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  cleanapis: "https://cleanapis.com/v1/chat/completions",
};
const DEFAULT_MODEL = {
  // 2026-10-10: TokenHarbor + CleanAPIs serve the Claude line only now. The
  // TokenHarbor ones are paid models (HTTP 402 on a $0 balance) — the chain
  // below still falls back to the keyless brain, so chat keeps answering.
  tokenharbor: "claude-fable-5.1",
  groq: "openai/gpt-oss-20b",
  openrouter: "nvidia/nemotron-3-super-120b-a12b:free",
  cleanapis: "claude-fable-5.1",
  pollinations: "openai",
};

/* Origins allowed to call this relay from a browser. The GitHub Pages site
   (and local dev) must be listed; anything else gets a hard 403. */
const DEFAULT_ORIGINS = [
  "https://fazeel-0108.github.io",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
  "http://localhost:8099", // local static-file testing of the published bundle
  "http://127.0.0.1:8099",
  "http://localhost:8788", // wrangler dev
  "http://127.0.0.1:8788",
];

function originAllowed(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return { origin: null, allowed: true }; // non-browser client (curl, serve.py)
  const list = String(env.APP_ORIGINS || DEFAULT_ORIGINS.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // The worker's own origin is always allowed: when the app is deployed as
  // this project's assets, its calls are same-origin and the browser still
  // sends an Origin header (which no allowlist should have to enumerate).
  const selfOrigin = new URL(request.url).origin;
  return { origin, allowed: origin === selfOrigin || list.includes(origin), list };
}

function corsHeaders(origin) {
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Expose-Headers": "X-Nova-Meta",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });

/* ---------------- D1: schema + helpers ---------------- */

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady || !env.DB) return;
  await env.DB.batch([
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS sync_store (
         code TEXT PRIMARY KEY,
         rev INTEGER NOT NULL DEFAULT 0,
         data TEXT NOT NULL DEFAULT '{}',
         devices TEXT NOT NULL DEFAULT '{}',
         updated INTEGER NOT NULL DEFAULT 0
       )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS gate_devices (
         id TEXT PRIMARY KEY, name TEXT, ip TEXT, seen INTEGER, ua TEXT
       )`
    ),
  ]);
  schemaReady = true;
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ---------------- /api/chat ---------------- */

async function callOpenAI(endpoint, key, model, messages, extra = {}, stream = false) {
  const headers = { "Content-Type": "application/json" };
  if (key) headers.Authorization = "Bearer " + key;
  return fetch(endpoint, {
    method: "POST",
    headers: { ...headers, ...extra },
    body: JSON.stringify({ model, messages, stream }),
  });
}

function chainFor(env, provider, model) {
  const k = {
    tokenharbor: [env.TOKENHARBOR_KEY_1, env.TOKENHARBOR_KEY_2].filter(Boolean),
    groq: env.GROQ_KEY ? [env.GROQ_KEY] : [],
    openrouter: env.OPENROUTER_KEY ? [env.OPENROUTER_KEY] : [],
    cleanapis: env.CLEANAPIS_KEY ? [env.CLEANAPIS_KEY] : [],
  };
  const poll = { provider: "pollinations", model: DEFAULT_MODEL.pollinations, endpoint: POLLINATIONS, keys: [""] };
  const modelFor = (prov) => (model && model !== "auto" ? model : DEFAULT_MODEL[prov]);
  const withKey = (prov, extra) =>
    k[prov].length
      ? [{ provider: prov, model: modelFor(prov), endpoint: EP[prov], keys: k[prov], extra }]
      : [];
  if (provider === "groq") return [...withKey("groq"), poll];
  if (provider === "openrouter")
    return [
      ...withKey("openrouter", { "HTTP-Referer": "https://nova.local", "X-Title": "Nova AI Assistant" }),
      poll,
    ];
  if (provider === "tokenharbor") return [...withKey("tokenharbor"), poll];
  if (provider === "cleanapis") return [...withKey("cleanapis"), poll];
  // "auto" + anything unknown: verified keyless brain first, then server keys.
  return [poll, ...withKey("groq")];
}

async function handleChat(body, env, cors) {
  const requested = body.provider || "auto";
  const stream = !!body.stream;
  const chain = chainFor(env, requested, body.model);
  let lastErr = null;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const hop of chain) {
    for (const key of hop.keys) {
      // The free Pollinations pool rate-limits bursts (402/429/5xx) — one
      // unlucky attempt shouldn't surface as an error. Retry briefly.
      const RETRIES = hop.provider === "pollinations" ? 2 : 0;
      for (let attempt = 0; attempt <= RETRIES; attempt++) {
        if (attempt) await sleep(400 + attempt * 400);
        try {
          const upstream = await callOpenAI(hop.endpoint, key, hop.model, body.messages || [], hop.extra || {}, stream);
          if (!upstream.ok) {
            const data = await upstream.json().catch(() => null);
            const msg =
              (data && data.error && (data.error.message || JSON.stringify(data.error))) || "HTTP " + upstream.status;
            const err = new Error(String(msg).slice(0, 180));
            err.retryable = upstream.status === 402 || upstream.status === 429 || upstream.status >= 500;
            throw err;
          }
          const ct = upstream.headers.get("content-type") || "";
          const meta = {
            requestedProvider: requested,
            requestedModel: body.model || null,
            actualProvider: hop.provider,
            actualModel: hop.model,
            fallbackUsed: requested !== "auto" && hop.provider !== requested,
          };
          const metaH = { "X-Nova-Meta": btoa(JSON.stringify(meta)) };
          if (stream && ct.includes("event-stream") && upstream.body) {
            return new Response(upstream.body, {
              status: 200,
              headers: {
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-store",
                "X-Accel-Buffering": "no",
                ...cors,
                ...metaH,
              },
            });
          }
          const data = await upstream.json();
          if (data.error) throw new Error(String(data.error.message || JSON.stringify(data.error)).slice(0, 180));
          return json({ ...data, meta }, 200, { ...cors, ...metaH });
        } catch (e) {
          lastErr = e.message;
          if (e.retryable === false) break;
        }
      }
    }
  }
  const friendly = /402|payment/i.test(lastErr || "")
    ? "The free AI pool (Pollinations) reported 'Payment Required' (402) — its shared quota is exhausted or this IP is temporarily rate-limited. Notes/commands still work. Retry in a minute, or add a free key (Groq console.groq.com/keys, Gemini aistudio.google.com/apikey) in Settings."
    : lastErr;
  return json({ error: "all providers failed" + (friendly ? ": " + friendly : "") }, 502, cors);
}

/* ---------------- /api/health ---------------- */

let HCACHE = null;
let HAT = 0;
const withTimeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms));

async function probe(endpoint, key, model) {
  const t0 = Date.now();
  try {
    const r = await Promise.race([
      callOpenAI(endpoint, key, model, [{ role: "user", content: "ping" }]),
      withTimeout(12000), // TokenHarbor legitimately takes 5-10s; 6s flagged it "broken"

    ]);
    if (!r.ok) throw new Error("status");
    await r.json().catch(() => null);
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch {
    return { ok: false, latencyMs: Date.now() - t0 };
  }
}

async function handleHealth(env, cors) {
  if (HCACHE && Date.now() - HAT < 300000) return json(HCACHE, 200, cors);
  const [pFree, pTH, pGr, pOr, pCa] = await Promise.all([
    probe(POLLINATIONS, "", DEFAULT_MODEL.pollinations),
    env.TOKENHARBOR_KEY_1 ? probe(EP.tokenharbor, env.TOKENHARBOR_KEY_1, DEFAULT_MODEL.tokenharbor) : Promise.resolve(null),
    env.GROQ_KEY ? probe(EP.groq, env.GROQ_KEY, DEFAULT_MODEL.groq) : Promise.resolve(null),
    env.OPENROUTER_KEY ? probe(EP.openrouter, env.OPENROUTER_KEY, DEFAULT_MODEL.openrouter) : Promise.resolve(null),
    env.CLEANAPIS_KEY ? probe(EP.cleanapis, env.CLEANAPIS_KEY, DEFAULT_MODEL.cleanapis) : Promise.resolve(null),
  ]);
  const st = (r) => (r === null ? "unconfigured" : r.ok ? (r.latencyMs > 8000 ? "limited" : "working") : "broken");
  const row = (provider, model, r) => ({
    provider,
    model,
    status: st(r),
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
  return json(HCACHE, 200, cors);
}

/* ---------------- /api/sync ---------------- */

const KEYS = ["ts", "id", "q", "text"];
function keyOf(x) {
  for (const k of KEYS) if (x && typeof x === "object" && k in x) return String(x[k]);
  return JSON.stringify(x);
}
function deepMerge(dst, src) {
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === "object" && !Array.isArray(v) && dst[k] && typeof dst[k] === "object" && !Array.isArray(dst[k])) {
      deepMerge(dst[k], v);
    } else if (Array.isArray(v) && Array.isArray(dst[k])) {
      if (v.length && typeof v[0] === "object") {
        const seen = new Map(dst[k].map((x) => [keyOf(x), x]));
        for (const item of v) {
          const kk = keyOf(item);
          const old = seen.get(kk);
          if (!old) seen.set(kk, item);
          else if (typeof item.ts === "number" && typeof old.ts === "number") {
            if (item.ts >= old.ts) seen.set(kk, item);
          } else seen.set(kk, item);
        }
        dst[k] = [...seen.values()];
      } else {
        dst[k] = [...new Set([...dst[k], ...v])];
      }
    } else {
      dst[k] = v;
    }
  }
}

async function readSync(env, code) {
  const row = await env.DB.prepare("SELECT rev, data, devices FROM sync_store WHERE code = ?").bind(code).first();
  if (!row) return { rev: 0, data: {}, devices: {} };
  const parse = (s, fb) => {
    try {
      return JSON.parse(s || "null") ?? fb;
    } catch {
      return fb;
    }
  };
  return { rev: row.rev || 0, data: parse(row.data, {}), devices: parse(row.devices, {}) };
}

async function handleSync(request, env, url, cors) {
  if (!env.DB) return json({ error: "sync storage not provisioned" }, 503, cors);
  await ensureSchema(env);
  let body = {};
  if (request.method === "POST") {
    try {
      body = await request.json();
    } catch {
      return json({ error: "bad json" }, 400, cors);
    }
  }
  const code = String(url.searchParams.get("code") || body.code || "").toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(code)) return json({ error: "bad code" }, 400, cors);

  if (request.method !== "POST") {
    const entry = await readSync(env, code);
    return json({ rev: entry.rev, data: entry.data }, 200, cors);
  }

  const payload = body.payload;
  if (!payload || typeof payload !== "object") return json({ error: "payload must be an object" }, 400, cors);

  const entry = await readSync(env, code);
  deepMerge(entry.data, payload);
  entry.devices[String(body.device || "dev").slice(0, 40)] = Date.now();
  const rev = entry.rev + 1;
  await env.DB.prepare(
    `INSERT INTO sync_store (code, rev, data, devices, updated) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET rev = excluded.rev, data = excluded.data, devices = excluded.devices, updated = excluded.updated`
  )
    .bind(code, rev, JSON.stringify(entry.data), JSON.stringify(entry.devices), Date.now())
    .run();
  return json({ ok: true, rev, data: entry.data }, 200, cors);
}

/* ---------------- /api/gate ---------------- */

function deviceLabel(ua) {
  const u = String(ua || "").toLowerCase();
  const phone = /android|iphone|ipad|mobile/.test(u);
  const kind = phone ? "Phone" : "Laptop";
  let browser = "Browser";
  if (u.includes("edg/")) browser = "Edge";
  else if (u.includes("chrome/")) browser = "Chrome";
  else if (u.includes("firefox/")) browser = "Firefox";
  else if (u.includes("safari/")) browser = "Safari";
  return `${kind} · ${browser}`;
}

async function handleGate(request, env, cors) {
  const PASS = env.NOVA_PASS || "";
  const HINT = env.NOVA_HINT || "";
  const ip = (request.headers.get("CF-Connecting-IP") || "unknown").trim();
  const ua = String(request.headers.get("User-Agent") || "").slice(0, 140);

  if (request.method === "GET") return json({ configured: !!PASS, hint: HINT }, 200, cors);

  let body = {};
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad json" }, 400, cors);
  }

  const devIdOf = () => sha256Hex((ip + "|" + ua).slice(0, 180)).then((h) => h.slice(0, 16));
  const remember = async (id, name) => {
    if (!env.DB) return;
    await ensureSchema(env);
    await env.DB.prepare(
      `INSERT INTO gate_devices (id, name, ip, seen, ua) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, ip = excluded.ip, seen = excluded.seen, ua = excluded.ua`
    )
      .bind(id, name, ip, Date.now(), ua)
      .run();
  };

  if (!PASS) {
    return json({ error: "NOVA_PASS is not set — add it in Sites → Secrets to lock this relay." }, 500, cors);
  }

  // Admin: list / revoke devices
  if (body.listAll) {
    if (body.adminPass !== PASS) return json({ ok: false, error: "wrong admin password" }, 401, cors);
    if (!env.DB) return json({ ok: true, devices: [] }, 200, cors);
    await ensureSchema(env);
    const { results } = await env.DB.prepare("SELECT id, name, ip, seen, ua FROM gate_devices ORDER BY seen DESC LIMIT 50").all();
    return json({ ok: true, devices: results || [] }, 200, cors);
  }
  if (body.revoke) {
    if (body.adminPass !== PASS) return json({ ok: false, error: "wrong admin password" }, 401, cors);
    if (env.DB) {
      await ensureSchema(env);
      await env.DB.prepare("DELETE FROM gate_devices WHERE id = ?").bind(String(body.revoke)).run();
    }
    return json({ ok: true, revoked: String(body.revoke) }, 200, cors);
  }

  // Verify a stored token (called on every load)
  if (body.token) {
    const token = await sha256Hex(PASS + "::nova-private");
    if (body.token !== token) return json({ ok: false, error: "bad token" }, 401, cors);
    const id = await devIdOf();
    await remember(id, deviceLabel(ua));
    return json({ ok: true, token, devId: id }, 200, cors);
  }

  // Password login
  if (String(body.pass || "") !== PASS) return json({ ok: false, error: "wrong password" }, 401, cors);
  const token = await sha256Hex(PASS + "::nova-private");
  const id = await devIdOf();
  await remember(id, deviceLabel(ua));
  return json({ ok: true, token, devId: id, name: deviceLabel(ua) }, 200, cors);
}

/* ---------------- router ---------------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const { origin, allowed } = originAllowed(request, env);
    const cors = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      if (!allowed) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: cors });
    }

    if (path.startsWith("/api/")) {
      if (!allowed) return json({ error: "origin not allowed" }, 403, cors);
      try {
        if (path === "/api/chat" && request.method === "POST") {
          const body = await request.json().catch(() => null);
          if (!body) return json({ error: "bad json" }, 400, cors);
          return await handleChat(body, env, cors);
        }
        if (path === "/api/health" && request.method === "GET") return await handleHealth(env, cors);
        if (path === "/api/sync") return await handleSync(request, env, url, cors);
        if (path === "/api/gate") return await handleGate(request, env, cors);
        return json({ error: "not found" }, 404, cors);
      } catch (e) {
        return json({ error: "relay error: " + String(e && e.message).slice(0, 200) }, 500, cors);
      }
    }

    // Static assets (a small landing page explaining the relay).
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return json({ ok: true, service: "nova-relay" }, 200, cors);
  },
};
