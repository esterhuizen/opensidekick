// Regression test for the workflow-recording banner. Loads the real extension
// and drives the side panel's Record / Stop buttons to confirm the "Recording…"
// banner is always cleared when recording stops — including the race where a
// slow START_RECORDING reply used to resurrect the banner after Stop.
//
// Run (headless server): xvfb-run -a node test/recording.e2e.mjs

import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { STORAGE_KEY } from "../src/common/constants.js";

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = "<!doctype html><meta charset=utf-8><title>Rec test</title><body><h1>Rec test</h1><input id=q><button id=go>Go</button></body>";

let fail = 0;
const ok = (c, m) => { console.log((c ? "ok  : " : "FAIL: ") + m); if (!c) fail = 1; };

const server = await new Promise((r) => {
  const s = http.createServer((rq, rs) => {
    if (rq.url === "/models") {
      rs.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
      return rs.end(JSON.stringify({ data: [{ id: "m" }] }));
    }
    rs.writeHead(200, { "content-type": "text/html" });
    rs.end(PAGE);
  });
  s.listen(0, "127.0.0.1", () => r(s));
});
const base = `http://127.0.0.1:${server.address().port}`;
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensidekick-rec-"));
const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-first-run", `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
  const id = new URL(sw.url()).host;

  const testPage = await ctx.newPage();
  await testPage.goto(`${base}/`, { waitUntil: "load" });

  const setup = await ctx.newPage();
  await setup.goto(`chrome-extension://${id}/src/options/options.html`, { waitUntil: "load" });
  await setup.evaluate(([k, c]) => chrome.storage.local.set({ [k]: c }), [STORAGE_KEY, {
    providers: [{ id: "m", name: "M", type: "openai", baseUrl: `${base}/v1`, apiKey: "", model: "m", models: ["m"] }],
    activeProviderId: "m", activeModel: "m", sitePermissions: {}, settings: { autonomy: "auto" },
  }]);
  await setup.close();

  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${id}/src/sidepanel/sidepanel.html`, { waitUntil: "load" });
  const bannerVisible = () => panel.$eval("#rec-banner", (e) => !e.hidden).catch(() => false);
  const recBtnOn = () => panel.$eval("#record-btn", (e) => e.classList.contains("recording")).catch(() => false);

  // 1) Normal: record -> banner shows -> stop -> banner hidden.
  await testPage.bringToFront();
  await panel.click("#record-btn");
  await panel.waitForTimeout(900);
  ok(await bannerVisible(), "record: banner shows while recording");
  await panel.click("#rec-stop").catch(() => {});
  await panel.waitForTimeout(1200);
  ok(!(await bannerVisible()), "stop: banner hidden after stop");
  ok(!(await recBtnOn()), "stop: record button cleared");

  // 2) Race: record, a second click during the (slow) start, then stop — the
  //    banner must not linger.
  await testPage.bringToFront();
  await panel.click("#record-btn");
  await panel.waitForTimeout(120);
  await panel.click("#record-btn").catch(() => {});
  await panel.waitForTimeout(1200);
  if (await bannerVisible()) await panel.click("#rec-stop").catch(() => {});
  await panel.waitForTimeout(1400);
  ok(!(await bannerVisible()), "race: banner hidden after rapid record/record/stop");
  ok(!(await recBtnOn()), "race: record button cleared");
} finally {
  await ctx.close();
  server.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
console.log(fail ? "\nSOME RECORDING CHECKS FAILED" : "\nALL RECORDING CHECKS PASSED");
process.exit(fail);
