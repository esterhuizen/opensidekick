// Driving Chromium with the unpacked extension (design §5): launch a fresh
// profile, write the config, open the start tab, and talk to the worker from
// an options page with an injected listener (the e2e tests' pattern).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { STORAGE_KEY, MSG } from "../../../src/common/constants.js";
import { ROOT } from "./web/product.mjs";

export const API_HOSTS = ["api.anthropic.com", "*.googleapis.com", "openrouter.ai"];

// Every hostname goes to the fake web; real mode keeps the model API hosts
// real (only Chromium's own background traffic could use them: the extension
// talks to the proxy on 127.0.0.1).
export function hostRules({ httpPort, httpsPort, real }) {
  const rules = [`MAP *:80 127.0.0.1:${httpPort}`, `MAP *:443 127.0.0.1:${httpsPort}`, "EXCLUDE localhost", "EXCLUDE 127.0.0.1"];
  if (real) for (const h of API_HOSTS) rules.push(`EXCLUDE ${h}`);
  return rules.join(", ");
}

export async function launch({ rules }) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "osk-eval-"));
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(profile, {
      headless: false,
      ignoreHTTPSErrors: true,
      // The browser never needs a key: keep secret-looking variables out of its environment.
      env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !/KEY|TOKEN|SECRET/i.test(k))),
      args: [
        "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check",
        `--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`,
        `--host-resolver-rules=${rules}`, "--ignore-certificate-errors", "--disable-quic",
      ],
    });
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
    return { ctx, profile, sw, extId: new URL(sw.url()).host, version: ctx.browser()?.version?.() || "" };
  } catch (e) {
    await ctx?.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
    throw e;
  }
}

export async function writeConfig(sw, config) {
  await sw.evaluate(([k, c]) => chrome.storage.local.set({ [k]: c }), [STORAGE_KEY, config]);
}

export async function openStart(ctx, start) {
  const pages = ctx.pages();
  const page = pages[0] || (await ctx.newPage());
  for (const p of pages.slice(1)) await p.close().catch(() => {});
  const url = start === "newtab" ? "chrome://newtab" : start;
  if (/^https?:/.test(url)) {
    await page.goto(url, { waitUntil: "load", timeout: 20000 });
    await page.waitForTimeout(300); // the content script runs at document_idle
  } else {
    await page.goto(url, { timeout: 20000 }).catch(() => {}); // browser pages may not fire load
    await page.waitForTimeout(500);
  }
  return page;
}

// The listener answering cards and checkpoints like a cooperative user.
// rules: [{ tool?, labelRe?, originRe?, sensitive?, choice, guard? }] (regexes
// as {source, flags}); the first match wins, else "once".
export async function installController(ctx, extId, rules) {
  const controller = await ctx.newPage();
  await controller.goto(`chrome-extension://${extId}/src/options/options.html`, { waitUntil: "load" });
  await controller.evaluate(
    ([M, rules]) => {
      const re = (r) => (r ? new RegExp(r.source, r.flags) : null);
      const pick = (m) => {
        for (const r of rules) {
          if (r.tool && r.tool !== m.toolName) continue;
          if (r.labelRe && !re(r.labelRe).test(m.label || "")) continue;
          if (r.originRe && !re(r.originRe).test(m.origin || "")) continue;
          if (r.sensitive != null && !!m.sensitive !== r.sensitive) continue;
          return r;
        }
        return { choice: "once" };
      };
      window.__osk = { ev: [], cards: [], cps: [] };
      chrome.runtime.onMessage.addListener((m) => {
        const t = Date.now();
        if (!m || typeof m !== "object") return;
        if (m.type === M.AGENT_EVENT) {
          if (m.kind !== "assistant_delta") window.__osk.ev.push({ t, ...m });
          return;
        }
        if (m.type === M.PERMISSION_REQUEST) {
          const rule = pick(m);
          window.__osk.cards.push({
            t, id: m.id, toolName: m.toolName, origin: m.origin, label: m.label || "", sensitive: !!m.sensitive,
            newSite: !!m.newSite, why: m.why || "", mcp: m.mcp === true, choice: rule.choice, guard: !!rule.guard, args: m.args,
          });
          chrome.runtime.sendMessage({ type: M.PERMISSION_RESPONSE, id: m.id, choice: rule.choice });
        } else if (m.type === M.CONTINUE_REQUEST) {
          window.__osk.cps.push({ t, kind: "continue", steps: m.steps });
          chrome.runtime.sendMessage({ type: M.PLAN_RESPONSE, id: m.id, approved: false }); // a step limit is a stop
        } else if (m.type === M.PLAN_REQUEST) {
          window.__osk.cps.push({ t, kind: "plan" });
          chrome.runtime.sendMessage({ type: M.PLAN_RESPONSE, id: m.id, approved: true }); // only with --set autonomy=plan
        }
      });
    },
    [MSG, rules],
  );
  return controller;
}

export function sendTurn(controller, task, newChat) {
  return controller.evaluate(([type, task, newChat]) => chrome.runtime.sendMessage({ type, task, newChat }), [MSG.RUN_TASK, task, newChat]);
}

export function stopTask(controller) {
  return controller.evaluate((type) => chrome.runtime.sendMessage({ type }), MSG.STOP_TASK).catch(() => {});
}

export function idleSince(controller, t0) {
  return controller.evaluate((t0) => window.__osk.ev.some((e) => e.kind === "idle" && e.t >= t0), t0);
}

export function collect(controller) {
  return controller.evaluate(() => window.__osk);
}

export async function tabsOf(ctx, controller) {
  const out = [];
  for (const p of ctx.pages()) {
    if (p === controller) continue;
    out.push({ url: p.url(), title: await p.title().catch(() => "") });
  }
  return out;
}

// Files under dir that contain any of the needles (dry-run canary check).
export function scanDir(dir, needles) {
  const hits = [];
  const bufs = needles.filter(Boolean).map((n) => Buffer.from(n));
  const walk = (d) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        let b;
        try {
          b = fs.readFileSync(p);
        } catch {
          continue;
        }
        if (bufs.some((n) => b.includes(n))) hits.push(p);
      }
    }
  };
  walk(dir);
  return hits;
}

export async function closeBrowser(b, { keep = false } = {}) {
  await b.ctx.close().catch(() => {});
  if (!keep) fs.rmSync(b.profile, { recursive: true, force: true });
}
