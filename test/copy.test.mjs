// Comments are blanked before the scan, so it fails only when shipped code names Chrome;
// vendored code is skipped, so a vendor bump must not fail it.

import fs from "node:fs";
import path from "node:path";
import { RESTRICTED_PAGE_HINT } from "../src/background/tools.js";

const SRC = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src");
const ROOT = path.join(SRC, "..");

let fail = 0;
const ok = (cond, label) => {
  if (cond) console.log(`ok  : ${label}`);
  else {
    console.log(`FAIL: ${label}`);
    fail++;
  }
};

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// Every newline is kept so line numbers match, and a string state is tracked so `//` in a URL is not a comment start.
function blankComments(src) {
  let out = "";
  let i = 0;
  let str = null;
  while (i < src.length) {
    const c = src[i];
    if (str) {
      out += c;
      if (c === "\\") {
        out += src[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === str) str = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      str = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      out += "  ";
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      i += 2;
      continue;
    }
    if (c === "<" && src.slice(i, i + 4) === "<!--") {
      i += 4;
      out += "    ";
      while (i < src.length && src.slice(i, i + 3) !== "-->") {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      i += 3;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (p.includes(`${path.sep}vendor${path.sep}`)) continue;
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(js|mjs|html|css)$/.test(e.name)) out.push(p);
  }
  return out.sort();
}

const NAMED = [];
for (const f of walk(SRC)) {
  const rel = path.relative(ROOT, f);
  const lines = blankComments(read(rel)).split("\n");
  lines.forEach((line, n) => {
    if (line.includes("Chrome")) NAMED.push(`${rel}:${n + 1}  ${line.trim()}`);
  });
}
ok(NAMED.length === 0, `no user-facing string in src names Chrome (found ${NAMED.length})`);
for (const l of NAMED) console.log(`  naming Chrome: ${l}`);

ok(RESTRICTED_PAGE_HINT.includes("about:"), `the restricted-page result names about: (got ${JSON.stringify(RESTRICTED_PAGE_HINT)})`);
ok(RESTRICTED_PAGE_HINT.includes("the browser's"), `the restricted-page result names the browser's own pages (got ${JSON.stringify(RESTRICTED_PAGE_HINT)})`);
ok(RESTRICTED_PAGE_HINT.includes("PDF"), "the restricted-page result keeps the PDF case");

const optionsHtml = read("src/options/options.html");
ok(optionsHtml.includes('id="cdp-hint"'), "options.html carries the cdp hint row the renderer writes to (#cdp-hint)");
ok(optionsHtml.includes('id="js-hint"'), "options.html carries the run-JavaScript hint row the renderer writes to (#js-hint)");

console.log(fail ? `\n${fail} COPY CHECK(S) FAILED` : "\nALL COPY CHECKS PASSED");
process.exit(fail ? 1 : 0);
