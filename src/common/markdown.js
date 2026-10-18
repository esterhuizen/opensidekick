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

// The allowlist: a destination that fails here stays literal text.
const validateLink = (url) => safeHref(url) !== null;

const md = new MarkdownIt({ html: false, linkify: true, typographer: false, validateLink });

// linkify matches a URL with a scheme only; fuzzy matching adds the bare domains
// a model writes, and the destination still goes through validateLink.
md.linkify.set({ fuzzyLink: true });

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

// markdown-it validates a destination for linkify, not for an inline link, so
// the allowlist is enforced where the anchor is emitted. A rejected destination
// renders as the label's plain text: the opening tag becomes a span, and
// link_close matches it.
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = safeHref(tokens[idx].attrGet("href"));
  if (!href) {
    tokens[idx].tag = "span";
    tokens[idx].attrs = [];
    return self.renderToken(tokens, idx, options);
  }
  tokens[idx].attrSet("href", href);
  tokens[idx].attrSet("target", "_blank");
  tokens[idx].attrSet("rel", "noopener noreferrer");
  return self.renderToken(tokens, idx, options);
};

md.renderer.rules.link_close = (tokens, idx) => {
  for (let k = idx - 1; k >= 0; k--) {
    if (tokens[k].type === "link_open") return tokens[k].tag === "span" ? "</span>" : "</a>";
  }
  return "</a>";
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
