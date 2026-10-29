// Options page: manage providers, model selection, behavior, and site rules.

import {
  PROVIDER_PRESETS,
  DEFAULT_CONFIG,
  DEFAULT_SETTINGS,
  MSG,
  STORAGE_KEY,
  MODELS_PAGE_URL,
  SESSIONS_INDEX_KEY,
  PROMPT_HISTORY_KEY,
} from "../common/constants.js";
import { presetFor } from "../common/presets.js";
import { isLocalBaseUrl, thinkingVerdict, corsHint } from "../common/model-test-messages.js";
import { escapeHtml } from "../common/escape.js";
import { loadConfig, saveConfig, loadSessionIndex } from "../background/storage.js";
import { listModels, testModel } from "../background/providers.js";
import { connectServer, listTools } from "../background/mcp.js";
import {
  DEFAULT_DECISION_MODELS,
  OPENROUTER_DECISIONS_URL,
  TYPESAFE_DECISIONS_URL,
  isOpenRouterUrl,
  resolveSource,
  testDecisions,
} from "../background/decisions.js";
import { cdpAvailable } from "../background/cdp.js";
import { toolToggle, jsToolSupported, CDP_HINT, JS_HINT } from "../common/browser.js";

let config;

const $ = (sel) => document.querySelector(sel);
const presetSelect = $("#preset-select");
const providerList = $("#provider-list");
const noProviders = $("#no-providers");
const permList = $("#perm-list");
const noPerms = $("#no-perms");
const toast = $("#toast");

// One model test per provider card at a time, keyed by the card element so that
// renderProviders() can stop everything it is about to detach. Declared up here
// with the rest of the module state because renderProviders() and
// addProviderFromPreset() both reach for it.
const autoTests = new Map(); // card -> { timer, controller, runId, dots, fingerprint }
const AUTO_TEST_DEBOUNCE_MS = 700;
const DOT_INTERVAL_MS = 350;
const MAX_DOTS = 6;
const PROBE_LABELS = [["text", "Text"], ["tools", "Tools"], ["vision", "Vision"]];
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

// Extras (<details> cards) start closed so a fresh install reads as two short
// bands. One that already holds something opens itself — once, so re-rendering
// after an edit can't fight a user who just folded it away.
const autoOpened = new Set();

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
  $("#add-mcp").addEventListener("click", addMcp);
  wireSettings();
  wireDecisions();
  wireRail();
  renderAll();

  // This page holds `config` in memory and persist() writes the WHOLE object.
  // Other surfaces also write the config while this page is open — the side
  // panel saves workflows and switches autonomy, the agent grants per-site
  // permissions. Without reloading here, the next persist() would clobber those
  // with our stale snapshot (a saved workflow used to vanish this way). So on
  // any external write, re-read and re-render.
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === "local" && (changes[SESSIONS_INDEX_KEY] || changes[PROMPT_HISTORY_KEY])) renderHistoryCard();
    if (area !== "local" || !changes[STORAGE_KEY]) return;
    if (selfWrites > 0) {
      selfWrites--; // our own persist() — in-memory config is already current
      return;
    }
    config = await loadConfig();
    renderAll();
  });
}

// The rail marks the section the reader is actually looking at. The topmost
// visible section wins, so it can't flicker between two overlapping ones.
function wireRail() {
  const links = [...document.querySelectorAll(".rail a")];
  const ids = links.map((a) => a.getAttribute("href").slice(1));
  const sections = ids.map((id) => document.getElementById(id)).filter(Boolean);
  const visible = new Set();
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) visible.add(e.target.id);
        else visible.delete(e.target.id);
      }
      const active = sections.find((sec) => visible.has(sec.id));
      for (const a of links) a.classList.toggle("active", !!active && a.getAttribute("href") === "#" + active.id);
    },
    { rootMargin: "-84px 0px -55% 0px" },
  );
  for (const sec of sections) io.observe(sec);
}

function openExtra(id, hasContent) {
  const d = document.getElementById(id);
  if (!d || !hasContent || autoOpened.has(id)) return;
  autoOpened.add(id);
  d.open = true;
}

function renderAll() {
  renderProviders();
  renderSettings();
  renderPermissions();
  renderPrompts();
  renderScheduled();
  renderWorkflows();
  renderMcp();
  // renderProviders() ends with renderDecisions() — the smart-checks section
  // reads the provider list, so it is always rendered from there.
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
    presetId: preset.id,
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
  // A local provider with a pre-filled model can be probed right away; a hosted
  // one has nothing to probe with until its key is pasted.
  const card = providerList.querySelector(`.provider[data-id="${provider.id}"]`);
  if (card && provider.model && (provider.apiKey || isLocalBaseUrl(provider.baseUrl))) {
    scheduleAutoTest(provider, card, { immediate: true, firstRun: true });
  }
}

