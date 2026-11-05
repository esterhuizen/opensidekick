// Product facts for the fake OpenSidekick sites, read from the repo itself so
// they never drift: the installed version from manifest.json, release notes
// from CHANGELOG.md, docs from README.md and PRIVACY.md.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

export const MANIFEST = JSON.parse(read("manifest.json"));
export const INSTALLED = MANIFEST.version;
export const CWS_ID = "idffinkmnnajgpjjonpmmaikjbpjmngk";
export const README = read("README.md");
export const PRIVACY = read("PRIVACY.md");
export const CHANGELOG = read("CHANGELOG.md");

// [{ version, date, body }] in file order, released versions only.
export const RELEASES = (() => {
  const out = [];
  const re = /^## \[(\d+\.\d+\.\d+)\](?:\s*[—-]\s*(\d{4}-\d{2}-\d{2}))?\s*$/gm;
  const heads = [...CHANGELOG.matchAll(re)];
  heads.forEach((m, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].index : CHANGELOG.length;
    out.push({ version: m[1], date: m[2] || "", body: CHANGELOG.slice(m.index + m[0].length, end).trim() });
  });
  return out;
})();

export function nextPatch(v) {
  const [a, b, c] = v.split(".").map(Number);
  return `${a}.${b}.${c + 1}`;
}

export function cmpVersion(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

// The release notes for a store version newer than any in CHANGELOG.
export const SYNTHETIC_NOTES = `### Fixed

- **Faster page reads** on very long pages.
- **Clearer permission cards** for sites opened in a new tab.`;

export function releaseFor(version, today) {
  const r = RELEASES.find((x) => x.version === version);
  if (r) return r;
  return { version, date: isoDate(today), body: SYNTHETIC_NOTES };
}

export function isoDate(d) {
  return new Date(d).toISOString().slice(0, 10);
}

export function longDate(iso) {
  return new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

// Bold titles of a release's "### Added" bullets (ver-whats-new ground truth).
export function addedTitles(body) {
  const added = (body.split(/^### /m).find((s) => /^Added\b/.test(s)) || "");
  return [...added.matchAll(/^- \*\*(.+?)\*\*/gm)].map((m) => m[1].replace(/`/g, "").replace(/[.]+$/, ""));
}
