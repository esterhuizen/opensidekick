// Packages the extension for Firefox by transforming manifest.json into
// dist/firefox/manifest.json. The shipped Chrome manifest is the single source
// of truth and is never written, so a packaging-only change cannot silently
// move the capability surface.
//
// Firefox has no MV3 service worker: a background is declared as
// `background.scripts` (module), not `service_worker`, and `persistent` is
// rejected in MV3.
//
// Firefox has no `side_panel`; `sidebar_action` is the equivalent and needs no
// extra permission (w3c/webextensions #387), so `sidePanel` is dropped and no
// `sidebar` permission is added.
//
// Firefox has no `chrome.debugger`, so the `debugger` permission is dropped;
// the console/network tools degrade to "not available" in the code.
//
// AMO rules: `name` capped at 45 chars, an add-on `id`, `strict_min_version`
// 140.0 (first Firefox with MV3 module background scripts plus
// `data_collection_permissions`), a data-collection disclosure, and no
// `minimum_chrome_version`, `strict_max_version` (fails AMO schema) or gecko_android.
//
// Run: node scripts/build-firefox.mjs

import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "dist", "firefox");

// Verbatim AMO contract values.
const FF_NAME = "OpenSidekick — Bring Your Own LLM Agent"; // 39 chars, base name is 47
const GECKO_ID = "opensidekick@opensidekick.app";
const STRICT_MIN_VERSION = "140.0";
const SIDEBAR_PANEL = "src/sidepanel/sidepanel.html";
const SIDEBAR_TITLE = "OpenSidekick";
const ACTION_TITLE = "Open OpenSidekick (Ctrl+Shift+E / Cmd+Shift+E)";
const SIDEBAR_COMMAND = "_execute_sidebar_action";
const SUGGESTED_KEY = { default: "Ctrl+Shift+E", mac: "Command+Shift+E" };
const COMMAND_DESCRIPTION = "Open the OpenSidekick sidebar";

// AMO penalises a listing that promises collection the code does not perform.
// Prompts and page text go only to the provider the user configures, only when
// the user asks; there is no analytics, telemetry, or phone-home.
const DATA_COLLECTION_PERMISSIONS = {
  required: ["none"],
  optional: ["personalCommunications", "websiteContent", "websiteActivity"],
};

// `sidePanel` has no Firefox equivalent to grant, and `debugger` does not exist
// in Firefox; keeping either would claim a permission the code cannot use.
const DROPPED_PERMISSIONS = ["sidePanel", "debugger"];

/**
 * The transform: base Chrome manifest in, Firefox manifest out. Pure — it does
 * no I/O, so `test/firefox-build.test.mjs` can assert the whole contract in
 * memory against `manifest.json`.
 */
export function firefoxManifest(base) {
  const out = {};
  for (const key of Object.keys(base)) {
    if (key === "minimum_chrome_version") continue; // Chrome-only floor
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
    // Deep-clone every carried-over value so the returned manifest can never
    // alias the base — mutating the Firefox manifest must not reach the Chrome one.
    out[key] = structuredClone(base[key]);
  }
  out.browser_specific_settings = {
    gecko: {
      id: GECKO_ID,
      strict_min_version: STRICT_MIN_VERSION,
      data_collection_permissions: structuredClone(DATA_COLLECTION_PERMISSIONS),
    },
  };
  return out;
}

// One line per key the transform touched, so the console output of
// `npm run build:firefox` is the contract, not a silent copy.
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

  // Fresh tree every run: a stale dist/firefox/ can keep a deleted source file,
  // including the byte-pinned vendor files. Only dist/ is ever written.
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  for (const row of summaryRows(base, out)) console.log(row);
  writeFileSync(join(OUT_DIR, "manifest.json"), JSON.stringify(out, null, 2) + "\n");

  // The Chrome source is copied, not rewritten, so `src/common/vendor/**` stays
  // byte-identical under the pin in test/vendor.test.mjs.
  const copies = [["src", "src"], ["icons", "icons"], ["LICENSE", "LICENSE"]];
  for (const [from, to] of copies) {
    cpSync(join(ROOT, from), join(OUT_DIR, to), { recursive: true });
    console.log(`copied ${from} → ${relative(ROOT, join(OUT_DIR, to))}`);
  }
  console.log(`wrote ${relative(ROOT, join(OUT_DIR, "manifest.json"))}`);
}

// ---- Driver (runs last, and only when this file is executed directly) ----
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  buildFromDisk();
}
