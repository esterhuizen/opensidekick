// Local agents: the bridge relays MCP over a private pipe (two real processes),
// and the extension side pairs and gates every call (fake chrome).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

let ok = 0;
const check = (cond, msg) => {
  assert.ok(cond, msg);
  ok++;
  console.log("ok  : " + msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Bridge relay -----------------------------------------------------------
const bridge = fileURLToPath(new URL("../native/opensidekick-bridge.mjs", import.meta.url));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "osk-bridge-"));
const env = { ...process.env, HOME, LOCALAPPDATA: HOME, USERPROFILE: HOME };
const STATE = process.platform === "win32" ? path.join(HOME, "OpenSidekick") : path.join(HOME, ".opensidekick");
const UNIX = process.platform !== "win32";

// Host side: answer Chrome-framed requests like the extension would.
let pairAnswer = { ok: true };
const seen = [];
function startHost() {
  const host = spawn(process.execPath, [bridge, "chrome-extension://test/"], { env });
  let hbuf = Buffer.alloc(0);
  host.stdout.on("data", (chunk) => {
    hbuf = Buffer.concat([hbuf, chunk]);
    while (hbuf.length >= 4 && hbuf.length >= 4 + hbuf.readUInt32LE(0)) {
      const n = hbuf.readUInt32LE(0);
      const msg = JSON.parse(hbuf.subarray(4, 4 + n));
      hbuf = hbuf.subarray(4 + n);
      seen.push(msg);
      if (msg.type === "closed") continue;
      const res =
        msg.type === "hello"
          ? pairAnswer
          : msg.type === "list"
            ? { tools: [{ name: "read_page", description: "d", inputSchema: { type: "object" } }] }
            : { result: { content: [{ type: "text", text: `called ${msg.name} on conn ${msg.conn}` }], isError: false } };
      const body = Buffer.from(JSON.stringify({ ...res, id: msg.id }));
      const head = Buffer.alloc(4);
      head.writeUInt32LE(body.length);
      host.stdin.write(Buffer.concat([head, body]));
    }
  });
  return host;
}
function mcpClient() {
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
  let n = 0;
  mcp.rpc = (method, params) =>
    new Promise((resolve) => {
      const id = ++n;
      replies.set(id, resolve);
      mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  return mcp;
}
const waitFor = async (cond, ms = 3000) => {
  for (let t = 0; t < ms && !cond(); t += 50) await sleep(50);
  return cond();
};

const host = startHost();
check(await waitFor(() => fs.existsSync(path.join(STATE, "bridge.json"))), "the host writes bridge.json once it listens");
const info = JSON.parse(fs.readFileSync(path.join(STATE, "bridge.json"), "utf8"));
check(/^[0-9a-f]{64}$/.test(info.token), "bridge.json carries a random 256-bit token");
if (UNIX) {
  check((fs.statSync(STATE).mode & 0o777) === 0o700, "the state folder is private (0700)");
  check((fs.statSync(path.join(STATE, "bridge.json")).mode & 0o777) === 0o600, "bridge.json is private (0600)");
  check(info.pipe === path.join(STATE, "bridge.sock") && (fs.statSync(info.pipe).mode & 0o077) === 0, "the socket lives in the private folder and is closed to others");
}

const mcp = mcpClient();
const init = await mcp.rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "test-agent" } });
check(init.result.serverInfo.name === "opensidekick", "initialize answers with the server info");
const list = await mcp.rpc("tools/list", {});
check(list.result.tools[0].name === "read_page", "tools/list is relayed to the extension");
const hello = seen.find((m) => m.type === "hello");
check(hello && hello.client === "test-agent" && !("token" in hello), "the first request pairs, naming the client, and the token never reaches the extension");
const call = await mcp.rpc("tools/call", { name: "read_page", arguments: {} });
check(call.result.content[0].text === `called read_page on conn ${hello.conn}`, "tools/call is relayed, tagged with its connection");
const big = await mcp.rpc("tools/call", { name: "upload_file", arguments: { content: "x".repeat(1_100_000) } });
check(big.result?.isError && /too big/.test(big.result.content[0].text), "a request over Chrome's 1 MB cap is refused, not forwarded");
const bad = await mcp.rpc("nope", {});
check(bad.error.code === -32601, "unknown methods get method-not-found");
mcp.kill();
check(await waitFor(() => seen.some((m) => m.type === "closed" && m.conn === hello.conn)), "a client hanging up is reported, so its session ends");

