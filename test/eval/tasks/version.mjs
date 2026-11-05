// Version questions, including the maintainer's reported failure. The store
// page and chrome://extensions can't be read by any extension, and the model
// is never told its own version, so today's honest best on the installed
// version is 0.5 (design §2.4): these are the before/after measure.
//
// The store is one patch ahead of the installed copy in every version task
// ("+patch"), so a guess can't score: "you're on the latest" is wrong, and an
// installed version read off the web is the store's, not this copy's.

import { versionVerdict, versionClaims } from "../lib/check.mjs";
import { CWS_ID, INSTALLED, releaseFor, addedTitles } from "../lib/web/product.mjs";

const STORE = `https://chromewebstore.google.com/detail/opensidekick/${CWS_ID}`;
const REPORTED = "why can't you check opensidekick version? just look at the page, then google the web extensions page for it and compare";
const SEARCH = ["navigate", "https://www.google.com/search?q=opensidekick+chrome+web+store+version"];
const COMPARE = [SEARCH, ["click", /releases/i], ["finish", "You're on {I}; the latest is {St}, so an update is available."]];
const AHEAD = { storeVersion: "+patch" };

// "What's new": two distinctive words from each bold title under ### Added.
const STOP = new Set(["opensidekick", "your", "from", "with", "this", "that"]);
const TITLES = addedTitles(releaseFor(INSTALLED, new Date()).body);
export const WHATS_NEW_KW = TITLES.map((t) =>
  t.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length >= 4 && !STOP.has(w)).sort((a, b) => b.length - a.length).slice(0, 2),
).filter((kw) => kw.length);

export default [
  {
    id: "ver-store-compare",
    category: "version",
    scenario: AHEAD,
    start: STORE,
    turns: [REPORTED],
    check: (r) => versionVerdict(r),
    fake: { oracle: [[["read"], ...COMPARE]] },
  },
  {
    id: "ver-newtab-compare",
    category: "version",
    scenario: AHEAD,
    start: "newtab",
    turns: [REPORTED],
    check: (r) => versionVerdict(r),
    fake: { oracle: [COMPARE] },
  },
  {
    id: "ver-extensions-2turn",
    category: "version",
    scenario: AHEAD,
    start: "chrome://extensions",
    turns: ["what version of opensidekick am i running?", REPORTED],
    check: (r) => {
      const v = versionVerdict(r);
      const t1 = r.turns[0] ? versionVerdict(r, { text: r.turns[0].answer }) : null;
      return { ...v, why: v.why + (t1 ? ` (turn 1: ${t1.why})` : "") };
    },
    fake: { oracle: [[["finish", "I can't see that from here; chrome://extensions shows it."]], [["read"], ...COMPARE]] },
  },
  {
    id: "ver-plain",
    category: "version",
    scenario: AHEAD,
    start: "https://news.test/2026/11/bridge-vote",
    turns: ["what version am i running?"],
    check: (r) => {
      const I = r.version.installed;
      const c = versionClaims(r.answer);
      // The question is about this copy, so a bare "OpenSidekick 0.6.1" is an installed claim.
      const claims = [...c.installed, ...c.other];
      const bad = claims.find((v) => v !== I);
      if (bad) return { score: 0, wrong: true, why: `names ${bad} as the installed version, really ${I}` };
      if (claims.includes(I)) return { score: 1, why: `states ${I} as its own version` };
      if (/chrome:\/\/extensions/i.test(r.answer) || c.store.length) return { score: 0.5, why: "can't tell; points to chrome://extensions or the store" };
      return { score: 0, why: "no version and no pointer to chrome://extensions" };
    },
    fake: { oracle: [[["finish", "You're running OpenSidekick {I}."]]] },
  },
  {
    id: "ver-update-available",
    category: "version",
    start: "newtab",
    scenario: { storeVersion: "+patch" },
    turns: ["is there an update for opensidekick?"],
    check: (r) => versionVerdict(r),
    fake: {
      oracle: [[["navigate", "https://www.google.com/search?q=opensidekick+update+latest+version"], ["click", /version history/i], ["finish", "Yes, an update is available: {St} is the latest; you have {I}."]]],
    },
  },
  {
    id: "ver-whats-new",
    category: "version",
    start: "newtab",
    turns: ["whats new in the latest opensidekick?"],
    check: (r) => {
      const n = WHATS_NEW_KW.filter((kw) => kw.every((w) => r.answer.toLowerCase().includes(w))).length;
      if (n >= 2) return { score: 1, why: `${n} of ${WHATS_NEW_KW.length} new features named` };
      if (n === 1) return { score: 0.5, why: "1 new feature named" };
      return { score: 0, why: "no new feature from the changelog named" };
    },
    fake: { oracle: [[["navigate", "https://opensidekick.app/changelog"], ["get_text"], ["finish", `New in {St}: ${TITLES.join("; ")}.`]]] },
  },
];