function renderProviders() {
  // Every card is thrown away here, so stop the pending debounce timers, dot
  // animations and in-flight probes first — an interval left behind would tick
  // against a detached node forever. A run that was still in flight is started
  // again on the rebuilt card below: an unrelated write from another surface
  // (the side panel saving a workflow) must not swallow the user's test.
  const wasTesting = [];
  for (const [card, state] of autoTests) {
    if (state.controller) wasTesting.push(card.dataset.id);
    stopTest(card);
  }
  autoTests.clear();
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
      // Whether this provider can lend its key to smart checks depends on the
      // URL and the key, so Smart checks has to be re-rendered here: persist()
      // suppresses the storage.onChanged re-render for our own writes.
      renderDecisions();
      // A verdict from the old endpoint says nothing about this one, so it is
      // either replaced by a fresh run or cleared.
      scheduleAutoTest(provider, node, { immediate: true });
    });

    const keyInput = node.querySelector(".api-key");
    keyInput.value = provider.apiKey || "";
    keyInput.addEventListener("change", () => {
      provider.apiKey = keyInput.value.trim();
      persist();
      renderDecisions();
      // The key was the only thing the probes were waiting for.
      if (node.querySelector(".model").value.trim()) scheduleAutoTest(provider, node, { immediate: true });
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
    renderSuggestions(node, provider);
    // Typing is debounced; committing a value (datalist pick, or a blur that
    // changed it) tests at once. Either way one pick is one run: the pending
    // timer is dropped, and a commit that repeats the configuration a run has
    // already started is skipped (see startModelTest).
    modelInput.addEventListener("input", () => scheduleAutoTest(provider, node));
    modelInput.addEventListener("change", () => {
      provider.model = modelInput.value.trim();
      if (config.activeProviderId === provider.id) config.activeModel = provider.model;
      persist();
      scheduleAutoTest(provider, node, { immediate: true });
    });

    const fetchBtn = node.querySelector(".fetch-models");
    const fetchStatus = node.querySelector(".fetch-status");
    // A fresh list changes which suggestions it is known to contain.
    fetchBtn.addEventListener("click", () =>
      fetchModels(provider, fetchBtn, fetchStatus, datalist).then(() => renderSuggestions(node, provider)),
    );

    const testBtn = node.querySelector(".test-model");
    testBtn.addEventListener("click", () => startModelTest(provider, node));

    node.querySelector(".delete-provider").addEventListener("click", () => removeProvider(provider.id));

    providerList.appendChild(node);
  }
  for (const id of wasTesting) {
    const provider = config.providers.find((p) => p.id === id);
    const card = providerList.querySelector(`.provider[data-id="${id}"]`);
    if (provider && card) scheduleAutoTest(provider, card, { immediate: true });
  }
  // The smart-checks key source points at one of these, by id.
  renderDecisions();
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
  status.style.color = "var(--os-muted)";
  try {
    const models = await listModels(provider);
    provider.models = models;
    fillDatalist(datalist, models);
    persist();
    status.textContent = `Found ${models.length} models. Start typing to filter.`;
  } catch (e) {
    const hint = corsHint(provider, e.status);
    status.textContent = hint
      ? `Could not fetch models. ${hint.text} See the README: Using a local model.`
      : "Could not fetch models: " + (e.message || e);
    status.style.color = "var(--os-bad-ink)";
  } finally {
    btn.disabled = false;
  }
}

function testState(card) {
  let state = autoTests.get(card);
  if (!state) {
    state = { timer: null, controller: null, runId: 0, dots: null, fingerprint: "" };
    autoTests.set(card, state);
  }
  return state;
}

function stopTest(card) {
  const state = autoTests.get(card);
  if (!state) return;
  clearTimeout(state.timer);
  clearInterval(state.dots);
  state.timer = null;
  state.dots = null;
  if (state.controller) state.controller.abort();
  state.controller = null;
  // An aborted run can still have a probe resolving in the same tick, and it
  // must not repaint over the status this just cleared — so its run id is
  // retired here, not only when a replacement run claims the next one.
  state.runId++;
  state.fingerprint = "";
}

// What an automatic run is "for": the same three inputs twice over is the same
// answer twice over, so the second run is dropped. Held in memory only — it
// carries the key and is never rendered or logged.
const testFingerprint = (provider, model) => JSON.stringify([model, provider.baseUrl || "", provider.apiKey || ""]);

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

