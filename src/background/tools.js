// Browser-control tools exposed to the model, plus their execution against the
// active tab. Tool schemas are provider-agnostic (plain JSON Schema); the
// provider layer converts them to the right wire format.

import { normalizeTarget } from "./permissions.js";
import { MSG } from "../common/constants.js";
import { readConsole, readNetwork } from "./cdp.js";

// The page list is the product's claim about the engine, so it has one owner here.
export const RESTRICTED_PAGE_HINT =
  "Could not reach the page. It may be a restricted page (chrome://, about: " +
  "pages, the browser's own extensions or add-ons store, or a PDF), or it " +
  "navigated away.";

const UPLOAD_MAX = 500_000;

export const TOOL_DEFS = [
  {
    name: "read_page",
    description:
      "Read the current page. Returns the page title, URL, a text summary, and a " +
      "list of interactive elements each with a numeric 'ref' id you can use with " +
      "click_element, type_text, and select_option. Call this before acting so you " +
      "know what is on the page. On big pages pass query (e.g. 'search box', " +
      "'checkout button') to get only the matching elements.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Optional: words describing the element(s) you want." } },
      additionalProperties: false,
    },
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
    name: "upload_file",
    description:
      "Attach a file you write to an <input type=file> by ref. You supply the " +
      "file's name and text content; files on the user's disk are not accessible.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "integer", description: "The file input's ref id." },
        name: { type: "string", description: "File name, e.g. cover-letter.txt." },
        content: { type: "string", description: "The file's text content." },
        mime: { type: "string", description: "MIME type (default text/plain)." },
      },
      required: ["ref", "name", "content"],
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
    description: "List the tabs you can work with: your OpenSidekick tab group plus your current tab (id, title, url, active).",
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
    description: "Switch the agent's focus to a tab from list_tabs, by its id.",
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
      properties: { summary: { type: "string", description: "Summary of the outcome. Empty if your last message already told the user." } },
      required: ["summary"],
      additionalProperties: false,
    },
  },
  {
    name: "ask_user",
    description:
      "Ask the user a question and end this turn; their reply arrives as the next message. " +
      "Use it only when you need something only the user can give: a choice between options, " +
      "missing details, or a login or CAPTCHA they must handle — and before sending, posting, publishing, " +
      "submitting, deleting or paying for anything the user didn't explicitly ask for. " +
      "Don't use it just to ask whether to keep working.",
    parameters: {
      type: "object",
      properties: { question: { type: "string", description: "The question, short and specific." } },
      required: ["question"],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

// ctx: { getTabId, setTabId }  — the agent owns the "focused" tab id and can
// change it (open_tab / switch_tab), so tools read/write it through ctx.
// Optional: ctx.expect (the label the caller saw: an element action is refused
// if the ref now names something else) and ctx.newTab(url) (where a new tab opens).
export async function executeTool(name, args, ctx) {
  switch (name) {
    case "read_page":
      return await csSend(await ctx.getTabId(), { type: MSG.CS_READ_PAGE, query: args.query || undefined });
    case "get_page_text":
      return await csSend(await ctx.getTabId(), { type: MSG.CS_GET_TEXT });
    case "click_element":
      return await csSend(await ctx.getTabId(), { type: MSG.CS_ACT, expect: ctx.expect, expectSubmits: ctx.expectSubmits, guard: ctx.guard, action: "click", ref: args.ref });
    case "type_text":
      return await csSend(await ctx.getTabId(), {
        type: MSG.CS_ACT, expect: ctx.expect, expectSubmits: ctx.expectSubmits, guard: ctx.guard,
        action: "type",
        ref: args.ref,
        text: args.text,
        submit: !!args.submit,
      });
    case "select_option":
      return await csSend(await ctx.getTabId(), {
        type: MSG.CS_ACT, expect: ctx.expect, expectSubmits: ctx.expectSubmits, guard: ctx.guard,
        action: "select",
        ref: args.ref,
        value: args.value,
      });
    case "hover_element":
      return await csSend(await ctx.getTabId(), { type: MSG.CS_ACT, expect: ctx.expect, expectSubmits: ctx.expectSubmits, guard: ctx.guard, action: "hover", ref: args.ref });
    case "double_click":
      return await csSend(await ctx.getTabId(), { type: MSG.CS_ACT, expect: ctx.expect, expectSubmits: ctx.expectSubmits, guard: ctx.guard, action: "dblclick", ref: args.ref });
    case "right_click":
      return await csSend(await ctx.getTabId(), { type: MSG.CS_ACT, expect: ctx.expect, expectSubmits: ctx.expectSubmits, guard: ctx.guard, action: "contextmenu", ref: args.ref });
    case "drag_element":
      return await csSend(await ctx.getTabId(), { type: MSG.CS_ACT, expect: ctx.expect, expectSubmits: ctx.expectSubmits, guard: ctx.guard, action: "drag", ref: args.from_ref, toRef: args.to_ref });
    case "press_keys":
      return await csSend(await ctx.getTabId(), { type: MSG.CS_ACT, expect: ctx.expect, expectSubmits: ctx.expectSubmits, guard: ctx.guard, action: "keys", keys: args.keys, ref: args.ref });
    case "upload_file":
      if (String(args.content ?? "").length > UPLOAD_MAX) return { ok: false, error: `The file is too big (max ${UPLOAD_MAX / 1000} KB of text).` };
      return await csSend(await ctx.getTabId(), {
        type: MSG.CS_ACT, expect: ctx.expect, expectSubmits: ctx.expectSubmits, guard: ctx.guard,
        action: "upload",
        ref: args.ref,
        name: args.name,
        content: args.content,
        mime: args.mime,
      });
    case "take_screenshot":
      return await screenshot(ctx);
    case "run_javascript":
      return await runJavascript(ctx, args.code);
    case "read_console":
      return await readConsole(await ctx.getTabId(), { onlyErrors: !!args.only_errors, limit: args.limit });
    case "read_network":
      return await readNetwork(await ctx.getTabId(), { urlPattern: args.url_pattern, limit: args.limit });
    case "scroll":
      return await csSend(await ctx.getTabId(), {
        type: MSG.CS_ACT, expect: ctx.expect, expectSubmits: ctx.expectSubmits, guard: ctx.guard,
        action: "scroll",
        direction: args.direction || "down",
        ref: args.ref,
      });
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
// Cosmetic, so it never waits long: a hung page must not hold up the caller.
export async function setOverlay(tabId, state, label) {
  let timer;
  try {
    await Promise.race([
      (async () => {
        await ensureContentScript(tabId);
        await chrome.tabs.sendMessage(tabId, { type: MSG.CS_OVERLAY, state, label });
      })(),
      new Promise((r) => (timer = setTimeout(r, 3000))),
    ]);
  } catch {
    /* restricted page or tab gone */
  } finally {
    clearTimeout(timer);
  }
}

// Ensure the content script is present in a tab; inject it if the page loaded
// before the extension (or for tabs the manifest match missed).
export async function ensureContentScript(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: MSG.CS_PING });
    if (pong && pong.ok) return true;
  } catch {
    /* not injected yet */
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/content/content-script.js"],
    });
    return true;
  } catch (e) {
    return false;
  }
}

