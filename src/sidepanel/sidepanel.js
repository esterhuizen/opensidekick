// Side panel UI controller. Talks to the service worker via runtime messages
// and renders the streaming agent transcript.

import { MSG } from "../common/constants.js";

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
};

let running = false;
let newChatPending = true; // first send starts a fresh conversation
let current = null; // { el, raw } assistant bubble being streamed
let pendingTools = []; // tool-event elements awaiting completion

init();

async function init() {
  const state = await send({ type: MSG.GET_STATE });
  if (state) applyState(state);
  refreshContextHint();

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === MSG.AGENT_EVENT) handleEvent(msg);
    else if (msg.type === MSG.PERMISSION_REQUEST) showPermission(msg);
    else if (msg.type === MSG.PLAN_REQUEST) showPlan(msg);
  });

  els.composer.addEventListener("submit", onSubmit);
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSubmit(e);
    }
  });
  els.input.addEventListener("input", autoGrow);
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
  if (!state.configured) {
    els.notConfigured.hidden = false;
    els.send.disabled = false; // allow send; worker will surface a clear error
  }
  if (state.seed) {
    els.input.value = state.seed;
    autoGrow();
  }
  if (state.running) setRunning(true);
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
    case "warning":
      addWarning(ev.text);
      break;
    case "error":
      addError(ev.error);
      break;
    case "aborted":
      addNote("⏹ Stopped.");
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
