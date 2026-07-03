// Browser-control tools exposed to the model, plus their execution against the
// active tab. Tool schemas are provider-agnostic (plain JSON Schema); the
// provider layer converts them to the right wire format.

import { MSG } from "../common/constants.js";
import { readConsole, readNetwork } from "./cdp.js";

export const TOOL_DEFS = [
  {
    name: "read_page",
    description:
      "Read the current page. Returns the page title, URL, a text summary, and a " +
      "list of interactive elements each with a numeric 'ref' id you can use with " +
      "click_element, type_text, and select_option. Call this before acting so you " +
      "know what is on the page.",
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
  switch (name) {
    case "read_page":
      return await csSend(await ctx.getTabId(), { type: MSG.CS_READ_PAGE });
    case "get_page_text":
      return await csSend(await ctx.getTabId(), { type: MSG.CS_GET_TEXT });
    case "click_element":
      return await csSend(await ctx.getTabId(), { type: MSG.CS_ACT, action: "click", ref: args.ref });
    case "type_text":
      return await csSend(await ctx.getTabId(), {
        type: MSG.CS_ACT,
        action: "type",
        ref: args.ref,
        text: args.text,
        submit: !!args.submit,
      });
    case "select_option":
      return await csSend(await ctx.getTabId(), {
        type: MSG.CS_ACT,
        action: "select",
        ref: args.ref,
        value: args.value,
      });
    case "hover_element":
      return await csSend(await ctx.getTabId(), { type: MSG.CS_ACT, action: "hover", ref: args.ref });
    case "double_click":
      return await csSend(await ctx.getTabId(), { type: MSG.CS_ACT, action: "dblclick", ref: args.ref });
    case "right_click":
      return await csSend(await ctx.getTabId(), { type: MSG.CS_ACT, action: "contextmenu", ref: args.ref });
    case "drag_element":
      return await csSend(await ctx.getTabId(), { type: MSG.CS_ACT, action: "drag", ref: args.from_ref, toRef: args.to_ref });
    case "press_keys":
      return await csSend(await ctx.getTabId(), { type: MSG.CS_ACT, action: "keys", keys: args.keys, ref: args.ref });
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
        type: MSG.CS_ACT,
        action: "scroll",
        direction: args.direction || "down",
        ref: args.ref,
      });
    case "navigate":
      return await navigate(ctx, args.url);
    case "wait":
      return await waitSeconds(args.seconds);
    case "list_tabs":
      return await listTabs();
    case "open_tab":
      return await openTab(ctx, args.url);
    case "switch_tab":
      return await switchTab(ctx, args.tab_id);
    default:
      return { ok: false, error: `Unknown tool: ${name}` };
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

async function csSend(tabId, msg) {
  await ensureContentScript(tabId);
  try {
    const res = await chrome.tabs.sendMessage(tabId, msg);
    return res ?? { ok: false, error: "No response from page." };
  } catch (e) {
    return {
      ok: false,
      error:
        "Could not reach the page. It may be a restricted page (chrome://, the " +
        "Chrome Web Store, or a PDF), or it navigated away.",
    };
  }
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
  const tab = await chrome.tabs.create({ url: full, active: true });
  ctx.setTabId(tab.id);
  await waitForLoad(tab.id);
  const updated = await chrome.tabs.get(tab.id);
  return { ok: true, tab_id: tab.id, url: updated.url, title: updated.title };
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
    return { ok: true, result: String(r.result).slice(0, 4000) };
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
  try {
    // captureVisibleTab grabs the active tab of the window as a PNG data URL.
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    const data = dataUrl.split(",")[1];
    return { ok: true, image: { mediaType: "image/png", data }, note: "Screenshot captured." };
  } catch (e) {
    return {
      ok: false,
      error:
        "Could not capture a screenshot (restricted page, or the tab isn't visible): " +
        (e.message || e),
    };
  }
}

async function listTabs() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
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
