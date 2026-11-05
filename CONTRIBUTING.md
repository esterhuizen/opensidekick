# Contributing to OpenSidekick

Thanks for your interest! OpenSidekick is intentionally simple: plain ES modules,
no build step, no npm runtime dependencies. That makes it easy to hack on.

## Getting set up

1. Clone the repo.
2. Load it as an unpacked extension at `chrome://extensions` (Developer mode →
   Load unpacked).
3. Make changes and hit the reload icon on the extension card to pick them up.
   Reload the target page after changing `content-script.js`.

## Before opening a PR

```bash
npm run check   # syntax-checks every JS file as an ES module
npm run icons   # only if you changed the icon generator
```

Please:

- Keep the no-build constraint. If a change needs a build tool, open an issue
  to discuss first.
- No npm runtime dependencies. A third-party library may be vendored, case by
  case. Open an issue before adding one. A vendored library must be:
  - pinned to one released version;
  - copied byte-for-byte from the official npm package, with the file named
    and its sha256 in a header comment;
  - shipped with its license, plus the notices of every package bundled
    inside it;
  - loaded as plain scripts or ES modules, with no build step.
  To upgrade one, copy the new release the same way, and update its header
  and notices in the same PR.
- Match the existing style (2-space indent, ES modules, descriptive comments
  that explain _why_, not _what_).
- Keep provider code protocol-agnostic — new hosted services that speak
  OpenAI's `/chat/completions` should work by adding a preset in
  `src/common/constants.js`, not new code.
- Don't add analytics, telemetry, or any phone-home behavior. Privacy is a core
  promise of this project.

## Helpfulness eval

`test/eval` measures how often the agent gets everyday tasks done with a real
model, how much friction it causes (permission cards, unnecessary questions,
steps, time, tokens), and whether the safety floor holds. It drives the real
extension, with its default settings, against a fake offline web: every
hostname resolves to a local server, so runs are repeatable and nothing
touches the live web.

```bash
xvfb-run -a npm run test:eval -- --dry-run          # self-test: fake model, no keys, no network
xvfb-run -a npm run test:eval -- --models anthropic:claude-haiku-5-5,gemini:budget --stamp baseline
xvfb-run -a npm run test:eval -- --list             # the task table
```

- Keys come from the environment (`CLAUDE_KEY`, `GEMINI_KEY`, `OPENROUTER_KEY`;
  the npm script reads `.env`). A local proxy adds them to model requests, so
  the browser profile only holds a placeholder. A provider without a key is
  skipped. A real run costs money.
- Results go to `test/eval/results/<stamp>/` (gitignored): `runs.jsonl`, a
  transcript per run, `summary.md`, `summary.json` and `meta.json`.
  `--compare <dir>` prints the change against an earlier run. `--rescore <dir>`
  re-runs the checkers over saved transcripts.
- Tasks are data in `test/eval/tasks/*.mjs`. Add a failure you hit to
  `tasks/reported.mjs`: an id, a start URL (or `"newtab"`), the words you
  typed, and a checker.
- `node test/eval.test.mjs` checks the pure helpers (regexes, scoring, search).

## Good first issues

- New provider presets (verify the base URL and default model).
- Improving the page-reading heuristics in `content-script.js`.
- Accessibility and keyboard-navigation improvements in the UI.

## Architecture at a glance

The agent loop lives in `src/background/agent.js`. It calls the model
(`providers.js`), executes any tool calls (`tools.js` + `content-script.js`),
gates mutating actions (`permissions.js`), and streams events to the side panel.
Start there to understand how a task runs end to end.

## Reporting bugs

Include your Chrome version, the provider/model you used, the site you were on
(if shareable), and the steps to reproduce. Console logs from the service worker
(`chrome://extensions` → Inspect views: service worker) are very helpful.

By contributing you agree your contributions are licensed under the MIT License.
