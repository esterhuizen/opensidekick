// Local agents (Claude Code, Codex, Cursor, …) reach the browser tools through
// the native bridge (native/opensidekick-bridge.mjs). They are trusted less
// than the user's own chat:
//   - Only on when the user turns on Settings → "Let local agents use this
//     browser" (which also grants the optional nativeMessaging permission).
//   - Each connection is paired with a card in the side panel first.
//   - The agent works only in tabs it opened itself, in its own tab group. It
//     never sees the user's own tabs.
//   - The first call on each site asks, reads included, and so does every call
//     on a sensitive site. Buy/Pay/Delete-like clicks, uploads and JavaScript
//     ask every time. Nothing is saved as "always allow"; a site the user
//     declines stays declined for that connection.
//   - Calls run one at a time, on the tab that was approved.
//   - Page text is scanned for injected instructions and flagged.

import { TOOL_DEFS, executeTool, groupTab, inReach, setOverlay } from "./tools.js";
import { evaluate, normalizeTarget, originOf, isSensitive, FOCUS_TOOLS } from "./permissions.js";
import { detectInjection, isSensitiveActionText, INJECTION_NOTE } from "./safety.js";

export const HOST_NAME = "com.opensidekick.bridge";
const WHY = "Asked by a program on this computer, through the OpenSidekick bridge";
const CARD_TIMEOUT_MS = 120_000;
const MAX_DECLINES = 3;
// Not offered: finishing or asking the user belongs to a chat, not to a caller.
const NOT_OFFERED = new Set(["finish", "ask_user"]);
// Tools that need no page and touch nothing outside the agent's own tabs.
const UNGATED = new Set(["list_tabs", "wait"]);
// Always a card, even on a site allowed earlier in this connection.
const ALWAYS_ASK = new Set(["run_javascript", "upload_file"]);
const REF_TOOLS = new Set(["click_element", "type_text", "select_option", "hover_element", "double_click", "right_click", "drag_element", "upload_file"]);

/** Tools offered to local agents under the current settings and browser. */
export function externalTools(settings, { cdpAvailable = true, jsAvailable = true } = {}) {
  return TOOL_DEFS.filter(
    (t) =>
      !NOT_OFFERED.has(t.name) &&
      !(t.visionOnly && !settings.enableVision) &&
      !(t.jsOnly && !(settings.enableJsTool && jsAvailable)) &&
      !(t.cdpOnly && !(settings.enableCdp && cdpAvailable)),
  );
}

// A display name a caller chose for itself: printable, short, and marked as a claim.
export function clientLabel(name) {
  const clean = String(name || "").replace(/[^\p{L}\p{N} ._()-]/gu, "").trim().slice(0, 40);
  return clean ? `A local agent ("${clean}")` : "A local agent";
}

/**
 * Serve the bridge until it disconnects.
 * deps: { loadConfig, requestPermission, isBusy, onClose, available, detachAll }
 */
export function connectBridge(deps) {
  const port = chrome.runtime.connectNative(HOST_NAME);
  const sessions = new Map(); // conn -> session
  let chain = Promise.resolve(); // one call at a time, across every connection

  port.onMessage.addListener((msg) => {
    if (msg?.type === "closed") {
      const s = sessions.get(msg.conn);
      sessions.delete(msg.conn);
      if (s) endSession(s, deps, sessions);
      return;
    }
    chain = chain.then(async () => {
      let res;
      try {
        res = await handle(msg, deps, sessions);
      } catch (e) {
        res = { error: String(e.message || e) };
      }
      try {
        port.postMessage({ ...res, id: msg.id });
      } catch {
        /* disconnected meanwhile */
      }
    });
  });
  port.onDisconnect.addListener(() => {
    for (const s of sessions.values()) endSession(s, deps, sessions);
    sessions.clear();
    deps.onClose?.(chrome.runtime.lastError?.message);
  });
  return port;
}

