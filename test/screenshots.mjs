// Generates Chrome Web Store screenshots (1280x800) by driving the REAL
// extension UI in Chromium against a mock model, then composing each capture
// into a titled marketing scene.
//
// Output: assets/screenshots/01-act.png, 02-providers.png, 03-summarize.png
// Run (headless server): xvfb-run -a node test/screenshots.mjs

import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { STORAGE_KEY, MSG } from "../src/common/constants.js";

const EXT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(EXT_DIR, "assets", "screenshots");
fs.mkdirSync(OUT_DIR, { recursive: true });

// A realistic-looking page: an article with a newsletter form (for both the
// "act" and "summarize" stories).
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>The Quiet Comeback of RSS — Signalpost</title>
<style>
  body{font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1f2328;margin:0;background:#fff}
  header.site{border-bottom:1px solid #eee;padding:14px 32px;display:flex;justify-content:space-between;align-items:center}
  .logo{font-weight:800;letter-spacing:-.02em}
  nav a{margin-left:18px;color:#555;text-decoration:none;font-size:14px}
  main{max-width:720px;margin:0 auto;padding:36px 24px 60px}
  h1{font-size:34px;line-height:1.2;margin:0 0 8px;letter-spacing:-.02em}
  .byline{color:#888;font-size:14px;margin-bottom:28px}
  p{margin:0 0 18px}
  .news{margin-top:34px;padding:22px;border:1px solid #e6e6e9;border-radius:14px;background:#fafafb}
  .news h3{margin:0 0 10px;font-size:18px}
  .news form{display:flex;gap:8px}
  .news input{flex:1;padding:10px 12px;border:1px solid #d5d5db;border-radius:8px;font-size:15px}
  .news button{background:#4f46e5;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-weight:600;cursor:pointer}
</style></head>
<body>
  <header class="site"><span class="logo">Signalpost</span>
    <nav><a href="#">Latest</a><a href="#">Culture</a><a href="#">Tech</a><a href="#">About</a></nav></header>
  <main>
    <h1>The Quiet Comeback of RSS</h1>
    <div class="byline">By Dana Okoro · 7 min read</div>
    <p>For years RSS was written off as a relic of the early blogosphere. Yet in 2026 the humble feed is quietly resurgent, powering newsletters, podcast apps, and a new wave of read-it-later tools that put people back in control of what they see.</p>
    <p>The appeal is simple: no algorithm decides your feed, no account is required, and every source is a plain, portable file. As trust in centralized platforms erodes, that transparency has become a feature rather than a footnote.</p>
    <p>Developers are noticing too. Open standards mean anyone can build a reader in an afternoon, and the format's age is now a strength — decades of content are already available without a single API key.</p>
    <div class="news">
      <h3>Get the weekly Signalpost</h3>
      <form onsubmit="return false">
        <input id="email" type="email" placeholder="you@example.com" aria-label="Email address" />
        <button id="subscribe" type="button">Subscribe</button>
      </form>
    </div>
  </main>
</body></html>`;

// ---- Mock model: two scripted stories keyed off the user's request. ----
function sse(res, write) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "access-control-allow-origin": "*" });
  write((o) => res.write("data: " + JSON.stringify(o) + "\n\n"));
  res.write("data: [DONE]\n\n");
  res.end();
}
function sseToolCall(res, name, argsObj) {
  sse(res, (send) => {
    const args = JSON.stringify(argsObj);
    send({ choices: [{ delta: { role: "assistant" } }] });
    send({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c" + Date.now(), function: { name, arguments: args } }] } }] });
    send({ choices: [{ finish_reason: "tool_calls" }] });
  });
}
function sseText(res, text) {
  sse(res, (send) => {
    send({ choices: [{ delta: { role: "assistant" } }] });
    for (const chunk of text.match(/.{1,24}/gs) || [text]) send({ choices: [{ delta: { content: chunk } }] });
    send({ choices: [{ finish_reason: "stop" }] });
  });
}

const SUMMARY = "Here are the key points:\n\n- RSS is quietly resurgent in 2026, powering newsletters, podcast apps, and read-it-later tools.\n- Its appeal is control: no algorithmic feed, no account required, and portable plain-text files.\n- Open standards make readers easy to build, and decades of content work with no API key.";
const ACT_CLOSE = "Done — I entered **alex@example.com** in the newsletter field. I left it unsubmitted so you can review it; just say the word and I'll click Subscribe.";

function decide(messages) {
  const firstUser = (messages.find((m) => m.role === "user")?.content || "").toLowerCase();
  const toolMsgs = messages.filter((m) => m.role === "tool");
  let elements = [];
  for (const m of toolMsgs) {
    try {
      const j = JSON.parse(m.content);
      if (Array.isArray(j.elements)) elements = j.elements;
    } catch {}
  }
  const summarize = /summ|bullet|key point/.test(firstUser);
  if (summarize) {
    if (toolMsgs.length === 0) return { kind: "tool", name: "get_page_text", args: {} };
    return { kind: "text", text: SUMMARY };
  }
  // Act story: read page, type email, close.
  if (toolMsgs.length === 0) return { kind: "tool", name: "read_page", args: {} };
  if (toolMsgs.length === 1) {
    const email = elements.find((e) => e.type === "email" || /email/i.test(e.placeholder || "") || /@/.test(e.placeholder || ""));
    return { kind: "tool", name: "type_text", args: { ref: email?.ref, text: "alex@example.com" } };
  }
  return { kind: "text", text: ACT_CLOSE };
}

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "*" });
      return res.end();
    }
    if (req.url === "/page") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(PAGE);
    }
    if (req.url.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
      return res.end(JSON.stringify({ data: [{ id: "your-model" }] }));
    }
    if (req.url.endsWith("/chat/completions") && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let messages = [];
        try {
          messages = JSON.parse(body).messages || [];
        } catch {}
        const d = decide(messages);
        if (d.kind === "text") sseText(res, d.text);
        else sseToolCall(res, d.name, d.args);
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// ---- Scene composition ----
function dataUri(file) {
  return "data:image/png;base64," + fs.readFileSync(file).toString("base64");
}

function sceneHTML({ title, subtitle, bullets, img, layout }) {
  const bulletHTML = (bullets || []).map((b) => `<li>${b}</li>`).join("");
  if (layout === "wide") {
    return `<div class="scene wide">
      <div class="head"><div class="brand"><span class="mark"></span>OpenSidekick</div>
        <h1>${title}</h1><p>${subtitle}</p></div>
      <div class="frame wideframe"><img src="${img}"/></div></div>`;
  }
  return `<div class="scene">
    <div class="copy">
      <div class="brand"><span class="mark"></span>OpenSidekick</div>
      <h1>${title}</h1><p>${subtitle}</p>
      <ul>${bulletHTML}</ul>
    </div>
    <div class="frame"><img src="${img}"/></div>
  </div>`;
}

const SCENE_CSS = `
  *{box-sizing:border-box;margin:0;padding:0}
  body{width:1280px;height:800px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  .scene{width:1280px;height:800px;background:linear-gradient(135deg,#4338ca 0%,#6d5ef0 55%,#8b7dff 100%);display:flex;align-items:center;gap:56px;padding:0 72px;color:#fff}
  .scene.wide{flex-direction:column;justify-content:center;padding:56px 72px;gap:34px}
  .copy{flex:1;max-width:520px}
  .brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:18px;opacity:.95;margin-bottom:22px}
  .mark{width:22px;height:22px;border-radius:6px;background:#fff;position:relative}
  .mark::after{content:"";position:absolute;inset:6px;border-radius:50%;border:3px solid #4f46e5}
  h1{font-size:46px;line-height:1.08;letter-spacing:-.02em;margin-bottom:16px}
  .copy p,.head p{font-size:19px;line-height:1.5;opacity:.92}
  ul{margin-top:22px;list-style:none;display:flex;flex-direction:column;gap:10px}
  li{font-size:16px;opacity:.95;padding-left:26px;position:relative}
  li::before{content:"✓";position:absolute;left:0;font-weight:700;color:#c7f9cc}
  .head{text-align:center;max-width:820px}
  .head h1{font-size:40px;margin-top:12px}
  .frame{border-radius:20px;overflow:hidden;box-shadow:0 30px 70px rgba(0,0,0,.35);background:#fff;line-height:0}
  .frame img{display:block;height:660px;width:auto}
  .wideframe img{height:auto;width:920px}
`;

async function seed(page, baseUrl) {
  const config = {
    providers: [
      { id: "openrouter", name: "OpenRouter", type: "openai", baseUrl, apiKey: "sk-or-v1-demokey", model: "your-model", models: ["your-model"], keyUrl: "https://openrouter.ai/keys" },
    ],
    activeProviderId: "openrouter",
    activeModel: "your-model",
    sitePermissions: { "https://mail.google.com": "allow" },
    settings: { autonomy: "auto", maxSteps: 10, maxTokens: 1024, temperature: 0.4 },
  };
  await page.evaluate(([key, cfg]) => chrome.storage.local.set({ [key]: cfg }), [STORAGE_KEY, config]);
}

async function runPanel(context, extId, testPage, base, task) {
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 460, height: 900 });
  await panel.goto(`chrome-extension://${extId}/src/sidepanel/sidepanel.html`, { waitUntil: "load" });
  await testPage.bringToFront();
  await panel.evaluate(([runType, t]) => chrome.runtime.sendMessage({ type: runType, task: t, newChat: true }), [MSG.RUN_TASK, task]);
  // Wait until the run is idle (send button visible again) with an assistant reply.
  for (let i = 0; i < 60; i++) {
    const done = await panel.$eval("#send-btn", (el) => !el.hidden).catch(() => false);
    const bubbles = await panel.$$eval(".msg.assistant", (n) => n.length).catch(() => 0);
    if (done && bubbles > 0) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await new Promise((r) => setTimeout(r, 600));
  await panel.bringToFront();
  const shot = path.join(OUT_DIR, "raw-" + task.slice(0, 6).replace(/\W/g, "") + ".png");
  await panel.screenshot({ path: shot });
  await panel.close();
  return shot;
}

async function renderScene(context, spec, outName) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.setContent(`<style>${SCENE_CSS}</style>${sceneHTML(spec)}`, { waitUntil: "load" });
  await new Promise((r) => setTimeout(r, 200));
  await page.screenshot({ path: path.join(OUT_DIR, outName), clip: { x: 0, y: 0, width: 1280, height: 800 } });
  await page.close();
  console.log("wrote assets/screenshots/" + outName);
}

async function main() {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensidekick-shots-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check", `--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
  });

  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
    const extId = new URL(sw.url()).host;

    const testPage = await context.newPage();
    await testPage.goto(`${base}/page`, { waitUntil: "load" });

    // Seed config (needs an extension page context).
    const setup = await context.newPage();
    await setup.goto(`chrome-extension://${extId}/src/options/options.html`, { waitUntil: "load" });
    // Seed a realistic-looking OpenRouter URL for the settings screenshot.
    await seed(setup, "https://openrouter.ai/api/v1");

    // Capture the options page for the "providers" scene.
    await setup.setViewportSize({ width: 1080, height: 760 });
    await setup.reload({ waitUntil: "load" });
    await new Promise((r) => setTimeout(r, 400));
    const optionsShot = path.join(OUT_DIR, "raw-options.png");
    await setup.screenshot({ path: optionsShot, clip: { x: 0, y: 0, width: 1080, height: 760 } });
    // Switch to the working mock endpoint before driving the live panel runs.
    await seed(setup, `${base}/v1`);
    await setup.close();

    // Capture real panel transcripts.
    const actShot = await runPanel(context, extId, testPage, base, "Enter my email alex@example.com in the newsletter box — don't submit.");
    const sumShot = await runPanel(context, extId, testPage, base, "Summarize this article in 3 bullet points.");

    await renderScene(context, {
      layout: "split",
      title: "Read and act on any page",
      subtitle: "Ask in plain language. OpenSidekick reads the page and clicks, types, and navigates for you.",
      bullets: ["Fills forms and follows multi-step flows", "Asks before acting on new or sensitive sites", "Works across multiple tabs"],
      img: dataUri(actShot),
    }, "01-act.png");

    await renderScene(context, {
      layout: "wide",
      title: "Bring your own LLM — your keys stay local",
      subtitle: "OpenRouter, OpenAI, Claude, Gemini, Groq, or a local model via Ollama / LM Studio.",
      img: dataUri(optionsShot),
    }, "02-providers.png");

    await renderScene(context, {
      layout: "split",
      title: "Summarize & extract in context",
      subtitle: "Turn any page into answers, bullet points, or structured data — with the model you choose.",
      bullets: ["Summaries, Q&A, and extraction", "Streams responses as they arrive", "100% open source, no telemetry"],
      img: dataUri(sumShot),
    }, "03-summarize.png");
  } finally {
    await context.close();
    server.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
  console.log("\nDone. Screenshots in assets/screenshots/");
}

main().catch((e) => {
  console.error("Screenshot harness error:", e);
  process.exit(1);
});
