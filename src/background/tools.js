// Browser-control tools exposed to the model, plus their execution against the
// active tab. Tool schemas are provider-agnostic (plain JSON Schema); the
// provider layer converts them to the right wire format.

import { MSG } from "../common/constants.js";
import { captureTabScreenshot, dispatchMouseAction, dispatchDragAt, readConsole, readNetwork } from "./cdp.js";

export const TOOL_DEFS = [
  {
    name: "read_page",
    description:
      "Read the current page. Returns the page title, URL, a text summary, and a " +
      "list of interactive elements each with a numeric 'ref' id you can use with " +
      "click_element, type_text, and select_option. Call this before acting so you " +
      "know what is on the page, including controls in accessible embedded frames.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_page_text",
    description:
      "Get the full readable text content of the current page (article/main text). " +
      "Use for reading, summarizing, or extracting information.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "click_element",
    description: "Click an interactive element by its ref id from read_page.",
    parameters: {
      type: "object",
      properties: { ref: { type: "integer", description: "The element ref id." } },
      required: ["ref"],
      additionalProperties: false,
    },
  },
  {
    name: "click_at",
    description: "Click CSS viewport coordinates using trusted Chromium input. Can click controls in cross-origin iframes or canvas when no element ref is available. Use a recent screenshot to locate the point. Requires opt-in native input.",
    parameters: { type: "object", properties: {
      x: { type: "number", description: "Horizontal CSS viewport coordinate." },
      y: { type: "number", description: "Vertical CSS viewport coordinate." },
    }, required: ["x", "y"], additionalProperties: false },
    nativeOnly: true,
  },
  {
    name: "drag_at",
    description: "Drag using a real held-left-mouse gesture from source to destination CSS viewport coordinates. Works inside cross-origin iframes and with drop zones lacking an element ref. Locate both centers in a fresh screenshot. Requires opt-in native input.",
    parameters: { type: "object", properties: {
      start_x: { type: "number", description: "Source center X in CSS viewport pixels." },
      start_y: { type: "number", description: "Source center Y in CSS viewport pixels." },
      end_x: { type: "number", description: "Drop-zone center X in CSS viewport pixels." },
      end_y: { type: "number", description: "Drop-zone center Y in CSS viewport pixels." },
      duration_ms: { type: "integer", minimum: 250, maximum: 2500, description: "Duration (250–2500 ms); default 650. Increase for slower drag gestures." },
    }, required: ["start_x", "start_y", "end_x", "end_y"], additionalProperties: false },
    nativeOnly: true,
  },
  {
    name: "type_text",
    description:
      "Type text into an input, textarea, or editable element by its ref id. " +
      "Set submit=true to press Enter afterwards (e.g. to run a search).",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "integer", description: "The element ref id." },
        text: { type: "string", description: "The text to type." },
        submit: { type: "boolean", description: "Press Enter after typing." },
      },
      required: ["ref", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "select_option",
    description: "Choose an option in a <select> dropdown by its ref id.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "integer", description: "The <select> element ref id." },
        value: { type: "string", description: "Option value or visible label to select." },
      },
      required: ["ref", "value"],
      additionalProperties: false,
    },
  },
  {
    name: "navigate",
    description:
      "Navigate the current tab. Provide a full URL, or 'back' / 'forward' to use " +
      "history. https:// is added automatically if the scheme is missing.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "URL, or 'back' / 'forward'." } },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "scroll",
    description: "Scroll the page or a specific element into view.",
    parameters: {
      type: "object",
      properties: {
        direction: {
          type: "string",
          enum: ["up", "down", "top", "bottom"],
          description: "Scroll direction.",
        },
        ref: { type: "integer", description: "Optional element ref to scroll into view." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "take_screenshot",
    description:
      "Capture a screenshot of the visible part of the current page and attach it " +
      "as an image so you can SEE the page — layout, canvas/image content, or " +
      "anything not captured by read_page's text. Requires a vision-capable model. " +
      "Use when the text map isn't enough to understand or locate something.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    visionOnly: true,
  },
  {
    name: "hover_element",
    description: "Hover the pointer over an element by ref (reveals menus/tooltips).",
    parameters: {
      type: "object",
      properties: { ref: { type: "integer", description: "The element ref id." } },
      required: ["ref"],
      additionalProperties: false,
    },
  },
  {
    name: "double_click",
    description: "Double-click an element by ref.",
    parameters: {
      type: "object",
      properties: { ref: { type: "integer", description: "The element ref id." } },
      required: ["ref"],
      additionalProperties: false,
    },
  },
  {
    name: "right_click",
    description: "Right-click (open the context menu on) an element by ref.",
    parameters: {
      type: "object",
      properties: { ref: { type: "integer", description: "The element ref id." } },
      required: ["ref"],
      additionalProperties: false,
    },
  },
  {
    name: "drag_element",
    description:
      "Drag one element onto another (pointer-based drag-and-drop). Best-effort; " +
      "works on most modern drag interfaces.",
    parameters: {
      type: "object",
      properties: {
        from_ref: { type: "integer", description: "Ref of the element to drag." },
        to_ref: { type: "integer", description: "Ref of the drop target element." },
      },
      required: ["from_ref", "to_ref"],
      additionalProperties: false,
    },
  },
  {
    name: "press_keys",
    description:
      "Press a key or keyboard shortcut, e.g. ['Enter'] or ['Control','k']. " +
      "Sent to the focused element, or the element with the given ref.",
    parameters: {
      type: "object",
      properties: {
        keys: { type: "array", items: { type: "string" }, description: "Keys; last is the main key, earlier ones are modifiers (Control, Shift, Alt, Meta)." },
        ref: { type: "integer", description: "Optional element to focus first." },
      },
      required: ["keys"],
      additionalProperties: false,
    },
  },
  {
    name: "run_javascript",
    description:
      "Run JavaScript in the current page and get the result. Use `return` to " +
      "return a value, e.g. `return document.title` or " +
      "`return [...document.querySelectorAll('a')].map(a => a.href)`. Powerful " +
      "escape hatch for reading or manipulating the page when the other tools " +
      "aren't enough.",
    parameters: {
      type: "object",
      properties: { code: { type: "string", description: "JavaScript to run in the page. Use return to return a value." } },
      required: ["code"],
      additionalProperties: false,
    },
    jsOnly: true,
  },
  {
    name: "read_console",
    description:
      "Read recent browser console messages for the page (logs, warnings, errors, " +
      "uncaught exceptions). Monitoring starts when first called; reload the page " +
      "and read again to catch load-time errors. Useful for debugging.",
    parameters: {
      type: "object",
      properties: {
        only_errors: { type: "boolean", description: "Return only warnings and errors." },
        limit: { type: "integer", description: "Max messages to return (default 50)." },
      },
      additionalProperties: false,
    },
    cdpOnly: true,
  },
  {
    name: "read_network",
    description:
      "Read recent network requests the page made (method, URL, status). Monitoring " +
      "starts when first called; reload to capture load-time requests. Useful for " +
      "debugging failed API calls.",
    parameters: {
      type: "object",
      properties: {
        url_pattern: { type: "string", description: "Optional regex to filter request URLs." },
        limit: { type: "integer", description: "Max requests to return (default 50)." },
      },
      additionalProperties: false,
    },
    cdpOnly: true,
  },
  {
    name: "wait",
    description: "Wait a number of seconds for the page to update or content to load.",
    parameters: {
      type: "object",
      properties: { seconds: { type: "number", description: "Seconds to wait (max 10)." } },
      required: ["seconds"],
      additionalProperties: false,
    },
  },
  {
    name: "list_tabs",
    description: "List the open tabs in the current window (id, title, url, active).",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "open_tab",
    description: "Open a new tab with the given URL and switch the agent's focus to it.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "URL to open." } },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "switch_tab",
    description: "Switch the agent's focus to an existing tab by its id (from list_tabs).",
    parameters: {
      type: "object",
      properties: { tab_id: { type: "integer", description: "The tab id." } },
      required: ["tab_id"],
      additionalProperties: false,
    },
  },
  {
    name: "finish",
    description:
      "Call this when the task is complete or cannot proceed. Provide a short " +
      "summary of the result for the user.",
    parameters: {
      type: "object",
      properties: { summary: { type: "string", description: "Summary of the outcome." } },
      required: ["summary"],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

// ctx: { getTabId, setTabId }  — the agent owns the "focused" tab id and can
// change it (open_tab / switch_tab), so tools read/write it through ctx.
export async function executeTool(name, args, ctx) {
  const tabId = await ctx.getTabId();
  switch (name) {
    case "read_page":
      return await readAllFrames(tabId, ctx.includeFrames);
    case "get_page_text":
      return await readAllText(tabId, ctx.includeFrames);
    case "click_element":
      return await mouseAction(tabId, ctx, "click", args.ref);
    case "click_at":
      return await clickAt(tabId, ctx, args.x, args.y);
    case "drag_at":
      return await dragAt(tabId, ctx, args);
    case "type_text":
      return await frameAction(tabId, { type: MSG.CS_ACT, action: "type", ref: args.ref, text: args.text, submit: !!args.submit });
    case "select_option":
      return await frameAction(tabId, { type: MSG.CS_ACT, action: "select", ref: args.ref, value: args.value });
    case "hover_element":
      return await mouseAction(tabId, ctx, "hover", args.ref);
    case "double_click":
      return await mouseAction(tabId, ctx, "dblclick", args.ref);
    case "right_click":
      return await mouseAction(tabId, ctx, "contextmenu", args.ref);
    case "drag_element":
      return await mouseAction(tabId, ctx, "drag", args.from_ref, args.to_ref);
    case "press_keys":
      return args.ref == null
        ? await csSend(tabId, { type: MSG.CS_ACT, action: "keys", keys: args.keys })
        : await frameAction(tabId, { type: MSG.CS_ACT, action: "keys", keys: args.keys, ref: args.ref });
    case "take_screenshot":
      return await screenshot(ctx);
    case "run_javascript":
      return await runJavascript(ctx, args.code);
    case "read_console":
      return await readConsole(await ctx.getTabId(), { onlyErrors: !!args.only_errors, limit: args.limit });
    case "read_network":
      return await readNetwork(await ctx.getTabId(), { urlPattern: args.url_pattern, limit: args.limit });
    case "scroll":
      return args.ref == null
        ? await csSend(tabId, { type: MSG.CS_ACT, action: "scroll", direction: args.direction || "down" })
        : await frameAction(tabId, { type: MSG.CS_ACT, action: "scroll", direction: args.direction || "down", ref: args.ref });
    case "navigate":
      return await navigate(ctx, args.url);
    case "wait":
      return await waitSeconds(args.seconds);
    case "list_tabs":
      return await listTabs(ctx);
    case "open_tab":
      return await openTab(ctx, args.url);
    case "switch_tab":
      return await switchTab(ctx, args.tab_id);
    default:
      return { ok: false, error: `Unknown tool: ${name}` };
  }
}

// Show/update or hide the on-page activity overlay for a tab. Best-effort:
// silently no-ops on restricted pages where the content script can't run.
export async function setOverlay(tabId, state, label) {
  try {
    await ensureContentScript(tabId);
    await chrome.tabs.sendMessage(tabId, { type: MSG.CS_OVERLAY, state, label });
  } catch {
    /* restricted page or tab gone */
  }
}

// References are scoped to a tab and the last read_page, not DOM integers
// reused independently by each frame. Store exact frame URLs to reject stale
// references after inner-frame navigation.
const frameRefs = new Map(); // tabId -> Map(globalRef -> { frameId, localRef, url })

export function getRefUrl(tabId, ref) {
  return frameRefs.get(tabId)?.get(ref)?.url || null;
}

async function frameList(tabId) {
  // No webNavigation permission is needed: injected probes report frameIds.
  let frames;
  try {
    frames = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => location.href });
  } catch {
    frames = [{ frameId: 0, result: (await chrome.tabs.get(tabId)).url || "" }];
  }
  const out = [];
  for (const f of frames.sort((a, b) => a.frameId - b.frameId)) {
    if (!Number.isInteger(f.frameId)) continue;
    try {
      const pong = await chrome.tabs.sendMessage(tabId, { type: MSG.CS_PING }, { frameId: f.frameId });
      if (pong?.ok) { out.push({ frameId: f.frameId, url: pong.url || f.result }); continue; }
    } catch { /* not injected */ }
    try {
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [f.frameId] }, files: ["src/content/content-script.js"] });
      const pong = await chrome.tabs.sendMessage(tabId, { type: MSG.CS_PING }, { frameId: f.frameId });
      if (pong?.ok) out.push({ frameId: f.frameId, url: pong.url || f.result });
    } catch { /* restricted / sandboxed / insufficient host permission */ }
  }
  return out;
}

