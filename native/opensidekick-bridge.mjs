#!/usr/bin/env node
// OpenSidekick bridge: lets local agents (Claude Code, Codex, Cursor, …) use
// the browser tools over MCP. Two modes, one file:
//   - Chrome starts it as a native messaging host. It then listens on a local
//     pipe only this OS user can open, and relays requests to the extension,
//     which gates every call (site rules, approval cards) before running it.
//   - An agent starts it with --mcp: a stdio MCP server that forwards
//     tools/list and tools/call to that pipe.
// No dependencies, Node 18+.
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const PIPE =
  process.env.OPENSIDEKICK_PIPE ||
  (process.platform === "win32"
    ? `\\\\.\\pipe\\opensidekick-${os.userInfo().username}`
    : path.join(os.tmpdir(), `opensidekick-${process.getuid()}.sock`));

// Newline-delimited JSON; unparseable lines are skipped.
export function lines(stream, onMessage) {
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
  });
}

function hostMode() {
  // Chrome's framing: 4-byte little-endian length, then JSON.
  const pending = new Map();
  let seq = 0;
  let buf = Buffer.alloc(0);
  process.stdin.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const n = buf.readUInt32LE(0);
      if (buf.length < 4 + n) break;
      const msg = JSON.parse(buf.subarray(4, 4 + n).toString("utf8"));
      buf = buf.subarray(4 + n);
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });
  process.stdin.on("end", () => process.exit(0)); // Chrome closed the port
  const toChrome = (msg) =>
    new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      const body = Buffer.from(JSON.stringify({ ...msg, id }));
      const head = Buffer.alloc(4);
      head.writeUInt32LE(body.length);
      process.stdout.write(Buffer.concat([head, body]));
    });

  if (process.platform !== "win32") fs.rmSync(PIPE, { force: true });
  const server = net.createServer((sock) => {
    sock.on("error", () => {});
    lines(sock, async (req) => {
      const { id: _chromeId, ...res } = await toChrome(req.msg || {});
      if (!sock.destroyed) sock.write(JSON.stringify({ ...res, id: req.id }) + "\n");
    });
  });
  server.on("error", () => process.exit(1)); // another Chrome profile already serves the pipe
  // Unix: the socket is 0600. Windows: a named pipe's default ACL lets only
  // its owner (and admins) open it for writing.
  server.listen(PIPE, () => {
    if (process.platform !== "win32") fs.chmodSync(PIPE, 0o600);
  });
}

function mcpMode() {
  const pending = new Map();
  let seq = 0;
  let sock = null;
  const fail = (err) => {
    for (const [, p] of pending) p.reject(err);
    pending.clear();
    sock = null;
  };
  const ask = (msg) =>
    new Promise((resolve, reject) => {
      if (!sock) {
        const s = (sock = net.connect(PIPE));
        s.on("error", () =>
          fail(new Error(`OpenSidekick isn't reachable. Open Chrome and turn on Settings → "Let local agents use this browser".`)),
        );
        s.on("close", () => sock === s && fail(new Error("OpenSidekick closed the connection.")));
        lines(s, (res) => {
          const p = pending.get(res.id);
          if (!p) return;
          pending.delete(res.id);
          p.resolve(res);
        });
      }
      const id = ++seq;
      pending.set(id, { resolve, reject });
      sock.write(JSON.stringify({ id, msg }) + "\n");
    });
  const reply = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");

  lines(process.stdin, async (req) => {
    if (req.id === undefined) return; // a notification
    try {
      let result;
      switch (req.method) {
        case "initialize":
          result = {
            protocolVersion: req.params?.protocolVersion || "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "opensidekick", version: "0.1" },
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
