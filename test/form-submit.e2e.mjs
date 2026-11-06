import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
// Checkout-form shapes: typing with submit, or Enter, in a field of a form with
// a buy-like button must raise the confirmation card (declined: no order).
import path from "node:path";
import { fileURLToPath } from "node:url";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let __bad = 0;
const { chromium } = createRequire(repo + "/node_modules/")("playwright");
const cs = readFileSync(repo + "/src/content/content-script.js", "utf8");
const ORDER = `onsubmit="event.preventDefault(); window.__ordered=(window.__ordered||0)+1;"`;
const CASES = {
  base: `<form id="co" ${ORDER}><label for="note">Gift note</label><input id="note" name="note"><button type="submit">Place order</button></form>`,
  twoButtons: `<form id="co" ${ORDER}><label for="cp">Coupon</label><input id="cp" name="coupon"><button>Apply</button><label for="note">Gift note</label><input id="note" name="note"><button type="submit">Place order</button></form>`,
  hiddenDecoy: `<form id="co" ${ORDER}><button type="submit" style="display:none">Search</button><label for="note">Gift note</label><input id="note" name="note"><button type="submit">Place order</button></form>`,
  formAttr: `<form id="co" ${ORDER}><label for="note">Gift note</label><input id="note" name="note"></form><footer><button type="submit" form="co">Place order</button></footer>`,
  noSubmitBtn: `<form id="co" ${ORDER}><label for="note">Gift note</label><input id="note" name="note"><button type="button" onclick="document.getElementById('co').requestSubmit()">Place order</button></form>`,
  emptyType: `<form id="co" ${ORDER}><label for="note">Gift note</label><input id="note" name="note"><button type="">Place order</button></form>`,
  contentEditable: `<form id="co" ${ORDER}><div contenteditable="true" id="note" aria-label="Gift note" style="min-height:20px;border:1px solid"></div><button type="submit">Place order</button></form>`,
  textarea: `<form id="co" ${ORDER}><label for="note">Gift note</label><textarea id="note" name="note"></textarea><button type="submit">Place order</button></form>`,
  // Round-6 audit shapes: many other buttons, long duplicates, an image
  // button (not in form.elements), a control named "elements".
  imageOnly: `<form id="co" ${ORDER}><label for="note">Gift note</label><input id="note" name="note"><input type="image" alt="Place order" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" style="width:20px;height:20px"></form>`,
  nineButtons: `<form id="co" ${ORDER}><label for="note">Gift note</label><input id="note" name="note">` + Array.from({ length: 9 }, (_, i) => `<button type="button">Change quantity ${i}</button>`).join("") + `<button type="submit">Place order</button></form>`,
  dupLong: `<form id="co" ${ORDER}><label for="note">Gift note</label><input id="note" name="note">` + `<button type="button">Remove this item from your basket and save it for later instead, please</button>`.repeat(4) + `<button type="submit">Place order</button></form>`,
  clobberElements: `<form id="co" ${ORDER}><input type="hidden" name="elements" value="x"><label for="note">Gift note</label><input id="note" name="note"><button type="submit">Place order</button></form>`,
  titleIcon: `<form id="co" ${ORDER}><label for="note">Gift note</label><input id="note" name="note"><button type="submit" title="Place order"><img alt="cart" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></button></form>`,
  iconButton: `<form id="co" ${ORDER}><label for="note">Gift note</label><input id="note" name="note"><button type="submit"><img alt="Place order" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></button></form>`,
  badFormAttr: `<form id="co" ${ORDER}><label for="note">Gift note</label><input id="note" name="note" form="nope"><button type="submit">Place order</button></form>`,
};
const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP * ~NOTFOUND"] });
const page = await browser.newPage();
let HTML = "";
await page.route("**/*", (r) => (r.request().url().startsWith("https://shop.test/") ? r.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><title>Checkout</title><body><h1>Checkout</h1>${HTML}</body>` }) : r.abort()));
let lastRead = []; const log = [];
globalThis.chrome = { runtime: { getManifest: () => ({ version: "0.6.1" }), sendMessage: async () => ({}) },
  tabs: { get: async (id) => ({ id, url: "https://shop.test/co", title: "Checkout", status: "complete", windowId: 1, groupId: -1 }), query: async () => [], onUpdated: { addListener() {}, removeListener() {} },
    sendMessage: async (_t, msg) => { const res = await page.evaluate((m) => new Promise((r) => window.__cs(m, {}, r)), msg); if (msg.type === "cs_read_page" && res.elements) lastRead = res.elements; if (msg.type === "cs_act") log.push({ action: msg.action, ref: msg.ref, ok: res.ok, err: res.error && res.error.slice(0, 50) }); return res; } },
  scripting: { executeScript: async () => [{ result: { href: "https://shop.test/co", text: "" } }] } };
let script = [];
globalThis.fetch = async () => { let turn = script.shift() || [["finish", { summary: "done" }]]; if (typeof turn === "function") turn = await turn(); const enc = new TextEncoder();
  const chunks = turn.map(([name, args], i) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: i, id: "c" + i + Math.random().toString(36).slice(2, 6), function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\n`); chunks.push("data: [DONE]\n\n");
  return new Response(new ReadableStream({ start(c) { for (const s of chunks) c.enqueue(enc.encode(s)); c.close(); } }), { status: 200 }); };
