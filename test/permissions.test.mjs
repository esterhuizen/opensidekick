// Unit tests for the per-site permission logic (pure — no chrome APIs),
// including the "only allowed sites" (allowlist) access mode.

import { evaluate, MUTATING_TOOLS, PAGE_READ_TOOLS } from "../src/background/permissions.js";

let fail = 0;
const ok = (c, m) => { console.log((c ? "ok  : " : "FAIL: ") + m); if (!c) fail = 1; };

const cfg = (siteAccess, autonomy, sitePermissions = {}) => ({
  sitePermissions,
  settings: { siteAccess, autonomy },
});
const none = new Set();
const URL_A = "https://example.com/page";

// --- Default ("all") mode: unchanged behavior ---
ok(evaluate("read_page", URL_A, cfg("all", "ask"), none).decision === "allow",
  "all-mode: reads are always allowed");
ok(evaluate("click_element", URL_A, cfg("all", "ask"), none).decision === "prompt",
  "all-mode/ask: first mutation on a new site prompts");
ok(evaluate("click_element", URL_A, cfg("all", "auto"), none).decision === "allow",
  "all-mode/auto: mutation auto-allowed on a new site");
ok(evaluate("click_element", URL_A, cfg("all", "auto", { "https://example.com": "block" }), none).decision === "block",
  "all-mode: a blocked site blocks even in auto");

// Coordinate input must use the SAME policy as click_element (including Auto).
for (const action of ["click_element", "click_at", "drag_at"]) {
  ok(evaluate(action, URL_A, cfg("all", "auto"), none).decision === "allow",
    `${action}: Auto mode doesn't force confirmation on normal sites`);
  ok(evaluate(action, URL_A, cfg("all", "ask"), none).decision === "prompt",
    `${action}: Ask mode requires confirmation`);
  ok(evaluate(action, URL_A, cfg("all", "auto", { "https://example.com": "block" }), none).decision === "block",
    `${action}: explicit site blocks survive Auto mode`);
}

// --- Allowlist mode ---
const alPrompt = evaluate("read_page", URL_A, cfg("allowlist", "auto"), none);
ok(alPrompt.decision === "prompt" && alPrompt.newSite === true,
  "allowlist: reading an unlisted site prompts (even in auto), flagged newSite");
ok(evaluate("click_element", URL_A, cfg("allowlist", "auto"), none).decision === "prompt",
  "allowlist: acting on an unlisted site prompts even in auto");
ok(evaluate("read_page", URL_A, cfg("allowlist", "auto", { "https://example.com": "allow" }), none).decision === "allow",
  "allowlist: an allowed site reads freely");
ok(evaluate("click_element", URL_A, cfg("allowlist", "auto", { "https://example.com": "allow" }), none).decision === "allow",
  "allowlist: an allowed site acts freely in auto");
ok(evaluate("read_page", URL_A, cfg("allowlist", "auto", { "https://example.com": "block" }), none).decision === "block",
  "allowlist: a blocked site is blocked");
ok(evaluate("read_page", URL_A, cfg("allowlist", "auto"), new Set(["https://example.com"])).decision === "allow",
  "allowlist: a session grant (Allow once) covers subsequent tools");
ok(evaluate("list_tabs", URL_A, cfg("allowlist", "auto"), none).decision === "allow",
  "allowlist: non-page tools (list_tabs) are not gated");

// Sensitive sites still force per-action prompts for mutations, allowed or not.
const bank = "https://www.chase.com/pay";
const sens = evaluate("click_element", bank, cfg("allowlist", "auto", { "https://www.chase.com": "allow" }), none);
ok(sens.decision === "prompt" && sens.sensitive === true,
  "allowlist: sensitive-site mutations still prompt per action even when allowed");

for (const action of ["click_at", "drag_at"]) {
  const sensitiveCoordinate = evaluate(action, bank, cfg("all", "auto"), none);
  ok(sensitiveCoordinate.decision === "prompt" && sensitiveCoordinate.sensitive === true,
    `${action}: sensitive sites continue to confirm in Auto mode`);
}
for (const action of ["click_at", "drag_at"]) {
  ok(evaluate(action, URL_A, cfg("allowlist", "auto"), none).decision === "prompt",
    `${action}: allowlist mode still asks for new origins`);
}

// Sets are disjoint sanity.
ok([...PAGE_READ_TOOLS].every((t) => !MUTATING_TOOLS.has(t)),
  "PAGE_READ_TOOLS and MUTATING_TOOLS are disjoint");

console.log(fail ? "\nSOME PERMISSION TESTS FAILED" : "\nALL PERMISSION TESTS PASSED");
process.exit(fail);
