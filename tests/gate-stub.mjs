/* Stub relay for the passcode-gate branches. Not part of the app.
 *
 *   node tests/gate-stub.mjs ok         # GET /api/gate -> 200 {"configured":false}
 *   node tests/gate-stub.mjs configured # GET /api/gate -> 200 {"configured":true}
 *   node tests/gate-stub.mjs down       # every route -> 503 (relay unreachable)
 *
 * Point the app at it from a hosted origin (non-localhost) with:
 *   localStorage.setItem("nova.relay", JSON.stringify("http://127.0.0.1:8098"))
 */
import http from "node:http";

const mode = process.argv[2] || "ok";
const PORT = 8098;

const server = http.createServer((req, res) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Expose-Headers": "X-Nova-Meta",
    "Cache-Control": "no-store",
  };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
  if (mode === "down") {
    res.writeHead(503, { "Content-Type": "text/plain" });
    res.end("Site temporarily unavailable");
    return;
  }
  if (req.url.startsWith("/api/gate")) {
    res.writeHead(200, { ...cors, "Content-Type": "application/json" });
    res.end(JSON.stringify(req.method === "GET"
      ? { configured: mode === "configured", hint: mode === "configured" ? "stub hint" : "" }
      : { ok: true, token: "stub-token", devId: "stubdev" }));
    return;
  }
  res.writeHead(404, cors); res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => console.log(`gate stub (${mode}) on http://127.0.0.1:${PORT}`));
