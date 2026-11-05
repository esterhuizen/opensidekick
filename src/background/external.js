// Local agents (Claude Code, Codex, Cursor, …) reach the browser tools through
// the native bridge (native/opensidekick-bridge.mjs). They are trusted less
// than the user's own chat:
//   - Only on when the user turns on Settings → "Let local agents use this
//     browser" (which also grants the optional nativeMessaging permission).
//   - Each connection is paired with a card in the side panel first.
//   - The agent works only in tabs it opened itself, in a window of its own
//     that never takes focus. It never sees the user's tabs or a chat's tabs.
//   - Reading or opening a site asks the first time; acting on a page asks
//     the first time per site too, separately. Sensitive sites ask every time.
//     Buy/Pay/Delete-like clicks, any click on a form's submit button, typing
//     with submit, any key press, drags and uploads ask every time. Nothing is saved as "always allow"; a site the user
//     declines stays declined for that connection.
//   - Every call is logged in the side panel; with no panel open, nothing runs.
//   - Calls run one at a time, on the tab and element that were approved.
//   - Page text is scanned for injected instructions and flagged.

import { TOOL_DEFS, executeTool, groupTab, inReach, setOverlay } from "./tools.js";
import { evaluate, normalizeTarget, originOf, isSensitive, FOCUS_TOOLS } from "./permissions.js";
import { detectInjection, isRiskyAgentAction, INJECTION_NOTE } from "./safety.js";

export const HOST_NAME = "com.opensidekick.bridge";
// The bridge program speaks this protocol; an older copy must be reinstalled.
export const BRIDGE_PROTOCOL = 2;
const WHY = "Asked by a program on this computer, through the OpenSidekick bridge";
const CARD_TIMEOUT_MS = 120_000;
const MAX_DECLINES = 3;
const PAIR_DECLINES = 3; // declined pairings before pairing pauses
const PAIR_PAUSE_MS = 10 * 60_000;
const PAYLOAD_MAX = 100_000; // longest text, file or script a card may approve
const RUN_TIMEOUT_MS = 45_000; // one call's run, once approved
// Not offered: finishing or asking belongs to a chat; JavaScript and the
// debugger readers are too strong for a caller the user can't see.
const NOT_OFFERED = new Set(["finish", "ask_user", "run_javascript", "read_console", "read_network"]);
// Need no page and touch nothing outside the agent's own tabs.
const UNGATED = new Set(["list_tabs", "wait"]);
// Reading or moving around: covered by "Allow reading this site".
const LOOK_TOOLS = new Set(["read_page", "get_page_text", "take_screenshot", "navigate", "open_tab", "switch_tab", "scroll", "hover_element"]);
const REF_TOOLS = new Set(["click_element", "type_text", "select_option", "hover_element", "double_click", "right_click", "drag_element", "upload_file"]);

const bridgeGroups = new Set(); // tab groups local agents own
export const isBridgeGroup = (id) => id != null && id !== -1 && bridgeGroups.has(id);

/** Tools offered to local agents under the current settings. */
export function externalTools(settings) {
  return TOOL_DEFS.filter((t) => !NOT_OFFERED.has(t.name) && !(t.visionOnly && !settings.enableVision));
}

// A display name a caller chose for itself: printable, short, and marked as a claim.
export function clientLabel(name) {
  const clean = String(name || "").replace(/[^\p{L}\p{N} ._()-]/gu, "").trim().slice(0, 40);
  return clean ? `A local agent ("${clean}")` : "A local agent";
}

// Why a call asks every time, even on a site allowed for actions; "" if it needn't.
export function riskReason(name, args, label, submits) {
  if (name === "upload_file") return "This uploads a file.";
  if (name === "press_keys") return "This presses keys, which can submit or trigger shortcuts.";
  if (name === "drag_element") return "This drags an element.";
  if (name === "type_text" && args.submit) return "This submits a form.";
  if (name === "click_element" || name === "double_click") {
    if (submits) return "This button submits a form.";
    if (isRiskyAgentAction(label)) return "This looks like a purchase, a send, or a change that may not be undone.";
  }
  return "";
}