// A raw client without the token gets nothing.
const rogue = await new Promise((resolve) => {
  const s = net.connect(info.pipe);
  let out = "";
  s.on("data", (d) => (out += d));
  s.on("close", () => resolve(out));
  s.on("error", () => resolve(out));
  s.write(JSON.stringify({ type: "hello", token: "0".repeat(64), client: "x", id: 1 }) + "\n");
  s.write(JSON.stringify({ id: 2, msg: { type: "list" } }) + "\n");
});
check(/Not authorised/.test(rogue) && !/read_page/.test(rogue), "a wrong token is refused and the connection closed");
const before = seen.length;
const skip = await new Promise((resolve) => {
  const s = net.connect(info.pipe);
  let out = "";
  s.on("data", (d) => (out += d));
  s.on("close", () => resolve(out));
  s.write(JSON.stringify({ id: 1, msg: { type: "call", name: "read_page" } }) + "\n");
});
check(/Not authorised/.test(skip) && seen.length === before, "a call without a hello never reaches the extension");

// The user declines the pairing card.
pairAnswer = { error: "The user didn't allow this connection." };
const shy = mcpClient();
await shy.rpc("initialize", {});
const refused = await shy.rpc("tools/list", {});
check(/didn't allow/.test(refused.error?.message || ""), "a declined pairing fails the agent's request");
shy.kill();
pairAnswer = { ok: true };

// A second Chrome profile doesn't take the pipe over.
const second = spawn(process.execPath, [bridge, "chrome-extension://test/"], { env });
const code = await new Promise((r) => second.on("exit", r));
const info2 = JSON.parse(fs.readFileSync(path.join(STATE, "bridge.json"), "utf8"));
check(code === 0 && info2.token === info.token, "a second host leaves a live bridge alone");

host.stdin.end();
check(await waitFor(() => !fs.existsSync(path.join(STATE, "bridge.json"))), "the host removes bridge.json when Chrome closes the port");

// No bridge running.
const lone = mcpClient();
await lone.rpc("initialize", {});
const err = await lone.rpc("tools/list", {});
check(/isn't reachable/.test(err.error.message), "a missing bridge says how to turn it on");
lone.kill();

if (UNIX) {
  // A bridge.json someone else could have written is not trusted.
  fs.writeFileSync(path.join(STATE, "bridge.json"), JSON.stringify({ pipe: "/tmp/elsewhere.sock", token: "t" }), { mode: 0o644 });
  fs.chmodSync(path.join(STATE, "bridge.json"), 0o644);
  const wary = mcpClient();
  await wary.rpc("initialize", {});
  const e2 = await wary.rpc("tools/list", {});
  check(/isn't reachable/.test(e2.error.message), "a bridge.json readable by others is refused");
  wary.kill();
  fs.chmodSync(STATE, 0o755);
  const { ensureStateDir } = await import("../native/opensidekick-bridge.mjs");
  ensureStateDir(STATE);
  check((fs.statSync(STATE).mode & 0o777) === 0o700, "a loosened state folder is closed again");
}
fs.rmSync(HOME, { recursive: true, force: true });

// --- Gate ---------------------------------------------------------------------
let nextTab = 10;
const tabs = { 1: { id: 1, url: "https://mail.example.com/inbox", groupId: -1, windowId: 1, active: true } }; // the user's own tab
const page = { elements: [{ ref: 1, name: "Next" }, { ref: 2, name: "Delete account" }] };
const ran = [];
globalThis.chrome = {
  debugger: { onEvent: { addListener() {} }, onDetach: { addListener() {} } },
  runtime: { sendMessage: async () => ({}) },
  scripting: { executeScript: async () => [{ result: { ok: true, result: "1" } }] },
  tabs: {
    get: async (id) => {
      if (!tabs[id]) throw new Error("No tab");
      return tabs[id];
    },
    create: async ({ url }) => (tabs[nextTab] = { id: nextTab++, url, groupId: -1, windowId: 1, status: "complete" }),
    update: async (id, p) => Object.assign(tabs[id], p),
    query: async () => Object.values(tabs),
    onUpdated: { addListener() {}, removeListener() {} },
    sendMessage: async (id, msg) => {
      ran.push([msg.type, msg.action || ""]);
      if (msg.type === "cs_ping") return { ok: true };
      if (msg.type === "cs_read_page") return { ok: true, url: tabs[id].url, ...page };
      if (msg.type === "cs_get_text") return { ok: true, url: tabs[id].url, text: "hello" };
      return { ok: true, url: tabs[id].url };
    },
  },
};
const { handle, gatedCall, externalTools, toMcp, newSession, clientLabel } = await import("../src/background/external.js");
const { DEFAULT_SETTINGS } = await import("../src/common/constants.js");

const asked = [];
let answer = "once";
const config = (settings = {}, sitePermissions = {}) => ({
  settings: { ...DEFAULT_SETTINGS, enableExternal: true, ...settings },
  sitePermissions,
});
let cfg = config();
const deps = {
  loadConfig: async () => cfg,
  requestPermission: async (d) => (asked.push(d), answer),
  isBusy: () => false,
};
const sessions = new Map();

let r = await handle({ type: "list", conn: 1 }, deps, sessions);
check(/isn't approved/.test(r.error), "an unpaired connection gets nothing, not even the tool list");
answer = "decline";
r = await handle({ type: "hello", conn: 1, client: "Claude Code" }, deps, sessions);
check(/didn't allow/.test(r.error) && asked[0].pairing && !sessions.has(1), "pairing asks first; a no leaves the connection unpaired");
answer = "once";
r = await handle({ type: "hello", conn: 1, client: "Claude Code‮<b>" }, deps, sessions);
check(r.ok && sessions.has(1), "an approved pairing opens the connection");
check(asked[1].client === 'A local agent ("Claude Codeb")', "the client's self-chosen name is cleaned and shown as a claim");
cfg = config({ enableExternal: false });
r = await handle({ type: "list", conn: 1 }, deps, sessions);
check(/turned off/.test(r.error), "turning the setting off stops a paired connection too");
cfg = config();

const tools = externalTools(DEFAULT_SETTINGS).map((t) => t.name);
check(!tools.includes("finish") && !tools.includes("ask_user"), "finish and ask_user aren't offered");
check(!tools.includes("take_screenshot") && !tools.includes("run_javascript"), "vision and JavaScript tools follow their settings");
check(externalTools({ ...DEFAULT_SETTINGS, enableJsTool: true }, { jsAvailable: false }).every((t) => t.name !== "run_javascript"), "a tool the browser can't run isn't offered");

const s = newSession("agent");
const n0 = asked.length;
r = await gatedCall("read_page", {}, cfg, deps, s);
check(r.ok === false && /no tab yet/.test(r.error) && !ran.length, "with no tab of its own, a read is refused: the user's tab is never touched");
r = await gatedCall("list_tabs", {}, cfg, deps, s);
check(r.ok && r.tabs.length === 0, "list_tabs doesn't show the user's tabs");
r = await gatedCall("navigate", { url: "https://shop.example.org/" }, cfg, deps, s);
check(r.ok && s.tabId >= 10 && tabs[1].url.includes("mail"), "a first navigate opens a new tab instead of taking over the user's");
check(asked.length === n0 + 1 && asked.at(-1).origin === "https://shop.example.org", "opening a new site asks");
r = await gatedCall("switch_tab", { tab_id: 1 }, cfg, deps, s);
check(r.ok === false && /among your tabs/.test(r.error), "the user's own tab is out of reach");

const n1 = asked.length;
r = await gatedCall("read_page", {}, cfg, deps, s);
check(r.ok && asked.length === n1, "a read on a site allowed for this connection doesn't ask again");
r = await gatedCall("click_element", { ref: 1 }, cfg, deps, s);
check(r.ok && asked.length === n1, "a plain click there doesn't ask again");
r = await gatedCall("click_element", { ref: 2 }, cfg, deps, s);
check(asked.length === n1 + 1 && asked.at(-1).label === "Delete account", "a Delete-like click asks every time, naming the element");
r = await gatedCall("click_element", { ref: 99 }, cfg, deps, s);
check(r.ok === false && /Unknown ref/.test(r.error), "a ref the last read didn't return is refused");
r = await gatedCall("upload_file", { ref: 1, name: "a.txt", content: "secret" }, cfg, deps, s);
check(asked.at(-1).toolName === "upload_file" && asked.at(-1).args.content === "secret", "an upload asks every time and the card gets the content");

// A redirect to another site: the next read asks for that site.
tabs[s.tabId].url = "https://other.example.net/";
const n2 = asked.length;
r = await gatedCall("get_page_text", {}, cfg, deps, s);
check(asked.length === n2 + 1 && asked.at(-1).origin === "https://other.example.net", "a read on a site not allowed yet asks, even after a redirect");
r = await gatedCall("click_element", { ref: 1 }, cfg, deps, s);
check(r.ok === false && /Unknown ref/.test(r.error), "refs read on one site can't be used on another");

// The page changes while the card is up.
tabs[s.tabId].url = "https://new.example.com/";
deps.requestPermission = async (d) => {
  asked.push(d);
  tabs[s.tabId].url = "https://evil.example.com/";
  return "once";
};
const before2 = ran.length;
r = await gatedCall("get_page_text", {}, cfg, deps, s);
check(r.ok === false && /changed while waiting/.test(r.error) && ran.length === before2, "an approval for one site doesn't run on another");
deps.requestPermission = async (d) => (asked.push(d), answer);

// Sensitive sites ask every time, reads too, and grant nothing.
tabs[s.tabId].url = "https://www.paypal.com/";
const n3 = asked.length;
await gatedCall("get_page_text", {}, cfg, deps, s);
await gatedCall("get_page_text", {}, cfg, deps, s);
check(asked.length === n3 + 2 && !s.grants.has("https://www.paypal.com"), "a sensitive site asks every time, reads too");

r = await gatedCall("get_page_text", {}, config({}, { "https://www.paypal.com": "block" }), deps, s);
check(r.ok === false && /blocked/.test(r.error), "a blocked site stays blocked");

answer = "no-panel";
tabs[s.tabId].url = "https://fresh.example.com/";
r = await gatedCall("get_page_text", {}, cfg, deps, s);
check(r.ok === false && /side panel is closed/.test(r.error), "a closed panel is reported as such, not as the user's no");

// Declines stick, and three end the connection's calls.
answer = "decline";
r = await gatedCall("get_page_text", {}, cfg, deps, s);
check(r.ok === false && /declined/.test(r.error), "a declined call doesn't run");
const n4 = asked.length;
r = await gatedCall("get_page_text", {}, cfg, deps, s);
check(asked.length === n4 && /declined this site/.test(r.error), "a declined site isn't asked about again");
for (const host of ["a", "b"]) {
  tabs[s.tabId].url = `https://${host}.example.com/`;
  await gatedCall("get_page_text", {}, cfg, deps, s);
}
sessions.set(2, s);
r = await handle({ type: "call", conn: 2, name: "get_page_text", args: {} }, deps, sessions);
check(/closed to further calls/.test(r.error), "after three declines the connection can't flood the panel");
answer = "once";

r = await gatedCall("navigate", { url: "javascript:alert(1)" }, cfg, deps, newSession());
check(r.ok === false && /http/.test(r.error), "only http(s) targets can be opened");
check(clientLabel("") === "A local agent", "a nameless client is just a local agent");

const m = toMcp({ ok: true, image: { data: "AA", mediaType: "image/png" } });
check(m.content[1].type === "image" && !m.content[0].text.includes("AA"), "a screenshot becomes an MCP image block");

console.log(`\nALL EXTERNAL CHECKS PASSED (${ok})`);
process.exit(0);
