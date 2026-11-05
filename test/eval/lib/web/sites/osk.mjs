// opensidekick.app: the README, CHANGELOG and PRIVACY policy rendered with
// the extension's own markdownToHtml, so the docs never drift from the repo.

import { markdownToHtml } from "../../../../../src/common/markdown.js";
import { page } from "../html.mjs";
import { README, PRIVACY, CHANGELOG, INSTALLED, cmpVersion, releaseFor, longDate } from "../product.mjs";

const nav = `<a href="https://opensidekick.app/">OpenSidekick</a><nav style="display:inline"><a href="https://opensidekick.app/docs">Docs</a><a href="https://opensidekick.app/changelog">Changelog</a><a href="https://opensidekick.app/privacy">Privacy</a><a href="https://github.com/esterhuizen/opensidekick">GitHub</a></nav>`;

// The changelog as the store version sees it: a synthetic entry on top when
// the scenario says the store is ahead of this checkout.
export function changelogFor(sc) {
  if (cmpVersion(sc.storeVersion, INSTALLED) <= 0) return CHANGELOG;
  const r = releaseFor(sc.storeVersion, sc.today);
  return CHANGELOG.replace(/^## \[Unreleased\]\s*$/m, `## [Unreleased]\n\n## [${r.version}] — ${r.date}\n\n${r.body}\n`);
}

const intro = README.split(/^## /m)[0];

export default {
  name: "osk",
  hosts: ["opensidekick.app"],
  searchDocs: (sc) => [
    {
      url: "https://opensidekick.app/changelog",
      title: "Changelog — OpenSidekick",
      snippet: `${sc.storeVersion} — ${longDate(sc.storeUpdated)}. All notable changes to OpenSidekick, the open-source browser agent.`,
      keywords: ["opensidekick", "changelog", "release notes", "whats new", "latest", "version", "update"],
    },
    {
      url: "https://opensidekick.app/docs",
      title: "OpenSidekick docs — setup, providers, local models",
      snippet: "Set up OpenSidekick with OpenRouter, Anthropic, Gemini, Ollama or LM Studio. Approval modes, site permissions, chat history.",
      keywords: ["opensidekick", "docs", "help", "ollama", "settings", "permissions", "how to"],
    },
    {
      url: "https://opensidekick.app/privacy",
      title: "Privacy policy — OpenSidekick",
      snippet: "What OpenSidekick stores, where, and what it sends to the model provider you choose.",
      keywords: ["opensidekick", "privacy", "data", "chats", "saved"],
    },
  ],
  handle(ctx) {
    const md = { "/": intro, "/docs": README, "/changelog": changelogFor(ctx.scenario), "/privacy": PRIVACY }[ctx.path.replace(/\/+$/, "") || "/"];
    if (md == null) return ctx.notFound();
    const titles = { "/": "OpenSidekick — the open-source browser agent", "/docs": "Docs — OpenSidekick", "/changelog": "Changelog — OpenSidekick", "/privacy": "Privacy — OpenSidekick" };
    ctx.html(page({ title: titles[ctx.path.replace(/\/+$/, "") || "/"], header: nav, body: `<article>${markdownToHtml(md)}</article>` }));
  },
};
