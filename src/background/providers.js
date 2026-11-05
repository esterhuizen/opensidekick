// Provider abstraction: a single normalized interface over any LLM backend.
//
// Two wire protocols are implemented:
//   - "openai":    OpenAI Chat Completions (OpenRouter, OpenAI, Ollama, Groq,
//                  Venice AI, Together, DeepSeek, LM Studio, Google's
//                  OpenAI-compatible endpoint, and anything else that speaks
//                  /chat/completions)
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
 * normalized assistant turn: { content, toolCalls, stopReason, reasoning }.
 * `reasoning` is whatever a thinking model sent in a separate reasoning field
 * ("" when none). It never reaches `onDelta`, and nothing outside testModel()
 * reads it: it is not shown, saved or sent back to the model.
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
    if (!res.ok) throw statusError(`Models request failed: ${res.status}`, res.status);
    const data = await res.json();
    return (data.data || []).map((m) => m.id);
  }
  // Venice serves text models by default today, but its catalog also holds
  // image/TTS/embedding models behind the same endpoint; pin the query to text
  // so they can never show up in Fetch models if that default ever changes.
  const url = isVeniceUrl(base) ? `${base}/models?type=text` : `${base}/models`;
  const res = await fetch(url, {
    headers: openaiHeaders(provider),
  });
  if (!res.ok) throw statusError(`Models request failed: ${res.status}`, res.status);
  const data = await res.json();
  return (data.data || []).map((m) => m.id).sort();
}

// A solid-red 8x8 PNG, used to probe whether a model can actually see images.
const TEST_IMAGE = {
  mediaType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC",
};

const PROBE_STAGES = ["text", "tools", "vision"];

/**
 * Empirically probe a model for the two capabilities OpenSidekick needs: tool
 * calling and vision. Runs three tiny live requests and reports what actually
 * happened — so it can't go stale as new models ship, and it works for any
 * provider (including local ones that expose no metadata).
 *
 * @param {object} provider
 * @param {string} model
 * @param {object} opts  { onProgress, signal } — onProgress(stage, resultsSoFar)
 *                       fires with "text", "tools", "vision" just before each
 *                       probe and "done" after the last; signal cancels the run.
 *
 * Returns { text, tools, vision }, each { status: "ok"|"warn"|"fail", detail },
 * plus httpStatus on a probe whose request got an HTTP error. thinking: true
 * on a probe means a reasoning model spent that probe's whole budget thinking;
 * thinking: true on the result means it did so on at least one probe.
 * A cancelled run returns what it had plus aborted: true — it never throws for
 * the abort, since a caller that cancelled has nothing to handle.
 */
export async function testModel(provider, model, opts = {}) {
  const { onProgress, signal } = opts;
  const out = {};
  const stopped = () => !!(signal && signal.aborted);
  // Cancelling says nothing about the model, so the probes that never ran say
  // "cancelled" rather than reporting a failure the user would have to read.
  const cancelFrom = (stage) => {
    for (const s of PROBE_STAGES.slice(PROBE_STAGES.indexOf(stage))) out[s] = { status: "warn", detail: "cancelled" };
    out.aborted = true;
    return out;
  };
  const begin = (stage) => {
    if (stopped()) return false;
    if (onProgress) onProgress(stage, out);
    return true;
  };
  const thought = (r, answered) => {
    if (!onlyThought(r, answered)) return false;
    out.thinking = true;
    return true;
  };
  const withStatus = (res, e) => (typeof e?.status === "number" ? { ...res, httpStatus: e.status } : res);

  // 1. Text — does the model respond at all?
  if (!begin("text")) return cancelFrom("text");
  try {
    const r = await callModel(provider, {
      model,
      messages: [{ role: "user", content: "Reply with exactly one word: ready" }],
      maxTokens: 16,
      temperature: 0,
      signal,
    });
    const said = (r.content || "").trim();
    out.text = thought(r, !!said)
      ? { status: "warn", detail: "spent the whole budget thinking, no answer", thinking: true }
      : said
        ? { status: "ok", detail: said.slice(0, 40) }
        : { status: "warn", detail: "empty response" };
  } catch (e) {
    if (stopped()) return cancelFrom("text");
    out.text = withStatus({ status: "fail", detail: shortErr(e) }, e);
  }

  // 2. Tools — does the model actually call a tool we give it?
  if (!begin("tools")) return cancelFrom("tools");
  try {
    const r = await callModel(provider, {
      model,
      messages: [{ role: "user", content: "Call the echo tool with word set to 'ok'. Reply only via the tool." }],
      tools: [
        {
          name: "echo",
          description: "Echo a word back to the user.",
          parameters: { type: "object", properties: { word: { type: "string" } }, required: ["word"] },
        },
      ],
      maxTokens: 64,
      temperature: 0,
      signal,
    });
    out.tools = r.toolCalls && r.toolCalls.length
      ? { status: "ok", detail: "called " + r.toolCalls[0].name }
      : thought(r, false)
        ? { status: "warn", detail: "spent the whole budget thinking, no tool call", thinking: true }
        : { status: "warn", detail: "accepted tools but didn't call one" };
  } catch (e) {
    if (stopped()) return cancelFrom("tools");
    const m = shortErr(e);
    out.tools = withStatus(
      /tool|function[- ]?call/i.test(m)
        ? { status: "fail", detail: "no tool-calling endpoint for this model" }
        : { status: "fail", detail: m },
      e,
    );
  }

  // 3. Vision — can the model see a solid-red image?
  if (!begin("vision")) return cancelFrom("vision");
  try {
    const r = await callModel(provider, {
      model,
      messages: [{ role: "user", content: "What color fills this image? Reply with just the color word.", images: [TEST_IMAGE] }],
      maxTokens: 16,
      temperature: 0,
      signal,
    });
    const said = (r.content || "").trim().toLowerCase();
    if (thought(r, !!said)) out.vision = { status: "warn", detail: "spent the whole budget thinking, no answer", thinking: true };
    else if (/red/.test(said)) out.vision = { status: "ok", detail: "identified the test image" };
    else if (said) out.vision = { status: "warn", detail: `responded "${said.slice(0, 20)}" (couldn't identify it)` };
    else out.vision = { status: "warn", detail: "no answer" };
  } catch (e) {
    if (stopped()) return cancelFrom("vision");
    const m = shortErr(e);
    out.vision = withStatus(
      /image|vision|multimodal|not support|modality/i.test(m)
        ? { status: "fail", detail: "model rejected the image (no vision)" }
        : { status: "fail", detail: m },
      e,
    );
  }

  if (onProgress) onProgress("done", out);
  return out;
}

