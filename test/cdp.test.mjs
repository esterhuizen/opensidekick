// The debugger module against stubbed namespaces: the console/network degrade when
// the browser has no debugger, the callback form that settles attach, and the event
// listeners left feeding the buffers.
//
// The wrappers keep Chrome's callback shape, where chrome.runtime.lastError is the
// only failure signal a trailing callback receives. The fake sets lastError before it
// fires the callback and counts the reads, so a wrapper that never runs shows up as
// zero reads, and the guards that keep Firefox out of this module show up as zero
// reads too.
//
// The tool filter lives in test/agent-tools.test.mjs, which owns the filter checks.
//
// Run: node test/cdp.test.mjs

import { cdpAvailable, ensureAttached, readConsole, readNetwork, detachAll } from "../src/background/cdp.js";

let fail = 0;
const ok = (cond, label) => {
  if (cond) console.log(`ok  : ${label}`);
  else {
    console.log(`FAIL: ${label}`);
    fail++;
  }
};

const DEGRADE = { ok: false, error: "Console/network reading is not available in this browser." };
const asJson = (o) => JSON.stringify(o);

// Chrome defines lastError only while a trailing callback runs, so the fake sets it
// before firing the callback and counts every read the module makes.
let lastErrorReads = 0;
let lastErrorValue = undefined;
const runtime = {
  get lastError() {
    lastErrorReads++;
    return lastErrorValue;
  },
};

// Recording stub in Chrome's callback shape: the trailing callback fires with the
// result; when the call fails, lastError carries the message instead.
const spy = (result, rejectWith) => {
  const fn = (...args) => {
    fn.calls.push(args);
    lastErrorValue = rejectWith ? { message: rejectWith } : undefined;
    const cb = args[args.length - 1];
    if (typeof cb === "function") cb(result);
    return Promise.resolve(result);
  };
  fn.calls = [];
  return fn;
};

const CHROME_SHAPE = () => {
  const listeners = { event: [], detach: [] };
  return {
    runtime,
    debugger: {
      onEvent: { addListener: (fn) => listeners.event.push(fn) },
      onDetach: { addListener: (fn) => listeners.detach.push(fn) },
      attach: spy(undefined),
      detach: spy(undefined),
      sendCommand: spy({}),
    },
    listeners,
  };
};

const FIREFOX_SHAPE = () => ({
  runtime,
  sidebarAction: { open: spy(undefined) },
  action: { onClicked: { addListener: spy(undefined) } },
});

// A promise that never settles is the failure this module was built to avoid: the race
// names a hang instead of leaving the suite stuck.
const settle = (p, ms = 200) =>
  Promise.race([
    p.then((v) => ({ settled: true, v })).catch((e) => ({ settled: true, threw: e })),
    new Promise((r) => setTimeout(() => r({ settled: false }), ms)),
  ]);

// ---- The seam: import under plain node, no global chrome ----
ok(typeof globalThis.chrome === "undefined", "cdp.js loads under plain node with no global chrome");
ok(cdpAvailable() === false, "cdpAvailable: false with no chrome namespace at all");

// The namespace is the parameter, so the shape is handed in as an argument: Firefox
// has no debugger, Chrome has one, and the default stays the global the service
// worker runs with.
ok(cdpAvailable(FIREFOX_SHAPE()) === false, "cdpAvailable: false on the Firefox namespace handed in as the parameter");
ok(cdpAvailable(CHROME_SHAPE()) === true, "cdpAvailable: true on the Chrome namespace handed in as the parameter");
ok(cdpAvailable(null) === false, "cdpAvailable: false on a null namespace");

// ---- Firefox shape: no debugger, every guard short-circuits ----
globalThis.chrome = FIREFOX_SHAPE();
ok(cdpAvailable() === false, "cdpAvailable: false on the Firefox namespace (no debugger)");
const ffStart = lastErrorReads;

const ffConsole = await readConsole(1);
ok(asJson(ffConsole) === asJson(DEGRADE), `readConsole: the degrade object on Firefox (got ${asJson(ffConsole)})`);
const ffNetwork = await readNetwork(1, { urlPattern: "x", limit: 3 });
ok(asJson(ffNetwork) === asJson(DEGRADE), `readNetwork: the degrade object on Firefox (got ${asJson(ffNetwork)})`);

