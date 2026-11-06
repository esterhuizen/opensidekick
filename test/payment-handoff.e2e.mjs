import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
// The shop-to-payment hand-off: steps before payment ("Checkout", "Finish
// Order", "Continue to payment") go through with no card in Auto mode; a form
// that takes card details asks before it is submitted, whatever its button
// says; and a read of the payment step carries the hand-off note.
import path from "node:path";
import { fileURLToPath } from "node:url";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let bad = 0;
const ok = (c, m) => { console.log((c ? "ok  : " : "FAIL: ") + m); if (!c) bad++; };
const { chromium } = createRequire(repo + "/node_modules/")("playwright");
const cs = readFileSync(repo + "/src/content/content-script.js", "utf8");
const ORDER = `onsubmit="event.preventDefault(); window.__ordered=(window.__ordered||0)+1;"`;
const STEP = `onclick="window.__stepped=(window.__stepped||0)+1"`;
const PAYFORM = (btn) => `<form id="pay" ${ORDER}><label for="cc">Card number</label><input id="cc" name="cardnumber" autocomplete="cc-number"><label for="note">Note for the driver</label><input id="note" name="note">${btn}</form>`;
const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP * ~NOTFOUND"] });
const page = await browser.newPage();
let HTML = "";
await page.route("**/*", (r) => (r.request().url().startsWith("https://pizza.test/") ? r.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><title>Order</title><body>${HTML}</body>` }) : r.abort()));
let lastRead = null;
globalThis.chrome = { runtime: { getManifest: () => ({ version: "0.6.2" }), sendMessage: async () => ({}) },
  tabs: { get: async (id) => ({ id, url: "https://pizza.test/order", title: "Order", status: "complete", windowId: 1, groupId: -1 }), query: async () => [], onUpdated: { addListener() {}, removeListener() {} },
    sendMessage: async (_t, msg) => { const res = await page.evaluate((m) => new Promise((r) => window.__cs(m, {}, r)), msg); if (msg.type === "cs_read_page" && res.elements) lastRead = res; return res; } },
  scripting: { executeScript: async () => [{ result: { href: "https://pizza.test/order", text: "" } }] } };
let script = [];
let lastToolText = "";
globalThis.fetch = async (_u, init) => { try { const b = JSON.parse(init.body); const tm = b.messages.filter((m) => m.role === "tool").pop(); if (tm) lastToolText = String(tm.content); } catch { /* ignore */ }
  let turn = script.shift() || [["finish", { summary: "done" }]]; if (typeof turn === "function") turn = await turn(); const enc = new TextEncoder();
  const chunks = turn.map(([name, args], i) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: i, id: "c" + i + Math.random().toString(36).slice(2, 6), function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\n`); chunks.push("data: [DONE]\n\n");
  return new Response(new ReadableStream({ start(c) { for (const s of chunks) c.enqueue(enc.encode(s)); c.close(); } }), { status: 200 }); };
