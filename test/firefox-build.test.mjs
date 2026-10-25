// Contract test for the Firefox packaging transform: the shipped Chrome
// manifest in, the AMO-shaped manifest out. The transform runs in memory, so
// nothing is written to disk — this is the seam that keeps `manifest.json`,
// the repo's capability surface, byte-identical under a packaging-only change.
//
// Run: node test/firefox-build.test.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { firefoxManifest } from "../scripts/build-firefox.mjs";

let fail = 0;
const eq = (got, want, label) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) console.log(`ok  : ${label}`);
  else {
    console.log(`FAIL: ${label}\n  got : ${g}\n  want: ${w}`);
    fail++;
  }
};
const ok = (cond, label) => {
  if (cond) console.log(`ok  : ${label}`);
  else {
    console.log(`FAIL: ${label}`);
    fail++;
  }
};

// Verbatim from the AMO contract: Firefox caps `name` at 45 chars, so the
// Chrome name ("OpenSidekick — Bring-Your-Own-LLM Browser Agent", 47) is too long.
const AMO_NAME = "OpenSidekick — Bring Your Own LLM Agent";
const SIDEBAR_PANEL = "src/sidepanel/sidepanel.html";

const base = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "manifest.json"), "utf8"));
const snapshot = JSON.stringify(base);
const out = firefoxManifest(base);

const bgs = out.background ?? {};
const gecko = out.browser_specific_settings?.gecko ?? {};

// ---- Keys that must survive unchanged ----
for (const key of ["manifest_version", "version", "short_name", "description", "author", "homepage_url", "icons", "content_scripts", "host_permissions"]) {
  eq(out[key], base[key], `${key} unchanged`);
}

// ---- AMO name limit ----
eq(out.name, AMO_NAME, "name is the AMO string with the em dash");
eq(out.name.length <= 45, true, `name is at most 45 chars (got ${out.name.length})`);
eq(out.version, base.version, "version equal to base");

// ---- Chrome-only keys deleted ----
for (const key of ["minimum_chrome_version", "side_panel", "persistent"]) {
  ok(!(key in out), `no top-level ${key}`);
}
ok(!("service_worker" in bgs), "no background.service_worker");
ok(!("persistent" in bgs), "no background.persistent");
ok(!("strict_max_version" in gecko), "no gecko.strict_max_version");
ok(!("gecko_android" in (out.browser_specific_settings ?? {})), "no gecko_android block");

// ---- Background script module ----
eq(bgs.scripts, [base.background.service_worker], "background.scripts is the base worker path");
eq(bgs.scripts?.[0], base.background.service_worker, "background.scripts[0] === base background.service_worker");
eq(bgs.type, "module", "background.type is module");

// ---- sidebar_action replaces side_panel ----
eq(out.sidebar_action, { default_title: "OpenSidekick", default_panel: SIDEBAR_PANEL, open_at_install: false }, "sidebar_action is the exact contract object");
eq(out.sidebar_action?.default_panel, base.side_panel.default_path, "sidebar_action.default_panel === base side_panel.default_path");

// ---- Permissions: drop sidePanel + debugger, add nothing ----
const KEEP = base.permissions.filter((p) => p !== "sidePanel" && p !== "debugger");
eq(out.permissions, KEEP, "permissions keeps every base permission except sidePanel and debugger, in base order");
ok(!(out.permissions ?? []).includes("sidePanel"), "no sidePanel permission");
ok(!(out.permissions ?? []).includes("debugger"), "no debugger permission");
ok(!(out.permissions ?? []).includes("sidebar"), "no sidebar permission (no grant is required)");
eq((out.permissions ?? []).length, base.permissions.length - 2, "permissions adds nothing (count is base - 2)");

// ---- The keyboard command ----
eq(Object.keys(out.commands ?? {}), ["_execute_sidebar_action"], "commands keys are exactly [_execute_sidebar_action]");
eq(!(("_execute_action") in (out.commands ?? {})), true, "no _execute_action command");
eq(out.commands?._execute_sidebar_action?.suggested_key, { default: "Ctrl+Shift+E", mac: "Command+Shift+E" }, "the suggested key is Ctrl+Shift+E / Command+Shift+E");
eq(out.commands?._execute_sidebar_action?.description, "Open the OpenSidekick sidebar", "the command description is the sidebar wording");

// ---- Action title names the new shortcut; the icon is untouched ----
eq(out.action?.default_title, "Open OpenSidekick (Ctrl+Shift+E / Cmd+Shift+E)", "action.default_title mentions Ctrl+Shift+E");
eq(out.action?.default_icon, base.action.default_icon, "action.default_icon unchanged");

// ---- browser_specific_settings.gecko ----
eq(gecko.id, "opensidekick@opensidekick.app", "gecko.id is the AMO add-on id");
eq(gecko.strict_min_version, "140.0", "gecko.strict_min_version is 140.0");
eq(gecko.data_collection_permissions, { required: ["none"], optional: ["personalCommunications", "websiteContent", "websiteActivity"] }, "data_collection_permissions is the proposed AMO disclosure");

// ---- No stray key: the key set is base minus the two Chrome keys, plus the two Firefox keys ----
const WANT_KEYS = ["manifest_version", "name", "short_name", "version", "description", "author", "homepage_url", "icons", "action", "background", "sidebar_action", "options_page", "content_scripts", "permissions", "host_permissions", "commands", "browser_specific_settings"];
eq(Object.keys(out), WANT_KEYS, "output key set is base minus minimum_chrome_version/side_panel plus sidebar_action/browser_specific_settings, in order");

// ---- The transform is pure: the shipped manifest is never mutated ----
ok(JSON.stringify(base) === snapshot, "the transform does not mutate the base manifest.json");
out.content_scripts[0].js.push("x");
out.icons["16"] = "mutated";
out.permissions.push("idle");
ok(JSON.stringify(base) === snapshot, "the output is deep-cloned, so mutating it cannot reach the base manifest");

console.log(fail ? `\n${fail} FIREFOX BUILD CHECK(S) FAILED` : "\nALL FIREFOX BUILD CHECKS PASSED");
process.exit(fail ? 1 : 0);
