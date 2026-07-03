// Verifies normalized-history -> provider-wire conversion by capturing the
// request body sent by callModel.
import { callModel } from "../src/background/providers.js";

function emptyStreamResponse() {
  const stream = new ReadableStream({ start: (c) => c.close() });
  return new Response(stream, { status: 200 });
}

let captured;
globalThis.fetch = async (_url, init) => {
  captured = JSON.parse(init.body);
  return emptyStreamResponse();
};

let fail = 0;
const eq = (a, b, msg) => {
  const pass = JSON.stringify(a) === JSON.stringify(b);
  console.log((pass ? "ok  : " : "FAIL: ") + msg);
  if (!pass) {
    console.log("   expected", JSON.stringify(b));
    console.log("   got     ", JSON.stringify(a));
    fail = 1;
  }
};

// A realistic multi-step conversation history.
const conversation = [
  { role: "user", content: "search for cats" },
  { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_page", args: {} }] },
  { role: "tool", toolCallId: "c1", name: "read_page", content: '{"ok":true,"elements":[]}' },
  { role: "assistant", content: "Found the search box.", toolCalls: [{ id: "c2", name: "type_text", args: { ref: 3, text: "cats", submit: true } }] },
  { role: "tool", toolCallId: "c2", name: "type_text", content: '{"ok":true}' },
  { role: "user", content: "thanks" },
];

// ---- OpenAI shape ----
await callModel(
  { type: "openai", baseUrl: "https://x/v1", apiKey: "k" },
  { model: "m", system: "SYS", messages: conversation, tools: [{ name: "read_page", description: "d", parameters: { type: "object", properties: {} } }] },
);
const m = captured.messages;
eq(m[0], { role: "system", content: "SYS" }, "openai: system prepended");
eq(m[1], { role: "user", content: "search for cats" }, "openai: first user");
eq(m[2].role, "assistant", "openai: assistant turn role");
eq(m[2].content, null, "openai: assistant content null when tool call present");
eq(m[2].tool_calls[0], { id: "c1", type: "function", function: { name: "read_page", arguments: "{}" } }, "openai: tool_call serialized");
eq(m[3], { role: "tool", tool_call_id: "c1", content: '{"ok":true,"elements":[]}' }, "openai: tool result");
eq(m[6], { role: "user", content: "thanks" }, "openai: trailing user");
eq(captured.tools[0].type, "function", "openai: tool def wrapped as function");
eq(captured.stream, true, "openai: streaming enabled");

// ---- Anthropic shape ----
await callModel(
  { type: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKey: "k" },
  { model: "claude", system: "SYS", maxTokens: 200, messages: conversation, tools: [{ name: "read_page", description: "d", parameters: { type: "object", properties: {} } }] },
);
const a = captured.messages;
eq(captured.system, "SYS", "anthropic: system as top-level param");
eq(a[0], { role: "user", content: [{ type: "text", text: "search for cats" }] }, "anthropic: first user block");
eq(a[1].role, "assistant", "anthropic: assistant role");
eq(a[1].content[0], { type: "tool_use", id: "c1", name: "read_page", input: {} }, "anthropic: assistant tool_use (no empty text block)");
eq(a[2], { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: '{"ok":true,"elements":[]}' }] }, "anthropic: tool_result as user turn");
eq(a[3].content[0], { type: "text", text: "Found the search box." }, "anthropic: assistant text block first");
eq(a[3].content[1], { type: "tool_use", id: "c2", name: "type_text", input: { ref: 3, text: "cats", submit: true } }, "anthropic: assistant text+tool_use");
// The final tool_result and the trailing "thanks" user message must merge into ONE user turn (alternation).
eq(a[4], { role: "user", content: [{ type: "tool_result", tool_use_id: "c2", content: '{"ok":true}' }, { type: "text", text: "thanks" }] }, "anthropic: trailing tool_result + user text MERGED into one turn");
eq(a.length, 5, "anthropic: exactly 5 turns (proper alternation)");
eq(captured.tools[0].input_schema, { type: "object", properties: {} }, "anthropic: tool uses input_schema");

// ---- Image (vision) message shaping ----
const withImage = [
  { role: "user", content: "look at this" },
  { role: "user", content: "Here is the screenshot:", images: [{ mediaType: "image/png", data: "AAAB" }] },
];

await callModel(
  { type: "openai", baseUrl: "https://x/v1", apiKey: "k" },
  { model: "m", messages: withImage, tools: [] },
);
const oi = captured.messages;
eq(oi[1].role, "user", "openai image: role user");
eq(oi[1].content[0], { type: "text", text: "Here is the screenshot:" }, "openai image: text part first");
eq(oi[1].content[1], { type: "image_url", image_url: { url: "data:image/png;base64,AAAB" } }, "openai image: image_url data URI");

await callModel(
  { type: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKey: "k" },
  { model: "claude", maxTokens: 100, messages: withImage, tools: [] },
);
const ai = captured.messages;
// The two user messages merge into one Anthropic user turn.
eq(ai.length, 1, "anthropic image: user turns merged");
eq(ai[0].content[1], { type: "text", text: "Here is the screenshot:" }, "anthropic image: text block");
eq(ai[0].content[2], { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAB" } }, "anthropic image: base64 image block");

console.log(fail ? "\nSOME TESTS FAILED" : "\nALL CONVERSION TESTS PASSED");
process.exitCode = fail;
