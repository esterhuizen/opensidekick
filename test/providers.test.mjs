// Exercises the real callModel() streaming/parsing paths with a mocked fetch.
import { callModel } from "../src/background/providers.js";

function fakeResponse(chunks) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

let assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else {
    console.log("ok  :", msg);
  }
};

// ---- OpenAI ----
const openaiEvents = [
  `data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n`,
  `data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n`,
  `data: {"choices":[{"delta":{"content":"world"}}]}\n\n`,
  `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_page","arguments":""}}]}}]}\n\n`,
  `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}\n\n`,
  `data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n`,
  `data: [DONE]\n\n`,
];
// Split into odd byte boundaries to test buffering across chunks.
const joined = openaiEvents.join("");
const twoChunks = [joined.slice(0, 137), joined.slice(137)];

globalThis.fetch = async () => fakeResponse(twoChunks);
let deltas = "";
let r = await callModel(
  { type: "openai", baseUrl: "https://x/v1", apiKey: "k" },
  { model: "m", messages: [{ role: "user", content: "hi" }], tools: [], onDelta: (t) => (deltas += t) },
);
assert(r.content === "Hello world", `openai content == "Hello world" (got "${r.content}")`);
assert(deltas === "Hello world", `openai onDelta streamed text (got "${deltas}")`);
assert(r.toolCalls.length === 1, `openai one tool call (got ${r.toolCalls.length})`);
assert(r.toolCalls[0]?.name === "read_page", `openai tool name read_page (got ${r.toolCalls[0]?.name})`);
assert(JSON.stringify(r.toolCalls[0]?.args) === "{}", `openai tool args {} (got ${JSON.stringify(r.toolCalls[0]?.args)})`);
assert(r.stopReason === "tool_use", `openai stopReason tool_use (got ${r.stopReason})`);

// ---- Anthropic ----
const anthropicEvents = [
  `event: message_start\ndata: {"type":"message_start","message":{"id":"m","content":[]}}\n\n`,
  `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n`,
  `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`,
  `event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"click_element"}}\n\n`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"ref\\":"}}\n\n`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"5}"}}\n\n`,
  `event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n`,
  `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n`,
  `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
];
// Also test CRLF line endings this time.
const anthChunks = [anthropicEvents.join("").replace(/\n/g, "\r\n")];
globalThis.fetch = async () => fakeResponse(anthChunks);
let deltas2 = "";
let r2 = await callModel(
  { type: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKey: "k" },
  { model: "claude", messages: [{ role: "user", content: "hi" }], tools: [], maxTokens: 100, onDelta: (t) => (deltas2 += t) },
);
assert(r2.content === "Hi", `anthropic content == "Hi" (got "${r2.content}")`);
assert(deltas2 === "Hi", `anthropic onDelta streamed text (got "${deltas2}")`);
assert(r2.toolCalls.length === 1, `anthropic one tool call (got ${r2.toolCalls.length})`);
assert(r2.toolCalls[0]?.name === "click_element", `anthropic tool name click_element`);
assert(JSON.stringify(r2.toolCalls[0]?.args) === '{"ref":5}', `anthropic tool args {ref:5} (got ${JSON.stringify(r2.toolCalls[0]?.args)})`);
assert(r2.stopReason === "tool_use", `anthropic stopReason tool_use (got ${r2.stopReason})`);

console.log(process.exitCode ? "\nSOME TESTS FAILED" : "\nALL TESTS PASSED");
