// Vercel serverless function: /api/sync — tiny shared store so paired
// devices (laptop <-> phone) merge chats, notes, flashcards and memory.
// In-memory per instance; fine for personal use on Vercel's free tier.
const mem = new Map(); // code -> { rev, data, devices }

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

export default async function handler(req, res) {
  let code = req.query?.code || "";
  let body = req.body || {};
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!code && body.code) code = body.code;
  code = String(code).toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(code)) {
    res.status(400).json({ error: "bad code" });
    return;
  }
  const entry = mem.get(code) || { rev: 0, data: {}, devices: {} };

  if (req.method === "POST") {
    const payload = body.payload;
    if (!payload || typeof payload !== "object") {
      res.status(400).json({ error: "payload must be an object" });
      return;
    }
    deepMerge(entry.data, payload);
    entry.devices[String(body.device || "dev").slice(0, 40)] = Date.now();
    entry.rev += 1;
    mem.set(code, entry);
    res.status(200).json({ ok: true, rev: entry.rev, data: entry.data });
    return;
  }

  res.status(200).json({ rev: entry.rev, data: entry.data });
}
