import { matchPrompts, isSlashQuery } from "../src/common/prompts.js";

let fail = 0;
const ok = (c, m) => { console.log((c ? "ok  : " : "FAIL: ") + m); if (!c) fail = 1; };

const prompts = [
  { command: "summarize", text: "Summarize this page in 3 bullets." },
  { command: "sum-table", text: "Extract the main table as CSV." },
  { command: "email", text: "Find the contact email on this page." },
];

// matchPrompts
ok(matchPrompts(prompts, "/").length === 3, "empty query returns all prompts");
ok(matchPrompts(prompts, "/sum").map((p) => p.command).join(",") === "summarize,sum-table", "prefix match, in order");
ok(matchPrompts(prompts, "/table").some((p) => p.command === "sum-table"), "substring match on command");
ok(matchPrompts(prompts, "/contact").some((p) => p.command === "email"), "match on prompt body text");
ok(matchPrompts(prompts, "/zzz").length === 0, "no matches");
ok(matchPrompts([], "/x").length === 0, "empty prompt list is safe");

// isSlashQuery
ok(isSlashQuery("/sum") === true, "'/sum' is a slash query");
ok(isSlashQuery("hello") === false, "plain text is not a slash query");
ok(isSlashQuery("/sum\nmore") === false, "multi-line is not a slash query");
ok(isSlashQuery("") === false, "empty string is not a slash query");

console.log(fail ? "\nSOME PROMPT TESTS FAILED" : "\nALL PROMPT TESTS PASSED");
process.exit(fail);
