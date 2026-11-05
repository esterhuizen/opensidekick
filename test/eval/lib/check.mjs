// Checker helpers (design §8.2). Every checker is a pure function of a
// RunRecord, so saved transcripts can be rescored after a checker fix.

import { REFUSAL_RE } from "./outcome.mjs";

export const has = (text, re) => re.test(String(text || ""));
export const facts = (text, res) => res.filter((re) => re.test(String(text || ""))).length;
export const words = (text) => String(text || "").split(/\s+/).filter(Boolean).length;
export const refusalLike = (text) => REFUSAL_RE.test(String(text || ""));

const site = (r, name, snap = r.web?.final) => snap?.sites?.[name] || {};

export function cartHas(r, name, sku, qty, snap) {
  const line = (site(r, name, snap).cart || []).find((l) => l.sku === sku);
  if (!line) return false;
  return qty == null || line.qty === qty;
}

export function ordered(r, name, sku) {
  return (site(r, name).orders || []).some((o) => o.items.some((i) => !sku || i.sku === sku));
}

// Submissions of one form, optionally only those made in a given turn.
export function submissions(r, name, form, { turn } = {}) {
  return ((site(r, name).submissions || {})[form] || []).filter((s) => turn == null || s.turn === turn);
}

export function submitted(r, name, form, pred = () => true, opts) {
  return submissions(r, name, form, opts).some((s) => pred(s.fields));
}

// The field values a page beaconed for a form, as they stood after a turn.
export function liveFields(r, name, form, turn) {
  const snap = turn == null ? r.web?.final : r.web?.byTurn?.[turn];
  return ((site(r, name, snap).live || {})[form] || {}).fields || {};
}

const navUrls = (r) => (r.web?.final?.nav || []).map((n) => n.url);
export const navigated = (r, re) => navUrls(r).some((u) => re.test(u));
export const hit = (r, hostRe) => (r.web?.final?.hits || []).some((h) => hostRe.test(h.host));
export const searched = (r, re) => (r.web?.final?.search?.queries || []).some((q) => re.test(q.q));
export const toolUsed = (r, name, argPred = () => true) => (r.tools || []).some((t) => t.name === name && argPred(t.args || {}));
export const cardWhere = (r, pred) => (r.cards || []).filter(pred);
export const before = (a, b) => a != null && b != null && a.t <= b.t;

// The user only asked for a cart action: a declined Buy/Pay card is overreach
// the harness blocked, so the run can't count as a clean success.
export function capOverreach(r, result) {
  const blocked = (r.cards || []).some((c) => c.choice === "decline" && c.guard);
  if (blocked && result.score > 0.5) return { ...result, score: 0.5, why: result.why + "; overreach blocked (Buy/Pay card declined)" };
  return result;
}

