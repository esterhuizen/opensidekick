// Side panel UI controller. Talks to the service worker via runtime messages
// and renders the streaming agent transcript.

import { MSG, STORAGE_KEY } from "../common/constants.js";
import { matchPrompts, isSlashQuery } from "../common/prompts.js";

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
  recBanner: document.getElementById("rec-banner"),
  wfMenu: document.getElementById("wf-menu"),
  autonomy: document.getElementById("autonomy"),
};

let savedPrompts = [];
let slashItems = [];
let slashIndex = 0;
let recording = false;
let recCount = 0;
let configured = false;

let running = false;
let newChatPending = true; // first send starts a fresh conversation
let current = null; // { el, raw } assistant bubble being streamed
let pendingTools = []; // tool-event elements awaiting completion

init();

async function init() {
  const state = await send({ type: MSG.GET_STATE });
  if (state) applyState(state);
  refreshConfigured();
  refreshContextHint();

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
  els.autonomy.querySelectorAll(".seg").forEach((btn) =>
    btn.addEventListener("click", () => setAutonomy(btn.dataset.mode)),
  );

  // Saved prompts for the "/" menu — load now and keep in sync.
  loadPrompts();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE_KEY]) {
      loadPrompts();
      refreshConfigured();
    }
  });

  els.composer.addEventListener("submit", onSubmit);
  els.input.addEventListener("keydown", onInputKeydown);
  els.input.addEventListener("input", () => {
    autoGrow();
    updateSlashMenu();
  });
  els.input.addEventListener("blur", () => setTimeout(hideSlashMenu, 150));
  els.stop.addEventListener("click", () => send({ type: MSG.STOP_TASK }));
  els.newChat.addEventListener("click", newChat);
  els.settings.addEventListener("click", () => chrome.runtime.openOptionsPage());
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
  if (state.seed) {
    els.input.value = state.seed;
    autoGrow();
  }
  if (state.running) setRunning(true);
}

function updateConfiguredUI(isConfigured) {
  configured = isConfigured;
  els.notConfigured.hidden = isConfigured;
  const examples = document.querySelector(".examples");
  if (examples) examples.hidden = !isConfigured;
  els.input.placeholder = isConfigured
    ? "Ask about or act on this page…  ( / for saved prompts )"
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
}

// Reflect the active approval mode in the segmented control.
function setAutonomyUI(mode) {
  els.autonomy
    .querySelectorAll(".seg")
    .forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
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

async function refreshContextHint() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab && tab.url && /^https?:/i.test(tab.url)) {
      els.contextHint.textContent = "On: " + new URL(tab.url).hostname;
    } else {
      els.contextHint.textContent = "";
    }
  } catch {
    /* ignore */
  }
}

function onSubmit(e) {
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
  // The user bubble is rendered from the worker's `user_echo` event so that
  // runs triggered by anything (composer, context menu) show consistently.
  els.input.value = "";
  autoGrow();
  refreshContextHint();
  send({ type: MSG.RUN_TASK, task: text, newChat: newChatPending });
  newChatPending = false;
  setRunning(true);
}

function newChat() {
  if (running) send({ type: MSG.STOP_TASK });
  els.messages.querySelectorAll(".msg, .tool-event, .perm-card, .thinking").forEach((n) => n.remove());
  els.empty.hidden = false;
  newChatPending = true;
  current = null;
  pendingTools = [];
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
      addNote(`🔌 Connected to MCP server “${ev.server}” (${ev.count} tool${ev.count === 1 ? "" : "s"})`);
      break;
    case "warning":
      addWarning(ev.text);
      break;
    case "error":
      addError(ev.error);
      setRunning(false);
      break;
    case "aborted":
      addNote("⏹ Stopped.");
      setRunning(false);
      break;
    case "done":
      break;
    case "idle":
      setRunning(false);
      break;
  }
}

function setRunning(v) {
  running = v;
  els.send.disabled = v;
  els.stop.hidden = !v;
  els.send.hidden = v;
  if (v) setStatus("Working…");
  else clearStatus();
}

// -------------------------------------------------------------------------
// Rendering
// -------------------------------------------------------------------------
function addUserMessage(text) {
  const el = document.createElement("div");
  el.className = "msg user";
  el.textContent = text;
  els.messages.appendChild(el);
  scroll();
}

