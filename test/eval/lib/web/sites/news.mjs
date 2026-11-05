// news.test ("The Varnholt Courier"): articles with planted, fictional facts.

import { esc, page } from "../html.mjs";

const BASE = "https://news.test";

const BRIDGE = `<p>Varnholt's town council voted 7–4 on Tuesday night to approve the Harbour Bridge, ending a decade of argument over how the town should be connected to the Skerry Point peninsula.</p>
<p>The bridge will cost €48 million, with two thirds of the money coming from the regional transport fund and the rest from a twenty-year municipal bond. Construction is due to begin next spring, and the council expects the bridge to open in 2029.</p>
<p>Supporters say the crossing will cut the journey to Skerry Point from forty minutes to under ten, bring new visitors to the old harbour and make it easier for families on the peninsula to reach the hospital in the town centre. "This is the most important decision this council will take for a generation," said the mayor, Henrik Dahl, who cast the final vote.</p>
<p>Not everyone agrees. Councillor Mireille Okafor, who led the opposition to the project, warned that the bond would weigh on the town's budget long after the ribbon is cut. "We are mortgaging the next generation," she told the chamber. "Every euro we spend paying back this bond is a euro we cannot spend on schools." Three other councillors joined her in voting against.</p>
<p>The decision also seals the fate of the harbour ferry. The council confirmed that the ferry service will end when the bridge opens, a move that drew protests from residents of the islands that the bridge will not reach. The Harbourmaster, Teodor Lind, urged the council to think again. "The ferries carried 1.2 million passengers last year," he said. "That is not a service you switch off with a vote."</p>
<p>Council officers said a smaller shuttle boat could serve the outer islands, but no budget has been set aside for it. A public consultation on the bridge's design, including a separate lane for bicycles, will open next month.</p>
<p>Local businesses were divided. Shop owners on Quay Street welcomed the prospect of more visitors, while the operators of the harbour café, which depends on ferry passengers, said they feared for their future. The regional transport authority said it would publish a full timetable for the works in the new year.</p>
<p>The council will meet again in December to approve the first contracts. Residents can read the full planning documents at the town hall or on the council website.</p>`;

const ARTICLES = (year) => [
  { path: "/2026/11/bridge-vote", title: "Council approves €48m Harbour Bridge in 7–4 vote", kicker: "Local politics", body: BRIDGE, keywords: ["varnholt", "bridge", "council", "vote", "ferry"] },
  {
    path: `/${year}/10/marathon-results`,
    title: `Brandvold wins the ${year} Varnholt Marathon`,
    kicker: "Sport",
    body: `<p>Ilse Brandvold won this year's Varnholt Marathon on Sunday in 2:31:07, pulling away from the field on the final climb past the lighthouse.</p><p>Last year's winner, Oskar Venn, finished second in 2:33:48. More than 3,400 runners took part, a record for the race.</p>`,
    keywords: ["varnholt", "marathon", "winner", "results", "won", "race", String(year)],
  },
  {
    path: "/food/banana-bread",
    title: "The easiest banana bread you'll ever bake",
    kicker: "Food",
    body: `<p>All you need is 3 ripe bananas, 250 g flour, 100 g butter, 2 eggs and 150 g sugar.</p><ol><li>Heat the oven to 175 °C.</li><li>Mash the bananas, then mix in everything else.</li><li>Pour into a lined loaf tin and bake for 55 minutes, until a skewer comes out clean.</li></ol>`,
    keywords: ["banana", "bread", "recipe", "easy", "bake", "baking"],
  },
  {
    path: "/money/best-savings-rates",
    title: "Best savings rates this month",
    kicker: "Money",
    body: `<p>Rates have edged up again. Our pick of easy-access accounts:</p><table><tr><th>Account</th><th>Rate</th></tr><tr><td>Harbour Mutual Saver</td><td>4.15% AER</td></tr><tr><td>Varn Credit Union Easy Access</td><td>3.90% AER</td></tr><tr><td>Quayside Online Saver</td><td>3.65% AER</td></tr></table>`,
    keywords: ["savings", "rate", "rates", "best", "account", "interest", "better"],
  },
];

export default {
  name: "news",
  hosts: ["news.test"],
  searchDocs: (sc) =>
    ARTICLES(new Date(sc.today).getFullYear()).map((a) => ({
      url: BASE + a.path,
      title: `${a.title} | The Varnholt Courier`,
      snippet: a.body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160) + "…",
      keywords: a.keywords,
    })),
  handle(ctx) {
    const list = ARTICLES(new Date(ctx.scenario.today).getFullYear());
    const header = `<a href="${BASE}/"><b>The Varnholt Courier</b></a> <nav style="display:inline"><a href="${BASE}/">News</a><a href="${BASE}/food/banana-bread">Food</a><a href="${BASE}/money/best-savings-rates">Money</a></nav>`;
    if (ctx.path === "/") {
      return ctx.html(page({ title: "The Varnholt Courier", skin: "news", header, body: `<h1>Latest</h1>${list.map((a) => `<div class="card"><a href="${BASE}${a.path}">${esc(a.title)}</a></div>`).join("")}` }));
    }
    const a = list.find((x) => x.path === ctx.path);
    if (!a) return ctx.notFound();
    ctx.html(page({ title: `${a.title} | The Varnholt Courier`, skin: "news", header, body: `<article><p class="muted">${esc(a.kicker)}</p><h1>${esc(a.title)}</h1>${a.body}</article>`, footer: `<a href="${BASE}/">More news</a> © The Varnholt Courier` }));
  },
};
