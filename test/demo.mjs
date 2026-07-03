// Captures frames of the REAL extension running a task — the target page on the
// left, the OpenSidekick side panel on the right — for assembly into a hero GIF.
// Deterministic (mock model), so the demo is reproducible.
//
// Frames land in assets/demo-frames/ as NNN_page.png and NNN_panel.png.
// Then: scripts assemble them into assets/demo.gif (see scripts/make-demo-gif.py).
//
// Run (headless server): xvfb-run -a node test/demo.mjs

import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { STORAGE_KEY, MSG } from "../src/common/constants.js";

const EXT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VIDEO_DIR = path.join(EXT_DIR, "assets", "demo-raw");
fs.rmSync(VIDEO_DIR, { recursive: true, force: true });
fs.mkdirSync(VIDEO_DIR, { recursive: true });

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>The Quiet Comeback of RSS — Signalpost</title>
<style>
  body{font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1f2328;margin:0;background:#fff}
  header.site{border-bottom:1px solid #eee;padding:14px 28px;display:flex;justify-content:space-between;align-items:center}
  .logo{font-weight:800;letter-spacing:-.02em}
  nav a{margin-left:16px;color:#555;text-decoration:none;font-size:14px}
  main{max-width:640px;margin:0 auto;padding:26px 24px 40px}
  h1{font-size:30px;line-height:1.2;margin:0 0 8px;letter-spacing:-.02em}
  .byline{color:#888;font-size:14px;margin-bottom:22px}
  p{margin:0 0 16px}
  .news{margin-top:26px;padding:20px;border:1px solid #e6e6e9;border-radius:14px;background:#fafafb}
  .news h3{margin:0 0 10px;font-size:18px}
  .news form{display:flex;gap:8px}
  .news input{flex:1;padding:10px 12px;border:1px solid #d5d5db;border-radius:8px;font-size:15px}
  .news button{background:#4f46e5;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-weight:600;cursor:pointer}
</style></head>
<body>
  <header class="site"><span class="logo">Signalpost</span>
    <nav><a href="#">Latest</a><a href="#">Tech</a><a href="#">About</a></nav></header>
  <main>
    <h1>The Quiet Comeback of RSS</h1>
    <div class="byline">By Dana Okoro · 7 min read</div>
    <p>For years RSS was written off as a relic of the early blogosphere. Yet in 2026 the humble feed is quietly resurgent, powering newsletters, podcast apps, and a new wave of read-it-later tools.</p>
    <div class="news">
      <h3>Get the weekly Signalpost</h3>
      <form onsubmit="return false">
        <input id="email" type="email" placeholder="you@example.com" aria-label="Email address" />
        <button id="subscribe" type="button">Subscribe</button>
      </form>
    </div>
  </main>
</body></html>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sseHead(res) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "access-control-allow-origin": "*" });
}
function sseToolCall(res, name, argsObj) {
  sseHead(res);
  const send = (o) => res.write("data: " + JSON.stringify(o) + "\n\n");
  send({ choices: [{ delta: { role: "assistant" } }] });
  send({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c" + Date.now(), function: { name, arguments: JSON.stringify(argsObj) } }] } }] });
  send({ choices: [{ finish_reason: "tool_calls" }] });
  res.write("data: [DONE]\n\n");
  res.end();
}
async function sseText(res, text) {
  sseHead(res);
  const send = (o) => res.write("data: " + JSON.stringify(o) + "\n\n");
  send({ choices: [{ delta: { role: "assistant" } }] });
  // Stream in small pieces with a pause, so the answer visibly types out.
  for (const chunk of text.match(/.{1,7}/gs) || [text]) {
    send({ choices: [{ delta: { content: chunk } }] });
    await sleep(30);
  }
  send({ choices: [{ finish_reason: "stop" }] });
  res.write("data: [DONE]\n\n");
  res.end();
}

const CLOSE = "Done — I entered **alex@example.com** in the newsletter field and left it unsubmitted, so you can review before subscribing.";

function decide(messages) {
  const toolMsgs = messages.filter((m) => m.role === "tool");
  let elements = [];
  for (const m of toolMsgs) { try { const j = JSON.parse(m.content); if (Array.isArray(j.elements)) elements = j.elements; } catch {} }
  if (toolMsgs.length === 0) return { kind: "tool", name: "read_page", args: {} };
  if (toolMsgs.length === 1) {
    const email = elements.find((e) => e.type === "email" || /email|you@/i.test(e.placeholder || "") || /@/.test(e.placeholder || ""));
    return { kind: "tool", name: "type_text", args: { ref: email?.ref, text: "alex@example.com" } };
  }
  return { kind: "text", text: CLOSE };
}

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "*" }); return res.end(); }
    if (req.url === "/page") { res.writeHead(200, { "content-type": "text/html" }); return res.end(PAGE); }
    if (req.url.endsWith("/models")) { res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" }); return res.end(JSON.stringify({ data: [{ id: "your-model" }] })); }
    if (req.url.endsWith("/chat/completions") && req.method === "POST") {
      let body = ""; req.on("data", (c) => (body += c));
      req.on("end", async () => {
        let m = []; try { m = JSON.parse(body).messages || []; } catch {}
        const d = decide(m);
        await sleep(650); // simulate the model "thinking" so each step is visible
        if (d.kind === "text") await sseText(res, d.text);
        else sseToolCall(res, d.name, d.args);
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

const PAGE_W = 900, PANEL_W = 470, H = 800;

async function main() {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensidekick-demo-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: PANEL_W, height: H },
    recordVideo: { dir: VIDEO_DIR, size: { width: PANEL_W, height: H } },
    args: [
      "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check",
      // Keep backgrounded pages rendering at full rate so the panel video doesn't
      // freeze while the agent acts on the (foreground) target tab.
      "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding", "--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling",
      `--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`,
    ],
  });
  let panelVideoPath = null;
  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
    const extId = new URL(sw.url()).host;

    const testPage = await context.newPage();
    await testPage.setViewportSize({ width: PAGE_W, height: H });
    await testPage.goto(`${base}/page`, { waitUntil: "load" });

    const setup = await context.newPage();
    await setup.goto(`chrome-extension://${extId}/src/options/options.html`, { waitUntil: "load" });
    await setup.evaluate(([key, cfg]) => chrome.storage.local.set({ [key]: cfg }), [STORAGE_KEY, {
      providers: [{ id: "openrouter", name: "OpenRouter", type: "openai", baseUrl: `${base}/v1`, apiKey: "sk-or-demo", model: "your-model", models: ["your-model"] }],
      activeProviderId: "openrouter", activeModel: "your-model", sitePermissions: {},
      settings: { autonomy: "auto", maxSteps: 8, maxTokens: 512, temperature: 0.2, enableVision: false },
    }]);
    await setup.close();

    const panel = await context.newPage();
    await panel.setViewportSize({ width: PANEL_W, height: H });
    await panel.goto(`chrome-extension://${extId}/src/sidepanel/sidepanel.html`, { waitUntil: "load" });
    await sleep(500); // a beat on the empty panel

    await testPage.bringToFront(); // so the agent locks onto the article tab
    await panel.evaluate(([rt, t]) => chrome.runtime.sendMessage({ type: rt, task: t, newChat: true }),
      [MSG.RUN_TASK, "Add my email alex@example.com to the newsletter, but don't subscribe."]);
    await sleep(350); // let the worker capture the target tab
    await panel.bringToFront(); // then keep the panel foreground so it records fully

    // Wait for the run to finish (idle + an assistant answer), then hold a beat.
    const started = Date.now();
    while (Date.now() - started < 24000) {
      const idle = await panel.$eval("#send-btn", (el) => !el.hidden).catch(() => false);
      const answered = await panel.$$eval(".msg.assistant", (n) => n.length).catch(() => 0);
      if (idle && answered > 0) break;
      await sleep(200);
    }
    await sleep(2200); // hold the final frame so the answer is readable

    panelVideoPath = await panel.video().path();
    await panel.close(); // finalizes this page's video
  } finally {
    await context.close();
    server.close();
  }
  // Move the panel recording to a stable path for the GIF step.
  const dest = path.join(VIDEO_DIR, "panel.webm");
  if (panelVideoPath && fs.existsSync(panelVideoPath)) {
    fs.renameSync(panelVideoPath, dest);
    console.log("recorded panel video →", path.relative(EXT_DIR, dest));
  } else {
    console.error("no panel video produced");
    process.exit(1);
  }
  fs.rmSync(userDataDir, { recursive: true, force: true });
}

main().catch((e) => { console.error("Demo capture error:", e); process.exit(1); });
