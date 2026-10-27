// Unit tests for the per-site permission logic (pure — no chrome APIs),
// including the "only allowed sites" (allowlist) access mode.

import { evaluate, MUTATING_TOOLS, PAGE_READ_TOOLS, FOCUS_TOOLS, originOf, hostOf, isSensitive, normalizeTarget, storedRule, stricter } from "../src/background/permissions.js";

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

// Sets are disjoint sanity.
ok([...PAGE_READ_TOOLS].every((t) => !MUTATING_TOOLS.has(t)),
  "PAGE_READ_TOOLS and MUTATING_TOOLS are disjoint");

// --- Tab tools (#8): open_tab is gated like navigate, switch_tab like a read ---
ok(MUTATING_TOOLS.has("open_tab") && MUTATING_TOOLS.has("navigate"), "open_tab and navigate are both mutating");
ok(MUTATING_TOOLS.has("hover_element"), "hover_element is gated (hover opens menus)");
ok(FOCUS_TOOLS.has("switch_tab") && !MUTATING_TOOLS.has("switch_tab") && !PAGE_READ_TOOLS.has("switch_tab"), "switch_tab is a focus tool only");
ok(!MUTATING_TOOLS.has("list_tabs") && !FOCUS_TOOLS.has("list_tabs"), "list_tabs stays ungated (pinned decision)");
ok(evaluate("open_tab", URL_A, cfg("all", "ask"), none).decision === "prompt", "all/ask: open_tab on a new site prompts");
ok(evaluate("open_tab", URL_A, cfg("all", "auto", { "https://example.com": "block" }), none).decision === "block", "open_tab to a blocked site is blocked, even in auto");
ok(evaluate("open_tab", bank, cfg("all", "auto"), none).sensitive === true, "open_tab to a bank asks per action, even in auto");
ok(evaluate("switch_tab", URL_A, cfg("all", "ask"), none).decision === "allow", "all/ask: switch_tab to an unlisted site is allowed");
ok(evaluate("switch_tab", URL_A, cfg("allowlist", "auto"), none).decision === "prompt", "allowlist: switch_tab to an unlisted site prompts");
ok(evaluate("switch_tab", URL_A, cfg("all", "auto", { "https://example.com": "block" }), none).decision === "block", "switch_tab to a blocked site is blocked");
ok(evaluate("switch_tab", bank, cfg("all", "auto"), none).sensitive === true, "switch_tab to a bank asks, even in auto");
ok(evaluate("switch_tab", "chrome://settings", cfg("all", "auto"), none).decision === "block", "switch_tab to an origin-less page is blocked");

// --- Trailing dots and parsed hosts ---
ok(originOf("https://Example.com./x") === "https://example.com", `trailing dot dropped from the origin (got ${originOf("https://Example.com./x")})`);
ok(evaluate("click_element", "https://example.com./", cfg("all", "auto", { "https://example.com": "block" }), none).decision === "block", "a trailing dot does not dodge a block rule");
ok(isSensitive("https://www.paypal.com./"), "a trailing dot does not dodge the sensitive patterns");
ok(originOf("http://localhost:3000/a") === "http://localhost:3000", "origin keeps the port");
ok(hostOf("https://chase.com?.approved.com") === "chase.com", "hostOf parses: chase.com?.approved.com is chase.com");
ok(hostOf("https://chase.com#.approved.com") === "chase.com", "hostOf parses: # suffix");
ok(hostOf("https://chase.com\\.approved.com") === "chase.com", "hostOf parses: backslash suffix");

// --- normalizeTarget: the one URL the gate and the tab share ---
const nt = (x) => normalizeTarget(x);
ok(nt("example.com") === "https://example.com/", "bare host gets https://");
ok(nt("  HTTPS://Example.com/a ") === "https://example.com/a", "scheme and host case folded, spaces trimmed");
ok(nt("localhost:3000") === "https://localhost:3000/", `host:port is a host (got ${nt("localhost:3000")})`);
ok(nt("intranet:8080/x") === "https://intranet:8080/x", "intranet:8080/x is a host with a path");
ok(nt("http://localhost:3000/") === "http://localhost:3000/", "explicit http kept");
for (const bad of ["javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "chrome://settings", "about:blank", "ftp://x.com", "", "   ", "https://chase.com@evil.com", "https://u:p@example.com"]) {
  ok(nt(bad) === "", `refused: ${JSON.stringify(bad)}`);
}
ok(originOf(nt("//evil.com/x")) === "https://evil.com", "//host is that host");
ok(hostOf(nt("chase.com?.approved.com")) === "chase.com", "normalized trick address still parses to chase.com");

// --- Block rules apply to reads in every mode; legacy trailing-dot keys still count ---
ok(evaluate("read_page", URL_A, cfg("all", "auto", { "https://example.com": "block" }), none).decision === "block", "all-mode: reading a blocked site is blocked");
ok(evaluate("get_page_text", URL_A, cfg("all", "ask"), none).decision === "allow", "all-mode: reading an unlisted site is still free");
ok(storedRule({ "https://example.com.": "block" }, "https://example.com./x") === "block", "a rule saved with a trailing dot still matches its own page");
ok(evaluate("click_element", "https://example.com./", cfg("all", "auto", { "https://example.com.": "block" }), none).decision === "block", "legacy trailing-dot block rule still blocks");
ok(stricter({ decision: "allow" }, { decision: "prompt", sensitive: true }).sensitive === true, "stricter: sensitive prompt beats allow");
ok(stricter({ decision: "block", reason: "x" }, { decision: "prompt" }).decision === "block", "stricter: block beats prompt");

ok(storedRule({ "https://example.com": "allow", "https://example.com.": "block" }, "https://example.com./") === "block", "a block on the dotted key wins over an allow on the plain key");
ok(storedRule({ "https://example.com": "allow" }, "https://example.com./") === "allow", "a plain-key allow covers the dotted page");

console.log(fail ? "\nSOME PERMISSION TESTS FAILED" : "\nALL PERMISSION TESTS PASSED");
process.exit(fail);
