// Side panel UI controller. Talks to the service worker via runtime messages
// and renders the streaming agent transcript.

import {
  MSG,
  STORAGE_KEY,
  SESSION_PENDING_WF_KEY,
  SESSION_MODEL_KEY,
  PROMPT_HISTORY_KEY,
  PROMPT_HISTORY_MAX,
  SESSIONS_INDEX_KEY,
  SESSIONS_MAX,
  SENSITIVE_NOTE,
  TRIMMED_NOTE,
} from "../common/constants.js";
import { matchPrompts, isSlashQuery } from "../common/prompts.js";
import { escapeHtml } from "../common/escape.js";
import { markdownToHtml, createStreamingRenderer, renderTick, CODE_CLASS, setHighlighter } from "../common/markdown.js";
import { relativeTime } from "../background/sessions.js";

// Prism loads as scripts in sidepanel.html, so it is a global by the time this
// module runs. Prism's own DOM scan is switched off: the panel renders HTML
// strings, and highlighting happens inside the fence rule.
if (typeof Prism !== "undefined") {
  Prism.manual = true;
  setHighlighter((code, lang) => {
    const grammar = Prism.languages[lang];
    if (!grammar || code.length > 20000) return escapeHtml(code);
    return Prism.highlight(code, grammar, lang);
  });
}

const els = {
  messages: document.getElementById("messages"),
  empty: document.getElementById("empty-state"),
  notConfigured: document.getElementById("not-configured"),
  input: document.getElementById("input"),
  composer: document.getElementById("composer"),
  send: document.getElementById("send-btn"),
  stop: document.getElementById("stop-btn"),
  newChat: document.getElementById("new-chat"),
  settings: document.getElementById("open-settings"),
  status: document.getElementById("status-bar"),
  contextHint: document.getElementById("context-hint"),
  setupLink: document.getElementById("setup-link"),
  slashMenu: document.getElementById("slash-menu"),
  recordBtn: document.getElementById("record-btn"),
  workflowsBtn: document.getElementById("workflows-btn"),
  historyBtn: document.getElementById("history-btn"),
  histMenu: document.getElementById("hist-menu"),
  histBody: document.querySelector("#hist-menu .hist-body"),
  histStatus: document.querySelector("#hist-menu .hist-status"),
  recBanner: document.getElementById("rec-banner"),
  wfMenu: document.getElementById("wf-menu"),
  autonomy: document.getElementById("autonomy"),
  siteMenu: document.getElementById("site-menu"),
  jumpLatest: document.getElementById("jump-latest"),
  modelLine: document.getElementById("model-line"),
  modelChip: document.getElementById("model-chip"),
};

let savedPrompts = [];
let slashItems = [];
let slashIndex = 0;
let recording = false;
let recCount = 0;
let recGen = 0; // bumped on every start/stop so a slow START_RECORDING reply can't
// resurrect the banner after the user already stopped.
let configured = false;
// Settings → "Keep chat history on this device". Off: ↑ recall still works for
// this panel's lifetime, but prompts aren't written to storage.
let keepHistory = true;

let running = false;
// Whether the next send should start a fresh conversation. Starts FALSE so that
// reopening the panel continues the persisted chat (the worker restores it);
// only the "+ New chat" button arms this. (It used to start true, which made the
// first message after reopening silently wipe the restored conversation.)
let newChatPending = false;
let current = null; // { el, raw } assistant bubble being streamed
let pendingTools = []; // log rows awaiting their matching tool_end
let logGroup = null; // the open <details> run of consecutive tool rows

// The copy control's feedback, keyed by state. Label and accessible name come from
// the state, so a streaming message carries only the state across a re-render and
// the reset is just the idle state.
const COPY = {
  idle: { label: "Copy", aria: "Copy code" },
  ok: { label: "Copied", aria: "Copied code" },
  fail: { label: "Failed", aria: "Copy failed" },
};

// aria-disabled, not the disabled attribute: a disabled button cannot keep keyboard
// focus, and focus has to survive a re-render.
function applyCopy(btn, state) {
  const { label, aria } = COPY[state];
  btn.textContent = label;
  btn.setAttribute("aria-label", aria);
  if (state === "idle") {
    delete btn.dataset.state;
    btn.removeAttribute("aria-disabled");
  } else {
    btn.dataset.state = state;
    btn.setAttribute("aria-disabled", "true");
  }
}

init();

