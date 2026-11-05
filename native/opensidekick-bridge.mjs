#!/usr/bin/env node
// OpenSidekick bridge: lets local agents (Claude Code, Codex, Cursor, …) use
// the browser tools over MCP. Two modes, one file:
//   - Chrome starts it as a native messaging host. It listens on a local pipe
//     and relays requests to the extension, which gates every call (a pairing
//     card per connection, site and action cards) before running it.
//   - An agent starts it with --mcp: a stdio MCP server that forwards
//     tools/list and tools/call to that pipe.
// The pipe's address and a random token live in a folder only this OS user
// can open (bridge.json, 0600). Client and host prove to each other that they
// hold the token (HMAC over fresh nonces; the token itself never crosses the
// pipe), so another user can neither talk to the bridge nor pose as it.
// No dependencies, Node 18+.
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

const WIN = process.platform === "win32";
export const STATE_DIR = WIN
  ? path.join(process.env.LOCALAPPDATA || os.homedir(), "OpenSidekick")
  : path.join(os.homedir(), ".opensidekick");
const INFO = path.join(STATE_DIR, "bridge.json");
export const PROTOCOL = 2; // must match BRIDGE_PROTOCOL in src/background/external.js
const LINE_MAX = 2_000_000; // one request line from a client
const REPLY_MAX = 64_000_000; // one reply line to a client (screenshots, images)
const TO_CHROME_MAX = 1_000_000; // Chrome's cap on a host-to-extension message

// The folder must be ours and closed to everyone else, or nothing in it can be trusted.
export function ensureStateDir(dir = STATE_DIR) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (WIN) return dir; // %LOCALAPPDATA% is per-user by its ACL
  let st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.uid !== process.getuid()) throw new Error(`${dir} is not a folder owned by you.`);
  if (st.mode & 0o077) {
    fs.chmodSync(dir, 0o700);
    st = fs.lstatSync(dir);
    if (st.mode & 0o077) throw new Error(`${dir} must be private (chmod 700).`);
  }
  return dir;
}

function readInfo() {
  ensureStateDir();
  const st = fs.lstatSync(INFO);
  if (!st.isFile() || (!WIN && (st.uid !== process.getuid() || st.mode & 0o077))) {
    throw new Error(`${INFO} is not a private file owned by you.`);
  }
  const info = JSON.parse(fs.readFileSync(INFO, "utf8"));
  if (typeof info.pipe !== "string" || typeof info.token !== "string") throw new Error("bridge.json is malformed.");
  return info;
}