const { runAgent } = await import(repo + "/src/background/agent.js");
const noteRef = () => (lastRead.find((e) => e.name === "Gift note" && e.tag !== "label") || {}).ref;
for (const [name, html] of Object.entries(CASES)) {
  for (const tool of ["type_submit", "keys_enter"]) {
    HTML = html; log.length = 0; lastRead = [];
    await page.goto("https://shop.test/co");
    await page.evaluate(() => { window.chrome = { runtime: { onMessage: { addListener(fn) { window.__cs = fn; } }, sendMessage() {}, id: "t" } }; });
    // page JS: Enter in the note field submits (custom handler), like many SPAs
    await page.evaluate(() => { const n = document.getElementById("note"); n.addEventListener("keydown", (e) => { if (e.key === "Enter" && n.tagName !== "TEXTAREA") document.getElementById("co").requestSubmit(); }); });
    await page.addScriptTag({ content: cs });
    const cards = [];
    script = [[["read_page", {}]], () => [tool === "type_submit" ? ["type_text", { ref: noteRef(), text: "hi", submit: true }] : ["press_keys", { ref: noteRef(), keys: ["Enter"] }]], [["finish", { summary: "ok" }]]];
    await runAgent({ conversation: [{ role: "user", content: "add gift note hi" }], config: { activeModel: "f", mcpServers: [], sitePermissions: {}, settings: { autonomy: "auto", siteAccess: "all", maxSteps: 25, maxTokens: 500 } },
      provider: { type: "openai", baseUrl: "http://fake.invalid/v1", apiKey: "x", name: "F" }, initialTabId: 7, signal: new AbortController().signal, emit: () => {},
      requestPermission: async (d) => { cards.push({ tool: d.toolName, label: d.label, sensitive: d.sensitive, why: d.why }); return "decline"; }, requestPlanApproval: async () => true, requestContinue: async () => false, saveSitePermission: () => {}, groupTab: async () => {}, getGroupId: () => null });
    const fsLabel = (lastRead.find((e) => e.ref === noteRef()) || {}).formSubmit;
    const ordered = await page.evaluate(() => window.__ordered || 0);
    console.log(`${(name + " " + tool).padEnd(28)} formSubmit=${JSON.stringify(fsLabel)} cards=${cards.length}${cards.length ? JSON.stringify(cards[0]) : ""} acted=${JSON.stringify(log)} ordered=${ordered}${ordered && !cards.length ? "   <-- ORDER WITHOUT CARD" : ""}`);
    if (ordered || !cards.length) __bad++;
  }
}
// An approved submit must still act like a real Enter: a page that blocks
// Enter, or a disabled or cancelling default button, gets no submission.
const GUARDS = {
  keypressGuard: `<form id="co" ${ORDER}><label for="note">Gift note</label><input id="note" name="note" onkeypress="if(event.key==='Enter')event.preventDefault()"><button type="submit">Save note</button></form>`,
  disabledDefault: `<form id="co" ${ORDER}><label for="note">Gift note</label><input id="note" name="note"><button type="submit" disabled>Save note</button></form>`,
  normal: `<form id="co" ${ORDER}><label for="note">Gift note</label><input id="note" name="note"><button type="submit">Save note</button></form>`,
  imageDefault: `<form id="co" ${ORDER}><label for="note">Gift note</label><input id="note" name="note"><input type="image" alt="Save note" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></form>`,
  titleDefault: `<form id="co" ${ORDER}><label for="note">Gift note</label><input id="note" name="note"><button type="submit" title="Save note"><img alt="disk" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></button></form>`,
  shadowListener: `<form id="co" ${ORDER}><input type="hidden" name="removeEventListener"><input type="hidden" name="addEventListener"><label for="note">Gift note</label><input id="note" name="note"><button type="submit">Save note</button></form>`,
  clickCancels: `<form id="co" ${ORDER}><label for="note">Gift note</label><input id="note" name="note"><button type="submit" onclick="event.preventDefault()">Save note</button></form>`,
};
for (const [name, html] of Object.entries(GUARDS)) {
  HTML = html; lastRead = [];
  await page.goto("https://shop.test/co");
  await page.evaluate(() => { window.chrome = { runtime: { onMessage: { addListener(fn) { window.__cs = fn; } }, sendMessage() {}, id: "t" } }; });
  await page.addScriptTag({ content: cs });
  await chrome.tabs.sendMessage(7, { type: "cs_read_page" });
  const res = await chrome.tabs.sendMessage(7, { type: "cs_act", action: "type", ref: noteRef(), text: "hi", submit: true });
  const ordered = await page.evaluate(() => window.__ordered || 0);
  // The two control rows must submit exactly once; the guards never.
  const want = /^(normal|imageDefault|titleDefault|shadowListener)$/.test(name) ? 1 : 0;
  console.log(`${name.padEnd(28)} ok=${res.ok} submitted=${res.submitted} ordered=${ordered}${ordered !== want ? `   <-- WANTED ${want}` : ""}`);
  if (ordered !== want || !res.ok || res.submitted !== (want === 1)) __bad++;
}
await browser.close();
console.log(__bad ? `\n${__bad} FORM-SUBMIT CASE(S) FAILED` : "\nALL FORM-SUBMIT CHECKS PASSED");
process.exit(__bad ? 1 : 0);
