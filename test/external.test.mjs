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
let bigReply = false;
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
            : bigReply
              ? { result: { content: [{ type: "text", text: "{}" }, { type: "image", data: "A".repeat(3_000_000), mimeType: "image/png" }], isError: false } }
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
check(hello && hello.client === "test-agent" && hello.protocol === 2 && !("token" in hello) && !JSON.stringify(seen).includes(info.token), "the first request pairs, naming the client and protocol; the token never reaches the extension");
const call = await mcp.rpc("tools/call", { name: "read_page", arguments: {} });
check(call.result.content[0].text === `called read_page on conn ${hello.conn}`, "tools/call is relayed, tagged with its connection");
const big = await mcp.rpc("tools/call", { name: "upload_file", arguments: { content: "x".repeat(1_100_000) } });
check(big.result?.isError && /too big/.test(big.result.content[0].text), "a request over Chrome's 1 MB cap is refused, not forwarded");
// A big reply (a HiDPI screenshot) must not drop the connection.
bigReply = true;
const shot = await mcp.rpc("tools/call", { name: "take_screenshot", arguments: {} });
bigReply = false;
check(shot.result?.content?.[1]?.data?.length === 3_000_000, "a 3 MB reply arrives whole");
const after = await mcp.rpc("tools/call", { name: "read_page", arguments: {} });
check(after.result?.content?.[0]?.text?.startsWith("called read_page") && seen.filter((m) => m.type === "hello").length === 1, "the connection survives it, with no new pairing");
const bad = await mcp.rpc("nope", {});
check(bad.error.code === -32601, "unknown methods get method-not-found");
mcp.kill();
check(await waitFor(() => seen.some((m) => m.type === "closed" && m.conn === hello.conn)), "a client hanging up is reported, so its session ends");

// Raw clients: the host opens with a challenge and wants a proof, not the token.
const raw = (lines) =>
  new Promise((resolve) => {
    const s = net.connect(info.pipe);
    let out = "";
    s.on("data", (d) => (out += d));
    s.on("close", () => resolve(out));
    s.on("error", () => resolve(out));
    for (const l of lines) s.write(JSON.stringify(l) + "\n");
  });
const before = seen.length;
const rogue = await raw([
  { type: "hello", token: info.token, client: "x" }, // the raw token is not a proof
  { id: 2, msg: { type: "list" } },
]);
check(/"challenge"/.test(rogue) && /Not authorised/.test(rogue) && !/read_page/.test(rogue), "a client without a valid proof is refused, even one sending the raw token");
const guess = await raw([{ type: "hello", nonce: "n1", mac: "0".repeat(64), client: "x" }]);
check(/Not authorised/.test(guess) && seen.length === before, "a wrong proof never reaches the extension");
const skip = await raw([{ id: 1, msg: { type: "call", name: "read_page" } }]);
check(/Not authorised/.test(skip) && seen.length === before, "a call without a hello never reaches the extension");