// Hide query tokens from LLM-facing metadata, but retain the exact URLs
// internally for navigation validation and origin-specific action permissions.
function displayFrameUrl(url) {
  try { const u = new URL(url); return u.origin + u.pathname; } catch { return "embedded document"; }
}

async function readAllFrames(tabId, includeFrames = true) {
  const frames = (await frameList(tabId)).filter((f) => includeFrames || f.frameId === 0);
  const refs = new Map(), elements = [], details = [];
  let top = null;
  for (const f of frames) {
    const r = await csSend(tabId, { type: MSG.CS_READ_PAGE }, f.frameId);
    if (!r?.ok) continue;
    if (f.frameId === 0) top = r;
    details.push({ frame_id: f.frameId, url: displayFrameUrl(f.url), title: r.title, ...(f.frameId ? { summary: r.summary } : {}) });
    for (const el of r.elements || []) {
      const ref = elements.length + 1;
      refs.set(ref, { frameId: f.frameId, localRef: el.ref, url: f.url });
      elements.push({ ...el, ref, ...(f.frameId ? { frame_id: f.frameId, frame_url: displayFrameUrl(f.url) } : {}) });
      if (elements.length >= 250) break;
    }
    if (elements.length >= 250) break;
  }
  frameRefs.set(tabId, refs);
  if (!top) return { ok: false, error: "Cannot read the top-level page." };
  return { ...top, elements, frames: details,
    note: elements.length >= 250 ? "Showing first 250 interactive elements across frames." : top.note };
}

