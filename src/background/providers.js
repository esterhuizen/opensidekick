// Provider abstraction: a single normalized interface over any LLM backend.
//
// Two wire protocols are implemented:
//   - "openai":    OpenAI Chat Completions (OpenRouter, OpenAI, Ollama, Groq,
//                  Together, DeepSeek, LM Studio, Google's OpenAI-compatible
//                  endpoint, and anything else that speaks /chat/completions)
//   - "anthropic": Anthropic Messages API (with the direct-browser CORS header)
//
// The rest of the codebase only ever deals with a NORMALIZED message/tool shape;
// conversion to and from each provider's wire format happens here.
//
// Normalized message shapes:
//   { role: "system",    content: string }
//   { role: "user",      content: string }
//   { role: "assistant", content: string, toolCalls?: [{ id, name, args }] }
//   { role: "tool",      toolCallId: string, name: string, content: string }
//
// Normalized tool definition:
//   { name, description, parameters: <JSON Schema object> }

const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Call the model once. Streams text via `onDelta` and returns the completed
 * normalized assistant turn: { content, toolCalls, stopReason, raw }.
 *
 * @param {object}   provider   { type, baseUrl, apiKey, ... }
 * @param {object}   opts       { model, messages, tools, system, maxTokens,
 *                                temperature, signal, onDelta }
 */
export async function callModel(provider, opts) {
  if (provider.type === "anthropic") return callAnthropic(provider, opts);
  return callOpenAI(provider, opts);
}

/** Fetch the list of model ids a provider exposes (best-effort). */
export async function listModels(provider) {
  const base = trimSlash(provider.baseUrl);
  if (provider.type === "anthropic") {
    const res = await fetch(`${base}/models`, {
      headers: anthropicHeaders(provider),
    });
    if (!res.ok) throw new Error(`Models request failed: ${res.status}`);
    const data = await res.json();
    return (data.data || []).map((m) => m.id);
  }
  const res = await fetch(`${base}/models`, {
    headers: openaiHeaders(provider),
  });
  if (!res.ok) throw new Error(`Models request failed: ${res.status}`);
  const data = await res.json();
  return (data.data || []).map((m) => m.id).sort();
}

// ---------------------------------------------------------------------------
// OpenAI-compatible
// ---------------------------------------------------------------------------

function openaiHeaders(provider) {
  const h = { "content-type": "application/json" };
  if (provider.apiKey) h["authorization"] = `Bearer ${provider.apiKey}`;
  // OpenRouter attribution headers (harmless for other providers).
  h["http-referer"] = "https://github.com/OWNER/opensidekick";
  h["x-title"] = "OpenSidekick";
  return h;
}

function toOpenAIMessages(messages, system) {
  const out = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of messages) {
    if (m.role === "system") {
      out.push({ role: "system", content: m.content });
    } else if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const msg = { role: "assistant", content: m.content || "" };
      if (m.toolCalls && m.toolCalls.length) {
        msg.content = m.content || null;
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
        }));
      }
      out.push(msg);
    } else if (m.role === "tool") {
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    }
  }
  return out;
}

function toOpenAITools(tools) {
  if (!tools || !tools.length) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

async function callOpenAI(provider, opts) {
  const body = {
    model: opts.model,
    messages: toOpenAIMessages(opts.messages, opts.system),
    stream: true,
    max_tokens: opts.maxTokens,
  };
  if (typeof opts.temperature === "number") body.temperature = opts.temperature;
  const tools = toOpenAITools(opts.tools);
  if (tools) body.tools = tools;

  const res = await fetch(`${trimSlash(provider.baseUrl)}/chat/completions`, {
    method: "POST",
    headers: openaiHeaders(provider),
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) throw await httpError(res);

  let content = "";
  const toolAccum = new Map(); // index -> { id, name, argChunks: [] }
  let stopReason = null;

  for await (const evt of sseStream(res)) {
    if (evt === "[DONE]") break;
    let json;
    try {
      json = JSON.parse(evt);
    } catch {
      continue;
    }
    const choice = json.choices && json.choices[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    if (delta.content) {
      content += delta.content;
      opts.onDelta && opts.onDelta(delta.content);
    }
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolAccum.has(idx)) toolAccum.set(idx, { id: null, name: "", argChunks: [] });
        const acc = toolAccum.get(idx);
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name = tc.function.name;
        if (tc.function?.arguments) acc.argChunks.push(tc.function.arguments);
      }
    }
    if (choice.finish_reason) stopReason = choice.finish_reason;
  }

  const toolCalls = [...toolAccum.values()].map((acc, i) => ({
    id: acc.id || `call_${i}`,
    name: acc.name,
    args: safeParseArgs(acc.argChunks.join("")),
  }));

  return {
    content,
    toolCalls,
    stopReason: toolCalls.length ? "tool_use" : stopReason || "stop",
  };
}

