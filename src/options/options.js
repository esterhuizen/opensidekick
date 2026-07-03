// Options page: manage providers, model selection, behavior, and site rules.

import { PROVIDER_PRESETS, DEFAULT_SETTINGS } from "../common/constants.js";
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
  wireSettings();
  renderProviders();
  renderSettings();
  renderPermissions();
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