export function newSession(client) {
  const s = {
    client: clientLabel(client),
    grants: new Set(), // origins allowed for this connection
    declined: new Set(), // origins the user refused for this connection
    declines: 0,
    lastElements: new Map(), // ref -> label, from the agent's last read_page
    readOrigin: null, // the origin those refs came from
    tabId: null,
    groupId: null,
    known: new Set(), // the tabs this connection opened
  };
  s.ctx = {
    getTabId: async () => s.tabId,
    setTabId: (id) => (s.tabId = id),
    getGroupId: () => s.groupId,
    groupTab: async (id) => {
      s.groupId = (await groupTab(id, s.groupId, `OpenSidekick · ${s.client}`)) ?? s.groupId;
    },
    known: s.known,
  };
  return s;
}

async function endSession(s, deps, sessions) {
  for (const t of s.known) await setOverlay(t, "hide").catch(() => {});
  if (!sessions.size && !deps.isBusy()) await deps.detachAll?.().catch(() => {});
}

function card(deps, details) {
  return Promise.race([
    deps.requestPermission({ sensitive: true, why: WHY, unreachable: "no-panel", external: true, ...details }),
    new Promise((r) => setTimeout(() => r("timeout"), CARD_TIMEOUT_MS)),
  ]);
}

const NO_PANEL =
  "Not run: the OpenSidekick side panel is closed, so nobody can approve this. " +
  "Ask the user to open it (toolbar icon or Ctrl+E) and keep it open, then retry.";

export async function handle(msg, deps, sessions) {
  const config = await deps.loadConfig();
  if (!config.settings.enableExternal) return { error: "Local agents are turned off in OpenSidekick settings." };

  if (msg.type === "hello") {
    const s = newSession(msg.client);
    const choice = await card(deps, { pairing: true, client: s.client, toolName: "connect", origin: "" });
    if (choice === "no-panel") return { error: NO_PANEL };
    if (choice !== "once") return { error: "The user didn't allow this connection." };
    sessions.set(msg.conn, s);
    return { ok: true };
  }
  const s = sessions.get(msg.conn);
  if (!s) return { error: "This connection isn't approved." };
  if (s.blocked) return { error: `The user declined ${MAX_DECLINES} requests, so this connection is closed to further calls. Reconnect to try again.` };

  const tools = externalTools(config.settings, deps.available?.() || {});
  if (msg.type === "list") {
    return { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })) };
  }
  if (msg.type !== "call") return { error: "Unknown request." };
  if (!tools.some((t) => t.name === msg.name)) return { error: `Unknown or disabled tool: ${msg.name}` };
  if (deps.isBusy()) return { error: "OpenSidekick is running a chat task; try again when it finishes." };
  const result = await gatedCall(msg.name, msg.args || {}, config, deps, s);
  return { result: toMcp(result) };
}

// The agent's tab is still open; else fall back to another tab it opened.
async function liveTab(s) {
  if (s.tabId != null && (await chrome.tabs.get(s.tabId).catch(() => null))) return s.tabId;
  s.known.delete(s.tabId);
  s.tabId = null;
  for (const id of [...s.known]) {
    if (await chrome.tabs.get(id).catch(() => null)) return (s.tabId = id);
    s.known.delete(id);
  }
  return null;
}