const CS_TIMEOUT_MS = 30_000;

async function csSend(tabId, { guard, ...msg }) {
  await ensureContentScript(tabId);
  // A caller that gave up meanwhile (its deadline passed) sends nothing late.
  if (guard && !guard()) return { ok: false, error: "Cancelled: the call ran out of time." };
  try {
    // A page whose main thread hangs must not stall the caller forever.
    const res = await Promise.race([
      chrome.tabs.sendMessage(tabId, msg),
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: "The page didn't answer in time." }), CS_TIMEOUT_MS)),
    ]);
    return res ?? { ok: false, error: "No response from page." };
  } catch (e) {
    return { ok: false, error: RESTRICTED_PAGE_HINT };
  }
}

async function navigate(ctx, target) {
  const tabId = await ctx.getTabId();
  if (target === "back") {
    await chrome.tabs.goBack(tabId).catch(() => {});
  } else if (target === "forward") {
    await chrome.tabs.goForward(tabId).catch(() => {});
  } else {
    const url = normalizeTarget(target);
    if (!url) return { ok: false, error: "OpenSidekick navigates to http(s) addresses only." };
    await chrome.tabs.update(tabId, { url });
  }
  await waitForLoad(tabId);
  const tab = await chrome.tabs.get(tabId);
  return { ok: true, url: tab.url, title: tab.title };
}

