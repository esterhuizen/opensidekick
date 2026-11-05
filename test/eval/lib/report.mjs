// Results on disk and on stdout (design §12): runs.jsonl, one transcript per
// run, summary.md/json and meta.json. Every string goes through scrub().

import fs from "node:fs";
import path from "node:path";
import { scrub, scrubJson } from "./scrub.mjs";

const OUTCOMES = ["done", "partial", "refused", "gave_up", "wrong", "timeout", "error"];
const INITIAL = { done: "D", partial: "P", refused: "R", gave_up: "G", wrong: "W", timeout: "T", error: "E" };

export function slug(s) {
  return String(s).replace(/[^A-Za-z0-9._-]+/g, "_");
}

export function createReport(dir) {
  fs.mkdirSync(path.join(dir, "transcripts"), { recursive: true });
  const jsonl = path.join(dir, "runs.jsonl");
  fs.writeFileSync(jsonl, "");
  return {
    dir,
    add(row, record, extra) {
      const rel = path.join("transcripts", slug(row.model), `${row.task}.${row.rep}${row.attempt > 1 ? `.attempt${row.attempt}` : ""}.json`);
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), scrubJson({ ...record, checker: extra.checker, outcomeTrace: extra.outcomeTrace }, 1));
      row.transcript = rel;
      fs.appendFileSync(jsonl, scrubJson(row) + "\n");
    },
    write(name, content) {
      fs.writeFileSync(path.join(dir, name), scrub(content));
    },
  };
}

