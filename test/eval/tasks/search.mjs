// Starting from a new tab: the agent has to search.

const google = (q) => ["navigate", "https://www.google.com/search?q=" + encodeURIComponent(q).replace(/%20/g, "+")];

export default [
  {
    id: "srch-marathon",
    category: "search",
    start: "newtab",
    turns: ["who won the varnholt marathon this year?"],
    check: (r) => (/brandvold/i.test(r.answer) ? { score: 1, why: "Brandvold" } : { score: 0, why: "winner not named" }),
    fake: { oracle: [[google("varnholt marathon winner"), ["click", /marathon/i], ["get_text"], ["finish", "Ilse Brandvold won this year's Varnholt Marathon in 2:31:07."]]] },
  },
  {
    id: "srch-weather",
    category: "search",
    start: "newtab",
    turns: ["weather in lisbon tomorrow?"],
    check: (r) => {
      const n = [/\b19\s*(°|degrees)/i, /shower|rain/i].filter((re) => re.test(r.answer)).length;
      return n === 2 ? { score: 1, why: "19° and showers" } : n === 1 ? { score: 0.5, why: "one of temperature/showers" } : { score: 0, why: "no forecast" };
    },
    fake: { oracle: [[google("lisbon weather tomorrow"), ["read"], ["finish", "Tomorrow in Lisbon: 19° high, 13° low, light showers."]]] },
  },
  {
    id: "srch-recipe",
    category: "search",
    start: "newtab",
    turns: ["find me an easy banana bread recipe, how long does it bake for?"],
    check: (r) => {
      const n = [/55\s*min/i, /175/].filter((re) => re.test(r.answer)).length;
      return n === 2 ? { score: 1, why: "55 min at 175 °C" } : n === 1 ? { score: 0.5, why: "time or temperature" } : { score: 0, why: "no bake time" };
    },
    fake: { oracle: [[google("easy banana bread recipe"), ["click", /banana bread/i], ["get_text"], ["finish", "Bake it at 175 °C for 55 minutes (recipe: The Varnholt Courier)."]]] },
  },
];