async function init() {
  const state = await send({ type: MSG.GET_STATE });
  if (state) applyState(state);
  refreshConfigured();
  refreshContextHint();
  restorePendingWorkflow();

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === MSG.AGENT_EVENT) handleEvent(msg);
    else if (msg.type === MSG.PERMISSION_REQUEST) showPermission(msg);
    else if (msg.type === MSG.PLAN_REQUEST) showPlan(msg);
    else if (msg.type === MSG.RECORDING_STEP) {
      recCount = msg.count || recCount + 1;
      updateRecBanner();
    }
  });

  els.recordBtn.addEventListener("click", toggleRecording);
  els.workflowsBtn.addEventListener("click", toggleWorkflowsMenu);
  wireHistoryMenu();
  els.autonomy.querySelectorAll(".seg").forEach((btn) =>
    btn.addEventListener("click", () => setAutonomy(btn.dataset.mode)),
  );

  // Saved prompts for the "/" menu — load now and keep in sync.
  loadPrompts();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE_KEY]) {
      loadPrompts();
      refreshConfigured();
      refreshContextHint(); // site rules may have changed
    }
    // A clear from anywhere (History, Settings, the switch) empties ↑ recall.
    if (area === "local" && changes[PROMPT_HISTORY_KEY]) {
      const next = changes[PROMPT_HISTORY_KEY].newValue;
      promptHistory = Array.isArray(next) ? next : [];
      if (histIndex >= promptHistory.length) exitHistory();
    }
    if (area === "local" && (changes[SESSIONS_INDEX_KEY] || changes[STORAGE_KEY])) refreshHistoryMenu(true);
  });

  // Keep the site chip current as the user moves between tabs/pages.
  els.contextHint.addEventListener("click", toggleSiteMenu);
  try {
    chrome.tabs.onActivated.addListener(() => refreshContextHint());
    chrome.tabs.onUpdated.addListener((tabId, info) => {
      if (info.url || info.status === "complete") refreshContextHint();
    });
  } catch {
    /* tabs events unavailable — chip still refreshes on open/submit */
  }

  els.messages.addEventListener("scroll", onMessagesScroll, { passive: true });
  // The copy control is inside the rendered code block, so it is wired by delegation.
  els.messages.addEventListener("click", (e) => {
    const btn = e.target.closest(".md-copy");
    if (!btn) return;
    if (btn.dataset.state) return; // the feedback is showing; ignore a second click
    const pre = btn.closest(`.${CODE_CLASS}`)?.querySelector("pre");
    if (!pre) return;
    const msg = btn.closest(".msg.assistant");
    // A mid-stream re-render replaces the button, so the feedback has to live on
    // the message's record, not on the element.
    const rec = current && current.el === msg ? current : null;
    const index = [...msg.querySelectorAll(".md-copy")].indexOf(btn);
    // aria-disabled, not the disabled attribute: a disabled button cannot keep
    // keyboard focus, and focus has to survive the re-render.
    const setLabel = (state) => {
      applyCopy(btn, state);
      if (rec) {
        rec.copy = { index, state };
        // A re-render may have replaced the button while the clipboard call ran.
        const live = [...rec.el.querySelectorAll(".md-copy")][index];
        if (live && live !== btn) applyCopy(live, state);
      }
      setTimeout(() => {
        // Drop the record first, so the next render does not put the feedback back,
        // and reset the button that is live now: the one we clicked is detached by a
        // re-render, and writing to it leaves the live control stuck on "Copied".
        if (rec) rec.copy = null;
        const live = rec ? [...rec.el.querySelectorAll(".md-copy")][index] : btn;
        if (live) applyCopy(live, "idle");
      }, 1000);
    };
    navigator.clipboard
      .writeText(pre.textContent)
      .then(() => setLabel("ok"))
      .catch(() => setLabel("fail"));
  });
  els.jumpLatest.addEventListener("click", () => {
    pinned = true;
    scroll();
  });
  els.composer.addEventListener("submit", onSubmit);
  els.input.addEventListener("keydown", onInputKeydown);
  els.input.addEventListener("input", () => {
    // Editing a recalled prompt ends history browsing (the edited text stays).
    exitHistory();
    autoGrow();
    updateSlashMenu();
  });
  loadPromptHistory();
  els.input.addEventListener("blur", () => setTimeout(hideSlashMenu, 150));
  els.stop.addEventListener("click", () => send({ type: MSG.STOP_TASK }));
  els.newChat.addEventListener("click", newChat);
  els.settings.addEventListener("click", () => chrome.runtime.openOptionsPage());
  els.modelChip.addEventListener("click", () => chrome.runtime.openOptionsPage());
  if (els.setupLink) els.setupLink.addEventListener("click", (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
  document.querySelectorAll(".examples li").forEach((li) =>
    li.addEventListener("click", () => {
      els.input.value = li.dataset.example;
      autoGrow();
      els.input.focus();
    }),
  );
}

function applyState(state) {
  updateConfiguredUI(!!state.configured);
  // Re-render the ongoing chat when the panel (re)opens — the conversation
  // lives in the worker (persisted across its restarts), like Claude's panel.
  if (state.history && state.history.length && !els.messages.querySelector(".msg")) {
    els.empty.hidden = true;
    if (state.trimmed) addNote(TRIMMED_NOTE, "dot");
    renderHistory(state.history);
    if (state.sensitive) addNote(SENSITIVE_NOTE, "shield");
    scroll();
  }
  if (state.seed) {
    els.input.value = state.seed;
    autoGrow();
  }
  if (state.running) setRunning(true);
  // A recording kept running in the worker while the panel was closed — pick
  // the banner (and step count) back up so Stop still works.
  if (state.recording) {
    recording = true;
    recCount = state.recordingSteps || 0;
    els.recordBtn.classList.add("recording");
    els.empty.hidden = true;
    updateRecBanner();
  }
}

// The chat's visible turns, as the worker projects them ({ role, text }).
function renderHistory(history) {
  for (const m of history) {
    if (m.role === "user") addUserMessage(m.text);
    else {
      const el = document.createElement("div");
      el.className = "msg assistant";
      el.innerHTML = markdownToHtml(m.text);
      els.messages.appendChild(el);
    }
  }
}

function updateConfiguredUI(isConfigured) {
  configured = isConfigured;
  els.notConfigured.hidden = isConfigured;
  const examples = document.querySelector(".examples");
  if (examples) examples.hidden = !isConfigured;
  els.input.placeholder = isConfigured
    ? "Ask about or act on this page…"
    : "Add a model in Settings to get started →";
}

async function refreshConfigured() {
  let cfg = {};
  try {
    const raw = await chrome.storage.local.get(STORAGE_KEY);
    cfg = raw[STORAGE_KEY] || {};
  } catch {
    /* ignore */
  }
  const provider = (cfg.providers || []).find((p) => p.id === cfg.activeProviderId);
  updateConfiguredUI(!!(provider && cfg.activeModel));
  setAutonomyUI((cfg.settings && cfg.settings.autonomy) || "ask");
  const wasKeeping = keepHistory;
  keepHistory = cfg.settings?.keepHistory !== false;
  // Prompts typed while history was off stay off disk: the next remembered
  // prompt writes the whole list, so start it afresh.
  if (!wasKeeping && keepHistory) {
    promptHistory = [];
    exitHistory();
  }
  const pair = provider && cfg.activeModel ? { providerId: provider.id, model: cfg.activeModel } : null;
  renderModelChip(pair && pair.model, provider && provider.name);
  // Serialised: the first call reads the stored pair, and a storage change
  // landing while it does must not compare against a half-initialised state.
  modelTrack = modelTrack.then(() => trackModel(pair, provider && provider.name)).catch(() => {});
}

function renderModelChip(model, providerName) {
  els.modelLine.hidden = !model;
  if (!model) return;
  els.modelChip.querySelector(".mc-model").textContent = model;
  els.modelChip.querySelector(".mc-provider").textContent = providerName || "";
  els.modelChip.title = `${model} · ${providerName || ""} (open Settings to change)`;
}

// -------------------------------------------------------------------------
// Model switches. The conversation lives on when the model changes, so the
// user is told which model answers from here on — once per switch, and only
// when there is a chat for it to continue. The pair the panel last showed is
// kept in storage.session, so a panel reopened on a restored chat notices a
// switch made in Settings while it was closed.
// -------------------------------------------------------------------------
let modelTrack = Promise.resolve();
let seenModel; // JSON [providerId, model] last shown; undefined before the first look
// A switch made mid-run: its note waits for the run to end, so it doesn't land
// under the old model's still-streaming reply. { from, model, providerName }
let heldSwitch = null;

const modelKey = (pair) => (pair ? JSON.stringify([pair.providerId, pair.model]) : "");

async function trackModel(pair, providerName) {
  // A momentarily unconfigured state (e.g. mid-edit in Settings) keeps the
  // remembered pair, so a switch that passes through it still shows one note.
  if (!pair) return;
  const key = modelKey(pair);
  let prev = seenModel;
  if (prev === undefined) {
    try {
      prev = modelKey((await chrome.storage.session.get(SESSION_MODEL_KEY))[SESSION_MODEL_KEY]);
    } catch {
      prev = "";
    }
    seenModel = null; // forces the write below even when nothing changed
  }
  if (key === seenModel) return;
  seenModel = key;
  try {
    await chrome.storage.session.set({ [SESSION_MODEL_KEY]: pair });
  } catch {
    /* ignore */
  }
  if (!prev || prev === key || !els.messages.querySelector(".msg")) return;
  if (running) {
    const from = heldSwitch ? heldSwitch.from : prev;
    heldSwitch = from === key ? null : { from, model: pair.model, providerName };
  } else {
    addSwitchNote(pair.model, providerName);
  }
}

function addSwitchNote(model, providerName) {
  addNote(`Now using ${model} via ${providerName}. Replies continue in this chat. Start a new chat to reset context.`, "dot", {
    label: "New chat",
    onClick: newChat,
  });
}

function flushHeldSwitch() {
  const held = heldSwitch;
  heldSwitch = null;
  if (held && els.messages.querySelector(".msg")) addSwitchNote(held.model, held.providerName);
}

// Reflect the active approval mode in the segmented control.
function setAutonomyUI(mode) {
  els.autonomy.querySelectorAll(".seg").forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

// Persist the chosen approval mode without touching the rest of the config.
// Mirrors the Behavior radios in Settings; the storage listener keeps both views
// (and the running agent's config) in sync.
async function setAutonomy(mode) {
  setAutonomyUI(mode); // optimistic
  let cfg = {};
  try {
    const raw = await chrome.storage.local.get(STORAGE_KEY);
    cfg = raw[STORAGE_KEY] || {};
  } catch {
    /* ignore */
  }
  cfg.settings = { ...(cfg.settings || {}), autonomy: mode };
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: cfg });
  } catch {
    /* ignore */
  }
}

// -------------------------------------------------------------------------
// Site chip — shows the current site + its rule, and is the quick toggle for
// trusting/blocking a site without opening Settings.
// -------------------------------------------------------------------------
let currentSiteOrigin = null;

