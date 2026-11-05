// Key scrubbing for everything the eval writes to disk or stdout. Keys live
// only in this process's memory and in the proxy's outgoing requests; this is
// the last line of defence if one ever ends up in an error body or a log line.

const PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-or-v1-[A-Za-z0-9]{20,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /AIza[0-9A-Za-z_-]{30,}/g,
  /Bearer\s+[A-Za-z0-9._-]{16,}/gi,
  /x-api-key["':\s]+[A-Za-z0-9._-]{16,}/gi,
];

// Exact values of secret-looking env vars, longest first so a key that
// contains another is replaced whole. Read at call time: dry-run plants
// canaries after start-up.
function secretEnv() {
  return Object.entries(process.env)
    .filter(([k, v]) => /KEY|TOKEN|SECRET/i.test(k) && typeof v === "string" && v.length >= 12)
    .sort((a, b) => b[1].length - a[1].length);
}

export function scrub(input) {
  let s = String(input ?? "");
  for (const [name, value] of secretEnv()) s = s.split(value).join(`[redacted:${name}]`);
  for (const re of PATTERNS) s = s.replace(re, "[redacted]");
  return s;
}

// JSON.stringify, then scrub: the only way objects reach disk.
export function scrubJson(obj, space) {
  return scrub(JSON.stringify(obj, null, space));
}
