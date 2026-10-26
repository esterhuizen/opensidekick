// Unit tests for the per-site permission logic (pure — no chrome APIs),
// including the "only allowed sites" (allowlist) access mode.

// Namespace imports keep a missing export as a value, so binding the helper behind a typeof guard
// makes a suite that lacks the export print FAIL on these checks instead of crashing mid-run.
import * as perms from "../src/background/permissions.js";
import * as tools from "../src/background/tools.js";
const { evaluate, MUTATING_TOOLS, PAGE_READ_TOOLS, originOf, FOCUS_TOOLS } = perms;
const normalizeTarget = typeof tools.normalizeTarget === "function" ? tools.normalizeTarget : () => "no export";

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

// --- open_tab is gated by the destination it opens, not the tab being left ---
const DEST = "https://example.org/two";
const DEST_ORIGIN = "https://example.org";

// Without membership `open_tab` never reaches the gate.
ok(MUTATING_TOOLS.has("open_tab"),
  "open_tab is a mutating tool (set membership in MUTATING_TOOLS)");

// A new destination asks, the same way a new origin for a mutation does.
const openAsk = evaluate("open_tab", DEST, cfg("all", "ask"), none);
ok(openAsk.decision === "prompt" && openAsk.sensitive === false,
  "all/ask: open_tab to a new destination prompts, not flagged sensitive (decision and sensitive)");

// Auto mode allows the open and records the grant.
const openAuto = evaluate("open_tab", DEST, cfg("all", "auto"), none);
ok(openAuto.decision === "allow" && openAuto.autoGranted === true,
  "all/auto: open_tab to a new destination auto-allowed with autoGranted recorded (decision and autoGranted)");

// The block reason must name the destination the user blocked.
const blocked = evaluate("open_tab", DEST, cfg("all", "ask", { [DEST_ORIGIN]: "block" }), none);
ok(blocked.decision === "block", "all: open_tab to a blocked destination origin is blocked (decision)");
ok((blocked.reason || "").includes(DEST_ORIGIN),
  "all: the block reason names the destination origin (reason)");

// A bank destination is never auto-allowed, even under a stored allow.
const openBank = evaluate("open_tab", bank, cfg("all", "auto", { "https://www.chase.com": "allow" }), none);
ok(openBank.decision === "prompt" && openBank.sensitive === true,
  "all/auto: a bank destination prompts for open_tab even when stored allow, flagged sensitive (decision and sensitive)");

// In allowlist mode an unlisted destination is not trusted, so the open asks.
const openAllowlist = evaluate("open_tab", DEST, cfg("allowlist", "auto"), none);
ok(openAllowlist.decision === "prompt" && openAllowlist.newSite === true,
  "allowlist: open_tab to an unlisted destination prompts, flagged newSite (decision and newSite)");

// --- switch_tab is a focus tool: prompts in allowlist mode only, in every mode gated by block and bank ---
ok(FOCUS_TOOLS?.has("switch_tab"),
  "switch_tab is a focus tool (set membership in FOCUS_TOOLS)");
ok(!!FOCUS_TOOLS && [...FOCUS_TOOLS].every((t) => !MUTATING_TOOLS.has(t) && !PAGE_READ_TOOLS.has(t)),
  "FOCUS_TOOLS is disjoint from MUTATING_TOOLS and PAGE_READ_TOOLS (pairwise disjoint)");
ok(!!FOCUS_TOOLS && !MUTATING_TOOLS.has("list_tabs") && !PAGE_READ_TOOLS.has("list_tabs") && !FOCUS_TOOLS.has("list_tabs"),
  "list_tabs is in none of the three sets (membership)");

// In "all" mode, both autonomy settings allow the focus with no grant.
const swAsk = evaluate("switch_tab", DEST, cfg("all", "ask"), none);
ok(swAsk.decision === "allow" && swAsk.autoGranted !== true,
  "all/ask: switch_tab on an unlisted destination is allowed with no grant recorded (decision and autoGranted)");
const swAuto = evaluate("switch_tab", DEST, cfg("all", "auto"), none);
ok(swAuto.decision === "allow" && swAuto.autoGranted !== true,
  "all/auto: switch_tab on an unlisted destination is allowed with no grant recorded (decision and autoGranted)");

// An unlisted destination prompts in allowlist mode, like a read.
const swAllowlist = evaluate("switch_tab", DEST, cfg("allowlist", "auto"), none);
ok(swAllowlist.decision === "prompt" && swAllowlist.newSite === true,
  "allowlist: switch_tab to an unlisted destination prompts, flagged newSite (decision and newSite)");

// A block rule gates focus in every mode, naming the origin it moved to.
const swBlocked = evaluate("switch_tab", DEST, cfg("all", "auto", { [DEST_ORIGIN]: "block" }), none);
ok(swBlocked.decision === "block", "all/auto: switch_tab onto a blocked origin is blocked (decision)");
ok((swBlocked.reason || "").includes(DEST_ORIGIN),
  "all/auto: the switch_tab block reason names the origin it moved to (reason)");

// The bank rule gates focus in every mode, even under a stored allow.
const swBank = evaluate("switch_tab", bank, cfg("all", "auto", { "https://www.chase.com": "allow" }), none);
ok(swBank.decision === "prompt" && swBank.sensitive === true,
  "all/auto: switch_tab onto a sensitive origin stored allow prompts, flagged sensitive (decision and sensitive)");

// An allowed destination needs no prompt, and "Allow once" covers the next switch.
ok(evaluate("switch_tab", DEST, cfg("allowlist", "auto", { [DEST_ORIGIN]: "allow" }), none).decision === "allow",
  "allowlist: switch_tab onto an allowed origin is allowed (decision)");
ok(evaluate("switch_tab", DEST, cfg("allowlist", "auto"), new Set([DEST_ORIGIN])).decision === "allow",
  "allowlist: a session grant covers switch_tab (decision)");

// A target with no origin is refused, not prompted: the gate needs an origin to consent to.
ok(evaluate("open_tab", "", cfg("all", "ask"), none).decision === "block",
  "all/ask: open_tab with no origin is blocked, not prompted (decision)");

// A non-special scheme reports origin the string "null", which sitePermissions would key on.
ok(originOf("chrome://extensions") === "null",
  "originOf of a non-special scheme is the string null (origin)");
ok(evaluate("open_tab", "chrome://extensions", cfg("all", "ask"), none).decision === "block",
  "all/ask: open_tab to a null-origin target is blocked, not prompted (decision)");

// The gate key and the tab creation share one normalization; a non-http(s) target is refused.
ok(normalizeTarget("example.com") === "https://example.com",
  "bare host normalizes to https:// (the string the gate keys on)");
ok(normalizeTarget("  http://a.test/x  ") === "http://a.test/x",
  "a full url is trimmed, not re-prefixed (scheme kept)");
ok(normalizeTarget("https://a.test/y") === "https://a.test/y",
  "an explicit http(s) scheme is kept, not rewritten to https://");
ok(normalizeTarget("file:///etc/passwd") === "",
  "normalizeTarget refuses a file:// target (empty string)");
ok(normalizeTarget("chrome://extensions") === "",
  "normalizeTarget refuses a chrome:// target (empty string)");

console.log(fail ? "\nSOME PERMISSION TESTS FAILED" : "\nALL PERMISSION TESTS PASSED");
process.exit(fail);
