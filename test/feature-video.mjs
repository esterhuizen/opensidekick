// Records the raw material for the feature-tour video (assets/video-raw/):
//   page.webm  (800x720)  — the article the agent acts on, with a caption bar
//   panel.webm (480x720)  — the side panel driving it (ask-mode: permission card)
//   card-title.png / card-model.png / card-end.png (1280x720) — narration cards
// Assembly into feature-tour.mp4 happens in scripts/make-feature-video.sh.
//
// Deterministic (mock model). Run: xvfb-run -a node test/feature-video.mjs

import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { STORAGE_KEY } from "../src/common/constants.js";

const EXT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RAW_DIR = path.join(EXT_DIR, "assets", "video-raw");
fs.rmSync(RAW_DIR, { recursive: true, force: true });
fs.mkdirSync(RAW_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>The Quiet Comeback of RSS — Signalpost</title>
<style>
  body{font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1f2328;margin:0;background:#fff}
  header.site{border-bottom:1px solid #eee;padding:13px 26px;display:flex;justify-content:space-between;align-items:center}
  .logo{font-weight:800;letter-spacing:-.02em}
  nav a{margin-left:15px;color:#555;text-decoration:none;font-size:13.5px}
  main{max-width:620px;margin:0 auto;padding:24px 24px 90px}
  h1{font-size:28px;line-height:1.2;margin:0 0 8px;letter-spacing:-.02em}
  .byline{color:#888;font-size:13.5px;margin-bottom:20px}
  p{margin:0 0 15px}
  .news{margin-top:24px;padding:18px;border:1px solid #e6e6e9;border-radius:14px;background:#fafafb}
  .news h3{margin:0 0 10px;font-size:17px}
  .news form{display:flex;gap:8px}
  .news input{flex:1;padding:10px 12px;border:1px solid #d5d5db;border-radius:8px;font-size:15px}
  .news button{background:#4f46e5;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-weight:600;cursor:pointer}
  /* Caption bar baked into the recording (ffmpeg build lacks drawtext). */
  .cap{position:fixed;left:0;right:0;bottom:0;background:rgba(23,23,29,.88);color:#fff;
    font-size:15.5px;font-weight:600;padding:12px 20px;letter-spacing:.01em}
  .cap b{color:#b8b0ff}
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
  <div class="cap" id="cap">Ask in plain language — <b>it reads the page and acts, with your approval</b></div>
</body></html>`;

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
  for (const chunk of text.match(/.{1,7}/gs) || [text]) {
    send({ choices: [{ delta: { content: chunk } }] });
    await sleep(32);
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
  const typed = toolMsgs.some((m) => { try { return JSON.parse(m.content).ok && /alex/.test(m.content); } catch { return false; } });
  if (!typed) {
    const email = elements.find((e) => e.type === "email" || /email|you@/i.test(e.placeholder || ""));
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
        await sleep(750);
        if (d.kind === "text") await sseText(res, d.text);
        else sseToolCall(res, d.name, d.args);
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(8080, "127.0.0.1", () => r(server)));
}

// ---- Narration cards (brand gradient, 1280x720) ----
const CARD_CSS = `
  *{box-sizing:border-box;margin:0;padding:0}
  .card{width:1280px;height:720px;position:relative;overflow:hidden;color:#fff;
    background:linear-gradient(135deg,#4338ca 0%,#6d5ef0 55%,#8b7dff 100%);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    display:flex;flex-direction:column;justify-content:center;padding:0 96px}
  .card::after{content:"";position:absolute;top:-40%;right:-12%;width:66%;height:150%;
    background:radial-gradient(closest-side,rgba(255,255,255,.22),rgba(255,255,255,0))}
  .brand{display:flex;align-items:center;gap:16px;font-weight:800;font-size:36px;letter-spacing:-.02em}
  .mark{width:56px;height:56px;background:#fff;border-radius:22%;position:relative;display:inline-block}
  .mark i{position:absolute;inset:26%;border-radius:50%;border:6px solid #4f46e5}
  .tag{font-weight:800;letter-spacing:-.02em;line-height:1.05;font-size:64px;margin-top:26px}
  .sub{opacity:.92;font-weight:500;font-size:24px;margin-top:18px;max-width:36ch;line-height:1.45}
  .chips{display:flex;gap:13px;margin-top:30px;position:relative;z-index:1}
  .chip{border:1px solid rgba(255,255,255,.4);border-radius:99px;padding:8px 18px;font-size:18px;font-weight:600}
  .split{flex-direction:row;align-items:center;gap:56px}
  .split .left{flex:1}
  .split .tag{font-size:52px;margin-top:20px}
  .shot{flex:0 0 460px;height:560px;border-radius:16px;overflow:hidden;background:#fff;
    box-shadow:0 30px 70px rgba(0,0,0,.35);position:relative;z-index:1}
  .shot img{width:460px;display:block;margin-top:-120px}
`;

async function renderCard(context, html, outName) {
  const p = await context.newPage();
  await p.setViewportSize({ width: 1280, height: 720 });
  await p.setContent(`<style>${CARD_CSS}</style>${html}`, { waitUntil: "load" });
  await sleep(150);
  await p.screenshot({ path: path.join(RAW_DIR, outName), clip: { x: 0, y: 0, width: 1280, height: 720 } });
  await p.close();
  console.log("card →", outName);
}

async function main() {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensidekick-video-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    // All tabs share one headed window, and a viewport resize on any tab
    // re-sizes that window and clips the others' screencasts. So: one equal
    // viewport for every page — 640+640 hstacks to exactly 1280x720.
    viewport: { width: 640, height: 720 },
    recordVideo: { dir: RAW_DIR, size: { width: 640, height: 720 } },
    args: [
      "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check",
      "--window-size=1500,860", // headed window must exceed every viewport, or the screencast clips
      "--window-position=0,0",
      "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding", "--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling",
      '--host-resolver-rules=MAP signalpost.demo 127.0.0.1', // pretty URL for the on-camera permission card
      `--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`,
    ],
  });
  let pagePath = null, panelPath = null;
  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
    const extId = new URL(sw.url()).host;

    // Seed config: ask mode so the permission card appears on camera.
    const setup = await context.newPage();
    await setup.goto(`chrome-extension://${extId}/src/options/options.html`, { waitUntil: "load" });
    await setup.evaluate(([k, c]) => chrome.storage.local.set({ [k]: c }), [STORAGE_KEY, {
      providers: [{ id: "openrouter", name: "OpenRouter", type: "openai", baseUrl: `${base}/v1`, apiKey: "sk-or-demo", model: "your-model", models: ["your-model"] }],
      activeProviderId: "openrouter", activeModel: "your-model", sitePermissions: {},
      settings: { autonomy: "ask", maxSteps: 8, maxTokens: 512, temperature: 0.2, enableVision: false },
    }]);
    await setup.close();

    const testPage = await context.newPage();
    await testPage.goto(`http://signalpost.demo:8080/page`, { waitUntil: "load" });

    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extId}/src/sidepanel/sidepanel.html`, { waitUntil: "load" });
    await sleep(900); // settle on the empty panel

    // Type the task like a person, then send (target tab must be the article).
    await panel.click("#input");
    await panel.type("#input", "Add my email alex@example.com to the newsletter, but don't subscribe.", { delay: 26 });
    await sleep(350);
    await testPage.bringToFront();
    await panel.click("#send-btn");

    // The mutating step triggers the ask-mode permission card — approve it on camera.
    await panel.waitForSelector('.perm-card button[data-choice="once"]', { timeout: 20000 });
    await sleep(1500); // let the viewer read the card
    await panel.click('button[data-choice="once"]');

    // Wait for the run to finish, then hold the final frame.
    const started = Date.now();
    while (Date.now() - started < 25000) {
      const idle = await panel.$eval("#send-btn", (el) => !el.hidden).catch(() => false);
      const answered = await panel.$$eval(".msg.assistant", (n) => n.length).catch(() => 0);
      if (idle && answered > 0) break;
      await sleep(200);
    }
    await sleep(2600);

    pagePath = await testPage.video().path();
    panelPath = await panel.video().path();
    await testPage.close();
    await panel.close();

    // ---- Narration cards ----
    const scratch = "/tmp/claude-1000/-home-ubuntu-build-llm-chrome-plugin/17953f38-96f9-4839-9b66-2e90a5b69c79/scratchpad/testbtn.png";
    const shotUri = fs.existsSync(scratch) ? "data:image/png;base64," + fs.readFileSync(scratch).toString("base64") : null;

    await renderCard(context, `<div class="card">
      <div class="brand"><span class="mark"><i></i></span>OpenSidekick</div>
      <div class="tag">Your browser,<br/>any model.</div>
      <div class="sub">An open-source AI agent in Chrome's side panel. It reads the page you're on — and acts on it.</div>
    </div>`, "card-title.png");

    await renderCard(context, `<div class="card split">
      <div class="left">
        <div class="tag">Bring your<br/>own model</div>
        <div class="sub">Any OpenAI-compatible endpoint or the Anthropic API — hosted, or fully local via Ollama / LM Studio.</div>
        <div class="chips"><span class="chip">One-click model Test</span><span class="chip">tools ✓ &nbsp;vision ✓</span></div>
      </div>
      ${shotUri ? `<div class="shot"><img src="${shotUri}"/></div>` : ""}
    </div>`, "card-model.png");

    await renderCard(context, `<div class="card">
      <div class="brand"><span class="mark"><i></i></span>OpenSidekick</div>
      <div class="tag" style="font-size:56px">Free. Open source.<br/>Keys stay local.</div>
      <div class="sub">opensidekick.app &nbsp;·&nbsp; Chrome Web Store &nbsp;·&nbsp; MIT</div>
    </div>`, "card-end.png");
  } finally {
    await context.close();
    server.close();
  }
  fs.renameSync(pagePath, path.join(RAW_DIR, "page.webm"));
  fs.renameSync(panelPath, path.join(RAW_DIR, "panel.webm"));
  // Remove stray recordings (setup/card pages).
  for (const f of fs.readdirSync(RAW_DIR)) if (f.endsWith(".webm") && !["page.webm", "panel.webm"].includes(f)) fs.rmSync(path.join(RAW_DIR, f));
  fs.rmSync(userDataDir, { recursive: true, force: true });
  console.log("raw material in assets/video-raw/:", fs.readdirSync(RAW_DIR).join(", "));
}

main().catch((e) => { console.error("feature-video error:", e); process.exit(1); });
