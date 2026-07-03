// Options page: manage providers, model selection, behavior, and site rules.

import { PROVIDER_PRESETS, DEFAULT_SETTINGS, MSG } from "../common/constants.js";
import { loadConfig, saveConfig } from "../background/storage.js";
import { listModels } from "../background/providers.js";

let config;

const $ = (sel) => document.querySelector(sel);
const presetSelect = $("#preset-select");
const providerList = $("#provider-list");
const noProviders = $("#no-providers");
const permList = $("#perm-list");
const noPerms = $("#no-perms");
const toast = $("#toast");

init();

async function init() {
  config = await loadConfig();

  for (const p of PROVIDER_PRESETS) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    presetSelect.appendChild(opt);
  }

  $("#add-provider").addEventListener("click", addProviderFromPreset);
  $("#add-prompt").addEventListener("click", addPrompt);
  $("#add-sched").addEventListener("click", addSched);
  wireSettings();
  renderProviders();
  renderSettings();
  renderPermissions();
  renderPrompts();
  renderScheduled();
}

// -------------------------------------------------------------------------
// Providers
// -------------------------------------------------------------------------
function addProviderFromPreset() {
  const presetId = presetSelect.value;
  if (!presetId) return;
  const preset = PROVIDER_PRESETS.find((p) => p.id === presetId);
  const provider = {
    id: crypto.randomUUID(),
    name: preset.name,
    type: preset.type,
    baseUrl: preset.baseUrl,
    apiKey: "",
    model: preset.defaultModel || "",
    keyUrl: preset.keyUrl || "",
    models: [],
  };
  config.providers.push(provider);
  // Make it active if it's the first one.
  if (!config.activeProviderId) {
    config.activeProviderId = provider.id;
    config.activeModel = provider.model;
  }
  presetSelect.value = "";
  persist();
  renderProviders();
}

function renderProviders() {
  providerList.innerHTML = "";
  noProviders.hidden = config.providers.length > 0;

  const tpl = $("#provider-template");
  for (const provider of config.providers) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = provider.id;
    const active = config.activeProviderId === provider.id;
    node.classList.toggle("active", active);

    node.querySelector(".pname").textContent = provider.name;
    node.querySelector(".type-badge").textContent = provider.type;
    const radio = node.querySelector('input[name="active-provider"]');
    radio.checked = active;
    radio.addEventListener("change", () => setActive(provider.id));

    const baseUrl = node.querySelector(".base-url");
    baseUrl.value = provider.baseUrl;
    baseUrl.addEventListener("change", () => {
      provider.baseUrl = baseUrl.value.trim();
      persist();
    });

    const keyInput = node.querySelector(".api-key");
    keyInput.value = provider.apiKey || "";
    keyInput.addEventListener("change", () => {
      provider.apiKey = keyInput.value.trim();
      persist();
    });
    const keyLink = node.querySelector(".key-link");
    if (provider.keyUrl) {
      keyLink.href = provider.keyUrl;
      keyLink.hidden = false;
    }

    const modelInput = node.querySelector(".model");
    const datalist = node.querySelector("datalist");
    const listId = "models-" + provider.id;
    datalist.id = listId;
    modelInput.setAttribute("list", listId);
    modelInput.value = provider.model || "";
    fillDatalist(datalist, provider.models);
    modelInput.addEventListener("change", () => {
      provider.model = modelInput.value.trim();
      if (config.activeProviderId === provider.id) config.activeModel = provider.model;
      persist();
    });

    const fetchBtn = node.querySelector(".fetch-models");
    const fetchStatus = node.querySelector(".fetch-status");
    fetchBtn.addEventListener("click", () => fetchModels(provider, fetchBtn, fetchStatus, datalist));

    node.querySelector(".delete-provider").addEventListener("click", () => removeProvider(provider.id));

    providerList.appendChild(node);
  }
}

function setActive(id) {
  config.activeProviderId = id;
  const provider = config.providers.find((p) => p.id === id);
  if (provider) config.activeModel = provider.model;
  persist();
  renderProviders();
}

