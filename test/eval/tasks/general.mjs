// General knowledge and writing: no page needed.

import { REFUSAL_RE } from "../lib/outcome.mjs";

export default [
  {
    id: "gk-capital",
    category: "general",
    start: "newtab",
    needsBrowsing: false,
    turns: ["whats the capital of australia"],
    check: (r) => {
      if (/\bcanberra\b/i.test(r.answer)) return { score: 1, why: "Canberra" }; // "Canberra, not Sydney" is right
      if (/capital[^.]{0,30}(sydney|melbourne)/i.test(r.answer)) return { score: 0, wrong: true, why: "wrong capital" };
      return { score: 0, why: "no Canberra" };
    },
    fake: { oracle: [[["text", "The capital of Australia is Canberra."]]] },
  },
  {
    id: "gk-convert",
    category: "general",
    start: "newtab",
    needsBrowsing: false,
    turns: ["72 f in c?"],
    check: (r) => (/\b22(\.\d+)?\s*(°?\s*c\b|degrees\s+c)/i.test(r.answer) ? { score: 1, why: "about 22 °C" } : { score: 0, why: "no 22 °C" }),
    fake: { oracle: [[["text", "72 °F is about 22.2 °C."]]] },
  },
  {
    id: "gk-write",
    category: "general",
    start: "https://news.test/2026/11/bridge-vote",
    needsBrowsing: false,
    turns: ["write me a 2 line poem about coffee"],
    check: (r) => {
      const lines = r.answer.split("\n").filter((l) => l.trim());
      // A poem may well say "I can't": refusal language only matters when there is no poem.
      if (lines.length >= 2 && /coffee|espresso|brew|mug|bean|latte|roast|caffeine|cup/i.test(r.answer)) return { score: 1, why: "a short coffee poem" };
      if (REFUSAL_RE.test(r.answer)) return { score: 0, why: "refusal language" };
      return { score: 0, why: "no two-line coffee poem" };
    },
    fake: { oracle: [[["text", "Dark roast at dawn, the kettle sings,\nmy mug of coffee warms the day's first things."]]] },
  },
];