async function readAllText(tabId, includeFrames = true) {
  const frames = (await frameList(tabId)).filter((f) => includeFrames || f.frameId === 0);
  let top = null;
  const parts = [], details = [];
  for (const f of frames) {
    const r = await csSend(tabId, { type: MSG.CS_GET_TEXT }, f.frameId);
    if (!r?.ok) continue;
    if (f.frameId === 0) top = r;
    details.push({ frame_id: f.frameId, url: displayFrameUrl(f.url) });
    if (r.text) parts.push((f.frameId ? "[Embedded: " + displayFrameUrl(f.url) + "]\n" : "") + r.text);
  }
  if (!top) return { ok: false, error: "Cannot read the top-level page." };
  return { ...top, text: parts.join("\n\n").slice(0, 16000), frames: details };
}

export async function ensureContentScript(tabId, frameId = 0) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: MSG.CS_PING }, { frameId });
    if (pong?.ok) return true;
  } catch { /* not injected */ }
  try {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ["src/content/content-script.js"] });
    return true;
  } catch { return false; }
}

async function csSend(tabId, msg, frameId = 0) {
  await ensureContentScript(tabId, frameId);
  try {
    return (await chrome.tabs.sendMessage(tabId, msg, { frameId })) ?? { ok: false, error: "No response from page." };
  } catch {
    return { ok: false, error: "Could not reach document/frame (restricted or navigated)." };
  }
}