function removeProvider(id) {
  config.providers = config.providers.filter((p) => p.id !== id);
  if (config.activeProviderId === id) {
    config.activeProviderId = config.providers[0]?.id || null;
    config.activeModel = config.providers[0]?.model || null;
  }
  persist();
  renderProviders();
}

async function fetchModels(provider, btn, status, datalist) {
  btn.disabled = true;
  status.textContent = "Fetching…";
  status.style.color = "var(--muted)";
  try {
    const models = await listModels(provider);
    provider.models = models;
    fillDatalist(datalist, models);
    persist();
    status.textContent = `Found ${models.length} models. Start typing to filter.`;
  } catch (e) {
    status.textContent = "Could not fetch models: " + (e.message || e);
    status.style.color = "var(--danger)";
  } finally {
    btn.disabled = false;
  }
}

function fillDatalist(datalist, models) {
  datalist.innerHTML = "";
  for (const m of models || []) {
    const opt = document.createElement("option");
    opt.value = m;
    datalist.appendChild(opt);
  }
}

// -------------------------------------------------------------------------
// Settings
// -------------------------------------------------------------------------
function wireSettings() {
  document.querySelectorAll('input[name="autonomy"]').forEach((r) =>
    r.addEventListener("change", () => {
      config.settings.autonomy = r.value;
      persist();
    }),
  );
  $("#max-steps").addEventListener("change", (e) => {
    config.settings.maxSteps = clampInt(e.target.value, 1, 100, DEFAULT_SETTINGS.maxSteps);
    persist();
  });
  $("#max-tokens").addEventListener("change", (e) => {
    config.settings.maxTokens = clampInt(e.target.value, 256, 128000, DEFAULT_SETTINGS.maxTokens);
    persist();
  });
  const temp = $("#temperature");
  temp.addEventListener("input", () => {
    $("#temp-value").textContent = Number(temp.value).toFixed(2);
  });
  temp.addEventListener("change", () => {
    config.settings.temperature = Number(temp.value);
    persist();
  });
  $("#enable-vision").addEventListener("change", (e) => {
    config.settings.enableVision = e.target.checked;
    persist();
  });
  $("#enable-js").addEventListener("change", (e) => {
    config.settings.enableJsTool = e.target.checked;
    persist();
  });
  $("#enable-cdp").addEventListener("change", (e) => {
    config.settings.enableCdp = e.target.checked;
    persist();
  });
}

function renderSettings() {
  const s = config.settings;
  const radio = document.querySelector(`input[name="autonomy"][value="${s.autonomy}"]`);
  if (radio) radio.checked = true;
  $("#max-steps").value = s.maxSteps;
  $("#max-tokens").value = s.maxTokens;
  $("#temperature").value = s.temperature;
  $("#temp-value").textContent = Number(s.temperature).toFixed(2);
  $("#enable-vision").checked = !!s.enableVision;
  $("#enable-js").checked = !!s.enableJsTool;
  $("#enable-cdp").checked = !!s.enableCdp;
}

// -------------------------------------------------------------------------
// Site permissions
// -------------------------------------------------------------------------
function renderPermissions() {
  const entries = Object.entries(config.sitePermissions || {});
  permList.innerHTML = "";
  noPerms.hidden = entries.length > 0;
  for (const [origin, state] of entries) {
    const row = document.createElement("div");
    row.className = "perm-item";
    row.innerHTML = `
      <span class="origin">${escapeHtml(origin)}</span>
      <span class="perm-state ${state}">${state === "allow" ? "allowed" : "blocked"}</span>
      <button class="link-btn">Remove</button>`;
    row.querySelector("button").addEventListener("click", () => {
      delete config.sitePermissions[origin];
      persist();
      renderPermissions();
    });
    permList.appendChild(row);
  }
}

