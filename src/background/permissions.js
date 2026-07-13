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

import { SENSITIVE_HOST_PATTERNS } from "../common/constants.js";

export const MUTATING_TOOLS = new Set([
  "click_element",
  "type_text",
  "select_option",
  "navigate",
  "scroll",
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

export function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function isSensitive(url) {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return SENSITIVE_HOST_PATTERNS.some((re) => re.test(host));
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

  // Non-page tools (list_tabs, wait, finish, …) are never gated. Page reads are
  // free in "all sites" mode; in allowlist mode they're gated like actions.
  if (!isMutating && !(allowlistMode && isPageRead)) return { decision: "allow" };

  const origin = originOf(url);
  if (!origin) return { decision: "block", reason: "Page has no permissible origin." };

  const stored = config.sitePermissions[origin];
  if (stored === "block") {
    return { decision: "block", reason: `You have blocked OpenSidekick on ${origin}.` };
  }

  const sensitive = isSensitive(url);
  if (sensitive && isMutating) {
    // Sensitive sites always prompt per action and are never auto/always allowed.
    return { decision: "prompt", sensitive: true };
  }

  if (stored === "allow" || sessionGrants.has(origin)) {
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
