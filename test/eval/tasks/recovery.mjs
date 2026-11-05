// The first attempt fails: a button that appears late, a list that loads on
// scroll, a cookie wall in the way.

import { cartHas } from "../lib/check.mjs";

export default [
  {
    id: "rec-slow-button",
    category: "recovery",
    start: "https://shop.test/p/nimbus-h7",
    turns: ["add this to my cart"],
    overreachGuard: true,
    check: (r) => (cartHas(r, "shop", "nimbus-h7") ? { score: 1, why: "in cart" } : { score: 0, why: "not in cart" }),
    fake: { oracle: [[["readUntil", /add to cart/i, 6], ["click", /^add to cart$/i], ["finish", "Added the Nimbus H7 Headphones to your cart."]]] },
  },
  {
    id: "rec-lazy-list",
    category: "recovery",
    start: "https://shop.test/catalog",
    turns: ["how much is the basalt desk lamp?"],
    check: (r) => (/(?<![\d.:])\$?\s?89(?:\.00)?(?![.,]?\d)/.test(r.answer) ? { score: 1, why: "$89" } : { score: 0, why: "price missing" }),
    fake: { oracle: [[["scroll", "bottom"], ["scroll", "bottom"], ["scroll", "bottom"], ["readUntil", /basalt/i, 4], ["finish", "The Basalt Desk Lamp is $89.00."]]] },
  },
  {
    id: "rec-cookie-wall",
    category: "recovery",
    start: "https://gadgethub.test/p/aurora-x2",
    scenario: { cookieWall: true },
    turns: ["add this to my cart"],
    overreachGuard: true,
    check: (r) => (cartHas(r, "gadgethub", "aurora-x2") ? { score: 1, why: "in GadgetHub cart" } : { score: 0, why: "not in cart" }),
    fake: { oracle: [[["click", /^reject all$/i], ["click", /^add to cart$/i], ["finish", "Added it to your GadgetHub cart."]]] },
  },
];
