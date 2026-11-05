// Search engines (Google, Bing, DuckDuckGo, Brave, Ecosia): one shared index
// built from every fake site's searchDocs(), each engine in its own skin.

import { esc, page } from "../html.mjs";

const ENGINES = {
  "www.google.com": { name: "Google", skin: "google", action: "/search" },
  "www.bing.com": { name: "Bing", skin: "bing", action: "/search" },
  "duckduckgo.com": { name: "DuckDuckGo", skin: "ddg", action: "/" },
  "search.brave.com": { name: "Brave Search", skin: "plain", action: "/search" },
  "www.ecosia.org": { name: "Ecosia", skin: "plain", action: "/search" },
};

const STOP = new Set("a an and are at be by can do for from how i in is it me my of on or the this to what whats when where which who why with you your".split(" "));

export function tokens(s) {
  return [...new Set(String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w)))];
}

// Token overlap (title x2, keywords, snippet); ties keep index order.
export function rank(docs, q, max = 8) {
  const qt = tokens(q);
  return docs
    .map((d, i) => {
      const title = tokens(d.title);
      const kw = tokens((d.keywords || []).join(" "));
      const snip = tokens(d.snippet);
      const score = qt.reduce((s, w) => s + (title.includes(w) ? 2 : 0) + (kw.includes(w) ? 1 : 0) + (snip.includes(w) ? 1 : 0), 0);
      return { d, i, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, max)
    .map((x) => x.d);
}

function answerBox(q) {
  if (/weather/i.test(q) && /lisbon/i.test(q)) {
    return `<section class="card" aria-label="Weather"><h2>Lisbon — Tomorrow: 19° / 13°, light showers</h2><p class="muted">Wind 14 km/h · Humidity 72% · Source: Varnholt Weather Service</p></section>`;
  }
  return "";
}

export default {
  name: "search",
  hosts: Object.keys(ENGINES),
  init: () => ({}),
  handle(ctx) {
    const eng = ENGINES[ctx.host];
    const isResults = ctx.path === eng.action || ctx.path === "/search" || ctx.path === "/html/" || ctx.path === "/html";
    const q = ctx.query.get("q") || "";
    const form = `<form action="${eng.action}" method="get" role="search"><input name="q" aria-label="Search" value="${esc(q)}" size="50"> <button type="submit">${esc(eng.name)} Search</button></form>`;
    if (!isResults && ctx.path !== "/") return ctx.notFound();
    if (!q.trim()) {
      return ctx.html(page({ title: eng.name, skin: eng.skin, body: `<h1>${esc(eng.name)}</h1>${form}` }));
    }
    ctx.all.search.queries.push({ t: ctx.now, turn: ctx.turn, engine: ctx.host, q });
    const results = rank(ctx.index(), q);
    const list = results.length
      ? results.map((d) => `<div class="card"><a href="${esc(d.url)}"><h3>${esc(d.title)}</h3></a><div class="muted">${esc(d.url)}</div><p>${esc(d.snippet)}</p></div>`).join("")
      : `<p>Your search - <b>${esc(q)}</b> - did not match any documents.</p>`;
    ctx.html(page({ title: `${q} - ${eng.name} Search`, skin: eng.skin, header: form, body: answerBox(q) + list }));
  },
};
