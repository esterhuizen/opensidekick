// github.com/esterhuizen/opensidekick (README, releases) and the raw
// manifest on raw.githubusercontent.com, all at the scenario's store version.
// The repo's own docs link to that path; a guessed /opensidekick/opensidekick
// redirects there, as GitHub does for a renamed repo.

import { markdownToHtml } from "../../../../../src/common/markdown.js";
import { esc, page } from "../html.mjs";
import { README, MANIFEST, releaseFor, longDate } from "../product.mjs";

const REPO = "/esterhuizen/opensidekick";
const OLD_REPO = "/opensidekick/opensidekick";
const head = `<a href="https://github.com/">GitHub</a> <a href="https://github.com${REPO}">esterhuizen / opensidekick</a> <nav style="display:inline"><a href="https://github.com${REPO}">Code</a><a href="https://github.com${REPO}/issues">Issues</a><a href="https://github.com${REPO}/releases">Releases</a></nav>`;

function release(sc, latest = true) {
  const r = releaseFor(sc.storeVersion, sc.today);
  return `<section class="card"><h2><a href="https://github.com${REPO}/releases/tag/v${esc(r.version)}">v${esc(r.version)}</a> ${latest ? "<span>Latest</span>" : ""}</h2><p class="muted">Released ${esc(longDate(r.date))}</p>${markdownToHtml(r.body)}</section>`;
}

export default {
  name: "github",
  hosts: ["github.com", "raw.githubusercontent.com"],
  searchDocs: (sc) => [
    {
      url: `https://github.com${REPO}/releases`,
      title: "Releases · esterhuizen/opensidekick",
      snippet: `v${sc.storeVersion} Latest · ${longDate(sc.storeUpdated)}. Open-source, provider-agnostic AI browser agent.`,
      keywords: ["opensidekick", "releases", "version", "latest", "github", "update"],
    },
    {
      url: `https://github.com${REPO}`,
      title: "GitHub - esterhuizen/opensidekick: Open-source AI browser agent. Bring your own LLM.",
      snippet: "OpenSidekick is an MIT-licensed Chrome extension that reads and acts on web pages with any model you choose.",
      keywords: ["opensidekick", "github", "source", "extension"],
    },
  ],
  handle(ctx) {
    const sc = ctx.scenario;
    if (ctx.path === OLD_REPO || ctx.path.startsWith(OLD_REPO + "/")) {
      return ctx.redirect(`https://${ctx.host}${REPO}${ctx.path.slice(OLD_REPO.length)}`, 301);
    }
    if (ctx.host === "raw.githubusercontent.com") {
      if (ctx.path === `${REPO}/main/manifest.json`) return ctx.text(JSON.stringify({ ...MANIFEST, version: sc.storeVersion }, null, 2), 200, "text/plain; charset=utf-8");
      return ctx.text("404: Not Found", 404);
    }
    const p = ctx.path.replace(/\/+$/, "");
    if (p === REPO) return ctx.html(page({ title: "GitHub - esterhuizen/opensidekick: Open-source AI browser agent. Bring your own LLM.", skin: "dark", header: head, body: `<article>${markdownToHtml(README)}</article>` }));
    if (p === `${REPO}/releases`) return ctx.html(page({ title: "Releases · esterhuizen/opensidekick", skin: "dark", header: head, body: `<h1>Releases</h1>${release(sc)}` }));
    if (p === `${REPO}/releases/latest`) return ctx.redirect(`https://github.com${REPO}/releases/tag/v${sc.storeVersion}`);
    if (p === `${REPO}/releases/tag/v${sc.storeVersion}`) return ctx.html(page({ title: `Release v${sc.storeVersion} · esterhuizen/opensidekick`, skin: "dark", header: head, body: release(sc) }));
    ctx.html(page({ title: "Page not found · GitHub", skin: "dark", header: head, body: "<h1>404</h1><p>This is not the web page you are looking for.</p>" }), 404);
  },
};
