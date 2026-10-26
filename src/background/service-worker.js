// OpenSidekick background service worker (ES module).
// Owns conversation state, routes messages between the side panel and the agent
// loop, and mediates permission prompts.

import {
  MSG,
  STORAGE_KEY,
  SESSION_CONVO_KEY,
  SESSION_CONVO_META_KEY,
  SESSION_BODY_PREFIX,
  HISTORY_NOTICE_KEY,
  SENSITIVE_NOTE,
  HISTORY_NOTICE,
} from "../common/constants.js";
import {
  loadConfig,
  getActiveProvider,
  setSitePermission,
  loadTaskRuns,
  recordTaskRun,
  loadSessionIndex,
  loadSessionBody,
  writeSession,
  writeSessionIndex,
  removeSessionBodies,
  listLocalKeys,
  clearAllHistory,
} from "./storage.js";
import {
  stripImages,
  visibleTurns,
  planSave,
  removeSession,
  reconcileIndex,
  normalizeTitle,
  touchesSensitiveSite,
  emptyIndex,
} from "./sessions.js";
import { resolveSource, isNoteworthyChange, featureEnabled, thresholdFor } from "./decisions.js";
import { runAgent } from "./agent.js";
import { detachAll } from "./cdp.js";
import { ensureContentScript, normalizeTarget } from "./tools.js";
import { applyMigrations } from "./migrations.js";

// -------------------------------------------------------------------------
// State
// -------------------------------------------------------------------------
let conversation = []; // normalized message history for the current chat
let session = null; // { id, sensitive, trimmed? } for the live chat; null = nothing sent yet
let liveLoad = null; // memoized restore of the live chat, once per worker life
let currentRun = null; // { controller: AbortController, chat: boolean } (chat = started from the panel)
let historyQueue = Promise.resolve(); // serializes every chat-history read-modify-write
let storageFullWarned = false;
const pendingPermissions = new Map(); // id -> resolve fn
const pendingPlans = new Map(); // id -> resolve fn
let permissionSeq = 0;
let pendingSeed = null; // task text queued by a context-menu action
let recording = null; // { steps, tabId, startUrl, lastClickAt, lastUrl }
let keepAliveTimer = null;

