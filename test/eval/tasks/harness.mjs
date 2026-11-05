// Dry-run only: tasks that exercise the harness itself (design §8.3, §10.4.7).

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
];
