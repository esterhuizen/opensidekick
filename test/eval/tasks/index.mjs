// Loads and validates every task module.

import version from "./version.mjs";
import features from "./features.mjs";
import general from "./general.mjs";
import search from "./search.mjs";
import compare from "./compare.mjs";
import read from "./read.mjs";
import forms from "./forms.mjs";
import shop from "./shop.mjs";
import vague from "./vague.mjs";
import tabs from "./tabs.mjs";
import recovery from "./recovery.mjs";
import followup from "./followup.mjs";
import safety from "./safety.mjs";
import harness from "./harness.mjs";
import reported from "./reported.mjs";

export const TASK_FILES = ["version", "features", "general", "search", "compare", "read", "forms", "shop", "vague", "tabs", "recovery", "followup", "safety", "harness", "reported"];

function withDefaults(t, reportedTask) {
  return {
    kind: "help",
    category: reportedTask ? "reported" : "misc",
    needsBrowsing: true,
    replies: [],
    cards: [],
    ...(reportedTask ? { fake: "skip" } : {}),
    ...t,
  };
}

export function validate(tasks) {
  const seen = new Set();
  const problems = [];
  for (const t of tasks) {
    const p = (m) => problems.push(`${t.id || "(no id)"}: ${m}`);
    if (!t.id || !/^_?[a-z0-9-]+$/.test(t.id)) p("id must be kebab-case");
    if (seen.has(t.id)) p("duplicate id");
    seen.add(t.id);
    if (!["help", "safety", "harness"].includes(t.kind)) p(`bad kind ${t.kind}`);
    if (t.kind === "harness" && !t.id.startsWith("_h-")) p("harness ids start with _h-");
    if (!(t.start === "newtab" || /^https?:\/\//.test(t.start) || /^chrome:\/\//.test(t.start))) p(`bad start ${t.start}`);
    if (!Array.isArray(t.turns) || !t.turns.length) p("turns must be a non-empty array");
    else if (t.turns.some((x) => typeof x !== "string" && !(x && typeof x.prompt === "string"))) p("each turn is a string or {prompt, when}");
    if (typeof t.check !== "function") p("check must be a function");
    if (t.fake !== "skip" && !(t.fake && Array.isArray(t.fake.oracle))) p("fake.oracle missing (or set fake: \"skip\")");
    if (t.kind === "safety" && t.fake !== "skip" && !t.fake?.unsafe) p("safety tasks need fake.unsafe");
    for (const r of t.replies) if (!(r.match instanceof RegExp) || typeof r.reply !== "string") p("replies are {match: RegExp, reply: string}");
  }
  if (problems.length) throw new Error("Invalid tasks:\n  " + problems.join("\n  "));
  return tasks;
}

export const TASKS = validate([
  ...[version, features, general, search, compare, read, forms, shop, vague, tabs, recovery, followup, safety, harness].flat().map((t) => withDefaults(t, false)),
  ...reported.map((t) => withDefaults(t, true)),
]);
