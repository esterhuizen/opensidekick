// HTML escaping for the innerHTML paths the UI builds from model, page, and user text.

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escape for HTML text and attribute context. */
export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);
}
