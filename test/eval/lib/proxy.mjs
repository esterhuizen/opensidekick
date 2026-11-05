// The model proxy (design §4.3). The extension's provider baseUrl points here
// with a placeholder key; the proxy adds the real key from process.env and
// forwards to the provider, so keys never enter the browser profile. It also
// tees the SSE stream for token usage, retries 429/5xx before any byte has
// reached the extension, and logs every call against the current run.

import http from "node:http";
import crypto from "node:crypto";
import { scrub } from "./scrub.mjs";

export const ROUTES = {
  anthropic: { base: "https://api.anthropic.com/v1", type: "anthropic", env: "CLAUDE_KEY" },
  google: { base: "https://generativelanguage.googleapis.com/v1beta/openai", type: "openai", env: "GEMINI_KEY" },
  openrouter: { base: "https://openrouter.ai/api/v1", type: "openai", env: "OPENROUTER_KEY" },
  "fake-openai": { fake: true, type: "openai", env: "GEMINI_KEY" },
  "fake-anthropic": { fake: true, type: "anthropic", env: "CLAUDE_KEY" },
};

const RETRY_STATUS = new Set([429, 500, 502, 503, 504, 529]);
const BACKOFF_MS = [2000, 5000, 10000];
const DROP_HEADERS = /^(host|origin|referer|cookie|authorization|x-api-key|connection|content-length|accept-encoding|user-agent|sec-.*|priority|pragma|cache-control)$/i;
// The fixed prompts of the options page's testModel() probes.
const PROBE_RE = /exactly one word: ready|call the echo tool|what color fills this image/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startProxy({ fake = null, usageInject = true, verbose = false } = {}) {
  const token = crypto.randomBytes(12).toString("hex");
  let run = null; // { id, calls: [] }
  let upstreamCalls = 0; // calls that left this machine (dry-run asserts 0)
  const usageUnavailable = new Set(); // "route|model" whose upstream refused stream_options

  async function upstream(routeName, route, { path, method, headers, body, signal }) {
    if (route.fake) return fake.handle({ route: routeName, path, method, headers, body, signal });
    upstreamCalls++;
    const res = await fetch(route.base + path, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : body, signal });
    return { status: res.status, headers: Object.fromEntries(res.headers), body: res.body };
  }

  const server = http.createServer(async (req, res) => {
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
    const m = /^\/([0-9a-f]+)\/([a-z-]+)(\/.*)?$/.exec(req.url || "");
    if (!m || m[1] !== token || !ROUTES[m[2]]) {
      res.writeHead(404, cors).end();
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors).end();
      return;
    }
    const routeName = m[2];
    const route = ROUTES[routeName];
    const path = m[3] || "/";
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = Buffer.concat(chunks);
    const text = body.toString("utf8");
    let model = "";
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
      model = (json && json.model) || "";
    } catch {
      /* not JSON */
    }
    const probe = PROBE_RE.test(text);
    // Ask OpenAI-compatible servers for a final usage chunk. The extension's
    // parser skips chunks without choices, so this changes nothing it sees.
    let injected = false;
    if (usageInject && route.type === "openai" && json && json.stream && !json.stream_options && !usageUnavailable.has(routeName + "|" + model)) {
      body = Buffer.from(JSON.stringify({ ...json, stream_options: { include_usage: true } }));
      injected = true;
    }

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!DROP_HEADERS.test(k)) headers[k] = v;
    const key = process.env[route.env] || "";
    if (route.type === "anthropic") headers["x-api-key"] = key;
    else if (key) headers["authorization"] = `Bearer ${key}`;

    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });

    const entry = { t: Date.now(), route: routeName, path, model, status: 0, ms: 0, retries: 0, backoffMs: 0, usage: null, probe, errorSnippet: "" };
    const owner = run;
    if (owner) owner.calls.push(entry);
    if (probe) console.warn("  warning: a model-suitability probe went through the proxy (excluded from metrics)");

    let up;
    for (let attempt = 0; ; attempt++) {
      try {
        up = await upstream(routeName, route, { path, method: req.method, headers, body, signal: abort.signal });
      } catch (e) {
        if (abort.signal.aborted) {
          entry.status = 499;
          entry.ms = Date.now() - entry.t;
          return;
        }
        up = { status: 0, headers: {}, body: null, error: e };
      }
      if (injected && up.status === 400) {
        const errText = await drain(up.body);
        if (/stream_options/i.test(errText)) {
          usageUnavailable.add(routeName + "|" + model);
          body = Buffer.from(text);
          injected = false;
          attempt--;
          continue;
        }
        up.body = once(errText);
      }
      const retryable = up.status === 0 || RETRY_STATUS.has(up.status);
      if (!retryable || attempt >= BACKOFF_MS.length) break;
      const ra = Number(up.headers?.["retry-after"]);
      const wait = ra > 0 ? Math.min(ra * 1000, 30000) : BACKOFF_MS[attempt];
      await drain(up.body);
      entry.retries++;
      entry.backoffMs += wait;
      if (verbose) console.log(`  proxy: ${routeName} ${up.status || "network error"}, retry in ${wait} ms`);
      await sleep(wait);
      if (abort.signal.aborted) {
        entry.status = 499; // the run gave up (timeout), not a provider failure
        entry.ms = Date.now() - entry.t;
        return;
      }
    }

    entry.status = up.status;
    if (up.status === 0) {
      entry.errorSnippet = scrub(String(up.error?.message || up.error)).slice(0, 300);
      entry.ms = Date.now() - entry.t;
      res.writeHead(502, { "content-type": "application/json", ...cors }).end(JSON.stringify({ error: { message: "eval proxy: upstream unreachable" } }));
      return;
    }
    const outHeaders = { ...cors };
    for (const [k, v] of Object.entries(up.headers || {})) {
      if (/^(content-type|retry-after|request-id|x-request-id)$/i.test(k)) outHeaders[k] = v;
    }
    res.writeHead(up.status, outHeaders);
    if (up.status >= 400) {
      const errText = await drain(up.body);
      entry.errorSnippet = scrub(errText).slice(0, 300);
      entry.ms = Date.now() - entry.t;
      res.end(scrub(errText)); // it lands in agent error events and chat history
      return;
    }
    const tee = sseUsage(route.type);
    try {
      if (up.body) {
        for await (const chunk of up.body) {
          const buf = Buffer.from(chunk);
          tee.push(buf);
          if (!res.write(buf)) await new Promise((r) => res.once("drain", r));
        }
      }
    } catch {
      /* client went away, or the upstream stream broke */
    }
    entry.usage = tee.usage();
    entry.ms = Date.now() - entry.t;
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  return {
    port,
    baseUrl: (route) => `http://127.0.0.1:${port}/${token}/${route}`,
    beginRun: (id) => (run = { id, calls: [] }),
    endRun: () => {
      const r = run;
      run = null;
      return r ? r.calls : [];
    },
    currentBackoffMs: () => (run ? run.calls.reduce((s, c) => s + c.backoffMs, 0) : 0),
    upstreamCalls: () => upstreamCalls,
    usageUnavailable: () => [...usageUnavailable],
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

async function drain(body) {
  if (!body) return "";
  let s = "";
  try {
    for await (const c of body) s += Buffer.from(c).toString("utf8");
  } catch {
    /* ignore */
  }
  return s;
}

async function* once(text) {
  yield Buffer.from(text);
}

// Parses an SSE stream as it passes and keeps the provider's usage numbers.
export function sseUsage(type) {
  let buf = "";
  const u = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let seen = false;
  const onEvent = (data) => {
    let j;
    try {
      j = JSON.parse(data);
    } catch {
      return;
    }
    if (type === "anthropic") {
      const mu = j.type === "message_start" ? j.message?.usage : null;
      if (mu) {
        seen = true;
        u.input += mu.input_tokens || 0;
        u.cacheWrite += mu.cache_creation_input_tokens || 0;
        u.cacheRead += mu.cache_read_input_tokens || 0;
        if (mu.output_tokens) u.output = mu.output_tokens;
      }
      if (j.type === "message_delta" && j.usage) {
        seen = true;
        if (j.usage.output_tokens != null) u.output = j.usage.output_tokens;
      }
    } else if (j.usage) {
      seen = true;
      u.input = j.usage.prompt_tokens || 0;
      u.output = j.usage.completion_tokens || 0;
      u.cacheRead = j.usage.prompt_tokens_details?.cached_tokens || 0;
    }
  };
  return {
    push(chunk) {
      buf += chunk.toString("utf8").replace(/\r/g, "");
      let i;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const ev = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of ev.split("\n")) if (line.startsWith("data:")) onEvent(line.slice(5).trim());
      }
    },
    usage: () => (seen ? { ...u } : null),
  };
}
