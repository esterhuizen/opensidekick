// A scripted fake LLM behind the proxy's fake routes (design §10). It speaks
// OpenAI SSE and Anthropic SSE, and plays one policy per model id:
//   oracle  - the task's fake.oracle script (does the task right)
//   refuser - always refuses with invented "privacy and security" wording
//   unsafe  - the safety task's fake.unsafe script (breaks the rule)
// It is stateless per request: the step it is on is encoded in the ids of the
// tool calls it made earlier in the conversation (fk_<turn>_<step>_<sub>_<n>).

export const REFUSAL_TEXT = "I'm sorry, but I can't do that because of a privacy and security boundary. You can check it yourself.";
const INTERNAL_USER_RE = /^\(Automatic reminder from OpenSidekick|^Here (?:is the screenshot|are the screenshots) you requested|^I approve this plan\./;
const NUDGE_RE = /^\(Automatic reminder from OpenSidekick/;

let nonce = 0;

export function createFake() {
  let run = { task: null, facts: {}, count529: 0 };
  return {
    setRun(r) {
      run = { count529: 0, ...r };
    },
    handle: (req) => handle(req, run),
  };
}

async function handle({ route, path, method, headers, body, signal }, run) {
  const type = route === "fake-anthropic" ? "anthropic" : "openai";
  // The proxy must have swapped the extension's placeholder for the real key.
  const want = process.env[type === "anthropic" ? "CLAUDE_KEY" : "GEMINI_KEY"] || "";
  const got = type === "anthropic" ? headers["x-api-key"] : String(headers["authorization"] || "").replace(/^Bearer\s+/i, "");
  if (!want || got !== want) return jsonRes(401, { error: { message: "fake model: missing or wrong API key (the proxy did not inject it)" } });

  if (method === "GET" && /\/models$/.test(path)) return jsonRes(200, { data: ["oracle", "refuser", "unsafe"].map((id) => ({ id })) });
  if (method !== "POST" || !/\/(chat\/completions|messages)$/.test(path)) return jsonRes(404, { error: { message: "fake model: unknown path" } });

  const req = JSON.parse(body.toString("utf8"));
  const task = run.task || {};
  const behaviour = task.fake && task.fake.behaviour;
  if (behaviour === "stall") return { status: 200, headers: { "content-type": "text/event-stream" }, body: stall(signal) };
  if (behaviour === "status400") return jsonRes(400, { error: { message: "fake model: bad request (scripted)" } });
  if (behaviour === "status529x2" && run.count529 < 2) {
    run.count529++;
    return jsonRes(529, { error: { message: "fake model: overloaded (scripted)" } });
  }

  const items = type === "anthropic" ? anthropicItems(req) : openaiItems(req);
  const policy = String(req.model || "").replace(/^fake-/, "");
  let reply;
  if (policy === "refuser") reply = { kind: "text", text: REFUSAL_TEXT };
  else {
    const script = (task.fake && task.fake[policy]) || [];
    reply = decide(script, items, run.facts || {});
  }
  const usageIn = Math.ceil(body.length / 4);
  const sse = type === "anthropic" ? anthropicSse(reply, usageIn) : openaiSse(reply, usageIn, !!req.stream_options?.include_usage);
  return { status: 200, headers: { "content-type": "text/event-stream" }, body: chunks(sse) };
}

function jsonRes(status, obj) {
  return { status, headers: { "content-type": "application/json" }, body: chunks([JSON.stringify(obj)]) };
}

async function* chunks(list) {
  for (const s of list) yield Buffer.from(s);
}

// Holds the stream open, sending nothing, until the client goes away.
async function* stall(signal) {
  await new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", resolve, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Conversation -> flat items: user | atext | call | result
// ---------------------------------------------------------------------------

const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (p && (p.text || "")) || "").join(" ") : "");

export function openaiItems(req) {
  const out = [];
  for (const m of req.messages || []) {
    if (m.role === "user") out.push({ kind: "user", text: textOf(m.content) });
    else if (m.role === "assistant") {
      if (m.content) out.push({ kind: "atext", text: textOf(m.content) });
      for (const tc of m.tool_calls || []) out.push({ kind: "call", id: tc.id, name: tc.function?.name, args: safeJson(tc.function?.arguments) });
    } else if (m.role === "tool") out.push({ kind: "result", id: m.tool_call_id, content: m.content });
  }
  return out;
}

export function anthropicItems(req) {
  const out = [];
  for (const m of req.messages || []) {
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content || [];
    for (const b of blocks) {
      if (m.role === "user" && b.type === "tool_result") out.push({ kind: "result", id: b.tool_use_id, content: textOf(b.content) });
      else if (m.role === "user" && b.type === "text") out.push({ kind: "user", text: b.text || "" });
      else if (m.role === "assistant" && b.type === "text") out.push({ kind: "atext", text: b.text || "" });
      else if (m.role === "assistant" && b.type === "tool_use") out.push({ kind: "call", id: b.id, name: b.name, args: b.input || {} });
    }
  }
  return out;
}

function safeJson(s) {
  try {
    return typeof s === "string" ? JSON.parse(s || "{}") : s || {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// The script interpreter (design §10.2)
// ---------------------------------------------------------------------------

const REF_OPS = new Set(["click", "type", "select"]);

function parseId(id) {
  const m = /^fk_(\d+)_(\d+)_([xruw])_/.exec(String(id || ""));
  return m ? { turn: +m[1], k: +m[2], sub: m[3] } : null;
}

function subst(v, facts) {
  return typeof v === "string" ? v.replace(/\{I\}/g, facts.installed || "").replace(/\{St\}/g, facts.store || "") : v;
}

function fits(el, op) {
  if (op === "type") return (el.tag === "input" && !["submit", "button", "checkbox", "radio", "hidden"].includes(el.type)) || el.tag === "textarea" || el.role === "textbox";
  if (op === "select") return el.tag === "select";
  return true;
}

const hay = (el) => [el.name, el.placeholder, el.href].filter(Boolean).join(" ");
// Each of name, placeholder and href on its own, so ^anchored patterns work.
const matchesEl = (el, re) => [el.name, el.placeholder, el.href].some((s) => s && re.test(s));

export function findElement(elements, re, op) {
  return (elements || []).find((el) => fits(el, op) && matchesEl(el, re)) || null;
}

function readMatches(result, re) {
  if (!result || result.ok === false) return false;
  const text = [result.summary?.headline, result.summary?.excerpt, ...(result.elements || []).map(hay)].join(" ");
  return re.test(text);
}

/** The next reply for a script, given the conversation so far. */
export function decide(script, items, facts) {
  let lastUser = -1;
  let turn = -1;
  items.forEach((it, i) => {
    if (it.kind === "user" && !INTERNAL_USER_RE.test(it.text)) {
      lastUser = i;
      turn++;
    }
  });
  const tail = items[items.length - 1];
  // The keep-going reminder: the last reply already said everything.
  if (tail && tail.kind === "user" && NUDGE_RE.test(tail.text)) return tool(turn, 0, "x", "finish", { summary: "" });

  const seg = items.slice(lastUser + 1);
  const calls = seg.filter((it) => it.kind === "call" && parseId(it.id)?.turn === turn);
  const results = new Map(seg.filter((it) => it.kind === "result").map((r) => [r.id, safeJson(r.content)]));
  const steps = script[turn] || [];
  const last = calls[calls.length - 1] || null;
  const lp = last ? parseId(last.id) : null;
  const lastRes = last ? results.get(last.id) : null;
  const countSub = (k, sub) => calls.filter((c) => { const p = parseId(c.id); return p.k === k && p.sub === sub; }).length;

  let k = !lp ? 0 : lp.sub === "x" ? lp.k + 1 : lp.k;
  // A refused click/type/select (say, the element changed since the read) is
  // tried again after a fresh read, up to 3 times, like a real model would.
  if (lp && lp.sub === "x" && lastRes && lastRes.ok === false && /^(click_element|type_text|select_option)$/.test(last.name) && countSub(lp.k, "x") < 3) k = lp.k;
  let fresh = last && last.name === "read_page" && lastRes && lastRes.ok !== false ? lastRes : null;

  for (;;) {
    const step = steps[k];
    if (!step) return tool(turn, k, "x", "finish", { summary: "Done." });
    const [op, a, b, c] = step;
    switch (op) {
      case "read": return tool(turn, k, "x", "read_page", {});
      case "get_text": return tool(turn, k, "x", "get_page_text", {});
      case "navigate": return tool(turn, k, "x", "navigate", { url: subst(a, facts) });
      case "open_tab": return tool(turn, k, "x", "open_tab", { url: subst(a, facts) });
      case "scroll": return tool(turn, k, "x", "scroll", { direction: a || "down" });
      case "wait": return tool(turn, k, "x", "wait", { seconds: a || 1 });
      case "ask": return tool(turn, k, "x", "ask_user", { question: subst(a, facts) });
      case "finish": return tool(turn, k, "x", "finish", { summary: subst(a, facts) });
      case "text": return { kind: "text", text: subst(a, facts) };
      case "readUntil": {
        const max = b || 6;
        if (lp && lp.k === k && lp.sub === "u") {
          if (readMatches(lastRes, a)) {
            k++;
            continue; // the read that matched is fresh for the next step
          }
          if (countSub(k, "u") >= max) return tool(turn, k, "x", "finish", { summary: `ORACLE: never saw ${a} after ${max} reads` });
          return tool(turn, k, "w", "wait", { seconds: 2 });
        }
        return tool(turn, k, "u", "read_page", {});
      }
      default: {
        if (!REF_OPS.has(op)) return tool(turn, k, "x", "finish", { summary: `ORACLE: unknown step ${op}` });
        const el = fresh ? findElement(fresh.elements, a, op) : null;
        if (el) {
          if (op === "click") return tool(turn, k, "x", "click_element", { ref: el.ref });
          if (op === "select") return tool(turn, k, "x", "select_option", { ref: el.ref, value: subst(b, facts) });
          return tool(turn, k, "x", "type_text", { ref: el.ref, text: subst(b, facts), ...(c && c.submit ? { submit: true } : {}) });
        }
        if (countSub(k, "r") >= 3) return tool(turn, k, "x", "finish", { summary: `ORACLE: no element ${a} for ${op}` });
        return tool(turn, k, "r", "read_page", {});
      }
    }
  }
}

function tool(turn, k, sub, name, args) {
  return { kind: "tool", id: `fk_${Math.max(turn, 0)}_${k}_${sub}_${++nonce}`, name, args };
}

// ---------------------------------------------------------------------------
// Wire formats
// ---------------------------------------------------------------------------

function openaiSse(reply, usageIn, withUsage) {
  const out = [];
  const send = (o) => out.push("data: " + JSON.stringify(o) + "\n\n");
  send({ choices: [{ index: 0, delta: { role: "assistant" } }] });
  let outBytes = 0;
  if (reply.kind === "text") {
    const mid = Math.ceil(reply.text.length / 2);
    send({ choices: [{ index: 0, delta: { content: reply.text.slice(0, mid) } }] });
    send({ choices: [{ index: 0, delta: { content: reply.text.slice(mid) } }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    outBytes = reply.text.length;
  } else {
    const args = JSON.stringify(reply.args);
    const mid = Math.ceil(args.length / 2); // split arguments across chunks, like real servers
    send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: reply.id, type: "function", function: { name: reply.name, arguments: "" } }] } }] });
    send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, mid) } }] } }] });
    send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(mid) } }] } }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    outBytes = args.length + reply.name.length;
  }
  if (withUsage) send({ choices: [], usage: { prompt_tokens: usageIn, completion_tokens: Math.ceil(outBytes / 4), total_tokens: usageIn + Math.ceil(outBytes / 4) } });
  out.push("data: [DONE]\n\n");
  return out;
}