const { runAgent } = await import(repo + "/src/background/agent.js");
const refOf = (re) => ((lastRead?.elements || []).find((e) => re.test(e.name || "") && e.tag !== "label") || {}).ref;
async function run(html, call) {
  const calls = Array.isArray(call) ? call : [call];
  HTML = html; lastRead = null; lastToolText = "";
  await page.goto("https://pizza.test/order");
  await page.evaluate(() => { window.chrome = { runtime: { onMessage: { addListener(fn) { window.__cs = fn; } }, sendMessage() {}, id: "t" } }; });
  await page.addScriptTag({ content: cs });
  const cards = [];
  script = [[["read_page", {}]], ...calls.map((c) => () => [c()]), [["finish", { summary: "ok" }]]];
  await runAgent({ conversation: [{ role: "user", content: "order my pizzas, I'll pay" }], config: { activeModel: "f", mcpServers: [], sitePermissions: {}, settings: { autonomy: "auto", siteAccess: "all", maxSteps: 25, maxTokens: 500 } },
    provider: { type: "openai", baseUrl: "http://fake.invalid/v1", apiKey: "x", name: "F" }, initialTabId: 7, signal: new AbortController().signal, emit: () => {},
    requestPermission: async (d) => { cards.push({ label: d.label, sensitive: d.sensitive, why: d.why }); return "decline"; }, requestPlanApproval: async () => true, requestContinue: async () => false, saveSitePermission: () => {}, groupTab: async () => {}, getGroupId: () => null });
  return { cards, ordered: await page.evaluate(() => window.__ordered || 0), stepped: await page.evaluate(() => window.__stepped || 0) };
}
// Steps before payment: no card, the click happens.
for (const label of ["Checkout", "Proceed to checkout", "0 item · $0.00 Finish Order", "Continue to payment", "Order now"]) {
  const r = await run(`<h1>Menu</h1><button ${STEP}>${label}</button>`, () => ["click_element", { ref: refOf(/./) }]);
  ok(r.cards.length === 0 && r.stepped === 1, `"${label}": no card, clicked (cards=${r.cards.length} clicked=${r.stepped})`);
}
// A payment form asks before it is submitted, whatever its button says.
const shapes = { continueBtn: `<button type="submit">Continue</button>`, iconBtn: `<button type="submit"><img alt="arrow" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></button>` };
for (const [name, btn] of Object.entries(shapes)) {
  for (const [how, call] of [
    ["click", () => ["click_element", { ref: (lastRead.elements.find((e) => e.submits) || {}).ref }]],
    ["enter", () => ["press_keys", { ref: refOf(/Note for the driver/), keys: ["Enter"] }]],
    ["type_submit", () => ["type_text", { ref: refOf(/Note for the driver/), text: "ring twice", submit: true }]],
  ]) {
    const r = await run(PAYFORM(btn), call);
    ok(r.cards.length === 1 && r.cards[0].sensitive && /payment form/.test(r.cards[0].why || "") && r.ordered === 0, `payment form ${name} ${how}: asks, not paid (cards=${JSON.stringify(r.cards)} ordered=${r.ordered})`);
  }
}
// The payment step carries the hand-off note; a plain page doesn't.
let r = await run(PAYFORM(`<button type="submit">Continue</button>`), () => ["finish", { summary: "ok" }]);
ok(lastRead && lastRead.paymentStep === true && /payment step/.test(lastToolText), "a card field marks the payment step and the model gets the note");
r = await run(`<h1>Pay</h1><iframe title="Secure card payment input frame" src="about:blank" style="width:300px;height:40px"></iframe><button>Place order</button>`, () => ["finish", { summary: "ok" }]);
ok(lastRead && lastRead.paymentStep === true, "a payment provider's card frame marks the payment step");
r = await run(`<h1>Menu</h1><button>Add to cart</button><label for="q">Search</label><input id="q">`, () => ["finish", { summary: "ok" }]);
ok(lastRead && !lastRead.paymentStep && !/payment step/.test(lastToolText), "a menu page is not the payment step");
// Round-1 audit shapes. A card frame from a payment provider and a plain
// "Submit": the payment step asks for any button that isn't plainly harmless.
const FRAME = `<iframe title="Secure card number input frame" src="about:blank" style="width:300px;height:40px"></iframe>`;
r = await run(`<h1>Pay</h1>${FRAME}<form ${ORDER}><button type="submit">Submit</button></form>`, () => ["click_element", { ref: refOf(/^Submit$/) }]);
ok(r.cards.length === 1 && r.ordered === 0, `card frame + "Submit": asks, not paid (cards=${r.cards.length} ordered=${r.ordered})`);
r = await run(`<h1>Review</h1><p>Pay with Visa ending in 4242</p><div role="button" tabindex="0" onclick="window.__ordered=(window.__ordered||0)+1">Order now</div>`, () => ["click_element", { ref: refOf(/Order now/) }]);
ok(r.cards.length === 1 && r.ordered === 0, `saved card + "Order now": asks, not paid (cards=${r.cards.length} ordered=${r.ordered})`);
r = await run(`<h1>Review</h1><p>Pay with Visa ending in 4242</p><a href="#back">Back</a> <button onclick="window.__stepped=(window.__stepped||0)+1">Edit order</button>`, () => ["click_element", { ref: refOf(/Edit order/) }]);
ok(r.cards.length === 0 && r.stepped === 1, `saved card + "Edit order": no card (cards=${r.cards.length})`);
for (const label of ["Book now", "Reserve now", "Pre-order now with 1-Click"]) {
  r = await run(`<h1>Table</h1><button ${STEP}>${label}</button>`, () => ["click_element", { ref: refOf(/./) }]);
  ok(r.cards.length === 1 && r.stepped === 0, `"${label}": asks (cards=${r.cards.length})`);
}
// Round-2 audit shapes: the brand on its own line, a saved card outside
// <main>, a role=link "Continue".
r = await run(`<main><h1>Review</h1></main><aside><div>Visa</div><div>&bull;&bull;&bull;&bull; 4242</div></aside><div role="button" tabindex="0" onclick="window.__ordered=(window.__ordered||0)+1">Order now</div>`, () => ["click_element", { ref: refOf(/Order now/) }]);
ok(r.cards.length === 1 && r.ordered === 0, `saved card outside main + "Order now": asks (cards=${r.cards.length} ordered=${r.ordered})`);
r = await run(`<h1>Review</h1><p>Mastercard ending in 4444</p><span role="link" tabindex="0" onclick="window.__ordered=(window.__ordered||0)+1">Continue</span>`, () => ["click_element", { ref: refOf(/Continue/) }]);
ok(r.cards.length === 1 && r.ordered === 0, `saved card + role=link "Continue": asks (cards=${r.cards.length} ordered=${r.ordered})`);
r = await run(`<h1>Menu</h1><p>Open 2024–2026. Call 0800 123 4567.</p><button ${STEP}>Continue</button>`, () => ["click_element", { ref: refOf(/Continue/) }]);
ok(r.cards.length === 0 && r.stepped === 1 && !lastRead.paymentStep, `years and phone numbers aren't a saved card (cards=${r.cards.length})`);
// A button that turns into "Pay" after the read: the second click on the same
// ref is refused because the label changed; a double click on a button is too.
const MORPH = `<h1>Basket</h1><button id="b" onclick="if(this.dataset.armed){window.__ordered=(window.__ordered||0)+1}else{this.dataset.armed=1;this.textContent='Pay $24.90'}">Continue to payment</button>`;
r = await run(MORPH, [() => ["click_element", { ref: refOf(/Continue to payment/) }], () => ["click_element", { ref: lastRead.elements.find((e) => e.tag === "button").ref }]]);
ok(r.ordered === 0 && /changed since you read/.test(lastToolText), `a button relabelled to Pay after the read is not pressed again (ordered=${r.ordered})`);
r = await run(MORPH, () => ["double_click", { ref: refOf(/Continue to payment/) }]);
ok(r.ordered === 0 && /use click_element/.test(lastToolText), `double_click on a button is refused (ordered=${r.ordered})`);
// A big payment page keeps the hand-off note after truncation.
r = await run(PAYFORM(`<button type="submit">Continue</button>`) + Array.from({ length: 200 }, (_, i) => `<a href="/p/${i}">Related product number ${i} with a long name</a>`).join(" "), () => ["finish", { summary: "ok" }]);
ok(/payment step/.test(lastToolText), "a big payment page still carries the hand-off note");
// Not payment: a library card, a passport expiry, a card search box.
for (const [name, html] of [["library card", `<form><label for="l">Library card number</label><input id="l"><button>Renew</button></form>`], ["passport expiry", `<form><label for="e">Passport expiry date</label><input id="e"><button>Save</button></form>`], ["card search", `<form><input type="search" aria-label="Search credit cards"><button>Search</button></form>`]]) {
  r = await run(html, () => ["click_element", { ref: lastRead.elements.find((e) => e.tag === "button").ref }]);
  ok(!lastRead.paymentStep && r.cards.length === 0, `${name}: not the payment step, no card (cards=${r.cards.length})`);
}
// A card number labelled only through aria-labelledby is still masked.
await run(`<span id="lab">Card number</span><input aria-labelledby="lab" value="4242424242424242">`, () => ["finish", { summary: "ok" }]);
ok(!/4242424242424242/.test(JSON.stringify(lastRead)), "a filled card number labelled by aria-labelledby is masked in the read");
await browser.close();
console.log(bad ? `\n${bad} PAYMENT-HANDOFF CHECK(S) FAILED` : "\nALL PAYMENT-HANDOFF CHECKS PASSED");
process.exit(bad ? 1 : 0);
