// Product copy is browser-neutral, the debugger toggle says why it is dead, and
// the details markers are hidden in both engines.
//
// The scan reads the shipped source as text. Comments that name Chrome are
// engineering notes (the debugger API, the webkit alias), not product copy, so
// comments are blanked first and what is checked is the code and the strings that
// remain.
//
// Run: node test/copy.test.mjs

import fs from "node:fs";
import path from "node:path";
// The hint has one owner: src/common/browser.js. Importing it means the scan pins
// the string the product ships, not a copy kept here that goes stale the moment the
// wording moves.
import { CDP_HINT } from "../src/common/browser.js";

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

// Blank out comments, keeping every newline, so line numbers still match the file.
// A string state is tracked so that `//` inside a URL or a quote inside prose is not
// read as a comment start.
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

// Every file the shipped UI reads: HTML, JS, CSS. The scan is on the code that is
// left after comments go blank, so the only way to pass is for copy to be neutral.
// The vendored provider library is skipped: it is byte-pinned by test/vendor.test.mjs,
// upstream text we do not write, and a vendor bump must not fail the copy scan.
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

// ---- the debugger hint that replaces the field hint when there is no debugger ----
// The string lives in src/common/browser.js, which returns the row's decision; the
// scan here is that the options page applies it, and the behavioural assertions are
// in test/browser.test.mjs.
const optionsJs = read("src/options/options.js");
const optionsHtml = read("src/options/options.html");
const browserJs = read("src/common/browser.js");
ok(browserJs.includes(`"${CDP_HINT}"`), `browser.js carries the exact hint "${CDP_HINT}"`);
ok(optionsHtml.includes('<p class="hint" id="cdp-hint">'), `the field hint at options.html:191 has id="cdp-hint"`);
ok(optionsJs.includes('import { cdpAvailable } from "../background/cdp.js";'), "options.js imports cdpAvailable from ../background/cdp.js");
// Pins on local variable names are not the contract: renaming `const t` changes no
// behaviour. The pins are on the imports and on the composition the call site builds.
ok(optionsJs.includes('import { cdpToggle, CDP_HINT } from "../common/browser.js";'), "options.js imports the toggle decision and the shared hint from ../common/browser.js");
ok(optionsJs.includes("cdpToggle(cdpAvailable())"), "options.js builds the row's decision from cdpToggle(cdpAvailable())");

// The rest of the row stays wired as it is: the change handler, enable-js
// (world: MAIN works from Firefox 128) and enable-vision.
ok(optionsJs.includes('$("#enable-cdp").addEventListener("change"'), "the #enable-cdp change handler stays wired");
ok(optionsJs.includes('$("#enable-vision").checked = !!s.enableVision'), "enableVision is untouched");
ok(optionsJs.includes('$("#enable-js").checked = !!s.enableJsTool'), "enableJsTool is untouched");

// ---- copy: the phrasing says "the browser", the meaning is kept ----
const sidepanelJs = read("src/sidepanel/sidepanel.js");
const toolsJs = read("src/background/tools.js");
ok(optionsHtml.includes("via the browser's debugger"), "the debugger hint names the browser's debugger, not Chrome's");
ok(optionsHtml.includes("banner while a task runs; it clears when the task ends"), "the debugger banner sentence keeps its meaning");
ok(optionsHtml.includes("the chat that's open stays until the browser closes"), "the history hint says until the browser closes");
ok(optionsHtml.includes("on a repeating schedule while the browser is open"), "the scheduled hint says while the browser is open");
ok(optionsJs.includes("The chat that's open now stays until the browser closes"), "the turn-off dialog says until the browser closes");
ok(sidepanelJs.includes("chats aren't kept after the browser closes"), "the history menu says after the browser closes");

const reach = toolsJs.slice(toolsJs.indexOf("Could not reach the page."));
const reachText = reach.slice(0, reach.indexOf("navigated away.") + "navigated away.".length);
ok(reachText.includes("about:"), `the restricted-page result names about: (got ${JSON.stringify(reachText)})`);
ok(reachText.includes("the browser's"), `the restricted-page result names the browser's own pages (got ${JSON.stringify(reachText)})`);
ok(reachText.includes("PDF"), "the restricted-page result keeps the PDF case");

// ---- details markers: list-style: none is on every summary ----
// list-style is how Firefox hides a <summary> marker, the webkit rule is the other
// engine's. The scan checks that the property is present on the base selector behind
// each marker rule; the rule count is not asserted.
const CSS_FILES = ["src/sidepanel/sidepanel.css", "src/options/options.css"];
const rules = [];
for (const f of CSS_FILES) {
  const body = blankComments(read(f));
  for (const m of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    rules.push({ file: f, selector: m[1].trim().replace(/\s+/g, " "), content: m[2] });
  }
}
const markerRules = rules.filter((r) => r.selector.endsWith("::-webkit-details-marker"));
for (const r of markerRules) {
  const base = r.selector.slice(0, r.selector.length - "::-webkit-details-marker".length);
  const baseRule = rules.find((x) => x.selector === base);
  ok(
    baseRule && /list-style:\s*none/.test(baseRule.content) && /display:\s*none/.test(r.content),
    `${base} hides its marker in both engines (list-style on ${baseRule ? "the summary" : "no summary rule"}, display on the webkit rule)`,
  );
}

console.log(fail ? `\n${fail} COPY CHECK(S) FAILED` : "\nALL COPY CHECKS PASSED");
process.exit(fail ? 1 : 0);