async function openTab(ctx, url) {
  const full = normalizeTarget(url);
  if (!full) return { ok: false, error: "OpenSidekick opens tabs to http(s) addresses only." };
  const tab = ctx.newTab ? await ctx.newTab(full) : await chrome.tabs.create({ url: full, active: true });
  ctx.setTabId(tab.id);
  ctx.known?.add(tab.id);
  await ctx.groupTab?.(tab.id);
  await waitForLoad(tab.id);
  const updated = await chrome.tabs.get(tab.id);
  return { ok: true, tab_id: tab.id, url: updated.url, title: updated.title };
}

// Put a tab in the chat's tab group, or a new "OpenSidekick" one when the old
// group is gone (closed or ungrouped by the user). Returns the group id, or
// null on failure: grouping is cosmetic and must never fail a run.
export async function groupTab(tabId, groupId, title = "OpenSidekick") {
  if (typeof chrome.tabs.group !== "function") return null; // no tab groups (Firefox before 139)
  // Grouping into a group in another window would drag the tab across windows.
  if (groupId != null) {
    try {
      const [tab, group] = await Promise.all([chrome.tabs.get(tabId), chrome.tabGroups.get(groupId)]);
      if (tab.windowId !== group.windowId) groupId = null;
    } catch {
      groupId = null; // tab or group gone
    }
  }
  if (groupId != null) {
    try {
      return await chrome.tabs.group({ tabIds: [tabId], groupId });
    } catch {
      /* group gone — make a new one */
    }
  }
  try {
    const id = await chrome.tabs.group({ tabIds: [tabId] });
    await chrome.tabGroups.update(id, { title }).catch(() => {});
    return id;
  } catch {
    return null;
  }
}

async function switchTab(ctx, tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    ctx.setTabId(tabId);
    return { ok: true, tab_id: tabId, url: tab.url, title: tab.title };
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

  // captureVisibleTab grabs whatever tab is in front in that window, so it must
  // be the agent's tab before and after the capture: else it could be the
  // user's mail or bank tab.
  const inFront = async () => {
    const [front] = await chrome.tabs.query({ active: true, windowId: tab.windowId }).catch(() => []);
    return front?.id === tabId;
  };
  const notInFront = {
    ok: false,
    error: "The tab isn't in front in its window, so it can't be captured. Call switch_tab with its tab_id first.",
  };
  try {
    if (!(await inFront())) return notInFront;
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    if (!(await inFront())) return notInFront;
    const data = dataUrl.split(",")[1];
    return { ok: true, url: tab.url, image: { mediaType: "image/png", data }, note: "Screenshot captured." };
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

// The agent sees only its own tab group and the tab it's on, like Claude in
// Chrome: the user's other tabs (mail, bank, …) stay out of reach.
// `known` holds the tabs the run started on or opened itself, so reach still
// works where tab groups don't (Firefox before 139, a failed group call).
export function inReach(tab, groupId, focusedTabId, known) {
  return tab.id === focusedTabId || !!known?.has(tab.id) || (groupId != null && groupId !== -1 && tab.groupId === groupId);
}

async function listTabs(ctx) {
  const focused = await ctx.getTabId();
  const groupId = ctx.getGroupId?.();
  const tabs = (await chrome.tabs.query({})).filter((t) => inReach(t, groupId, focused, ctx.known));
  return {
    ok: true,
    tabs: tabs.map((t) => ({ tab_id: t.id, title: t.title, url: t.url, active: t.active })),
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
