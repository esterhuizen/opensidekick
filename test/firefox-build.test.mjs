// The transform runs in memory, so `manifest.json`, the repo's capability surface,
// stays byte-identical under a packaging-only change.

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

// AMO caps `name` at 45 chars; the Chrome name is 47, so it is too long.
const AMO_NAME = "OpenSidekick — Bring Your Own LLM Agent";
const SIDEBAR_PANEL = "src/sidepanel/sidepanel.html";

const base = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "manifest.json"), "utf8"));
const snapshot = JSON.stringify(base);
const out = firefoxManifest(base);

const bgs = out.background ?? {};
const gecko = out.browser_specific_settings?.gecko ?? {};

for (const key of ["manifest_version", "version", "short_name", "description", "author", "homepage_url", "icons", "content_scripts", "host_permissions"]) {
  eq(out[key], base[key], `${key} unchanged`);
}

eq(out.name, AMO_NAME, "name is the AMO string with the em dash");

for (const key of ["minimum_chrome_version", "side_panel"]) {
  ok(!(key in out), `no top-level ${key}`);
}
ok(!("service_worker" in bgs), "no background.service_worker");
ok(!("persistent" in bgs), "no background.persistent");
ok(!("strict_max_version" in gecko), "no gecko.strict_max_version");
ok(!("gecko_android" in (out.browser_specific_settings ?? {})), "no gecko_android block");

eq(bgs.scripts, [base.background.service_worker], "background.scripts is the base worker path");
eq(bgs.type, "module", "background.type is module");

eq(out.sidebar_action, { default_title: "OpenSidekick", default_panel: SIDEBAR_PANEL, open_at_install: false }, "sidebar_action is the exact contract object");
eq(out.sidebar_action?.default_panel, base.side_panel.default_path, "sidebar_action.default_panel === base side_panel.default_path");

const KEEP = base.permissions.filter((p) => p !== "sidePanel" && p !== "debugger");
eq(out.permissions, KEEP, "permissions keeps every base permission except sidePanel and debugger, in base order");

eq(Object.keys(out.commands ?? {}), ["_execute_sidebar_action"], "commands keys are exactly [_execute_sidebar_action]");
eq(out.commands?._execute_sidebar_action?.suggested_key?.default, "Ctrl+Shift+U", "suggested key is Ctrl+Shift+U");
eq(out.commands?._execute_sidebar_action?.suggested_key?.mac, "Command+Shift+U", "mac key is Command+Shift+U");
eq(out.commands?._execute_sidebar_action?.description, "Open the OpenSidekick sidebar", "the command description is the sidebar wording");

eq(out.action?.default_title, "Open OpenSidekick (Ctrl+Shift+U / Cmd+Shift+U)", "the action title names the key");
eq(out.action?.default_icon, base.action.default_icon, "action.default_icon unchanged");

// The old key must be gone from every byte, not just from commands.
ok(!JSON.stringify(out).includes("Ctrl+Shift+E"), "no Ctrl+Shift+E anywhere in the Firefox manifest");

// The add-on id is permanent and the data-collection disclosure has to match
// what is really sent to the model provider, so the build ships the version floor only.
eq(gecko.strict_min_version, "140.0", "gecko.strict_min_version is 140.0");
eq(Object.keys(gecko), ["strict_min_version"], "gecko key set is exactly [strict_min_version]");

const WANT_KEYS = ["manifest_version", "name", "short_name", "version", "description", "author", "homepage_url", "icons", "action", "background", "sidebar_action", "options_page", "content_scripts", "permissions", "host_permissions", "commands", "browser_specific_settings"];
eq(Object.keys(out), WANT_KEYS, "output key set is base minus minimum_chrome_version/side_panel plus sidebar_action/browser_specific_settings, in order");

ok(JSON.stringify(base) === snapshot, "the transform does not mutate the base manifest.json");
out.content_scripts[0].js.push("x");
out.icons["16"] = "mutated";
out.permissions.push("idle");
ok(JSON.stringify(base) === snapshot, "the output is deep-cloned, so mutating it cannot reach the base manifest");

console.log(fail ? `\n${fail} FIREFOX BUILD CHECK(S) FAILED` : "\nALL FIREFOX BUILD CHECKS PASSED");
process.exit(fail ? 1 : 0);