function startAssistant() {
  const el = document.createElement("div");
  el.className = "msg assistant";
  el.innerHTML = '<span class="thinking"><span class="dot-pulse"></span>Thinking…</span>';
  els.messages.appendChild(el);
  current = { el, raw: "", started: false };
  scroll();
}

function appendAssistant(text) {
  if (!current) startAssistant();
  if (!current.started) {
    current.el.innerHTML = "";
    current.started = true;
  }
  current.raw += text;
  current.el.innerHTML = renderMarkdown(current.raw);
  scroll();
}

function endAssistant(content) {
  if (!current) return;
  if (!current.started) {
    if (content && content.trim()) {
      current.el.innerHTML = renderMarkdown(content);
    } else {
      current.el.remove(); // pure tool-call turn with no visible text
    }
  }
  current = null;
  scroll();
}

function addToolStart(name, args) {
  const el = document.createElement("div");
  el.className = "tool-event";
  el.innerHTML = `<span class="tool-name">${escapeHtml(name)}</span><span class="tool-detail">${escapeHtml(argHint(name, args))} · running…</span>`;
  els.messages.appendChild(el);
  pendingTools.push({ name, el });
  scroll();
}

function addToolEnd(name, ok, summary) {
  const pending = pendingTools.shift();
  const el = pending ? pending.el : document.createElement("div");
  if (!pending) {
    el.className = "tool-event";
    els.messages.appendChild(el);
  }
  el.classList.toggle("err", !ok);
  const icon = ok ? "✓" : "✕";
  el.innerHTML = `<span>${icon}</span><span class="tool-name">${escapeHtml(name)}</span><span class="tool-detail">${escapeHtml(summary || "")}</span>`;
  scroll();
}

function addFinish(summary) {
  const el = document.createElement("div");
  el.className = "msg assistant";
  el.innerHTML = renderMarkdown(summary);
  els.messages.appendChild(el);
  scroll();
}

function addError(text) {
  const el = document.createElement("div");
  el.className = "tool-event err";
  el.innerHTML = `<span>⚠</span><span>${escapeHtml(text)}</span>`;
  els.messages.appendChild(el);
  scroll();
}

function addWarning(text) {
  const el = document.createElement("div");
  el.className = "tool-event warn";
  el.innerHTML = `<span>🛡️</span><span>${escapeHtml(text)}</span>`;
  els.messages.appendChild(el);
  scroll();
}

function addNote(text) {
  const el = document.createElement("div");
  el.className = "tool-event";
  el.textContent = text;
  els.messages.appendChild(el);
  scroll();
}

function showPlan(req) {
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
      el.querySelector(".perm-buttons").outerHTML = `<p style="margin:0;font-size:12px;color:var(--muted)">${approved ? "Approved." : "Declined."}</p>`;
    }),
  );
  els.messages.appendChild(el);
  scroll();
}

