// Unit suite for the chat renderer. Plain node, no browser, no deps.

import { markdownToHtml, safeHref, createStreamingRenderer, renderTick, setHighlighter } from "../src/common/markdown.js";
import { escapeHtml } from "../src/common/escape.js";

let fail = 0;
const eq = (got, want, label) => {
  if (got === want) console.log(`ok  : ${label}`);
  else { console.log(`FAIL: ${label}\n  got : ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); fail++; }
};
const ok = (cond, label) => {
  if (cond) console.log(`ok  : ${label}`);
  else { console.log(`FAIL: ${label}`); fail++; }
};
const count = (html, re) => (html.match(re) || []).length;

// ---- headings ----
eq(markdownToHtml("# A"), "<h1>A</h1>", "ATX heading renders as h1");
eq(markdownToHtml("###### F"), "<h6>F</h6>", "level 6 heading renders as h6");
ok(!markdownToHtml("# A").includes("#"), "the heading marker does not print");

// ---- paragraphs and breaks ----
eq(markdownToHtml("a\nb"), "<p>a<br>\nb</p>", "a single newline renders as a line break");
ok(markdownToHtml("a  \nb").includes("<br>"), "two trailing spaces make a hard break");

// ---- lists ----
ok(markdownToHtml("- one\n- two").includes("<ul>") && count(markdownToHtml("- one\n- two"), /<li>/g) === 2,
  "bullet list renders two items");
ok(markdownToHtml("1. a\n2. b").includes("<ol>"), "ordered list renders as ol");
ok(markdownToHtml("3. a\n4. b").includes('<ol start="3">'), "an ordered list keeps its start number");
const nested = markdownToHtml("- one\n  - nested");
ok(nested.includes("<ul>") && count(nested, /<li>/g) === 2 && nested.includes("<li>one\n<ul>"), "nested list renders inside its parent item");
ok(markdownToHtml("- [ ] todo\n- [x] done").includes('type="checkbox"'), "task list renders checkboxes");
ok(markdownToHtml("- [x] done").includes("checked"), "a completed task is checked");
ok(markdownToHtml("- [ ] todo").includes('type="checkbox"') && !markdownToHtml("- [ ] todo").includes("<p>"),
  "a tight task item gets a checkbox with no unclosed paragraph");
ok(markdownToHtml("- [ ] a\n\n- [ ] b").includes("<p>"), "a loose task list keeps its paragraphs");

// ---- blockquote, rule ----
ok(markdownToHtml("> quoted").includes("<blockquote>") && markdownToHtml("> quoted").includes("quoted"), "blockquote renders");
ok(markdownToHtml("---").includes("<hr>"), "thematic break renders as hr");
ok(!markdownToHtml("- - -").includes("<ul>"), "- - - is a rule, not a list");

// ---- code ----
const fence = markdownToHtml("```js\nconst x = 1;\n```");
ok(fence.includes('<span class="md-code-lang">js</span>'), "the fence language shows as a banner label");
ok(fence.includes("<pre tabindex=\"0\"><code>const x = 1;</code></pre>"), "the fence body renders as code without the language");
ok(fence.includes('class="md-copy"'), "a code block carries a Copy control");
ok(markdownToHtml("~~~\nc\n~~~").includes("<code>c</code>"), "a tilde fence is a code block");
ok(markdownToHtml("```js\nunclosed").includes("<code>unclosed</code>"), "an unclosed fence at the end is a code block");
ok(markdownToHtml("    indented").includes("<code>indented</code>"), "indented code renders as code");
ok(markdownToHtml("`inline`").includes("<code>inline</code>"), "inline code renders");

// ---- highlighting: the seam is optional ----
const seen = [];
setHighlighter((code, lang) => {
  seen.push(lang);
  return `<span class="token keyword">${escapeHtml(code)}</span>`;
});
const hl = markdownToHtml("```js\nconst x = 1;\n```");
ok(hl.includes('<span class="token keyword">const x = 1;</span>'), "a registered highlighter draws the fence body");
ok(seen.includes("js"), "the highlighter receives the fence language");
ok(markdownToHtml("```\nc\n```").includes("<code>c</code>"), "a fence with no language skips the highlighter");
ok(!seen.includes(""), "no highlighter call for a fence with no language");
ok(markdownToHtml("```js\n<b>x</b>\n```").includes('<span class="token keyword">&lt;b&gt;x&lt;/b&gt;</span>'), "the highlighter's escaped output goes into the code element");
setHighlighter(null);
ok(markdownToHtml("```js\n<b>x</b>\n```").includes("<code>&lt;b&gt;x&lt;/b&gt;</code>"), "with no highlighter the fence body is escaped text");

// ---- inline emphasis ----
ok(markdownToHtml("**bold**").includes("<strong>bold</strong>"), "bold renders");
ok(markdownToHtml("*em*").includes("<em>em</em>"), "emphasis renders");
ok(markdownToHtml("~~gone~~").includes("<s>gone</s>"), "strikethrough renders");
ok(markdownToHtml("a \\* b").includes("a * b"), "an escaped delimiter is literal");

// ---- links: the allowlist is the contract ----
const abs = markdownToHtml("[x](https://a.b/c)");
ok(abs.includes('<a href="https://a.b/c" target="_blank" rel="noopener noreferrer">x</a>'),
  "an absolute link renders as an external anchor");
ok(!markdownToHtml("[x](/docs)").includes("<a"), "a relative destination renders as inert text");
ok(!markdownToHtml("[x](javascript:alert(1))").includes("<a"), "a javascript: destination renders as inert text");
ok(markdownToHtml("[x](mailto:a@b.c)").includes("<a"), "a mailto destination renders as an anchor");
ok(markdownToHtml("See https://a.b/c now").includes("<a"), "a bare URL with a scheme is autolinked");
ok(!markdownToHtml("See www.example.com now").includes("<a"), "a bare domain is not autolinked — fuzzyLink is off");
ok(!markdownToHtml("edit setup.py and README.md, main.rs").includes("<a"), "filenames are not invented into domains");
ok(markdownToHtml("Mail user@example.com").includes('<a href="mailto:user@example.com"'), "a bare email is a mailto link — fuzzyEmail is on");
eq(markdownToHtml("Front: https://example.org/files/my_report_v2.png"),
  '<p>Front: <a href="https://example.org/files/my_report_v2.png" target="_blank" rel="noopener noreferrer">https://example.org/files/my_report_v2.png</a></p>',
  "a bare URL keeps its underscores — a filename is not cut at the first one");
ok(markdownToHtml("[x][ref]\n\n[ref]: https://a.b/c").includes("<a"), "a reference link resolves");

// ---- images: alt text only, no network destination ----
ok(!markdownToHtml("![d](https://evil.example/i.png)").includes("<img"), "an image never becomes an <img>");
ok(markdownToHtml("and ![d](https://a.b/i.png) x").includes("[image: d]"), "an image marks its alt text inside a sentence");
ok(markdownToHtml("![](https://a.b/i.png)").includes("[image]"), "an empty alt still leaves the marker");
ok(markdownToHtml("![a **b**](https://a.b/i.png)").includes("[image: a b]"), "alt markup is dropped, not printed raw");
const altLink = markdownToHtml("![see [b](https://x.y/z)](https://a.b/i.png)");
ok(altLink.includes("[image: see b]") && !altLink.includes("<a"), "a link inside the alt stays plain text, not a link the reader never saw");
ok(markdownToHtml("![a\nb](https://a.b/i.png)").includes("[image: a b]"), "a newline in the alt is a space, not a word join");
ok(markdownToHtml("![a **b** c*](https://a.b/i.png)").includes("[image: a b c*]"), "the whitelist drops only what markdown-it recognised, so an unmatched marker prints as text");

// ---- raw HTML is inert ----
ok(!markdownToHtml("<div>raw</div>").includes("<div>"), "raw HTML is escaped, not injected");
ok(markdownToHtml("<script>alert(1)</script>").includes("&lt;script&gt;"), "a script tag renders as text");

// ---- escaping: model output cannot inject HTML ----
ok(markdownToHtml("<b>x</b>").includes("&lt;b&gt;"), "tags are escaped at the text node");
const quoteHref = markdownToHtml('[x](https://a.b/c"onmouseover="alert(1))');
ok(!quoteHref.includes('onmouseover="'), "a quote in a destination cannot open an attribute");
ok(quoteHref.includes("%22"), "the quote is percent-encoded in the href");

// ---- tables ----
const table = markdownToHtml("| a | b |\n| --- | ---: |\n| 1 | 2 |");
ok(table.includes("<th>a</th>") && table.includes('<th style="text-align:right">b</th>'), "table header renders with alignment");
ok(count(table, /<tr>/g) === 2, "table renders its header row and its body row");
ok(table.includes('class="md-table"'), "a table gets its own scroll frame");

// ---- safeHref ----
eq(safeHref("https://a.b/c"), "https://a.b/c", "safeHref accepts an absolute http(s) URL");
eq(safeHref("mailto:a@b.c"), "mailto:a@b.c", "safeHref accepts mailto");
eq(safeHref("/docs"), null, "safeHref rejects a relative destination");
eq(safeHref("javascript:alert(1)"), null, "safeHref rejects javascript:");
eq(safeHref("data:text/html,x"), null, "safeHref rejects data:");
eq(safeHref("Aimailto:x"), null, "safeHref rejects a string that only contains mailto:");

// ---- input shapes ----
eq(markdownToHtml(""), "", "empty input renders nothing");
eq(markdownToHtml("a\r\nb\r\n"), "<p>a<br>\nb</p>", "CRLF input is handled");

// ---- streaming: the DOM after a chunked stream equals the one-shot render ----
const sample = [
  "## Findings",
  "1. first",
  "2. second",
  "",
  "- one",
  "  - nested",
  "",
  "| Site | Status |",
  "| --- | --- |",
  "| acme | ok |",
  "",
  "> quoted note",
  "",
  "```js",
  "const x = 1;",
  "```",
  "",
  "[safe](https://a.b/c) and [relative](/docs) and ![img](https://evil.example/i.png)",
].join("\n");

for (const size of [1, 3, 7, 16, 40]) {
  const r = createStreamingRenderer();
  const steps = Math.ceil(sample.length / size);
  const marks = [Math.ceil(steps / 4), Math.ceil(steps / 2), Math.ceil((3 * steps) / 4)];
  let html = "";
  for (let step = 1; step <= steps; step++) {
    r.append(sample.slice((step - 1) * size, step * size));
    html = r.render();
    // A mid-stream DOM is checked, not just the last one: that is the DOM the
    // panel shows partway through a reply.
    if (marks.includes(step)) {
      eq(html, markdownToHtml(sample.slice(0, step * size)), `streaming at ${size}-byte chunks renders the text sent so far (step ${step}/${steps})`);
    }
  }
  eq(html, markdownToHtml(sample), `streaming at ${size}-byte chunks ends at the one-shot render`);
}

// Parity holds on the highlighted path too.
setHighlighter((code, lang) => `<span class="token">${escapeHtml(code)}</span>`);
const rh = createStreamingRenderer();
let hlHtml = "";
for (let i = 0; i < sample.length; i += 7) {
  rh.append(sample.slice(i, i + 7));
  hlHtml = rh.render();
}
eq(hlHtml, markdownToHtml(sample), "streaming with a highlighter ends at the one-shot render");
setHighlighter(null);

// The final render is the same render a finished message gets.
const r = createStreamingRenderer();
r.append(sample.slice(0, 20));
const mid = r.render();
r.append(sample.slice(20));
eq(r.finalize(sample), markdownToHtml(sample), "finalize(full text) equals the one-shot render");
ok(mid !== markdownToHtml(sample), "a partial stream renders a partial reply");

// ---- render cadence ----
eq(renderTick(2), 16, "a few-millisecond render keeps the 16 ms tick");
eq(renderTick(10), 40, "the next tick is four times the last render");
eq(renderTick(125), 500, "a 125 ms render slows the stream to half a second");
eq(renderTick(500), 2000, "a 0.5 s render of a 100 KB reply gives the thread two seconds");
eq(renderTick(1300), 4000, "the tick clamps at 4 s, so a hostile reply still redraws");

console.log(fail ? `\n${fail} MARKDOWN CHECK(S) FAILED` : "\nALL MARKDOWN CHECKS PASSED");
process.exit(fail ? 1 : 0);