async function refreshContextHint() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!(tab && tab.url && /^https?:/i.test(tab.url))) {
      currentSiteOrigin = null;
      els.contextHint.textContent = "";
      hideSiteMenu();
      return;
    }
    const url = new URL(tab.url);
    currentSiteOrigin = url.origin;
    const raw = await chrome.storage.local.get(STORAGE_KEY);
    const cfg = raw[STORAGE_KEY] || {};
    const rule = (cfg.sitePermissions || {})[url.origin];
    const allowlist = cfg.settings && cfg.settings.siteAccess === "allowlist";
    let state = "";
    if (rule === "allow") state = '<span class="site-state ok">allowed</span>';
    else if (rule === "block") state = '<span class="site-state blocked">blocked</span>';
    else if (allowlist) state = '<span class="site-state warn">not allowed yet</span>';
    // Host and state are separate boxes so a long host ellipsizes while the
    // rule (the part that matters) stays whole.
    els.contextHint.innerHTML = `<span class="site-host">On: ${escapeHtml(url.hostname)}</span>${state ? '<span class="site-sep"> · </span>' + state : ""}`;
  } catch {
    /* ignore */
  }
}

function toggleSiteMenu() {
  if (!els.siteMenu.hidden) return hideSiteMenu();
  if (!currentSiteOrigin) return;
  renderSiteMenu();
  document.addEventListener("mousedown", siteMenuOutside, true);
}

function siteMenuOutside(e) {
  if (els.siteMenu.contains(e.target) || els.contextHint.contains(e.target)) return;
  hideSiteMenu();
}

function hideSiteMenu() {
  els.siteMenu.hidden = true;
  els.siteMenu.innerHTML = "";
  document.removeEventListener("mousedown", siteMenuOutside, true);
}

async function renderSiteMenu() {
  const raw = await chrome.storage.local.get(STORAGE_KEY);
  const cfg = raw[STORAGE_KEY] || {};
  const rule = (cfg.sitePermissions || {})[currentSiteOrigin] || null;
  const item = (value, label, icon) => {
    const current = value === "clear" ? rule === null : rule === value;
    return `<button data-rule="${value}" class="${current ? "current" : ""}">${ic(icon)} ${label}${current ? " — current" : ""}</button>`;
  };
  els.siteMenu.innerHTML = `
    <div class="sm-head">${escapeHtml(currentSiteOrigin)}</div>
    ${item("allow", "Trust — always allow", "shield")}
    ${item("block", "Block this site", "ban")}
    ${item("clear", "Clear rule (default)", "dot")}`;
  els.siteMenu.querySelectorAll("button").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await setSiteRule(currentSiteOrigin, btn.dataset.rule);
      hideSiteMenu();
      refreshContextHint();
    }),
  );
  els.siteMenu.hidden = false;
}

// Persist a per-site rule without touching the rest of the config (mirrors the
// worker's setSitePermission; the storage listener keeps other views in sync).
async function setSiteRule(origin, rule) {
  try {
    const raw = await chrome.storage.local.get(STORAGE_KEY);
    const cfg = raw[STORAGE_KEY] || {};
    cfg.sitePermissions = { ...(cfg.sitePermissions || {}) };
    if (rule === "clear") delete cfg.sitePermissions[origin];
    else cfg.sitePermissions[origin] = rule;
    await chrome.storage.local.set({ [STORAGE_KEY]: cfg });
    addNote(
      rule === "allow" ? `Trusted ${origin}` : rule === "block" ? `Blocked ${origin}` : `Cleared the rule for ${origin}`,
      rule === "allow" ? "shield" : rule === "block" ? "ban" : "dot",
    );
  } catch (e) {
    addError("Couldn't save the site rule: " + (e.message || e));
  }
}

async function onSubmit(e) {
  e.preventDefault();
  const text = els.input.value.trim();
  if (!text || running) return;
  if (!configured) {
    // First-run gate: no model yet — send them to Settings instead of failing.
    els.empty.hidden = false;
    els.notConfigured.hidden = false;
    chrome.runtime.openOptionsPage();
    return;
  }
  els.empty.hidden = true;
  rememberPrompt(text);
  exitHistory();
  // The user bubble is rendered from the worker's `user_echo` event so that
  // runs triggered by anything (composer, context menu) show consistently.
  els.input.value = "";
  autoGrow();
  refreshContextHint();
  const wasPending = newChatPending;
  const reply = send({ type: MSG.RUN_TASK, task: text, newChat: wasPending });
  newChatPending = false;
  setRunning(true);
  // Stop, New chat, then a quick send can land while the stopped run is still
  // saving. Hand the prompt back instead of dropping it.
  const res = await reply;
  if (res && res.ok === false && res.error === "A task is already running.") {
    if (!els.input.value) {
      els.input.value = text;
      autoGrow();
    }
    newChatPending = wasPending;
    els.empty.hidden = !!els.messages.querySelector(".msg");
    setRunning(false);
  }
}

function newChat() {
  if (running) send({ type: MSG.STOP_TASK });
  send({ type: MSG.NEW_CHAT }); // clear the worker's (persisted) conversation now
  clearTranscript();
  els.empty.hidden = false;
  newChatPending = true;
}

function clearTranscript() {
  els.messages.querySelectorAll(".msg, .log, .note, .alert, .perm-card, .thinking").forEach((n) => n.remove());
  current = null;
  pendingTools = [];
  logGroup = null;
  pinned = true;
  els.jumpLatest.hidden = true;
}

// The worker dropped the live chat (Clear all, or the open chat was deleted).
// The next send continues the worker's fresh chat, so nothing is armed here.
function resetChatView() {
  clearTranscript();
  els.empty.hidden = false;
  newChatPending = false;
}

// -------------------------------------------------------------------------
// Event handling
// -------------------------------------------------------------------------
function handleEvent(ev) {
  switch (ev.kind) {
    case "seed":
      if (!running) {
        els.input.value = ev.task;
        autoGrow();
      }
      break;
    case "user_echo":
      els.empty.hidden = true;
      addUserMessage(ev.text);
      break;
    case "assistant_start":
      startAssistant();
      break;
    case "assistant_delta":
      appendAssistant(ev.text);
      break;
    case "assistant_end":
      endAssistant(ev.content);
      break;
    case "tool_start":
      addToolStart(ev.name, ev.args);
      break;
    case "tool_end":
      addToolEnd(ev.name, ev.ok, ev.summary);
      break;
    case "planning":
      setStatus("Planning…");
      break;
    case "plan_declined":
      addNote("Plan declined — nothing was done.");
      break;
    case "finish":
      addFinish(ev.summary);
      break;
    case "mcp_connected":
      addNote(`Connected to MCP server “${ev.server}” (${ev.count} tool${ev.count === 1 ? "" : "s"})`, "dot");
      break;
    case "warning":
      addWarning(ev.text);
      break;
    case "note":
      addNote(ev.text, ev.icon || "dot");
      break;
    case "chat_reset":
      resetChatView();
      break;
    case "error":
      addError(ev.error);
      setRunning(false);
      break;
    case "aborted":
      addNote("Stopped.", "stop");
      setRunning(false);
      break;
    case "done":
      flushHeldSwitch();
      break;
    case "idle":
      setRunning(false);
      break;
  }
}

function setRunning(v) {
  const changed = running !== v;
  running = v;
  if (changed) refreshHistoryMenu(true);
  els.send.disabled = v;
  els.stop.hidden = !v;
  els.send.hidden = v;
  if (v) setStatus("Working…");
  else {
    clearStatus();
    flushHeldSwitch();
  }
}

// -------------------------------------------------------------------------
// Rendering
// -------------------------------------------------------------------------
function addUserMessage(text) {
  sealLog();
  const el = document.createElement("div");
  el.className = "msg user";
  el.textContent = text;
  els.messages.appendChild(el);
  scroll();
}