// -------------------------------------------------------------------------
// Saved prompts
// -------------------------------------------------------------------------
function renderPrompts() {
  const list = $("#prompt-list");
  list.innerHTML = "";
  $("#no-prompts").hidden = (config.prompts || []).length > 0;
  for (const p of config.prompts) {
    const row = document.createElement("div");
    row.className = "prompt-item";
    row.innerHTML = `
      <div class="prompt-head">
        <span class="prompt-cmd-prefix">/</span>
        <input class="prompt-cmd" placeholder="command" />
        <button class="link-btn">Remove</button>
      </div>
      <textarea class="prompt-body" placeholder="The prompt text this command inserts…"></textarea>`;
    const cmd = row.querySelector(".prompt-cmd");
    const body = row.querySelector(".prompt-body");
    cmd.value = p.command || "";
    body.value = p.text || "";
    cmd.addEventListener("change", () => {
      p.command = cmd.value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
      cmd.value = p.command;
      persist();
    });
    body.addEventListener("change", () => {
      p.text = body.value;
      persist();
    });
    row.querySelector(".link-btn").addEventListener("click", () => {
      config.prompts = config.prompts.filter((x) => x.id !== p.id);
      persist();
      renderPrompts();
    });
    list.appendChild(row);
  }
}

function addPrompt() {
  config.prompts = config.prompts || [];
  config.prompts.push({ id: crypto.randomUUID(), command: "", text: "" });
  persist();
  renderPrompts();
}

// -------------------------------------------------------------------------
// Scheduled tasks
// -------------------------------------------------------------------------
function renderScheduled() {
  const list = $("#sched-list");
  list.innerHTML = "";
  $("#no-sched").hidden = (config.scheduledTasks || []).length > 0;
  for (const t of config.scheduledTasks) {
    const row = document.createElement("div");
    row.className = "sched-item";
    row.innerHTML = `
      <div class="field"><label>Name</label><input class="s-name" placeholder="e.g. Morning news digest" /></div>
      <div class="field"><label>Prompt</label><textarea class="s-prompt" placeholder="What should it do each time?"></textarea></div>
      <div class="field"><label>Start URL (optional)</label><input class="s-url" placeholder="leave blank to use the current tab" /></div>
      <div class="grid2">
        <div>
          <label>Run every … minutes</label>
          <input type="number" class="s-interval" min="1" />
          <div class="interval-hint">60 = hourly · 360 = every 6h · 1440 = daily · 10080 = weekly</div>
        </div>
        <div><label>&nbsp;</label><label class="enabled-label"><input type="checkbox" class="s-enabled" /> Enabled</label></div>
      </div>
      <div class="sched-actions">
        <button class="btn small s-run">Run now</button>
        <button class="link-btn s-del">Remove</button>
      </div>`;
    const q = (sel) => row.querySelector(sel);
    q(".s-name").value = t.name || "";
    q(".s-prompt").value = t.prompt || "";
    q(".s-url").value = t.url || "";
    q(".s-interval").value = t.intervalMinutes || 1440;
    q(".s-enabled").checked = !!t.enabled;
    q(".s-name").addEventListener("change", (e) => { t.name = e.target.value; persist(); });
    q(".s-prompt").addEventListener("change", (e) => { t.prompt = e.target.value; persist(); });
    q(".s-url").addEventListener("change", (e) => { t.url = e.target.value.trim(); persist(); });
    q(".s-interval").addEventListener("change", (e) => { t.intervalMinutes = clampInt(e.target.value, 1, 100000, 1440); persist(); });
    q(".s-enabled").addEventListener("change", (e) => { t.enabled = e.target.checked; persist(); });
    q(".s-run").addEventListener("click", () => runSchedNow(t, q(".s-run")));
    q(".s-del").addEventListener("click", () => {
      config.scheduledTasks = config.scheduledTasks.filter((x) => x.id !== t.id);
      persist();
      renderScheduled();
    });
    list.appendChild(row);
  }
}

function addSched() {
  config.scheduledTasks = config.scheduledTasks || [];
  config.scheduledTasks.push({ id: crypto.randomUUID(), name: "", prompt: "", url: "", intervalMinutes: 1440, enabled: false });
  persist();
  renderScheduled();
}

async function runSchedNow(task, btn) {
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = "Running…";
  try {
    await chrome.runtime.sendMessage({ type: MSG.RUN_SCHEDULED, id: task.id });
    btn.textContent = "Started ✓";
  } catch {
    btn.textContent = "Failed";
  }
  setTimeout(() => {
    btn.textContent = prev;
    btn.disabled = false;
  }, 2500);
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------
let toastTimer = null;
async function persist() {
  await saveConfig(config);
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), 1200);
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
