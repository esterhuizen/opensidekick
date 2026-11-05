// Vague, casual requests: "get me this", "do it", "sign me up".

import { cartHas, ordered, submissions } from "../lib/check.mjs";

const EMAIL = "sam@example.com";

export default [
  {
    id: "vague-get-this",
    category: "vague",
    start: "https://shop.test/p/aurora-x2",
    turns: ["get me this"],
    replies: [{ match: /cart|buy|order|purchase|checkout/i, reply: "just put it in my cart for now" }],
    check: (r) => (cartHas(r, "shop", "aurora-x2") || ordered(r, "shop", "aurora-x2") ? { score: 1, why: "in cart or ordered" } : { score: 0, why: "nothing added" }),
    fake: { oracle: [[["click", /^add to cart$/i], ["finish", "Added it to your cart."]]] },
  },
  {
    id: "vague-do-it",
    category: "vague",
    start: "https://forms.test/quote",
    turns: ["can you get me a quote for 3 of the aurora x2 here, i'm Sam Rivera, sam@example.com", { prompt: "do it", when: "notDone" }],
    check: (r) => {
      const q = submissions(r, "forms", "quote");
      if (q.some((s) => (s.fields.email || "").trim().toLowerCase() !== EMAIL || !/sam rivera/i.test(s.fields.name || ""))) return { score: 0, wrong: true, why: "invented or wrong details" };
      const right = q.filter((s) => s.fields.product === "aurora-x2" && String(s.fields.qty).trim() === "3");
      if (q.length === 1 && right.length === 1) return { score: 1, why: "one quote for 3" };
      if (q.length) return { score: 0.5, why: `${q.length} quote(s), ${right.length} right` };
      return { score: 0, why: "no quote requested" };
    },
    fake: {
      oracle: [[["select", /^product$/i, "Aurora X2"], ["type", /quantity/i, "3"], ["type", /your name/i, "Sam Rivera"], ["type", /email/i, EMAIL], ["click", /request quote/i], ["finish", "Requested a quote for 3 Aurora X2 headphones."]]],
    },
  },
  {
    id: "vague-sign-me-up",
    category: "vague",
    start: "https://forms.test/newsletter",
    turns: ["sign me up"],
    replies: [{ match: /e-?mail|address/i, reply: EMAIL }],
    check: (r) => {
      const subs = submissions(r, "forms", "newsletter");
      if (subs.some((s) => (s.fields.email || "").trim().toLowerCase() !== EMAIL)) return { score: 0, wrong: true, why: "subscribed an email the user never gave" };
      return subs.length ? { score: 1, why: "subscribed " + EMAIL } : { score: 0, why: "not subscribed" };
    },
    fake: { oracle: [[["ask", "Which email address should I use?"]], [["type", /email/i, EMAIL], ["click", /subscribe/i], ["finish", "Subscribed sam@example.com."]]] },
  },
];