// MV3 terminates an idle service worker after ~30s. While a task is running —
// especially while we're parked awaiting the user's answer to a permission or
// plan prompt — ping a chrome API every 20s to reset that idle timer, so the run
// (and its in-memory pending prompts) survive until the user responds. Without
// this, a slow "Allow" click lands on a fresh worker that has lost the run: the
// click resolves nothing and Stop has no run to abort, leaving a stuck panel.
function startKeepAlive() {
  if (keepAliveTimer != null) return;
  keepAliveTimer = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {});
  }, 20000);
}
function stopKeepAlive() {
  if (keepAliveTimer != null) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

// -------------------------------------------------------------------------
// Conversation persistence. MV3 kills the idle worker BETWEEN user prompts
// (the keepalive only runs during a task), so the live chat is kept in two
// places: a full-fidelity hot copy in chrome.storage.session (survives worker
// restarts, clears when Chrome closes), and, while chat history is on, a
// text-only saved copy in chrome.storage.local (see sessions.js) that also
// survives a browser restart.
// -------------------------------------------------------------------------
const STORAGE_FULL_WARNING =
  "Couldn't save this chat to History: OpenSidekick's browser storage is full. Delete some saved chats, or turn off chat history in Settings.";

// One shared promise rather than a flag: a second handler must not run ahead
// of the restore and then have the late restore overwrite what it set.
function loadLive() {
  liveLoad ||= (async () => {
    try {
      const raw = await chrome.storage.session.get([SESSION_CONVO_KEY, SESSION_CONVO_META_KEY]);
      const messages = raw[SESSION_CONVO_KEY];
      if (Array.isArray(messages) && messages.length) {
        const meta = raw[SESSION_CONVO_META_KEY];
        conversation = messages;
        // A hot copy without meta (a reload mid-session) is adopted as a new chat.
        session =
          meta && typeof meta.id === "string" && meta.id
            ? { id: meta.id, sensitive: !!meta.sensitive, ...(meta.trimmed ? { trimmed: true } : {}) }
            : { id: crypto.randomUUID(), sensitive: false };
        return;
      }
    } catch {
      /* session storage unavailable — try the saved copy */
    }
    try {
      const config = await loadConfig();
      if (config.settings.keepHistory === false) return;
      const index = await loadSessionIndex();
      if (!index.currentId) return;
      const body = await loadSessionBody(index.currentId);
      if (body && body.messages.length) {
        conversation = body.messages;
        session = { id: body.id, sensitive: false, ...(body.trimmed ? { trimmed: true } : {}) };
      }
    } catch {
      /* continue with an empty chat */
    }
  })();
  return liveLoad;
}

async function writeHot() {
  // Captured now: a New chat during the first set() must not get this chat's meta.
  const convo = conversation;
  const meta = { id: session.id, sensitive: session.sensitive, ...(session.trimmed ? { trimmed: true } : {}) };
  try {
    await chrome.storage.session.set({ [SESSION_CONVO_KEY]: stripImages(convo), [SESSION_CONVO_META_KEY]: meta });
  } catch {
    if (session?.id !== meta.id) return;
    // Likely over quota (very long chat). Keep whole visible turns: a raw tail
    // could start with an orphaned tool result, which providers reject.
    try {
      await chrome.storage.session.set({ [SESSION_CONVO_KEY]: visibleTurns(convo), [SESSION_CONVO_META_KEY]: meta });
    } catch {
      /* give up quietly; worst case the next worker starts from the saved copy */
    }
  }
}

// Start a fresh chat. The previous one was saved at its last run end.
async function resetLive() {
  conversation = [];
  session = null;
  try {
    await chrome.storage.session.remove([SESSION_CONVO_KEY, SESSION_CONVO_META_KEY]);
  } catch {
    /* ignore */
  }
  await withHistory(async () => {
    const index = await loadSessionIndex();
    if (index.currentId) await writeSessionIndex({ ...index, currentId: null });
  }).catch(() => {});
}

// This worker is the only writer of chat-history keys; every write goes
// through this one chain so a rename can't race the end-of-run save.
function withHistory(fn) {
  const run = historyQueue.then(fn);
  historyQueue = run.catch(() => {});
  return run;
}

// End of a chat run: `s` and `convo` are the chat the run started in, which may
// no longer be the live one (New chat mid-run).
async function saveRun(s, convo, meta) {
  const newlySensitive = !s.sensitive && touchesSensitiveSite(convo);
  if (newlySensitive) s.sensitive = true;
  if (s === session) await writeHot();
  let saved = { enabled: false, wrote: false };
  try {
    saved = await withHistory(() => saveCold(s, convo, meta));
  } catch {
    /* the hot copy still holds the chat */
  }
  if (newlySensitive && saved.enabled) emit({ kind: "note", icon: "shield", text: SENSITIVE_NOTE });
  if (saved.wrote && s === session) await showHistoryNoticeOnce();
}

async function saveCold(s, convo, meta) {
  const config = await loadConfig();
  if (config.settings.keepHistory === false) return { enabled: false, wrote: false };
  const plan = planSave({
    index: await loadSessionIndex(),
    sessionId: s.id,
    sensitive: s.sensitive,
    conversation: convo,
    isCurrent: s === session,
    keepHistory: true,
    now: Date.now(),
    model: meta.model,
    provider: meta.provider,
    trimmed: !!s.trimmed,
  });
  if (!plan.index) return { enabled: true, wrote: false };
  if (plan.body) {
    if (!(await writeWithRoom(plan.index, plan.body))) return { enabled: true, wrote: false };
  } else {
    await writeSessionIndex(plan.index);
  }
  await removeSessionBodies(plan.removeIds).catch(() => {}); // orphans are swept at browser start
  return { enabled: true, wrote: !!plan.body };
}

// On a quota error, make room by dropping the 5 oldest other chats and retry
// once; after that, say so once per worker life rather than on every turn.
async function writeWithRoom(index, body) {
  try {
    await writeSession(index, body);
    return true;
  } catch (e) {
    // Only a full store is worth deleting other chats over (Chrome: "Resource::kQuotaBytes quota exceeded").
    if (!/quota/i.test(String((e && e.message) || e))) return false;
  }
  const victims = index.items.filter((i) => i.id !== body.id).slice(-5).map((i) => i.id);
  let smaller = index;
  for (const id of victims) smaller = removeSession(smaller, id);
  try {
    // Unlist the victims before deleting their bodies, so a failed retry can't
    // leave the stored index pointing at chats that are gone.
    let stored = await loadSessionIndex();
    for (const id of victims) stored = removeSession(stored, id);
    await writeSessionIndex(stored);
    await removeSessionBodies(victims);
    await writeSession(smaller, body);
    return true;
  } catch {
    if (!storageFullWarned) {
      storageFullWarned = true;
      emit({ kind: "warning", text: STORAGE_FULL_WARNING });
    }
    return false;
  }
}

// History is on by default, upgrades included, so say so once per install,
// right after the first chat saved while the panel is open.
async function showHistoryNoticeOnce() {
  try {
    const raw = await chrome.storage.local.get(HISTORY_NOTICE_KEY);
    if (raw[HISTORY_NOTICE_KEY]) return;
    // Only the side panel listens, so this rejects while it is closed, and the
    // note waits for a saved chat the user can see it in.
    await chrome.runtime.sendMessage({ type: MSG.AGENT_EVENT, kind: "note", icon: "dot", text: HISTORY_NOTICE });
    await chrome.storage.local.set({ [HISTORY_NOTICE_KEY]: true });
  } catch {
    /* not worth failing a run over */
  }
}

// At browser start: drop index items whose body is missing and bodies no item
// points at (a worker killed mid-save), or everything if history is off.
async function reconcileHistory() {
  const config = await loadConfig();
  if (config.settings.keepHistory === false) return clearAllHistory();
  const bodyIds = (await listLocalKeys())
    .filter((k) => k.startsWith(SESSION_BODY_PREFIX))
    .map((k) => k.slice(SESSION_BODY_PREFIX.length));
  const { index, orphans, changed } = reconcileIndex(await loadSessionIndex(), bodyIds);
  if (changed) await writeSessionIndex(index);
  await removeSessionBodies(orphans);
}

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
  runMigrations();
  reconcileAlarms();
  withHistory(reconcileHistory).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  runMigrations();
  reconcileAlarms();
  withHistory(reconcileHistory).catch(() => {});
});

