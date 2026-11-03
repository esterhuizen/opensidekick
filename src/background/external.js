// External agents (Claude Code, Codex, Cursor, …) reach the browser tools
// through the native bridge (native/opensidekick-bridge.mjs). The commands come
// from outside the panel, so they are trusted less than the user's own chat:
//   - Only on when the user turns on Settings → "Let local agents use this browser".
//   - Blocked sites stay blocked; sensitive sites always ask.
//   - Every action (anything but a read) asks in the side panel; "Allow once"
//     covers that site until the bridge reconnects. Nothing is saved as
//     "always allow".
//   - The agent works in its own tab group, like a chat does.
//   - Page text is scanned for injected instructions and flagged.

import { TOOL_DEFS, executeTool, groupTab, inReach } from "./tools.js";
import { evaluate, normalizeTarget, originOf, isSensitive, MUTATING_TOOLS, FOCUS_TOOLS } from "./permissions.js";
import { detectInjection, INJECTION_NOTE } from "./safety.js";

export const HOST_NAME = "com.opensidekick.bridge";
const WHY = "Requested by an external agent (via the OpenSidekick bridge)";

/** Tools offered to external agents under the current settings. */
export function externalTools(settings) {
  return TOOL_DEFS.filter(
    (t) =>
      t.name !== "finish" &&
      !(t.jsOnly && !settings.enableJsTool) &&
      !(t.cdpOnly && !settings.enableCdp),
  );
}

/**
 * Connect to the bridge and serve its requests until it disconnects.
 * deps: { loadConfig, requestPermission, isBusy, activeTabId, onClose }
 */
export function connectBridge(deps) {
  const port = chrome.runtime.connectNative(HOST_NAME);
  let session = newSession();

  port.onMessage.addListener(async (msg) => {
    let res;
    try {
      if (msg.type === "call" && !(await alive(session))) session = newSession();
      res = await handle(msg, deps, session.ctx, session.grants);
    } catch (e) {
      res = { error: String(e.message || e) };
    }
    try {
      port.postMessage({ ...res, id: msg.id });
    } catch {
      /* disconnected meanwhile */
    }
  });
  port.onDisconnect.addListener(() => deps.onClose?.(chrome.runtime.lastError?.message));
  return port;
}

// A session is the agent's tab group plus the sites allowed "once" in it.
// Closing the group ends it: the next call starts a fresh one (new group, and
// every site asks again).
export function newSession() {
  const grants = new Set();
  let tabId = null;
  let groupId = null;
  const ctx = {
    getTabId: async () => tabId,
    setTabId: (id) => (tabId = id),
    getGroupId: () => groupId,
    groupTab: async (id) => {
      groupId = (await groupTab(id, groupId)) ?? groupId;
    },
  };
  return { ctx, grants };
}

// Still usable: its group exists. A closed tab inside a live group moves the
// agent to another tab of that group.
export async function alive({ ctx }) {
  const groupId = ctx.getGroupId();
  const tabId = await ctx.getTabId();
  if (groupId == null) return tabId == null || !!(await chrome.tabs.get(tabId).catch(() => null));
  const inGroup = await chrome.tabs.query({ groupId }).catch(() => []);
  if (!inGroup.length) return false;
  if (!inGroup.some((t) => t.id === tabId)) ctx.setTabId(inGroup[0].id);
  return true;
}

async function handle(msg, deps, ctx, grants) {
  const config = await deps.loadConfig();
  if (!config.settings.enableExternal) return { error: "External agents are turned off in OpenSidekick settings." };
  const tools = externalTools(config.settings);
  if (msg.type === "list") {
    return { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })) };
  }
  if (msg.type !== "call") return { error: "Unknown request." };
  if (!tools.some((t) => t.name === msg.name)) return { error: `Unknown or disabled tool: ${msg.name}` };
  if (deps.isBusy()) return { error: "OpenSidekick is running a chat task; try again when it finishes." };

  if ((await ctx.getTabId()) == null) {
    const id = await deps.activeTabId();
    if (id == null) return { error: "No browser tab to work on." };
    ctx.setTabId(id);
    await ctx.groupTab(id);
  }
  const result = await gatedCall(msg.name, msg.args || {}, config, deps, ctx, grants);
  return { result: toMcp(result) };
}

// The site a call acts on, the same way the chat agent judges it.
async function targetOf(name, args, ctx) {
  if (name === "open_tab" || (name === "navigate" && !["back", "forward"].includes(args.url))) {
    const url = normalizeTarget(args.url);
    return url ? { url, args: { ...args, url } } : { error: "Only http(s) web addresses can be opened." };
  }
  if (FOCUS_TOOLS.has(name)) {
    const tab = await chrome.tabs.get(Number(args.tab_id)).catch(() => null);
    if (!tab || !inReach(tab, ctx.getGroupId(), await ctx.getTabId())) {
      return { error: `No tab with id ${args.tab_id} in your tab group.` };
    }
    return { url: tab.url || tab.pendingUrl || "", args: { ...args, tab_id: tab.id } };
  }
  const tab = await chrome.tabs.get(await ctx.getTabId()).catch(() => null);
  return tab ? { url: tab.url || "", args } : { error: "The agent's tab was closed." };
}

export async function gatedCall(name, args, config, deps, ctx, grants) {
  const t = await targetOf(name, args, ctx);
  if (t.error) return { ok: false, error: t.error };

  const verdict = evaluate(name, t.url, config, grants);
  if (verdict.decision === "block") return { ok: false, error: verdict.reason };
  const acts = MUTATING_TOOLS.has(name) || FOCUS_TOOLS.has(name);
  const origin = originOf(t.url) || t.url;
  // Unlike the chat, auto mode and "always allow" rules don't skip the card:
  // only a grant from this connection does. A sensitive site asks every time,
  // reads included: the caller could carry what it reads anywhere.
  const sensitive = verdict.sensitive || isSensitive(t.url);
  if (verdict.decision === "prompt" || sensitive || (acts && !grants.has(origin))) {
    const choice = await deps.requestPermission({
      origin,
      toolName: name,
      args: t.args,
      sensitive: true, // no "always allow" button for outside callers
      why: WHY,
      unreachable: "no-panel",
    });
    if (choice === "no-panel") {
      return {
        ok: false,
        error:
          "Not run: the OpenSidekick side panel is closed, so nobody can approve this. " +
          "Ask the user to open it (toolbar icon or Ctrl+E) and keep it open, then retry.",
      };
    }
    if (choice === "decline") return { ok: false, error: "The user declined this action." };
    if (!sensitive) grants.add(origin);
  }

  const result = await executeTool(name, t.args, ctx);
  const text = name === "get_page_text" ? result?.text : name === "read_page" ? JSON.stringify(result?.elements || []) : "";
  if (text && detectInjection(text).suspected) {
    result.suspected_injection = true;
    result.injection_note = INJECTION_NOTE;
  }
  return result;
}

// MCP tool result: the JSON as text, a screenshot as an image block.
export function toMcp(result) {
  const r = result || {};
  const { image, ...rest } = r;
  const content = [{ type: "text", text: JSON.stringify(rest) }];
  if (image) content.push({ type: "image", data: image.data, mimeType: image.mediaType });
  return { content, isError: r.ok === false };
}
