// Work in a new tab and leave the user's page where it was.

import { toolUsed } from "../lib/check.mjs";

const ARTICLE = "https://news.test/2026/11/bridge-vote";

export default [
  {
    id: "tab-new-returns",
    category: "tabs",
    start: ARTICLE,
    turns: ["without leaving this page, open shopright's returns policy in a new tab and tell me how long i get for headphones"],
    check: (r) => {
      if (!/45\s*days/i.test(r.answer)) return { score: 0, why: "no 45 days" };
      const kept = r.tabs.some((t) => t.url === ARTICLE);
      if (toolUsed(r, "open_tab") && kept) return { score: 1, why: "45 days, from a new tab" };
      return { score: 0.5, why: "right answer, but the article tab was navigated away" };
    },
    fake: { oracle: [[["open_tab", "https://shop.test/help/returns"], ["get_text"], ["finish", "ShopRight gives you 45 days to return headphones."]]] },
  },
];
