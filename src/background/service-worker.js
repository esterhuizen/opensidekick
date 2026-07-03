// OpenSidekick background service worker (ES module).
// Owns conversation state, routes messages between the side panel and the agent
// loop, and mediates permission prompts.

import { MSG, STORAGE_KEY } from "../common/constants.js";
import { loadConfig, getActiveProvider, setSitePermission } from "./storage.js";
import { runAgent } from "./agent.js";
import { detachAll } from "./cdp.js";
import { ensureContentScript } from "./tools.js";

// -------------------------------------------------------------------------
// State
// -------------------------------------------------------------------------
let conversation = []; // normalized message history for the current chat
let currentRun = null; // { controller: AbortController }
const pendingPermissions = new Map(); // id -> resolve fn
const pendingPlans = new Map(); // id -> resolve fn
let permissionSeq = 0;
let pendingSeed = null; // task text queued by a context-menu action
let recording = null; // { steps, tabId, startUrl, lastClickAt, lastUrl }

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
  reconcileAlarms();
});

chrome.runtime.onStartup.addListener(() => reconcileAlarms());

// Re-register scheduled-task alarms whenever the config changes.
const SCHED_PREFIX = "osk:sched:";
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STORAGE_KEY]) reconcileAlarms();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith(SCHED_PREFIX)) runScheduledById(alarm.name.slice(SCHED_PREFIX.length));
});

