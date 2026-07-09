// Records the raw material for the feature-tour video (assets/video-raw/):
//   scene1-page/panel.webm — act on a page: task typed, ask-mode approval, form filled
//   scene2-page/panel.webm — vision: canvas chart, take_screenshot, answer
//   scene3-page/panel.webm — multi-tab: find the pricing tab, read it, answer
//   scene4-page/panel.webm — workflow: record steps, save, replay menu
//   card-title/model/end.png (1280x720) — narration cards
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

// ---- Demo pages (caption bars are baked in: this ffmpeg build lacks drawtext) ----
const SHELL = (title, caption, body, extraCss = "") => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
  body{font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1f2328;margin:0;background:#fff}
  header.site{border-bottom:1px solid #eee;padding:13px 26px;display:flex;justify-content:space-between;align-items:center}
  .logo{font-weight:800;letter-spacing:-.02em}
  nav a{margin-left:15px;color:#555;text-decoration:none;font-size:13.5px}
  main{max-width:620px;margin:0 auto;padding:24px 24px 90px}
  h1{font-size:26px;line-height:1.2;margin:0 0 8px;letter-spacing:-.02em}
  .byline{color:#888;font-size:13.5px;margin-bottom:18px}
  p{margin:0 0 15px}
  .cap{position:fixed;left:0;right:0;bottom:0;background:rgba(23,23,29,.88);color:#fff;
    font-size:15.5px;font-weight:600;padding:12px 20px;letter-spacing:.01em;z-index:5}
  .cap b{color:#b8b0ff}
  ${extraCss}
</style></head>
<body>
  <header class="site"><span class="logo">Signalpost</span>
    <nav><a href="#">Latest</a><a href="#">Tech</a><a href="#">About</a></nav></header>
  <main>${body}</main>
  <div class="cap">${caption}</div>
</body></html>`;

const ARTICLE = SHELL("The Quiet Comeback of RSS — Signalpost",
  'Ask in plain language — <b>it reads the page and acts, with your approval</b>',
  `<h1>The Quiet Comeback of RSS</h1>
   <div class="byline">By Dana Okoro · 7 min read</div>
   <p>For years RSS was written off as a relic of the early blogosphere. Yet in 2026 the humble feed is quietly resurgent, powering newsletters, podcast apps, and a new wave of read-it-later tools.</p>
   <div class="news"><h3>Get the weekly Signalpost</h3>
     <form onsubmit="return false">
       <input id="email" type="email" placeholder="you@example.com" aria-label="Email address" />
       <button id="subscribe" type="button">Subscribe</button>
     </form></div>`,
  `.news{margin-top:24px;padding:18px;border:1px solid #e6e6e9;border-radius:14px;background:#fafafb}
   .news h3{margin:0 0 10px;font-size:17px}
   .news form{display:flex;gap:8px}
   .news input{flex:1;padding:10px 12px;border:1px solid #d5d5db;border-radius:8px;font-size:15px}
   .news button{background:#4f46e5;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-weight:600;cursor:pointer}`);

const CHART = SHELL("Traffic dashboard — Signalpost",
  'A canvas chart — nothing readable in the DOM. <b>It takes a screenshot and looks.</b>',
  `<h1>Traffic — last 6 months</h1>
   <div class="byline">Signalpost analytics</div>
   <canvas id="c" width="560" height="360" style="border:1px solid #eee;border-radius:12px"></canvas>
   <script>
     const ctx = document.getElementById("c").getContext("2d");
     const data = [["Jan",21],["Feb",22],["Mar",42],["Apr",30],["May",27],["Jun",33]];
     ctx.font = "13px sans-serif"; ctx.textAlign = "center";
     data.forEach(([m,v],i)=>{
       const x = 45 + i*88, h = v*6.5;
       ctx.fillStyle = i===2 ? "#4f46e5" : "#b9b3f5";
       ctx.fillRect(x, 320-h, 56, h);
       ctx.fillStyle = "#444"; ctx.fillText(m, x+28, 342);
     });
   </script>`);

const PRICING = SHELL("Pricing — Signalpost",
  '<b>It works across your tabs</b> — list, switch, read, report back',
  `<h1>Pricing</h1>
   <div class="byline">Simple plans, cancel anytime</div>
   <div class="plans">
     <div class="plan"><h3>Basic</h3><div class="price">$9<span>/mo</span></div><p>1 feed bundle</p></div>
     <div class="plan hot"><h3>Pro</h3><div class="price">$29<span>/mo</span></div><p>Unlimited bundles</p></div>
     <div class="plan"><h3>Team</h3><div class="price">$79<span>/mo</span></div><p>Shared workspaces</p></div>
   </div>`,
  `.plans{display:flex;gap:12px;margin-top:14px}
   .plan{flex:1;border:1px solid #e6e6e9;border-radius:14px;padding:16px;text-align:center;background:#fafafb}
   .plan.hot{border-color:#4f46e5;background:#f4f2ff}
   .plan h3{margin:0 0 6px}
   .price{font-size:28px;font-weight:800}
   .price span{font-size:13px;color:#888;font-weight:500}`);

const SEARCH = SHELL("Library — Signalpost",
  '<b>Record a task once</b> — save it, replay it anytime',
  `<h1>Article library</h1>
   <div class="byline">Search the archive</div>
   <div class="news" style="margin-top:14px;padding:18px;border:1px solid #e6e6e9;border-radius:14px;background:#fafafb">
     <form onsubmit="return false" style="display:flex;gap:8px">
       <input id="q" placeholder="Search articles" style="flex:1;padding:10px 12px;border:1px solid #d5d5db;border-radius:8px;font-size:15px" />
       <button id="go" type="button" style="background:#4f46e5;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-weight:600;cursor:pointer">Search</button>
     </form>
     <div id="out" style="margin-top:10px;color:#555"></div>
   </div>
   <script>document.getElementById("go").addEventListener("click",()=>{document.getElementById("out").textContent="12 results for: "+document.getElementById("q").value;});</script>`);

// ---- Mock model ----
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
    await sleep(30);
  }
  send({ choices: [{ finish_reason: "stop" }] });
  res.write("data: [DONE]\n\n");
  res.end();
}

function decide(messages) {
  const firstUser = (messages.find((m) => m.role === "user")?.content || "").toString().toLowerCase();
  const toolMsgs = messages.filter((m) => m.role === "tool");
  const n = toolMsgs.length;
  const parsed = toolMsgs.map((m) => { try { return JSON.parse(m.content); } catch { return {}; } });

  // Scene 2 — vision: the chart is canvas, so look at a screenshot.
  if (/chart|highest|traffic/.test(firstUser)) {
    if (n === 0) return { kind: "tool", name: "take_screenshot", args: {} };
    return { kind: "text", text: "Looking at the chart, **March** had the highest traffic — about 42k visits, roughly double February." };
  }

  // Scene 3 — multi-tab: find the pricing tab, read it.
  if (/pricing|pro plan/.test(firstUser)) {
    if (n === 0) return { kind: "tool", name: "list_tabs", args: {} };
    if (n === 1) {
      const tabs = (parsed[0] && parsed[0].tabs) || [];
      const t = tabs.find((x) => /pricing/i.test(x.title || ""));
      return { kind: "tool", name: "switch_tab", args: { tab_id: t ? t.tab_id : 0 } };
    }
    if (n === 2) return { kind: "tool", name: "get_page_text", args: {} };
    return { kind: "text", text: "The **Pro plan is $29/month** (Basic is $9, Team is $79) — it's the highlighted middle plan on your pricing tab." };
  }

  // Scene 1 — act on the page: read, type into the email field, report.
  const elements = parsed.reduce((a, p) => (Array.isArray(p.elements) ? p.elements : a), []);
  const typed = toolMsgs.some((m) => { try { return JSON.parse(m.content).ok && /alex/.test(m.content); } catch { return false; } });
  if (n === 0) return { kind: "tool", name: "read_page", args: {} };
  if (!typed) {
    const email = elements.find((e) => e.type === "email" || /email|you@/i.test(e.placeholder || ""));
    return { kind: "tool", name: "type_text", args: { ref: email?.ref, text: "alex@example.com" } };
  }
  return { kind: "text", text: "Done — I entered **alex@example.com** in the newsletter field and left it unsubmitted, so you can review before subscribing." };
}

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "*" }); return res.end(); }
    const html = { "/page": ARTICLE, "/chart": CHART, "/pricing": PRICING, "/search": SEARCH }[req.url];
    if (html) { res.writeHead(200, { "content-type": "text/html" }); return res.end(html); }
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

// ---- Narration cards ----
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
  const base = "http://signalpost.demo:8080";
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensidekick-video-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false, // REQUIRED: the headless shell silently disables extensions
    // All tabs share one headed window, and a viewport resize on any tab
    // re-sizes that window and clips the others' screencasts. So: one equal
    // viewport for every page — 640+640 hstacks to exactly 1280x720.
    viewport: { width: 640, height: 720 },
    recordVideo: { dir: RAW_DIR, size: { width: 640, height: 720 } },
    args: [
      "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check",
      "--window-size=1500,860",
      "--window-position=0,0",
      "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding", "--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling",
      "--host-resolver-rules=MAP signalpost.demo 127.0.0.1",
      `--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`,
    ],
  });
  const keepVideos = [];
  try {
    // Poll rather than waiting on the event — the worker may register before the
    // listener is armed, or take a while under load.
    let sw = null;
    for (let i = 0; i < 60 && !sw; i++) {
      sw = context.serviceWorkers()[0] || null;
      if (!sw) await sleep(1000);
    }
    if (!sw) throw new Error("extension service worker never started (60s)");
    const extId = new URL(sw.url()).host;
    const PANEL_URL = `chrome-extension://${extId}/src/sidepanel/sidepanel.html`;

    const setup = await context.newPage();
    await setup.goto(`chrome-extension://${extId}/src/options/options.html`, { waitUntil: "load" });
    await setup.evaluate(([k, c]) => chrome.storage.local.set({ [k]: c }), [STORAGE_KEY, {
      providers: [{ id: "openrouter", name: "OpenRouter", type: "openai", baseUrl: "http://127.0.0.1:8080/v1", apiKey: "sk-or-demo", model: "your-model", models: ["your-model"] }],
      activeProviderId: "openrouter", activeModel: "your-model", sitePermissions: {},
      settings: { autonomy: "ask", maxSteps: 8, maxTokens: 512, temperature: 0.2, enableVision: true },
    }]);
    await setup.close();

    // Open a fresh page+panel pair for a scene; panel starts a clean chat.
    const openPair = async (url) => {
      const page = await context.newPage();
      await page.goto(url, { waitUntil: "load" });
      const panel = await context.newPage();
      await panel.goto(PANEL_URL, { waitUntil: "load" });
      await sleep(600);
      await panel.click("#new-chat");
      await sleep(400);
      return { page, panel };
    };
    // Close the pair and keep its recordings under scene names.
    const closePair = async (n, { page, panel }) => {
      const pv = await page.video().path();
      const nv = await panel.video().path();
      await page.close(); await panel.close();
      fs.renameSync(pv, path.join(RAW_DIR, `scene${n}-page.webm`));
      fs.renameSync(nv, path.join(RAW_DIR, `scene${n}-panel.webm`));
      keepVideos.push(`scene${n}-page.webm`, `scene${n}-panel.webm`);
      console.log(`scene ${n} recorded`);
    };
    const typeTask = async (panel, page, text) => {
      await panel.click("#input");
      await panel.type("#input", text, { delay: 24 });
      await sleep(300);
      await page.bringToFront(); // the agent targets the active content tab
      await panel.click("#send-btn");
    };
    const waitIdle = async (panel, ms = 25000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const idle = await panel.$eval("#send-btn", (el) => !el.hidden).catch(() => false);
        const answered = await panel.$$eval(".msg.assistant", (n) => n.length).catch(() => 0);
        if (idle && answered > 0) return;
        await sleep(200);
      }
    };

    // ---- Scene 1: act on the page (ask-mode approval on camera) ----
    {
      const pair = await openPair(`${base}/page`);
      await sleep(500);
      await typeTask(pair.panel, pair.page, "Add my email alex@example.com to the newsletter, but don't subscribe.");
      await pair.panel.waitForSelector('.perm-card button[data-choice="once"]', { timeout: 20000 });
      await sleep(1500); // let the viewer read the permission card
      await pair.panel.click('button[data-choice="once"]');
      await waitIdle(pair.panel);
      await sleep(2200);
      await closePair(1, pair);
    }

    // ---- Scene 2: vision — screenshot the canvas chart ----
    {
      const pair = await openPair(`${base}/chart`);
      await sleep(500);
      await typeTask(pair.panel, pair.page, "Which month had the highest traffic in this chart?");
      await waitIdle(pair.panel);
      await sleep(2200);
      await closePair(2, pair);
    }

    // ---- Scene 3: multi-tab — find and read the pricing tab ----
    {
      // Pre-open the pricing tab; record IT as the page side (the agent switches
      // to it on camera and the activity overlay appears while it reads).
      const pricing = await context.newPage();
      await pricing.goto(`${base}/pricing`, { waitUntil: "load" });
      const article = await context.newPage();
      await article.goto(`${base}/page`, { waitUntil: "load" });
      const panel = await context.newPage();
      await panel.goto(PANEL_URL, { waitUntil: "load" });
      await sleep(600);
      await panel.click("#new-chat");
      await sleep(400);
      await typeTask(panel, article, "What does the Pro plan cost? It's on my pricing tab.");
      await waitIdle(panel);
      await sleep(2200);
      const pv = await pricing.video().path();
      const nv = await panel.video().path();
      await pricing.close(); await article.close(); await panel.close();
      fs.renameSync(pv, path.join(RAW_DIR, "scene3-page.webm"));
      fs.renameSync(nv, path.join(RAW_DIR, "scene3-panel.webm"));
      keepVideos.push("scene3-page.webm", "scene3-panel.webm");
      console.log("scene 3 recorded");
    }

    // ---- Scene 4: workflow — record steps, save, show the replay menu ----
    {
      const pair = await openPair(`${base}/search`);
      await sleep(500);
      await pair.page.bringToFront(); // recording targets the active tab
      await pair.panel.click("#record-btn");
      await sleep(900); // content script arms; banner shows "Recording — 0 steps"
      await pair.page.click("#q");
      await pair.page.type("#q", "aeropress", { delay: 60 });
      await pair.page.click("#go");
      await sleep(1200); // steps tick up on the banner
      await pair.panel.click("#rec-stop");
      await pair.panel.waitForSelector("#wf-name", { timeout: 10000 });
      await sleep(900);
      await pair.panel.type("#wf-name", "Library search", { delay: 30 });
      await sleep(400);
      await pair.panel.click('button[data-save="1"]');
      await sleep(1000);
      await pair.panel.click("#workflows-btn"); // show it saved, ready to replay
      await sleep(2000);
      await closePair(4, pair);
    }

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
  // Remove stray recordings (setup/card/article-helper pages).
  for (const f of fs.readdirSync(RAW_DIR)) if (f.endsWith(".webm") && !keepVideos.includes(f)) fs.rmSync(path.join(RAW_DIR, f));
  fs.rmSync(userDataDir, { recursive: true, force: true });
  console.log("raw material in assets/video-raw/:", fs.readdirSync(RAW_DIR).sort().join(", "));
}

main().catch((e) => { console.error("feature-video error:", e); process.exit(1); });
