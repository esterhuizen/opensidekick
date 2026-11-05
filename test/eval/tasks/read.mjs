// Reading the current page: summarise an article, turn a table into a list.

import { facts, words } from "../lib/check.mjs";
import { FERRY_ROUTES } from "../lib/web/sites/wiki.mjs";

const ARTICLE_FACTS = [/7\s*(–|-|to)\s*4/, /48\s*million/i, /2029/, /okafor/i, /ferr(y|ies)[^.]{0,40}(end|stop|cease|discontinu)/i];
const routeRe = (name) => new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+–\s+/, "\\s*[–—-]+\\s*"), "i");

export default [
  {
    id: "sum-article",
    category: "read",
    start: "https://news.test/2026/11/bridge-vote",
    turns: ["summarise this"],
    check: (r) => {
      const n = facts(r.answer, ARTICLE_FACTS);
      const w = words(r.answer);
      if (n >= 3 && w <= 250) return { score: 1, why: `${n}/5 facts, ${w} words` };
      if (n >= 2) return { score: 0.5, why: `${n}/5 facts, ${w} words` };
      return { score: 0, why: `${n}/5 facts` };
    },
    fake: {
      oracle: [[["get_text"], ["finish", "The council voted 7–4 to build the €48 million Harbour Bridge, due to open in 2029. Councillor Mireille Okafor opposed it, and the ferry service will end when the bridge opens."]]],
    },
  },
  {
    id: "tbl-list",
    category: "read",
    start: "https://wiki.test/wiki/Varnholt_ferry_routes",
    turns: ["turn that table into a list for me, just the route and the fare"],
    check: (r) => {
      const names = FERRY_ROUTES.filter(([name]) => routeRe(name).test(r.answer)).length;
      const fares = FERRY_ROUTES.filter(([, , , fare]) => r.answer.includes(fare.slice(1))).length;
      if (names === 8 && fares >= 7) return { score: 1, why: `${names} routes, ${fares} fares` };
      if (names >= 5) return { score: 0.5, why: `${names} routes, ${fares} fares` };
      return { score: 0, why: `${names} routes, ${fares} fares` };
    },
    fake: { oracle: [[["get_text"], ["finish", FERRY_ROUTES.map(([n, , , f]) => `- ${n}: ${f}`).join("\n")]]] },
  },
];
