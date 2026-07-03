# Changelog

All notable changes to OpenSidekick are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

- **Vision (optional):** a `take_screenshot` tool + image support in the message
  layer for both providers, so multimodal models can see the page. Gated by a
  new "Enable vision" toggle in Settings.
- **Fuller action set:** `hover_element`, `double_click`, `right_click`,
  `drag_element` (pointer-based drag-and-drop), and `press_keys` (keyboard
  shortcuts).
- **Run-JavaScript escape hatch (optional):** a `run_javascript` tool that runs
  code in the page via `chrome.scripting` (world MAIN). Opt-in; permission-gated.
- **Developer tools (optional):** `read_console` and `read_network`, backed by
  `chrome.debugger` (CDP). The debugger attaches lazily and detaches when the
  task ends. Opt-in via a Settings toggle; declares the `debugger` permission.
- **Safety layer:**
  - On-page activity indicator (glow + label + Stop button) shown while the agent
    works and cleared when the task ends.
  - Pre-action domain re-check: a mutating action is blocked if the page changed
    origin since it was last read, with a warning to the user.
  - Forced confirmation on purchase/delete/transfer-type clicks (by element
    label) even in "auto" mode — never persisted, always re-prompts.
  - Prompt-injection flagging: page content that looks like instructions aimed at
    the agent is marked as untrusted in the tool result, and the user is warned.
  - Unit tests for the injection + sensitive-action heuristics; e2e coverage for
    all four behaviors in a real browser.
- **Real-model e2e test** (`npm run test:real`) that drives the extension against
  a live LLM via OpenRouter; verified end-to-end with gpt-4o-mini.
- e2e coverage for vision, run_javascript, and CDP console/network (verified that
  `chrome.debugger` attaches and captures real console + network events).
- Unit coverage for image message shaping (OpenAI + Anthropic).

### Changed

- The side panel renders the user's message from the worker event, so runs
  triggered by any entry point display consistently.

## [0.1.0] — 2026-07-03

Initial release.

### Added

- Side-panel chat aware of the current page.
- Agentic browser control: `read_page`, `get_page_text`, `click_element`,
  `type_text`, `select_option`, `navigate`, `scroll`, `wait`, and multi-tab
  tools (`list_tabs`, `open_tab`, `switch_tab`).
- Provider-agnostic model layer with two protocols:
  - OpenAI-compatible (`/chat/completions`) — OpenRouter, OpenAI, Google Gemini,
    Groq, Together, DeepSeek, Ollama, LM Studio, and custom endpoints.
  - Anthropic Messages API (direct-from-browser).
- Streaming responses (SSE) with a live view of each tool action.
- Per-site permission model (ask / auto) with hard guards on sensitive sites.
- Options page for managing providers, keys, models, behavior, and site rules.
- Context-menu actions: ask about a selection, summarize a page.
- Dependency-free PNG icon generator.