// A status line is only ever shown with something in it.
function setStatus(statusEl, html) {
  statusEl.innerHTML = html;
  statusEl.hidden = false;
}

function clearStatus(statusEl) {
  statusEl.innerHTML = "";
  statusEl.hidden = true;
}

// Provider error bodies sometimes echo the key back (401s like to), and these
// lines now appear without anyone pressing a button — so nothing key-shaped
// reaches the screen.
function redactKeys(detail, apiKey) {
  let s = String(detail ?? "");
  if (apiKey && apiKey.length >= 8) s = s.split(apiKey).join("[key]");
  return s.replace(/\b(?:sk|or|pk|gsk)-[A-Za-z0-9_-]{8,}/g, "[key]");
}

const isNetworkFail = (detail) => /failed to fetch|load failed|network ?error|connection refused|econnrefused/i.test(String(detail || ""));

// Picking a model is the moment the user wants to know whether it works, so the
// probes run then and there instead of waiting for a button. Base URL and key
// are read from the provider (both commit on blur, before the model is touched);
// the model comes from the input, which is still mid-edit.
function scheduleAutoTest(provider, card, { immediate = false, firstRun = false } = {}) {
  const statusEl = card.querySelector(".test-status");
  const model = card.querySelector(".model").value.trim();
  const state = testState(card);
  clearTimeout(state.timer);
  state.timer = null;

  if (!model) {
    stopTest(card);
    clearStatus(statusEl);
    return;
  }
  if (!provider.baseUrl) return; // the Test button is where that gets explained
  if (!provider.apiKey && !isLocalBaseUrl(provider.baseUrl)) {
    stopTest(card);
    setStatus(statusEl, `<span class="test-line muted">Add your API key and the test will run automatically.</span>`);
    return;
  }
  if (immediate) {
    startModelTest(provider, card, { auto: true, firstRun });
    return;
  }
  // Mid-typing, only a model id the provider actually lists is worth three live
  // requests: a pause longer than the debounce after "gpt-" would otherwise
  // probe a model that doesn't exist. Anything else waits for the commit.
  if (!(provider.models || []).includes(model)) {
    // Whatever verdict is on screen was for a different model id, and the field
    // no longer says that — drop it rather than let it describe the new one.
    if (!state.controller && state.fingerprint && state.fingerprint !== testFingerprint(provider, model)) {
      state.fingerprint = "";
      clearStatus(statusEl);
    }
    return;
  }
  state.timer = setTimeout(() => startModelTest(provider, card, { auto: true }), AUTO_TEST_DEBOUNCE_MS);
}

// The one entry point for both the Test button and the automatic runs: cancels
// whatever that card was doing and claims the card's next run id.
function startModelTest(provider, card, { auto = false, firstRun = false } = {}) {
  const state = testState(card);
  const model = card.querySelector(".model").value.trim();
  const fingerprint = testFingerprint(provider, model);
  // Typing a model id and then blurring the field fires both the debounced
  // "input" run and the commit "change" run for one and the same model — the
  // second is the same three requests for the same answer, so it is dropped.
  // The Test button is the deliberate re-run and always goes through.
  if (auto && fingerprint === state.fingerprint) return;
  clearTimeout(state.timer);
  state.timer = null;
  if (state.controller) state.controller.abort();
  state.controller = new AbortController();
  state.fingerprint = fingerprint;
  return runModelTest(provider, card.querySelector(".model"), card.querySelector(".test-model"), card.querySelector(".test-status"), {
    auto,
    firstRun,
    signal: state.controller.signal,
    runId: ++state.runId,
  });
}

