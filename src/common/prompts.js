// Pure helper for the "/" slash-command menu — kept testable and shared.

/**
 * Filter saved prompts for a slash query. `query` is the composer text; if it
 * starts with "/", the part after it is matched against each prompt's command
 * (prefix matches first, then substring, then body matches). Returns up to 8.
 */
export function matchPrompts(prompts, query) {
  const list = Array.isArray(prompts) ? prompts : [];
  const q = String(query || "").replace(/^\//, "").trim().toLowerCase();
  if (!q) return list.slice(0, 8);
  const starts = [];
  const contains = [];
  for (const p of list) {
    const cmd = String(p.command || "").toLowerCase();
    if (cmd.startsWith(q)) starts.push(p);
    else if (cmd.includes(q) || String(p.text || "").toLowerCase().includes(q)) contains.push(p);
  }
  return [...starts, ...contains].slice(0, 8);
}

/** True when the composer text is an active slash query (starts with "/", one line, no spaces yet in the command). */
export function isSlashQuery(text) {
  const t = String(text || "");
  if (!t.startsWith("/")) return false;
  if (t.includes("\n")) return false;
  return true;
}
