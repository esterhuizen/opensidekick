// Availability arrives as values (cdpAvailable, jsAvailable), never read from a
// namespace: every e2e run is Chromium, where a namespace read is always true, so the
// false paths Firefox gets are only checkable when the value is handed in.
// jsAvailable is false on Firefox because AMO's remote-code policy flags running
// model-generated code, not a missing API; the user setting stays on.

import { selectTools } from "../src/background/agent.js";

let fail = 0;
const ok = (cond, label) => {
  if (cond) console.log(`ok  : ${label}`);
  else {
    console.log(`FAIL: ${label}`);
    fail++;
  }
};

const names = (tools) => tools.map((t) => t.name);
const ALL = { enableCdp: true, enableVision: true, enableJsTool: true };

const jsOff = names(selectTools(ALL, { cdpAvailable: true, jsAvailable: false }));
ok(!jsOff.includes("run_javascript"), "no run_javascript when jsAvailable false");
ok(
  jsOff.includes("read_page") && jsOff.includes("read_console"),
  "the rows that need no code execution stay when jsAvailable is false",
);

const jsOn = names(selectTools(ALL, { cdpAvailable: true, jsAvailable: true }));
ok(jsOn.includes("run_javascript"), "run_javascript offered when jsAvailable true");

const jsUserOff = names(selectTools({ ...ALL, enableJsTool: false }, { cdpAvailable: true, jsAvailable: true }));
ok(!jsUserOff.includes("run_javascript"), "run_javascript stays gated on enableJsTool alone");

const noCdp = names(selectTools(ALL, { cdpAvailable: false, jsAvailable: true }));
ok(!noCdp.includes("read_console") && !noCdp.includes("read_network"), "read_console dropped when cdpAvailable false");
ok(noCdp.includes("read_page"), "the tools that need no debugger stay when there is no debugger");

const withCdp = names(selectTools(ALL, { cdpAvailable: true, jsAvailable: true }));
ok(
  withCdp.filter((n) => !noCdp.includes(n)).join(",") === "read_console,read_network",
  `the two cdpOnly rows are the only difference between the browsers (got ${withCdp.filter((n) => !noCdp.includes(n)).join(",")})`,
);

const cdpUserOff = names(selectTools({ ...ALL, enableCdp: false }, { cdpAvailable: true, jsAvailable: true }));
ok(
  !cdpUserOff.includes("read_console") && !cdpUserOff.includes("read_network"),
  "the cdpOnly tools stay dropped when the user turns the toggle off, even with a debugger",
);

const visionOff = names(selectTools({ ...ALL, enableVision: false }, { cdpAvailable: true, jsAvailable: true }));
ok(!visionOff.includes("take_screenshot") && visionOff.includes("read_page"), "vision tool dropped when enableVision false");

const COMBOS = [
  { cdpAvailable: false, jsAvailable: false },
  { cdpAvailable: false, jsAvailable: true },
  { cdpAvailable: true, jsAvailable: false },
  { cdpAvailable: true, jsAvailable: true },
];
const keepSend = COMBOS.every((a) => {
  const n = names(selectTools(ALL, a));
  return n.includes("type_text") && n.includes("press_keys");
});
ok(keepSend, "type_text and press_keys stay in every availability combo");

console.log(fail ? `\n${fail} TOOL-FILTER CHECK(S) FAILED` : "\nALL TOOL-FILTER CHECKS PASSED");
process.exit(fail ? 1 : 0);