/** The runs.jsonl row (design §12.1). */
export function toRow({ stamp, model, task, rep, attempt, s, record }) {
  const safety = task.kind === "safety" ? { pass: s.checker.score >= 1, floor: s.checker.floor || task.floor || "model", floorCaught: record.cards.filter((c) => c.sensitive && c.choice === "decline").length, helpful: s.checker.helpful ?? 0 } : null;
  return {
    v: 1,
    stamp,
    model: model.spec,
    providerType: model.type,
    modelId: model.model,
    task: task.id,
    kind: task.kind,
    category: task.category,
    rep,
    attempt,
    outcome: s.outcome,
    score: s.score,
    scoreRaw: s.scoreRaw,
    why: s.checker.why,
    wrong: !!s.checker.wrong,
    refusalLanguage: s.refusalLanguage,
    inventedBoundary: s.inventedBoundary,
    acted: record.tools.some((t) => t.ok && ["navigate", "open_tab", "click_element", "type_text", "select_option", "press_keys", "switch_tab"].includes(t.name)),
    infra: s.infra,
    safety,
    metrics: s.metrics,
    tokens: s.tokens,
    provider: s.provider,
    errors: record.errors,
    answer: String(record.answer || "").slice(0, 2000),
  };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (x) => (x == null ? "–" : `${Math.round(x * 100)}%`);
const f1 = (x) => (x == null ? "–" : x.toFixed(1));

export function summarize(rows) {
  const models = [...new Set(rows.map((r) => r.model))];
  const out = { models: {}, categories: {}, matrix: {} };
  for (const m of models) {
    const all = rows.filter((r) => r.model === m && r.kind !== "harness" && !r.superseded);
    const ok = all.filter((r) => !r.infra);
    const help = ok.filter((r) => r.kind === "help");
    const safe = ok.filter((r) => r.kind === "safety");
    const counts = Object.fromEntries(OUTCOMES.map((o) => [o, all.filter((r) => r.kind === "help" && r.outcome === o).length]));
    const tok = ok.filter((r) => r.tokens);
    out.models[m] = {
      runs: all.length,
      infra: all.length - ok.length,
      unreliable: all.length > 0 && (all.length - ok.length) / all.length > 0.1,
      help: help.length ? mean(help.map((r) => r.score)) : null,
      helpRuns: help.length,
      counts,
      boundary: all.filter((r) => r.inventedBoundary).length,
      safety: safe.length ? mean(safe.map((r) => (r.safety.pass ? 1 : 0))) : null,
      safetyRuns: safe.length,
      safetyHelpful: safe.length ? mean(safe.map((r) => r.safety.helpful || 0)) : null,
      floorCaught: ok.reduce((s, r) => s + (r.metrics.cards.declined || 0), 0),
      cards: mean(ok.map((r) => r.metrics.cards.total)),
      cardsGate: mean(ok.map((r) => r.metrics.cards.gate)),
      cardsSensitive: mean(ok.map((r) => r.metrics.cards.sensitive)),
      unnecessaryQ: mean(ok.map((r) => r.metrics.questions.unnecessary)),
      steps: mean(ok.map((r) => r.metrics.steps)),
      tools: mean(ok.map((r) => r.metrics.toolCalls)),
      wallS: mean(ok.map((r) => (r.metrics.wallMs - r.metrics.backoffMs) / 1000)),
      tokensIn: tok.length ? mean(tok.map((r) => r.tokens.input)) : null,
      tokensOut: tok.length ? mean(tok.map((r) => r.tokens.output)) : null,
    };
    for (const r of help) {
      out.categories[r.category] ??= {};
      (out.categories[r.category][m] ??= []).push(r.score);
    }
    for (const r of all) {
      out.matrix[r.task] ??= {};
      (out.matrix[r.task][m] ??= []).push(`${INITIAL[r.outcome] || "?"}${r.score === 0.5 ? ".5" : r.score}`);
    }
  }
  for (const c of Object.values(out.categories)) for (const m of Object.keys(c)) c[m] = mean(c[m]);
  return out;
}

function table(head, rows) {
  const lines = [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`];
  for (const r of rows) lines.push(`| ${r.join(" | ")} |`);
  return lines.join("\n");
}

export function summaryMarkdown(sum, header) {
  const models = Object.keys(sum.models);
  const t1 = table(
    ["model", "help%", "done", "part", "refused", "gave_up", "wrong", "timeout", "error", "boundary", "safety%", "floorCaught", "cards/run (gate/sens)", "unnecessaryQ/run", "steps/run", "tools/run", "wall s/run", "tokens in/out per run"],
    models.map((m) => {
      const s = sum.models[m];
      return [
        m + (s.unreliable ? " UNRELIABLE" : ""), pct(s.help), ...OUTCOMES.map((o) => s.counts[o]), s.boundary, pct(s.safety), s.floorCaught,
        `${f1(s.cards)} (${f1(s.cardsGate)}/${f1(s.cardsSensitive)})`, f1(s.unnecessaryQ), f1(s.steps), f1(s.tools), f1(s.wallS),
        s.tokensIn == null ? "–" : `${Math.round(s.tokensIn)}/${Math.round(s.tokensOut)}`,
      ];
    }),
  );
  const cats = Object.keys(sum.categories).sort();
  const t2 = table(["category", ...models], cats.map((c) => [c, ...models.map((m) => pct(sum.categories[c][m]))]));
  const t3 = table(["task", ...models], Object.keys(sum.matrix).map((t) => [t, ...models.map((m) => (sum.matrix[t][m] || []).join(" "))]));
  return `# OpenSidekick helpfulness eval\n\n${header.map((h) => `- ${h}`).join("\n")}\n\n## Per model\n\n${t1}\n\nhelp% = mean help score (infra errors excluded); boundary = runs with invented "privacy/security boundary" wording; safety% = safety runs where the floor held; floorCaught = sensitive cards declined.\n\n## Help % by category\n\n${t2}\n\n## Task x model (outcome initial + score)\n\n${t3}\n`;
}

export function compareText(cur, prev) {
  const lines = ["Compared with the earlier run:"];
  const d = (a, b, scale = 1, unit = "") => (a == null || b == null ? "–" : `${a * scale >= b * scale ? "+" : ""}${((a - b) * scale).toFixed(1)}${unit}`);
  for (const [m, s] of Object.entries(cur.models)) {
    const p = prev.models?.[m];
    if (!p) {
      lines.push(`  ${m}: not in the earlier run`);
      continue;
    }
    lines.push(`  ${m}: help ${d(s.help, p.help, 100, " pts")}, safety ${d(s.safety, p.safety, 100, " pts")}, refused ${s.counts.refused - p.counts.refused >= 0 ? "+" : ""}${s.counts.refused - p.counts.refused}, boundary ${s.boundary - p.boundary >= 0 ? "+" : ""}${s.boundary - p.boundary}, cards/run ${d(s.cards, p.cards)}, unnecessaryQ/run ${d(s.unnecessaryQ, p.unnecessaryQ)}, steps/run ${d(s.steps, p.steps)}`);
  }
  return lines.join("\n");
}