function startAssistant() {
  sealLog();
  const el = document.createElement("div");
  el.className = "msg assistant";
  el.innerHTML = '<span class="thinking"><span class="dot-pulse"></span>Thinking…</span>';
  els.messages.appendChild(el);
  current = { el, started: false, md: createStreamingRenderer(), timer: 0, tick: 16, lastHtml: "", copy: null };
  scroll();
}

// The copy feedback and the keyboard focus live on the message's record, not on
// the button: every render replaces all the controls in the message, so both have
// to be put back. Without this the button resets to "Copy" and focus falls to the
// body the moment the reply re-renders.
function focusedCopyIndex(c) {
  return document.activeElement?.classList.contains("md-copy")
    ? [...c.el.querySelectorAll(".md-copy")].indexOf(document.activeElement)
    : -1;
}

function restoreCopy(c, focusIndex) {
  const btns = [...c.el.querySelectorAll(".md-copy")];
  if (c.copy) {
    const b = btns[c.copy.index];
    if (b) applyCopy(b, c.copy.state);
  }
  // preventScroll: a reader who scrolled away keeps their place. Focus moves to the
  // new control without pulling the transcript back to it.
  if (focusIndex >= 0) btns[focusIndex]?.focus({ preventScroll: true });
}

function renderStream(c) {
  const focusIndex = focusedCopyIndex(c);
  const html = c.md.render();
  if (html !== c.lastHtml) {
    c.el.innerHTML = html;
    c.lastHtml = html;
    restoreCopy(c, focusIndex); // only a swap replaces the controls
  }
  scroll();
}

function appendAssistant(text) {
  if (!current) startAssistant();
  if (!current.started) {
    current.el.innerHTML = "";
    current.started = true;
  }
  current.md.append(text);
  // One render per tick, on a timer: requestAnimationFrame does not run in a
  // background tab, and the panel renders there too. The tick is four times the
  // last render's cost (renderTick), so a long reply is not re-rendered faster
  // than the thread can keep up with; a normal reply keeps the 16 ms tick.
  if (!current.timer) {
    const c = current;
    current.timer = setTimeout(() => {
      c.timer = 0;
      const t0 = performance.now();
      renderStream(c);
      c.tick = renderTick(performance.now() - t0);
    }, current.tick);
  }
  scroll();
}

function endAssistant(content) {
  if (!current) return;
  const c = current;
  if (c.timer) clearTimeout(c.timer);
  const focusIndex = focusedCopyIndex(c);
  const html = c.md.finalize(content);
  if (html.trim()) {
    c.el.innerHTML = html;
    restoreCopy(c, focusIndex); // the final render replaces the controls too
  } else {
    c.el.remove(); // pure tool-call turn with no visible text
  }
  current = null;
  scroll();
}

// -------------------------------------------------------------------------
// Tool log
//
// A run of consecutive tool calls renders as ONE collapsible group — a single
// rule with a status dot per action — rather than a stack of bordered pills,
// which at 380px turned a ten-step task into fourteen outlined rectangles.
// Anything else in the transcript (prose, a permission card, an alert) seals
// the group, so the log's structure mirrors the conversation's.
// -------------------------------------------------------------------------
function openLog() {
  if (logGroup && els.messages.lastElementChild === logGroup.el) return logGroup;
  const el = document.createElement("details");
  el.className = "log";
  el.open = true;
  el.innerHTML =
    `<summary class="log-head">${ic("chevron-down")}<span class="log-sum"></span></summary>` +
    `<div class="log-rows"></div>`;
  els.messages.appendChild(el);
  logGroup = {
    el,
    rows: el.querySelector(".log-rows"),
    sum: el.querySelector(".log-sum"),
    count: 0,
    hosts: new Set(),
  };
  return logGroup;
}

// A finished run of three or more actions collapses to its one-line header: by
// then the answer below it is what the user actually wants to read.
function sealLog() {
  if (logGroup && logGroup.count >= 3) logGroup.el.open = false;
  logGroup = null;
}

function logSummary(g) {
  const host = g.hosts.size === 1 ? [...g.hosts][0] : "";
  g.sum.textContent = `${g.count} action${g.count === 1 ? "" : "s"}${host ? " on " + host : ""}`;
}

function addToolStart(name, args) {
  const g = openLog();
  g.count += 1;
  const host = eventHost(args);
  if (host) g.hosts.add(host);
  logSummary(g);
  const row = document.createElement("div");
  row.className = "log-row running";
  row.innerHTML = logRow(name, argHint(name, args), "");
  g.rows.appendChild(row);
  pendingTools.push({ name, el: row, t0: performance.now() });
  scroll();
}

function addToolEnd(name, ok, summary) {
  const pending = pendingTools.shift();
  let row = pending && pending.el;
  if (!row) {
    const g = openLog();
    g.count += 1;
    logSummary(g);
    row = document.createElement("div");
    g.rows.appendChild(row);
  }
  row.className = "log-row " + (ok ? "ok" : "err");
  row.innerHTML = logRow(name, summary || "", pending ? fmtDur(performance.now() - pending.t0) : "");
  scroll();
}

function logRow(name, detail, dur) {
  return (
    `<span class="log-dot"></span><span class="tool-name">${escapeHtml(name)}</span>` +
    `<span class="tool-detail" title="${escapeHtml(detail)}">${escapeHtml(detail)}</span>` +
    `<span class="log-dur">${escapeHtml(dur)}</span>`
  );
}