// Submits a form or presses a key that may: always its own card.
export function isSubmit(name, args) {
  if (name === "type_text" && args.submit) return true;
  if (name === "press_keys") {
    const keys = Array.isArray(args.keys) ? args.keys : [args.keys];
    return keys.some((k) => /^(enter|return|numpadenter)$/i.test(String(k ?? "").split("+").pop()));
  }
  return false;
}

/**
 * Serve the bridge until it disconnects.
 * deps: { loadConfig, requestPermission, isBusy, activity, onClose, detachAll }
 */
export function connectBridge(deps) {
  const port = chrome.runtime.connectNative(HOST_NAME);
  const sessions = new Map(); // conn -> session
  const closed = new Set(); // conns that hung up (checked after every wait)
  const pairing = { declines: [] };
  let chain = Promise.resolve(); // one call at a time, across every connection

  const reply = (msg, res) => {
    try {
      port.postMessage({ ...res, id: msg.id });
    } catch {
      /* disconnected meanwhile */
    }
  };
  port.onMessage.addListener((msg) => {
    if (msg?.type === "closed") {
      closed.add(msg.conn);
      const s = sessions.get(msg.conn);
      sessions.delete(msg.conn);
      if (s) endSession(s, deps, sessions);
      return;
    }
    // Pairing waits on the user, so it runs beside the queue, not in it.
    if (msg?.type === "hello") {
      pair(msg, deps, sessions, closed, pairing)
        .catch((e) => ({ error: String(e.message || e) }))
        .then((res) => reply(msg, res));
      return;
    }
    chain = chain.then(async () => {
      let res;
      try {
        res = await handle(msg, deps, sessions, closed);
      } catch (e) {
        res = { error: String(e.message || e) };
      }
      reply(msg, res);
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
    look: new Set(), // origins it may read and open
    act: new Set(), // origins it may act on
    declined: new Set(),
    declines: 0,
    blocked: false,
    lastElements: new Map(), // ref -> { name, submits }, from the agent's last read_page
    readOrigin: null,
    readTab: null,
    tabId: null,
    groupId: null,
    windowId: null,
    known: new Set(), // the tabs this connection opened
  };
  s.ctx = {
    getTabId: async () => s.tabId,
    setTabId: (id) => (s.tabId = id),
    // Reach is only the agent's own tabs, never by group (a chat could share it).
    getGroupId: () => null,
    groupTab: async (id) => {
      const g = await groupTab(id, s.groupId, "OpenSidekick · agent");
      if (g != null) {
        s.groupId = g;
        bridgeGroups.add(g);
      }
    },
    // New tabs open in the agent's own window, which never takes focus.
    newTab: async (url) => {
      if (s.windowId != null) {
        const tab = await chrome.tabs.create({ url, windowId: s.windowId, active: true }).catch(() => null);
        if (tab) return tab;
      }
      const win = await chrome.windows.create({ url, focused: false });
      s.windowId = win.id;
      return win.tabs?.[0] || (await chrome.tabs.query({ windowId: win.id }))[0];
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
  return deps.requestPermission({
    why: WHY,
    unreachable: "no-panel",
    external: true,
    timeoutMs: CARD_TIMEOUT_MS,
    ...details,
  });
}

const NO_PANEL =
  "Not run: the OpenSidekick side panel is closed, so nobody can see or approve this. " +
  "Ask the user to open it (toolbar icon or Ctrl+E) and keep it open, then retry.";

export async function pair(msg, deps, sessions, closed, pairing, now = Date.now()) {
  const config = await deps.loadConfig();
  if (!config.settings.enableExternal) return { error: "Local agents are turned off in OpenSidekick settings." };
  if (msg.protocol !== BRIDGE_PROTOCOL) {
    return { error: "This OpenSidekick bridge is out of date. Run `node native/install.mjs <extension-id>` again from an updated copy." };
  }
  pairing.declines = pairing.declines.filter((t) => now - t < PAIR_PAUSE_MS);
  if (pairing.declines.length >= PAIR_DECLINES) {
    return { error: "Connections were declined several times, so new ones are paused for 10 minutes." };
  }
  // One connection card at a time, so a burst can't stack up cards to misclick.
  if (pairing.busy) return { error: "Another connection is waiting for approval. Try again in a moment." };
  const s = newSession(msg.client);
  pairing.busy = true;
  let choice;
  try {
    choice = await card(deps, { pairing: true, client: s.client, toolName: "connect", origin: "" });
  } finally {
    pairing.busy = false;
  }
  if (choice === "no-panel") return { error: NO_PANEL };
  if (choice !== "once") {
    pairing.declines.push(now);
    return { error: choice === "timeout" ? "Nobody answered the connection card in time." : "The user didn't allow this connection." };
  }
  if (closed.has(msg.conn)) return { error: "The connection closed." };
  sessions.set(msg.conn, s);
  return { ok: true };
}

export async function handle(msg, deps, sessions, closed = new Set()) {
  const config = await deps.loadConfig();
  if (!config.settings.enableExternal) return { error: "Local agents are turned off in OpenSidekick settings." };
  const s = sessions.get(msg.conn);
  if (!s) return { error: "This connection isn't approved." };
  if (s.blocked) return { error: `The user declined ${MAX_DECLINES} requests, so this connection is closed to further calls. Reconnect to try again.` };

  const tools = externalTools(config.settings);
  if (msg.type === "list") {
    return { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })) };
  }
  if (msg.type !== "call") return { error: "Unknown request." };
  if (!tools.some((t) => t.name === msg.name)) return { error: `Unknown or disabled tool: ${msg.name}` };
  if (deps.isBusy()) return { error: "OpenSidekick is running a chat task; try again when it finishes." };
  const live = () => !closed.has(msg.conn) && sessions.get(msg.conn) === s;
  const result = await gatedCall(msg.name, msg.args || {}, config, deps, s, live);
  return { result: toMcp(result) };
}

// The agent's tab is still open; else fall back to another tab it opened,
// forgetting refs read on the old one.
async function liveTab(s) {
  if (s.tabId != null && (await chrome.tabs.get(s.tabId).catch(() => null))) return s.tabId;
  s.known.delete(s.tabId);
  s.tabId = null;
  s.lastElements = new Map();
  s.readOrigin = null;
  for (const id of [...s.known]) {
    if (await chrome.tabs.get(id).catch(() => null)) return (s.tabId = id);
    s.known.delete(id);
  }
  return null;
}

const originOrUrl = (u) => originOf(u) || u;

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
  let tab;
  if (FOCUS_TOOLS.has(name)) {
    tab = await chrome.tabs.get(Number(args.tab_id)).catch(() => null);
    if (!tab || !inReach(tab, null, tabId, s.known)) return { error: `No tab with id ${args.tab_id} among your tabs.` };
    args = { ...args, tab_id: tab.id };
  } else {
    tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return { error: "Your tab was closed." };
  }
  // Mid-way to another site: judge it once it lands, never by where it was.
  if (tab.pendingUrl && originOrUrl(tab.pendingUrl) !== originOrUrl(tab.url || "")) {
    return { error: "That tab is still loading another site. Wait a moment and try again." };
  }
  return { url: tab.url || "", name, args, tabId: tab.id };
}

export async function gatedCall(callName, args, config, deps, s, live = () => true) {
  if (UNGATED.has(callName)) return executeTool(callName, args, s.ctx);
  const t = await targetOf(callName, args, s);
  if (t.error) return { ok: false, error: t.error };
  const { name } = t;

  const verdict = evaluate(name, t.url, config, new Set());
  if (verdict.decision === "block") return { ok: false, error: verdict.reason };
  const origin = originOrUrl(t.url);
  const sensitive = isSensitive(t.url);
  if (s.declined.has(origin)) return { ok: false, error: "The user declined this site for this connection." };

  for (const k of ["text", "content", "code"]) {
    if (String(t.args[k] ?? "").length > PAYLOAD_MAX) return { ok: false, error: `Too long to approve (${PAYLOAD_MAX / 1000}k characters max).` };
  }

  // Refs are only good for the tab and site the agent last read.
  let label = "";
  let submits = false;
  const ref = name === "drag_element" ? t.args.from_ref : t.args.ref;
  if (REF_TOOLS.has(name) || t.args.ref != null) {
    if (!s.lastElements.has(ref) || s.readOrigin !== origin || s.readTab !== t.tabId) {
      return { ok: false, error: "Unknown ref for this page. Call read_page first and use a ref it returned." };
    }
    ({ name: label, submits } = s.lastElements.get(ref));
  }

  const looks = LOOK_TOOLS.has(name);
  const grants = looks ? s.look : s.act;
  const reason = riskReason(name, t.args, label, submits);
  if (sensitive || reason || !grants.has(origin)) {
    const grantLabel = sensitive || reason ? "" : looks ? "Allow reading this site" : "Allow actions on this site";
    const choice = await card(deps, { origin, toolName: name, args: t.args, label, client: s.client, sensitive, grantLabel, reason });
    if (choice === "no-panel") return { ok: false, error: NO_PANEL };
    if (choice === "timeout") return { ok: false, error: "Nobody answered the approval card in time. Not run." };
    if (choice !== "once" && choice !== "always") {
      s.declined.add(origin);
      if (++s.declines >= MAX_DECLINES) s.blocked = true;
      return { ok: false, error: "The user declined this action." };
    }
    if (choice === "always" && grantLabel) {
      grants.add(origin);
      if (!looks) s.look.add(origin); // acting on a site includes reading it
    }
    if (!live()) return { ok: false, error: "The connection closed. Not run." };
    if (deps.isBusy()) return { ok: false, error: "OpenSidekick started a chat task meanwhile; try again when it finishes." };
  }

  // Run on the tab that was approved, and only if it still shows that site.
  if (t.tabId != null) {
    const now = await chrome.tabs.get(t.tabId).catch(() => null);
    const there = now && [now.url, now.pendingUrl].filter(Boolean).every((u) => originOrUrl(u) === origin);
    const same = FOCUS_TOOLS.has(name) || s.tabId === t.tabId;
    if (!there || !same) return { ok: false, error: "The page changed while waiting for approval. Not run; read it again." };
  }
  // Logged in the panel; no panel means nobody is watching, so it doesn't run.
  if (!(await deps.activity?.({ client: s.client, toolName: name, args: t.args, origin }))) return { ok: false, error: NO_PANEL };

  const overlay = `${s.client} is using this tab`;
  const shot = name === "take_screenshot";
  s.ctx.expect = REF_TOOLS.has(name) || t.args.ref != null ? label : undefined;
  let result;
  let timer;
  try {
    // A hung page must not stall every agent's calls behind it.
    result = await Promise.race([
      (async () => {
        if (s.tabId != null) await setOverlay(s.tabId, shot ? "hide" : "show", overlay);
        return (await executeTool(name, t.args, s.ctx)) || { ok: false, error: "No result." };
      })(),
      new Promise((r) => (timer = setTimeout(() => r({ ok: false, error: "The page didn't finish in time. It may be stuck; try again or open another tab." }), RUN_TIMEOUT_MS))),
    ]);
  } finally {
    clearTimeout(timer);
    s.ctx.expect = undefined;
  }
  if (s.tabId != null && (shot || name === "open_tab" || name === "navigate")) await setOverlay(s.tabId, "show", overlay);

  if (["navigate", "open_tab", "switch_tab"].includes(name)) {
    s.lastElements = new Map();
    s.readOrigin = null;
  }
  // A read that landed somewhere else (a redirect mid-read) isn't handed over.
  if (["read_page", "get_page_text", "take_screenshot"].includes(name) && result.ok !== false && result.url && originOrUrl(result.url) !== origin) {
    return { ok: false, error: "The page moved to another site during the read. Read it again." };
  }
  if (name === "read_page" && result.ok !== false) {
    s.lastElements = new Map((result.elements || []).map((e) => [e.ref, { name: e.name || "", submits: !!e.submits }]));
    s.readOrigin = origin;
    s.readTab = s.tabId;
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
