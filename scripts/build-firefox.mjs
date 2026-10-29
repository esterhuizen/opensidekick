// Firefox gaps, measured: no MV3 service worker (`background.scripts` module,
// `persistent` rejected), no `side_panel` (`sidebar_action` replaces it, no extra
// permission), no `chrome.debugger`. AMO caps: `name` 45 chars, `strict_min_version`
// 140.0, no `strict_max_version` (fails the AMO schema), no gecko_android.

import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "dist", "firefox");

const FF_NAME = "OpenSidekick — Bring Your Own LLM Agent"; // 39 chars, base name is 47
const STRICT_MIN_VERSION = "140.0";
const SIDEBAR_PANEL = "src/sidepanel/sidepanel.html";
const SIDEBAR_TITLE = "OpenSidekick";
// Ctrl+Shift+E is the Firefox Network Monitor. Ctrl+Shift+Q quits Firefox on
// Windows/Linux, and Shift-Command-Q logs the user out of macOS: a key the browser
// already uses is accepted by the manifest and the handler is never called. So the
// key is U, measured free in Firefox 158.0.1.
const ACTION_TITLE = "Open OpenSidekick (Ctrl+Shift+U / Cmd+Shift+U)";
const SIDEBAR_COMMAND = "_execute_sidebar_action";
const SUGGESTED_KEY = { default: "Ctrl+Shift+U", mac: "Command+Shift+U" };
const COMMAND_DESCRIPTION = "Open the OpenSidekick sidebar";

// Keeping either would claim a permission the code cannot use.
const DROPPED_PERMISSIONS = ["sidePanel", "debugger"];

/** Pure transform, base manifest in, Firefox manifest out — no I/O, so the contract is asserted in memory. */
export function firefoxManifest(base) {
  const out = {};
  for (const key of Object.keys(base)) {
    if (key === "minimum_chrome_version") continue;
    if (key === "side_panel") {
      out.sidebar_action = {
        default_title: SIDEBAR_TITLE,
        default_panel: SIDEBAR_PANEL,
        open_at_install: false,
      };
      continue;
    }
    if (key === "name") {
      out.name = FF_NAME;
      continue;
    }
    if (key === "action") {
      out.action = { ...structuredClone(base.action), default_title: ACTION_TITLE };
      continue;
    }
    if (key === "background") {
      out.background = {
        scripts: [base.background.service_worker],
        type: base.background.type,
      };
      continue;
    }
    if (key === "permissions") {
      out.permissions = base.permissions.filter((p) => !DROPPED_PERMISSIONS.includes(p));
      continue;
    }
    if (key === "commands") {
      out.commands = {
        [SIDEBAR_COMMAND]: { suggested_key: { ...SUGGESTED_KEY }, description: COMMAND_DESCRIPTION },
      };
      continue;
    }
    // Deep-clone so mutating the output cannot reach the base manifest.
    out[key] = structuredClone(base[key]);
  }
  out.browser_specific_settings = {
    gecko: { strict_min_version: STRICT_MIN_VERSION },
  };
  return out;
}

// One line per key the transform touched, so the build output is the contract.
function keyDetail(key, b, o) {
  if (key === "name") return `${JSON.stringify(b)} → ${JSON.stringify(o)} (${o.length} chars)`;
  if (key === "action") return `default_title → ${JSON.stringify(o.default_title)}; default_icon unchanged`;
  if (key === "background") return `service_worker → scripts ${JSON.stringify(o.scripts)} type:${o.type}`;
  if (key === "permissions") {
    const dropped = b.filter((p) => !o.includes(p));
    return `${b.length} → ${o.length} (dropped ${dropped.join(", ")}; added none)`;
  }
  if (key === "commands") {
    return `${Object.keys(b).join(",")} → ${Object.keys(o).join(",")} (${o[SIDEBAR_COMMAND].suggested_key.default})`;
  }
  return JSON.stringify(o);
}

function summaryRows(base, out) {
  const rows = [];
  for (const key of Object.keys(base)) {
    if (!(key in out)) {
      rows.push(`removed ${key}: ${JSON.stringify(base[key])}`);
      continue;
    }
    const b = base[key];
    const o = out[key];
    if (JSON.stringify(b) === JSON.stringify(o)) continue;
    rows.push(`changed ${key}: ${keyDetail(key, b, o)}`);
  }
  for (const key of Object.keys(out)) {
    if (!(key in base)) rows.push(`added ${key}: ${keyDetail(key, undefined, out[key])}`);
  }
  return rows;
}

function buildFromDisk() {
  const base = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
  const out = firefoxManifest(base);

  // A stale dist/firefox/ keeps a deleted source file, including the vendor files.
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  for (const row of summaryRows(base, out)) console.log(row);
  writeFileSync(join(OUT_DIR, "manifest.json"), JSON.stringify(out, null, 2) + "\n");

  const copies = [["src", "src"], ["icons", "icons"], ["LICENSE", "LICENSE"]];
  for (const [from, to] of copies) {
    cpSync(join(ROOT, from), join(OUT_DIR, to), { recursive: true });
    console.log(`copied ${from} → ${relative(ROOT, join(OUT_DIR, to))}`);
  }
  console.log(`wrote ${relative(ROOT, join(OUT_DIR, "manifest.json"))}`);
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  buildFromDisk();
}