// ---------------------------------------------------------------------------
// Anthropic Messages API
// ---------------------------------------------------------------------------

function anthropicHeaders(provider) {
  return {
    "content-type": "application/json",
    "x-api-key": provider.apiKey || "",
    "anthropic-version": ANTHROPIC_VERSION,
    // Required to call the Anthropic API directly from a browser/extension
    // context (opts into the CORS-enabled path).
    "anthropic-dangerous-direct-browser-access": "true",
  };
}

function toAnthropicMessages(messages) {
  // Anthropic wants tool results merged into user turns and does not use a
  // "tool" role. System messages are pulled out separately by the caller.
  const out = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      pushAnthropic(out, "user", [{ type: "text", text: m.content }]);
    } else if (m.role === "assistant") {
      const blocks = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls || []) {
        blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args ?? {} });
      }
      if (blocks.length) pushAnthropic(out, "assistant", blocks);
    } else if (m.role === "tool") {
      pushAnthropic(out, "user", [
        { type: "tool_result", tool_use_id: m.toolCallId, content: m.content },
      ]);
    }
  }
  return out;
}

// Merge consecutive same-role blocks (Anthropic requires alternating turns, and
// multiple tool results should share one user turn).
function pushAnthropic(out, role, blocks) {
  const last = out[out.length - 1];
  if (last && last.role === role) {
    last.content.push(...blocks);
  } else {
    out.push({ role, content: blocks });
  }
}

function toAnthropicTools(tools) {
  if (!tools || !tools.length) return undefined;
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

async function callAnthropic(provider, opts) {
  const systemParts = opts.messages.filter((m) => m.role === "system").map((m) => m.content);
  if (opts.system) systemParts.unshift(opts.system);

  const body = {
    model: opts.model,
    max_tokens: opts.maxTokens || 4096,
    stream: true,
    messages: toAnthropicMessages(opts.messages),
  };
  if (systemParts.length) body.system = systemParts.join("\n\n");
  const tools = toAnthropicTools(opts.tools);
  if (tools) body.tools = tools;

  const res = await fetch(`${trimSlash(provider.baseUrl)}/messages`, {
    method: "POST",
    headers: anthropicHeaders(provider),
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) throw await httpError(res);

  let content = "";
  const blocks = new Map(); // index -> { type, name, id, jsonChunks: [] }
  let stopReason = null;

  for await (const evt of sseStream(res)) {
    let json;
    try {
      json = JSON.parse(evt);
    } catch {
      continue;
    }
    switch (json.type) {
      case "content_block_start": {
        const cb = json.content_block || {};
        blocks.set(json.index, {
          type: cb.type,
          name: cb.name,
          id: cb.id,
          jsonChunks: [],
        });
        break;
      }
      case "content_block_delta": {
        const d = json.delta || {};
        if (d.type === "text_delta") {
          content += d.text;
          opts.onDelta && opts.onDelta(d.text);
        } else if (d.type === "input_json_delta") {
          const b = blocks.get(json.index);
          if (b) b.jsonChunks.push(d.partial_json || "");
        }
        break;
      }
      case "message_delta": {
        if (json.delta?.stop_reason) stopReason = json.delta.stop_reason;
        break;
      }
      case "error": {
        throw new Error(`Anthropic stream error: ${json.error?.message || "unknown"}`);
      }
    }
  }

  const toolCalls = [];
  for (const b of blocks.values()) {
    if (b.type === "tool_use") {
      toolCalls.push({ id: b.id, name: b.name, args: safeParseArgs(b.jsonChunks.join("")) });
    }
  }

  return {
    content,
    toolCalls,
    stopReason: toolCalls.length ? "tool_use" : stopReason || "end_turn",
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// Async generator that yields the `data:` payload of each SSE event.
async function* sseStream(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    // Normalize CRLF so event splitting on "\n\n" works across servers.
    buffer += decoder.decode(value, { stream: true }).replace(/\r/g, "");
    // SSE events are separated by a blank line.
    let sep;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of rawEvent.split("\n")) {
        const trimmed = line.trimStart();
        if (trimmed.startsWith("data:")) {
          yield trimmed.slice(5).trim();
        }
      }
    }
  }
}

function safeParseArgs(str) {
  if (!str || !str.trim()) return {};
  try {
    return JSON.parse(str);
  } catch {
    return { _raw: str };
  }
}

async function httpError(res) {
  let detail = "";
  try {
    detail = await res.text();
  } catch {
    /* ignore */
  }
  const err = new Error(`Provider request failed (${res.status}): ${detail.slice(0, 500)}`);
  err.status = res.status;
  return err;
}

function trimSlash(url) {
  return (url || "").replace(/\/+$/, "");
}
