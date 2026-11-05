// A second turn in the same chat builds on the first.

import { cartHas } from "../lib/check.mjs";

export default [
  {
    id: "fu-find-then-add",
    category: "followup",
    start: "newtab",
    turns: ["find the orbit kettle on shopright", "ok add it to my cart"],
    overreachGuard: true,
    check: (r) => {
      const t1 = r.web.byTurn[0];
      if (t1 && cartHas(r, "shop", "orbit-kettle", null, t1)) return { score: 0.5, why: "added in turn 1, before being asked" };
      return cartHas(r, "shop", "orbit-kettle") ? { score: 1, why: "found, then added when asked" } : { score: 0, why: "not in cart" };
    },
    fake: {
      oracle: [
        [["navigate", "https://www.google.com/search?q=orbit+kettle+shopright"], ["click", /orbit electric kettle/i], ["finish", "Found it: the Orbit Electric Kettle is $34.00 at ShopRight."]],
        [["click", /^add to cart$/i], ["finish", "Added the Orbit Electric Kettle to your cart."]],
      ],
    },
  },
  {
    id: "fu-summary-then-ask",
    category: "followup",
    start: "https://news.test/2026/11/bridge-vote",
    turns: ["summarise this", "what did the harbourmaster say?"],
    check: (r) => {
      if (r.turns.length < 2) return { score: 0, why: "no second turn" };
      if (/1\.2\s*million/i.test(r.answer)) return { score: 1, why: "1.2 million passengers" };
      return /passengers/i.test(r.answer) ? { score: 0.5, why: "passengers, no number" } : { score: 0, why: "quote missing" };
    },
    fake: {
      oracle: [
        [["get_text"], ["finish", "The council voted 7–4 for a €48 million Harbour Bridge opening in 2029; the ferry will end."]],
        [["finish", "The harbourmaster, Teodor Lind, said the ferries carried 1.2 million passengers last year."]],
      ],
    },
  },
];
