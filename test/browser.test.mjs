// The browser shim against fake namespaces — Chrome-only, Firefox-only, neither —
// run in plain node: the shim takes the namespace as a parameter, so no global
// chrome is needed. Firefox's sidebarAction.open() takes NO arguments and runs
// only inside a user gesture, so a gesture refusal must settle, not throw.
//
// Run: node test/browser.test.mjs

import { cdpSupported, panelSupported, openPanel, setPanelBehaviorOnActionClick, jsToolSupported, toolToggle, CDP_HINT, JS_HINT } from "../src/common/browser.js";

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
  // Measured on Chromium 149 (probe-firefox.md round 3): scripting is present and
  // runtime has no getBrowserInfo at all.
  scripting: { executeScript: spy(Promise.resolve()) },
  runtime: { getPlatformInfo: spy(Promise.resolve()) },
};
const FIREFOX = {
  sidebarAction: { open: spy(Promise.resolve()) },
  // Measured on Firefox 158 (probe-firefox.md round 2): scripting.executeScript is
  // present too, so a missing API is not the marker. runtime.getBrowserInfo is the
  // measured Firefox-only key.
  scripting: { executeScript: spy(Promise.resolve()) },
  runtime: { getBrowserInfo: spy(Promise.resolve()), getPlatformInfo: spy(Promise.resolve()) },
};
const NEITHER = { action: { onClicked: { addListener: spy() } } };

// ---- The seam: import under plain node, no global chrome ----
ok(typeof globalThis.chrome === "undefined", "browser.js loads under plain node with no global chrome");

// ---- cdpSupported ----
ok(cdpSupported(CHROME) === true, "cdpSupported: true when attach and sendCommand are functions");
ok(cdpSupported(FIREFOX) === false, "cdpSupported: false on the Firefox namespace (no debugger)");
ok(cdpSupported(NEITHER) === false, "cdpSupported: false when debugger is absent");
ok(cdpSupported({ debugger: { attach: () => {} } }) === false, "cdpSupported: false when sendCommand is missing");
ok(cdpSupported({ debugger: { attach: "1.3", sendCommand: null } }) === false, "cdpSupported: false when neither is a function");

// ---- panelSupported ----
ok(panelSupported(CHROME) === true, "panelSupported: true on Chrome (sidePanel.open)");
ok(panelSupported(FIREFOX) === true, "panelSupported: true on Firefox (sidebarAction.open)");
ok(panelSupported(NEITHER) === false, "panelSupported: false on a namespace with neither API");
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
let gesturePromise = null;
try {
  gesturePromise = openPanel(gesture, 42);
} catch {}
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

// ---- jsToolSupported: the run_javascript row's availability ----
// Firefox runs world: "MAIN" scripting from 128, so the tool is off by AMO's
// remote-code policy, not by a missing API. The detector is the measured marker:
// runtime.getBrowserInfo is 'function' on Firefox 158 and 'undefined' on Chromium
// 149, and scripting.executeScript is a function on both.
ok(jsToolSupported(CHROME) === true, "jsToolSupported: true on the Chrome namespace");
ok(jsToolSupported(FIREFOX) === false, "jsToolSupported: false on the Firefox namespace");

// ---- toolToggle: the options row's decision, one function for both rows ----
const on = toolToggle(true);
ok(on.disabled === false, "toolToggle: toggle left enabled when the browser can run the tool");
ok(on.hint === undefined, "toolToggle: no hint when the browser can run the tool");

const jsOff = toolToggle(false, JS_HINT);
ok(jsOff.disabled === true, "toolToggle: toggle disabled when the browser cannot run the tool");
ok(
  jsOff.hint === JS_HINT,
  `toolToggle: the disabled JS row carries the exact hint (got ${JSON.stringify(jsOff.hint)})`,
);

const cdpOff = toolToggle(false, CDP_HINT);
ok(
  cdpOff.hint === CDP_HINT,
  `toolToggle: the same function swaps in the debugger hint for the cdp row (got ${JSON.stringify(cdpOff.hint)})`,
);

console.log(fail ? `\n${fail} BROWSER SHIM CHECK(S) FAILED` : "\nALL BROWSER SHIM CHECKS PASSED");
process.exit(fail ? 1 : 0);