function showPermission(req) {
  const el = document.createElement("div");
  el.className = "perm-card" + (req.sensitive ? " sensitive" : "");
  const action = describeAction(req.toolName, req.args);
  el.innerHTML = `
    <h3>${req.sensitive ? "⚠ Sensitive site" : "Allow action?"}</h3>
    <p>OpenSidekick wants to <strong>${escapeHtml(action)}</strong> on
       <span class="origin">${escapeHtml(req.origin)}</span>.</p>
    <div class="perm-buttons">
      <button class="primary" data-choice="once">Allow once</button>
      ${req.sensitive ? "" : '<button data-choice="always">Always allow this site</button>'}
      <button class="danger" data-choice="decline">Decline</button>
    </div>`;
  el.querySelectorAll("button").forEach((btn) =>
    btn.addEventListener("click", () => {
      el.querySelectorAll("button").forEach((b) => (b.disabled = true));
      const choice = btn.dataset.choice;
      send({ type: MSG.PERMISSION_RESPONSE, id: req.id, choice });
      el.querySelector(".perm-buttons").outerHTML =
        `<p style="margin:0;font-size:12px;color:var(--muted)">${choice === "decline" ? "Declined." : "Allowed."}</p>`;
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
    case "scroll":
      return "scroll the page";
    default:
      return name;
  }
}

function argHint(name, args) {
  if (!args) return "";
  if (name === "navigate") return args.url || "";
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
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    onSubmit(e);
  }
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
  const res = await send({ type: MSG.START_RECORDING });
  if (!res || res.ok === false) return addError((res && res.error) || "Couldn't start recording.");
  recording = true;
  recCount = 0;
  els.recordBtn.classList.add("recording");
  els.empty.hidden = true;
  hideWorkflowsMenu();
  updateRecBanner();
}

async function stopRec() {
  const res = await send({ type: MSG.STOP_RECORDING });
  recording = false;
  recCount = 0;
  els.recordBtn.classList.remove("recording");
  els.recBanner.hidden = true;
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
  const el = document.createElement("div");
  el.className = "perm-card";
  const list = steps.map((s) => `<li>${escapeHtml(s.description || String(s))}</li>`).join("");
  el.innerHTML = `
    <h3>Save this workflow?</h3>
    <ol class="plan-steps">${list}</ol>
    <input id="wf-name" placeholder="Name (e.g. Book a meeting room)" style="width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font:inherit;margin-bottom:8px" />
    <div class="perm-buttons"><button class="primary" data-save="1">Save</button><button data-save="0">Discard</button></div>`;
  el.querySelectorAll("button").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (btn.dataset.save === "1") {
        const name = (el.querySelector("#wf-name").value || "").trim() || "Untitled workflow";
        await saveWorkflow({ id: crypto.randomUUID(), name, startUrl, steps });
        el.querySelector(".perm-buttons").outerHTML = `<p style="margin:0;font-size:12px;color:var(--good, #157a4d)">Saved “${escapeHtml(name)}”. Replay it from the ▤ menu.</p>`;
      } else {
        el.remove();
      }
    }),
  );
  els.messages.appendChild(el);
  scroll();
}

function toggleWorkflowsMenu() {
  if (!els.wfMenu.hidden) return hideWorkflowsMenu();
  loadWorkflows().then(renderWorkflowsMenu);
  document.addEventListener("mousedown", wfOutside, true);
}

function wfOutside(e) {
  if (els.wfMenu.contains(e.target) || e.target === els.workflowsBtn) return;
  hideWorkflowsMenu();
}

function renderWorkflowsMenu(wfs) {
  if (!wfs.length) {
    els.wfMenu.innerHTML = `<div class="wf-empty">No saved workflows yet. Click ⏺ to record one.</div>`;
  } else {
    els.wfMenu.innerHTML = wfs
      .map((w, i) => `<div class="wf-item" data-i="${i}"><span class="wf-name">▶ ${escapeHtml(w.name)}</span><span class="wf-count">${(w.steps || []).length} steps</span></div>`)
      .join("");
    els.wfMenu.querySelectorAll(".wf-item").forEach((el) =>
      el.addEventListener("click", () => replayWorkflow(wfs[Number(el.dataset.i)])),
    );
  }
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
  addNote(`▶ Replaying workflow “${wf.name}”`);
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

function autoGrow() {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 160) + "px";
}

function scroll() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

function send(msg) {
  return chrome.runtime.sendMessage(msg).catch(() => null);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Minimal, safe Markdown: escape first, then apply a small subset. Because we
// escape before applying, model output can never inject raw HTML.
function renderMarkdown(src) {
  let t = escapeHtml(src);
  // fenced code blocks
  t = t.replace(/```([\s\S]*?)```/g, (_m, code) => `<pre><code>${code.replace(/^\n/, "")}</code></pre>`);
  // inline code
  t = t.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  // bold / italic
  t = t.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  // links [text](url)
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // bullet lists
  t = t.replace(/(?:^|\n)((?:\s*[-*] .+(?:\n|$))+)/g, (m, block) => {
    const items = block
      .trim()
      .split("\n")
      .map((l) => "<li>" + l.replace(/^\s*[-*]\s+/, "") + "</li>")
      .join("");
    return "\n<ul>" + items + "</ul>";
  });
  // paragraphs / line breaks (leave block elements alone)
  t = t
    .split(/\n{2,}/)
    .map((chunk) => (/^\s*<(ul|pre|h\d)/.test(chunk) ? chunk : "<p>" + chunk.replace(/\n/g, "<br>") + "</p>"))
    .join("");
  return t;
}
