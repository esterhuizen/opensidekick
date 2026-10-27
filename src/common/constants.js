// Shared constants and defaults for OpenSidekick.
// Imported by the service worker, side panel, and options page (all ES modules).
// NOTE: the content script is NOT a module and cannot import this file — keep
// any values it needs duplicated there intentionally.

export const STORAGE_KEY = "opensidekick.config.v1";

// chrome.storage.local key for scheduled-run bookkeeping (what each task last
// produced, when, and how many notifications were suppressed). Deliberately a
// key of its own rather than fields on the task: a config write re-registers
// every alarm, and the options page writes the whole config from its own
// in-memory snapshot — so run state must not live in there.
export const TASK_RUNS_KEY = "opensidekick.taskRuns.v1";

// chrome.storage.session key for the current chat's conversation. MV3 can
// terminate the idle service worker at any time; persisting here lets the next
// worker pick the chat back up (and it clears automatically when Chrome closes).
export const SESSION_CONVO_KEY = "opensidekick.conversation.v1";

// Session-scoped browser tab-group workspace used by the agent across turns.
export const SESSION_TAB_WORKSPACE_KEY = "opensidekick.tabWorkspace.v1";

// chrome.storage.session key for a finished recording that hasn't been saved or
// discarded yet — so closing the side panel doesn't silently lose the steps.
export const SESSION_PENDING_WF_KEY = "opensidekick.pendingWorkflow.v1";

// chrome.storage.local key for the composer's prompt history (shell-style
// up/down recall). Survives browser restarts; capped, most recent last.
export const PROMPT_HISTORY_KEY = "opensidekick.promptHistory.v1";
export const PROMPT_HISTORY_MAX = 50;

// chrome.storage.session key for the last { providerId, model } the side panel
// showed, so a panel reopened on a restored chat can tell that the model was
// switched while it was closed.
export const SESSION_MODEL_KEY = "opensidekick.lastModel.v1";

// Chat history in chrome.storage.local: a small index of saved chats plus one
// key per chat body, so each write (and each storage.onChanged broadcast)
// covers one chat rather than all of them. The version sits before the id so
// every body shares one prefix that the index key can't match.
export const SESSIONS_INDEX_KEY = "opensidekick.sessions.v1";
export const SESSION_BODY_PREFIX = "opensidekick.session.v1.";
export const SESSIONS_MAX = 20;

// chrome.storage.session key for { id, sensitive }: which saved chat the hot
// copy under SESSION_CONVO_KEY belongs to.
export const SESSION_CONVO_META_KEY = "opensidekick.conversationMeta.v1";

// chrome.storage.local flag: the one-time "chats are now saved" note has been
// shown. Not part of chat history, so clearing history leaves it alone.
export const HISTORY_NOTICE_KEY = "opensidekick.historyNotice.v1";

// Transcript notes about chat history, shared by the worker and the side panel.
export const SENSITIVE_NOTE = "This chat used a banking, payment or crypto site, so it won't be saved to History.";
export const HISTORY_NOTICE = "Chats are now saved on this device. Manage in Settings → Chat history.";
export const TRIMMED_NOTE = "Older messages in this chat weren't kept.";

// Provider "type" determines which wire protocol we speak.
//   "openai"    -> POST {baseUrl}/chat/completions   (OpenRouter, OpenAI, Ollama,
//                  Groq, Venice AI, Together, DeepSeek, LM Studio, Google's
//                  OpenAI-compatible endpoint, and any other OpenAI-compatible
//                  server)
//   "anthropic" -> POST {baseUrl}/messages           (Anthropic Messages API)
export const PROVIDER_TYPES = ["openai", "anthropic"];

// The living list of suggested models. Linked from Settings, never fetched.
export const MODELS_PAGE_URL = "https://opensidekick.app/models/";