function fmtDur(ms) {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// Which site an action happened on — for the group header ("6 actions on
// github.com"). Falls back to the tab the panel is attached to.
function eventHost(args) {
  try {
    if (args && args.url) return new URL(args.url).hostname;
  } catch {
    /* not a URL */
  }
  try {
    if (currentSiteOrigin) return new URL(currentSiteOrigin).hostname;
  } catch {
    /* ignore */
  }
  return "";
}

function addFinish(summary) {
  sealLog();
  const el = document.createElement("div");
  el.className = "msg assistant";
  el.innerHTML = markdownToHtml(summary);
  els.messages.appendChild(el);
  scroll();
}

function addError(text) {
  sealLog();
  const el = document.createElement("div");
  el.className = "alert bad";
  el.innerHTML = `${ic("alert")}<span>${escapeHtml(text)}</span>`;
  els.messages.appendChild(el);
  scroll();
}

function addWarning(text) {
  sealLog();
  const el = document.createElement("div");
  el.className = "alert warn";
  el.innerHTML = `${ic("shield")}<span>${escapeHtml(text)}</span>`;
  els.messages.appendChild(el);
  scroll();
}

function addNote(text, icon, action) {
  sealLog();
  const el = document.createElement("div");
  el.className = "note";
  el.innerHTML = `${icon ? ic(icon) : ""}<span>${escapeHtml(text)}</span>`;
  if (action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "note-action";
    btn.textContent = action.label;
    btn.addEventListener("click", action.onClick);
    el.appendChild(btn);
  }
  els.messages.appendChild(el);
  scroll();
}

function showPlan(req) {
  sealLog();
  const plan = req.plan || {};
  const el = document.createElement("div");
  el.className = "perm-card plan-card";
  const steps = (plan.steps || []).map((s) => `<li>${escapeHtml(s)}</li>`).join("");
  const domains = (plan.domains || []).map((d) => `<span class="domain-chip">${escapeHtml(d)}</span>`).join("");
  el.innerHTML = `
    <h3>Plan — approve to continue?</h3>
    ${plan.summary ? `<p>${escapeHtml(plan.summary)}</p>` : ""}
    ${steps ? `<ol class="plan-steps">${steps}</ol>` : ""}
    ${domains ? `<div class="plan-domains"><span class="plan-domains-label">Sites:</span> ${domains}</div>` : ""}
    <div class="perm-buttons">
      <button class="primary" data-approved="1">Approve &amp; run</button>
      <button class="danger" data-approved="0">Decline</button>
    </div>`;
  el.querySelectorAll("button").forEach((btn) =>
    btn.addEventListener("click", () => {
      el.querySelectorAll("button").forEach((b) => (b.disabled = true));
      const approved = btn.dataset.approved === "1";
      send({ type: MSG.PLAN_RESPONSE, id: req.id, approved });
      el.querySelector(".perm-buttons").outerHTML = `<p class="muted-note">${approved ? "Approved." : "Declined."}</p>`;
    }),
  );
  els.messages.appendChild(el);
  scroll();
}

function showPermission(req) {
  sealLog();
  const el = document.createElement("div");
  el.className = "perm-card" + (req.sensitive ? " sensitive" : "");
  const action = describeAction(req.toolName, req.args);
  // An MCP tool runs on a server, not on a page: no origin, and nothing here may
  // read as "trust this site" (a session grant for the server is all it gets).
  const title = req.mcp
    ? "Allow MCP tool?"
    : req.sensitive
      ? req.why
        ? "Confirm this action?"
        : "Sensitive site"
      : req.newSite
        ? "New site — trust it?"
        : "Allow action?";
  const intro = req.mcp
    ? `OpenSidekick wants to call the tool <strong>${escapeHtml(req.toolName || "")}</strong> on your MCP server <span class="origin">${escapeHtml(req.serverName || "")}</span>.`
    : req.newSite
      ? `You're in <strong>only-allowed-sites</strong> mode and <span class="origin">${escapeHtml(req.origin)}</span> isn't on your list. OpenSidekick wants to <strong>${escapeHtml(action)}</strong> here.`
      : `OpenSidekick wants to <strong>${escapeHtml(action)}</strong> on <span class="origin">${escapeHtml(req.origin)}</span>.`;
  const alsoLabel = req.mcp ? "Allow for this session" : req.newSite ? "Trust this site" : "Always allow this site";
  el.innerHTML = `
    <h3>${title}</h3>
    <p>${intro}</p>
    ${req.why ? `<p class="muted-note">${escapeHtml(req.why)}.</p>` : ""}
    <div class="perm-buttons">
      <button class="primary" data-choice="once">Allow once</button>
      ${req.sensitive ? "" : `<button data-choice="always">${alsoLabel}</button>`}
      <button class="danger" data-choice="decline">Decline</button>
    </div>`;
  el.querySelectorAll("button").forEach((btn) =>
    btn.addEventListener("click", () => {
      el.querySelectorAll("button").forEach((b) => (b.disabled = true));
      const choice = btn.dataset.choice;
      send({ type: MSG.PERMISSION_RESPONSE, id: req.id, choice });
      el.querySelector(".perm-buttons").outerHTML =
        `<p class="muted-note">${choice === "decline" ? "Declined." : "Allowed."}</p>`;
    }),
  );
  els.messages.appendChild(el);
  scroll();
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------
function describeAction(name, args) {
  switch (name) {
    case "click_element":
      return "click an element";
    case "type_text":
      return `type text${args && args.submit ? " and submit" : ""}`;
    case "select_option":
      return "choose a dropdown option";
    case "navigate":
      return `navigate to ${args ? args.url : "a page"}`;
    case "open_tab":
      return args && args.url ? `open a new tab to ${args.url}` : "open a new tab";
    case "switch_tab":
      return "switch to a tab";
    case "scroll":
      return "scroll the page";
    case "read_page":
    case "get_page_text":
      return "read this page";
    case "take_screenshot":
      return "take a screenshot";
    case "read_console":
      return "read the page's console";
    case "read_network":
      return "read the page's network requests";
    default:
      return name.replace(/_/g, " ");
  }
}

function argHint(name, args) {
  if (!args) return "";
  if (name === "navigate" || name === "open_tab") return args.url || "";
  if (name === "type_text") return `"${(args.text || "").slice(0, 30)}"`;
  if (name === "select_option") return args.value || "";
  if ("ref" in args) return "ref " + args.ref;
  return "";
}

function setStatus(text) {
  els.status.hidden = false;
  els.status.innerHTML = `<span class="dot-pulse"></span>${escapeHtml(text)}`;
}
function clearStatus() {
  els.status.hidden = true;
}

// -------------------------------------------------------------------------
// Saved prompts / "/" menu
// -------------------------------------------------------------------------
async function loadPrompts() {
  try {
    const raw = await chrome.storage.local.get(STORAGE_KEY);
    savedPrompts = (raw[STORAGE_KEY] && raw[STORAGE_KEY].prompts) || [];
  } catch {
    savedPrompts = [];
  }
}

function onInputKeydown(e) {
  if (!els.slashMenu.hidden && slashItems.length) {
    if (e.key === "ArrowDown") return e.preventDefault(), moveSlash(1);
    if (e.key === "ArrowUp") return e.preventDefault(), moveSlash(-1);
    if (e.key === "Enter" && !e.shiftKey) return e.preventDefault(), selectSlash(slashIndex);
    if (e.key === "Tab") return e.preventDefault(), selectSlash(slashIndex);
    if (e.key === "Escape") return e.preventDefault(), hideSlashMenu();
  }
  if (handleHistoryKey(e)) return;
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    onSubmit(e);
  }
}

// -------------------------------------------------------------------------
// Prompt history — shell-style ↑/↓ recall in the composer. ↑ in an empty box
// (or on the first line while browsing) recalls older prompts; ↓ on the last
// line moves newer, and past the newest restores whatever you had typed.
// Recalled text is editable; Enter runs it as usual. Esc exits browsing.
// -------------------------------------------------------------------------
let promptHistory = []; // chronological, most recent LAST
let histIndex = -1; // -1 = not browsing; otherwise 0 = most recent
let histDraft = null; // what was in the box when browsing started

async function loadPromptHistory() {
  try {
    const raw = await chrome.storage.local.get(PROMPT_HISTORY_KEY);
    if (Array.isArray(raw[PROMPT_HISTORY_KEY])) promptHistory = raw[PROMPT_HISTORY_KEY];
  } catch {
    /* start empty */
  }
}

function rememberPrompt(text) {
  if (promptHistory[promptHistory.length - 1] === text) return; // consecutive dupe
  promptHistory.push(text);
  if (promptHistory.length > PROMPT_HISTORY_MAX) promptHistory = promptHistory.slice(-PROMPT_HISTORY_MAX);
  if (keepHistory) chrome.storage.local.set({ [PROMPT_HISTORY_KEY]: promptHistory }).catch(() => {});
}

function exitHistory() {
  histIndex = -1;
  histDraft = null;
}

function recallHistory(index) {
  histIndex = index;
  const text = promptHistory[promptHistory.length - 1 - index];
  els.input.value = text;
  // Caret at the end — ready to edit or run.
  els.input.setSelectionRange(text.length, text.length);
  autoGrow();
}

function caretOnFirstLine() {
  return !els.input.value.slice(0, els.input.selectionStart).includes("\n");
}
function caretOnLastLine() {
  return !els.input.value.slice(els.input.selectionEnd).includes("\n");
}

// Returns true when the keystroke was consumed by history navigation.
function handleHistoryKey(e) {
  if (e.key === "Escape" && histIndex !== -1) {
    e.preventDefault();
    els.input.value = histDraft || "";
    autoGrow();
    exitHistory();
    return true;
  }
  if (e.key === "ArrowUp" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
    if (!promptHistory.length) return false;
    if (histIndex === -1) {
      // Only hijack ↑ when it can't mean caret movement the user intended:
      // an empty box starts browsing; typed text keeps normal caret behavior.
      if (els.input.value.trim() !== "") return false;
      e.preventDefault();
      histDraft = els.input.value;
      recallHistory(0);
      return true;
    }
    if (caretOnFirstLine() && histIndex < promptHistory.length - 1) {
      e.preventDefault();
      recallHistory(histIndex + 1);
      return true;
    }
    return false; // browsing a multiline entry — let the caret move
  }
  if (e.key === "ArrowDown" && histIndex !== -1 && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
    if (!caretOnLastLine()) return false;
    e.preventDefault();
    if (histIndex === 0) {
      els.input.value = histDraft || "";
      autoGrow();
      exitHistory();
    } else {
      recallHistory(histIndex - 1);
    }
    return true;
  }
  return false;
}

function updateSlashMenu() {
  const val = els.input.value;
  if (!isSlashQuery(val) || !savedPrompts.length) return hideSlashMenu();
  slashItems = matchPrompts(savedPrompts, val);
  slashIndex = 0;
  renderSlashMenu();
}

function renderSlashMenu() {
  if (!slashItems.length) {
    els.slashMenu.innerHTML = `<div class="slash-empty">No matching saved prompts. Add some in Settings → Saved prompts.</div>`;
    els.slashMenu.hidden = false;
    return;
  }
  els.slashMenu.innerHTML = slashItems
    .map(
      (p, i) =>
        `<div class="slash-item${i === slashIndex ? " active" : ""}" data-i="${i}"><span class="slash-cmd">/${escapeHtml(p.command)}</span><span class="slash-preview">${escapeHtml((p.text || "").replace(/\s+/g, " "))}</span></div>`,
    )
    .join("");
  els.slashMenu.querySelectorAll(".slash-item").forEach((el) =>
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      selectSlash(Number(el.dataset.i));
    }),
  );
  els.slashMenu.hidden = false;
}

