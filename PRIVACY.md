# Privacy Policy — OpenSidekick

_Last updated: 2026-10-11_

OpenSidekick is a browser extension that runs entirely on your device. It has no
backend server operated by the project and collects no analytics or telemetry.

## What data is handled

- **API keys and settings** you enter are stored locally using
  `chrome.storage.local`. They never leave your browser except as described
  below.
- **Page content** (text and a map of interactive elements) from the tab you ask
  the assistant to work on is read on demand and sent **to the LLM provider you
  configured** so the model can understand and act on the page.
- **Where you are:** each request also tells the provider the site the task
  started on (the hostname only, such as `example.com`, never the full address
  or page title) and today's date. If you had text selected on the page when you
  asked, that text is sent with the first page read, where page content would
  be sent anyway, and never on banking, payment or crypto sites or on sites your
  rules keep the agent off.
- **Your messages** to the assistant are sent to that same provider.
- **Chat history** (on by default; Settings → Chat history) is stored in
  `chrome.storage.local`: your 20 most recent chats, each with a title, when it
  was started and last used, the model id and provider name that answered, and
  the text of your messages and the assistant's replies (up to about 200 KB per
  chat; the oldest messages are dropped first, and a single very long message
  is shortened). Your messages are kept as you
  typed them, so a password or key you paste into one is saved with the chat:
  delete that chat afterwards. It does not store screenshots, the page text or
  element maps the assistant read, or the actions it took. A chat in which the
  assistant reads (including by running JavaScript on the page), opens,
  switches to or screenshots a site on the built-in sensitive-site list (banks,
  payment processors, crypto exchanges) is never saved, and is removed if an
  earlier part of it had been saved. Your last 50 prompts are also kept, so ↑
  in the chat box can recall them. Turning chat history off deletes both and
  stops saving them; the chat that is open stays in memory until Chrome closes. History is never sent anywhere — but when you
  continue a saved chat, its earlier messages go to the provider you are using
  at that moment, which may not be the one that answered before.

## Where data goes

The only network destination is the **provider endpoint you choose** (e.g.
OpenRouter, OpenAI, Anthropic, Google, Groq, Venice AI, or a local model at
`localhost`) — plus, **only if you switch on Smart checks**, the decision
endpoint described in the next section. OpenSidekick sends requests directly
from your browser to those endpoints. The project's authors never receive your
keys, prompts, or page data.

Your chosen provider's own privacy policy governs what they do with the data you
send them. If you use a local model (Ollama, LM Studio), nothing leaves your
machine at all.

## Smart checks (optional, off by default)

Settings → **Smart checks** can add fast yes/no safety checks using TypeSafe's
Jev decision model. It is off until you supply a key and switch a check on, and
each of the three checks is switched on separately. While it is on, short
extracts leave your browser to **one** endpoint — whichever key source you
picked:

- `https://openrouter.ai/api/alpha/decisions`, using one of your existing
  OpenRouter provider keys, or
- `https://api.typesafe.ai/v1/systemone`, using a TypeSafe key you add.

What each check sends, and nothing more:

- **Check risky actions before acting**: your own instruction for the current
  turn (up to 500 characters of it), the tool name, the page URL and title, and
  the visible label of the element about to be used — or, for a navigation, the
  URL it is about to open. Never anything the assistant types into the page, and
  never the value of a page field.

  Your instruction **is** sent, so: don't paste passwords, card numbers or API
  keys into the chat while this check is on. As a backstop, an instruction that
  matches a credential marker (`password`, `passcode`, `PIN`, `secret`, `API
  key`, `token`, `CVV`, a 13–19 digit number) is dropped from the request
  entirely — the check then runs on the tool, page and label alone.
- **Classify page text for hidden instructions**: up to 60,000 characters of the
  page text the assistant has just read. Never on a site matched by the built-in sensitive-site list (banks,
  payment processors, crypto exchanges — the same list that always requires
  per-action confirmation): there, only the built-in pattern check runs.
- **Scheduled tasks: only notify when the result changed**: the task's name, up
  to 500 characters of its prompt, and up to 4,000 characters each of the
  previous and the new result. The previous result is kept in
  `chrome.storage.local` so the next run has something to compare against; it
  never leaves your browser except in this request.

No identity fields are sent. OpenSidekick never sends the optional `user`,
`session_id`, or `trace` fields these APIs accept, and there is still no
account, sign-in, or identifier of any kind.

TypeSafe states that it does not train on data sent to its API. Its retention
period and processing region are not published, and zero-retention terms are
enterprise-only — so treat anything a check sends as disclosed to TypeSafe (and
to OpenRouter as well, if you route through it) under their own policies. If a
check is off, fails, or times out, the assistant behaves exactly as it does with
Smart checks disabled.

## What is NOT collected

- No analytics, tracking, or usage metrics.
- No accounts, sign-in, or user identifiers.
- No selling or sharing of data with third parties by this extension.

## Permissions and why they're needed

- **Host access (`<all_urls>`)**: to read and act on the pages you point the
  assistant at, and to call the model provider / local endpoint you configure.
- **`scripting` / `activeTab` / `tabs`**: to read the current page and perform
  actions across tabs on your behalf.
- **`storage`**: to save your providers, keys, preferences and, unless you turn it
  off, chat history locally.
- **`sidePanel`**: to show the assistant UI.
- **`contextMenus` / `notifications`**: right-click actions and status.

## Your control

- Remove a provider or key at any time in Settings.
- Manage or revoke per-site permissions in Settings → Site permissions.
- Delete a saved chat from the side panel's History menu, or all of them (with
  your prompt history) with **Clear all** there or **Clear history** in Settings
  → Chat history. Turn chat history off to delete it and stop saving.
- Uninstalling the extension deletes all locally stored data.

## Contact

Open an issue at https://github.com/esterhuizen/opensidekick for questions.
