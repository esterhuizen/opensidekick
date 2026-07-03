// Browser-control tools exposed to the model, plus their execution against the
// active tab. Tool schemas are provider-agnostic (plain JSON Schema); the
// provider layer converts them to the right wire format.

import { MSG } from "../common/constants.js";

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
