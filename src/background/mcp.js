// Minimal Model Context Protocol (MCP) client over Streamable HTTP.
//
// Browser extensions can't spawn local stdio MCP servers, so this speaks the
// remote HTTP transport: JSON-RPC POSTed to a single endpoint that replies with
// either application/json or a text/event-stream. Session state is carried in
// the Mcp-Session-Id header.

const PROTOCOL_VERSION = "2025-06-18";
let idCounter = 0;

// Connect + initialize; returns a session handle { sessionId }.
export async function connectServer(server) {
  const { result, sessionId } = await rpc(server, null, "initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "OpenSidekick", version: "0.1" },
  });
  // Best-effort "initialized" notification (some servers require it).
  await notify(server, sessionId, "notifications/initialized", {});
  return { sessionId, serverInfo: result && result.serverInfo };
}

export async function listTools(server, session) {
  const { result } = await rpc(server, session.sessionId, "tools/list", {});
  return (result && result.tools) || [];
}

export async function callTool(server, session, name, args) {
  const { result } = await rpc(server, session.sessionId, "tools/call", {
    name,
    arguments: args || {},
  });
  return result || {};
}

export async function closeSession(server, session) {
  if (!session || !session.sessionId) return;
  try {
    await fetch(server.url, {
      method: "DELETE",
      headers: authHeaders(server, session.sessionId),
    });
  } catch {
    /* server may not support session teardown */
  }
}

// A safe, namespaced tool id from a server + remote tool name.
export function mcpToolName(serverName, toolName) {
  return ("mcp_" + serverName + "_" + toolName).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

// Flatten an MCP tool result's content array into a string for the model.
export function flattenMcpContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content || {});
  return content
    .map((c) => {
      if (!c) return "";
      if (c.type === "text") return c.text || "";
      if (c.type === "resource" && c.resource) return c.resource.text || JSON.stringify(c.resource);
      return `[${c.type || "content"}]`;
    })
    .join("\n")
    .slice(0, 8000);
}

// ---------------------------------------------------------------------------

function authHeaders(server, sessionId) {
  const h = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": PROTOCOL_VERSION,
  };
  if (server.authToken) h["authorization"] = "Bearer " + server.authToken;
  if (sessionId) h["mcp-session-id"] = sessionId;
  return h;
}

async function rpc(server, sessionId, method, params) {
  const id = ++idCounter;
  const res = await fetch(server.url, {
    method: "POST",
    headers: authHeaders(server, sessionId),
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`${method} → HTTP ${res.status} ${detail.slice(0, 200)}`);
  }
  const newSession = res.headers.get("mcp-session-id");
  const ct = res.headers.get("content-type") || "";
  const message = ct.includes("text/event-stream") ? await readSseResult(res, id) : await res.json();
  if (message && message.error) {
    throw new Error(`${method} → ${message.error.message || JSON.stringify(message.error)}`);
  }
  return { result: message && message.result, sessionId: newSession || sessionId };
}

async function notify(server, sessionId, method, params) {
  try {
    await fetch(server.url, {
      method: "POST",
      headers: authHeaders(server, sessionId),
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
    });
  } catch {
    /* ignore */
  }
}

// Read a Streamable-HTTP SSE response, returning the JSON-RPC message with `id`.
async function readSseResult(res, id) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r/g, "");
    let sep;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of raw.split("\n")) {
        const t = line.trimStart();
        if (t.startsWith("data:")) {
          try {
            const msg = JSON.parse(t.slice(5).trim());
            if (msg && msg.id === id) {
              reader.cancel().catch(() => {});
              return msg;
            }
          } catch {
            /* keep reading */
          }
        }
      }
    }
  }
  throw new Error("MCP stream ended without a response");
}
