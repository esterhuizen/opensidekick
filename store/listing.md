# Chrome Web Store — Listing Copy & Submission Guide

This file contains ready-to-paste listing text and a step-by-step checklist for
publishing OpenSidekick to the Chrome Web Store.

> Replace `OWNER` with your GitHub org/user, and swap in your real hosted PRIVACY
> URL before submitting.

---

## Listing copy

**Name** (max 45 chars)

```
OpenSidekick — BYO-LLM Browser Agent
```

**Summary** (max 132 chars)

```
Open-source AI agent for your browser. Reads & acts on pages using any LLM: OpenRouter, OpenAI, Claude, Gemini, or a local model.
```

**Category:** Productivity
**Language:** English

**Detailed description** (paste into the "Description" field)

```
OpenSidekick puts an AI agent in your browser's side panel — one that can read
the page you're on and act on it: click, type, fill forms, navigate, and work
across tabs.

Unlike closed assistants, you bring your own model. Point OpenSidekick at
OpenRouter, OpenAI, Anthropic (Claude), Google Gemini, Groq, or a local model
running in Ollama or LM Studio. Your API keys stay in your browser and are sent
only to the provider you choose. There is no OpenSidekick account, no middleman,
and no telemetry.

WHAT IT CAN DO
• Summarize or answer questions about the current page
• Extract information (emails, prices, tables, links)
• Fill in forms and click through multi-step flows
• Search and navigate on your behalf
• Work across multiple tabs to complete a task

BRING YOUR OWN MODEL
• OpenAI-compatible: OpenRouter, OpenAI, Google Gemini, Groq, Together,
  DeepSeek, Ollama, LM Studio, or any custom endpoint
• Anthropic Messages API
• Local models supported — nothing leaves your machine

PRIVATE BY DESIGN
• Keys and settings stored locally in your browser
• Requests go straight to your chosen provider
• No analytics, no tracking, no accounts
• 100% open source (MIT) — audit or fork it on GitHub

SAFE BY DEFAULT
• "Ask before acting" mode confirms actions on new sites
• Sensitive sites (banking, payments, crypto) always ask per action
• The agent won't bypass logins or CAPTCHAs — it hands those back to you

Open source: https://github.com/esterhuizen/opensidekick
```

**Screenshots:** 1280×800 or 640×400 PNG/JPEG (at least one, up to five).
Suggested shots: (1) the side panel summarizing a page, (2) an agentic task with
the action log visible, (3) the Settings/provider screen.

**Small promo tile** (optional): 440×280.

---

## Single-purpose & permission justifications

The store review asks you to justify each permission. Ready answers:

| Permission | Justification |
| --- | --- |
| Host access `<all_urls>` | Required to read and act on the web pages the user asks the assistant to work on, and to send requests to the user-configured LLM provider or local model endpoint. |
| `scripting` | To inject the page-reading/action content script into the active tab on demand. |
| `activeTab` / `tabs` | To identify the active tab and perform multi-tab tasks the user requests. |
| `storage` | To store the user's providers, API keys, and preferences locally. |
| `sidePanel` | To display the assistant UI in Chrome's side panel. |
| `contextMenus` | Right-click "Ask about selection" / "Summarize page" entry points. |
| `notifications` | Optional status notifications. |

**Single purpose statement:**

```
OpenSidekick is a single-purpose AI assistant that reads and acts on the current
web page on the user's behalf, using a language model the user configures.
```

**Data usage disclosures** (Privacy practices tab):
- Does the extension collect user data? Personally identifiable info / web
  content are **handled** (sent to the user's chosen model provider) but **not
  collected by the developer**. Select the relevant "handled" categories
  (Personal communications / Web content) and certify:
  - Not sold to third parties.
  - Only used for the item's single purpose.
  - Not used for creditworthiness/lending.
- Provide a **Privacy Policy URL** (host `PRIVACY.md` publicly, e.g. on GitHub
  Pages, and link it).

---

## Submission checklist

1. **Prep the package**
   - [ ] Replace every `OWNER` placeholder with your GitHub handle.
   - [ ] Host `PRIVACY.md` at a public URL and note it.
   - [ ] Bump `version` in `manifest.json` if needed.
   - [ ] Build the zip: `npm run zip` (produces `opensidekick.zip` containing
         `manifest.json`, `src/`, `icons/`, `LICENSE`).
2. **Create a developer account**
   - [ ] Go to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
   - [ ] Pay the one-time US$5 registration fee (per account).
   - [ ] Verify your email / set up the account.
3. **Create the item**
   - [ ] Click **Add new item** and upload `opensidekick.zip`.
   - [ ] Fill in name, summary, description (copy above), and category.
   - [ ] Upload at least one screenshot and the 128×128 store icon.
4. **Privacy tab**
   - [ ] Add the Privacy Policy URL.
   - [ ] Complete the permission justifications (table above).
   - [ ] Complete the data-usage disclosures and certifications.
5. **Distribution**
   - [ ] Choose visibility (Public, Unlisted, or Private/Trusted testers).
   - [ ] Select target regions (default: all).
6. **Submit for review**
   - [ ] Click **Submit for review**. Review typically takes a few hours to a
         few business days; extensions with broad host permissions may take
         longer.
7. **After approval**
   - [ ] Share the store link; add it and a "Available in the Chrome Web Store"
         badge to the README.
   - [ ] Tag the release on GitHub to match the published version.

### Tips to pass review smoothly

- Broad host permissions (`<all_urls>`) get extra scrutiny. The permission
  justifications above explain *why each is necessary* — keep them specific.
- Make sure the description clearly states the extension needs a user-provided
  API key or local model to function (reviewers test the flow).
- Don't include remote/hosted code — everything runs from the packaged files
  (this project already complies; there is no remote code execution).
- Keep the single-purpose statement tight; multi-purpose framing is a common
  rejection reason.

### Edge, Brave, and other Chromium browsers

The same unpacked/packaged extension loads in any Chromium 116+ browser. To also
list on the **Microsoft Edge Add-ons** store, use the
[Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/) — the
same zip works; the listing flow mirrors the steps above.
