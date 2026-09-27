// Netlify Function: gate — password check + token verification + device registry
// for private Nova.
//
// Setup (one time, in Netlify):
//   Site configuration → Environment variables:
//     NOVA_PASS = <your secret password>
//     NOVA_HINT = <optional short hint>
//
// Endpoints (all via POST /api/gate with JSON body):
//   { pass: "..." }            -> verify password, returns token, registers device
//   { token: "..." }           -> verify stored token (device still allowed?)
//   { adminPass, listAll: 1 }  -> list devices with name, IP, last-seen
//   { adminPass, revoke: "<devId>" } -> remove a device (it must re-login)
//
// GET /api/gate -> { configured, hint }
//
// This is a lightweight personal gate — enough to keep strangers out of a
// URL only you know. For true multi-user security you'd add real auth.

const mem = new Map(); // devId -> { name, ip, seen, ua }

function devIdOf(ip, ua) {
  // Stable per-device id: hash(ip + UA family). Same device = same id.
  return digest((ip + "|" + ua).slice(0, 180)).then((h) => h.slice(0, 16));
}

async function digest(s) {
  const data = new TextEncoder().encode(s);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

export async function handler(event) {
  const PASS = process.env.NOVA_PASS || "";
  const HINT = process.env.NOVA_HINT || "";

  if (event.httpMethod === "GET") {
    return json(200, { configured: !!PASS, hint: HINT });
  }

  let body = {};
  try {
    body = typeof event.body === "string" ? JSON.parse(event.body || "{}") : (event.body || {});
  } catch {
    return json(400, { error: "bad json" });
  }

  const ip = (event.headers["x-forwarded-for"] || event.headers["client-ip"] || "").split(",")[0].trim() || "unknown";
  const ua = String(event.headers["user-agent"] || "").slice(0, 140);

  // ── Admin: list devices ─────────────────────────────────────────────
  if (body.listAll) {
    if (!PASS || body.adminPass !== PASS) return json(401, { ok: false, error: "wrong admin password" });
    const devices = [...mem.entries()].map(([id, d]) => ({
      id, name: d.name, ip: d.ip, seen: d.seen, ua: d.ua,
    })).sort((a, b) => b.seen - a.seen);
    return json(200, { ok: true, devices });
  }

  // ── Admin: revoke a device ──────────────────────────────────────────
  if (body.revoke) {
    if (!PASS || body.adminPass !== PASS) return json(401, { ok: false, error: "wrong admin password" });
    mem.delete(String(body.revoke));
    return json(200, { ok: true, revoked: String(body.revoke) });
  }

  // ── Verify a stored token (called on every load) ────────────────────
  if (body.token) {
    if (!PASS) return json(500, { error: "NOVA_PASS env var not set. Add it in Netlify → Site configuration → Environment variables." });
    const token = await digest(PASS + "::nova-private");
    if (body.token !== token) return json(401, { ok: false, error: "bad token" });
    // Valid — refresh this device's presence.
    const id = await devIdOf(ip, ua);
    const d = mem.get(id) || {};
    mem.set(id, { name: d.name || deviceLabel(ua), ip, seen: Date.now(), ua });
    return json(200, { ok: true, token, devId: id });
  }

  // ── Password login ──────────────────────────────────────────────────
  const pass = String(body.pass || "");
  if (!PASS) return json(500, { error: "NOVA_PASS env var not set. Add it in Netlify → Site configuration → Environment variables." });
  if (pass !== PASS) return json(401, { ok: false, error: "wrong password" });

  const token = await digest(PASS + "::nova-private");
  const id = await devIdOf(ip, ua);
  mem.set(id, { name: deviceLabel(ua), ip, seen: Date.now(), ua });
  return json(200, { ok: true, token, devId: id, name: deviceLabel(ua) });
}

// Friendly device label from the user-agent.
function deviceLabel(ua) {
  const u = ua.toLowerCase();
  const phone = /android|iphone|ipad|mobile/.test(u);
  const kind = phone ? "Phone" : "Laptop";
  let browser = "Browser";
  if (u.includes("edg/")) browser = "Edge";
  else if (u.includes("chrome/")) browser = "Chrome";
  else if (u.includes("firefox/")) browser = "Firefox";
  else if (u.includes("safari/")) browser = "Safari";
  return `${kind} · ${browser}`;
}