async function resolvedRef(tabId, ref) {
  const target = frameRefs.get(tabId)?.get(ref);
  if (!target) return { error: "Unknown element ref. Call read_page again." };
  const pong = await csSend(tabId, { type: MSG.CS_PING }, target.frameId);
  if (!pong?.ok || pong.url !== target.url) return { error: "The document or iframe navigated. Call read_page again." };
  return target;
}

async function frameAction(tabId, msg) {
  const target = await resolvedRef(tabId, msg.ref);
  if (target.error) return { ok: false, error: target.error };
  if (msg.toRef != null) {
    const dest = await resolvedRef(tabId, msg.toRef);
    if (dest.error) return { ok: false, error: dest.error };
    if (dest.frameId !== target.frameId) return { ok: false, error: "Drag targets must be in the same frame." };
    msg = { ...msg, toRef: dest.localRef };
  }
  return await csSend(tabId, { ...msg, ref: target.localRef }, target.frameId);
}

async function mouseAction(tabId, ctx, action, ref, toRef) {
  const target = await resolvedRef(tabId, ref);
  if (target.error) return { ok: false, error: target.error };
  const fallback = () => frameAction(tabId, { type: MSG.CS_ACT, action, ref, ...(toRef == null ? {} : { toRef }) });
  if (!ctx.enableCdpInput) return await fallback();
  // A frame-local element rect is not the top viewport's CDP coordinate.
  // The content script can act inside OOPIFs; click_at handles trusted input.
  if (target.frameId !== 0) {
    const r = await fallback();
    return r?.ok ? { ...r, trusted_input: false, input_fallback: "iframe-dom",
      note: "For trusted input use click_at with screenshot viewport coordinates." } : r;
  }
  const point = await csSend(tabId, { type: MSG.CS_ACT, action: "target", ref: target.localRef });
  if (!point?.ok) return point;
  let destPoint = null;
  if (action === "drag") {
    const dest = await resolvedRef(tabId, toRef);
    if (dest.error) return { ok: false, error: dest.error };
    if (dest.frameId !== 0) return { ok: false, error: "Drag targets must be in the same frame." };
    destPoint = await csSend(tabId, { type: MSG.CS_ACT, action: "target", ref: dest.localRef });
    if (!destPoint?.ok) return destPoint;
  }
  try {
    await dispatchMouseAction(tabId, action, point, destPoint);
    const label = { click: "clicked", hover: "hovered", dblclick: "doubleClicked", contextmenu: "rightClicked" }[action];
    return { ok: true, [label || "dragged"]: label ? point.target : true, trusted_input: true,
      ...(point.obstructed || destPoint?.obstructed ? { obstructed: true,
        note: "Another element covers this target; the browser may click the covering element." } : {}) };
  } catch (e) {
    const r = await fallback();
    return r?.ok ? { ...r, trusted_input: false, input_fallback: "dom", native_input_error: String(e.message || e),
      ...(point.obstructed ? { obstructed: true, note: "The target is covered." } : {}) }
      : { ok: false, error: "Native input and DOM fallback failed: " + (e.message || e) };
  }
}

