import { mcpToolName, flattenMcpContent } from "../src/background/mcp.js";

let fail = 0;
const ok = (c, m) => { console.log((c ? "ok  : " : "FAIL: ") + m); if (!c) fail = 1; };

// mcpToolName — namespaced + sanitized to a valid tool id.
ok(mcpToolName("github", "create_issue") === "mcp_github_create_issue", "namespaces server + tool");
ok(/^[a-zA-Z0-9_-]+$/.test(mcpToolName("My Server!", "do thing")), "sanitizes to a valid tool id");
ok(mcpToolName("x".repeat(80), "y").length <= 64, "caps length at 64");

// flattenMcpContent — text/resource/mixed/string.
ok(flattenMcpContent([{ type: "text", text: "hello" }]) === "hello", "flattens a text block");
ok(
  flattenMcpContent([{ type: "text", text: "a" }, { type: "text", text: "b" }]) === "a\nb",
  "joins multiple text blocks",
);
ok(flattenMcpContent([{ type: "resource", resource: { text: "R" } }]) === "R", "reads a resource's text");
ok(/\[image\]/.test(flattenMcpContent([{ type: "image", data: "…" }])), "labels non-text blocks");
ok(flattenMcpContent("plain") === "plain", "passes a plain string through");

console.log(fail ? "\nSOME MCP TESTS FAILED" : "\nALL MCP TESTS PASSED");
process.exit(fail);
