// Vercel serverless function: proxies /api/chat to the free Pollinations AI.
// Pollinations blocks direct browser calls but allows server-to-server ones.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  try {
    const upstream = await fetch("https://text.pollinations.ai/openai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...(req.body || {}), stream: false }),
    });
    const data = await upstream.json();
    res.status(upstream.status).setHeader("Content-Type", "application/json").json(data);
  } catch (e) {
    res.status(502).json({ error: "proxy failed: " + e.message });
  }
}