// A reasoning model that spent a probe's whole budget thinking: its thoughts
// came back, in a reasoning field or as an inline <think> block the token cap
// cut off, but the answer (`answered`) did not. A model that thought briefly
// and then answered in text (stopping on its own) is not flagged.
function onlyThought(r, answered) {
  const content = (r.content || "").trimStart();
  const cutOff = r.stopReason === "length";
  if (cutOff && content.startsWith("<think>") && !content.includes("</think>")) return true;
  return !answered && !!(r.reasoning || "").trim() && (cutOff || !content.trim());
}

// Pull the provider's human-readable message out of our wrapped error, trimmed.
function shortErr(e) {
  let m = String((e && e.message) || e);
  const j = m.match(/\{[\s\S]*\}/);
  if (j) {
    try {
      const o = JSON.parse(j[0]);
      if (o.error && o.error.message) m = o.error.message;
    } catch {
      /* keep the raw message */
    }
  }
  return m.slice(0, 140);
}

// ---------------------------------------------------------------------------
// OpenAI-compatible
// ---------------------------------------------------------------------------

function openaiHeaders(provider) {
  const h = { "content-type": "application/json" };
  if (provider.apiKey) h["authorization"] = `Bearer ${provider.apiKey}`;
  // OpenRouter attribution headers (harmless for other providers).
  h["http-referer"] = "https://opensidekick.app";
  h["x-title"] = "OpenSidekick";
  return h;
}

// Opaque provider data that must go back with the turn that produced it, and
// only to the server that sent it: Gemini's thought signatures ride on tool
// calls as extra_content (Google's endpoint) or on the assistant message as
// reasoning_details (OpenRouter). Gemini 3 rejects a later tool turn without
// them (issue #7).
function sameOrigin(replay, origin) {
  return !!(replay && origin && replay.origin === origin);
}