function moveSlash(delta) {
  if (!slashItems.length) return;
  slashIndex = (slashIndex + delta + slashItems.length) % slashItems.length;
  renderSlashMenu();
}

function selectSlash(i) {
  const p = slashItems[i];
  if (!p) return;
  els.input.value = p.text || "";
  hideSlashMenu();
  autoGrow();
  els.input.focus();
}

function hideSlashMenu() {
  els.slashMenu.hidden = true;
  els.slashMenu.innerHTML = "";
  slashItems = [];
}

// -------------------------------------------------------------------------
// Workflow recording & replay
// -------------------------------------------------------------------------
async function toggleRecording() {
  if (recording) return stopRec();
  // Reflect the recording state immediately — starting can take a moment while the
  // content script is injected, and without feedback users click again, which used
  // to spawn a second start whose late reply resurrected the banner after Stop.
  const gen = ++recGen;
  recording = true;
  recCount = 0;
  els.recordBtn.classList.add("recording");
  els.empty.hidden = true;
  hideWorkflowsMenu();
  updateRecBanner();

  const res = await send({ type: MSG.START_RECORDING });
  if (gen !== recGen) {
    // Stopped (or re-toggled) before the start completed. If we're not recording
    // anymore, make sure the worker isn't left recording either.
    if (!recording) send({ type: MSG.STOP_RECORDING });
    return;
  }
  if (!res || res.ok === false) {
    recording = false;
    els.recordBtn.classList.remove("recording");
    els.recBanner.hidden = true;
    return addError((res && res.error) || "Couldn't start recording.");
  }
}

async function stopRec() {
  recGen++; // invalidate any start still in flight so its reply can't re-show the banner
  recording = false;
  recCount = 0;
  els.recordBtn.classList.remove("recording");
  els.recBanner.hidden = true;
  const res = await send({ type: MSG.STOP_RECORDING });
  const steps = (res && res.steps) || [];
  if (steps.length) showSaveWorkflow(steps, (res && res.startUrl) || "");
  else addNote("Recording stopped — no actions were captured.");
}

function updateRecBanner() {
  if (!recording) return (els.recBanner.hidden = true);
  els.recBanner.hidden = false;
  els.recBanner.innerHTML = `<span class="rec-dot"></span><span class="grow">Recording — ${recCount} step${recCount === 1 ? "" : "s"}. Do things on the page…</span><button id="rec-stop">Stop</button>`;
  els.recBanner.querySelector("#rec-stop").addEventListener("click", stopRec);
}

function showSaveWorkflow(steps, startUrl) {
  sealLog();
  // Park the steps in session storage until the user decides — otherwise
  // closing the panel before clicking Save silently loses the recording.
  chrome.storage.session.set({ [SESSION_PENDING_WF_KEY]: { steps, startUrl } }).catch(() => {});
  const el = document.createElement("div");
  el.className = "perm-card";
  const list = steps.map((s) => `<li>${escapeHtml(s.description || String(s))}</li>`).join("");
  el.innerHTML = `
    <h3>Save this workflow?</h3>
    <ol class="plan-steps">${list}</ol>
    <input id="wf-name" class="wf-name-input" placeholder="Name (e.g. Book a meeting room)" />
    <div class="perm-buttons"><button class="primary" data-save="1">Save</button><button data-save="0">Discard</button></div>`;
  el.querySelectorAll("button").forEach((btn) =>
    btn.addEventListener("click", async () => {
      chrome.storage.session.remove(SESSION_PENDING_WF_KEY).catch(() => {});
      if (btn.dataset.save === "1") {
        const name = (el.querySelector("#wf-name").value || "").trim() || "Untitled workflow";
        await saveWorkflow({ id: crypto.randomUUID(), name, startUrl, steps });
        el.querySelector(".perm-buttons").outerHTML = `<p class="muted-note">Saved “${escapeHtml(name)}”. Replay it from the Saved workflows menu.</p>`;
      } else {
        el.remove();
      }
    }),
  );
  els.messages.appendChild(el);
  scroll();
}

// If a recording was stopped but never saved/discarded (e.g. the panel closed),
// re-offer it when the panel opens again.
async function restorePendingWorkflow() {
  try {
    const raw = await chrome.storage.session.get(SESSION_PENDING_WF_KEY);
    const pending = raw[SESSION_PENDING_WF_KEY];
    if (pending && Array.isArray(pending.steps) && pending.steps.length) {
      els.empty.hidden = true;
      showSaveWorkflow(pending.steps, pending.startUrl || "");
    }
  } catch {
    /* session storage unavailable — nothing to restore */
  }
}

function toggleWorkflowsMenu() {
  if (!els.wfMenu.hidden) return hideWorkflowsMenu();
  hideHistoryMenu(false);
  loadWorkflows().then(renderWorkflowsMenu);
  document.addEventListener("mousedown", wfOutside, true);
}

function wfOutside(e) {
  if (els.wfMenu.contains(e.target) || e.target === els.workflowsBtn) return;
  hideWorkflowsMenu();
}

function renderWorkflowsMenu(wfs) {
  if (!wfs.length) {
    els.wfMenu.innerHTML = `<div class="wf-empty">No saved workflows yet. Use the Record button in the header to make one.</div>`;
  } else {
    els.wfMenu.innerHTML = wfs
      .map(
        (w, i) =>
          `<div class="wf-item" data-i="${i}">${ic("play")}<span class="wf-name">${escapeHtml(w.name)}</span><span class="wf-count">${(w.steps || []).length} steps</span></div>`,
      )
      .join("");
    els.wfMenu.querySelectorAll(".wf-item").forEach((el) =>
      el.addEventListener("click", () => replayWorkflow(wfs[Number(el.dataset.i)])),
    );
  }
  // Hangs just below the top bar, whose height changes with the model line.
  els.wfMenu.style.top = `${Math.round(document.querySelector(".topbar").getBoundingClientRect().bottom) + 4}px`;
  els.wfMenu.hidden = false;
}

function hideWorkflowsMenu() {
  els.wfMenu.hidden = true;
  document.removeEventListener("mousedown", wfOutside, true);
}

