// Netlify Function: gate — password check for private Nova.
//
// Setup (one time, in Netlify):
//   Site configuration → Environment variables:
//     NOVA_PASS = <your secret password>
//     NOVA_HINT = <optional short hint>
//
// The site frontend (lock screen in app.js) POSTs { pass } here.
// Correct  -> 200 with a signed-ish token (HMAC of the password) that the
//             client stores in localStorage; offline sessions unlock with it.
// Wrong    -> 401.
//
// This is a lightweight personal gate — enough to keep strangers out of a
// URL only you know. For true multi-user security you'd add real auth.

export async function handler(event) {
  const PASS = process.env.NOVA_PASS || "";
  const HINT = process.env.NOVA_HINT || "";

  if (!PASS) {
    // Not configured — fail open-closed with guidance rather than leaking.
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "NOVA_PASS env var not set. Add it in Netlify → Site configuration → Environment variables." }),
    };
  }

  let pass = "";
  try {
    const body = typeof event.body === "string" ? JSON.parse(event.body || "{}") : (event.body || {});
    pass = String(body.pass || "");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "bad json" }) };
  }

  if (event.httpMethod === "GET") {
    return {
      statusCode: 200,
      body: JSON.stringify({ configured: true, hint: HINT }),
    };
  }

  if (pass === PASS) {
    // Lightweight token: constant-ish digest of the password + salt.
    const token = await digest(PASS + "::nova-private");
    return { statusCode: 200, body: JSON.stringify({ ok: true, token }) };
  }

  return { statusCode: 401, body: JSON.stringify({ ok: false, error: "wrong password" }) };
}

async function digest(s) {
  const data = new TextEncoder().encode(s);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
