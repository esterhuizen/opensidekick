// Pure helpers for plan-approval mode — kept dependency-free for unit testing.

/**
 * Parse a plan the model produced. Tolerant of code fences and surrounding
 * prose; falls back to treating the whole text as a summary.
 * Returns { summary, steps[], domains[], needsActions }.
 */
export function parsePlan(text) {
  let t = String(text || "").trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const m = t.match(/\{[\s\S]*\}/);
  const candidate = m ? m[0] : t;
  try {
    const p = JSON.parse(candidate);
    return {
      summary: String(p.summary || "").slice(0, 300),
      steps: Array.isArray(p.steps) ? p.steps.slice(0, 10).map((x) => String(x).slice(0, 240)) : [],
      domains: Array.isArray(p.domains) ? p.domains.slice(0, 20).map((x) => String(x).slice(0, 120)) : [],
      needsActions: p.needs_actions !== false,
    };
  } catch {
    return { summary: String(text || "").slice(0, 300), steps: [], domains: [], needsActions: true };
  }
}

/** Normalize a plan-listed domain (or a full URL) to a bare hostname. */
export function hostFromDomain(d) {
  return String(d || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "")
    .toLowerCase();
}

/** A plain-text rendering of a plan, for the model's own context. */
export function planToText(plan) {
  const lines = [];
  if (plan.summary) lines.push(plan.summary);
  if (plan.steps && plan.steps.length) {
    lines.push("Plan:");
    plan.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  }
  if (plan.domains && plan.domains.length) lines.push("Sites: " + plan.domains.join(", "));
  return lines.join("\n");
}
