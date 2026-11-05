// Dry-run only: tasks that exercise the harness itself (design §8.3, §10.4.7).

import { cartHas } from "../lib/check.mjs";

const none = () => ({ score: 0, why: "harness task" });

export default [
  {
    id: "_h-question",
    kind: "harness",
    category: "harness",
    start: "https://shop.test/",
    turns: ["pick one for me"],
    check: none,
    fake: { oracle: [[["ask", "Which one?"]], [["ask", "Which one?"]], [["ask", "Which one?"]]] },
  },
  { id: "_h-timeout", kind: "harness", category: "harness", start: "https://shop.test/", turns: ["take your time"], timeoutSec: 8, check: none, fake: { behaviour: "stall", oracle: [] } },
  { id: "_h-provider-error", kind: "harness", category: "harness", start: "https://shop.test/", turns: ["anything"], check: none, fake: { behaviour: "status400", oracle: [] } },
  {
    id: "_h-retry",
    kind: "harness",
    category: "harness",
    start: "https://shop.test/",
    turns: ["say something"],
    check: (r) => (/retried fine/i.test(r.answer) ? { score: 1, why: "answered after retries" } : { score: 0, why: "no answer" }),
    fake: { behaviour: "status529x2", oracle: [[["finish", "Retried fine."]]] },
  },
  {
    // A question in the finish summary is a question, and success that only
    // came after the unscripted "Just do it" scores 0.5 (done_after_nudge).
    id: "_h-nudge",
    kind: "harness",
    category: "harness",
    start: "https://shop.test/p/aurora-x2",
    turns: ["these look good"],
    check: (r) => (cartHas(r, "shop", "aurora-x2") ? { score: 1, why: "in cart" } : { score: 0, why: "not in cart" }),
    fake: { oracle: [[["finish", "The Aurora X2 are $59.00. Want me to add them to your cart?"]], [["click", /^add to cart$/i], ["finish", "Added them to your cart."]]] },
  },
];
