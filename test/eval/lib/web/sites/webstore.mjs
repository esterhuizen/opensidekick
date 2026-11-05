// chromewebstore.google.com. Chromium refuses to let any extension script or
// capture this host, even when we serve it, so the agent can only learn the
// tab title here. Kept faithful on purpose (design §2.2 spike 3).

import { esc, page } from "../html.mjs";
import { CWS_ID, longDate } from "../product.mjs";

const TITLE = "OpenSidekick — Bring-Your-Own-LLM Browser Agent - Chrome Web Store";
const DESC = "Open-source AI assistant that reads and acts on web pages using any model you choose. Your keys stay in your browser.";

function listing(sc) {
  return page({
    title: TITLE,
    skin: "store",
    desc: DESC,
    header: `<a href="https://chromewebstore.google.com/">chrome web store</a> <form action="/search" style="display:inline"><input name="q" aria-label="Search extensions"></form>`,
    body: `<h1>OpenSidekick — Bring-Your-Own-LLM Browser Agent</h1>
<p>opensidekick.app · ★ 4.8 (52 ratings) · 1,000+ users</p>
<button type="button">Remove from Chrome</button>
<h2>Overview</h2><p>${esc(DESC)}</p>
<h2>Details</h2>
<ul><li>Version ${esc(sc.storeVersion)}</li><li>Updated ${esc(longDate(sc.storeUpdated))}</li><li>Size 236KiB</li><li>Languages English</li></ul>`,
  });
}

export default {
  name: "webstore",
  hosts: ["chromewebstore.google.com"],
  searchDocs: () => [
    {
      url: `https://chromewebstore.google.com/detail/opensidekick/${CWS_ID}`,
      title: TITLE,
      snippet: DESC,
      keywords: ["opensidekick", "chrome web store", "extension", "web extensions", "install"],
    },
  ],
  handle(ctx) {
    if (ctx.path.startsWith("/detail/") && ctx.path.includes(CWS_ID)) return ctx.html(listing(ctx.scenario));
    if (ctx.path.startsWith("/search") || ctx.path === "/") {
      const link = `https://chromewebstore.google.com/detail/opensidekick/${CWS_ID}`;
      return ctx.html(page({ title: "Chrome Web Store", skin: "store", body: `<h1>Chrome Web Store</h1><div class="card"><a href="${link}">OpenSidekick — Bring-Your-Own-LLM Browser Agent</a><p>${esc(DESC)}</p></div>` }));
    }
    ctx.notFound();
  },
};