let ffEnsure;
try {
  ffEnsure = await ensureAttached(1);
} catch (e) {
  ffEnsure = { threw: e };
}
ok(ffEnsure === undefined, "ensureAttached: no-op on Firefox, resolves without touching the namespace");
let ffDetach;
try {
  ffDetach = await detachAll();
} catch (e) {
  ffDetach = { threw: e };
}
ok(ffDetach === undefined, "detachAll: no-op on Firefox, resolves without touching the namespace");
ok(lastErrorReads === ffStart, `the guards keep Firefox out of the wrappers, so nothing reads lastError (reads: ${lastErrorReads - ffStart})`);

// ---- Chrome shape: the callback settles the attach ----
const c = CHROME_SHAPE();
globalThis.chrome = c;
ok(cdpAvailable() === true, "cdpAvailable: true when attach and sendCommand are functions");

const cStart = lastErrorReads;
const firstAttach = await settle(ensureAttached(7));
ok(firstAttach.settled && firstAttach.v === undefined, "attach: the trailing callback settles it, so ensureAttached never hangs");
ok(c.debugger.attach.calls.length === 1, "ensureAttached: attaches once");
ok(
  lastErrorReads - cStart === 4,
  `the wrappers read lastError inside their callbacks: attach plus the three domain calls (reads: ${lastErrorReads - cStart})`,
);
const methods = c.debugger.sendCommand.calls.map((a) => a[1]);
ok(methods.join(",") === "Runtime.enable,Log.enable,Network.enable", `the domains are enabled best-effort (got ${methods.join(",")})`);
ok(c.listeners.event.length === 1, "the console/network event listener is bound once");

await ensureAttached(7);
ok(c.debugger.attach.calls.length === 1, "ensureAttached: a second call on the same tab does not re-attach");

// ---- the event listeners still feed the buffers ----
c.listeners.event[0]({ tabId: 7 }, "Runtime.consoleAPICalled", { type: "error", args: [{ value: "console_boom" }] });
c.listeners.event[0]({ tabId: 7 }, "Network.requestWillBeSent", { requestId: "r1", request: { method: "GET", url: "http://x/y" } });
const con = await readConsole(7);
ok(
  con.ok === true && con.messages.length === 1 && con.messages[0].text === "console_boom",
  `readConsole: a console event is captured (got ${asJson(con.messages)})`,
);
const net = await readNetwork(7, { urlPattern: "/y$" });
ok(
  net.ok === true && net.requests.length === 1 && net.requests[0].url === "http://x/y",
  `readNetwork: a network event is captured (got ${asJson(net.requests)})`,
);

// ---- best-effort enable: a rejected domain call must not break the attach ----
const boom = CHROME_SHAPE();
globalThis.chrome = boom;
boom.debugger.sendCommand = spy(undefined, "disabled on this page");
let boomRes;
try {
  boomRes = await settle(ensureAttached(9));
} catch (e) {
  boomRes = { threw: e };
}
ok(boomRes.settled && boomRes.v === undefined && boom.debugger.attach.calls.length === 1, "ensureAttached: a rejected domain call is swallowed, the attach stays");

// ---- detachAll detaches each attached tab, and the "not attached" lastError is ignored ----
// "Not attached" is the normal end-of-task case: the callback fires with lastError set
// and detach must resolve, not reject.
let detachArgs = [];
const d = CHROME_SHAPE();
globalThis.chrome = d;
d.debugger.detach = (...args) => {
  detachArgs.push(args[0]);
  lastErrorValue = { message: "Debugger is not attached to the tab" };
  args[args.length - 1]();
  return Promise.resolve();
};
await ensureAttached(4);
await ensureAttached(5);
const dStart = lastErrorReads;
const detached = await settle(detachAll());
ok(detached.settled && detached.v === undefined, "detachAll: resolves when the callback reports 'not attached'");
ok(
  detachArgs.some((a) => a.tabId === 4) && detachArgs.some((a) => a.tabId === 5),
  `detachAll: detached each attached tab (got ${JSON.stringify(detachArgs)})`,
);
ok(
  lastErrorReads - dStart === detachArgs.length,
  `the detach callback read lastError once per detach call (reads: ${lastErrorReads - dStart}, detaches: ${detachArgs.length})`,
);

console.log(fail ? `\n${fail} CDP CHECK(S) FAILED` : "\nALL CDP CHECKS PASSED");
process.exit(fail ? 1 : 0);
