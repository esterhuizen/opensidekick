// Pure helpers for chat history: what a saved chat keeps, the caps that bound
// its size, titles, the index of saved chats, and the sensitive-site scan.
// No chrome.* APIs here, so all of it is unit-tested in Node; storage.js and
// the service worker do the reading and writing.

import { isSensitive } from "./permissions.js";
import { SESSIONS_MAX } from "../common/constants.js";

export const MESSAGE_MAX_CHARS = 20000;
export const SESSION_MAX_BYTES = 200 * 1024;
export const TITLE_MAX_CHARS = 60;
export const RENAME_MAX_CHARS = 80;
export const TRIM_MARK = "\n\n[…trimmed in saved history]";
export const SCREENSHOT_PLACEHOLDER = "(a screenshot was attached here; it is not retained across sessions)";

// Tools whose result URL is a page the agent actually read, opened or saw.
// list_tabs and read_network are left out on purpose: they mention other URLs
// without the agent having looked at those pages.
const SENSITIVE_SCAN_TOOLS = new Set([
  "read_page",
  "get_page_text",
  "run_javascript",
  "navigate",
  "open_tab",
  "switch_tab",
  "take_screenshot",
]);

const encoder = new TextEncoder();

// Bytes rather than characters, so CJK text (3 bytes a char) can't triple the bound.
export function byteLength(value) {
  return encoder.encode(JSON.stringify(value)).length;
}

// Cut to at most n UTF-16 units without splitting a surrogate pair.
function cut(s, n) {
  if (s.length <= n) return s;
  const code = s.charCodeAt(n - 1);
  return s.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
}

// Screenshots are large and only matter within the turn they were taken in.
export function stripImages(messages) {
  return messages.map((m) =>
    m.images && m.images.length
      ? { ...m, images: undefined, content: m.content || SCREENSHOT_PLACEHOLDER }
      : m,
  );
}

// What the user saw: their prompts and the assistant's text (or a finish
// summary). Tool traffic, internal plumbing and images never reach disk.
export function visibleTurns(messages) {
  const out = [];
  if (!Array.isArray(messages)) return out;
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "user") {
      if (typeof m.content === "string" && m.content && !m.images && !m.internal) {
        out.push(m.seeded ? { role: "user", content: m.content, seeded: true } : { role: "user", content: m.content });
      }
    } else if (m.role === "assistant") {
      let text = typeof m.content === "string" ? m.content.trim() : "";
      if (!text && Array.isArray(m.toolCalls)) {
        const fin = m.toolCalls.find((t) => t && t.name === "finish" && t.args && t.args.summary);
        const ask = m.toolCalls.find((t) => t && t.name === "ask_user" && t.args && t.args.question);
        if (fin) text = String(fin.args.summary);
        else if (ask) text = String(ask.args.question);
      }
      if (!text) continue;
      const prev = out[out.length - 1];
      if (prev && prev.role === "assistant") prev.content += "\n\n" + text;
      else out.push({ role: "assistant", content: text });
    }
  }
  return out;
}

// Cap each message, then drop the oldest exchanges (a user turn plus the
// replies before the next one) until the chat fits. The last exchange is
// always kept whole, and the result always starts with a user turn. So the
// byte bound is approximate: text heavy in JSON escapes (a control char is 6
// bytes) can take the last exchange alone past it, to about 240 KB at worst.
export function capTurns(turns, { maxBytes = SESSION_MAX_BYTES, maxMessageChars = MESSAGE_MAX_CHARS } = {}) {
  const exchanges = [];
  for (const t of turns) {
    const content = t.content.length > maxMessageChars ? cut(t.content, maxMessageChars) + TRIM_MARK : t.content;
    const msg = t.seeded ? { role: t.role, content, seeded: true } : { role: t.role, content };
    if (t.role === "user") exchanges.push([msg]);
    else if (exchanges.length) exchanges[exchanges.length - 1].push(msg);
  }
  // JSON.stringify(array) is "[" + items joined by "," + "]", so sizes add up
  // per message without re-serializing the whole chat on every drop.
  const sizes = exchanges.map((ex) => ex.reduce((n, m) => n + byteLength(m), 0));
  const counts = exchanges.map((ex) => ex.length);
  let bytes = 2 + sizes.reduce((a, b) => a + b, 0) + Math.max(0, counts.reduce((a, b) => a + b, 0) - 1);
  let start = 0;
  while (start < exchanges.length - 1 && bytes > maxBytes) {
    bytes -= sizes[start] + counts[start]; // its messages and their commas
    start++;
  }
  return exchanges.slice(start).flat();
}

export function titleFrom(text) {
  let t = typeof text === "string" ? text : "";
  const seed = t.match(/^Regarding this selected text from the page:\s*"""([\s\S]*?)"""/);
  const replay = !seed && t.match(/saved workflow named "([\s\S]+?)"\. Perform/);
  if (seed) t = seed[1];
  else if (replay) t = `Replay: ${replay[1]}`;
  t = t.replace(/\s+/g, " ").trim();
  if (!t) return "Untitled chat";
  return t.length > TITLE_MAX_CHARS ? cut(t, TITLE_MAX_CHARS - 1).trimEnd() + "…" : t;
}

export function normalizeTitle(input) {
  if (typeof input !== "string") return null;
  const t = cut(input.replace(/\s+/g, " ").trim(), RENAME_MAX_CHARS).trim();
  return t || null;
}

export function emptyIndex() {
  return { v: 1, currentId: null, items: [] };
}

