// Real-model helpfulness eval for OpenSidekick: how often the agent gets
// everyday tasks done, the friction on the way (cards, questions, steps,
// time, tokens), and whether the safety floor holds. Offline fake web,
// real extension defaults, one browser at a time. See CONTRIBUTING.md.
//
//   xvfb-run -a npm run test:eval -- --dry-run
//   xvfb-run -a npm run test:eval -- --models anthropic:claude-haiku-5-5,gemini:budget --stamp baseline
//
// Keys come from the environment only (CLAUDE_KEY, GEMINI_KEY, OPENROUTER_KEY;
// the npm script loads .env). They stay in this process and the proxy's
// outgoing requests: the browser profile only ever holds a placeholder.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { DEFAULT_SETTINGS } from "../../src/common/constants.js";
import { parseArgs, selectTasks, defaultStamp, USAGE } from "./lib/cli.mjs";
import { parseModels, validateModel } from "./lib/models.mjs";
import { startProxy } from "./lib/proxy.mjs";
import { createFake } from "./lib/fake-model.mjs";
import { startWeb } from "./lib/web/server.mjs";
import { makeCert } from "./lib/web/tls.mjs";
import { ROOT, INSTALLED } from "./lib/web/product.mjs";
import { hostRules, isApiHost } from "./lib/browser.mjs";
import { runOne, score, live } from "./lib/runner.mjs";
import { createReport, toRow, summarize, summaryMarkdown, compareText } from "./lib/report.mjs";
import { scrub, scrubJson } from "./lib/scrub.mjs";
import { DRY_PLAN, plantCanaries, selftest, printSelftest } from "./lib/selftest.mjs";
import { TASKS, TASK_FILES } from "./tasks/index.mjs";

const EVAL_DIR = path.join(ROOT, "test", "eval");
const RESULTS = path.join(EVAL_DIR, "results");

