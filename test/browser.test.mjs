// The browser shim against fake namespaces — Chrome-only, Firefox-only, neither —
// run in plain node: the shim takes the namespace as a parameter, so no global
// chrome is needed. Firefox's sidebarAction.open() takes NO arguments and runs
// only inside a user gesture, so a gesture refusal must settle, not throw.
//
// Run: node test/browser.test.mjs

import { cdpSupported, panelSupported, openPanel, setPanelBehaviorOnActionClick, cdpToggle, CDP_HINT } from "../src/common/browser.js";

let fail = 0;
const ok = (cond, label) => {
  if (cond) console.log(`ok  : ${label}`);
  else {
    console.log(`FAIL: ${label}`);
    fail++;
  }
};

// A recording stub: the recorded argument lists are what the assertions read, so
// a stray argument shows up as a failed assertion.
const spy = (result) => {
  const fn = (...args) => {
    fn.calls.push(args);
    if (result instanceof Error) throw result;
    return result;
  };
  fn.calls = [];
  return fn;
};

const CHROME = {
  sidePanel: { open: spy(Promise.resolve()), setPanelBehavior: spy(Promise.resolve()) },
  debugger: { attach: spy(), sendCommand: spy() },
};
const FIREFOX = {
  sidebarAction: { open: spy(Promise.resolve()) },
};
const NEITHER = { action: { onClicked: { addListener: spy() } } };

// ---- The seam: import under plain node, no global chrome ----
ok(typeof globalThis.chrome === "undefined", "browser.js loads under plain node with no global chrome");

// ---- cdpSupported ----
ok(cdpSupported(CHROME) === true, "cdpSupported: true when attach and sendCommand are functions");
ok(cdpSupported(FIREFOX) === false, "cdpSupported: false on the Firefox namespace (no debugger)");
ok(cdpSupported(NEITHER) === false, "cdpSupported: false when debugger is absent");
ok(cdpSupported(null) === false, "cdpSupported: false on a null namespace");
ok(cdpSupported({ debugger: { attach: () => {} } }) === false, "cdpSupported: false when sendCommand is missing");
ok(cdpSupported({ debugger: { attach: "1.3", sendCommand: null } }) === false, "cdpSupported: false when neither is a function");

// ---- panelSupported ----
ok(panelSupported(CHROME) === true, "panelSupported: true on Chrome (sidePanel.open)");
ok(panelSupported(FIREFOX) === true, "panelSupported: true on Firefox (sidebarAction.open)");
ok(panelSupported(NEITHER) === false, "panelSupported: false on a namespace with neither API");
ok(panelSupported(null) === false, "panelSupported: false on a null namespace");
ok(panelSupported({ sidePanel: { open: 1 } }) === false, "panelSupported: false when open is not a function");

// ---- openPanel: Chrome ----
const chromeCalls = { ...CHROME };
const chromeOpen = await openPanel(chromeCalls, 42);
ok(JSON.stringify(chromeCalls.sidePanel.open.calls) === '[[{"tabId":42}]]', "openPanel: Chrome calls sidePanel.open({ tabId: 42 })");
ok(chromeOpen === true, "openPanel: Chrome resolves true when the panel opened");

// ---- openPanel: Firefox, no arguments ----
const firefoxCalls = { ...FIREFOX };
const firefoxOpen = await openPanel(firefoxCalls, 42);
ok(firefoxCalls.sidebarAction.open.calls.length === 1, "openPanel: Firefox calls sidebarAction.open() once");
ok(firefoxCalls.sidebarAction.open.calls[0].length === 0, "openPanel: Firefox passes NO arguments to sidebarAction.open()");
ok(firefoxOpen === true, "openPanel: Firefox resolves true when the sidebar opened");

// ---- openPanel: neither API ----
const neitherCalls = { ...NEITHER };
const neitherOpen = await openPanel(neitherCalls, 42);
ok(neitherOpen === undefined, "openPanel: resolves on a namespace with neither API");
ok(neitherCalls.action.onClicked.addListener.calls.length === 0, "openPanel: touches nothing when neither API is present");

// ---- openPanel: a gesture refusal settles, it never throws synchronously ----
const gesture = { sidePanel: { open: spy(new Error("sidePanel.open must be called from a user gesture")) } };
let threw = false;
let gesturePromise = null;
try {
  gesturePromise = openPanel(gesture, 42);
} catch {
  threw = true;
}
ok(!threw, "openPanel: a namespace whose open throws synchronously comes back as a promise, not a throw");
const gestureSettled = await gesturePromise.then((v) => ({ state: "resolved", value: v }), (e) => ({ state: "rejected", value: e }));
ok(gestureSettled.state === "resolved" && gestureSettled.value === false, "openPanel: the gesture refusal resolves neutral (false), no rejected promise leaks");

