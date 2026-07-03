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
  if (!MUTATING_TOOLS.has(toolName)) return { decision: "allow" };

  const origin = originOf(url);
  if (!origin) return { decision: "block", reason: "Page has no permissible origin." };

  const stored = config.sitePermissions[origin];
  if (stored === "block") {
    return { decision: "block", reason: `You have blocked OpenSidekick on ${origin}.` };
  }

  const sensitive = isSensitive(url);
  if (sensitive) {
    // Sensitive sites always prompt per action and are never auto/always allowed.
    return { decision: "prompt", sensitive: true };
  }

  if (stored === "allow" || sessionGrants.has(origin)) {
    return { decision: "allow" };
  }

  if (config.settings.autonomy === "auto") {
    // Auto mode: allow on first touch but still record a session grant so the
    // side panel can show which sites were used.
    return { decision: "allow", autoGranted: true };
  }

  return { decision: "prompt", sensitive: false };
}
