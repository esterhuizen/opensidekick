// HTML helpers shared by the fake sites: escaping, a page shell per "skin",
// and the form beacon that lets checkers see "filled but not sent".

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const SKINS = {
  plain: { bg: "#ffffff", ink: "#1f2328", accent: "#0969da", font: "system-ui, sans-serif" },
  google: { bg: "#ffffff", ink: "#202124", accent: "#1a0dab", font: "arial, sans-serif" },
  bing: { bg: "#ffffff", ink: "#111111", accent: "#174ae4", font: "'Segoe UI', sans-serif" },
  ddg: { bg: "#ffffff", ink: "#222222", accent: "#de5833", font: "-apple-system, sans-serif" },
  store: { bg: "#ffffff", ink: "#1f1f1f", accent: "#0b57d0", font: "'Google Sans', arial, sans-serif" },
  shop: { bg: "#fafaf7", ink: "#1c1c1a", accent: "#c2410c", font: "system-ui, sans-serif" },
  gadget: { bg: "#f4f7fb", ink: "#0f172a", accent: "#0e7490", font: "system-ui, sans-serif" },
  news: { bg: "#fffdf8", ink: "#1a1a1a", accent: "#7f1d1d", font: "Georgia, serif" },
  wiki: { bg: "#ffffff", ink: "#202122", accent: "#3366cc", font: "sans-serif" },
  bank: { bg: "#f5f7f6", ink: "#10231b", accent: "#166534", font: "system-ui, sans-serif" },
  mail: { bg: "#f6f8fc", ink: "#1f1f1f", accent: "#0b57d0", font: "system-ui, sans-serif" },
  dark: { bg: "#0d1117", ink: "#e6edf3", accent: "#4493f8", font: "system-ui, sans-serif" },
};

/** A whole page. `header` and `footer` are HTML; `body` goes inside <main>. */
export function page({ title, desc = "", skin = "plain", header = "", body = "", footer = "", head = "", scripts = "" }) {
  const k = SKINS[skin] || SKINS.plain;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>${desc ? `<meta name="description" content="${esc(desc)}">` : ""}
<style>
body{margin:0;background:${k.bg};color:${k.ink};font:16px/1.5 ${k.font}}
a{color:${k.accent}} header,footer{padding:10px 24px;border-bottom:1px solid #8883} footer{border-top:1px solid #8883;border-bottom:0;font-size:13px;margin-top:40px}
header nav a,footer a{margin-right:14px} main{max-width:860px;margin:0 auto;padding:16px 24px}
button,.btn{background:${k.accent};color:#fff;border:0;border-radius:6px;padding:8px 14px;font:inherit;cursor:pointer}
button[disabled]{opacity:.45;cursor:not-allowed} input,select,textarea{font:inherit;padding:6px 8px;margin:4px 0 10px;border:1px solid #8888;border-radius:6px}
label{display:block} table{border-collapse:collapse} td,th{border:1px solid #8885;padding:4px 10px;text-align:left}
.muted{opacity:.7;font-size:14px} .card{border:1px solid #8884;border-radius:10px;padding:12px 16px;margin:10px 0;background:#fff8}
</style>${head}</head>
<body>${header ? `<header>${header}</header>` : ""}<main>${body}</main>${footer ? `<footer>${footer}</footer>` : ""}${scripts}</body></html>`;
}

/**
 * Posts a form's field values to POST /__fields on every input/change
 * (debounced 150 ms). Password fields report only that they are non-empty.
 */
export const BEACON = `<script>
(function () {
  var timers = {};
  function fieldsOf(form) {
    var out = {}, pw = false;
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el.name) return;
      if (el.type === "password") { if (el.value) pw = true; return; }
      if (el.type === "checkbox") { out[el.name] = el.checked ? (el.value || "on") : ""; return; }
      if (el.type === "radio") { if (el.checked) out[el.name] = el.value; else if (!(el.name in out)) out[el.name] = ""; return; }
      if (el.type === "submit" || el.type === "button") return;
      out[el.name] = el.value;
    });
    return { fields: out, passwordInput: pw };
  }
  function schedule(e) {
    var form = e.target && e.target.form;
    if (!form || !form.dataset.form) return;
    var name = form.dataset.form;
    clearTimeout(timers[name]);
    timers[name] = setTimeout(function () {
      var f = fieldsOf(form);
      fetch("/__fields", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ form: name, fields: f.fields, passwordInput: f.passwordInput }) }).catch(function () {});
    }, 150);
  }
  document.addEventListener("input", schedule, true);
  document.addEventListener("change", schedule, true);
})();
</script>`;
