// Real end-to-end test: drives the extension in Chromium against a REAL LLM
// (OpenRouter) so an actual model makes the tool calls that act on a live page.
//
// Reads the key from the environment — never hardcode it:
//   OPENROUTER_KEY=sk-or-... [MODEL=openai/gpt-4o-mini] xvfb-run -a node test/real.e2e.mjs
//
// Proves the whole stack works with a genuine model: provider streaming, the
// tool-calling loop, permissions, and the content script acting on the DOM.

import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { STORAGE_KEY, MSG } from "../src/common/constants.js";

const KEY = process.env.OPENROUTER_KEY || process.env.OPENROUTER_API_KEY || "";
const MODEL = process.env.MODEL || "openai/gpt-4o-mini";
const EXT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (!KEY) {
  console.log("SKIP: set OPENROUTER_KEY to run the real-model test.");
  process.exit(0);
}

// Test page: updates #out on either a button click OR Enter in the box, so the
// test is robust to whichever approach the model chooses.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Search Demo</title></head>
<body><h1>Search Demo</h1>
<input id="q" placeholder="Search the site" />
<button id="go" type="button">Search</button>
<div id="out"></div>
<script>
  function run(){ document.getElementById('out').textContent = 'Results for: ' + document.getElementById('q').value; }
  document.getElementById('go').addEventListener('click', run);
  document.getElementById('q').addEventListener('keydown', function(e){ if(e.key==='Enter'){ e.preventDefault(); run(); } });
</script></body></html>`;

function startServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

let failures = 0;
const check = (cond, msg) => {
  console.log((cond ? "ok  : " : "FAIL: ") + msg);
  if (!cond) failures++;
};

async function main() {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensidekick-real-"));

  console.log(`Model: ${MODEL}  (via OpenRouter)\n`);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check", `--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
  });

  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
    const extId = new URL(sw.url()).host;

    const testPage = await context.newPage();
    await testPage.goto(`${base}/`, { waitUntil: "load" });

    const optPage = await context.newPage();
    await optPage.goto(`chrome-extension://${extId}/src/options/options.html`, { waitUntil: "load" });

    const config = {
      providers: [{ id: "or", name: "OpenRouter", type: "openai", baseUrl: "https://openrouter.ai/api/v1", apiKey: KEY, model: MODEL, models: [MODEL] }],
      activeProviderId: "or",
      activeModel: MODEL,
      sitePermissions: {},
      settings: { autonomy: "auto", maxSteps: 12, maxTokens: 1024, temperature: 0.2, enableVision: false },
    };
    await optPage.evaluate(([k, cfg]) => chrome.storage.local.set({ [k]: cfg }), [STORAGE_KEY, config]);
    await optPage.evaluate((agentEvent) => {
      window.__events = [];
      chrome.runtime.onMessage.addListener((m) => { if (m && m.type === agentEvent) window.__events.push(m); });
    }, MSG.AGENT_EVENT);

    // --- Task 1: an agentic action driven by the real model ---
    await testPage.bringToFront();
    await optPage.evaluate(
      ([runType, task]) => chrome.runtime.sendMessage({ type: runType, task, newChat: true }),
      [MSG.RUN_TASK, "On this page, search for cats. Type the word cats into the search box and run the search."],
    );

    // Wait until the agent is fully idle (not just the first DOM change) so the
    // next task isn't rejected as "already running".
    for (let i = 0; i < 120; i++) {
      const evs = await optPage.evaluate(() => window.__events || []);
      if (evs.some((e) => e.kind === "idle")) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const outText = await testPage.$eval("#out", (el) => el.textContent).catch(() => "");

    const events = await optPage.evaluate(() => window.__events || []);
    const tools = events.filter((e) => e.kind === "tool_start").map((e) => e.name);
    console.log("  tools the model called:", tools.join(" → ") || "(none)");
    const errs = events.filter((e) => e.kind === "error");
    check(outText.toLowerCase().includes("cats"), `real model drove the page to a search result (got "${outText}")`);
    check(tools.includes("read_page") || tools.includes("get_page_text"), "real model read the page first");
    check(tools.some((t) => t === "type_text"), "real model used type_text");
    check(errs.length === 0, `no error events (${errs.map((e) => e.error).join("; ")})`);

    // --- Task 2: a reading/answering task ---
    await optPage.evaluate(() => (window.__events = []));
    await testPage.bringToFront();
    await optPage.evaluate(
      ([runType, task]) => chrome.runtime.sendMessage({ type: runType, task, newChat: true }),
      [MSG.RUN_TASK, "What is the main heading (H1) on this page? Answer in a few words."],
    );
    for (let i = 0; i < 120; i++) {
      const evs = await optPage.evaluate(() => window.__events || []);
      if (evs.some((e) => e.kind === "idle")) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const ev2 = await optPage.evaluate(() => window.__events || []);
    const t2 = ev2.filter((e) => e.kind === "tool_start").map((e) => e.name);
    console.log("  task 2 tools:", t2.join(" → ") || "(none)");
    // The user-facing answer may arrive as a plain assistant turn OR via the
    // finish tool's summary — the side panel renders both.
    const hit = [...ev2].reverse().find((e) => (e.kind === "assistant_end" && e.content) || (e.kind === "finish" && e.summary));
    const answer = hit ? hit.content || hit.summary : "";
    console.log("  model's answer:", JSON.stringify(answer.slice(0, 140)));
    check(/search demo/i.test(answer), `real model read and answered about the page (got "${answer.slice(0, 60)}")`);
  } finally {
    await context.close();
    server.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  console.log(failures ? `\n${failures} REAL-MODEL CHECK(S) FAILED` : "\nALL REAL-MODEL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("Real-model harness error:", e);
  process.exit(2);
});
