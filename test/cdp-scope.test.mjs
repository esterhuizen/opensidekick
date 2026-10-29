// The scope contract for the cdp change, read from git: the three `chrome.debugger`
// wrappers stay untouched from origin/main, word for word, including the three
// `chrome.runtime.lastError` reads, and cdp.js carries only the degrade — the guards
// that answer "no debugger" before a wrapper is called. `git diff origin/main HEAD` is
// the diff a maintainer reads, so it is the thing to assert on.


import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { NO_DEBUGGER } from "../src/background/cdp.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
const fileAt = (ref, path) => git(["show", `${ref}:${path}`]);

let fail = 0;
const ok = (cond, label) => {
  if (cond) console.log(`ok  : ${label}`);
  else {
    console.log(`FAIL: ${label}`);
    fail++;
  }
};

const PATH = "src/background/cdp.js";
const BASE = "origin/main";
const mainSrc = fileAt(BASE, PATH);
const headSrc = fileAt("HEAD", PATH);
const diff = git(["diff", BASE, "HEAD", "--", PATH]);

const wrapper = (name) => {
  const m = mainSrc.match(new RegExp(`function ${name}\\([^{]*\\)\\s*{[\\s\\S]*?\\n}\\n`, "g"));
  return m ? m[0] : "";
};
const WRAPPERS = ["debuggerAttach", "debuggerDetach", "sendCommand"];

const isComment = (l) => /^\s*(\/\/|\*)/.test(l.slice(1));
// Comment lines are not code: the wrapper bodies are asserted verbatim below, so the anti-rewrite proof does not depend on them.
const removed = diff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).filter((l) => !isComment(l));
const added = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).filter((l) => !isComment(l));
ok(removed.length === 0, `nothing is removed from cdp.js's code lines, so no wrapper was rewritten (code removals: ${removed.length})`);
ok(
  !added.some((l) => l.includes("chrome.debugger.")),
  `the diff adds no code line that calls chrome.debugger (added debugger code lines: ${added.filter((l) => l.includes("chrome.debugger.")).length})`,
);

for (const w of WRAPPERS) {
  const body = wrapper(w);
  ok(body.length > 0 && headSrc.includes(body), `${w}: kept from origin/main, body verbatim`);
}

const reads = (headSrc.match(/runtime\.lastError/g) || []).length;
ok(reads === 3, `the three lastError reads are present (reads: ${reads})`);
ok(
  WRAPPERS.every((w) => headSrc.includes(wrapper(w)) && wrapper(w).includes("lastError")),
  "each wrapper still reads lastError inside its own callback",
);

ok(headSrc.includes('import { cdpSupported } from "../common/browser.js";'), "cdp.js imports cdpSupported from the browser shim");
ok(headSrc.includes("export function cdpAvailable(ns = globalThis.chrome)"), "cdpAvailable takes the namespace as a parameter");
// Reads the shipped string as data, not a literal re-typed here.
ok(
  headSrc.includes("export const NO_DEBUGGER") && headSrc.includes(`error: ${JSON.stringify(NO_DEBUGGER.error)}`),
  "NO_DEBUGGER is exported as the degrade result",
);
const guards = [
  ["ensureAttached", "export async function ensureAttached(tabId) {\n  if (!cdpAvailable()) return;"],
  ["readConsole", "const { onlyErrors = false, limit = 50 } = opts;\n  if (!cdpAvailable()) return NO_DEBUGGER;"],
  ["readNetwork", "const { urlPattern, limit = 50 } = opts;\n  if (!cdpAvailable()) return NO_DEBUGGER;"],
  ["detachAll", "export async function detachAll() {\n  if (!cdpAvailable()) return;"],
];
for (const [fn, guard] of guards) {
  ok(headSrc.includes(guard), `the guard short-circuits ${fn} when there is no debugger`);
}

ok(!headSrc.includes("Firefox ignores"), "the file carries no Firefox-ignores-the-callback copy");
ok(!headSrc.includes("Promise-first"), "the file carries no promise-settlement copy");
ok(!headSrc.includes("chrome.debugger.attach({ tabId }, \"1.3\");"), "attach is not rewritten to return a promise directly");

const testSrc = readFileSync(join(root, "test", "cdp.test.mjs"), "utf8");
ok(!testSrc.includes("promise-first"), "test/cdp.test.mjs asserts no promise-settlement shape");
ok(testSrc.includes("ALL CDP CHECKS PASSED"), "test/cdp.test.mjs is the degrade suite");

console.log(fail ? `\n${fail} CDP-SCOPE CHECK(S) FAILED` : "\nALL CDP-SCOPE CHECKS PASSED");
process.exit(fail ? 1 : 0);
