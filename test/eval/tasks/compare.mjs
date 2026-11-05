// Look something up on a second site and compare.

export default [
  {
    id: "cmp-price",
    category: "compare",
    start: "https://shop.test/p/aurora-x2",
    turns: ["is this cheaper on gadgethub?"],
    check: (r) => {
      const a = r.answer;
      if (/shopright\s+(?:is|'s)\s+(?:cheaper|less expensive)|gadgethub\s+is\s+(?:more expensive|pricier|not cheaper)|(?:not|isn'?t)\s+cheaper\s+(?:on|at)\s+gadgethub/i.test(a)) return { score: 0, wrong: true, why: "says ShopRight is cheaper" };
      const yes = /\byes\b|cheaper|less|lower/i.test(a);
      if (yes && /54\.50/.test(a) && (/\b59(\.00)?\b/.test(a) || /4\.50/.test(a))) return { score: 1, why: "GadgetHub cheaper, both prices" };
      if (yes && /gadgethub/i.test(a)) return { score: 0.5, why: "right direction, numbers missing" };
      return { score: 0, why: "no comparison" };
    },
    fake: { oracle: [[["navigate", "https://gadgethub.test/p/aurora-x2"], ["read"], ["finish", "Yes: GadgetHub has it for $54.50 versus $59.00 here, so it's $4.50 cheaper."]]] },
  },
];