async function runModelTest(provider, modelInput, btn, statusEl, opts = {}) {
  const { auto = false, firstRun = false, signal, runId } = opts;
  const state = testState(statusEl.closest(".provider"));
  // A cancelled run can still have a probe in flight; everything it would
  // render or re-enable is dropped once the card has moved on.
  const current = () => runId === undefined || state.runId === runId;
  const model = (modelInput.value || provider.model || "").trim();
  if (!model) {
    if (!auto) setStatus(statusEl, `<span class="test-line fail">Enter a model id first.</span>`);
    return;
  }
  if (!provider.baseUrl) {
    if (!auto) setStatus(statusEl, `<span class="test-line fail">Set the provider's Base URL first.</span>`);
    return;
  }
  btn.disabled = true;

  const icon = { ok: "✓", warn: "⚠", fail: "✗" };
  const line = (label, res) =>
    `<span class="test-line ${res.status}">${icon[res.status]} <strong>${label}</strong> — ${escapeHtml(redactKeys(res.detail, provider.apiKey))}</span>`;
  // The model id stays on screen: an automatic run nobody started has to say
  // which model the ticks belong to — and, while it is running, where the key
  // is going, since no button was pressed to authorise that.
  const host = hostOf(provider.baseUrl);
  const nameLine = (verb, withHost) =>
    `<span class="test-line muted">${verb} <code>${escapeHtml(model)}</code>${withHost && host ? ` at ${escapeHtml(host)}` : ""}</span>`;
  let stage = "text";
  let dots = 1;
  let doneLines = [];
  let dotsEl = null;
  const dotText = () => (reducedMotion.matches ? "…" : ".".repeat(dots));
  // The block is rewritten only when a probe finishes; in between, the ticker
  // writes into the dot span alone, so the role="status" region isn't re-read
  // to a screen reader three times a second.
  const paint = () => {
    if (!current()) return;
    setStatus(
      statusEl,
      [
        nameLine("Testing", true),
        ...doneLines,
        `<span class="test-line muted test-progress">… testing ${stage} <span class="dots" aria-hidden="true">${dotText()}</span></span>`,
      ].join(""),
    );
    dotsEl = statusEl.querySelector(".test-progress .dots");
  };
  paint();
  clearInterval(state.dots);
  const ticker = setInterval(() => {
    if (!current()) return;
    dots = dots >= MAX_DOTS ? 1 : dots + 1;
    if (dotsEl) dotsEl.textContent = dotText(); // frozen at "…" under reduced motion
  }, DOT_INTERVAL_MS);
  state.dots = ticker;

  try {
    const r = await testModel({ ...provider, model }, model, {
      signal,
      onProgress: (s, results) => {
        if (s === "done" || !current()) return;
        stage = s;
        dots = 1;
        doneLines = PROBE_LABELS.filter(([key]) => results[key]).map(([key, label]) => line(label, results[key]));
        paint();
      },
    });
    if (!current() || r.aborted) return; // the next run has already taken over
    // A local server that isn't up yet is the overwhelmingly likely reason a
    // just-added preset can't be reached — say so instead of reporting the
    // model as incapable of calling tools.
    if (firstRun && r.text.status === "fail" && isNetworkFail(r.text.detail)) {
      setStatus(statusEl, `<span class="test-line warn">Couldn't reach ${escapeHtml(host)} — start your local server and press Test.</span>`);
      return;
    }
    // A local server that refuses the extension's origin fails every probe the
    // same way; the fix is a server setting, not a different model.
    const hint = r.text.status === "fail" ? corsHint(provider, r.text.httpStatus) : null;
    if (hint) {
      setStatus(
        statusEl,
        [
          nameLine("Tested", false),
          line("Text", r.text),
          `<span class="test-line fail">${escapeHtml(hint.text)} <a href="${escapeHtml(hint.readmeUrl)}" target="_blank" rel="noopener">How to allow it (README)</a></span>`,
        ].join(""),
      );
      return;
    }
    let verdict = "";
    if (r.tools.status === "ok" && (r.vision.status === "ok" || r.vision.status === "warn")) {
      verdict = `<span class="test-line ok">This model can drive OpenSidekick.${r.vision.status === "ok" ? " Vision works too." : ""}</span>`;
    } else if (r.tools.thinking) {
      verdict = `<span class="test-line fail">${escapeHtml(thinkingVerdict(provider, model))}</span>`;
    } else if (r.tools.status !== "ok") {
      verdict = `<span class="test-line fail">Tools didn't work — the agent can't act with this model. Pick a tool-capable one.</span>`;
    } else if (r.vision.status === "fail") {
      verdict = `<span class="test-line warn">Tools work, but this model can't see images. Fine for text tasks; turn off Vision or pick a multimodal model for image work.</span>`;
    }
    setStatus(statusEl, [nameLine("Tested", false), line("Text", r.text), line("Tools", r.tools), line("Vision", r.vision), verdict].join(""));
  } catch (e) {
    if (current()) setStatus(statusEl, `<span class="test-line fail">Test failed: ${escapeHtml(redactKeys(e.message || e, provider.apiKey))}</span>`);
  } finally {
    clearInterval(ticker);
    if (state.dots === ticker) state.dots = null;
    if (current()) {
      btn.disabled = false;
      if (state.controller && state.controller.signal === signal) state.controller = null;
    }
  }
}

