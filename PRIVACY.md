# Privacy Policy — OpenSidekick

_Last updated: 2026-07-03_

OpenSidekick is a browser extension that runs entirely on your device. It has no
backend server operated by the project and collects no analytics or telemetry.

## What data is handled

- **API keys and settings** you enter are stored locally using
  `chrome.storage.local`. They never leave your browser except as described
  below.
- **Page content** (text and a map of interactive elements) from the tab you ask
  the assistant to work on is read on demand and sent **to the LLM provider you
  configured** so the model can understand and act on the page.
- **Your messages** to the assistant are sent to that same provider.

## Where data goes

The only network destination is the **provider endpoint you choose** (e.g.
OpenRouter, OpenAI, Anthropic, Google, Groq, or a local model at
`localhost`). OpenSidekick sends requests directly from your browser to that
endpoint. The project's authors never receive your keys, prompts, or page data.

Your chosen provider's own privacy policy governs what they do with the data you
send them. If you use a local model (Ollama, LM Studio), nothing leaves your
machine at all.

## What is NOT collected

- No analytics, tracking, or usage metrics.
- No accounts, sign-in, or user identifiers.
- No selling or sharing of data with third parties by this extension.

## Permissions and why they're needed

- **Host access (`<all_urls>`)**: to read and act on the pages you point the
  assistant at, and to call the model provider / local endpoint you configure.
- **`scripting` / `activeTab` / `tabs`**: to read the current page and perform
  actions across tabs on your behalf.
- **`storage`**: to save your providers, keys, and preferences locally.
- **`sidePanel`**: to show the assistant UI.
- **`contextMenus` / `notifications`**: right-click actions and status.

## Your control

- Remove a provider or key at any time in Settings.
- Manage or revoke per-site permissions in Settings → Site permissions.
- Uninstalling the extension deletes all locally stored data.

## Contact

Open an issue at https://github.com/OWNER/opensidekick for questions.
