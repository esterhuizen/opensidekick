// End-to-end test: loads the real extension into Chromium (Playwright), points
// it at a mock OpenAI-compatible server, and verifies the full agent pipeline —
// model call -> tool loop -> content-script actions on a real page.
//
// The mock "model" drives a scripted task: read the page, type "cats" into the
// search box (found via the real read_page element map), click Search, finish.
// Success is verified by the resulting DOM change on the page.
//
// Requires: npm install (playwright) + a browser (npx playwright install chromium).
// On a headless server, run under Xvfb: xvfb-run -a node test/e2e.test.mjs

import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { STORAGE_KEY, MSG } from "../src/common/constants.js";

const EXT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (cond, msg) => {
  console.log((cond ? "ok  : " : "FAIL: ") + msg);
  if (!cond) failures++;
};

const TEST_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Test Search</title></head>
<body>
  <h1>Test Search Page</h1>
  <input id="q" placeholder="Search the site" />
  <button id="go" type="button">Search</button>
  <div id="out"></div>
  <script>
    document.getElementById('go').addEventListener('click', function () {
      document.getElementById('out').textContent = 'Results for: ' + document.getElementById('q').value;
    });
  </script>
</body></html>`;

// --- Mock model: scripts a multi-step agentic task over the tool protocol. ---
function decideToolCall(messages) {
  const toolMsgs = messages.filter((m) => m.role === "tool");
  const toolCount = toolMsgs.length;
  // Recover the element refs from the most recent read_page tool result.
  let elements = [];
  for (const m of toolMsgs) {
    try {
      const j = JSON.parse(m.content);
      if (Array.isArray(j.elements)) elements = j.elements;
    } catch {}
  }
  const input = elements.find((e) => e.tag === "input");
  const button = elements.find((e) => e.tag === "button" || (e.name || "").toLowerCase() === "search");

  if (toolCount === 0) return { name: "read_page", args: {} };
  if (toolCount === 1) return { name: "type_text", args: { ref: input?.ref, text: "cats" } };
  if (toolCount === 2) return { name: "click_element", args: { ref: button?.ref } };
  return { name: "finish", args: { summary: 'Typed "cats" and clicked Search.' } };
}

function sseToolCall(res, id, name, argsObj) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "access-control-allow-origin": "*",
  });
  const args = JSON.stringify(argsObj);
  const send = (o) => res.write("data: " + JSON.stringify(o) + "\n\n");
  send({ choices: [{ delta: { role: "assistant" } }] });
  send({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: "" } }] } }] });
  const mid = Math.ceil(args.length / 2); // split args across chunks on purpose
  send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, mid) } }] } }] });
  send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(mid) } }] } }] });
  send({ choices: [{ finish_reason: "tool_calls" }] });
  res.write("data: [DONE]\n\n");
  res.end();
}

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "*",
        "access-control-allow-methods": "*",
      });
      return res.end();
    }
    if (req.url === "/page") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(TEST_PAGE);
    }
    if (req.url.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
      return res.end(JSON.stringify({ data: [{ id: "mock-model" }] }));
    }
    if (req.url.endsWith("/chat/completions") && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let messages = [];
        try {
          messages = JSON.parse(body).messages || [];
        } catch {}
        const call = decideToolCall(messages);
        sseToolCall(res, "call_" + Date.now(), call.name, call.args);
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function main() {
  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensidekick-e2e-"));

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
    ],
  });

  try {
    // Get the extension id from its service worker.
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20000 });
    const extId = new URL(sw.url()).host;
    check(!!extId, `extension service worker registered (id ${extId})`);

    // Open the test page (this becomes the tab the agent acts on).
    const testPage = await context.newPage();
    await testPage.goto(`${base}/page`, { waitUntil: "load" });

    // Open the options page: used to seed config and to trigger/observe the run
    // from an extension context that isn't the active content tab.
    const optPage = await context.newPage();
    await optPage.goto(`chrome-extension://${extId}/src/options/options.html`, { waitUntil: "load" });

    const config = {
      providers: [
        {
          id: "mock",
          name: "Mock",
          type: "openai",
          baseUrl: `${base}/v1`,
          apiKey: "",
          model: "mock-model",
          models: ["mock-model"],
        },
      ],
      activeProviderId: "mock",
      activeModel: "mock-model",
      sitePermissions: {},
      settings: { autonomy: "auto", maxSteps: 10, maxTokens: 1024, temperature: 0.4 },
    };
    await optPage.evaluate(
      ([key, cfg]) => chrome.storage.local.set({ [key]: cfg }),
      [STORAGE_KEY, config],
    );

    // Collect agent events in the options page context.
    await optPage.evaluate((agentEventType) => {
      window.__events = [];
      chrome.runtime.onMessage.addListener((m) => {
        if (m && m.type === agentEventType) window.__events.push(m);
      });
    }, MSG.AGENT_EVENT);

    // Make the test page the active tab, then kick off the task.
    await testPage.bringToFront();
    await optPage.evaluate(
      ([runType, task]) => chrome.runtime.sendMessage({ type: runType, task, newChat: true }),
      [MSG.RUN_TASK, "Search for cats on this page."],
    );

    // Wait for the agent to complete its work: the page's #out should update.
    let outText = "";
    let inputVal = "";
    for (let i = 0; i < 60; i++) {
      outText = await testPage.$eval("#out", (el) => el.textContent).catch(() => "");
      inputVal = await testPage.$eval("#q", (el) => el.value).catch(() => "");
      if (outText.includes("cats")) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    check(inputVal === "cats", `agent typed "cats" into the search box (got "${inputVal}")`);
    check(outText === "Results for: cats", `agent clicked Search; page shows results (got "${outText}")`);

    // Inspect the streamed event transcript.
    const events = await optPage.evaluate(() => window.__events || []);
    const toolStarts = events.filter((e) => e.kind === "tool_start").map((e) => e.name);
    const finished = events.some((e) => e.kind === "finish");
    check(toolStarts.includes("read_page"), "transcript includes read_page");
    check(toolStarts.includes("type_text"), "transcript includes type_text");
    check(toolStarts.includes("click_element"), "transcript includes click_element");
    check(finished, "agent called finish");
    const anyError = events.filter((e) => e.kind === "error");
    check(anyError.length === 0, `no error events (${anyError.map((e) => e.error).join("; ")})`);
  } finally {
    await context.close();
    server.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  console.log(failures ? `\n${failures} E2E CHECK(S) FAILED` : "\nALL E2E CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("E2E harness error:", e);
  process.exit(2);
});
