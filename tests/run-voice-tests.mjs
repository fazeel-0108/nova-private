/* Runs the Nova voice lifecycle suite headlessly (CI-friendly).
 *
 *   node tests/run-voice-tests.mjs                 # the current app.js
 *   node tests/run-voice-tests.mjs old-app.js      # a previous build placed in site-dist/
 *
 * Serves the repo over HTTP, drives tests/voice-lifecycle.html in Chromium and
 * exits non-zero unless every assertion passed. No live microphone, no network.
 */
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import process from "node:process";

const ROOT = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const PORT = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 8096;
const APP_ARG = process.argv[2] || "";           // optional alt build inside site-dist/
const TIMEOUT_MS = 240000;

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    let file = join(ROOT, rel);
    const info = await stat(file).catch(() => null);
    if (!info) { res.writeHead(404); res.end("not found"); return; }
    if (info.isDirectory()) file = join(file, "index.html");
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(body);
  } catch (err) {
    res.writeHead(500); res.end("server error: " + err.message);
  }
});

function listen() {
  return new Promise((ok, bad) => {
    server.once("error", bad);
    server.listen(PORT, "127.0.0.1", ok);
  });
}

async function main() {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.error("Playwright is not installed. Run: npm i --no-save playwright && npx playwright install --with-deps chromium");
    process.exit(2);
  }

  await listen();
  const boundPort = server.address().port;   // 0 above means "any free port"
  const base = `http://127.0.0.1:${boundPort}`;
  const query = APP_ARG ? `?app=../site-dist/${APP_ARG}` : "";
  console.log(`serving ${ROOT} on ${base}`);
  console.log(`running ${base}/tests/voice-lifecycle.html${query}`);

  const browser = await chromium.launch({
    args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"],
  });
  let failed = [];
  let total = 0, passed = 0;
  try {
    const page = await browser.newPage();
    page.on("pageerror", (e) => console.error("page error:", e.message));
    await page.goto(`${base}/tests/voice-lifecycle.html${query}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__voiceTestDone === true, null, { timeout: TIMEOUT_MS });
    const detail = await page.evaluate(() => {
      const box = document.getElementById("voice-test-results");
      return { summary: window.__voiceTestSummary, list: box ? box.innerText.split("\n").filter((l) => l.trim()) : [] };
    });
    ({ total = 0, passed = 0, failed = [] } = detail.summary || {});
    for (const line of detail.list) if (/^(PASS|FAIL)/.test(line.trim())) console.log("  " + line.trim());
  } catch (err) {
    failed = [`runner: ${err.message}`];
    total = total || 0;
  } finally {
    await browser.close();
    server.close();
  }

  console.log(`\n${passed}/${total} assertions passed`);
  if (failed.length) {
    console.error("FAILED:");
    for (const f of failed) console.error("  - " + f);
    process.exit(1);
  }
  console.log("voice lifecycle suite: OK");
}

main().catch((err) => { console.error(err); process.exit(1); });