const str = (v) => (typeof v === "string" && v ? v : null);

// Tolerant of anything storage hands back: a malformed item is dropped rather
// than taking the whole list down with it.
export function readIndex(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.items)) return emptyIndex();
  const items = raw.items
    .filter((i) => i && typeof i === "object" && typeof i.id === "string" && i.id && Number.isFinite(i.updatedAt))
    .map((i) => ({
      id: i.id,
      title: str(i.title) || "Untitled chat",
      createdAt: Number.isFinite(i.createdAt) ? i.createdAt : i.updatedAt,
      updatedAt: i.updatedAt,
      model: str(i.model),
      provider: str(i.provider),
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const seen = new Set();
  const unique = items.filter((i) => !seen.has(i.id) && seen.add(i.id)).slice(0, SESSIONS_MAX);
  const currentId = unique.some((i) => i.id === raw.currentId) ? raw.currentId : null;
  return { v: 1, currentId, items: unique };
}

export function upsertSession(index, entry, { max = SESSIONS_MAX } = {}) {
  const existing = index.items.find((i) => i.id === entry.id);
  const item = existing
    ? { ...existing, updatedAt: entry.updatedAt, model: entry.model, provider: entry.provider }
    : {
        id: entry.id,
        title: entry.title,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        model: entry.model,
        provider: entry.provider,
      };
  const rest = index.items.filter((i) => i.id !== entry.id).sort((a, b) => b.updatedAt - a.updatedAt);
  const keep = Math.max(0, max - 1);
  return {
    index: { ...index, items: [item, ...rest.slice(0, keep)] },
    evicted: rest.slice(keep).map((i) => i.id),
  };
}

export function removeSession(index, id) {
  return {
    ...index,
    currentId: index.currentId === id ? null : index.currentId,
    items: index.items.filter((i) => i.id !== id),
  };
}

// Items whose body is missing are dropped; bodies no item points at are orphans.
export function reconcileIndex(index, bodyIds) {
  const bodies = new Set(bodyIds);
  const items = index.items.filter((i) => bodies.has(i.id));
  const listed = new Set(items.map((i) => i.id));
  const currentId = listed.has(index.currentId) ? index.currentId : null;
  return {
    index: { ...index, currentId, items },
    orphans: [...bodies].filter((id) => !listed.has(id)),
    changed: items.length !== index.items.length || currentId !== index.currentId,
  };
}

// Everything the end-of-run save writes, decided in one place. `trimmed` is
// whether an earlier save already dropped old exchanges (a chat restored from
// a trimmed body has lost them for good, even if it now fits).
export function planSave({ index, sessionId, sensitive, conversation, isCurrent, keepHistory, now, model, provider, trimmed = false }) {
  const nothing = { index: null, body: null, removeIds: [] };
  if (!keepHistory) return nothing;
  const listed = index.items.some((i) => i.id === sessionId);
  if (sensitive) return listed ? { index: removeSession(index, sessionId), body: null, removeIds: [sessionId] } : nothing;
  const turns = visibleTurns(conversation);
  const first = turns.findIndex((t) => t.role === "user");
  if (first < 0) return nothing;
  const messages = capTurns(turns);
  const up = upsertSession(index, {
    id: sessionId,
    title: titleFrom(turns[first].content),
    createdAt: now,
    updatedAt: now,
    model: str(model),
    provider: str(provider),
  });
  let currentId = isCurrent ? sessionId : up.index.currentId;
  if (!up.index.items.some((i) => i.id === currentId)) currentId = null;
  const body = { id: sessionId, messages };
  if (trimmed || messages.length < turns.length - first) body.trimmed = true;
  return { index: { ...up.index, currentId }, body, removeIds: up.evicted };
}

// The top-level URL of a tool result. A result truncated by truncateForModel
// only has a JSON prefix in `preview`; `url` is near the front of every
// relevant shape, so the first match is the page's own URL.
export function observedUrl(content) {
  let r;
  try {
    r = typeof content === "string" ? JSON.parse(content) : content;
  } catch {
    return "";
  }
  if (!r || typeof r !== "object" || r.ok === false) return "";
  if (typeof r.url === "string") return r.url;
  if (typeof r.preview === "string") {
    const m = r.preview.match(/"url":"((?:[^"\\]|\\.)*)"/);
    if (m) {
      try {
        return JSON.parse(`"${m[1]}"`);
      } catch {
        return "";
      }
    }
  }
  return "";
}

export function touchesSensitiveSite(messages) {
  if (!Array.isArray(messages)) return false;
  return messages.some(
    (m) => m && m.role === "tool" && SENSITIVE_SCAN_TOOLS.has(m.name) && isSensitive(observedUrl(m.content)),
  );
}

export function relativeTime(ts, now = Date.now(), locale) {
  const elapsed = now - ts;
  if (!(elapsed >= 60e3)) return "just now";
  if (elapsed < 3600e3) return `${Math.floor(elapsed / 60e3)}m ago`;
  if (elapsed < 86400e3) return `${Math.floor(elapsed / 3600e3)}h ago`;
  if (elapsed < 2 * 86400e3) return "yesterday";
  if (elapsed < 7 * 86400e3) return `${Math.floor(elapsed / 86400e3)}d ago`;
  const date = new Date(ts);
  const opts = { day: "numeric", month: "short" };
  if (date.getFullYear() !== new Date(now).getFullYear()) opts.year = "numeric";
  return date.toLocaleDateString(locale, opts);
}