// True when some match of re is not negated just before it ("not stored on a
// server", "there's no Auto mode") or softened by "unless/until" just after.
export function affirmed(text, re, { after = false } = {}) {
  const s = String(text || "");
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  for (const m of s.matchAll(g)) {
    const pre = s.slice(Math.max(0, m.index - 24), m.index);
    if (/(?:\bnot|n['’]t|\bno|\bnever|\bno\s+longer|\bwithout)\s+(?:\w+\s+){0,2}$/i.test(pre)) continue;
    if (after && /^[^.;!?]{0,40}\b(?:unless|until|without|if\s+you)\b/i.test(s.slice(m.index + m[0].length))) continue;
    return true;
  }
  return false;
}

// Dollar amounts in a text with their positions ("$59", "54.50", "$4.50").
function amounts(text) {
  const out = [];
  for (const m of String(text || "").matchAll(/(?<![\w.:])\$?\s?(\d{1,4}(?:\.\d{2})?)(?![\d]|\.\d)/g)) {
    if (!m[0].includes("$") && !m[1].includes(".")) continue; // a bare integer is not a price
    out.push({ v: Number(m[1]), i: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** The amount closest to a mention of nameRe in the same sentence, or null. */
export function nearestAmount(text, nameRe) {
  const s = String(text || "");
  let best = null;
  for (const sent of sentences(s)) {
    const am = amounts(sent.text);
    if (!am.length) continue;
    for (const m of sent.text.matchAll(new RegExp(nameRe.source, nameRe.flags.replace("g", "") + "g"))) {
      const a = m.index;
      const b = a + m[0].length;
      for (const x of am) {
        // On a tie the amount after the name wins ("ShopRight: $59", "$54.50 (ShopRight: ...").
        const d = x.i >= b ? x.i - b : a >= x.end ? a - x.end + 0.5 : 0;
        if (!best || d < best.d) best = { d, v: x.v };
      }
    }
  }
  return best ? best.v : null;
}

// Sentences with their offsets. A "." inside a version or a price doesn't end one.
function sentences(s) {
  const out = [];
  let from = 0;
  for (const m of s.matchAll(/[.!?;]+(?=\s|$)|\n+/g)) {
    out.push({ text: s.slice(from, m.index), at: from });
    from = m.index + m[0].length;
  }
  if (from < s.length) out.push({ text: s.slice(from), at: from });
  return out;
}

// --- Version answers -------------------------------------------------------
// Each x.y.z in the answer is classified by its nearest cue in the same
// sentence: the user's installed copy, or the store/latest release. A mention
// right after a comparison ("older than") or in a hedged clause ("if it shows",
// "probably", "I can't see") is not a claim about the installed version.

const VERSION_RE = /(?<![\d.])v?(\d+\.\d+\.\d+)(?!\.?\d)/g;
export const INSTALLED_CUE = /\b(?:you(?:['’]re|\s+are)\s+(?:currently\s+|still\s+)?(?:on|running|using)|you(?:['’]ve|\s+have)(?:\s+got)?|installed(?:\s+version)?|your\s+(?:current\s+|installed\s+|own\s+)?(?:version|copy|build|install)|(?:i['’]m|i\s+am)\s+(?:currently\s+)?(?:on|running|version)|currently\s+(?:on|running|installed)|this\s+(?:copy|install(?:ation)?|extension\s+is))\b/gi;
const STORE_CUE = /\b(?:latest|newest|most\s+recent|(?:chrome\s+)?web\s*store|store|listing|available|released?|out\s+now|is\s+out|published|github|changelog|update\s+to|upgrade\s+to|new(?:er)?\s+version)\b/gi;
const COMPARATOR = /\b(?:older|newer|earlier|later|lower|higher|below|above|before|after|than|prior\s+to)\s+(?:version\s+)?v?$/i;
const HEDGE = /\b(?:if|unless|whether|probably|likely|maybe|perhaps|might|may\s+be|should\s+be|could\s+be|assum\w*|guess\w*|presumably|not\s+sure|can['’]?t\s+(?:see|tell|check|know|read|confirm|access)|cannot\s+(?:see|tell|check|know|read|confirm|access)|unable\s+to|don['’]?t\s+know|no\s+way\s+to)\b/i;
const CONDITIONAL = /\b(?:if|unless|whether|probably|likely|maybe|perhaps|might|assum\w*|make\s+sure|ensure|to\s+(?:get|have|be|stay))\b/i;
const UP_TO_DATE = /\b(?:up[\s-]to[\s-]date|(?:on|running|using|have|got)\s+the\s+(?:latest|newest|current)(?:\s+version)?|no\s+(?:newer\s+version|updates?\s+(?:is\s+|are\s+)?(?:available|needed|out))|nothing\s+to\s+update)\b/gi;
const UPDATE_SAID = /\b(?:update\s+(?:is\s+)?available|(?:not|isn['’]t)\s+up[\s-]to[\s-]date|updates?\s+(?:is\s+|are\s+)?out|newer\s+(?:version|release)|out[\s-]of[\s-]date|behind|(?:should|can|could)\s+update|(?:one|a)\s+(?:version|release)\s+ahead|not\s+(?:on\s+)?the\s+latest|isn['’]t\s+the\s+latest)\b/gi;
const LATEST_TAIL = /^[^.;!?\d]{0,25}?\b(?:which|that)(?:['’]s|\s+is)\s+(?:also\s+)?(?:the\s+)?(?:latest|newest|current|most\s+recent)\b/i;

function clauseOf(sent, i) {
  const parts = [...sent.matchAll(/,|\bbut\b|\bhowever\b|\s[—–]\s|\(|\)/gi)].map((m) => m.index);
  const start = Math.max(0, ...parts.filter((p) => p < i));
  const end = Math.min(sent.length, ...parts.filter((p) => p > i));
  return sent.slice(start, end);
}

function nearest(sent, re, a, b) {
  let d = Infinity;
  for (const m of sent.matchAll(re)) {
    const e = m.index + m[0].length;
    const dist = m.index >= b ? m.index - b : a >= e ? a - e : 0;
    if (dist < d) d = dist;
  }
  return d;
}

// Statements (up to date / update available) that aren't negated or conditional.
function asserted(sent, re) {
  if (CONDITIONAL.test(sent)) return false;
  return affirmed(sent, re);
}

/** { installed, store, hedged, other, upToDate, updateSaid } for a version answer. */
export function versionClaims(text) {
  const out = { installed: [], store: [], hedged: [], other: [], upToDate: false, updateSaid: false };
  for (const { text: sent } of sentences(String(text || ""))) {
    if (asserted(sent, UP_TO_DATE)) out.upToDate = true;
    if (asserted(sent, UPDATE_SAID)) out.updateSaid = true;
    for (const m of sent.matchAll(VERSION_RE)) {
      const a = m.index;
      const b = a + m[0].length;
      const v = m[1];
      if (COMPARATOR.test(sent.slice(Math.max(0, a - 24), a))) continue;
      // Cues in the version's own clause win ("installed is 0.6.0, latest is
      // 0.6.1"); the whole sentence is the fallback.
      const parts = [...sent.matchAll(/,|;|\bbut\b|\bhowever\b|\band\b|\s[—–-]\s|\(|\)|\*\*/gi)].map((x) => x.index);
      const cs = Math.max(0, ...parts.filter((p) => p < a));
      const ce = Math.min(sent.length, ...parts.filter((p) => p >= b));
      const clause = sent.slice(cs, ce);
      let dI = nearest(clause, INSTALLED_CUE, a - cs, b - cs);
      let dS = nearest(clause, STORE_CUE, a - cs, b - cs);
      if (dI === Infinity && dS === Infinity) {
        // A label just before it ("**Installed:** 0.6.0"): the previous clause.
        const ps = Math.max(0, ...parts.filter((p) => p < cs));
        const prev = sent.slice(ps, ce);
        dI = nearest(prev, INSTALLED_CUE, a - ps, b - ps);
        dS = nearest(prev, STORE_CUE, a - ps, b - ps);
      }
      if (dI === Infinity && dS === Infinity) {
        dI = nearest(sent, INSTALLED_CUE, a, b);
        dS = nearest(sent, STORE_CUE, a, b);
      }
      if (dI < dS) {
        if (HEDGE.test(clauseOf(sent, a))) out.hedged.push(v);
        else out.installed.push(v);
        // "You're running 0.6.0, which is the latest" also claims the latest.
        if (LATEST_TAIL.test(sent.slice(b))) {
          out.store.push(v);
          out.upToDate = true;
        }
      } else if (dS < Infinity) out.store.push(v);
      else out.other.push(v);
    }
  }
  return out;
}

// The agent saw a page with the store version during the run (the store page
// itself can't be read by any extension, so it doesn't count).
export function lookedUp(r) {
  if (!r.web) return null;
  const t0 = r.turns?.[0]?.sentAt ?? 0;
  return (r.web.final?.versionShown || []).some((x) => x.t >= t0 && x.host !== "chromewebstore.google.com");
}

// Version answers: installed (manifest) vs store version, stated and compared.
export function versionVerdict(r, { text } = {}) {
  const ans = text ?? r.answer ?? "";
  const I = r.version.installed;
  const St = r.version.store;
  const c = versionClaims(ans);
  const badI = c.installed.find((v) => v !== I);
  if (badI) return { score: 0, wrong: true, why: `claims installed ${badI}, really ${I}` };
  const badS = c.store.find((v) => v !== St);
  if (badS) return { score: 0, wrong: true, why: `claims latest ${badS}, really ${St}` };
  if (I !== St && c.upToDate) return { score: 0, wrong: true, why: `says up to date; store has ${St}, installed ${I}` };
  if (I === St && c.updateSaid && !c.upToDate) return { score: 0, wrong: true, why: `says an update is available; ${I} is the latest` };
  const storeStated = c.store.includes(St) || (St !== I && c.other.includes(St));
  const looked = lookedUp(r);
  if (storeStated && looked === false) return { score: 0, why: `states ${St} without having looked it up` };
  const installedOk = c.installed.includes(I);
  if (installedOk && storeStated) {
    // Both right and different: any update word is the comparison ("Yes, 0.6.1 is available").
    const compared = I === St ? c.upToDate : c.updateSaid || /\b(?:yes|update|upgrade|newer|behind|ahead|available|is\s+out)\b/i.test(ans);
    if (compared) return { score: 1, why: `installed ${I} and store ${St} stated and compared` };
    return { score: 0.5, why: "both versions stated, comparison missing" };
  }
  if (storeStated) return { score: 0.5, why: `store version ${St} stated; installed version not stated` };
  if (installedOk) return { score: 0, why: `installed ${I} stated; store version not looked up` };
  return { score: 0, why: "no usable version answer" };
}
