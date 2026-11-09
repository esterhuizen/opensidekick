// Mocked ref-based native input: opt-in, preflight, fallback and no double dispatch.
import assert from "node:assert/strict";
import { executeTool } from "../src/background/tools.js";
import { detachAll } from "../src/background/cdp.js";

let nativeCalls = [], messages = [], currentUrl = "https://example.com/page";
let failAttach = false, failRelease = false, preflight = null;
let lastError;
const callback = (fn) => (...args) => {
  const cb = args.at(-1);
  const error = fn(...args.slice(0, -1));
  lastError = error ? { message: error } : undefined;
  cb({});
  lastError = undefined;
};
globalThis.chrome = {
  runtime: { get lastError() { return lastError; } },
  debugger: {
    onEvent: { addListener() {} },
    onDetach: { addListener() {} },
    attach: callback(() => failAttach ? "debugger unavailable" : null),
    detach: callback(() => null),
    sendCommand: callback((_target, method, params) => {
      nativeCalls.push({ method, params });
      return failRelease && method === "Input.dispatchMouseEvent" && params.type === "mouseReleased" ? "release failed" : null;
    }),
  },
  tabs: {
    get: async () => ({ url: currentUrl }),
    sendMessage: async (_id, msg) => {
      messages.push(msg);
      if (msg.type === "cs_ping") return { ok: true };
      if (msg.action === "target") return preflight || { ok: true, x: 22, y: 30, target: "Search", obstructed: true };
      if (msg.action === "click") return { ok: true, clicked: "Search" };
      return { ok: false, error: "unexpected action" };
    },
  },
};
const ctx = {
  getTabId: async () => 123,
  enableNativeInput: false,
  nativeOrigin: "https://example.com",
  expect: "Search",
  expectSubmits: false,
  expectPaymentStep: false,
};
const run = () => executeTool("click_element", { ref: 3 }, ctx);
const pointerCalls = () => nativeCalls.filter((x) => x.method === "Input.dispatchMouseEvent");

let r = await run();
assert.equal(r.clicked, "Search");
assert.equal(pointerCalls().length, 0, "DOM remains the default and needs no debugger");
assert.equal(messages.at(-1).action, "click");

ctx.enableNativeInput = true;
r = await run();
assert.equal(r.trusted_input, true);
assert.equal(r.obstructed, true);
assert.match(r.note, /covering element/);
assert.deepEqual(pointerCalls().map((x) => x.params.type), ["mouseMoved", "mousePressed", "mouseReleased"]);
const target = messages.find((m) => m.action === "target");
assert.equal(target.expect, "Search");
assert.equal(target.expectPaymentStep, false, "the same sensitive-step guard is passed to preflight");

preflight = { ok: false, error: "Element changed" };
const previous = pointerCalls().length;
r = await run();
assert.equal(r.ok, false);
assert.equal(pointerCalls().length, previous, "ref preflight must block native input");
preflight = null;

currentUrl = "https://other.example/page";
r = await run();
assert.equal(r.ok, false);
assert.equal(pointerCalls().length, previous, "redirect after approval must block native input");
currentUrl = "https://example.com/page";

await detachAll();
failAttach = true;
r = await run();
assert.equal(r.input_fallback, "dom");
assert.equal(r.trusted_input, false);
assert.equal(pointerCalls().length, previous, "failed attachment uses the original DOM path");
failAttach = false;

failRelease = true;
r = await run();
assert.equal(r.ok, false);
assert.match(r.error, /partially executed/);
assert.match(r.note, /not attempted/);
assert.notEqual(messages.at(-1).action, "click", "possible native click must not replay via DOM");
failRelease = false;
await detachAll();

console.log("ALL NATIVE MOUSE INPUT TESTS PASSED");