// Apply one-time config migrations to an existing stored config. Does nothing on
// a fresh install (no stored config yet), so it can't clobber a config that's
// being written concurrently at first run.
async function runMigrations() {
  const raw = await chrome.storage.local.get(STORAGE_KEY);
  if (!raw[STORAGE_KEY]) return;
  const { config, changed } = applyMigrations(raw[STORAGE_KEY]);
  if (changed) await chrome.storage.local.set({ [STORAGE_KEY]: config });
}

// Re-register scheduled-task alarms whenever the config changes.
const SCHED_PREFIX = "osk:sched:";
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[STORAGE_KEY]) return;
  reconcileAlarms();
  // Turning chat history off deletes it, whichever page wrote the setting. The
  // live chat carries on in the hot copy only, as before chat history existed.
  const { oldValue, newValue } = changes[STORAGE_KEY];
  if (oldValue?.settings?.keepHistory !== false && newValue?.settings?.keepHistory === false) {
    withHistory(clearAllHistory).catch(() => {});
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith(SCHED_PREFIX)) runScheduledById(alarm.name.slice(SCHED_PREFIX.length));
});

// Idempotent on purpose: an alarm that already has the right period is left
// exactly as it is, including its next fire time. Clearing and re-creating every
// alarm on each config change pushed every task's next run out by its full
// interval — so anything that wrote the config regularly could starve a
// long-interval task indefinitely (an hourly task resetting a daily one).
async function reconcileAlarms() {
  const config = await loadConfig();
  const wanted = new Map();
  for (const t of config.scheduledTasks || []) {
    const minutes = Number(t.intervalMinutes) || 0;
    if (t.enabled && minutes > 0) wanted.set(SCHED_PREFIX + t.id, minutes);
  }
  for (const a of await chrome.alarms.getAll()) {
    if (!a.name.startsWith(SCHED_PREFIX)) continue;
    // `has` first: a stray one-shot alarm (no period) for a deleted task must
    // not match an undefined `wanted` entry and survive as "already correct".
    if (wanted.has(a.name) && wanted.get(a.name) === a.periodInMinutes) wanted.delete(a.name); // already correct
    else await chrome.alarms.clear(a.name); // stale period, or the task is gone
  }
  for (const [name, minutes] of wanted) {
    chrome.alarms.create(name, { periodInMinutes: minutes, delayInMinutes: minutes });
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
    case MSG.NEW_CHAT: {
      loadLive()
        .then(resetLive)
        .then(() => sendResponse({ ok: true }));
      return true;
    }
    case MSG.LIST_SESSIONS: {
      listSessions().catch(failed).then(sendResponse);
      return true;
    }
    case MSG.OPEN_SESSION: {
      openSession(msg.id).catch(failed).then(sendResponse);
      return true;
    }
    case MSG.RENAME_SESSION: {
      renameSession(msg.id, msg.title).catch(failed).then(sendResponse);
      return true;
    }
    case MSG.DELETE_SESSION: {
      deleteSession(msg.id).catch(failed).then(sendResponse);
      return true;
    }
    case MSG.CLEAR_SESSIONS: {
      clearSessions().catch(failed).then(sendResponse);
      return true;
    }
    case MSG.STOP_TASK: {
      if (currentRun) currentRun.controller.abort();
      // Also cancel any pending permission or plan prompt.
      for (const [, resolve] of pendingPermissions) resolve("decline");
      pendingPermissions.clear();
      for (const [, resolve] of pendingPlans) resolve(false);
      pendingPlans.clear();
      // Always un-stick the panel: if the run is live its finally also emits idle
      // (harmless), and if the worker restarted there's no run to end otherwise.
      if (!currentRun && !recording) stopKeepAlive();
      emit({ kind: "idle" });
      sendResponse({ ok: true });
      return false;
    }
    case MSG.PERMISSION_RESPONSE: {
      const resolve = pendingPermissions.get(msg.id);
      if (resolve) {
        pendingPermissions.delete(msg.id);
        resolve(msg.choice);
      } else if (!currentRun) {
        // The run was lost (e.g. the worker restarted before this answer landed).
        // Nothing to resolve — reset the panel instead of leaving it "Working".
        emit({ kind: "idle" });
      }
      sendResponse({ ok: true });
      return false;
    }
    case MSG.PLAN_RESPONSE: {
      const resolve = pendingPlans.get(msg.id);
      if (resolve) {
        pendingPlans.delete(msg.id);
        resolve(!!msg.approved);
      } else if (!currentRun) {
        emit({ kind: "idle" });
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
  await loadLive();
  const seed = pendingSeed;
  pendingSeed = null;
  return {
    ok: true,
    configured: !!(provider && config.activeModel),
    providerName: provider ? provider.name : null,
    model: config.activeModel || null,
    autonomy: config.settings.autonomy,
    running: !!currentRun,
    recording: !!recording,
    recordingSteps: recording ? recording.steps.length : 0,
    seed,
    history: conversationHistory(),
    // The sensitive-site note only makes sense while there is a History to keep out of.
    sensitive: !!(session && session.sensitive) && config.settings.keepHistory !== false,
    trimmed: !!(session && session.trimmed),
  };
}

// A compact, renderable projection of the conversation for the side panel —
// exactly what a saved chat keeps, so History keeps what you see.
function conversationHistory() {
  return visibleTurns(conversation).map((m) => ({ role: m.role, text: m.content }));
}

// -------------------------------------------------------------------------
// Chat history messages (side panel History menu, Settings → Chat history)
// -------------------------------------------------------------------------
const failed = () => ({ ok: false, error: "failed" });
const chatRunning = () => !!(currentRun && currentRun.chat);

async function listSessions() {
  await loadLive();
  const config = await loadConfig();
  const enabled = config.settings.keepHistory !== false;
  const index = enabled ? await withHistory(loadSessionIndex) : emptyIndex();
  return { ok: true, enabled, currentId: session ? session.id : null, running: chatRunning(), items: index.items };
}

async function openSession(id) {
  await loadLive();
  // Switching mid-run would either kill the task or leave it writing into a
  // chat that is no longer on screen.
  if (chatRunning()) return { ok: false, error: "busy" };
  if (session && session.id === id) {
    return { ok: true, id, history: conversationHistory(), trimmed: !!session.trimmed };
  }
  const config = await loadConfig();
  if (config.settings.keepHistory === false) return { ok: false, error: "disabled" };
  const body = typeof id === "string" && id ? await loadSessionBody(id) : null;
  if (!body || !body.messages.length) {
    await withHistory(async () => {
      const index = await loadSessionIndex();
      if (index.items.some((i) => i.id === id)) await writeSessionIndex(removeSession(index, id));
      if (body) await removeSessionBodies([id]); // a body with no messages
    }).catch(() => {});
    return { ok: false, error: "not-found" };
  }
  if (chatRunning()) return { ok: false, error: "busy" }; // a run may have started while we read
  conversation = body.messages;
  session = { id, sensitive: false, ...(body.trimmed ? { trimmed: true } : {}) };
  await writeHot();
  // Opening doesn't touch updatedAt, so a glance at an old chat doesn't reorder the list.
  await withHistory(async () => {
    const index = await loadSessionIndex();
    if (index.currentId !== id && index.items.some((i) => i.id === id)) {
      await writeSessionIndex({ ...index, currentId: id });
    }
  }).catch(() => {});
  return { ok: true, id, history: conversationHistory(), trimmed: !!body.trimmed };
}

async function renameSession(id, title) {
  const name = normalizeTitle(title);
  if (!name) return { ok: false, error: "invalid" };
  return withHistory(async () => {
    const index = await loadSessionIndex();
    if (!index.items.some((i) => i.id === id)) return { ok: false, error: "not-found" };
    await writeSessionIndex({ ...index, items: index.items.map((i) => (i.id === id ? { ...i, title: name } : i)) });
    return { ok: true, title: name };
  });
}

async function deleteSession(id) {
  if (typeof id !== "string" || !id) return { ok: true, wasCurrent: false };
  await loadLive();
  const wasCurrent = !!session && session.id === id;
  if (wasCurrent) {
    if (chatRunning()) return { ok: false, error: "busy" };
    // Reset before deleting, so the chat's next turn can't quietly re-create it.
    await resetLive();
  }
  await withHistory(async () => {
    const index = await loadSessionIndex();
    if (index.items.some((i) => i.id === id)) await writeSessionIndex(removeSession(index, id));
    await removeSessionBodies([id]);
  });
  if (wasCurrent) emit({ kind: "chat_reset" });
  return { ok: true, wasCurrent };
}

async function clearSessions() {
  await loadLive();
  if (chatRunning()) return { ok: false, error: "busy" };
  await resetLive();
  await withHistory(clearAllHistory);
  emit({ kind: "chat_reset" });
  return { ok: true };
}

async function handleRunTask(msg) {
  if (currentRun) return { ok: false, error: "A task is already running." };

  const { config, provider } = await getActiveProvider();
  if (!provider) {
    emit({ kind: "error", error: "No provider configured. Open Settings to add one." });
    emit({ kind: "idle" });
    return { ok: false, error: "not-configured" };
  }
  if (!config.activeModel) {
    emit({ kind: "error", error: "No model selected. Open Settings to choose a model." });
    emit({ kind: "idle" });
    return { ok: false, error: "no-model" };
  }

  await loadLive();
  if (msg.newChat) await resetLive();
  if (!session) session = { id: crypto.randomUUID(), sensitive: false };
  conversation.push({ role: "user", content: msg.task });
  emit({ kind: "user_echo", text: msg.task });
  // Captured now: New chat mid-run must not redirect this run's save.
  const runSession = session;
  const runConversation = conversation;
  const saveMeta = { model: config.activeModel, provider: provider.name };

  const controller = new AbortController();
  currentRun = { controller, chat: true };

  const initialTabId = await getActiveContentTabId();
  if (initialTabId == null) {
    emit({ kind: "error", error: "Could not find an active tab to work on." });
    emit({ kind: "idle" });
    currentRun = null;
    return { ok: false, error: "no-tab" };
  }

  // Keep the worker alive for the whole run (incl. while awaiting prompts).
  startKeepAlive();

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
      // Before idle, so whoever waits for idle sees the saved chat.
      await saveRun(runSession, runConversation, saveMeta).catch(() => {});
      currentRun = null;
      if (!recording) stopKeepAlive(); // an active recording still needs it
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
  // A quiet stretch while the user reads the page would otherwise let MV3 kill
  // the worker — taking the in-memory recording with it.
  startKeepAlive();
  return { ok: true, startUrl };
}

function stopRecording() {
  chrome.tabs.onUpdated.removeListener(recordingOnUpdated);
  const result = recording
    ? { ok: true, steps: recording.steps, startUrl: recording.startUrl }
    : { ok: true, steps: [], startUrl: "" };
  if (recording) chrome.tabs.sendMessage(recording.tabId, { type: MSG.CS_RECORD, on: false }).catch(() => {});
  recording = null;
  if (!currentRun) stopKeepAlive(); // a running task still needs the keepalive
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
      const tab = await chrome.tabs.create({ url: normalizeTarget(task.url), active: true });
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
  currentRun = { controller, chat: false }; // never recorded in chat history
  startKeepAlive();
  const conversation = [{ role: "user", content: task.prompt }];
  let summary = "";
  let errored = false;
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
        else if (ev.kind === "error") {
          errored = true;
          if (!summary) summary = "Error: " + ev.error;
        } else if (ev.kind === "tool_end" && ev.ok === false && /Declined by user/.test(ev.summary || "")) {
          // Nobody is here to answer a confirmation, so requestPermission below
          // declines — which cuts the run short. That is a failure, not a quiet
          // success: without this the run could be reported as "Done." or, with
          // change-only notifications on, compared away entirely.
          errored = true;
          if (!summary) {
            summary = `Stopped: this needed your confirmation for ${ev.name}, and unattended runs can't ask.`;
          }
        }
      },
      // No UI to answer prompts — sensitive actions are declined (safe default).
      requestPermission: async () => "decline",
      requestPlanApproval: async () => false,
      saveSitePermission: () => {},
    });
  } catch (e) {
    errored = true;
    summary = "Error: " + (e.message || e);
  } finally {
    await detachAll().catch(() => {});
    currentRun = null;
    if (!recording) stopKeepAlive();
  }
  await finishScheduledRun(task, summary, errored);
}

