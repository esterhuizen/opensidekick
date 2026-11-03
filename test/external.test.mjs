// External agents: the bridge relays MCP over a pipe (two real processes), and
// the extension side gates every call (fake chrome).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

let ok = 0;
const check = (cond, msg) => {
  assert.ok(cond, msg);
  ok++;
  console.log("ok  : " + msg);
};

// --- Bridge relay -----------------------------------------------------------
const bridge = fileURLToPath(new URL("../native/opensidekick-bridge.mjs", import.meta.url));
const pipe =
  process.platform === "win32"
    ? `\\\\.\\pipe\\osk-test-${process.pid}`
    : path.join(os.tmpdir(), `osk-test-${process.pid}.sock`);
const env = { ...process.env, OPENSIDEKICK_PIPE: pipe };

// Host side: answer Chrome-framed requests like the extension would.
const host = spawn(process.execPath, [bridge], { env });
let hbuf = Buffer.alloc(0);
host.stdout.on("data", (chunk) => {
  hbuf = Buffer.concat([hbuf, chunk]);
  while (hbuf.length >= 4 && hbuf.length >= 4 + hbuf.readUInt32LE(0)) {
    const n = hbuf.readUInt32LE(0);
    const msg = JSON.parse(hbuf.subarray(4, 4 + n));
    hbuf = hbuf.subarray(4 + n);
    const res =
      msg.type === "list"
        ? { tools: [{ name: "read_page", description: "d", inputSchema: { type: "object" } }] }
        : { result: { content: [{ type: "text", text: "called " + msg.name }], isError: false } };
    const body = Buffer.from(JSON.stringify({ ...res, id: msg.id }));
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length);
    host.stdin.write(Buffer.concat([head, body]));
  }
});
await new Promise((r) => setTimeout(r, 500)); // let it listen

