// Markdown rendering for the chat transcript. Parsing is markdown-it (vendored);
// this module owns what a library cannot: the link allowlist, images as alt
// text, and the code-block chrome. Raw HTML stays inert text (html:false).

import MarkdownIt from "./vendor/markdown-it.mjs";
import { escapeHtml } from "./escape.js";

// The code-block contract: the side panel finds the code inside this class.
export const CODE_CLASS = "md-code";

// Syntax highlighting is optional. The panel registers a highlighter that returns
// escaped HTML; a fence with no language, no highlighter, or a language the
// highlighter does not know renders as escaped text.
let highlight = null;
export function setHighlighter(fn) {
  highlight = typeof fn === "function" ? fn : null;
}

const ALLOWED = /^(https?:\/\/|mailto:)/i;

export function safeHref(url) {
  const u = String(url ?? "").trim();
  if (!u) return null;
  if (!ALLOWED.test(u)) return null;
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "mailto:") return null;
    return parsed.href;
  } catch {
    return null;
  }
}

// breaks: true. The chat used to emit <br> for a single newline, and replies rely
// on it — a model writes "line one\nline two" as two lines, not one. The panel
// sets white-space: normal, so the renderer owns whitespace.
const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: true });

// markdown-it reads md.validateLink, the prototype method, not a constructor
// option, so the allowlist goes there. Inline links, reference definitions,
// autolinks, and linkify all ask it before they emit a destination, which leaves
// no second place to check.
md.validateLink = (url) => safeHref(url) !== null;

// The linkify flags, left as upstream ships them. fuzzyLink stays off: a bare
// domain is a guess, so setup.py and README.md — filenames a model writes — become
// links to http://setup.py and http://README.md, invented from two-letter TLDs.
// fuzzyEmail stays on: mailto: is in the allowlist, so a bare email in a reply is
// a clickable mailto link, and a click goes through the browser's mail handler.
// The panel's only network destination is still the user's provider.

// A code fence gets a banner naming its language, so the language is not the
// code's first line, and a Copy control. The copy handler lives in the side panel.
md.renderer.rules.fence = (tokens, idx) => {
  const lang = tokens[idx].info.trim().split(/\s+/)[0] || "";
  const body = tokens[idx].content.replace(/\n$/, "");
  const banner = lang ? `<span class="md-code-lang">${escapeHtml(lang)}</span>` : "";
  const bodyHtml = lang && highlight ? highlight(body, lang) : escapeHtml(body);
  return (
    `<div class="${CODE_CLASS}"><div class="${CODE_CLASS}-banner">` +
    banner +
    '<button type="button" class="md-copy" aria-label="Copy code">Copy</button>' +
    `</div><pre tabindex="0"><code>${bodyHtml}</code></pre></div>`
  );
};

// Indented code: the same frame, no banner.
md.renderer.rules.code_block = (tokens, idx) =>
  `<div class="${CODE_CLASS}"><pre tabindex="0"><code>${escapeHtml(tokens[idx].content.replace(/\n$/, ""))}</code></pre></div>`;

// A wide table scrolls sideways inside its own frame instead of pushing the panel.
md.renderer.rules.table_open = () => '<div class="md-table" tabindex="0"><table>';
md.renderer.rules.table_close = () => "</table></div>";

// An image is its alt text. No src, so no request.
md.renderer.rules.image = (tokens, idx) => escapeHtml(tokens[idx].content);

// Task lists: markdown-it has none, so the marker is handled here. The inline
// renderer draws a token's children, not its content, so the strip happens on
// the first child.
md.renderer.rules.paragraph_open = (tokens, idx, options, env, self) => {
  if (tokens[idx - 1]?.type === "list_item_open") {
    const inline = tokens[idx + 1];
    const first = inline?.type === "inline" ? inline.children[0] : null;
    const m = first?.type === "text" ? /^\[([ xX])\]\s+/.exec(first.content) : null;
    if (m) {
      first.content = first.content.slice(m[0].length);
      return `<p><input type="checkbox" disabled${m[1] === " " ? "" : " checked"} /> `;
    }
  }
  return self.renderToken(tokens, idx, options);
};

// validateLink has already allowlisted the destination, so this rule only adds
// what a chat panel needs: the link opens in its own tab, with no handle from the
// opened page back into the panel.
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet("href", safeHref(tokens[idx].attrGet("href")));
  tokens[idx].attrSet("target", "_blank");
  tokens[idx].attrSet("rel", "noopener noreferrer");
  return self.renderToken(tokens, idx, options);
};

export function markdownToHtml(src) {
  return md.render(String(src ?? "")).replace(/\n+$/, "");
}

// Streaming: a growing reply is rendered whole on each call, so the last render
// is the same render a finished message gets — the DOM after a chunked stream is
// the DOM of the same answer sent in one piece.
export function createStreamingRenderer() {
  let raw = "";
  return {
    append(text) {
      raw += text;
    },
    render() {
      return markdownToHtml(raw);
    },
    finalize(text) {
      if (text) raw = text;
      return markdownToHtml(raw);
    },
  };
}