// The host proves itself too: a client that holds the token checks the host's answer.
const { handshake, proof } = await import("../native/opensidekick-bridge.mjs");
const probe = await handshake(info, { type: "probe" });
probe.sock.destroy();
check(probe.reply.ok && probe.reply.mac.length === 64 && seen.length === before, "a probe is answered with the host's proof and never reaches the extension");
let impostorErr = "";
await handshake({ ...info, token: "f".repeat(64) }, { type: "probe" }).catch((e) => (impostorErr = String(e.message)));
check(/Not authorised|didn't prove/.test(impostorErr), "a client with the wrong token gets no host proof it accepts");
check(proof("t", "host", "a", "b") !== proof("t", "client", "a", "b"), "host and client proofs differ, so one can't be replayed as the other");

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
// The user's own tab, in the focused window.
const tabs = { 1: { id: 1, url: "https://mail.example.com/inbox", groupId: -1, windowId: 1, active: true } };
const windows = [];
let page = { elements: [{ ref: 1, name: "Next" }, { ref: 2, name: "Delete account" }, { ref: 3, name: "Email" }] };
const ran = [];
const newTab = (url, windowId) => (tabs[nextTab] = { id: nextTab++, url, groupId: -1, windowId, active: true, status: "complete" });
globalThis.chrome = {
  debugger: { onEvent: { addListener() {} }, onDetach: { addListener() {} } },
  runtime: { sendMessage: async () => ({}) },
  scripting: { executeScript: async () => [] },
  windows: {
    create: async ({ url, focused }) => {
      const id = 100 + windows.length;
      windows.push({ id, focused });
      return { id, tabs: [newTab(url, id)] };
    },
  },
  tabs: {
    get: async (id) => {
      if (!tabs[id]) throw new Error("No tab");
      return tabs[id];
    },
    create: async ({ url, windowId }) => newTab(url, windowId ?? 1),
    update: async (id, p) => Object.assign(tabs[id], p),
    query: async (q = {}) => Object.values(tabs).filter((t) => (q.windowId == null || t.windowId === q.windowId) && (q.active == null || t.active === q.active)),
    onUpdated: { addListener() {}, removeListener() {} },
    captureVisibleTab: async () => "data:image/png;base64,AA",
    sendMessage: async (id, msg) => {
      ran.push([msg.type, msg.action || "", msg.expect]);
      if (msg.type === "cs_ping") return { ok: true };
      if (msg.type === "cs_read_page") return { ok: true, url: tabs[id].url, ...page };
      if (msg.type === "cs_get_text") return { ok: true, url: tabs[id].landed || tabs[id].url, text: "hello" };
      return { ok: true, url: tabs[id].url };
    },
  },
};
const { handle, pair, gatedCall, externalTools, toMcp, newSession, clientLabel, isSubmit, isBridgeGroup } = await import("../src/background/external.js");
const { DEFAULT_SETTINGS } = await import("../src/common/constants.js");

const asked = [];
let answer = "once";
const config = (settings = {}, sitePermissions = {}) => ({
  settings: { ...DEFAULT_SETTINGS, enableExternal: true, ...settings },
  sitePermissions,
});
let cfg = config();
const logged = [];
let panelOpen = true;
const deps = {
  loadConfig: async () => cfg,
  requestPermission: async (d) => (asked.push(d), typeof answer === "function" ? answer(d) : answer),
  isBusy: () => false,
  activity: async (e) => (logged.push(e), panelOpen),
};
const sessions = new Map();
const closed = new Set();
const pairing = { declines: [] };

// Pairing.
let r = await handle({ type: "list", conn: 1 }, deps, sessions);
check(/isn't approved/.test(r.error), "an unpaired connection gets nothing, not even the tool list");
r = await pair({ type: "hello", conn: 1, client: "x", protocol: 1 }, deps, sessions, closed, pairing);
check(/out of date/.test(r.error) && !asked.length, "an old bridge copy is told to reinstall, with no card");
answer = "decline";
r = await pair({ type: "hello", conn: 1, client: "Claude Code", protocol: 2 }, deps, sessions, closed, pairing);
check(/didn't allow/.test(r.error) && asked[0].pairing && asked[0].external && asked[0].timeoutMs > 0 && !sessions.has(1), "pairing asks first, with a timeout; a no leaves the connection unpaired");
answer = "once";
r = await pair({ type: "hello", conn: 1, client: "Claude Code‮<b>", protocol: 2 }, deps, sessions, closed, pairing);
check(r.ok && sessions.has(1), "an approved pairing opens the connection");
check(asked[1].client === 'A local agent ("Claude Codeb")', "the client's self-chosen name is cleaned and shown as a claim");
closed.add(9);
r = await pair({ type: "hello", conn: 9, client: "gone", protocol: 2 }, deps, sessions, closed, pairing);
check(r.error && !sessions.has(9), "a pairing approved after the client left isn't kept");
answer = "decline";
for (const c of [20, 21]) await pair({ type: "hello", conn: c, client: "spam", protocol: 2 }, deps, sessions, closed, pairing);
const nPair = asked.length;
r = await pair({ type: "hello", conn: 22, client: "spam", protocol: 2 }, deps, sessions, closed, pairing);
check(/paused/.test(r.error) && asked.length === nPair, "after three declined pairings, new ones pause without a card");
r = await pair({ type: "hello", conn: 22, client: "spam", protocol: 2 }, deps, sessions, closed, pairing, Date.now() + 11 * 60_000);
check(asked.length === nPair + 1, "the pause ends after 10 minutes");
answer = "once";
cfg = config({ enableExternal: false });
r = await handle({ type: "list", conn: 1 }, deps, sessions);
check(/turned off/.test(r.error), "turning the setting off stops a paired connection too");
cfg = config();

const tools = externalTools({ ...DEFAULT_SETTINGS, enableVision: false, enableJsTool: true, enableCdp: true }).map((t) => t.name);
check(!tools.includes("finish") && !tools.includes("ask_user"), "finish and ask_user aren't offered");
check(!tools.includes("run_javascript") && !tools.includes("read_console") && !tools.includes("read_network"), "JavaScript and the debugger readers are never offered, whatever the chat settings");
check(!tools.includes("take_screenshot"), "screenshots follow the vision setting");

// Its own tabs, in its own unfocused window.
const s = newSession("agent");
const live = () => true;
r = await gatedCall("read_page", {}, cfg, deps, s);
check(r.ok === false && /no tab yet/.test(r.error) && !ran.length, "with no tab of its own, a read is refused: the user's tab is never touched");
r = await gatedCall("list_tabs", {}, cfg, deps, s);
check(r.ok && r.tabs.length === 0, "list_tabs doesn't show the user's tabs");
const n0 = asked.length;
answer = "always";
r = await gatedCall("navigate", { url: "https://shop.example.org/" }, cfg, deps, s);
check(r.ok && s.tabId >= 10 && tabs[1].url.includes("mail"), "a first navigate opens a new tab instead of taking over the user's");
check(windows.length === 1 && windows[0].focused === false && tabs[s.tabId].windowId === windows[0].id, "the agent's tab opens in its own window, which doesn't take focus");
check(asked.length === n0 + 1 && asked.at(-1).origin === "https://shop.example.org" && asked.at(-1).grantLabel === "Allow reading this site", "opening a new site asks, offering to allow reading it");
check(logged.at(-1).toolName === "open_tab", "the call is logged in the panel");
r = await gatedCall("open_tab", { url: "https://shop.example.org/cart" }, cfg, deps, s);
check(tabs[s.tabId].windowId === windows[0].id && windows.length === 1, "later tabs open in the same agent window");
r = await gatedCall("switch_tab", { tab_id: 1 }, cfg, deps, s);
check(r.ok === false && /among your tabs/.test(r.error), "the user's own tab is out of reach");

// Reading is one grant, acting another.
let n1 = asked.length;
r = await gatedCall("read_page", {}, cfg, deps, s);
check(r.ok && asked.length === n1, "a read on a site allowed for reading doesn't ask again");
r = await gatedCall("click_element", { ref: 1 }, cfg, deps, s);
check(r.ok && asked.length === n1 + 1 && asked.at(-1).grantLabel === "Allow actions on this site", "the first action on a site asks, even after reading was allowed");
check(ran.some(([type, action, expect]) => action === "click" && expect === "Next"), "the action carries the label the agent saw, so a changed element is refused");
n1 = asked.length;
r = await gatedCall("type_text", { ref: 3, text: "me@example.com" }, cfg, deps, s);
check(r.ok && asked.length === n1, "after 'Allow actions', a plain action there doesn't ask");
r = await gatedCall("type_text", { ref: 3, text: "DELETE", submit: true }, cfg, deps, s);
check(asked.length === n1 + 1 && !asked.at(-1).grantLabel, "typing with submit asks every time, with no grant button");
r = await gatedCall("press_keys", { keys: ["Enter"] }, cfg, deps, s);
check(asked.length === n1 + 2, "pressing Enter asks every time");
r = await gatedCall("click_element", { ref: 2 }, cfg, deps, s);
check(asked.length === n1 + 3 && asked.at(-1).label === "Delete account", "a Delete-like click asks every time, naming the element");
r = await gatedCall("upload_file", { ref: 1, name: "a.txt", content: "secret" }, cfg, deps, s);
check(asked.at(-1).toolName === "upload_file" && asked.at(-1).args.content === "secret", "an upload asks every time and the card gets the content");
r = await gatedCall("type_text", { ref: 3, text: "x".repeat(100_001) }, cfg, deps, s);
check(r.ok === false && /Too long/.test(r.error), "a payload too long to show whole is refused");
r = await gatedCall("click_element", { ref: 99 }, cfg, deps, s);
check(r.ok === false && /Unknown ref/.test(r.error), "a ref the last read didn't return is refused");
check(isSubmit("press_keys", { keys: ["Control+Enter"] }) && !isSubmit("press_keys", { keys: ["Tab"] }), "Ctrl+Enter counts as a submit, Tab doesn't");

// Allow once grants nothing.
answer = "once";
tabs[s.tabId].url = "https://once.example.com/";
await gatedCall("get_page_text", {}, cfg, deps, s);
const n2 = asked.length;
await gatedCall("get_page_text", {}, cfg, deps, s);
check(asked.length === n2 + 1, "'Allow once' covers that one call only");
answer = "always";

// Loading another site: refused until it lands; a read that lands elsewhere is withheld.
tabs[s.tabId].url = "https://shop.example.org/";
tabs[s.tabId].pendingUrl = "https://bank.example.com/";
r = await gatedCall("get_page_text", {}, cfg, deps, s);
check(r.ok === false && /still loading another site/.test(r.error), "a tab mid-way to another site isn't judged by the old one");
delete tabs[s.tabId].pendingUrl;
tabs[s.tabId].landed = "https://elsewhere.example.com/";
r = await gatedCall("get_page_text", {}, cfg, deps, s);
check(r.ok === false && /moved to another site/.test(r.error) && !("text" in r), "a read that landed on another site isn't handed over");
delete tabs[s.tabId].landed;

// The page changes while the card is up.
tabs[s.tabId].url = "https://new.example.com/";
answer = () => {
  tabs[s.tabId].url = "https://evil.example.com/";
  return "always";
};
const before2 = ran.length;
r = await gatedCall("get_page_text", {}, cfg, deps, s);
check(r.ok === false && /changed while waiting/.test(r.error) && ran.length === before2, "an approval for one site doesn't run on another");
check(!s.look.has("https://evil.example.com"), "and grants nothing for the other site");
answer = () => {
  tabs[s.tabId].pendingUrl = "https://evil.example.com/";
  return "once";
};
tabs[s.tabId].url = "https://new2.example.com/";
r = await gatedCall("get_page_text", {}, cfg, deps, s);
check(r.ok === false && /changed while waiting/.test(r.error), "a navigation started during approval stops the call too");
delete tabs[s.tabId].pendingUrl;
answer = "always";

// The client hangs up during the card.
tabs[s.tabId].url = "https://late.example.com/";
let gone = false;
answer = () => ((gone = true), "once");
r = await gatedCall("get_page_text", {}, cfg, deps, s, () => !gone);
check(r.ok === false && /connection closed/.test(r.error), "a call approved after the client left doesn't run");
answer = "always";

// No panel, no run.
panelOpen = false;
tabs[s.tabId].url = "https://shop.example.org/";
const before3 = ran.length;
r = await gatedCall("get_page_text", {}, cfg, deps, s);
check(r.ok === false && /side panel is closed/.test(r.error) && ran.length === before3, "on an allowed site with the panel closed, nothing runs");
panelOpen = true;

// Sensitive sites ask every time, reads too, and grant nothing.
tabs[s.tabId].url = "https://www.paypal.com/";
const n3 = asked.length;
await gatedCall("get_page_text", {}, cfg, deps, s);
await gatedCall("get_page_text", {}, cfg, deps, s);
check(asked.length === n3 + 2 && asked.at(-1).sensitive && !asked.at(-1).grantLabel && !s.look.has("https://www.paypal.com"), "a sensitive site asks every time, reads too, styled as sensitive");
r = await gatedCall("get_page_text", {}, config({}, { "https://www.paypal.com": "block" }), deps, s);
check(r.ok === false && /blocked/.test(r.error), "a blocked site stays blocked");

answer = "no-panel";
tabs[s.tabId].url = "https://fresh.example.com/";
r = await gatedCall("get_page_text", {}, cfg, deps, s);
check(r.ok === false && /side panel is closed/.test(r.error), "a closed panel is reported as such, not as the user's no");
answer = "timeout";
r = await gatedCall("get_page_text", {}, cfg, deps, s);
check(r.ok === false && /in time/.test(r.error), "an unanswered card times out and nothing runs");

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
answer = "always";

// A closed tab: fall back to another of its tabs, forgetting old refs.
const s2 = newSession("agent2");
await gatedCall("open_tab", { url: "https://one.example.com/" }, cfg, deps, s2);
const first = s2.tabId;
await gatedCall("open_tab", { url: "https://one.example.com/b" }, cfg, deps, s2);
await gatedCall("read_page", {}, cfg, deps, s2);
delete tabs[s2.tabId];
r = await gatedCall("click_element", { ref: 1 }, cfg, deps, s2);
check(s2.tabId === first && r.ok === false && /Unknown ref/.test(r.error), "a closed tab moves the agent to another of its tabs, and old refs don't carry over");

r = await gatedCall("navigate", { url: "javascript:alert(1)" }, cfg, deps, newSession());
check(r.ok === false && /http/.test(r.error), "only http(s) targets can be opened");
check(clientLabel("") === "A local agent", "a nameless client is just a local agent");
check(!isBridgeGroup(-1) && !isBridgeGroup(undefined), "no group is never a bridge group");

const m = toMcp({ ok: true, image: { data: "AA", mediaType: "image/png" } });
check(m.content[1].type === "image" && !m.content[0].text.includes("AA"), "a screenshot becomes an MCP image block");

console.log(`\nALL EXTERNAL CHECKS PASSED (${ok})`);
process.exit(0);