function git(args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function tasksHash() {
  const h = crypto.createHash("sha256");
  for (const f of TASK_FILES) h.update(fs.readFileSync(path.join(EVAL_DIR, "tasks", f + ".mjs")));
  return h.digest("hex").slice(0, 16);
}

function playwrightVersion() {
  try {
    return createRequire(import.meta.url)("playwright/package.json").version;
  } catch {
    return "";
  }
}

function listTasks() {
  const rows = TASKS.filter((t) => t.kind !== "harness");
  for (const t of rows) console.log(`${t.id.padEnd(22)} ${t.kind.padEnd(7)} ${t.category.padEnd(9)} ${String(t.turns.length).padStart(1)} turn(s)  ${t.start}`);
  console.log(`\n${rows.length} tasks (${rows.filter((t) => t.kind === "help").length} help, ${rows.filter((t) => t.kind === "safety").length} safety), plus ${TASKS.length - rows.length} dry-run harness tasks`);
}

async function rescore(opts, stamp) {
  const src = path.resolve(opts.rescore);
  const lines = fs.readFileSync(path.join(src, "runs.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const dir = path.join(RESULTS, stamp);
  if (fs.existsSync(dir)) throw new Error(`results dir ${dir} already exists; pick another --stamp`);
  const report = createReport(dir);
  const rows = [];
  // runs.jsonl written before a crash has no superseded flags: an attempt is
  // superseded when a later attempt of the same run exists.
  const lastAttempt = new Map();
  for (const l of lines) {
    const k = `${l.model}|${l.task}|${l.rep}`;
    lastAttempt.set(k, Math.max(lastAttempt.get(k) || 0, l.attempt || 1));
  }
  for (const old of lines) {
    const task = TASKS.find((t) => t.id === old.task);
    if (!task) {
      console.log(`  skip ${old.task}: no such task any more`);
      continue;
    }
    const record = JSON.parse(fs.readFileSync(path.join(src, old.transcript), "utf8"));
    const s = score(task, record, { infra: old.infra });
    const superseded = old.superseded || (old.attempt || 1) < lastAttempt.get(`${old.model}|${old.task}|${old.rep}`);
    const row = { ...toRow({ stamp, model: { spec: old.model, type: old.providerType, model: old.modelId }, task, rep: old.rep, attempt: old.attempt, s, record }), superseded };
    report.add(row, record, s);
    rows.push(row);
    if (row.score !== old.score) console.log(`  ${old.model} ${old.task} #${old.rep}: ${old.outcome} ${old.score} -> ${row.outcome} ${row.score} (${row.why})`);
  }
  const sum = summarize(rows);
  const md = summaryMarkdown(sum, [`rescored from ${src}`, `tasks ${tasksHash()}`, `${rows.length} runs`]);
  report.write("summary.md", md);
  report.write("summary.json", JSON.stringify(sum, null, 2));
  report.write("meta.json", JSON.stringify({ rescoredFrom: src, stamp, tasksHash: tasksHash() }, null, 2));
  console.log("\n" + md + `\nResults: ${dir}`);
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\n\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  if (opts.list) {
    listTasks();
    return 0;
  }
  const stamp = opts.stamp || process.env.EVAL_STAMP || defaultStamp();
  if (opts.rescore) {
    await rescore(opts, stamp);
    return 0;
  }
  if (process.platform === "linux" && !process.env.DISPLAY) {
    console.error("No display: run under xvfb-run -a (the extension needs headed Chromium).");
    return 2;
  }
  if (!opts.dryRun && !opts.models.length) {
    console.error(`--models is required (or --dry-run).\n\n${USAGE}`);
    return 2;
  }

  // What to run: [{ model, policy, tasks }]
  const plan = [];
  let canaries = [];
  const skipped = [];
  if (opts.dryRun) {
    canaries = plantCanaries();
    const sel = selectTasks(TASKS, opts.tasks);
    const withHarness = opts.tasks === "all" ? [...sel, ...TASKS.filter((t) => t.kind === "harness")] : sel;
    for (const t of withHarness) if (t.fake === "skip") skipped.push(t);
    for (const g of DRY_PLAN) {
      const [model] = parseModels([g.spec]);
      const tasks = withHarness.filter((t) => g.kinds.includes(t.kind) && t.fake !== "skip");
      if (tasks.length) plan.push({ model, policy: g.policy, tasks });
    }
  } else {
    let models;
    try {
      models = parseModels(opts.models);
    } catch (e) {
      console.error(e.message);
      return 2;
    }
    const tasks = selectTasks(TASKS, opts.tasks).filter((t) => t.kind !== "harness" || opts.tasks !== "all");
    for (const m of models) {
      if (m.fake) {
        plan.push({ model: m, policy: m.model, tasks });
        continue;
      }
      if (!process.env[m.keyEnv]) {
        console.log(`SKIP ${m.spec} — ${m.keyEnv} not set`);
        continue;
      }
      const v = await validateModel(m);
      if (!v.ok) {
        console.error(`${m.spec}: ${v.reason}${v.ids ? `\n  closest ids: ${v.ids.join(", ")}` : ""}`);
        return 2;
      }
      if (m.requested !== m.model) console.log(`${m.provider}:${m.requested} -> ${m.model}`);
      plan.push({ model: m, policy: null, tasks });
    }
  }
  if (!plan.length) {
    console.log("Nothing to run.");
    return 0;
  }

  const dir = path.join(RESULTS, stamp);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
    console.error(`results dir ${dir} already exists; pick another --stamp`);
    return 2;
  }

  const tls = makeCert();
  let web = null;
  let proxy = null;
  const cleanup = async () => {
    if (live.browser) {
      await live.browser.ctx.close().catch(() => {});
      if (!opts.keepProfiles) fs.rmSync(live.browser.profile, { recursive: true, force: true });
    }
    await web?.close().catch(() => {});
    await proxy?.close().catch(() => {});
    tls.cleanup();
  };
  const onSignal = (sig) => {
    console.error(`\n${sig}: cleaning up`);
    cleanup().finally(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    web = await startWeb({ tls });
    const fake = createFake();
    proxy = await startProxy({ fake, usageInject: opts.usageInject, verbose: opts.verbose });
    const rules = hostRules({ httpPort: web.httpPort, httpsPort: web.httpsPort });
    const report = createReport(dir);
    const started = new Date();
    const total = plan.reduce((s, g) => s + g.tasks.length * (opts.dryRun ? 1 : opts.repeat), 0);
    const runs = [];
    const rows = [];
    const apiHostHits = [];
    let n = 0;
    let chromium = "";
    console.log(`OpenSidekick eval ${stamp}: ${total} run(s)${opts.dryRun ? " (dry run, fake model, offline)" : ""}\n`);

    for (const g of plan) {
      for (let rep = 1; rep <= (opts.dryRun ? 1 : opts.repeat); rep++) {
        for (const task of g.tasks) {
          n++;
          let prev = null;
          for (let attempt = 1; attempt <= 1 + opts.retryInfra; attempt++) {
            const res = await runOne({
              task, model: g.model, rep, web, proxy, fake, policy: g.policy, rules, settings: opts.set,
              timeoutSec: opts.timeout, keepProfile: opts.keepProfiles, canaries, verbose: opts.verbose,
            });
            chromium ||= res.record.chromium;
            // The host rules send model API hosts nowhere; one reaching the fake web is a harness bug.
            const apiHits = (res.record.web.final.hits || []).filter((h) => isApiHost(h.host));
            if (apiHits.length) {
              apiHostHits.push(...apiHits.map((h) => h.host));
              console.error(`  ERROR: the fake web saw model API host(s) ${[...new Set(apiHits.map((h) => h.host))].join(", ")}: check hostRules()`);
            }
            const row = toRow({ stamp, model: g.model, task, rep, attempt, s: res, record: res.record });
            if (prev) prev.superseded = true;
            report.add(row, res.record, res);
            rows.push(row);
            runs.push({ policy: g.policy, task, row, record: res.record });
            const m = row.metrics;
            console.log(
              `[${String(n).padStart(3)}/${total}] ${g.model.spec} ${task.id} #${rep}${attempt > 1 ? ` (retry ${attempt - 1})` : ""} -> ${row.outcome} ${row.score}` +
                `  cards ${m.cards.total} q ${m.questions.total} steps ${m.steps} ${(m.wallMs / 1000).toFixed(1)}s` +
                (row.inventedBoundary ? "  [boundary]" : "") + (opts.verbose || row.score < 1 ? `  — ${scrub(row.why)}` : ""),
            );
            if (!row.infra) break;
            prev = row;
            if (attempt <= opts.retryInfra) console.log(`        infra failure (${scrub(row.errors.map((e) => e.message).join("; ")).slice(0, 200)}), retrying`);
          }
        }
      }
    }
    // Superseded rows were already written; rewrite runs.jsonl with the flag.
    fs.writeFileSync(path.join(dir, "runs.jsonl"), rows.map((r) => scrubJson(r)).join("\n") + "\n");

    const sum = summarize(rows);
    const sha = git(["rev-parse", "--short", "HEAD"]);
    const dirty = git(["status", "--porcelain"]) ? " (dirty)" : "";
    const header = [
      `stamp ${stamp}`, `git ${sha}${dirty}`, `extension ${INSTALLED}`, `chromium ${chromium}`,
      `settings ${Object.keys(opts.set).length ? JSON.stringify(opts.set) : "extension defaults"}`, `tasks ${tasksHash()}`, `${rows.length} runs`,
    ];
    const md = summaryMarkdown(sum, header);
    report.write("summary.md", md);
    report.write("summary.json", JSON.stringify(sum, null, 2));
    report.write("meta.json", JSON.stringify({
      stamp, args: process.argv.slice(2), dryRun: opts.dryRun,
      models: plan.map((g) => ({ spec: g.model.spec, requested: g.model.requested, provider: g.model.provider, type: g.model.type, presetName: g.model.name, policy: g.policy })),
      settings: { ...DEFAULT_SETTINGS, ...opts.set }, overrides: opts.set, hostRules: rules,
      tasks: [...new Set(plan.flatMap((g) => g.tasks.map((t) => t.id)))], tasksHash: tasksHash(),
      startedAt: started.toISOString(), endedAt: new Date().toISOString(),
      usageUnavailable: proxy.usageUnavailable(), apiHostHits: [...new Set(apiHostHits)], node: process.version, playwright: playwrightVersion(), chromium, git: sha + dirty,
    }, null, 2));
    console.log("\n" + md);
    if (opts.compare) {
      const prev = JSON.parse(fs.readFileSync(path.join(path.resolve(opts.compare), "summary.json"), "utf8"));
      console.log(compareText(sum, prev) + "\n");
    }
    console.log(`Results: ${dir}`);

    if (opts.dryRun) {
      const failed = printSelftest(selftest({ runs, dir, canaries, upstreamCalls: proxy.upstreamCalls(), apiHostHits, skipped, full: opts.tasks === "all" }));
      return failed ? 1 : 0;
    }
    return apiHostHits.length ? 1 : 0;
  } finally {
    await cleanup();
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error("Eval harness error:", scrub(e && e.stack ? e.stack : e));
    process.exit(2);
  },
);
