// No repo script fetches and runs code that the lockfile pins.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

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

const fetching = Object.keys(pkg.scripts).filter((k) => pkg.scripts[k].includes("npx"));
eq(fetching, [], "no npx in scripts");

console.log(fail ? `\n${fail} PACKAGE-SCRIPT CHECK(S) FAILED` : "\nALL PACKAGE-SCRIPT CHECKS PASSED");
process.exit(fail ? 1 : 0);
