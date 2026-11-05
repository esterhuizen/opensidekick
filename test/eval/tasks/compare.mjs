// Look something up on a second site and compare. Each price is read as the
// amount nearest to the shop's name in the same sentence, so "GadgetHub
// charges $59.00 vs $54.50 here" is caught as the wrong way round.

import { nearestAmount } from "../lib/check.mjs";

const GH = /gadget\s?hub/i;
const SR = /shop\s?right|\bhere\b|this (?:page|site|shop|one)/i;
const google = (q) => ["navigate", "https://www.google.com/search?q=" + encodeURIComponent(q).replace(/%20/g, "+")];

export default [
  {
    id: "cmp-price",
    category: "compare",
    start: "https://shop.test/p/aurora-x2",
    turns: ["is this cheaper on gadgethub?"],
    check: (r) => {
      const a = r.answer;
      if (/^\W*no\b/i.test(a) || /shopright\s+(?:is|'s)\s+(?:cheaper|less expensive)|gadgethub\s+is\s+(?:more expensive|pricier|not cheaper)|(?:not|isn'?t)\s+cheaper\s+(?:on|at)\s+gadgethub|\bit(?:'s|\s+is)\s+not\s+cheaper/i.test(a)) return { score: 0, wrong: true, why: "says ShopRight is cheaper" };
      const gh = nearestAmount(a, GH);
      if (gh === 59) return { score: 0, wrong: true, why: "gives GadgetHub the $59.00 price" };
      const yes = /\byes\b|\bcheaper\b|\blower\b|\bless\s+(?:expensive|than)\b|\bsaves?\b/i.test(a);
      if (yes && gh === 54.5 && (nearestAmount(a, SR) === 59 || /(?<![\d.])4\.50(?!\d)/.test(a))) return { score: 1, why: "GadgetHub cheaper, both prices" };
      if (yes && GH.test(a)) return { score: 0.5, why: "right direction, numbers missing or unattributed" };
      return { score: 0, why: "no comparison" };
    },
    fake: { oracle: [[["navigate", "https://gadgethub.test/p/aurora-x2"], ["read"], ["finish", "Yes: GadgetHub has it for $54.50 versus $59.00 here, so it's $4.50 cheaper."]]] },
  },
  {
    id: "cmp-kettle-newtab",
    category: "compare",
    start: "newtab",
    turns: ["where's the orbit kettle cheaper, shopright or gadgethub?"],
    check: (r) => {
      const a = r.answer;
      const sr = nearestAmount(a, /shop\s?right/i);
      const gh = nearestAmount(a, GH);
      const srCheaper = /shop\s?right[^.;]{0,40}\b(?:cheaper|less expensive|lower|better (?:price|deal))|(?:cheaper|less expensive|lower)[^.;]{0,30}\bshop\s?right|gadget\s?hub[^.;]{0,30}\b(?:more expensive|pricier|dearer|costs more)/i.test(a);
      const ghCheaper = /gadget\s?hub\s+(?:is|'s|has it)\s+(?:\w+\s+)?(?:cheaper|less expensive|lower)/i.test(a);
      if (sr === 36.5 || gh === 34 || (ghCheaper && !srCheaper)) return { score: 0, wrong: true, why: "says GadgetHub is cheaper, or swaps the prices" };
      if (srCheaper && sr === 34 && gh === 36.5) return { score: 1, why: "ShopRight cheaper, $34.00 vs $36.50" };
      if (srCheaper) return { score: 0.5, why: "right shop, prices missing or unattributed" };
      return { score: 0, why: "no comparison" };
    },
    fake: { oracle: [[google("orbit kettle price"), ["read"], ["finish", "ShopRight is cheaper: the Orbit Electric Kettle is $34.00 there versus $36.50 at GadgetHub."]]] },
  },
];
