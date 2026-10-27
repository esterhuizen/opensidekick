# Changelog

All notable changes to OpenSidekick are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

## [0.4.2] — 2026-10-27

### Security

- **The site permission check is stricter** ([#8](https://github.com/esterhuizen/opensidekick/issues/8),
  reported by @kurotope). Opening a tab now asks like navigating does, and both
  are judged by the site they load, not the page the agent is on. Switching to
  a tab honours a block rule and the bank rule, and asks in only-allowed-sites
  mode. Once the agent has been on a sensitive site in a chat, every later
  navigation, typing and script asks first, which makes it much harder to carry
  what it read there to another site. A blocked site is also blocked for reading. Only http(s) addresses can
  be opened. A tool you turned off in Settings can't run even if the model asks
  for it by name. Plan approval never skips the per-action prompt on a
  sensitive site. After it changes page or tab, the agent must read the new
  page before acting on it, and an action is refused if the page changed while
  you were deciding. Hovering now counts as an action.

## [0.4.1] — 2026-10-25

### Fixed

- **Gemini tool calls no longer fail on the second step** ([#7](https://github.com/esterhuizen/opensidekick/issues/7)).
  Gemini 3 models attach a thought signature to each tool call and reject the
  next request if it is missing. OpenSidekick now keeps that data and sends it
  back with the turn it came from, both on Google's OpenAI-compatible endpoint
  (`extra_content`) and through OpenRouter (`reasoning_details`). It goes only
  to the server that sent it.

## [0.4.0] — 2026-10-22

### Added

- **Real Markdown in the chat.** Replies now render headings, tables, nested
  and ordered lists, blockquotes, task lists, strikethrough and reference
  links with markdown-it (vendored, pinned, verified against npm). Code fences
  get a language banner, a Copy button and syntax colours from Prism for 12
  common languages. Full web addresses (http or https) and email addresses
  in a reply become links; bare domains and file names such as `setup.py`
  do not. Links stay limited to http, https and mailto, images never load
  (one shows as an `[image: alt text]` marker), and raw HTML stays plain
  text, so the chat still never loads anything from the web. Single line
  breaks still break lines. Thanks @kurotope.
  ([#6](https://github.com/esterhuizen/opensidekick/pull/6))

- **`read_page` lists custom comboboxes.** ARIA comboboxes (`role="combobox"`
  on a `div` or similar) now appear in the page map with their label and the
  option currently shown, so the agent can open them and pick an option, as it
  already could with `<select>`. A `<textarea role="combobox">` keeps reporting
  what was typed into it. Thanks @reopenpilot.
  ([#5](https://github.com/esterhuizen/opensidekick/pull/5))

### Changed

- **Contributing rules.** No npm runtime dependencies still holds; a library
  may be vendored case by case when it is pinned, byte-verified against the
  official npm package, and shipped with its license. See CONTRIBUTING.md.

### Fixed

- **`click_element` fired twice.** The content script dispatched a synthetic
  click and then also called `el.click()`, so the element's default action ran
  two times: checkboxes flipped straight back, and forms with a JavaScript
  submit handler submitted twice. Now exactly one click fires. `double_click`
  sends two, as a native double-click does. Thanks @reopenpilot.
  ([#4](https://github.com/esterhuizen/opensidekick/pull/4))

## [0.3.1] — 2026-10-13

### Fixed

- **The Ollama preset pointed at a thinking model.** Ollama's plain
  `qwen3-vl:8b` and `qwen3-vl:30b` tags are thinking builds: they spend the
  whole reply thinking, so the agent got no answer and no tool call, and the
  model test in Settings said tools didn't work. The preset now uses
  `qwen3-vl:8b-instruct` (about 6 GB), with `qwen3-vl:30b-a3b-instruct` (about
  20 GB) as the bigger pick. If you added Ollama before this release, run
  `ollama pull qwen3-vl:8b-instruct`, then change the model to
  `qwen3-vl:8b-instruct` in Settings.
  ([#3](https://github.com/esterhuizen/opensidekick/issues/3))
- **The model test and Fetch models now say why a local model failed.** A
  reasoning model that uses the whole test on thinking gets "spent the whole
  budget thinking", with the instruct build to use instead where there is one.
  A local server that answers 403 gets the fix: set `OLLAMA_ORIGINS` for
  Ollama, or switch on **Enable CORS** in LM Studio. The message points to the
  README, with a link in the model test. Before, both cases ended in "Tools
  didn't work".

## [0.3.0] — 2026-10-11

### Added

- **Chat history.** The side panel now keeps your chats in this browser, so
  restarting Chrome or starting a new chat no longer loses the conversation. A
  History button in the top bar lists your 20 most recent chats (title, when,
  and which model answered); open one to carry on where you left off, rename
  it, or delete it, and **Clear all** removes every saved chat, your prompt
  history and the open chat.
  **New chat** now starts a fresh chat and keeps the previous one in History.
  History saves what you see in the chat — your messages and the assistant's
  replies — not screenshots, the page text the assistant read, or the steps it
  took. A very long chat keeps its most recent messages, and says so when
  older ones weren't kept. A chat in which the assistant reads, opens or
  screenshots a site on the built-in sensitive-site list (banks, payment
  processors, crypto exchanges) is never saved, and the chat says so.
  Settings → **Chat history** has a "Keep chat history on this device" switch,
  on by default, including for existing installs (everyone sees a one-time note
  in the chat after their first saved chat); turning it off deletes saved chats
  and your prompt history and stops saving them, so ↑ recall then only covers
  the panel you have open. Saved chats are never sent anywhere by themselves;
  continuing one sends its earlier messages to the model you are using at that
  moment. Scheduled tasks are not added to History. (#1)

### Fixed

- **A very long chat could fail on the next prompt after the worker restarted.**
  When the chat outgrew session storage, the fallback kept the last 20 messages,
  which could begin mid-way through a tool call and make the provider reject the
  next request. The fallback now keeps the chat's text as whole turns (without
  tool steps), which providers accept.
- **An approved plan no longer shows up as a message from you.** Reopening a
  chat that used plan approval used to show the approval ("I approve this
  plan…") as a user bubble.

## [0.2.0] — 2026-10-10

### Added

- **Suggested models per provider.** Each preset in Settings → Providers shows
  up to two suggested models as chips under the Model field (dated
  2026-10-10, tagged closed / open / budget / light). A click fills the field,
  saves it, and runs the model test once. A chip is muted when the provider's
  fetched model list doesn't include it. A "This week's picks ↗" link points to
  the live list at https://opensidekick.app/models/ (only linked, never
  fetched). Providers added from a preset now record its `presetId`; older ones
  are matched to their preset by the exact host of their base URL.
- **Model chip and switch notice in the side panel.** A chip under the top bar
  shows the active model and provider and opens Settings when clicked.
  Switching the model in the middle of a chat adds a one-time note ("Now using
  … via …. Replies continue in this chat.") with a **New chat** button. A
  reopened panel shows the same note if the model changed while it was closed.
- **The agent knows which model it is.** The system prompt now names the
  configured model id and provider (never the key or base URL), so "which
  model are you?" gets the right answer.

### Changed

- **Preset defaults refreshed.** Each provider preset now pre-fills its current
  balanced pick (as of October 2026), e.g. Claude Sonnet 5.5, GPT-5.6 Terra,
  Gemini 3.8 Flash, Qwen 3.8 27B on Groq, Qwen3-VL 8B for Ollama. LM Studio keeps an empty
  default because its model ids depend on what you have downloaded.
- **Visual polish, second pass.** The side panel opens on one quiet question
  ("What should I do on this page?") just above the composer instead of a
  landing-page hero, and Send is now an icon button inside the input with the
  Plan / Ask / Auto control directly under it. Indigo is kept for Send and the
  active state; elsewhere the panel, Settings and the on-page pill use warm
  off-white paper (near-black in dark mode), a 12/13/14/16/20 px type scale and
  4/8/12 px radii. Settings marks the active provider with an "Active" tag and
  folds long hints under "Learn more". Focus rings are visible, panel targets
  are at least 32 px, and nothing works differently.
- **Models are tested the moment you pick them.** Choosing or typing a model id
  in Settings → Providers (or pasting the key for a provider whose model is
  already filled in) now runs the three-probe suitability test automatically,
  with a live "Testing…" progress line that fills in ✓/⚠/✗ for text, tool
  calling and vision as each probe finishes. Picking another model mid-test
  cancels the first. The Test button is still there for re-runs.
- **Visual refresh, first pass.** One shared token sheet (`src/common/ui.css`,
  lifted from opensidekick.app) now drives the side panel, the settings page
  and the on-page activity pill; header buttons use inline SVG icons instead of
  Unicode glyphs; the settings page gains a section sidebar with status tags;
  the activity ring is thinner and Stop is a ghost button so a normal run no
  longer reads as an error. No behaviour changes; every test selector kept.

## [0.1.9] — 2026-10-10

### Added

- **Smart checks (beta, optional)** — Settings → **Smart checks**. Fast yes/no
  safety verdicts from TypeSafe's **Jev** decision model, used to catch what the
  built-in pattern matching misses. The key source is yours to pick: one of your
  existing **OpenRouter** provider keys (requests go to
  `https://openrouter.ai/api/alpha/decisions`) or a **TypeSafe** key
  (`https://api.typesafe.ai/v1/systemone`). Three checks, each switched on
  separately:
  - **Check risky actions before acting** — asks you first when a click, type or
    navigate looks like a purchase, payment, deletion or send, **even in Auto**.
    It can only ever add a confirmation the built-in rules would have let
    through; it can't relax one, unblock a site, or override a site rule.
    Unattended scheduled runs have nobody to ask, so a confirmation there stops
    the task instead.
  - **Classify page text for hidden instructions** — a prompt-injection
    classifier layered on top of the built-in heuristic, which stays as an
    unconditional floor. It never runs on a site matched by the built-in sensitive-site list (banks, payment
    processors, crypto exchanges); there, only the built-in check applies.
  - **Scheduled tasks: only notify when the result changed** — compares a run's
    result with the previous one and stays quiet when nothing material changed.
    Beta: it compares the model's own wording, so a reworded but unchanged
    answer can still count as a change. A task's first run, a failed run, and
    every sixth quiet run always notify.

  A **Sensitivity** setting (Cautious / Balanced / Permissive) sets how much
  certainty it takes to escalate, and a **Test** button runs one live request
  with two known answers and reports the measured latency. All of it is off
  until you supply a key and switch a check on, and on any failure — no key, an
  error, a timeout, or three failures in a row — the agent behaves exactly as it
  does with smart checks disabled.

  Privacy: short extracts go to the one endpoint you picked — the page text just
  read for the injection check; the tool name, page URL and title, the target
  element's label (or destination URL) and up to 500 characters of your own
  instruction for the action check; the task name, prompt and last two run
  summaries for change-only notifications. Text the agent types into a page is
  never sent, an instruction that looks like it carries a credential is withheld
  entirely, and no identifiers (`user`, `session_id`, `trace`) are ever sent —
  there is still no account and no telemetry. [PRIVACY.md](PRIVACY.md) lists
  exactly what each check sends.
- **Loop detector.** The agent is now stopped from running the exact same action
  (same tool, same arguments) three times in a row: the fourth attempt is
  refused and the model is nudged to try a different element or a different
  approach, with one warning in the chat. Reads, scrolls, waits and screenshots
  are exempt — repeating those is normal. Pure JavaScript; no key or smart check
  needed.

### Fixed

- **MCP tool calls now respect your autonomy mode.** Tools from your MCP servers
  were dispatched before the permission gate, so **ask** and **plan** modes
  never confirmed them — even though an MCP tool can send mail, move files, or
  change a repository. Ask/plan now confirm the first call per server per task
  ("Allow for this session"), and a decline sticks for the rest of the run
  instead of re-prompting on every step. **Auto** is unchanged, and scheduled
  runs — which already run as auto — are unchanged.
- **Saving settings no longer pushes every scheduled task's next run back.**
  Scheduled alarms were cleared and re-created on every config change, so each
  edit reset every task's countdown to a full interval. Alarms whose schedule
  hasn't changed are now left alone, including their next fire time.
- **An unattended scheduled run that needed a confirmation is no longer reported
  as "Done."** Unattended runs decline prompts (nobody is watching to approve),
  which cuts the run short; the notification now says which tool needed
  confirmation, and such a run is never silenced by change-only notifications.

## [0.1.8] — 2026-09-18

### Added

- **Venice AI provider preset** (Settings → Providers → Add a provider).
  Privacy-focused inference with open-weight and frontier models over Venice's
  OpenAI-compatible API. OpenSidekick turns off Venice's injected default system
  prompt (`include_venice_system_prompt: false`) so the agent's own instructions
  aren't diluted, strips `<think>` blocks from reasoning models' replies, and
  pins the catalog query to text models so Venice's image/TTS/embedding models
  can never appear in **Fetch models**, even if Venice changes that default.
  The preset pre-fills `qwen-3-8-27b` — Venice's default vision model, which
  supports tool calling and vision per Venice's model catalog. Get a key at
  venice.ai/settings/api.

## [0.1.1 – 0.1.7] — 2026-07-05 to 2026-07-14

_Shipped as a series of Chrome Web Store releases; grouped here._

### Added

- **Prompt history in the composer.** Press ↑ in the chat box to recall your
  previous prompts (↓ moves back toward the newest; going past it restores
  whatever you were typing). Recalled prompts are editable and run with Enter,
  shell-style. History keeps the last 50 prompts, survives browser restarts,
  and skips consecutive duplicates. Esc exits browsing. Arrows keep their
  normal caret behavior while you're typing or moving within a multiline
  prompt.
- **Only-allowed-sites mode + a site trust chip** (user-requested). A new site
  access setting (Settings → Site permissions) locks the agent down to domains
  you trust: on any unlisted site it won't even *read* the page without asking
  first — even in Auto mode — and the prompt doubles as the "trust this site"
  toggle. The site chip under the chat box shows the current site's rule
  (✓ allowed / ⛔ blocked / not allowed yet) and opens a two-click
  trust / block / clear menu, no trip to Settings. Blocked sites refuse tools
  outright; sensitive sites (banking, payments) still confirm per action even
  when trusted; unattended scheduled runs decline prompts, so they simply won't
  touch untrusted sites in this mode.

- **"Test" button for a model (Settings → Providers).** Runs three tiny live
  requests against the selected model and reports what actually happened —
  ✓/⚠/✗ for **text**, **tool calling**, and **vision** — plus a plain-language
  verdict ("This model can drive OpenSidekick"). Because it probes the real model
  rather than a built-in list, it stays correct as new models ship and works for
  any provider, including local ones with no metadata. Catches the common trap of
  a vision model that has no tool-calling endpoint (e.g. some Qwen-VL endpoints)
  before you hit it mid-task.
- **"Need help choosing a model?" explainer in Settings.** A collapsible note in
  the Providers section explains that the agent needs a model with **tool/function
  calling** (required) and **vision** (recommended), warns about the traps (only a
  specific family variant sees images; a vision model can still lack a tool-calling
  endpoint), and lists **tested** picks that pass both — open models like
  `qwen/qwen3-vl-30b-a3b-instruct`, `meta-llama/llama-4-maverick`,
  `mistralai/mistral-small-3.2-24b-instruct`, `google/gemma-3-27b-it`, plus the
  closed `openai/gpt-4o` — and points to the Test button for anything else.
- **Approval selector under the chat box.** A one-click segmented control
  (Plan / Ask / Auto) directly below the composer lets you switch autonomy mode
  without opening Settings. It stays in sync with the Behavior setting both ways,
  and the change applies to your next run.

### Fixed

- **Stale "Working…" / "Recording…" bars never cleared visually.** The status
  bar and recording banner have `display:flex` in CSS, which overrides the HTML
  `hidden` attribute — so hiding them set the property but they stayed on
  screen (the "Working…" strip lingered after every task, and the recording
  banner survived Stop). A global `[hidden] { display:none !important }` guard
  fixes the whole class of bug; the e2e now asserts computed visibility instead
  of the property.

- **Saved workflows no longer vanish.** The Settings page held its config
  snapshot from page-load and wrote the *whole* object back on any change — so a
  workflow saved (or a site permission granted, or an autonomy switch made)
  while Settings was open in another tab got silently wiped by the next Settings
  interaction. Settings now reloads and re-renders whenever another surface
  writes the config.
- **Recordings survive closing the side panel.** A finished-but-unsaved
  recording is parked in session storage and the "Save this workflow?" card is
  re-offered when the panel reopens; a recording still in progress keeps the
  worker alive (previously Chrome could kill it ~30s into a quiet stretch and
  lose the steps), and a reopened panel picks the live recording banner back up
  with the current step count.
- **The conversation now survives between prompts.** Chrome terminates the
  extension's idle service worker ~30s after a task finishes, which wiped the
  in-memory chat — so a follow-up like "ok do it" started from scratch with no
  context. The conversation is now persisted to `chrome.storage.session`
  (survives worker restarts, clears when Chrome closes) and restored on the next
  prompt. Reopening the side panel also re-renders the ongoing chat, and
  "+ New chat" clears the stored conversation immediately. Screenshots are
  stripped from the persisted copy to stay inside the session-storage quota.
  Also fixed the panel's first message after reopening silently starting a new
  chat (it sent `newChat: true`), which wiped the restored conversation — the
  panel now continues the chat; only the "+" button starts a fresh one.
- **The "Recording…" banner no longer gets stuck after Stop.** Starting a
  recording could take a moment (while the content script is injected) with no
  visual feedback, so a quick second click spawned a second start whose late
  reply re-showed the banner *after* you'd already stopped. The panel now shows
  the recording state immediately and ignores a start that resolves after a stop,
  so Stop always clears the banner. Covered by `test/recording.e2e.mjs`.
- **Stop and slow permission answers no longer wedge the panel.** Chrome can
  terminate the extension's service worker while the agent waits for you to
  answer a permission prompt; a later "Allow" then landed on a fresh worker that
  had lost the run, so nothing happened and Stop did nothing. The worker now
  keeps itself alive for the duration of a run (including while awaiting a
  prompt), and — as a backstop — Stop and any orphaned prompt answer always
  reset the panel to idle.
- **First run no longer gets stuck on "Working…".** Sending a message before a
  model is connected now shows a clear "add a model" message and the side panel
  returns to idle instead of hanging with a dead Stop button. Submitting with no
  model configured opens Settings so you can connect one, and the composer
  prompts you to do so.
- **Inspecting a page that is itself an image** (a direct `.jpg`/`.png` URL) now
  attaches the actual full-resolution image to the model instead of a viewport
  screenshot of the picture floating on the browser's gray backdrop — much
  clearer for the model to read. Non-image pages still use a screenshot.

### Changed

- **Vision is now on by default** (matches other browser agents). Screenshots are
  still on-demand, so the model only captures the page when it needs to see. If a
  text-only model rejects the screenshot, the agent now surfaces a clear hint to
  switch models or disable vision, instead of a cryptic provider error.

### Added

- **MCP tool servers:** connect remote Model Context Protocol servers (Streamable
  HTTP transport) in Settings — the agent connects at task start, lists the
  server's tools, exposes them (namespaced) alongside the browser tools, and
  dispatches calls to the server. A minimal MCP client (`mcp.js`: initialize →
  tools/list → tools/call, JSON + SSE responses, session header, optional bearer
  auth), a "Test" button that lists a server's tools, and e2e coverage against a
  mock MCP server (the model calls a remote `get_weather` tool and its result
  flows back). Unit tests for the tool-name and content-flatten helpers.
- **Workflow recording & replay:** a Record button in the side panel captures
  your page actions (clicks, typing, selects, navigations) as human-readable
  steps; save them as a named workflow and replay from the side panel's menu. The
  content script records into steps, the worker manages recording state and
  re-arms across navigations, and replay feeds the steps to the agent so it
  re-runs them intelligently (not brittle click-replay). Manage/rename/delete
  workflows in Settings. e2e-verified: recording captures real clicks/typing and
  replay re-runs them.
- **Saved prompts / slash commands:** store reusable prompts in Settings and
  insert them by typing `/` in the side panel (autocomplete menu with keyboard
  nav). Matching logic in a unit-tested `prompts.js`.
- **Scheduled tasks:** run a prompt on a repeating schedule (`chrome.alarms`,
  adds the `alarms` permission) while Chrome is open; optional start URL; result
  delivered as a notification. Unattended runs use auto mode and decline
  purchase/deletion confirmations for safety. "Run now" button in Settings.
  Both e2e-verified (the slash menu via the real side panel; scheduled run-now
  end to end).
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
- **Plan-approval mode:** a third autonomy setting ("Plan first"). The agent
  proposes a plan (summary + steps + the sites it expects to use) and waits for
  approval before acting; approved sites then act without per-action prompts,
  while any other site still prompts. Plan helpers live in a unit-tested
  `plan.js`; e2e-verified end to end.
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
