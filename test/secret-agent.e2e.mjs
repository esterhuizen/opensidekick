// The secret-field card and secretConfirmed wiring, end to end: real runAgent
// and tools.js (Node) driving the real content script (offline Chromium).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = createRequire(repo + "/node_modules/")("playwright");
const cs = readFileSync(repo + "/src/content/content-script.js", "utf8");

const HTML = `<!doctype html><title>Log in</title><body><h1>Log in</h1>
<form id="f" onsubmit="event.preventDefault(); window.__sub=(window.__sub||0)+1;">
<label for="u">Username</label><input id="u" name="username">
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

// 1. Same run, two calls in one turn (user + password) -> one card for the password.
await reset();
await run([{ role: "user", content: "log me in, username samr password Hunter-77" }], cfg("auto"),
  [[["read_page", {}]], () => [["type_text", { ref: refOf("Username"), text: "samr" }], ["type_text", { ref: refOf("Password"), text: "Hunter-77" }]], [["finish", { summary: "ok" }]]]);
console.log("[1] same run"); dump(); invariant(1);
check("[1] password filled after its card", (await val("p")) === "Hunter-77");

// 2. Follow-up run on run-1 refs without a re-read: refused, then read + card + fill.
for (const [mode, sp] of [["auto", {}], ["ask", { "https://forum.test": "allow" }], ["ask", {}]]) {
  await reset();
  const convo = [{ role: "user", content: "log me into the forum, my username is samr" }];
  await run(convo, cfg(mode, sp), [[["read_page", {}]], () => [["type_text", { ref: refOf("Username"), text: "samr" }]], [["ask_user", { question: "What's your password?" }]]]);
  const pwRef = refOf("Password");
  log.length = 0;
  convo.push({ role: "user", content: "Hunter-77" });
  let afterRefusal = null;
  await run(convo, cfg(mode, sp), [[["type_text", { ref: pwRef, text: "Hunter-77" }]], async () => { afterRefusal = await val("p"); return [["read_page", {}]]; }, () => [["type_text", { ref: refOf("Password"), text: "Hunter-77" }]], [["finish", { summary: "ok" }]]]);
  console.log(`[2 ${mode}${sp["https://forum.test"] ? "+allow" : ""}] follow-up run`); dump(); invariant(2);
  check(`[2 ${mode}] first attempt refused, field empty`, afterRefusal === "");
  check(`[2 ${mode}] filled only after re-read + card`, (await val("p")) === "Hunter-77" && log.some((e) => e.ev === "card" && e.why));
}

// 3. Two secret fields in one turn: approve first, decline second.
await reset();
let n3 = 0;
await run([{ role: "user", content: "sign up, password Hunter-77" }], cfg("auto"),
  [[["read_page", {}]], () => [["type_text", { ref: refOf("Password"), text: "Hunter-77" }], ["type_text", { ref: refOf("Confirm password"), text: "Hunter-77" }], ["type_text", { ref: refOf("Notes"), text: "Hunter-77" }]]],
  () => (++n3 === 1 ? "once" : "decline"));
console.log("[3] two secret fields, second declined"); dump(); invariant(3);
check("[3] first filled, second and Notes untouched", (await val("p")) === "Hunter-77" && (await val("p2")) === "" && (await val("notes")) === "");

// 4. Approved card, then a plain field flipped to password before the next call in the same turn.
await reset();
await run([{ role: "user", content: "log in, password Hunter-77" }], cfg("auto"),
  [[["read_page", {}]], async () => { const pr = refOf("Password"), nr = refOf("Notes"); return [["type_text", { ref: pr, text: "Hunter-77" }], ["type_text", { ref: nr, text: "Hunter-77" }]]; }, [["finish", { summary: "ok" }]]],
  async (d) => { await page.evaluate(() => { document.getElementById("notes").type = "password"; }); return "once"; });
console.log("[4] notes flips to password during the first card"); dump(); invariant(4);
check("[4] flipped field refused without its own card", (await val("notes")) === "");

// 5. Page changes origin during the card -> not typed; next call in turn gets no flag.
await reset();
await run([{ role: "user", content: "log in, password Hunter-77" }], cfg("auto"),
  [[["read_page", {}]], () => [["type_text", { ref: refOf("Password"), text: "Hunter-77" }], ["type_text", { ref: refOf("Password"), text: "Hunter-77" }]], [["finish", { summary: "ok" }]]],
  async () => { tabUrl = "https://evil.test/login"; return "once"; });
console.log("[5] origin change during card"); dump(); invariant(5);
check("[5] nothing typed", (await val("p")) === "");

// 6. Approved card, element removed during the card (execute errors) -> later plain type has no flag.
await reset();
await run([{ role: "user", content: "log in, username samr password Hunter-77" }], cfg("auto"),
  [[["read_page", {}]], () => [["type_text", { ref: refOf("Password"), text: "Hunter-77" }], ["type_text", { ref: refOf("Username"), text: "samr" }]], [["finish", { summary: "ok" }]]],
  async () => { await page.evaluate(() => { document.getElementById("p").remove(); }); return "once"; });
console.log("[6] element gone during card"); dump(); invariant(6);

// 7. Card approved for a value the user did not give -> refused by secretOk.
await reset();
await run([{ role: "user", content: "log me in" }], cfg("auto"),
  [[["read_page", {}]], () => [["type_text", { ref: refOf("Password"), text: "Tmp-4821" }]], [["finish", { summary: "ok" }]]]);
console.log("[7] value not user-given"); dump(); invariant(7);
check("[7] not filled", (await val("p")) === "");

// 8. Declined card ends the run.
await reset();
await run([{ role: "user", content: "log in, password Hunter-77" }], cfg("auto"),
  [[["read_page", {}]], () => [["type_text", { ref: refOf("Password"), text: "Hunter-77" }]], [["type_text", { ref: 4, text: "Hunter-77" }]]], () => "decline");
console.log("[8] declined"); dump(); invariant(8);
check("[8] not filled", (await val("p")) === "");

// 9. Same-turn re-read between approval and another call: second call needs its own card.
await reset();
await run([{ role: "user", content: "log in, password Hunter-77" }], cfg("auto"),
  [[["read_page", {}]], () => [["type_text", { ref: refOf("Password"), text: "Hunter-77" }], ["read_page", {}], ["type_text", { ref: 6, text: "Hunter-77" }]], [["finish", { summary: "ok" }]]]);
console.log("[9] approve, read, type again in one turn"); dump(); invariant(9);

await browser.close();
console.log(bad ? `\n${bad} PROBLEM(S)` : "\nALL AGENT-E2E PROBES OK");
process.exit(bad ? 1 : 0);
