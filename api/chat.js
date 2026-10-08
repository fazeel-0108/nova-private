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
  tokenharbor: "deepseek-v4.1-flash:free",
  groq: "openai/gpt-oss-20b",
  openrouter: "nvidia/nemotron-3-super-120b-a12b:free",
  cleanapis: "deepseek-v4-flash-0731",
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
  for (const hop of chain) {
    for (const key of hop.keys) {
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
          throw new Error(String((data && data.error && (data.error.message || JSON.stringify(data.error))) || "HTTP " + upstream.status).slice(0, 180));
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
      } catch (e) { lastErr = e.message; }
    }
  }
  res.status(502).json({ error: "all providers failed" + (lastErr ? ": " + lastErr : "") });
}
