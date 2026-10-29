// `zip -r` appends to an archive that already exists, so a file deleted from `src`
// keeps shipping in later releases. This suite drives `npm run zip:firefox` in a
// throwaway copy of the repo essentials so the worktree's own dist/ is never written.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let fail = 0;
const ok = (cond, label) => {
  if (cond) console.log(`ok  : ${label}`);
  else {
    console.log(`FAIL: ${label}`);
    fail++;
  }
};

// The build script resolves its own root, so a copied tree gives a full run in isolation.
const TMP = mkdtempSync(join(ROOT, ".zip-firefox-tmp-"));
const XPI = join(TMP, "dist", "opensidekick-firefox.xpi");
for (const item of ["manifest.json", "package.json", "scripts", "src", "icons", "LICENSE"]) {
  cpSync(join(ROOT, item), join(TMP, item), { recursive: true });
}

const archiveNames = () => {
  const r = spawnSync("unzip", ["-Z1", XPI], { encoding: "utf8" });
  if (r.status !== 0) return null;
  return r.stdout.split("\n").filter(Boolean).filter((n) => !n.endsWith("/"));
};

const zipFirefox = () =>
  spawnSync("npm", ["run", "zip:firefox"], { cwd: TMP, encoding: "utf8" }).status === 0;

const builtFiles = (dir, prefix) => {
  const names = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) names.push(...builtFiles(join(dir, e.name), p));
    else names.push(p);
  }
  return names;
};

// Sentinel: a source file deleted in a later release that a stale archive keeps shipping.
mkdirSync(join(TMP, "dist"), { recursive: true});
const STALE = join(TMP, "stale");
mkdirSync(STALE);
writeFileSync(join(STALE, "old-content-script.js"), "// removed from src in a later release\n");
spawnSync("zip", ["-q", XPI, "old-content-script.js"], { cwd: STALE, encoding: "utf8" });
ok(archiveNames()?.includes("old-content-script.js"), "the stale archive starts with the sentinel entry");

// .DS_Store at two depths: the build copies src/ verbatim, so only the zip exclusion keeps them out.
writeFileSync(join(TMP, "src", ".DS_Store"), "mac cruft");
writeFileSync(join(TMP, "src", "background", ".DS_Store"), "mac cruft at depth");

ok(zipFirefox(), "npm run zip:firefox exits 0 (first run, over a stale archive)");
ok(existsSync(join(TMP, "dist", "firefox", "src", ".DS_Store")), "the .DS_Store fixture reaches the built tree");
ok(existsSync(join(TMP, "dist", "firefox", "src", "background", ".DS_Store")), "the deep .DS_Store fixture reaches the built tree");

const first = archiveNames();
ok(first !== null, "unzip -Z1 lists the archive");

ok(zipFirefox(), "npm run zip:firefox exits 0 (second run, over a full archive)");
const second = archiveNames();
const want = builtFiles(join(TMP, "dist", "firefox"), "").filter((n) => !n.split("/").includes(".DS_Store"));
ok([...second].sort().join("\n") === want.sort().join("\n"), "fresh xpi rebuilds (the archive is exactly the built tree)");

rmSync(TMP, { recursive: true, force: true });

console.log(fail ? `\n${fail} ZIP-FIREFOX CHECK(S) FAILED` : "\nALL ZIP-FIREFOX CHECKS PASSED");
process.exit(fail ? 1 : 0);