async function dragAt(tabId, ctx, args) {
  if (!ctx.enableCdpInput) return { ok: false, error: "Native pointer input is disabled in Settings." };
  const { start_x, start_y, end_x, end_y, duration_ms } = args;
  const coords = [start_x, start_y, end_x, end_y];
  if (!coords.every((n) => typeof n === "number" && Number.isFinite(n))) {
    return { ok: false, error: "Drag coordinates must be finite numbers." };
  }
  if (duration_ms !== undefined && (!Number.isInteger(duration_ms) || duration_ms < 250 || duration_ms > 2500)) {
    return { ok: false, error: "duration_ms must be an integer between 250 and 2500." };
  }
  const size = await chrome.scripting.executeScript({ target: { tabId }, func: () => ({ width: innerWidth, height: innerHeight }) });
  const { width, height } = size[0].result;
  if ([start_x, end_x].some((x) => x < 0 || x >= width) || [start_y, end_y].some((y) => y < 0 || y >= height)) {
    return { ok: false, error: "Source or destination outside the viewport." };
  }
  const start = { x: start_x, y: start_y }, end = { x: end_x, y: end_y };
  const result = await dispatchDragAt(tabId, start, end, duration_ms);
  return { ...result, dragged: { from: start, to: end }, note: "Gesture dispatched. Re-read the widget to verify the drop was accepted." };
}

async function clickAt(tabId, ctx, x, y) {
  if (!ctx.enableCdpInput) return { ok: false, error: "Native pointer input is disabled in Settings." };
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: "Invalid coordinates." };
  const size = await chrome.scripting.executeScript({ target: { tabId }, func: () => ({ width: innerWidth, height: innerHeight }) });
  const { width, height } = size[0].result;
  if (x < 0 || y < 0 || x >= width || y >= height) return { ok: false, error: "Coordinates outside the viewport." };
  await dispatchMouseAction(tabId, "click", { x, y });
  return { ok: true, clicked: { x, y }, trusted_input: true,
    note: "Chromium hit-testing chose the receiving element. Verify the page changed as expected." };
}