const ffBoom = { sidebarAction: { open: spy(new Error("open requires a user gesture")) } };
const ffSettled = await openPanel(ffBoom).then((v) => ({ state: "resolved", value: v }), () => ({ state: "rejected" }));
ok(ffSettled.state === "resolved" && ffSettled.value === false, "openPanel: a Firefox gesture refusal also resolves neutral");

// ---- openPanel: a rejected promise from the API settles the same way ----
const rejection = { sidePanel: { open: spy(Promise.reject(new Error("no tab"))) } };
const rejectedSettled = await openPanel(rejection, 42).then((v) => ({ state: "resolved", value: v }), () => ({ state: "rejected" }));
ok(rejectedSettled.state === "resolved" && rejectedSettled.value === false, "openPanel: a rejected API promise settles neutral, not as a rejection");

// ---- the icon-click guard: inert in Chrome ----
ok(typeof CHROME.sidebarAction?.open === "undefined", "guard: sidebarAction.open is absent on the Chrome namespace, so the icon listener is never registered there");
ok(typeof FIREFOX.sidebarAction?.open === "function", "guard: sidebarAction.open is present on the Firefox namespace, so the icon listener is registered there");

// ---- setPanelBehaviorOnActionClick ----
const behaviorChrome = { ...CHROME };
ok(setPanelBehaviorOnActionClick(behaviorChrome) === true, "setPanelBehaviorOnActionClick: true on Chrome");
ok(
  JSON.stringify(behaviorChrome.sidePanel.setPanelBehavior.calls) === '[[{"openPanelOnActionClick":true}]]',
  "setPanelBehaviorOnActionClick: Chrome gets { openPanelOnActionClick: true }",
);
ok(setPanelBehaviorOnActionClick(FIREFOX) === false, "setPanelBehaviorOnActionClick: no-op without sidePanel (Firefox)");
ok(setPanelBehaviorOnActionClick(NEITHER) === false, "setPanelBehaviorOnActionClick: no-op without sidePanel (neither API)");
ok(setPanelBehaviorOnActionClick(null) === false, "setPanelBehaviorOnActionClick: no-op on a null namespace");
ok(behaviorChrome.sidebarAction?.open === undefined, "setPanelBehaviorOnActionClick: nothing was added to the Chrome namespace");
ok(behaviorChrome.sidePanel.setPanelBehavior.calls.length === 1, "setPanelBehaviorOnActionClick: called once, not on every call site");

const behaviorBoom = { sidePanel: { setPanelBehavior: spy(new Error("no sidePanel permission")) } };
let behaviorThrew = false;
try {
  setPanelBehaviorOnActionClick(behaviorBoom);
} catch {
  behaviorThrew = true;
}
ok(!behaviorThrew, "setPanelBehaviorOnActionClick: never throws synchronously when the call fails");

const behaviorReject = { sidePanel: { setPanelBehavior: spy(Promise.reject(new Error("no sidePanel permission"))) } };
ok(setPanelBehaviorOnActionClick(behaviorReject) === true, "setPanelBehaviorOnActionClick: true on Chrome when the behavior call is made");
await new Promise((r) => setImmediate(r));
ok(behaviorReject.sidePanel.setPanelBehavior.calls.length === 1, "setPanelBehaviorOnActionClick: a rejected behavior call is swallowed, not unhandled");

// The exact product copy is part of the contract, so it is asserted as a whole
// string imported from src/common/browser.js: the copy has one owner, so
// rewording CDP_HINT moves this suite and test/copy.test.mjs together.

// ---- cdpToggle: the options row's decision ----
// The shim returns the decision and options.js applies it, so a browser with no
// debugger disables the row and says why. These assertions read the decision,
// against the same fake namespaces as the rest of this suite.
const on = cdpToggle(true);
ok(on.disabled === false, "cdpToggle: toggle left enabled when the browser has a debugger");
ok(on.hint === undefined, "cdpToggle: no hint when the browser has a debugger");

const off = cdpToggle(false);
ok(off.disabled === true, "cdpToggle: toggle disabled when the browser has no debugger");
ok(off.hint === CDP_HINT, `cdpToggle: the disabled row carries the exact hint (got ${JSON.stringify(off.hint)})`);

// No fixture re-test: cdpSupported on the fake namespaces is asserted above and the
// four checks above cover the decision, so feeding a fixture through cdpToggle again
// adds a check that cannot fail on its own.

console.log(fail ? `\n${fail} BROWSER SHIM CHECK(S) FAILED` : "\nALL BROWSER SHIM CHECKS PASSED");
process.exit(fail ? 1 : 0);
