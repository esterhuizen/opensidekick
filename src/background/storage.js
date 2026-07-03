// Thin wrapper over chrome.storage.local for the OpenSidekick config object.
// All secrets (API keys) live here, in the extension's local storage only —
// they are never sent anywhere except directly to the provider endpoint the
// user configured.

import { STORAGE_KEY, DEFAULT_CONFIG, DEFAULT_SETTINGS } from "../common/constants.js";

export async function loadConfig() {
  const raw = await chrome.storage.local.get(STORAGE_KEY);
  const stored = raw[STORAGE_KEY];
  if (!stored) return structuredClone(DEFAULT_CONFIG);
  // Merge to tolerate configs written by older versions.
  return {
    ...structuredClone(DEFAULT_CONFIG),
    ...stored,
    settings: { ...DEFAULT_SETTINGS, ...(stored.settings || {}) },
    sitePermissions: { ...(stored.sitePermissions || {}) },
    providers: Array.isArray(stored.providers) ? stored.providers : [],
    prompts: Array.isArray(stored.prompts) ? stored.prompts : [],
    scheduledTasks: Array.isArray(stored.scheduledTasks) ? stored.scheduledTasks : [],
    workflows: Array.isArray(stored.workflows) ? stored.workflows : [],
    mcpServers: Array.isArray(stored.mcpServers) ? stored.mcpServers : [],
  };
}

export async function saveConfig(config) {
  await chrome.storage.local.set({ [STORAGE_KEY]: config });
  return config;
}

export async function getActiveProvider() {
  const config = await loadConfig();
  const provider = config.providers.find((p) => p.id === config.activeProviderId) || null;
  return { config, provider };
}

export async function setSitePermission(origin, value) {
  const config = await loadConfig();
  if (value === null) {
    delete config.sitePermissions[origin];
  } else {
    config.sitePermissions[origin] = value;
  }
  await saveConfig(config);
  return config;
}