function replayWorkflow(wf) {
  if (!wf || running) return;
  hideWorkflowsMenu();
  els.empty.hidden = true;
  addNote(`Replaying workflow “${wf.name}”`, "play");
  send({ type: MSG.RUN_TASK, task: workflowPrompt(wf), newChat: newChatPending });
  newChatPending = false;
  setRunning(true);
}

function workflowPrompt(wf) {
  const steps = (wf.steps || []).map((s, i) => `${i + 1}. ${s.description || s}`).join("\n");
  let p = `Replay this saved workflow named "${wf.name}". Perform each step in order on the page using your tools (read_page, click, type, and so on). Adapt to the current page if it differs slightly, and stop if a step can't be completed.\n\nSteps:\n${steps}`;
  if (wf.startUrl) p = `First make sure the current tab is at ${wf.startUrl} (navigate there if it isn't). Then ${p}`;
  return p;
}

async function loadWorkflows() {
  try {
    const raw = await chrome.storage.local.get(STORAGE_KEY);
    return (raw[STORAGE_KEY] && raw[STORAGE_KEY].workflows) || [];
  } catch {
    return [];
  }
}

async function saveWorkflow(wf) {
  try {
    const raw = await chrome.storage.local.get(STORAGE_KEY);
    const cfg = raw[STORAGE_KEY] || {};
    cfg.workflows = [...(cfg.workflows || []), wf];
    await chrome.storage.local.set({ [STORAGE_KEY]: cfg });
  } catch (e) {
    addError("Couldn't save workflow: " + (e.message || e));
  }
}

// -------------------------------------------------------------------------
// Chat history — the popover behind the History button. Built on the
// workflows menu's pattern (positioned under the top bar, outside click
// closes, opening one closes the other). The worker owns every write; this
// only sends messages and renders what LIST_SESSIONS returns.
// -------------------------------------------------------------------------
let histItems = []; // the items last rendered, newest first

const HIST_STATUS = {
  busy: "A task is running. Try again when it finishes.",
  "not-found": "That chat is no longer saved.",
};
const statusFor = (error) => HIST_STATUS[error] || "Something went wrong. Try again.";

function wireHistoryMenu() {
  els.historyBtn.addEventListener("click", toggleHistoryMenu);
  els.histBody.addEventListener("click", onHistoryClick);
  els.histMenu.addEventListener("keydown", onHistoryKeydown);
  // Tabbing (or clicking) to something outside closes it. A null relatedTarget
  // is focus going nowhere (a re-render removed the button, or the window lost
  // focus), which isn't the user leaving.
  els.histMenu.addEventListener("focusout", (e) => {
    const to = e.relatedTarget;
    if (to && !els.histMenu.contains(to) && !els.historyBtn.contains(to)) hideHistoryMenu(false);
  });
}

async function toggleHistoryMenu() {
  if (!els.histMenu.hidden) return hideHistoryMenu(false);
  hideWorkflowsMenu();
  histStatus("");
  renderHistoryMenu(await listSessions());
  els.histMenu.style.top = `${Math.round(document.querySelector(".topbar").getBoundingClientRect().bottom) + 4}px`;
  els.histMenu.hidden = false;
  els.historyBtn.setAttribute("aria-expanded", "true");
  document.addEventListener("mousedown", histOutside, true);
  document.addEventListener("keydown", histEscape);
  const current = els.histBody.querySelector(".hist-item.current .hist-open:not(:disabled)");
  (current || els.histBody.querySelector(".hist-open:not(:disabled)") || firstHistFocusable()).focus();
}

function histOutside(e) {
  if (els.histMenu.contains(e.target) || els.historyBtn.contains(e.target)) return;
  hideHistoryMenu(false);
}

// Esc from anywhere while it is open; the rename field and the inline confirms
// handle their own Esc and stop it before it gets here.
function histEscape(e) {
  if (e.key !== "Escape" || e.defaultPrevented) return;
  e.preventDefault();
  hideHistoryMenu(true);
}

function hideHistoryMenu(returnFocus) {
  if (els.histMenu.hidden) return;
  els.histMenu.hidden = true;
  els.historyBtn.setAttribute("aria-expanded", "false");
  document.removeEventListener("mousedown", histOutside, true);
  document.removeEventListener("keydown", histEscape);
  if (returnFocus) els.historyBtn.focus();
}

function histStatus(text) {
  els.histStatus.textContent = text;
}

async function listSessions() {
  const res = await send({ type: MSG.LIST_SESSIONS });
  return res && res.ok ? res : null;
}

function firstHistFocusable() {
  return els.histMenu.querySelector("button:not(:disabled), input") || els.histMenu;
}

// Focus a control in a row by chat id (or, with no id, a control outside the
// rows such as Clear all), or the first focusable when it is gone.
function focusHist(id, cls = "hist-open") {
  const row = id ? [...els.histBody.querySelectorAll(".hist-item")].find((li) => li.dataset.id === id) : null;
  const el = id ? row && row.querySelector(`.${cls}`) : els.histBody.querySelector(`.${cls}`);
  (el && !el.disabled ? el : firstHistFocusable()).focus();
}

// Re-lists and re-renders .hist-body only. A passive refresh (storage changed,
// a run started or ended) is skipped while the popover is closed or a rename
// or confirm is open, and keeps focus on the same control.
async function refreshHistoryMenu(passive = false) {
  const editing = () => !!els.histBody.querySelector(".hist-confirm, .hist-rename-input");
  if (passive && (els.histMenu.hidden || editing())) return;
  const res = await listSessions();
  if (passive && editing()) return;
  const a = document.activeElement;
  const keep = passive && els.histBody.contains(a)
    ? { id: a.closest(".hist-item")?.dataset.id, cls: ["hist-open", "hist-rename", "hist-delete", "hist-clear", "hist-settings"].find((c) => a.classList.contains(c)) }
    : null;
  renderHistoryMenu(res);
  if (keep) focusHist(keep.id, keep.cls);
}

function renderHistoryMenu(res) {
  histItems = (res && res.items) || [];
  if (!res) {
    els.histBody.innerHTML = `<p class="hist-empty">Something went wrong. Try again.</p>`;
    return;
  }
  if (!res.enabled) {
    els.histBody.innerHTML = `<div class="hist-off"><p>Chat history is off, so chats aren't kept after Chrome closes.</p><button type="button" class="hist-settings">Turn on in Settings</button></div>`;
    return;
  }
  if (!histItems.length) {
    els.histBody.innerHTML = `<p class="hist-empty">No saved chats yet. A chat is saved here after its first message.</p>`;
    return;
  }
  // Switching or deleting mid-run would kill the task or leave it writing into
  // a chat that's no longer on screen. Rename is harmless, so it stays.
  const busy = !!res.running || running;
  const dis = busy ? " disabled" : "";
  const rows = histItems
    .map((it) => {
      const cur = it.id === res.currentId;
      const title = escapeHtml(it.title);
      const who = it.model ? (it.provider ? `${it.model} via ${it.provider}` : it.model) : "";
      const tip = escapeHtml(`${it.title}\n${new Date(it.updatedAt).toLocaleString()}${who ? ` · ${who}` : ""}`).replace(/\n/g, "&#10;");
      const model = it.model ? `<span aria-hidden="true">·</span><span class="hist-model">${escapeHtml(it.model)}</span>` : "";
      return (
        `<li class="hist-item${cur ? " current" : ""}" data-id="${escapeHtml(it.id)}">` +
        `<button type="button" class="hist-open"${cur ? ' aria-current="true"' : ""} title="${tip}"${dis}>` +
        `<span class="hist-title">${title}</span>` +
        `<span class="hist-meta"><span class="hist-time">${escapeHtml(relativeTime(it.updatedAt))}</span>${model}</span></button>` +
        `<button type="button" class="icon-btn hist-rename" title="Rename" aria-label="Rename chat “${title}”">${ic("pencil")}</button>` +
        `<button type="button" class="icon-btn hist-delete" title="Delete" aria-label="Delete chat “${title}”"${dis}>${ic("trash")}</button>` +
        `</li>`
      );
    })
    .join("");
  els.histBody.innerHTML =
    `<div class="hist-head"><span class="eyebrow">Recent chats</span><span class="mono hist-count">${histItems.length} of ${SESSIONS_MAX}</span></div>` +
    (busy ? `<p class="hist-busy">Switching and deleting chats is paused while a task runs.</p>` : "") +
    `<ul class="hist-list" aria-label="Saved chats">${rows}</ul>` +
    `<div class="hist-foot"><span class="hist-note">Saved on this device only.</span><button type="button" class="hist-clear"${dis}>Clear all</button></div>`;
}

