// chrome-stats.com: a readable third-party page with the store version.

import { esc, page } from "../html.mjs";
import { CWS_ID, longDate } from "../product.mjs";

export default {
  name: "chromestats",
  hosts: ["chrome-stats.com"],
  searchDocs: (sc) => [
    {
      url: `https://chrome-stats.com/d/${CWS_ID}`,
      title: "OpenSidekick - Chrome Web Store stats, version history",
      snippet: `OpenSidekick — version ${sc.storeVersion}, updated ${longDate(sc.storeUpdated)}. Users, ratings and version history.`,
      keywords: ["opensidekick", "version", "chrome web store", "web extensions", "stats", "update", "latest"],
    },
  ],
  handle(ctx) {
    if (ctx.path !== `/d/${CWS_ID}`) return ctx.notFound();
    const sc = ctx.scenario;
    ctx.html(page({
      title: "OpenSidekick - Chrome Web Store stats, version history",
      header: `<a href="https://chrome-stats.com/">Chrome-Stats</a>`,
      body: `<h1>OpenSidekick — Bring-Your-Own-LLM Browser Agent</h1>
<table><tr><th>Version</th><td>${esc(sc.storeVersion)}</td></tr><tr><th>Last updated</th><td>${esc(longDate(sc.storeUpdated))}</td></tr><tr><th>Users</th><td>1,240</td></tr><tr><th>Rating</th><td>4.8 (52)</td></tr></table>
<p class="muted">Listing: chromewebstore.google.com/detail/${CWS_ID}</p>`,
    }));
  },
};