function writeInfo(info) {
  const tmp = `${INFO}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(info), { mode: 0o600 });
  fs.renameSync(tmp, INFO);
}

export function proof(token, role, hostNonce, clientNonce) {
  return crypto.createHmac("sha256", String(token)).update(`${role}|${hostNonce}|${clientNonce}`).digest("hex");
}

export function proofMatches(given, want) {
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(String(want));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Connect and run the handshake: the host sends a nonce, the client answers
// with its own nonce and proof, the host's reply carries the host's proof.
// Resolves { sock, reply } once the host's proof checks out.
export function handshake(info, first, onLine) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(info.pipe);
    let clientNonce = null;
    let hostNonce = null;
    let done = false;
    const fail = (e) => {
      if (done) return;
      done = true;
      sock.destroy();
      reject(e);
    };
    sock.on("error", (e) => fail(e));
    sock.on("close", () => fail(new Error("closed")));
    lines(
      sock,
      (msg) => {
        if (done) return onLine?.(msg);
        if (hostNonce == null) {
          if (msg.type !== "challenge" || typeof msg.nonce !== "string") return fail(new Error("not a bridge"));
          hostNonce = msg.nonce;
          clientNonce = crypto.randomBytes(16).toString("hex");
          sock.write(JSON.stringify({ ...first, nonce: clientNonce, mac: proof(info.token, "client", hostNonce, clientNonce) }) + "\n");
          return;
        }
        if (!proofMatches(msg.mac, proof(info.token, "host", hostNonce, clientNonce))) {
          return fail(new Error(msg.error || "The bridge didn't prove itself."));
        }
        done = true;
        resolve({ sock, reply: msg });
      },
      REPLY_MAX,
    );
  });
}

// Newline-delimited JSON; unparseable lines are skipped, an overlong one ends the stream.
export function lines(stream, onMessage, max = LINE_MAX) {
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      onMessage(msg);
    }
    if (buf.length > max) {
      buf = "";
      stream.destroy?.();
    }
  });
}

// A live bridge that proves it holds the recorded token (not just anything listening there).
async function liveBridge(info) {
  let timer;
  const attempt = handshake(info, { type: "probe" });
  try {
    return await Promise.race([
      attempt.then(({ sock }) => (sock.destroy(), true)),
      new Promise((r) => (timer = setTimeout(() => r(false), 1500))),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    attempt.then(({ sock }) => sock.destroy(), () => {});
  }
}

async function hostMode() {
  ensureStateDir();
  // Another Chrome profile already serving keeps the pipe: don't take it over.
  try {
    if (await liveBridge(readInfo())) process.exit(0);
  } catch {
    /* no live bridge */
  }
  const pipe = WIN ? `\\\\.\\pipe\\opensidekick-${crypto.randomBytes(16).toString("hex")}` : path.join(STATE_DIR, "bridge.sock");
  const token = crypto.randomBytes(32).toString("hex");
  if (!WIN) fs.rmSync(pipe, { force: true });

  // Chrome's framing: 4-byte little-endian length, then JSON.
  const pending = new Map();
  let seq = 0;
  let buf = Buffer.alloc(0);
  process.stdin.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const n = buf.readUInt32LE(0);
      if (buf.length < 4 + n) break;
      let msg = null;
      try {
        msg = JSON.parse(buf.subarray(4, 4 + n).toString("utf8"));
      } catch {
        /* skip a bad frame */
      }
      buf = buf.subarray(4 + n);
      const resolve = msg && pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });
  // Only our own files: a newer host may have taken over the folder.
  const cleanup = () => {
    try {
      if (readInfo().token !== token) return;
      fs.rmSync(INFO, { force: true });
      if (!WIN) fs.rmSync(pipe, { force: true });
    } catch {
      /* already gone */
    }
  };
  process.stdin.on("end", () => {
    cleanup();
    process.exit(0); // Chrome closed the port
  });
  const post = (msg) => {
    const body = Buffer.from(JSON.stringify(msg));
    if (body.length > TO_CHROME_MAX) return false;
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length);
    process.stdout.write(Buffer.concat([head, body]));
    return true;
  };
  const toChrome = (msg) =>
    new Promise((resolve) => {
      const id = ++seq;
      if (!post({ ...msg, id })) return resolve({ error: "The request is too big to pass to the browser (1 MB max)." });
      pending.set(id, resolve);
    });

  let conns = 0;
  const server = net.createServer((sock) => {
    const conn = ++conns;
    const hostNonce = crypto.randomBytes(16).toString("hex");
    let state = "new"; // new -> pairing -> open, or dead
    sock.on("error", () => {});
    sock.on("close", () => {
      if (state === "pairing" || state === "open") post({ type: "closed", conn });
    });
    const send = (obj) => !sock.destroyed && !sock.writableEnded && sock.write(JSON.stringify(obj) + "\n");
    // Refuse and hang up once the reply is flushed; later lines are ignored.
    const refuse = (obj) => {
      state = "dead";
      if (!sock.destroyed && !sock.writableEnded) sock.end(JSON.stringify(obj) + "\n");
    };
    send({ type: "challenge", nonce: hostNonce });
    lines(sock, async (req) => {
      if (state === "dead") return;
      if (state === "new") {
        const nonce = typeof req.nonce === "string" ? req.nonce.slice(0, 64) : "";
        if (!nonce || !proofMatches(req.mac, proof(token, "client", hostNonce, nonce))) return refuse({ error: "Not authorised." });
        const mac = proof(token, "host", hostNonce, nonce);
        if (req.type === "probe") return refuse({ ok: true, mac });
        if (req.type !== "hello") return refuse({ error: "Not authorised." });
        state = "pairing";
        const res = await toChrome({ type: "hello", conn, protocol: PROTOCOL, client: String(req.client || "").slice(0, 200) });
        if (res.error) {
          post({ type: "closed", conn });
          return refuse({ error: res.error, mac });
        }
        state = "open";
        return send({ ok: true, mac });
      }
      if (state !== "open") return send({ id: req.id, error: "Wait for the connection to be approved." });
      // Only these two kinds pass: a client can't pose as the host's own messages.
      const m = req.msg || {};
      if (m.type !== "list" && m.type !== "call") return send({ id: req.id, error: "Unknown request." });
      const out = m.type === "list" ? { type: "list" } : { type: "call", name: String(m.name || ""), args: m.args && typeof m.args === "object" ? m.args : {} };
      const { id: _chromeId, ...res } = await toChrome({ ...out, conn });
      send({ ...res, id: req.id });
    });
  });
  server.on("error", () => process.exit(1));
  process.umask(0o077);
  server.listen(pipe, () => {
    if (!WIN) fs.chmodSync(pipe, 0o600);
    writeInfo({ pipe, token, pid: process.pid });
  });
}

function mcpMode() {
  const pending = new Map();
  let seq = 0;
  let sock = null;
  let client = "";
  const fail = (err) => {
    for (const [, p] of pending) p.reject(err);
    pending.clear();
    sock = null;
  };
  const request = (s, obj) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      s.write(JSON.stringify({ ...obj, id }) + "\n");
    });
  const unreachable = () =>
    new Error(`OpenSidekick isn't reachable. Open Chrome and turn on Settings → "Let local agents use this browser".`);
  const open = async () => {
    let info;
    try {
      info = readInfo();
    } catch {
      throw unreachable();
    }
    if (!WIN) {
      const st = fs.lstatSync(info.pipe, { throwIfNoEntry: false });
      if (!st || !st.isSocket() || st.uid !== process.getuid()) throw unreachable();
    }
    let hs;
    try {
      // Pairing: the proofs show both sides hold the token; the card in the panel asks the user.
      hs = await handshake(info, { type: "hello", client }, (res) => {
        const p = pending.get(res.id);
        if (!p) return;
        pending.delete(res.id);
        p.resolve(res);
      });
    } catch (e) {
      throw /ECONNREFUSED|ENOENT|closed|not a bridge/.test(String(e.message || e.code)) ? unreachable() : e;
    }
    if (hs.reply.error) {
      hs.sock.destroy();
      throw new Error(hs.reply.error);
    }
    const s = hs.sock;
    s.on("close", () => sock === s && fail(new Error("OpenSidekick closed the connection.")));
    s.on("error", () => sock === s && fail(new Error("OpenSidekick closed the connection.")));
    sock = s;
    return s;
  };
  let opening = null;
  const ask = async (msg) => {
    if (!sock) opening ??= open().finally(() => (opening = null));
    const s = sock && !opening ? sock : await opening;
    return request(s, { msg });
  };
  const reply = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");

  lines(process.stdin, async (req) => {
    if (req.id === undefined) return; // a notification
    try {
      let result;
      switch (req.method) {
        case "initialize":
          client = String(req.params?.clientInfo?.name || "").slice(0, 200);
          result = {
            protocolVersion: req.params?.protocolVersion || "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "opensidekick", version: "0.2" },
          };
          break;
        case "ping":
          result = {};
          break;
        case "tools/list": {
          const res = await ask({ type: "list" });
          if (res.error) throw new Error(res.error);
          result = { tools: res.tools };
          break;
        }
        case "tools/call": {
          const res = await ask({ type: "call", name: req.params?.name, args: req.params?.arguments || {} });
          result = res.error ? { isError: true, content: [{ type: "text", text: res.error }] } : res.result;
          break;
        }
        default:
          return reply({ id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } });
      }
      reply({ id: req.id, result });
    } catch (e) {
      reply({ id: req.id, error: { code: -32000, message: String(e.message || e) } });
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

if (process.argv.includes("--mcp")) mcpMode();
else if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) hostMode();