async function navigate(ctx, target) {
  const tabId = await ctx.getTabId();
  if (target === "back") {
    await chrome.tabs.goBack(tabId).catch(() => {});
  } else if (target === "forward") {
    await chrome.tabs.goForward(tabId).catch(() => {});
  } else {
    let url = target.trim();
    if (!/^https?:\/\//i.test(url) && !/^[a-z]+:\/\//i.test(url)) url = "https://" + url;
    await chrome.tabs.update(tabId, { url });
  }
  await waitForLoad(tabId);
  const tab = await chrome.tabs.get(tabId);
  return { ok: true, url: tab.url, title: tab.title };
}

async function openTab(ctx, url) {
  let full = url.trim();
  if (!/^https?:\/\//i.test(full) && !/^[a-z]+:\/\//i.test(full)) full = "https://" + full;

  let current = null;
  try {
    current = await chrome.tabs.get(await ctx.getTabId());
  } catch {
    /* fall back to Chrome's default window */
  }

  const createProps = { url: full, active: false };
  if (current && Number.isInteger(current.windowId)) createProps.windowId = current.windowId;
  const tab = await chrome.tabs.create(createProps);

  const groupId = typeof ctx.getTabGroupId === "function" ? ctx.getTabGroupId() : null;
  if (Number.isInteger(groupId) && groupId >= 0) {
    try {
      await chrome.tabs.group({ tabIds: [tab.id], groupId });
    } catch {
      // If the group vanished mid-run, keep the tab usable rather than failing.
    }
  }

  ctx.setTabId(tab.id);
  await waitForLoad(tab.id);
  const updated = await chrome.tabs.get(tab.id);
  return { ok: true, tab_id: tab.id, url: updated.url, title: updated.title, active: updated.active };
}

async function switchTab(ctx, tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const groupId = typeof ctx.getTabGroupId === "function" ? ctx.getTabGroupId() : null;
    if (Number.isInteger(groupId) && groupId >= 0 && tab.groupId !== groupId) {
      return { ok: false, error: `Tab ${tabId} is outside the current OpenSidekick workspace.` };
    }
    ctx.setTabId(tabId);
    return { ok: true, tab_id: tabId, url: tab.url, title: tab.title, active: tab.active };
  } catch {
    return { ok: false, error: `No tab with id ${tabId}.` };
  }
}

async function runJavascript(ctx, code) {
  const tabId = await ctx.getTabId();
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [String(code || "")],
      func: (src) => {
        try {
          // Function body so `return` works; runs in the page's global scope.
          const out = new Function(src)();
          let serialized;
          try {
            serialized = out === undefined ? "undefined" : JSON.stringify(out);
          } catch {
            serialized = String(out);
          }
          return { ok: true, result: serialized === undefined ? String(out) : serialized };
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) };
        }
      },
    });
    const r = results && results[0] && results[0].result;
    if (!r) return { ok: false, error: "No result (restricted page, or the script couldn't run)." };
    if (r.ok === false) return { ok: false, error: "JavaScript error: " + r.error };
    // The URL lets chat history spot a sensitive page read this way.
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    return { ok: true, url: tab ? tab.url : undefined, result: String(r.result).slice(0, 4000) };
  } catch (e) {
    return { ok: false, error: "Could not run JavaScript here: " + (e.message || e) };
  }
}