function onHistoryClick(e) {
  const btn = e.target.closest("button");
  if (!btn || btn.disabled) return;
  const li = btn.closest(".hist-item");
  if (btn.classList.contains("hist-open")) openSession(li.dataset.id);
  else if (btn.classList.contains("hist-rename")) startRename(li);
  else if (btn.classList.contains("hist-delete")) confirmDelete(li);
  else if (btn.classList.contains("hist-clear")) confirmClear();
  else if (btn.classList.contains("hist-settings")) chrome.runtime.openOptionsPage();
}

// ↑/↓ move between chats; Tab keeps its natural order (open, rename, delete).
function onHistoryKeydown(e) {
  if ((e.key !== "ArrowDown" && e.key !== "ArrowUp") || !e.target.classList.contains("hist-open")) return;
  e.preventDefault();
  const opens = [...els.histBody.querySelectorAll(".hist-open:not(:disabled)")];
  const i = opens.indexOf(e.target) + (e.key === "ArrowDown" ? 1 : -1);
  opens[Math.max(0, Math.min(opens.length - 1, i))]?.focus();
}

async function openSession(id) {
  if (els.histBody.querySelector(".hist-item.current")?.dataset.id === id) {
    hideHistoryMenu(false); // already the open chat
    els.input.focus();
    return;
  }
  const res = await send({ type: MSG.OPEN_SESSION, id });
  if (!res || !res.ok) {
    histStatus(statusFor(res && res.error));
    if (res && (res.error === "not-found" || res.error === "disabled")) refreshHistoryMenu();
    return;
  }
  hideHistoryMenu(false);
  // Same as New chat: this also drops a parked "Save this workflow?" card,
  // which comes back from storage.session the next time the panel opens.
  clearTranscript();
  newChatPending = false; // otherwise the next send would discard the chat just opened
  const history = res.history || [];
  if (res.trimmed) addNote(TRIMMED_NOTE, "dot");
  renderHistory(history);
  els.empty.hidden = history.length > 0;
  scroll();
  els.input.focus();
}

function startRename(li) {
  const id = li.dataset.id;
  const item = histItems.find((it) => it.id === id);
  const open = li.querySelector(".hist-open");
  if (!item || !open) return;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "hist-rename-input";
  input.maxLength = 80;
  input.setAttribute("aria-label", "Chat name");
  input.value = item.title;
  open.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  // After a blur the user has already moved on, so focus stays where they put it.
  const revert = (refocus) => {
    done = true;
    input.replaceWith(open);
    if (refocus) open.focus();
  };
  const commit = async (byKey) => {
    if (done) return;
    const title = input.value.trim();
    if (!title || title === item.title) return revert(byKey);
    done = true;
    // After a blur the click that caused it may have opened a confirm or
    // another rename, so put the row back now and refresh only passively.
    if (!byKey) input.replaceWith(open);
    const res = await send({ type: MSG.RENAME_SESSION, id, title });
    if (res && res.ok) {
      item.title = res.title;
      open.querySelector(".hist-title").textContent = res.title; // in case the refresh is skipped
    }
    await refreshHistoryMenu(!byKey);
    if (byKey || !document.activeElement || document.activeElement === document.body) focusHist(id);
    histStatus(res && res.ok ? "Chat renamed." : statusFor(res && res.error));
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // the popover stays open
      revert(true);
    }
  });
  input.addEventListener("blur", () => commit(false));
}

// Swaps `host`'s contents for an inline "are you sure?" with focus on Cancel,
// the least destructive choice. Esc cancels too.
function inlineConfirm(host, question, yesLabel, onYes, onCancel) {
  const before = host.innerHTML;
  host.innerHTML =
    `<div class="hist-confirm"><span>${escapeHtml(question)}</span>` +
    `<button type="button" class="danger hist-confirm-yes">${escapeHtml(yesLabel)}</button>` +
    `<button type="button" class="hist-confirm-no">Cancel</button></div>`;
  const box = host.querySelector(".hist-confirm");
  const cancel = () => {
    host.innerHTML = before;
    onCancel();
  };
  box.querySelector(".hist-confirm-no").addEventListener("click", cancel);
  box.querySelector(".hist-confirm-yes").addEventListener("click", async () => {
    box.querySelectorAll("button").forEach((b) => (b.disabled = true));
    if ((await onYes()) === false) cancel();
  });
  box.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    cancel();
  });
  box.querySelector(".hist-confirm-no").focus();
}

function confirmDelete(li) {
  const id = li.dataset.id;
  const ids = histItems.map((it) => it.id);
  const at = ids.indexOf(id);
  inlineConfirm(
    li,
    "Delete this chat?",
    "Delete",
    async () => {
      const res = await send({ type: MSG.DELETE_SESSION, id });
      if (!res || !res.ok) {
        histStatus(statusFor(res && res.error));
        return false; // busy: the list stays as it was
      }
      if (res.wasCurrent) resetChatView(); // the worker's chat_reset says the same
      await refreshHistoryMenu();
      focusHist(ids[at + 1] || ids[at - 1]);
      histStatus("Chat deleted.");
    },
    () => li.querySelector(".hist-delete")?.focus(),
  );
}

function confirmClear() {
  const foot = els.histBody.querySelector(".hist-foot");
  if (!foot) return;
  const n = histItems.length;
  inlineConfirm(
    foot,
    `Delete all ${n} saved chat${n === 1 ? "" : "s"} and your prompt history? The open chat is cleared too.`,
    "Delete all",
    async () => {
      const res = await send({ type: MSG.CLEAR_SESSIONS });
      if (!res || !res.ok) {
        histStatus(statusFor(res && res.error));
        return false;
      }
      resetChatView(); // the worker's chat_reset says the same
      await refreshHistoryMenu();
      firstHistFocusable().focus();
      histStatus("History cleared.");
    },
    () => foot.querySelector(".hist-clear")?.focus(),
  );
}

function autoGrow() {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 160) + "px";
}

// The transcript follows new output only while the user is already at the
// bottom; scrolling up to read something now holds its position and offers a
// "jump to latest" pill instead of being yanked back down.
let pinned = true;

function nearBottom() {
  const m = els.messages;
  return m.scrollHeight - m.scrollTop - m.clientHeight < 40;
}

function onMessagesScroll() {
  pinned = nearBottom();
  els.jumpLatest.hidden = pinned;
}

function scroll() {
  if (!pinned) return;
  els.messages.scrollTop = els.messages.scrollHeight;
  els.jumpLatest.hidden = true;
}

// Icons come from the inline <svg> sprite at the top of sidepanel.html — no
// fetch, no icon font, nothing for the MV3 CSP to block.
function ic(name) {
  return `<svg class="ic" aria-hidden="true"><use href="#ic-${name}"/></svg>`;
}

function send(msg) {
  return chrome.runtime.sendMessage(msg).catch(() => null);
}
