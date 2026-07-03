import { parsePlan, hostFromDomain, planToText } from "../src/background/plan.js";

let fail = 0;
const eq = (a, b, msg) => {
  const pass = JSON.stringify(a) === JSON.stringify(b);
  console.log((pass ? "ok  : " : "FAIL: ") + msg);
  if (!pass) {
    console.log("   expected", JSON.stringify(b), "got", JSON.stringify(a));
    fail = 1;
  }
};
const ok = (c, m) => { console.log((c ? "ok  : " : "FAIL: ") + m); if (!c) fail = 1; };

// --- parsePlan ---
const p1 = parsePlan('{"summary":"Do X","steps":["a","b"],"domains":["github.com"],"needs_actions":true}');
eq(p1.summary, "Do X", "parsePlan: summary");
eq(p1.steps, ["a", "b"], "parsePlan: steps");
eq(p1.domains, ["github.com"], "parsePlan: domains");
ok(p1.needsActions === true, "parsePlan: needsActions true");

const p2 = parsePlan('```json\n{"summary":"S","steps":[],"domains":[],"needs_actions":false}\n```');
ok(p2.summary === "S", "parsePlan: strips code fences");
ok(p2.needsActions === false, "parsePlan: needs_actions false");

const p3 = parsePlan('Sure! Here is the plan:\n{"summary":"Y","steps":["one"],"domains":["a.com"]}\nHope that helps.');
eq(p3.steps, ["one"], "parsePlan: extracts JSON from surrounding prose");
ok(p3.needsActions === true, "parsePlan: defaults needsActions true when omitted");

const p4 = parsePlan("not json at all");
ok(p4.summary === "not json at all" && p4.needsActions === true, "parsePlan: falls back gracefully");

// --- hostFromDomain ---
ok(hostFromDomain("github.com") === "github.com", "host: bare domain");
ok(hostFromDomain("https://github.com/some/path") === "github.com", "host: strips scheme + path");
ok(hostFromDomain("http://127.0.0.1:8080/page") === "127.0.0.1", "host: strips port");
ok(hostFromDomain("Example.COM") === "example.com", "host: lowercased");

// --- planToText ---
const t = planToText({ summary: "Do it", steps: ["s1", "s2"], domains: ["x.com"] });
ok(/Do it/.test(t) && /1\. s1/.test(t) && /Sites: x\.com/.test(t), "planToText: renders summary, steps, sites");

console.log(fail ? "\nSOME PLAN TESTS FAILED" : "\nALL PLAN TESTS PASSED");
process.exit(fail);
