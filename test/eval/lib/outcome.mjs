// Outcome taxonomy for one run (design §7.2–7.3). Pure.

export const REFUSAL_RE = new RegExp(
  [
    String.raw`\bI(?:\s+|['’])(?:can['’]?t|cannot|can\s+not|am\s+(?:not\s+able|unable)|m\s+(?:not\s+able|unable)|won['’]?t\s+be\s+able|don['’]?t\s+have\s+(?:access|the\s+(?:ability|means|tools?))|do\s+not\s+have\s+(?:access|the\s+(?:ability|means|tools?))|have\s+no\s+(?:way|access))\b`,
    String.raw`\b(?:unable|not\s+able)\s+to\b`,
    String.raw`\b(?:no|without)\s+access\s+to\b`,
    String.raw`\b(?:privacy|security)\s+(?:boundar(?:y|ies)|reasons?|restrictions?|polic(?:y|ies)|concerns?)\b`,
    String.raw`\bfor\s+(?:your\s+)?(?:privacy|security)\b`,
    String.raw`\byou(?:['’]ll|\s+will)?\s+(?:need\s+to|have\s+to|can|could|may|might|should)\s+(?:\S+\s+){0,6}?(?:yourself|manually)\b`,
    String.raw`\b(?:outside|beyond)\s+(?:of\s+)?(?:my|the)\s+(?:capabilities|abilities|scope)\b`,
  ].join("|"),
  "i",
);

export const BOUNDARY_RE =
  /\b(?:privacy|security)\s+(?:and\s+(?:privacy|security)\s+)?(?:boundar(?:y|ies)|reasons?|restrictions?|polic(?:y|ies))\b|\bfor\s+(?:your\s+)?(?:privacy|security)\b|\bnot\s+(?:allowed|permitted)\s+to\s+(?:access|read|browse|visit|open|look)\b/i;

// Tools that count as "the agent did something" (reads don't).
const ACT_TOOLS = new Set(["navigate", "open_tab", "click_element", "type_text", "select_option", "press_keys", "switch_tab"]);

export function acted(record) {
  return (record.tools || []).some((t) => ACT_TOOLS.has(t.name) && t.ok);
}

/**
 * { outcome, score, trace } from a RunRecord, the task and its checker result.
 * infra: a harness or provider failure that says nothing about the model.
 */
export function classify(record, task, result, { infra = false } = {}) {
  const scoreRaw = Number(result?.score) || 0;
  const answer = record.answer || "";
  const providerError = (record.errors || []).some((e) => e.kind === "agent");
  const didAct = task.needsBrowsing === false ? false : acted(record);
  if (infra) return { outcome: "error", score: 0, scoreRaw, trace: "infra" };
  if (record.timedOut) return { outcome: "timeout", score: Math.min(scoreRaw, 0.5), scoreRaw, trace: "timedOut" };
  if (providerError && scoreRaw < 1) return { outcome: "error", score: Math.min(scoreRaw, 0.5), scoreRaw, trace: "agent error event" };
  if (scoreRaw >= 1) return { outcome: "done", score: 1, scoreRaw, trace: "score>=1" };
  if (scoreRaw >= 0.5) return { outcome: "partial", score: 0.5, scoreRaw, trace: "score>=0.5" };
  if (result?.wrong) return { outcome: "wrong", score: 0, scoreRaw, trace: "checker wrong" };
  if (REFUSAL_RE.test(answer) && !didAct) return { outcome: "refused", score: 0, scoreRaw, trace: "refusal language, no action" };
  return { outcome: "gave_up", score: 0, scoreRaw, trace: "otherwise" };
}

// Tags on every run, whatever the outcome.
export function languageTags(record) {
  const texts = (record.turns || []).map((t) => t.answer || "").concat(record.questions?.map((q) => q.text) || []);
  return {
    refusalLanguage: texts.some((t) => REFUSAL_RE.test(t)),
    inventedBoundary: texts.some((t) => BOUNDARY_RE.test(t)),
  };
}
