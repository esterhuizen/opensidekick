// Per-site permission logic. The agent must be granted access to act on a site.
//
// Model:
//   - Reads (read_page / get_page_text) are allowed on any site the user is
//     actively looking at — they don't modify anything.
//   - Mutating actions (click, type, select, navigate, submit) require the
//     origin to be "allow"-listed. The first such action on a new origin
//     triggers a user prompt (Allow once / Always allow / Decline), UNLESS
//     autonomy is "auto" and the origin isn't already blocked.
//   - Sensitive categories (banking, payments, crypto) always require an
//     explicit per-action confirmation and cannot be "always allowed".
//   - navigate and open_tab are judged by the site they load, not the page the
//     agent is on; switch_tab (a focus tool) by the tab it moves to, gated like
//     a read: it asks in allowlist mode and honours block and sensitive rules.

import { SENSITIVE_HOST_PATTERNS } from "../common/constants.js";

export const MUTATING_TOOLS = new Set([
  "click_element",
  "type_text",
  "select_option",
  "navigate",
  "open_tab",
  "scroll",
  "hover_element",
  "double_click",
  "right_click",
  "drag_element",
  "press_keys",
  "run_javascript",
]);

// Tools that read page content without modifying it. In the default "all sites"
// mode these are always permitted on the page the user is viewing; in
// "allowlist" site-access mode they are gated like actions, so the agent
// doesn't even read a site the user hasn't trusted.
export const PAGE_READ_TOOLS = new Set([
  "read_page",
  "get_page_text",
  "take_screenshot",
  "read_console",
  "read_network",
]);

// Tools that move the agent's focus to another tab without loading anything.
export const FOCUS_TOOLS = new Set(["switch_tab"]);

// "chase.com." is chase.com to the browser; without this a trailing dot would
// dodge block rules (keyed by origin) and the sensitive patterns (anchored at $).
function cleanHost(hostname) {
  return String(hostname || "").toLowerCase().replace(/\.+$/, "");
}

export function originOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return u.origin;
    return `${u.protocol}//${cleanHost(u.hostname)}${u.port ? ":" + u.port : ""}`;
  } catch {
    return null;
  }
}

/** The parsed hostname (lowercase, no trailing dot), or "" if it isn't a URL. */
export function hostOf(url) {
  try {
    return cleanHost(new URL(url).hostname);
  } catch {
    return "";
  }
}

export function isSensitive(url) {
  const host = hostOf(url);
  if (!host) return false;
  return SENSITIVE_HOST_PATTERNS.some((re) => re.test(host));
}

/**
 * The exact URL a navigate/open_tab target loads, or "" when it may not be
 * opened. The gate and the tab use this one string, so the site the user is
 * asked about is the site that loads. Bare hosts get https://; "host:port" is
 * a host, not a scheme; only http(s) is allowed; user:pass@ is refused because
 * "chase.com@evil.com" reads as one site and loads another.
 */
export function normalizeTarget(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return "";
  const hostPort = /^[a-z0-9.-]+:\d+(?:[/?#]|$)/i.test(raw);
  const hasScheme = !hostPort && /^[a-z][a-z0-9+.-]*:/i.test(raw);
  let u;
  try {
    u = new URL(hasScheme ? raw : "https://" + raw.replace(/^\/+/, ""));
  } catch {
    return "";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "";
  if (u.username || u.password || !u.hostname) return "";
  return u.href;
}

/**
 * The stored rule for a URL's site. Keys are origins without a trailing dot;
 * rules saved before that (raw "https://example.com.") still count.
 */
export function storedRule(sitePermissions, url) {
  const perms = sitePermissions || {};
  const origin = originOf(url);
  if (origin && perms[origin]) return perms[origin];
  try {
    return perms[new URL(url).origin] || null;
  } catch {
    return null;
  }
}

/** The stricter of two verdicts: block > sensitive prompt > prompt > allow. */
export function stricter(a, b) {
  const rank = (v) => (v.decision === "block" ? 3 : v.decision === "prompt" ? (v.sensitive ? 2 : 1) : 0);
  return rank(b) > rank(a) ? b : a;
}

/**
 * Decide whether a tool call is permitted right now.
 * Returns one of:
 *   { decision: "allow" }
 *   { decision: "block", reason }
 *   { decision: "prompt", sensitive: bool }   <- caller must ask the user
 *
 * `sessionGrants` is a Set of origins the user allowed "once" during this task.
 */
export function evaluate(toolName, url, config, sessionGrants) {
  const allowlistMode = config.settings.siteAccess === "allowlist";
  const isMutating = MUTATING_TOOLS.has(toolName);
  const isPageRead = PAGE_READ_TOOLS.has(toolName);
  const isFocus = FOCUS_TOOLS.has(toolName);

  // Non-page tools (list_tabs, wait, finish, …) are never gated. Page reads are
  // free in "all sites" mode; in allowlist mode they're gated like actions.
  // A focus tool always reaches the checks below, so block and sensitive rules
  // apply to it in every mode.
  if (!isMutating && !isFocus && !(allowlistMode && isPageRead)) {
    // A site the user blocked stays blocked for reads too.
    if (isPageRead && storedRule(config.sitePermissions, url) === "block") {
      return { decision: "block", reason: `You have blocked OpenSidekick on ${originOf(url)}.` };
    }
    return { decision: "allow" };
  }

  const origin = originOf(url);
  if (!origin || origin === "null") return { decision: "block", reason: "Page has no permissible origin." };

  const stored = storedRule(config.sitePermissions, url);
  if (stored === "block") {
    return { decision: "block", reason: `You have blocked OpenSidekick on ${origin}.` };
  }

  const sensitive = isSensitive(url);
  if (sensitive && (isMutating || isFocus)) {
    // Sensitive sites always prompt per action and are never auto/always allowed.
    return { decision: "prompt", sensitive: true };
  }

  if (stored === "allow" || sessionGrants.has(origin)) {
    return { decision: "allow" };
  }

  if (isFocus && !allowlistMode) {
    // Moving focus touches no page, so "all sites" mode lets it through; the
    // next action on that tab is gated on its own.
    return { decision: "allow" };
  }

  if (allowlistMode) {
    // Only-allowed-sites mode: a site not on the allowlist always prompts —
    // even in auto mode, and even for reads. The prompt is the quick "trust
    // this site" toggle.
    return { decision: "prompt", sensitive: false, newSite: true };
  }

  if (config.settings.autonomy === "auto") {
    // Auto mode: allow on first touch but still record a session grant so the
    // side panel can show which sites were used.
    return { decision: "allow", autoGranted: true };
  }

  return { decision: "prompt", sensitive: false };
}
