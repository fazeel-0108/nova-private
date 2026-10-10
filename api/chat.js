// Vercel serverless function: server-side brain relay (mirrors Netlify).
// Provider keys live in environment variables — never in the frontend.
// Streaming: body.stream=true pipes the upstream SSE through chunk-by-chunk.
const POLLINATIONS = "https://text.pollinations.ai/openai";
const EP = {
  tokenharbor: "https://tokenharbor.ai/v1/chat/completions",
  groq: "https://api.groq.com/openai/v1/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  cleanapis: "https://cleanapis.com/v1/chat/completions",
};
const DEFAULT_MODEL = {
  // Kept in sync with relay/worker.js: TokenHarbor + CleanAPIs serve the
  // Claude line (the TokenHarbor ones need a balance — 402 without one).
  tokenharbor: "claude-fable-5.1",
  groq: "openai/gpt-oss-20b",
  openrouter: "nvidia/nemotron-3-super-120b-a12b:free",
  cleanapis: "claude-fable-5.1",
  pollinations: "openai",
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const body = req.body || {};
  const requested = body.provider || "auto";
  const wantStream = !!body.stream;
  const k = {
    tokenharbor: [process.env.TOKENHARBOR_KEY_1, process.env.TOKENHARBOR_KEY_2].filter(Boolean),
    groq: process.env.GROQ_KEY ? [process.env.GROQ_KEY] : [],
    openrouter: process.env.OPENROUTER_KEY ? [process.env.OPENROUTER_KEY] : [],
    cleanapis: process.env.CLEANAPIS_KEY ? [process.env.CLEANAPIS_KEY] : [],
  };
  const chain = requested === "tokenharbor" || requested === "groq" || requested === "openrouter" || requested === "cleanapis"
    ? [...(k[requested].length ? [{ provider: requested, endpoint: EP[requested], keys: k[requested], model: body.model && body.model !== "auto" ? body.model : DEFAULT_MODEL[requested] }] : []), { provider: "pollinations", endpoint: POLLINATIONS, keys: [""], model: DEFAULT_MODEL.pollinations }]
    : [{ provider: "pollinations", endpoint: POLLINATIONS, keys: [""], model: DEFAULT_MODEL.pollinations }, ...(k.groq.length ? [{ provider: "groq", endpoint: EP.groq, keys: k.groq, model: DEFAULT_MODEL.groq }] : [])];
  let lastErr = null;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const hop of chain) {
    for (const key of hop.keys) {
      // Free Pollinations pool rate-limits bursts (402/429/5xx) — retry a
      // couple of times with short backoff before moving on (see Netlify twin).
      const RETRIES = hop.provider === "pollinations" ? 2 : 0;
      for (let attempt = 0; attempt <= RETRIES; attempt++) {
        if (attempt) await sleep(400 + attempt * 400);
        try {
          const upstream = await fetch(hop.endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(key ? { Authorization: "Bearer " + key } : {}) },
            body: JSON.stringify({ model: hop.model, messages: body.messages || [], stream: wantStream }),
          });
          const ct = upstream.headers.get("content-type") || "";
          const meta = { requestedProvider: requested, requestedModel: body.model || null, actualProvider: hop.provider, actualModel: hop.model, fallbackUsed: requested !== "auto" && hop.provider !== requested };
          const metaB64 = Buffer.from(JSON.stringify(meta)).toString("base64");
          if (!upstream.ok) {
            const data = await upstream.json().catch(() => null);
            const err = new Error(String((data && data.error && (data.error.message || JSON.stringify(data.error))) || "HTTP " + upstream.status).slice(0, 180));
            err.retryable = upstream.status === 402 || upstream.status === 429 || upstream.status >= 500;
            throw err;
          }
          if (wantStream && ct.includes("event-stream") && upstream.body) {
            res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
            res.setHeader("Cache-Control", "no-store");
            res.setHeader("X-Accel-Buffering", "no");
            res.setHeader("X-Nova-Meta", metaB64);
            res.status(200);
            for await (const chunk of upstream.body) res.write(chunk);
            res.end();
            return;
          }
          const data = await upstream.json();
          if (data.error) throw new Error(String(data.error.message || JSON.stringify(data.error)).slice(0, 180));
          res.setHeader("X-Nova-Meta", metaB64);
          res.status(200).json({ ...data, meta });
          return;
        } catch (e) {
          lastErr = e.message;
          if (e.retryable === false) break;
        }
      }
    }
  }
  const friendly = /402|payment/i.test(lastErr || "")
    ? "The free AI pool (Pollinations) reported 'Payment Required' (402) — its shared quota is exhausted or your IP is temporarily rate-limited. Notes/commands still work. Options: retry in a minute, or add a free key (Groq console.groq.com/keys or aistudio.google.com/apikey) in Settings so Nova stops depending on the shared pool."
    : lastErr;
  res.status(502).json({ error: "all providers failed" + (friendly ? ": " + friendly : "") });
}