// The preset's suggested models as one-click chips under the Model field. A
// chip is a datalist pick by other means: it fires the same input + change pair
// on the model field, so it persists and auto-tests through the same handlers
// (and the same one-run dedupe) as picking from the list.
function renderSuggestions(card, provider) {
  const row = card.querySelector(".suggest-row");
  const chips = row.querySelector(".suggest-chips");
  const suggestions = presetFor(provider)?.suggestions || [];
  chips.innerHTML = "";
  row.hidden = suggestions.length === 0;
  if (!suggestions.length) return;
  row.querySelector(".suggest-link").href = MODELS_PAGE_URL;
  // Only a list the provider actually returned can say a model is missing.
  const listed = provider.models || [];
  for (const s of suggestions) {
    const offList = listed.length > 0 && !listed.includes(s.model);
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip suggest-chip" + (offList ? " off-list" : "");
    chip.dataset.model = s.model;
    chip.title = `${s.model} · ${s.note}${offList ? " — not in the models this provider returned" : ""}`;
    chip.innerHTML = `<span>${escapeHtml(s.label)}</span><span class="kind-tag">${escapeHtml(s.kind)}</span>`;
    chip.addEventListener("click", () => {
      const input = card.querySelector(".model");
      input.value = s.model;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    chips.appendChild(chip);
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
  document.querySelectorAll('input[name="siteAccess"]').forEach((r) =>
    r.addEventListener("change", () => {
      config.settings.siteAccess = r.value;
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
  $("#keep-history").addEventListener("change", onKeepHistory);
  $("#clear-history").addEventListener("click", clearHistory);
}

function renderSettings() {
  const s = config.settings;
  const radio = document.querySelector(`input[name="autonomy"][value="${s.autonomy}"]`);
  if (radio) radio.checked = true;
  const saRadio = document.querySelector(`input[name="siteAccess"][value="${s.siteAccess || "all"}"]`);
  if (saRadio) saRadio.checked = true;
  $("#max-steps").value = s.maxSteps;
  $("#max-tokens").value = s.maxTokens;
  $("#temperature").value = s.temperature;
  $("#temp-value").textContent = Number(s.temperature).toFixed(2);
  $("#enable-vision").checked = !!s.enableVision;
  $("#enable-js").checked = !!s.enableJsTool;
  $("#enable-cdp").checked = !!s.enableCdp;
  renderCdpAvailability();
  renderJsAvailability();
  $("#keep-history").checked = s.keepHistory !== false;
  renderHistoryCard();
}

// Firefox has no chrome.debugger, so this toggle is a dead setting: the agent
// filter already drops the cdpOnly tools, and a box the user can turn on would
// promise a tool that can never run. enableVision is left alone because Firefox
// runs vision.
function renderCdpAvailability() {
  const t = toolToggle(cdpAvailable(), CDP_HINT);
  $("#enable-cdp").disabled = t.disabled;
  // options.html carries the row's own wording, so the hint is swapped only when
  // the row is dead: a browser that can run the tools keeps the hint it shipped
  // with, and the wording is the shared CDP_HINT from src/common/browser.js.
  if (t.hint) $("#cdp-hint").textContent = CDP_HINT;
}

// The run-JavaScript row is dead on Firefox: world: "MAIN" scripting works from 128,
// so this is AMO's remote-code policy on new Function over model output, not a
// missing API. The setting is kept as stored, and the row is not user-enableable —
// the agent filter drops the tool, so a box to turn it on would promise nothing.
function renderJsAvailability() {
  const t = toolToggle(jsToolSupported(chrome), JS_HINT);
  $("#enable-js").disabled = t.disabled;
  if (t.hint) $("#js-hint").textContent = JS_HINT;
}

// -------------------------------------------------------------------------
// Chat history. The worker owns every write: turning the switch off is just a
// config write (the worker deletes the data when it sees the flip), and Clear
// history is a message. This page only reads the counts.
// -------------------------------------------------------------------------
let historyRender = 0; // bumped per render so a slow read can't show stale counts

async function historyCounts() {
  let chats = 0;
  let prompts = 0;
  try {
    chats = (await loadSessionIndex()).items.length;
    const raw = await chrome.storage.local.get(PROMPT_HISTORY_KEY);
    if (Array.isArray(raw[PROMPT_HISTORY_KEY])) prompts = raw[PROMPT_HISTORY_KEY].length;
  } catch {
    /* storage unavailable — show nothing saved */
  }
  return { chats, prompts };
}

async function renderHistoryCard() {
  const run = ++historyRender;
  const { chats, prompts } = await historyCounts();
  if (run !== historyRender) return;
  const count = $("#history-count");
  const btn = $("#clear-history");
  if (config.settings.keepHistory === false) {
    count.textContent = "History is off. Nothing is saved.";
    btn.disabled = true;
  } else if (chats > 0) {
    count.textContent = `${chats} saved chat${chats === 1 ? "" : "s"} on this device.`;
    btn.disabled = false;
  } else {
    count.textContent = "No saved chats yet.";
    btn.disabled = !prompts;
  }
}

const plural = (n) => (n === 1 ? "" : "s");
const turnOffCopy = (n) =>
  `Turn off chat history?\n\nThis deletes ${n ? `the ${n} chat${plural(n)} saved on this device and ` : ""}your prompt history. It can't be undone. The chat that's open now stays until the browser closes.`;
const clearCopy = (n) =>
  `Delete all chat history?\n\nThis deletes ${n ? `the ${n} chat${plural(n)} saved on this device, ` : ""}your prompt history and the open chat. It can't be undone.`;

async function onKeepHistory(e) {
  if (e.target.checked) {
    config.settings.keepHistory = true;
    persist();
    renderHistoryCard();
    return;
  }
  const { chats, prompts } = await historyCounts();
  if (chats + prompts > 0 && !confirm(turnOffCopy(chats))) {
    e.target.checked = true;
    return;
  }
  config.settings.keepHistory = false;
  persist();
  renderHistoryCard();
}

async function clearHistory() {
  const status = $("#clear-history-status");
  status.textContent = "";
  const { chats } = await historyCounts();
  if (!confirm(clearCopy(chats))) return;
  const res = await chrome.runtime.sendMessage({ type: MSG.CLEAR_SESSIONS }).catch(() => null);
  status.textContent = res && res.ok
    ? "History cleared."
    : res && res.error === "busy"
      ? "A task is running. Try again when it finishes."
      : "Couldn't clear history. Try again.";
}

// -------------------------------------------------------------------------
// Smart checks (Jev decision model)
// -------------------------------------------------------------------------
const DECISION_FEATURES = [
  ["#dec-f-action", "action"],
  ["#dec-f-injection", "injection"],
  ["#dec-f-change", "changeOnly"],
];

// Older configs predate this block, and a half-written one would lose the
// feature switches — fill both in before reading or writing them.
function decisions() {
  if (!config.decisions) config.decisions = structuredClone(DEFAULT_CONFIG.decisions);
  if (!config.decisions.features) config.decisions.features = { ...DEFAULT_CONFIG.decisions.features };
  return config.decisions;
}

function wireDecisions() {
  $("#dec-enabled").addEventListener("change", (e) => {
    decisions().enabled = e.target.checked;
    persist();
    renderDecisions();
  });
  document.querySelectorAll('input[name="dec-source"]').forEach((r) =>
    r.addEventListener("change", () => {
      decisions().source = r.value;
      persist();
      renderDecisions();
    }),
  );
  $("#dec-provider").addEventListener("change", (e) => {
    decisions().providerId = e.target.value || null;
    persist();
    renderDecisions();
  });
  $("#dec-key").addEventListener("change", (e) => {
    decisions().apiKey = e.target.value.trim();
    persist();
    renderDecisions();
  });
  $("#dec-model").addEventListener("change", (e) => {
    decisions().model = e.target.value.trim();
    persist();
  });
  $("#dec-base-url").addEventListener("change", (e) => {
    decisions().baseUrl = e.target.value.trim();
    persist();
    renderDecisions(); // the "your key goes here" warning depends on this field
  });
  $("#dec-sensitivity").addEventListener("change", (e) => {
    decisions().sensitivity = e.target.value;
    persist();
  });
  for (const [sel, key] of DECISION_FEATURES) {
    $(sel).addEventListener("change", (e) => {
      decisions().features[key] = e.target.checked;
      persist();
    });
  }
  $("#dec-test").addEventListener("click", () => runDecisionTest($("#dec-test"), $("#dec-test-status")));
}

function renderDecisions() {
  const d = decisions();
  const source = d.source === "typesafe" ? "typesafe" : "openrouter";
  $("#dec-enabled").checked = !!d.enabled;
  openExtra("smart-checks", !!d.enabled);
  const sourceRadio = document.querySelector(`input[name="dec-source"][value="${source}"]`);
  if (sourceRadio) sourceRadio.checked = true;

  // Only a provider that really points at openrouter.ai can lend its key.
  const orProviders = (config.providers || []).filter((p) => isOpenRouterUrl(p.baseUrl));
  const select = $("#dec-provider");
  select.innerHTML = "";
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = orProviders.length ? "Pick a provider…" : "No OpenRouter providers";
  select.appendChild(blank);
  for (const p of orProviders) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name + (p.apiKey ? "" : " (no key yet)");
    select.appendChild(opt);
  }
  select.value = orProviders.some((p) => p.id === d.providerId) ? d.providerId : "";
  $("#dec-provider-field").hidden = source !== "openrouter";
  $("#dec-provider-hint").hidden = orProviders.length > 0;

  $("#dec-key-field").hidden = source !== "typesafe";
  $("#dec-key").value = d.apiKey || "";
  $("#dec-model").value = d.model || "";
  $("#dec-model").placeholder = DEFAULT_DECISION_MODELS[source];
  $("#dec-base-url").value = d.baseUrl || "";
  $("#dec-base-url").placeholder = source === "typesafe" ? TYPESAFE_DECISIONS_URL : OPENROUTER_DECISIONS_URL;
  // An override is the one way a key reaches a host we didn't check — name the
  // key that would travel so a "just paste this proxy URL" has to say it out loud.
  const baseUrlHint = $("#dec-base-url-hint");
  baseUrlHint.classList.toggle("warn", !!d.baseUrl);
  // …and say it out loud when the override is plain http: the key would travel
  // unencrypted, which is only ever reasonable for a local proxy.
  const plainHttp = /^http:\/\//i.test((d.baseUrl || "").trim());
  baseUrlHint.textContent = d.baseUrl
    ? (source === "typesafe"
        ? "Your TypeSafe key will be sent to this URL."
        : "Your OpenRouter provider's key will be sent to this URL.") +
      (plainHttp ? " This URL is plain http, so the key is not encrypted in transit." : "")
    : "Leave blank to use the standard endpoint for the key source above.";
  $("#dec-sensitivity").value = d.sensitivity || DEFAULT_CONFIG.decisions.sensitivity;

  // No usable key source = nothing to switch on.
  const resolvable = !!resolveSource(withDecisionsEnabled());
  for (const [sel, key] of DECISION_FEATURES) {
    const box = $(sel);
    box.checked = !!d.features[key];
    box.disabled = !resolvable;
  }
  $("#dec-features-hint").hidden = resolvable;
}

// The Test button and the "is a source usable?" check both ignore the master
// switch — you can verify a key before turning anything on.
function withDecisionsEnabled() {
  return { ...config, decisions: { ...decisions(), enabled: true } };
}

async function runDecisionTest(btn, statusEl) {
  const src = resolveSource(withDecisionsEnabled());
  statusEl.hidden = false;
  if (!src) {
    statusEl.innerHTML = `<span class="test-line fail">Pick a key source above and make sure its key is filled in.</span>`;
    return;
  }
  btn.disabled = true;
  statusEl.innerHTML = `<span class="test-line muted">Asking <code>${escapeHtml(src.model)}</code> two questions with known answers…</span>`;
  try {
    const r = await testDecisions(src);
    const icon = { ok: "✓", warn: "⚠", fail: "✗" };
    const line = (label, res) =>
      `<span class="test-line ${res.status}">${icon[res.status]} <strong>${label}</strong> — ${escapeHtml(res.detail)}</span>`;
    let verdict = "";
    if (r.auth.status !== "ok") {
      verdict = `<span class="test-line fail">No answer from the endpoint — every check would fall back to the built-in ones.</span>`;
    } else if (r.noul.status === "ok" && r.choice.status === "ok") {
      verdict = `<span class="test-line ${r.latencyMs.status === "ok" ? "ok" : "warn"}">Smart checks work with this key and model.${
        r.latencyMs.status === "ok" ? "" : " Latency is above the budget for checks before an action, so those may be slow."
      }</span>`;
    } else {
      verdict = `<span class="test-line warn">The endpoint answered, but not with the expected answers — check the model id.</span>`;
    }
    statusEl.innerHTML = [
      line("Auth", r.auth),
      line("Yes-no", r.noul),
      line("Choice", r.choice),
      line("Latency", r.latencyMs),
      verdict,
    ].join("");
  } catch (e) {
    statusEl.innerHTML = `<span class="test-line fail">Test failed: ${escapeHtml(String(e.message || e))}</span>`;
  } finally {
    btn.disabled = false;
  }
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
  openExtra("sec-prompts", (config.prompts || []).length > 0);
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
  openExtra("sec-sched", (config.scheduledTasks || []).length > 0);
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
        <button class="btn btn-ghost small s-run">Run now</button>
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
// Workflows
// -------------------------------------------------------------------------
function renderWorkflows() {
  const list = $("#wf-list");
  list.innerHTML = "";
  $("#no-wf").hidden = (config.workflows || []).length > 0;
  openExtra("sec-workflows", (config.workflows || []).length > 0);
  for (const w of config.workflows) {
    const row = document.createElement("div");
    row.className = "prompt-item";
    const steps = (w.steps || []).map((s) => `<li>${escapeHtml(s.description || String(s))}</li>`).join("");
    row.innerHTML = `
      <div class="prompt-head">
        <input class="prompt-cmd wf-name" placeholder="Workflow name" />
        <button class="link-btn">Remove</button>
      </div>
      ${w.startUrl ? `<div class="interval-hint">Starts at ${escapeHtml(w.startUrl)}</div>` : ""}
      <ol class="wf-steps">${steps}</ol>`;
    const nameInput = row.querySelector(".wf-name");
    nameInput.value = w.name || "";
    nameInput.addEventListener("change", () => {
      w.name = nameInput.value.trim() || "Untitled workflow";
      nameInput.value = w.name;
      persist();
    });
    row.querySelector(".link-btn").addEventListener("click", () => {
      config.workflows = config.workflows.filter((x) => x.id !== w.id);
      persist();
      renderWorkflows();
    });
    list.appendChild(row);
  }
}

// -------------------------------------------------------------------------
// MCP tool servers
// -------------------------------------------------------------------------
function renderMcp() {
  const list = $("#mcp-list");
  list.innerHTML = "";
  $("#no-mcp").hidden = (config.mcpServers || []).length > 0;
  openExtra("sec-mcp", (config.mcpServers || []).length > 0);
  for (const m of config.mcpServers) {
    const row = document.createElement("div");
    row.className = "sched-item";
    row.innerHTML = `
      <div class="field"><label>Name</label><input class="m-name" placeholder="e.g. github" /></div>
      <div class="field"><label>Server URL</label><input class="m-url" placeholder="https://…/mcp" /></div>
      <div class="field"><label>Auth token (optional)</label><input type="password" class="m-token" placeholder="Bearer token, if the server needs one" autocomplete="off" /></div>
      <div class="sched-actions">
        <label class="enabled-label"><input type="checkbox" class="m-enabled" /> Enabled</label>
        <button class="btn btn-ghost small m-test">Test</button>
        <button class="link-btn m-del">Remove</button>
      </div>
      <p class="interval-hint m-status"></p>`;
    const q = (sel) => row.querySelector(sel);
    q(".m-name").value = m.name || "";
    q(".m-url").value = m.url || "";
    q(".m-token").value = m.authToken || "";
    q(".m-enabled").checked = !!m.enabled;
    q(".m-name").addEventListener("change", (e) => { m.name = e.target.value.trim(); persist(); });
    q(".m-url").addEventListener("change", (e) => { m.url = e.target.value.trim(); persist(); });
    q(".m-token").addEventListener("change", (e) => { m.authToken = e.target.value.trim(); persist(); });
    q(".m-enabled").addEventListener("change", (e) => { m.enabled = e.target.checked; persist(); });
    q(".m-del").addEventListener("click", () => {
      config.mcpServers = config.mcpServers.filter((x) => x.id !== m.id);
      persist();
      renderMcp();
    });
    q(".m-test").addEventListener("click", () => testMcp(m, q(".m-status"), q(".m-test")));
    list.appendChild(row);
  }
}

function addMcp() {
  config.mcpServers = config.mcpServers || [];
  config.mcpServers.push({ id: crypto.randomUUID(), name: "", url: "", authToken: "", enabled: true });
  persist();
  renderMcp();
}

async function testMcp(server, statusEl, btn) {
  if (!server.url) {
    statusEl.textContent = "Enter a server URL first.";
    statusEl.style.color = "var(--os-bad-ink)";
    return;
  }
  btn.disabled = true;
  statusEl.style.color = "var(--os-muted)";
  statusEl.textContent = "Connecting…";
  try {
    const session = await connectServer(server);
    const tools = await listTools(server, session);
    const names = tools.map((t) => t.name).slice(0, 8).join(", ");
    statusEl.textContent = `Connected — ${tools.length} tool${tools.length === 1 ? "" : "s"}${names ? ": " + names : ""}.`;
    statusEl.style.color = "var(--os-good-ink)";
  } catch (e) {
    statusEl.textContent = "Failed: " + (e.message || e);
    statusEl.style.color = "var(--os-bad-ink)";
  } finally {
    btn.disabled = false;
  }
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------
let toastTimer = null;
let selfWrites = 0; // storage.onChanged events caused by our own persist()
async function persist() {
  selfWrites++;
  try {
    await saveConfig(config);
  } catch (e) {
    selfWrites--; // the write never happened, so no onChanged will fire for it
    throw e;
  }
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), 1600);
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
