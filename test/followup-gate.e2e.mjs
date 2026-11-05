// A follow-up run must read the page before acting, so the buy/pay/delete card
// still fires for a ref read in an earlier run.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = createRequire(repo + "/node_modules/")("playwright");
const cs = readFileSync(repo + "/src/content/content-script.js", "utf8");

const HTML = `<!doctype html><title>Log in</title><body><h1>Log in</h1>
<form id="f" onsubmit="event.preventDefault(); window.__sub=(window.__sub||0)+1;">
<label for="u">Username</label><input id="u" name="username"><button type="button" id="buy" onclick="window.__bought=(window.__bought||0)+1">Buy now</button>
<label for="p">Password</label><input id="p" name="password" type="password">
<label for="p2">Confirm password</label><input id="p2" name="password2" type="password">
<label for="notes">Notes</label><input id="notes" name="notes">
<button type="submit">Log in</button></form></body>`;

const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP * ~NOTFOUND"] });
const page = await browser.newPage();
await page.route("**/*", (r) => (r.request().url().startsWith("https://forum.test/") ? r.fulfill({ status: 200, contentType: "text/html", body: HTML }) : r.abort()));
let tabUrl = "https://forum.test/login";
async function freshPage() {
  tabUrl = "https://forum.test/login";
  await page.goto("https://forum.test/login");
  await page.evaluate(() => { window.chrome = { runtime: { onMessage: { addListener(fn) { window.__cs = fn; } }, sendMessage() {}, id: "t" } }; });
  await page.addScriptTag({ content: cs });
}
const log = []; // ordered events: card / cs_act
let lastRead = [];
globalThis.chrome = {
  runtime: { getManifest: () => ({ version: "0.6.0" }), sendMessage: async () => ({}) },
  tabs: {
    get: async (id) => ({ id, url: tabUrl, title: "Log in", status: "complete", windowId: 1, groupId: -1 }),
    query: async () => [],
    onUpdated: { addListener() {}, removeListener() {} },
    sendMessage: async (_tab, msg) => {
      const res = await page.evaluate((m) => new Promise((r) => { const ret = window.__cs(m, {}, r); }), msg);
      if (msg.type === "cs_read_page" && res && res.elements) lastRead = res.elements;
      if (msg.type === "cs_act") log.push({ ev: "cs", action: msg.action, ref: msg.ref, secretOk: msg.secretOk, secretConfirmed: msg.secretConfirmed, ok: res && res.ok, err: res && res.error ? res.error.slice(0, 70) : undefined });
      return res;
    },
  },
  scripting: { executeScript: async () => [{ result: { href: tabUrl, text: "" } }] },
};
const refOf = (name) => (lastRead.find((e) => e.name === name && e.tag === "input") || {}).ref;
let script = [];
globalThis.fetch = async () => {
  let turn = script.shift() || [["finish", { summary: "done" }]];
  if (typeof turn === "function") turn = await turn();
  const enc = new TextEncoder();
  const chunks = turn.map(([name, args], i) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: i, id: "c" + i + Math.random().toString(36).slice(2, 8), function: { name, arguments: JSON.stringify(typeof args === "function" ? args() : args) } }] } }] })}\n\n`);
  chunks.push("data: [DONE]\n\n");
  return new Response(new ReadableStream({ start(c) { for (const s of chunks) c.enqueue(enc.encode(s)); c.close(); } }), { status: 200 });
};
const { runAgent } = await import(repo + "/src/background/agent.js");
const provider = { type: "openai", baseUrl: "http://fake.invalid/v1", apiKey: "x", name: "Fake" };
const cfg = (autonomy, sp = {}) => ({ activeModel: "fake", mcpServers: [], sitePermissions: sp, settings: { autonomy, siteAccess: "all", maxSteps: 25, maxTokens: 500, enableVision: false, enableJsTool: false, enableCdp: false } });
async function run(conversation, config, turns, answer = () => "once") {
  script = turns.slice();
  await runAgent({ conversation, config, provider, initialTabId: 7, signal: new AbortController().signal, emit: () => {},
    requestPermission: async (d) => { const a = await answer(d); log.push({ ev: "card", tool: d.toolName, label: d.label, sensitive: d.sensitive, why: d.why, answer: a }); return a; },
    requestPlanApproval: async () => true, requestContinue: async () => false, saveSitePermission: () => {}, groupTab: async () => {}, getGroupId: () => null });
}
const val = (id) => page.evaluate((i) => document.getElementById(i).value, id);
let bad = 0;
function check(label, cond) { console.log((cond ? "ok  : " : "FAIL: ") + label); if (!cond) bad++; }
// Invariant: every cs type with secretConfirmed===true is immediately preceded by an approved
// secret card for the same element label.
function invariant(tag) {
  for (let i = 0; i < log.length; i++) {
    const e = log[i];
    if (e.ev === "cs" && e.secretConfirmed === true) {
      const prev = log[i - 1];
      if (!(prev && prev.ev === "card" && prev.why === "Typing into a password, card or code field" && prev.answer !== "decline")) { console.log("   VIOLATION at", i, JSON.stringify(e)); bad++; }
    }
    if (e.ev === "cs" && e.action !== "type" && e.secretConfirmed !== undefined) { console.log("   non-type carried flag", JSON.stringify(e)); bad++; }
  }
}
const dump = () => log.forEach((e) => console.log("   ", JSON.stringify(e)));
const reset = async () => { log.length = 0; lastRead = []; await freshPage(); };


const bought = () => page.evaluate(() => window.__bought || 0);
const refBtn = (name) => (lastRead.find((e) => e.name === name && e.tag === "button") || {}).ref;
for (const [mode, sp] of [["auto", {}], ["ask", { "https://forum.test": "allow" }]]) {
  // Control: same run -> forced sensitive card for "Buy now".
  await reset();
  await run([{ role: "user", content: "find the kettle" }], cfg(mode, sp), [[["read_page", {}]], () => [["click_element", { ref: refBtn("Buy now") }]], [["finish", { summary: "ok" }]]], () => "decline");
  console.log(`[buy control ${mode}] same run`); dump();
  check(`[buy control ${mode}] card shown, nothing bought`, (await bought()) === 0 && log.some((e) => e.ev === "card" && e.sensitive));
  // Follow-up run: ref from the previous run's read, no re-read.
  await reset();
  const convo = [{ role: "user", content: "find the kettle" }];
  await run(convo, cfg(mode, sp), [[["read_page", {}]], [["ask_user", { question: "Which colour?" }]]]);
  const br = refBtn("Buy now");
  log.length = 0;
  convo.push({ role: "user", content: "red" });
  await run(convo, cfg(mode, sp), [[["click_element", { ref: br }]], [["finish", { summary: "ok" }]]], () => "decline");
  console.log(`[buy follow-up ${mode}] run 2 clicks run-1 ref`); dump();
  check(`[buy follow-up ${mode}] run 2 can't click a run-1 ref: nothing bought`, (await bought()) === 0);
}
await browser.close();
console.log(bad ? `\n${bad} PROBLEM(S)` : "\nALL AGENT-E2E PROBES OK");
process.exit(bad ? 1 : 0);