const mcp = spawn(process.execPath, [bridge, "--mcp"], { env });
const replies = new Map();
let mbuf = "";
mcp.stdout.on("data", (d) => {
  mbuf += d;
  let i;
  while ((i = mbuf.indexOf("\n")) >= 0) {
    const m = JSON.parse(mbuf.slice(0, i));
    mbuf = mbuf.slice(i + 1);
    replies.get(m.id)?.(m);
  }
});
const rpc = (id, method, params) =>
  new Promise((resolve) => {
    replies.set(id, resolve);
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

const init = await rpc(1, "initialize", { protocolVersion: "2025-06-18" });
check(init.result.serverInfo.name === "opensidekick", "initialize answers with the server info");
const list = await rpc(2, "tools/list", {});
check(list.result.tools[0].name === "read_page", "tools/list is relayed to the extension");
const call = await rpc(3, "tools/call", { name: "read_page", arguments: {} });
check(call.result.content[0].text === "called read_page", "tools/call is relayed and answered by id");
const bad = await rpc(4, "nope", {});
check(bad.error.code === -32601, "unknown methods get method-not-found");
mcp.kill();
host.kill();

// --- No bridge running -------------------------------------------------------
const lone = spawn(process.execPath, [bridge, "--mcp"], {
  env: { ...process.env, OPENSIDEKICK_PIPE: pipe + "-none" },
});
const err = await new Promise((resolve) => {
  lone.stdout.once("data", (d) => resolve(JSON.parse(String(d))));
  lone.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
});
check(/isn't reachable/.test(err.error.message), "a missing bridge says how to turn it on");
lone.kill();

// --- Gate ---------------------------------------------------------------------
const tabs = { 1: { id: 1, url: "https://example.com/", groupId: -1 } };
globalThis.chrome = {
  debugger: { onEvent: { addListener() {} }, onDetach: { addListener() {} } },
  runtime: { sendMessage: async () => ({ ok: true, url: "https://example.com/", elements: [] }) },
  scripting: { executeScript: async () => [] },
  tabs: {
    get: async (id) => tabs[id],
    sendMessage: async () => ({ ok: true, url: "https://example.com/", elements: [], clicked: "x" }),
  },
};
const { gatedCall, externalTools, toMcp } = await import("../src/background/external.js");
const { DEFAULT_SETTINGS } = await import("../src/common/constants.js");

const asked = [];
let answer = "once";
const deps = { requestPermission: async (d) => (asked.push(d), answer) };
const ctx = { getTabId: async () => 1, setTabId() {}, getGroupId: () => null, groupTab: async () => {} };
const cfg = (settings = {}, sitePermissions = {}) => ({
  settings: { ...DEFAULT_SETTINGS, ...settings },
  sitePermissions,
});

let r = await gatedCall("read_page", {}, cfg(), deps, ctx, new Set());
check(r.ok && asked.length === 0, "reads on a normal site don't ask");

const grants = new Set();
r = await gatedCall("click_element", { ref: 1 }, cfg({ autonomy: "auto" }, { "https://example.com": "allow" }), deps, ctx, grants);
check(asked.length === 1 && asked[0].sensitive, "an action asks even in auto mode on an always-allowed site, with no always button");
r = await gatedCall("click_element", { ref: 1 }, cfg(), deps, ctx, grants);
check(asked.length === 1, "Allow once covers the site for this connection");

answer = "decline";
r = await gatedCall("click_element", { ref: 1 }, cfg(), deps, ctx, new Set());
check(r.ok === false && /declined/.test(r.error), "a declined action doesn't run");

answer = "no-panel";
r = await gatedCall("click_element", { ref: 1 }, cfg(), deps, ctx, new Set());
check(r.ok === false && /side panel is closed/.test(r.error), "a closed panel is reported as such, not as the user's no");

r = await gatedCall("read_page", {}, cfg({}, { "https://example.com": "block" }), deps, ctx, new Set());
check(r.ok === false && /blocked/.test(r.error), "a blocked site stays blocked");

tabs[1].url = "https://www.paypal.com/";
const before = asked.length;
answer = "once";
const g2 = new Set();
await gatedCall("read_page", {}, cfg(), deps, ctx, g2);
await gatedCall("read_page", {}, cfg(), deps, ctx, g2);
check(asked.length === before + 2 && g2.size === 0, "a sensitive site asks every time, reads too, and grants nothing");
tabs[1].url = "https://example.com/";

r = await gatedCall("navigate", { url: "javascript:alert(1)" }, cfg(), deps, ctx, new Set());
check(r.ok === false && /http/.test(r.error), "only http(s) targets can be opened");

// Sessions end with their tab group.
const { newSession, alive } = await import("../src/background/external.js");
let groupTabs = [];
chrome.tabs.query = async () => groupTabs;
const sess = newSession();
check(await alive(sess), "a session with no tab yet is alive");
sess.ctx.setTabId(5);
await sess.ctx.groupTab(5); // fake chrome has no tabs.group: stays ungrouped
tabs[5] = { id: 5 };
check(await alive(sess), "an ungrouped session lives while its tab does");
delete tabs[5];
check(!(await alive(sess)), "an ungrouped session ends with its tab");
const s2 = newSession();
chrome.tabs.group = async () => 42;
chrome.tabGroups = { update: async () => {} };
s2.ctx.setTabId(5);
await s2.ctx.groupTab(5);
groupTabs = [{ id: 6 }];
check((await alive(s2)) && (await s2.ctx.getTabId()) === 6, "a closed tab moves the agent to another tab of its group");
groupTabs = [];
check(!(await alive(s2)), "a closed group ends the session");

check(!externalTools(DEFAULT_SETTINGS).some((t) => t.name === "run_javascript" || t.name === "finish"), "disabled tools and finish aren't offered");
const m = toMcp({ ok: true, image: { data: "AA", mediaType: "image/png" } });
check(m.content[1].type === "image" && !m.content[0].text.includes("AA"), "a screenshot becomes an MCP image block");

console.log(`\nALL EXTERNAL CHECKS PASSED (${ok})`);