function anthropicSse(reply, usageIn) {
  const out = [];
  const send = (event, o) => out.push(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...o })}\n\n`);
  send("message_start", { message: { id: "msg_fake", type: "message", role: "assistant", content: [], model: "fake", usage: { input_tokens: usageIn, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
  let outBytes = 0;
  if (reply.kind === "text") {
    send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    const mid = Math.ceil(reply.text.length / 2);
    send("content_block_delta", { index: 0, delta: { type: "text_delta", text: reply.text.slice(0, mid) } });
    send("content_block_delta", { index: 0, delta: { type: "text_delta", text: reply.text.slice(mid) } });
    send("content_block_stop", { index: 0 });
    outBytes = reply.text.length;
  } else {
    const args = JSON.stringify(reply.args);
    const mid = Math.ceil(args.length / 2);
    send("content_block_start", { index: 0, content_block: { type: "tool_use", id: reply.id, name: reply.name, input: {} } });
    send("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: args.slice(0, mid) } });
    send("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: args.slice(mid) } });
    send("content_block_stop", { index: 0 });
    outBytes = args.length;
  }
  send("message_delta", { delta: { stop_reason: reply.kind === "text" ? "end_turn" : "tool_use" }, usage: { output_tokens: Math.ceil(outBytes / 4) } });
  send("message_stop", {});
  return out;
}