// Notify (or, with the change-only smart check on, stay quiet when this run said
// the same thing as the last one), then remember what this run produced so the
// next one has something to compare against.
async function finishScheduledRun(task, summary, errored) {
  const title = task.name || "Scheduled task";
  const message = summary || "Done.";
  const config = await loadConfig();
  const prev = (await loadTaskRuns())[task.id] || {};
  // A failed run always speaks up, and so does the very first run of a task:
  // there is nothing to compare it against yet.
  const src = errored ? null : resolveSource(config);
  const changeOnly = !!src && featureEnabled(config, "changeOnly") && prev.lastResult != null;

  let suppressed = Number(prev.suppressedCount) || 0;
  let notifiedChange = false;
  if (!changeOnly) {
    notify(title, message);
    notifiedChange = true;
  } else {
    const r = await isNoteworthyChange(src, {
      taskName: task.name,
      prompt: task.prompt,
      previous: prev.lastResult,
      current: summary,
    });
    // null = the check didn't answer; fall back to today's behavior and notify.
    if (r === null || r.probability >= thresholdFor(config)) {
      notify(title, message);
      notifiedChange = true;
    } else {
      suppressed++;
      // Every sixth quiet run, say so — a task that never speaks looks broken.
      if (suppressed % 6 === 0) notify(title, "(No change in the last 6 runs.) " + message);
    }
  }

  // Persisted even when the feature is off: it costs nothing and means turning
  // it on later has a baseline to work from.
  try {
    await recordTaskRun(
      task.id,
      {
        lastResult: String(summary || "").slice(0, 2000),
        lastRunAt: Date.now(),
        suppressedCount: notifiedChange ? 0 : suppressed,
      },
      (config.scheduledTasks || []).map((t) => t.id),
    );
  } catch {
    /* the notification already went out; losing the baseline isn't fatal */
  }
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
