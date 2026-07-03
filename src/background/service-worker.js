// OpenSidekick background service worker (ES module).
// Owns conversation state, routes messages between the side panel and the agent
// loop, and mediates permission prompts.

import { MSG } from "../common/constants.js";
import { loadConfig, getActiveProvider, setSitePermission } from "./storage.js";
import { runAgent } from "./agent.js";

// -------------------------------------------------------------------------
// State
// -------------------------------------------------------------------------
let conversation = []; // normalized message history for the current chat
let currentRun = null; // { controller: AbortController }
const pendingPermissions = new Map(); // id -> resolve fn
let permissionSeq = 0;
let pendingSeed = null; // task text queued by a context-menu action

// -------------------------------------------------------------------------
// Lifecycle
// -------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.contextMenus.create({
    id: "ask-opensidekick",
    title: 'Ask OpenSidekick about "%s"',
    contexts: ["selection"],
  });
  chrome.contextMenus.create({
    id: "summarize-page",
    title: "Summarize this page with OpenSidekick",
    contexts: ["page"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  let task = null;
  if (info.menuItemId === "ask-opensidekick" && info.selectionText) {
    task = `Regarding this selected text from the page:\n\n"""${info.selectionText}"""\n\nPlease help me with it.`;
  } else if (info.menuItemId === "summarize-page") {
    task = "Summarize the current page for me.";
  }
  if (!task) return;
  pendingSeed = task;
  if (tab && tab.id != null) {
    try {
      await chrome.sidePanel.open({ tabId: tab.id });
    } catch {
      /* user may need to click the icon */
    }
  }
  // Nudge an already-open panel to pick up the seed.
  chrome.runtime.sendMessage({ type: MSG.AGENT_EVENT, kind: "seed", task }).catch(() => {});
});

// -------------------------------------------------------------------------
// Messaging
// -------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {
    case MSG.GET_STATE: {
      handleGetState().then(sendResponse);
      return true;
    }
    case MSG.RUN_TASK: {
      handleRunTask(msg).then(sendResponse);
      return true;
    }
    case MSG.STOP_TASK: {
      if (currentRun) currentRun.controller.abort();
      // Also cancel any pending permission prompt.
      for (const [, resolve] of pendingPermissions) resolve("decline");
      pendingPermissions.clear();
      sendResponse({ ok: true });
      return false;
    }
    case MSG.PERMISSION_RESPONSE: {
      const resolve = pendingPermissions.get(msg.id);
      if (resolve) {
        pendingPermissions.delete(msg.id);
        resolve(msg.choice);
      }
      sendResponse({ ok: true });
      return false;
    }
    default:
      return false;
  }
});

async function handleGetState() {
  const { config, provider } = await getActiveProvider();
  const seed = pendingSeed;
  pendingSeed = null;
  return {
    ok: true,
    configured: !!(provider && config.activeModel),
    providerName: provider ? provider.name : null,
    model: config.activeModel || null,
    autonomy: config.settings.autonomy,
    running: !!currentRun,
    seed,
  };
}

async function handleRunTask(msg) {
  if (currentRun) return { ok: false, error: "A task is already running." };

  const { config, provider } = await getActiveProvider();
  if (!provider) {
    emit({ kind: "error", error: "No provider configured. Open Settings to add one." });
    return { ok: false, error: "not-configured" };
  }
  if (!config.activeModel) {
    emit({ kind: "error", error: "No model selected. Open Settings to choose a model." });
    return { ok: false, error: "no-model" };
  }

  if (msg.newChat) conversation = [];
  conversation.push({ role: "user", content: msg.task });
  emit({ kind: "user_echo", text: msg.task });

  const controller = new AbortController();
  currentRun = { controller };

  const initialTabId = await getActiveContentTabId();
  if (initialTabId == null) {
    emit({ kind: "error", error: "Could not find an active tab to work on." });
    currentRun = null;
    return { ok: false, error: "no-tab" };
  }

  // Run the loop (do not await the sendResponse on it — events stream async).
  runAgent({
    conversation,
    config,
    provider,
    initialTabId,
    signal: controller.signal,
    emit,
    requestPermission,
    saveSitePermission: (origin, value) => setSitePermission(origin, value),
  })
    .catch((e) => emit({ kind: "error", error: String(e.message || e) }))
    .finally(() => {
      currentRun = null;
      emit({ kind: "idle" });
    });

  return { ok: true };
}

// Ask the side panel to approve an action. Resolves to "once" | "always" | "decline".
function requestPermission(details) {
  const id = ++permissionSeq;
  return new Promise((resolve) => {
    pendingPermissions.set(id, resolve);
    chrome.runtime
      .sendMessage({ type: MSG.PERMISSION_REQUEST, id, ...details })
      .catch(() => {
        // Side panel not reachable — fail safe by declining.
        pendingPermissions.delete(id);
        resolve("decline");
      });
  });
}

function emit(event) {
  chrome.runtime.sendMessage({ type: MSG.AGENT_EVENT, ...event }).catch(() => {});
}

async function getActiveContentTabId() {
  let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tabs.length) tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs.find((t) => t.url && /^https?:/i.test(t.url)) || tabs[0];
  return tab ? tab.id : null;
}