async function screenshot(ctx) {
  const tabId = await ctx.getTabId();
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { ok: false, error: "No active tab to capture." };
  }

  // If the tab is itself a direct image (e.g. someone opened a .jpg/.png URL),
  // send the actual full-resolution image instead of a viewport screenshot.
  // A viewport shot of an image document is the picture shrunk onto the
  // browser's gray backdrop, which reads poorly for the model.
  const direct = await fetchDirectImage(tab.url || "");
  if (direct) {
    return { ok: true, url: tab.url, image: direct, note: "Loaded the full-resolution image from this tab." };
  }

  try {
    // captureVisibleTab only captures the ACTIVE tab; use CDP for a background
    // workspace tab so the agent never sees somebody else's foreground page.
    const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    let data;
    if (active?.id === tabId) {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      data = dataUrl.split(",")[1];
    } else {
      const shot = await captureTabScreenshot(tabId);
      if (!shot?.data) return { ok: false, error: "Could not capture the background workspace tab." };
      data = shot.data;
    }
    // captureVisibleTab may return device pixels, while CDP Input expects CSS
    // pixels. Report both sizes so a vision model can convert accurately.
    let note = "Screenshot captured.";
    try {
      const header = atob(data.slice(0, 40));
      const read32 = (i) => header.charCodeAt(i) * 16777216 + header.charCodeAt(i + 1) * 65536 + header.charCodeAt(i + 2) * 256 + header.charCodeAt(i + 3);
      const bitmapWidth = read32(16), bitmapHeight = read32(20);
      const res = await chrome.scripting.executeScript({ target: { tabId }, func: () => ({ width: innerWidth, height: innerHeight }) });
      const css = res[0].result;
      note = `Screenshot bitmap: ${bitmapWidth}x${bitmapHeight} pixels; CSS viewport: ${css.width}x${css.height} pixels. click_at expects CSS viewport coordinates: multiply screenshot x by ${(css.width / bitmapWidth).toFixed(4)} and y by ${(css.height / bitmapHeight).toFixed(4)}.`;
    } catch { /* keep the screenshot even when viewport probing fails */ }
    return { ok: true, url: tab.url, image: { mediaType: "image/png", data }, note };
  } catch (e) {
    return {
      ok: false,
      error:
        "Could not capture a screenshot (restricted page, or the tab isn't visible): " +
        (e.message || e),
    };
  }
}

const IMAGE_URL_RE = /^https?:\/\/[^?#]+\.(jpe?g|png|gif|webp|bmp|avif)(\?[^#]*)?(#.*)?$/i;
// Model-accepted image media types; other formats fall back to a screenshot.
const MODEL_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

// When a tab points straight at an image, fetch its bytes and return
// { mediaType, data } for direct attachment. Returns null (→ fall back to a
// screenshot) if it isn't a fetchable, model-supported image.
async function fetchDirectImage(url) {
  if (!IMAGE_URL_RE.test(url)) return null;
  try {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) return null;
    const blob = await res.blob();
    const mediaType = (blob.type || "").toLowerCase();
    if (!MODEL_IMAGE_TYPES.has(mediaType)) return null;
    // Guard against very large payloads (data URI base64 ≈ 1.37× bytes).
    if (blob.size > 12 * 1024 * 1024) return null;
    const buf = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < buf.length; i += chunk) {
      binary += String.fromCharCode.apply(null, buf.subarray(i, i + chunk));
    }
    return { mediaType, data: btoa(binary) };
  } catch {
    return null;
  }
}

async function listTabs(ctx) {
  const groupId = typeof ctx.getTabGroupId === "function" ? ctx.getTabGroupId() : null;
  let tabs;
  if (Number.isInteger(groupId) && groupId >= 0) {
    tabs = await chrome.tabs.query({ groupId });
  } else {
    const current = await chrome.tabs.get(await ctx.getTabId()).catch(() => null);
    tabs = await chrome.tabs.query(current ? { windowId: current.windowId } : { currentWindow: true });
  }
  const focusedId = await ctx.getTabId();
  return {
    ok: true,
    tabs: tabs.map((t) => ({
      tab_id: t.id,
      title: t.title,
      url: t.url,
      active: t.active,
      agent_focused: t.id === focusedId,
    })),
  };
}

async function waitSeconds(seconds) {
  const ms = Math.min(Math.max(Number(seconds) || 1, 0), 10) * 1000;
  await new Promise((r) => setTimeout(r, ms));
  return { ok: true, waited_seconds: ms / 1000 };
}

function waitForLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      // Small settle delay so client-side rendering can start.
      setTimeout(resolve, 400);
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, timeoutMs);
    // In case it's already complete.
    chrome.tabs.get(tabId).then((t) => {
      if (t && t.status === "complete") finish();
    });
  });
}
