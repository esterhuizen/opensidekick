// Command-line parsing and task selection (design §11). Pure.

export const USAGE = `node test/eval/run.mjs [options]     (on Linux: xvfb-run -a npm run test:eval -- ...)
  --models <list>     provider:model[,...]; provider = anthropic | gemini | openrouter | fake-openai | fake-anthropic;
                      model = an id, or "default" / "budget" (from PROVIDER_PRESETS). Required unless --dry-run.
  --tasks <sel>       all (default) | id,id | category:<c> | kind:<k>; "!" prefix excludes (e.g. all,!kind:safety)
  --repeat <n>        runs per task and model (default 1)
  --timeout <s>       default per-task budget in seconds (default 180)
  --stamp <name>      results dir name (else $EVAL_STAMP, else a UTC timestamp)
  --set k=v           settings override, repeatable (recorded in meta and the summary)
  --dry-run | --fake-model   offline self-test with a scripted fake model
  --rescore <dir>     re-run checkers over saved transcripts (no browser)
  --compare <dir>     print deltas against an earlier results dir
  --retry-infra <n>   retries after a harness/provider failure (default 1)
  --no-usage-inject   don't add stream_options to openai-type requests
  --keep-profiles     keep Chromium profiles (they contain no keys)
  --list              print the task table and exit
  --verbose`;

export function parseArgs(argv) {
  const o = {
    models: [], tasks: "all", repeat: 1, timeout: 180, stamp: "", set: {}, dryRun: false, rescore: "", compare: "",
    retryInfra: 1, usageInject: true, keepProfiles: false, list: false, verbose: false, help: false,
  };
  const need = (i, flag) => {
    if (i >= argv.length || argv[i].startsWith("--")) throw new Error(`${flag} needs a value`);
    return argv[i];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--models": o.models = need(++i, a).split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--tasks": o.tasks = need(++i, a); break;
      case "--repeat": o.repeat = posInt(need(++i, a), a); break;
      case "--timeout": o.timeout = posInt(need(++i, a), a); break;
      case "--stamp": o.stamp = need(++i, a); break;
      case "--set": {
        const kv = need(++i, a);
        const eq = kv.indexOf("=");
        if (eq < 1) throw new Error(`--set wants k=v, got "${kv}"`);
        o.set[kv.slice(0, eq)] = coerce(kv.slice(eq + 1));
        break;
      }
      case "--dry-run": case "--fake-model": o.dryRun = true; break;
      case "--rescore": o.rescore = need(++i, a); break;
      case "--compare": o.compare = need(++i, a); break;
      case "--retry-infra": o.retryInfra = Math.max(0, parseInt(need(++i, a), 10) || 0); break;
      case "--no-usage-inject": o.usageInject = false; break;
      case "--keep-profiles": o.keepProfiles = true; break;
      case "--list": o.list = true; break;
      case "--verbose": o.verbose = true; break;
      case "--help": case "-h": o.help = true; break;
      default: throw new Error(`unknown option ${a}`);
    }
  }
  if (o.stamp && !/^[\w.-]+$/.test(o.stamp)) throw new Error("--stamp may use letters, digits, '.', '_' and '-' only");
  return o;
}

function posInt(v, flag) {
  const n = parseInt(v, 10);
  if (!(n > 0)) throw new Error(`${flag} wants a positive integer`);
  return n;
}

function coerce(v) {
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

export function defaultStamp(now = new Date()) {
  return now.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
}

// Task selection: comma-separated terms, applied left to right; "!" removes.
export function selectTasks(tasks, sel) {
  const matches = (t, term) => {
    if (term === "all") return true;
    if (term.startsWith("category:")) return t.category === term.slice(9);
    if (term.startsWith("kind:")) return t.kind === term.slice(5);
    return t.id === term;
  };
  const terms = String(sel || "all").split(",").map((s) => s.trim()).filter(Boolean);
  let chosen = new Set();
  // A selection that starts with an exclusion starts from "all".
  if (terms[0]?.startsWith("!")) chosen = new Set(tasks.filter((t) => t.kind !== "harness"));
  for (const term of terms) {
    const neg = term.startsWith("!");
    const body = neg ? term.slice(1) : term;
    const known = body === "all" || /^(category|kind):/.test(body) || tasks.some((t) => t.id === body);
    if (!known) throw new Error(`unknown task "${body}"`);
    for (const t of tasks) {
      // "all" never pulls in the dry-run-only harness tasks; naming one does.
      if (body === "all" && t.kind === "harness") continue;
      if (matches(t, body)) neg ? chosen.delete(t) : chosen.add(t);
    }
  }
  return tasks.filter((t) => chosen.has(t));
}