// One-click presets shown in the options page. `apiKey` and `defaultModel`
// are filled in by the user. baseUrl has no trailing slash.
//
// `suggestions` (at most two per preset: { model, label, kind, note }, kind one
// of closed / open / budget / light) are a static hint, dated 2026-10-10 (Ollama
// tags 2026-10-13): they ship with the extension and go stale between releases.
// MODELS_PAGE_URL is the living list.
//
// `defaultModel` follows the first suggestion (Ollama: the light pick; LM Studio stays empty because its ids depend on what the user downloaded, since
// the quality pick needs more memory than most laptops have). Dated 2026-10-10
// (Ollama 2026-10-13).
export const PROVIDER_PRESETS = [
  {
    id: "openrouter",
    name: "OpenRouter",
    type: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "anthropic/claude-sonnet-5.5",
    keyUrl: "https://openrouter.ai/keys",
    hint: "One key, hundreds of models. Recommended default.",
    suggestions: [
      { model: "anthropic/claude-sonnet-5.5", label: "Claude Sonnet 5.5", kind: "closed", note: "balanced cost and capability" },
      { model: "qwen/qwen3-vl-235b-a22b-instruct", label: "Qwen3-VL 235B", kind: "open", note: "cheap, strong on computer-use tests" },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    type: "openai",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5.6-terra",
    keyUrl: "https://platform.openai.com/api-keys",
    hint: "GPT models directly from OpenAI.",
    suggestions: [
      { model: "gpt-5.6-terra", label: "GPT-5.6 Terra", kind: "closed", note: "balanced; GPT-6 models need the Responses API for tools" },
      { model: "gpt-5.6-luna", label: "GPT-5.6 Luna", kind: "budget", note: "cheapest" },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic (Claude)",
    type: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-5-5",
    keyUrl: "https://console.anthropic.com/settings/keys",
    hint: "Claude models directly from Anthropic.",
    suggestions: [
      { model: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", kind: "closed", note: "balanced" },
      { model: "claude-haiku-5-5", label: "Claude Haiku 5.5", kind: "budget", note: "cheapest" },
    ],
  },
  {
    id: "google",
    name: "Google Gemini (OpenAI-compatible)",
    type: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-3.8-flash",
    keyUrl: "https://aistudio.google.com/apikey",
    hint: "Gemini via Google's OpenAI-compatible endpoint.",
    suggestions: [
      { model: "gemini-3.8-flash", label: "Gemini 3.8 Flash", kind: "closed", note: "balanced" },
      { model: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite", kind: "budget", note: "cheapest" },
    ],
  },
  {
    id: "groq",
    name: "Groq",
    type: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "qwen/qwen3.8-27b",
    keyUrl: "https://console.groq.com/keys",
    hint: "Very fast open-weight models.",
    suggestions: [
      { model: "qwen/qwen3.8-27b", label: "Qwen 3.8 27B", kind: "open", note: "the only Groq model with tools + vision" },
      { model: "openai/gpt-oss-20b", label: "GPT-OSS 20B", kind: "light", note: "fast and cheap, no vision" },
    ],
  },
  {
    id: "venice",
    name: "Venice AI",
    type: "openai",
    baseUrl: "https://api.venice.ai/api/v1",
    defaultModel: "claude-sonnet-5-5",
    keyUrl: "https://venice.ai/settings/api",
    hint: "Privacy-focused inference. Open-weight and frontier models with tool calling + vision.",
    suggestions: [
      { model: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", kind: "closed", note: "balanced cost and capability" },
      { model: "qwen3-vl-235b-a22b", label: "Qwen3-VL 235B", kind: "open", note: "cheap, strong on computer-use tests" },
    ],
  },
  {
    // Ollama's plain qwen3-vl:<size> tags are the thinking builds: they spend the
    // whole reply in "reasoning" and never answer within a small budget
    // (ollama/ollama#16945), so the presets name the instruct tags.
    id: "ollama",
    name: "Ollama (local)",
    type: "openai",
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "qwen3-vl:8b-instruct",
    keyUrl: "",
    hint: "Runs entirely on your machine. No API key needed. Set OLLAMA_ORIGINS=chrome-extension://* and restart Ollama.",
    suggestions: [
      { model: "qwen3-vl:30b-a3b-instruct", label: "Qwen3-VL 30B", kind: "open", note: "about 20 GB" },
      { model: "qwen3-vl:8b-instruct", label: "Qwen3-VL 8B", kind: "light", note: "about 6 GB" },
    ],
  },
  {
    id: "lmstudio",
    name: "LM Studio (local)",
    type: "openai",
    baseUrl: "http://localhost:1234/v1",
    defaultModel: "",
    keyUrl: "",
    hint: "Local server from LM Studio. No API key needed.",
    suggestions: [
      { model: "qwen/qwen3-vl-8b", label: "Qwen3-VL 8B", kind: "open", note: "tools + vision" },
      { model: "mistralai/mistral-small-3.2", label: "Mistral Small 3.2", kind: "open", note: "tools + vision" },
    ],
  },
  {
    id: "custom",
    name: "Custom (OpenAI-compatible)",
    type: "openai",
    baseUrl: "",
    defaultModel: "",
    keyUrl: "",
    hint: "Any server exposing /chat/completions.",
    suggestions: [],
  },
];

export const DEFAULT_SETTINGS = {
  // "ask"  -> confirm before the agent takes its first action on each new site.
  // "auto" -> act without asking on already-allowed sites (still confirms new
  //           domains and blocked categories).
  autonomy: "ask",
  // "all"       -> the agent may work on any site (per-site rules still apply).
  // "allowlist" -> the agent only works on sites the user has allowed; anything
  //                else prompts first — even reads, even in auto mode.
  siteAccess: "all",
  // Hard ceiling on agent tool-calling iterations per task (prevents runaways).
  maxSteps: 25,
  // Expose a screenshot tool so vision-capable models can see the page on demand.
  // On by default (matches other browser agents); turn off for text-only models.
  enableVision: true,
  // Expose a run_javascript escape-hatch tool (runs code in the page).
  enableJsTool: false,
  // Browser-level pointer input is opt-in (Chrome shows a debugger banner).
  enableNativeInput: false,
  // Expose console/network reading via Chrome's debugger (shows a banner).
  enableCdp: false,
  // Max output tokens per model call.
  maxTokens: 4096,
  // Temperature for OpenAI-style requests (ignored by Anthropic newer models).
  temperature: 0.4,
  // Chat history and prompt history in chrome.storage.local. Raw readers treat
  // anything except false as on.
  keepHistory: true,
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
  // Optional "smart checks": fast yes/no verdicts from TypeSafe's Jev decision
  // model, used to catch what the built-in regex heuristics miss. Entirely off
  // until the user picks a key source and switches a check on; on any failure
  // the agent behaves exactly as it does with this block disabled.
  //   source     -> "openrouter" (borrow an OpenRouter provider's key, by
  //                 providerId) or "typesafe" (its own key, below)
  //   baseUrl    -> optional override; blank uses the default for the source
  //   model      -> optional override; blank uses DEFAULT_DECISION_MODELS
  //   features   -> one switch per check, all off
  decisions: {
    enabled: false,
    source: "openrouter",
    providerId: null,
    apiKey: "",
    baseUrl: "",
    model: "",
    sensitivity: "balanced",
    features: { injection: false, action: false, changeOnly: false },
  },
  settings: { ...DEFAULT_SETTINGS },
};

// Probability of "bad" at or above which a smart check escalates (prompts the
// user, flags the page). Cautious escalates on weaker evidence, so it prompts
// more often. NOTE: Jev's calibration is unverified by us — the vendor claims
// 0.8 means "right about 80% of the time" — so these numbers may move once
// there's real-world data behind them.
export const DECISION_SENSITIVITY = {
  cautious: 0.5,
  balanced: 0.8,
  permissive: 0.95,
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
  NEW_CHAT: "new_chat",
  PERMISSION_RESPONSE: "permission_response",
  PLAN_RESPONSE: "plan_response",
  RUN_SCHEDULED: "run_scheduled",
  START_RECORDING: "start_recording",
  STOP_RECORDING: "stop_recording",
  GET_STATE: "get_state",
  // side panel / options -> worker: chat history
  LIST_SESSIONS: "list_sessions",
  OPEN_SESSION: "open_session",
  RENAME_SESSION: "rename_session",
  DELETE_SESSION: "delete_session",
  CLEAR_SESSIONS: "clear_sessions",
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
