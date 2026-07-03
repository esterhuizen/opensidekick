// Shared constants and defaults for OpenSidekick.
// Imported by the service worker, side panel, and options page (all ES modules).
// NOTE: the content script is NOT a module and cannot import this file — keep
// any values it needs duplicated there intentionally.

export const STORAGE_KEY = "opensidekick.config.v1";

// Provider "type" determines which wire protocol we speak.
//   "openai"    -> POST {baseUrl}/chat/completions   (OpenRouter, OpenAI, Ollama,
//                  Groq, Together, DeepSeek, LM Studio, Google's OpenAI-compatible
//                  endpoint, and any other OpenAI-compatible server)
//   "anthropic" -> POST {baseUrl}/messages           (Anthropic Messages API)
export const PROVIDER_TYPES = ["openai", "anthropic"];

// One-click presets shown in the options page. `apiKey` and `defaultModel`
// are filled in by the user. baseUrl has no trailing slash.
export const PROVIDER_PRESETS = [
  {
    id: "openrouter",
    name: "OpenRouter",
    type: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "anthropic/claude-sonnet-4.5",
    keyUrl: "https://openrouter.ai/keys",
    hint: "One key, hundreds of models. Recommended default.",
  },
  {
    id: "openai",
    name: "OpenAI",
    type: "openai",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o",
    keyUrl: "https://platform.openai.com/api-keys",
    hint: "GPT models directly from OpenAI.",
  },
  {
    id: "anthropic",
    name: "Anthropic (Claude)",
    type: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-4-5",
    keyUrl: "https://console.anthropic.com/settings/keys",
    hint: "Claude models directly from Anthropic.",
  },
  {
    id: "google",
    name: "Google Gemini (OpenAI-compatible)",
    type: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.0-flash",
    keyUrl: "https://aistudio.google.com/apikey",
    hint: "Gemini via Google's OpenAI-compatible endpoint.",
  },
  {
    id: "groq",
    name: "Groq",
    type: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    keyUrl: "https://console.groq.com/keys",
    hint: "Very fast open-weight models.",
  },
  {
    id: "ollama",
    name: "Ollama (local)",
    type: "openai",
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "qwen2.5:7b",
    keyUrl: "",
    hint: "Runs entirely on your machine. No API key needed. Set OLLAMA_ORIGINS to allow the extension.",
  },
  {
    id: "lmstudio",
    name: "LM Studio (local)",
    type: "openai",
    baseUrl: "http://localhost:1234/v1",
    defaultModel: "",
    keyUrl: "",
    hint: "Local server from LM Studio. No API key needed.",
  },
  {
    id: "custom",
    name: "Custom (OpenAI-compatible)",
    type: "openai",
    baseUrl: "",
    defaultModel: "",
    keyUrl: "",
    hint: "Any server exposing /chat/completions.",
  },
];

export const DEFAULT_SETTINGS = {
  // "ask"  -> confirm before the agent takes its first action on each new site.
  // "auto" -> act without asking on already-allowed sites (still confirms new
  //           domains and blocked categories).
  autonomy: "ask",
  // Hard ceiling on agent tool-calling iterations per task (prevents runaways).
  maxSteps: 25,
  // Expose a screenshot tool so vision-capable models can see the page on demand.
  enableVision: false,
  // Expose a run_javascript escape-hatch tool (runs code in the page).
  enableJsTool: false,
  // Expose console/network reading via Chrome's debugger (shows a banner).
  enableCdp: false,
  // Max output tokens per model call.
  maxTokens: 4096,
  // Temperature for OpenAI-style requests (ignored by Anthropic newer models).
  temperature: 0.4,
};

export const DEFAULT_CONFIG = {
  providers: [],
  activeProviderId: null,
  activeModel: null,
  // Per-origin permission map: { "https://example.com": "allow" | "block" }
  sitePermissions: {},
  // Saved prompts, accessed by typing "/" in the side panel.
  prompts: [], // { id, command, text }
  // Recurring tasks run via chrome.alarms while Chrome is open.
  scheduledTasks: [], // { id, name, prompt, url, intervalMinutes, enabled }
  // Recorded workflows replayed by the agent.
  workflows: [], // { id, name, startUrl, steps: [{ action, description }] }
  // Remote MCP tool servers whose tools the agent can use.
  mcpServers: [], // { id, name, url, authToken, enabled }
  settings: { ...DEFAULT_SETTINGS },
};

// Schedule presets shown in the options UI (minutes).
export const SCHEDULE_PRESETS = [
  { label: "Every hour", minutes: 60 },
  { label: "Every 6 hours", minutes: 360 },
  { label: "Every day", minutes: 1440 },
  { label: "Every week", minutes: 10080 },
];

// Site categories the agent must never act on without an explicit per-action
// override. Matched against the hostname. Deliberately conservative.
export const SENSITIVE_HOST_PATTERNS = [
  /(^|\.)(chase|bankofamerica|wellsfargo|citi|capitalone|barclays|hsbc)\./i,
  /(^|\.)(paypal|venmo|wise|revolut|stripe)\.com$/i,
  /(^|\.)(coinbase|binance|kraken|crypto)\./i,
  /(^|\.)(bank|banking)\./i,
];

// Message types passed between the side panel, service worker, and content script.
export const MSG = {
  // side panel -> worker
  RUN_TASK: "run_task",
  STOP_TASK: "stop_task",
  PERMISSION_RESPONSE: "permission_response",
  PLAN_RESPONSE: "plan_response",
  RUN_SCHEDULED: "run_scheduled",
  START_RECORDING: "start_recording",
  STOP_RECORDING: "stop_recording",
  GET_STATE: "get_state",
  // worker -> side panel
  AGENT_EVENT: "agent_event", // { kind, ... } streamed progress
  PERMISSION_REQUEST: "permission_request",
  PLAN_REQUEST: "plan_request",
  RECORDING_STEP: "recording_step", // { step } as the user records
  // worker <-> content script
  CS_RECORD: "cs_record", // { on: bool } arm/disarm recording listeners
  CS_STEP: "cs_step", // content script -> worker: a captured step
  // worker <-> content script
  CS_READ_PAGE: "cs_read_page",
  CS_GET_TEXT: "cs_get_text",
  CS_ACT: "cs_act",
  CS_PING: "cs_ping",
  CS_OVERLAY: "cs_overlay",
};