// The site a call acts on, the way the chat agent judges it.
async function targetOf(name, args, s) {
  const tabId = await liveTab(s);
  if (name === "open_tab" || (name === "navigate" && !["back", "forward"].includes(args.url))) {
    const url = normalizeTarget(args.url);
    if (!url) return { error: "Only http(s) web addresses can be opened." };
    // No tab of its own yet: a navigate opens one; it never takes over the user's tab.
    return { url, name: tabId == null ? "open_tab" : name, args: { ...args, url } };
  }
  if (tabId == null) return { error: "You have no tab yet. Start with open_tab: you work in your own tabs, not the user's." };
  if (FOCUS_TOOLS.has(name)) {
    const tab = await chrome.tabs.get(Number(args.tab_id)).catch(() => null);
    if (!tab || !inReach(tab, s.groupId, tabId, s.known)) return { error: `No tab with id ${args.tab_id} among your tabs.` };
    return { url: tab.url || tab.pendingUrl || "", alt: tab.pendingUrl, name, args: { ...args, tab_id: tab.id } };
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return { error: "Your tab was closed." };
  return { url: tab.url || "", alt: tab.pendingUrl, name, args, tabId };
}

export async function gatedCall(callName, args, config, deps, s) {
  if (UNGATED.has(callName)) return executeTool(callName, args, s.ctx);
  const t = await targetOf(callName, args, s);
  if (t.error) return { ok: false, error: t.error };
  const name = t.name;

  // A page that is still loading is judged by where it is going too.
  const urls = [t.url, t.alt].filter(Boolean);
  for (const u of urls) {
    const v = evaluate(name, u, config, new Set());
    if (v.decision === "block") return { ok: false, error: v.reason };
  }
  const origins = [...new Set(urls.map((u) => originOf(u) || u))];
  const origin = origins[0];
  const sensitive = urls.some((u) => isSensitive(u));
  if (origins.some((o) => s.declined.has(o))) return { ok: false, error: "The user declined this site for this connection." };

  // Refs are only good for the page the agent last read.
  let label = "";
  if (REF_TOOLS.has(name) || args.ref != null) {
    const ref = name === "drag_element" ? args.from_ref : args.ref;
    if (!s.lastElements.has(ref) || s.readOrigin !== origin) {
      return { ok: false, error: "Unknown ref for this page. Call read_page first and use a ref it returned." };
    }
    label = s.lastElements.get(ref);
  }
  const riskyClick = (name === "click_element" || name === "double_click") && isSensitiveActionText(label);

  if (sensitive || riskyClick || ALWAYS_ASK.has(name) || origins.some((o) => !s.grants.has(o))) {
    const choice = await card(deps, { origin, toolName: name, args: t.args, label, client: s.client });
    if (choice === "no-panel") return { ok: false, error: NO_PANEL };
    if (choice === "timeout") return { ok: false, error: "Nobody answered the approval card in time. Not run." };
    if (choice !== "once") {
      s.declined.add(origin);
      if (++s.declines >= MAX_DECLINES) s.blocked = true;
      return { ok: false, error: "The user declined this action." };
    }
    if (!sensitive) for (const o of origins) s.grants.add(o);
  }

  // Run on the tab that was approved, and only if it still shows that site.
  if (t.tabId != null) {
    const now = await chrome.tabs.get(t.tabId).catch(() => null);
    if (!now || s.tabId !== t.tabId || !origins.includes(originOf(now.url || "") || now.url)) {
      return { ok: false, error: "The page changed while waiting for approval. Not run; read it again." };
    }
  }

  const shot = name === "take_screenshot";
  if (s.tabId != null) await setOverlay(s.tabId, shot ? "hide" : "show", `${s.client} is using this tab`);
  const result = (await executeTool(name, t.args, s.ctx)) || { ok: false, error: "No result." };
  if (shot && s.tabId != null) await setOverlay(s.tabId, "show", `${s.client} is using this tab`);
  if (name === "open_tab" && s.tabId != null) await setOverlay(s.tabId, "show", `${s.client} is using this tab`);

  if (name === "read_page" && result.ok !== false) {
    s.lastElements = new Map((result.elements || []).map((e) => [e.ref, e.name || ""]));
    s.readOrigin = originOf(result.url || "") || null;
  } else if (["navigate", "open_tab", "switch_tab"].includes(name)) {
    s.lastElements = new Map();
    s.readOrigin = null;
  }

  const text =
    name === "get_page_text"
      ? result.text
      : name === "read_page"
        ? JSON.stringify({ summary: result.summary, elements: result.elements || [] })
        : "";
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
