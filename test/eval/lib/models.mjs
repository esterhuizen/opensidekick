// Which models can run (design §11): CLI provider names mapped onto the
// extension's own PROVIDER_PRESETS, key env names, "default"/"budget" aliases,
// and a live model-id check made by Node (never through the browser).

import { PROVIDER_PRESETS } from "../../../src/common/constants.js";
import { ROUTES } from "./proxy.mjs";

export const PROVIDERS = {
  anthropic: { preset: "anthropic", route: "anthropic" },
  gemini: { preset: "google", route: "google" },
  openrouter: { preset: "openrouter", route: "openrouter" },
  "fake-openai": { route: "fake-openai", fake: true, name: "Fake model (OpenAI-compatible)" },
  "fake-anthropic": { route: "fake-anthropic", fake: true, name: "Fake model (Anthropic)" },
};

export function resolveAlias(provider, model) {
  const p = PROVIDERS[provider];
  const preset = PROVIDER_PRESETS.find((x) => x.id === p.preset);
  if (!preset) return model;
  if (model === "default") return preset.defaultModel;
  if (model === "budget") return (preset.suggestions.find((s) => s.kind === "budget") || preset.suggestions[0] || {}).model || preset.defaultModel;
  return model;
}

/** Parse "provider:model" specs into runnable model entries (no network). */
export function parseModels(specs) {
  return specs.map((spec) => {
    const i = spec.indexOf(":");
    if (i < 1) throw new Error(`--models wants provider:model, got "${spec}"`);
    const provider = spec.slice(0, i);
    const requested = spec.slice(i + 1);
    const p = PROVIDERS[provider];
    if (!p) throw new Error(`unknown provider "${provider}" (one of ${Object.keys(PROVIDERS).join(", ")})`);
    const preset = PROVIDER_PRESETS.find((x) => x.id === p.preset);
    const route = ROUTES[p.route];
    const model = p.fake ? requested : resolveAlias(provider, requested);
    return {
      spec: `${provider}:${model}`,
      provider,
      requested,
      model,
      route: p.route,
      type: route.type,
      name: preset ? preset.name : p.name,
      keyEnv: route.env,
      fake: !!p.fake,
    };
  });
}

// Live check that a model id exists. Returns { ok, ids?, reason? }.
export async function validateModel(m) {
  const key = process.env[m.keyEnv] || "";
  let ids = [];
  try {
    if (m.provider === "anthropic") {
      const r = await fetch("https://api.anthropic.com/v1/models?limit=1000", { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } });
      if (!r.ok) return { ok: false, reason: `model list failed (HTTP ${r.status})` };
      ids = ((await r.json()).data || []).map((d) => d.id);
    } else if (m.provider === "gemini") {
      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/models", { headers: { authorization: `Bearer ${key}` } });
      if (!r.ok) return { ok: false, reason: `model list failed (HTTP ${r.status})` };
      ids = ((await r.json()).data || []).map((d) => String(d.id).replace(/^models\//, ""));
    } else if (m.provider === "openrouter") {
      const r = await fetch("https://openrouter.ai/api/v1/models");
      if (!r.ok) return { ok: false, reason: `model list failed (HTTP ${r.status})` };
      const data = (await r.json()).data || [];
      const hit = data.find((d) => d.id === m.model);
      if (hit && !(hit.supported_parameters || []).includes("tools")) return { ok: false, reason: `${m.model} doesn't support tool calling on OpenRouter` };
      ids = data.map((d) => d.id);
    } else return { ok: true };
  } catch (e) {
    return { ok: false, reason: `model list failed (${e.code || e.message})` };
  }
  if (ids.includes(m.model)) return { ok: true };
  const common = (a, b) => {
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    return i;
  };
  const close = [...ids].sort((a, b) => common(b, m.model) - common(a, m.model)).slice(0, 5);
  return { ok: false, reason: `unknown model id "${m.model}"`, ids: close };
}