async function reconcileAlarms() {
  const config = await loadConfig();
  const existing = await chrome.alarms.getAll();
  for (const a of existing) {
    if (a.name.startsWith(SCHED_PREFIX)) await chrome.alarms.clear(a.name);
  }
  for (const t of config.scheduledTasks || []) {
    const minutes = Number(t.intervalMinutes) || 0;
    if (t.enabled && minutes > 0) {
      chrome.alarms.create(SCHED_PREFIX + t.id, { periodInMinutes: minutes, delayInMinutes: minutes });
    }
  }
}

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
      // Also cancel any pending permission or plan prompt.
      for (const [, resolve] of pendingPermissions) resolve("decline");
      pendingPermissions.clear();
      for (const [, resolve] of pendingPlans) resolve(false);
      pendingPlans.clear();
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
    case MSG.PLAN_RESPONSE: {
      const resolve = pendingPlans.get(msg.id);
      if (resolve) {
        pendingPlans.delete(msg.id);
        resolve(!!msg.approved);
      }
      sendResponse({ ok: true });
      return false;
    }
    case MSG.RUN_SCHEDULED: {
      runScheduledById(msg.id).then(() => sendResponse({ ok: true }));
      return true;
    }
    case MSG.START_RECORDING: {
      startRecording().then(sendResponse);
      return true;
    }
    case MSG.STOP_RECORDING: {
      sendResponse(stopRecording());
      return false;
    }
    case MSG.CS_STEP: {
      if (recording && msg.step) pushStep(msg.step);
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
    requestPlanApproval,
    saveSitePermission: (origin, value) => setSitePermission(origin, value),
  })
    .catch((e) => emit({ kind: "error", error: String(e.message || e) }))
    .finally(async () => {
      // Detach the debugger (removes the "debugging this browser" banner).
      await detachAll().catch(() => {});
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

// -------------------------------------------------------------------------
// Workflow recording — capture user actions on a tab as steps
// -------------------------------------------------------------------------
async function startRecording() {
  const tabId = await getActiveContentTabId();
  if (tabId == null) return { ok: false, error: "No page to record on." };
  let startUrl = "";
  try {
    startUrl = (await chrome.tabs.get(tabId)).url || "";
  } catch {
    /* ignore */
  }
  recording = { steps: [], tabId, startUrl, lastClickAt: 0, lastUrl: startUrl };
  chrome.tabs.onUpdated.addListener(recordingOnUpdated);
  await ensureContentScript(tabId);
  chrome.tabs.sendMessage(tabId, { type: MSG.CS_RECORD, on: true }).catch(() => {});
  return { ok: true, startUrl };
}

function stopRecording() {
  chrome.tabs.onUpdated.removeListener(recordingOnUpdated);
  const result = recording
    ? { ok: true, steps: recording.steps, startUrl: recording.startUrl }
    : { ok: true, steps: [], startUrl: "" };
  if (recording) chrome.tabs.sendMessage(recording.tabId, { type: MSG.CS_RECORD, on: false }).catch(() => {});
  recording = null;
  return result;
}

function pushStep(step) {
  if (!recording) return;
  if (step.action === "click") recording.lastClickAt = Date.now();
  recording.steps.push(step);
  chrome.runtime.sendMessage({ type: MSG.RECORDING_STEP, step, count: recording.steps.length }).catch(() => {});
}

function recordingOnUpdated(tabId, changeInfo) {
  if (!recording || tabId !== recording.tabId) return;
  if (changeInfo.url && changeInfo.url !== recording.lastUrl) {
    recording.lastUrl = changeInfo.url;
    // Skip navigations that a just-recorded click caused (avoid duplicates).
    const causedByClick = Date.now() - (recording.lastClickAt || 0) < 1500;
    if (!causedByClick && /^https?:/i.test(changeInfo.url)) {
      pushStep({ action: "navigate", description: `Go to ${changeInfo.url}` });
    }
  }
  if (changeInfo.status === "complete") {
    // The fresh content script on the new page needs re-arming.
    chrome.tabs.sendMessage(tabId, { type: MSG.CS_RECORD, on: true }).catch(() => {});
  }
}

// -------------------------------------------------------------------------
// Scheduled tasks (run unattended via alarms, or "run now" from Settings)
// -------------------------------------------------------------------------
async function runScheduledById(id) {
  const config = await loadConfig();
  const task = (config.scheduledTasks || []).find((t) => t.id === id);
  if (task) await runScheduledTask(task);
}

async function runScheduledTask(task) {
  if (currentRun) {
    notify(task.name, "Skipped — another task was already running.");
    return;
  }
  const { config, provider } = await getActiveProvider();
  if (!provider || !config.activeModel) {
    notify(task.name, "Skipped — no model configured.");
    return;
  }

  let tabId;
  try {
    if (task.url) {
      const tab = await chrome.tabs.create({ url: normalizeUrl(task.url), active: true });
      tabId = tab.id;
      await waitTabComplete(tabId);
    } else {
      tabId = await getActiveContentTabId();
    }
  } catch {
    notify(task.name, "Couldn't open the target page.");
    return;
  }
  if (tabId == null) {
    notify(task.name, "No page available to run on.");
    return;
  }

  const controller = new AbortController();
  currentRun = { controller };
  const conversation = [{ role: "user", content: task.prompt }];
  let summary = "";
  try {
    await runAgent({
      conversation,
      // Unattended runs act without asking (no one is watching to approve).
      config: { ...config, settings: { ...config.settings, autonomy: "auto" } },
      provider,
      initialTabId: tabId,
      signal: controller.signal,
      emit: (ev) => {
        if (ev.kind === "finish" && ev.summary) summary = ev.summary;
        else if (ev.kind === "assistant_end" && ev.content) summary = ev.content;
        else if (ev.kind === "error" && !summary) summary = "Error: " + ev.error;
      },
      // No UI to answer prompts — sensitive actions are declined (safe default).
      requestPermission: async () => "decline",
      requestPlanApproval: async () => false,
      saveSitePermission: () => {},
    });
  } catch (e) {
    summary = "Error: " + (e.message || e);
  } finally {
    await detachAll().catch(() => {});
    currentRun = null;
  }
  notify(task.name || "Scheduled task", summary || "Done.");
}

function notify(title, message) {
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: "OpenSidekick — " + (title || "Scheduled task"),
      message: String(message || "").slice(0, 400),
    });
  } catch {
    /* notifications may be unavailable */
  }
}

function normalizeUrl(u) {
  const s = String(u || "").trim();
  if (!s) return s;
  return /^[a-z]+:\/\//i.test(s) ? s : "https://" + s;
}

function waitTabComplete(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      setTimeout(resolve, 400);
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.get(tabId).then((t) => t && t.status === "complete" && finish()).catch(() => {});
  });
}

// Ask the side panel to approve the agent's plan. Resolves to true/false.
function requestPlanApproval(plan) {
  const id = ++permissionSeq;
  return new Promise((resolve) => {
    pendingPlans.set(id, resolve);
    chrome.runtime.sendMessage({ type: MSG.PLAN_REQUEST, id, plan }).catch(() => {
      pendingPlans.delete(id);
      resolve(false);
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