export function toOpenAIMessages(messages, system, origin) {
  const out = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of messages) {
    if (m.role === "system") {
      out.push({ role: "system", content: m.content });
    } else if (m.role === "user") {
      if (m.images && m.images.length) {
        const parts = [];
        if (m.content) parts.push({ type: "text", text: m.content });
        for (const img of m.images) {
          parts.push({ type: "image_url", image_url: { url: `data:${img.mediaType};base64,${img.data}` } });
        }
        out.push({ role: "user", content: parts });
      } else {
        out.push({ role: "user", content: m.content });
      }
    } else if (m.role === "assistant") {
      const msg = { role: "assistant", content: m.content || "" };
      if (m.toolCalls && m.toolCalls.length) {
        msg.content = m.content || null;
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
          ...(sameOrigin(tc.replay, origin) && tc.replay.extra_content
            ? { extra_content: tc.replay.extra_content }
            : {}),
        }));
      }
      if (sameOrigin(m.replay, origin) && Array.isArray(m.replay.reasoning_details)) {
        msg.reasoning_details = m.replay.reasoning_details;
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
  const origin = trimSlash(provider.baseUrl);
  const body = {
    model: opts.model,
    messages: toOpenAIMessages(opts.messages, opts.system, origin),
    stream: true,
    max_tokens: opts.maxTokens,
  };
  if (typeof opts.temperature === "number") body.temperature = opts.temperature;
  const tools = toOpenAITools(opts.tools);
  if (tools) body.tools = tools;
  if (isVeniceUrl(provider.baseUrl)) {
    // Venice otherwise prepends its own consumer-chat system prompt, which
    // dilutes the agent's instructions; and reasoning models' <think> blocks
    // would stream into the chat as visible text.
    body.venice_parameters = { include_venice_system_prompt: false, strip_thinking_response: true };
  }

  const res = await fetch(`${trimSlash(provider.baseUrl)}/chat/completions`, {
    method: "POST",
    headers: openaiHeaders(provider),
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) throw await httpError(res);

  let content = "";
  // Thinking models stream their thoughts in a separate field: "reasoning" on
  // Ollama, "reasoning_content" on vLLM, LM Studio and DeepSeek-style servers.
  // Kept apart from content and never streamed to onDelta.
  let reasoning = "";
  const toolAccum = new Map(); // index -> { id, name, argChunks: [], extra }
  const reasoningDetails = [];
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
    if (typeof delta.reasoning === "string") reasoning += delta.reasoning;
    if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
    if (Array.isArray(delta.reasoning_details)) mergeReasoningDetails(reasoningDetails, delta.reasoning_details);
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolAccum.has(idx)) toolAccum.set(idx, { id: null, name: "", argChunks: [] });
        const acc = toolAccum.get(idx);
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name = tc.function.name;
        if (tc.function?.arguments) acc.argChunks.push(tc.function.arguments);
        if (isPlainObject(tc.extra_content)) acc.extra = mergeDeep(acc.extra || {}, tc.extra_content);
      }
    }
    if (choice.finish_reason) stopReason = choice.finish_reason;
  }

  const toolCalls = [...toolAccum.values()].map((acc, i) => {
    const call = { id: acc.id || `call_${i}`, name: acc.name, args: safeParseArgs(acc.argChunks.join("")) };
    if (acc.extra) call.replay = { origin, extra_content: acc.extra };
    return call;
  });

  const result = {
    content,
    toolCalls,
    stopReason: toolCalls.length ? "tool_use" : stopReason || "stop",
    reasoning,
  };
  if (reasoningDetails.length) result.replay = { origin, reasoning_details: reasoningDetails };
  return result;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function mergeDeep(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? mergeDeep(out[k], v) : v;
  }
  return out;
}

// OpenRouter streams reasoning_details in pieces: entries that share an index
// are one detail whose text/summary/data strings continue across chunks.
function mergeReasoningDetails(acc, chunk) {
  for (const d of chunk) {
    if (!isPlainObject(d)) continue;
    const prev = typeof d.index === "number" ? acc.find((x) => x.index === d.index && x.type === d.type) : null;
    if (!prev) {
      acc.push({ ...d });
      continue;
    }
    for (const [k, v] of Object.entries(d)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
      if (["text", "summary", "data"].includes(k) && typeof v === "string" && typeof prev[k] === "string") prev[k] += v;
      else if (prev[k] === undefined || prev[k] === null) prev[k] = v;
    }
  }
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
      const blocks = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const img of m.images || []) {
        blocks.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
      }
      if (!blocks.length) blocks.push({ type: "text", text: m.content || "" });
      pushAnthropic(out, "user", blocks);
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
    reasoning: "",
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

export function safeParseArgs(str) {
  if (!str || !str.trim()) return {};
  try {
    const v = JSON.parse(str);
    // Tools take an object; anything else ("{}" double-encoded, true, 3) is raw.
    return v && typeof v === "object" && !Array.isArray(v) ? v : { _raw: str };
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
  return statusError(`Provider request failed (${res.status}): ${detail.slice(0, 500)}`, res.status);
}

function statusError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function trimSlash(url) {
  return (url || "").replace(/\/+$/, "");
}

// True only for Venice's own API host — used to send Venice-specific request
// options. Hostname-exact so lookalikes (api.venice.ai.evil.com) don't match;
// a fully-qualified trailing dot still counts, other schemes don't.
export function isVeniceUrl(baseUrl) {
  try {
    const u = new URL(baseUrl);
    return /^https?:$/.test(u.protocol) && u.hostname.toLowerCase().replace(/\.$/, "") === "api.venice.ai";
  } catch {
    return false;
  }
}
