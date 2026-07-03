# OpenSidekick

**An open-source, provider-agnostic AI agent for your browser.** OpenSidekick is a
Chrome extension that lives in the side panel, reads the page you're on, and can
act on it for you — click, type, fill forms, navigate, and work across tabs.

Unlike vendor-locked assistants, **you bring your own model.** Point it at
OpenRouter, OpenAI, Anthropic, Google Gemini, Groq, or a local model running in
Ollama or LM Studio. Your API keys stay in your browser and are sent only to the
provider you choose.

MIT licensed. No account. No telemetry. No middleman.

![OpenSidekick reading a page and filling a form on the user's behalf](store/screenshots/01-act.png)

<sub>More: [bring your own model](store/screenshots/02-providers.png) · [summarize & extract](store/screenshots/03-summarize.png)</sub>

---

## Why this exists

Anthropic's "Claude for Chrome" is a capable agentic browser assistant, but it's
tied to Claude, requires a paid Claude plan, and is closed source. Existing
open-source alternatives each miss something: some are unmaintained, some can't
use local models, and the best-maintained one (Page Assist) is a chat sidebar
with no agentic control.

OpenSidekick aims to be the piece that's missing: **maintained, MIT-licensed,
genuinely agentic, and usable with any LLM — including fully local models.**

## Features

- **Side-panel chat** that's aware of the current page.
- **Agentic browser control** — reads an accessible map of the page and clicks,
  types, selects, scrolls, hovers, double/right-clicks, drags, and presses
  keyboard shortcuts, all by element reference.
- **Optional vision** — when enabled, the agent can capture a screenshot so a
  multimodal model can *see* the page (canvas apps, image-only UIs, layout).
- **Multi-tab** — list, open, and switch tabs to complete a task.
- **Any provider, any model** via two protocols:
  - OpenAI-compatible (`/chat/completions`): OpenRouter, OpenAI, Google Gemini,
    Groq, Together, DeepSeek, **Ollama**, **LM Studio**, or any custom endpoint.
  - Anthropic Messages API (direct from the browser).
- **Per-site permission model** with an "ask before acting" default and hard
  guards on sensitive sites (banking, payments, crypto).
- **Context menu**: right-click a selection to ask about it, or summarize a page.
- **Streaming responses** and a live view of every action the agent takes.
- **Local-first & private**: keys and settings live in `chrome.storage.local`;
  requests go straight to your chosen provider.

## Install (from source, unpacked)

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome (or Edge / Brave — any Chromium 116+).
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select this folder.
5. Pin OpenSidekick and click it (or press **Ctrl+E** / **Cmd+E**) to open the
   side panel.

> The icons ship pre-generated. If you edit `scripts/generate-icons.mjs`, run
> `npm run icons` (Node only, no dependencies) to rebuild them.

## Configure a model

Open **Settings** (the ⚙ in the side panel, or the extension's options page) and
add a provider:

| Provider | Base URL | Notes |
| --- | --- | --- |
| **OpenRouter** (recommended) | `https://openrouter.ai/api/v1` | One key, hundreds of models. |
| OpenAI | `https://api.openai.com/v1` | |
| Anthropic | `https://api.anthropic.com/v1` | Uses the direct-browser access header. |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | OpenAI-compatible endpoint. |
| Groq | `https://api.groq.com/openai/v1` | Very fast open-weight models. |
| **Ollama** (local) | `http://localhost:11434/v1` | No key. See CORS note below. |
| **LM Studio** (local) | `http://localhost:1234/v1` | No key. |
| Custom | your URL | Anything speaking `/chat/completions`. |

Paste your API key, click **Fetch models** (or type a model id), select the
provider, and you're ready.

> **Tool use / agentic actions require a model that supports function calling.**
> Most hosted models do. For local models via Ollama, pick a tool-capable model
> (e.g. `qwen2.5`, `llama3.1`). Models without tool support still work for chat
> and summarization.

### Using a local model (Ollama)

Ollama must allow the extension's origin to call it. Start Ollama with:

```bash
# macOS/Linux
OLLAMA_ORIGINS='chrome-extension://*' ollama serve
```

(or set `OLLAMA_ORIGINS` in your environment / launchd / systemd unit).

## How it works

```
 Side panel (chat UI)
        │  user task
        ▼
 Service worker ──► Agent loop ──► your LLM provider (streaming)
        │                │  tool calls
        │                ▼
        │           Tools (navigate, tabs) + Content script (read/act on page)
        ▼
 Permission prompts ◄────┘  (for actions on new / sensitive sites)
```

1. You type a task. The service worker sends it to your model with a set of
   browser-control tools.
2. The model calls tools like `read_page` (which returns a compact map of
   interactive elements, each with a numeric ref) and then `click_element`,
   `type_text`, `navigate`, etc.
3. The content script executes those actions on the page and returns results.
4. Mutating actions on a new site trigger a permission prompt (unless you're in
   "auto" mode); sensitive sites always ask per action.
5. The loop continues until the model calls `finish` or has nothing left to do.

## Safety & privacy

- **Your keys never leave your browser** except in the request to the provider
  you configured. There is no OpenSidekick server and no analytics.
- **The agent uses your real logged-in sessions**, like any human clicking in
  your browser. Start on trusted sites, watch what it does, and use "ask" mode.
- **Prompt-injection awareness**: the system prompt instructs the model to treat
  page content as untrusted and never follow instructions embedded in pages.
  This is a mitigation, not a guarantee — review actions on important sites.
- **Sensitive sites** (banks, payment processors, crypto exchanges) always
  require per-action confirmation and can't be "always allowed."
- The agent will not attempt to bypass logins or CAPTCHAs — it pauses and asks
  you to handle them.

See [PRIVACY.md](PRIVACY.md) for the full data-handling statement.

## Limitations (v0.1)

- Actions are DOM-based (synthesized events), which works on most sites but can
  miss elements inside closed shadow DOM, cross-origin iframes, or `<canvas>`
  apps.
- Restricted pages (`chrome://`, the Chrome Web Store, PDFs) can't be read or
  acted on.
- No scheduled tasks or workflow recording yet — see the roadmap.
- Scheduled/long tasks depend on the service worker staying alive; very long
  idle waits can be suspended by Chrome.

## Roadmap

Shipped since the first cut:

- [x] Vision — on-demand screenshots for multimodal models (Settings toggle)
- [x] Fuller action set — hover, double-click, right-click, drag, keyboard shortcuts

Planned, to reach and exceed feature parity with vendor-locked assistants:

- [ ] Saved prompts / slash commands (`/`)
- [ ] Scheduled and recurring tasks
- [ ] Workflow recording & replay
- [ ] Connect to MCP tool servers (extend beyond the browser)
- [ ] Read console errors + network requests (debugging tasks)
- [ ] Upload files into file inputs
- [ ] Run-JavaScript escape hatch (opt-in)
- [ ] Plan-approval mode + stronger prompt-injection defenses
- [ ] On-page activity indicator
- [ ] Firefox (WebExtensions) build
- [ ] Optional CDP-based trusted input for tougher sites

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

No build step and no runtime dependencies. Everything is plain ES modules loaded
directly by Chrome.

```bash
npm run icons   # regenerate PNG icons (Node only)
npm run check   # syntax-check all JS
npm run zip     # package a store-ready zip
```

Project layout:

```
manifest.json                 MV3 manifest
src/common/constants.js       shared config, presets, message types
src/background/
  service-worker.js           message routing, conversation state
  agent.js                    the agentic tool-calling loop
  providers.js                OpenAI + Anthropic adapters, SSE streaming
  tools.js                    browser-control tool defs + execution
  permissions.js              per-site permission logic
  storage.js                  chrome.storage wrapper
src/content/content-script.js page reading (element map) + action execution
src/sidepanel/                chat UI
src/options/                  settings UI
scripts/generate-icons.mjs    dependency-free PNG icon generator
```

## Publishing to the Chrome Web Store

See [store/listing.md](store/listing.md) for ready-to-use listing copy and a
step-by-step submission checklist.

## License

[MIT](LICENSE) © OpenSidekick contributors.
