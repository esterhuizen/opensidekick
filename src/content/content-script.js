// OpenSidekick content script (NOT an ES module — runs in the page's isolated
// world). It reads the page into a compact, model-friendly representation and
// executes actions (click / type / select / scroll) by stable "ref" ids.
//
// Design mirrors how agentic browser assistants ground actions: build a map of
// interactive elements, hand the model numeric refs, and let it act by ref.

(function () {
  "use strict";
  if (window.__opensidekick_cs_loaded) return;
  window.__opensidekick_cs_loaded = true;

  const MAX_ELEMENTS = 200;
  const MAX_TEXT = 8000;

  // ref id -> element. Rebuilt on every read_page.
  let refMap = new Map();
  let refCounter = 0;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    try {
      switch (msg.type) {
        case "cs_ping":
          sendResponse({ ok: true });
          return true;
        case "cs_read_page":
          sendResponse(readPage());
          return true;
        case "cs_get_text":
          sendResponse({ ok: true, url: location.href, title: document.title, text: pageText() });
          return true;
        case "cs_act":
          sendResponse(act(msg));
          return true;
        default:
          sendResponse({ ok: false, error: "Unknown message" });
          return true;
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      return true;
    }
  });

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  function readPage() {
    refMap = new Map();
    refCounter = 0;

    const elements = [];
    const selector = [
      "a[href]",
      "button",
      "input:not([type=hidden])",
      "textarea",
      "select",
      "[role=button]",
      "[role=link]",
      "[role=checkbox]",
      "[role=radio]",
      "[role=tab]",
      "[role=menuitem]",
      "[role=switch]",
      "[role=option]",
      "[contenteditable=true]",
      "[contenteditable='']",
      "summary",
      "label[for]",
    ].join(",");

    const nodes = document.querySelectorAll(selector);
    for (const el of nodes) {
      if (elements.length >= MAX_ELEMENTS) break;
      if (!isVisible(el)) continue;
      const ref = ++refCounter;
      refMap.set(ref, el);
      elements.push(describe(ref, el));
    }

    return {
      ok: true,
      url: location.href,
      title: document.title,
      summary: pageSummary(),
      elements,
      note:
        elements.length >= MAX_ELEMENTS
          ? `Showing first ${MAX_ELEMENTS} interactive elements; scroll for more.`
          : undefined,
    };
  }

  function describe(ref, el) {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role") || undefined;
    const type = el.getAttribute("type") || undefined;
    const out = { ref, tag };
    if (role) out.role = role;
    if (type) out.type = type;
    const name = accessibleName(el);
    if (name) out.name = name.slice(0, 160);
    if (tag === "input" || tag === "textarea") {
      out.value = (el.value || "").slice(0, 120);
      if (el.placeholder) out.placeholder = el.placeholder.slice(0, 80);
    }
    if (tag === "select") {
      out.options = Array.from(el.options)
        .slice(0, 30)
        .map((o) => o.textContent.trim().slice(0, 60));
      out.value = el.value;
    }
    if (tag === "a" && el.href) out.href = shortUrl(el.href);
    if (el.getAttribute("aria-checked")) out.checked = el.getAttribute("aria-checked");
    if (el.disabled) out.disabled = true;
    return out;
  }

  function accessibleName(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const parts = labelledby
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((n) => n.textContent.trim());
      if (parts.length) return parts.join(" ");
    }
    if (el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl) return lbl.textContent.trim();
    }
    const closestLabel = el.closest("label");
    if (closestLabel) return closestLabel.textContent.trim();
    const text = (el.textContent || "").trim().replace(/\s+/g, " ");
    if (text) return text;
    return (
      el.getAttribute("placeholder") ||
      el.getAttribute("title") ||
      el.getAttribute("alt") ||
      el.getAttribute("value") ||
      ""
    ).trim();
  }

  function pageSummary() {
    const meta = document.querySelector('meta[name="description"]');
    const desc = meta ? meta.getAttribute("content") : "";
    const h1 = document.querySelector("h1");
    return {
      headline: h1 ? h1.textContent.trim().slice(0, 200) : "",
      description: (desc || "").trim().slice(0, 300),
      excerpt: pageText().slice(0, 500),
    };
  }

  function pageText() {
    const root =
      document.querySelector("main") ||
      document.querySelector("article") ||
      document.querySelector("[role=main]") ||
      document.body;
    if (!root) return "";
    const text = (root.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
    return text.slice(0, MAX_TEXT);
  }

  // -------------------------------------------------------------------------
  // Acting
  // -------------------------------------------------------------------------

  function act(msg) {
    if (msg.action === "scroll") return scroll(msg);
    const el = refMap.get(msg.ref);
    if (!el) {
      return {
        ok: false,
        error: `No element with ref ${msg.ref}. Call read_page again — the page may have changed.`,
      };
    }
    if (!document.contains(el)) {
      return { ok: false, error: `Element ${msg.ref} is no longer on the page. Re-read the page.` };
    }
    try {
      el.scrollIntoView({ block: "center", inline: "center" });
    } catch {
      /* ignore */
    }
    switch (msg.action) {
      case "click":
        return click(el);
      case "type":
        return type(el, msg.text, msg.submit);
      case "select":
        return select(el, msg.value);
      default:
        return { ok: false, error: `Unknown action ${msg.action}` };
    }
  }

  function click(el) {
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new PointerEvent("pointerdown", opts));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    try {
      el.focus({ preventScroll: true });
    } catch {
      /* ignore */
    }
    el.dispatchEvent(new PointerEvent("pointerup", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
    // Fallback for elements whose handler only listens to .click().
    if (typeof el.click === "function") {
      try {
        el.click();
      } catch {
        /* ignore */
      }
    }
    return { ok: true, clicked: accessibleName(el).slice(0, 80) || el.tagName.toLowerCase() };
  }

  function type(el, text, submit) {
    const tag = el.tagName.toLowerCase();
    try {
      el.focus({ preventScroll: true });
    } catch {
      /* ignore */
    }
    if (el.isContentEditable) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
    } else if (tag === "input" || tag === "textarea") {
      setNativeValue(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      return { ok: false, error: `Element ${tag} is not typable.` };
    }
    if (submit) {
      const key = { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 };
      el.dispatchEvent(new KeyboardEvent("keydown", key));
      el.dispatchEvent(new KeyboardEvent("keyup", key));
      const form = el.form || el.closest("form");
      if (form) {
        try {
          if (typeof form.requestSubmit === "function") form.requestSubmit();
          else form.submit();
        } catch {
          /* ignore */
        }
      }
    }
    return { ok: true, typed: text.slice(0, 80), submitted: !!submit };
  }

  function select(el, value) {
    if (el.tagName.toLowerCase() !== "select") {
      return { ok: false, error: `Element ${el.tagName} is not a <select>.` };
    }
    const wanted = String(value).toLowerCase();
    let matched = null;
    for (const opt of el.options) {
      if (
        opt.value.toLowerCase() === wanted ||
        opt.textContent.trim().toLowerCase() === wanted ||
        opt.textContent.trim().toLowerCase().includes(wanted)
      ) {
        matched = opt;
        break;
      }
    }
    if (!matched) return { ok: false, error: `No option matching "${value}".` };
    el.value = matched.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, selected: matched.textContent.trim().slice(0, 60) };
  }

  function scroll(msg) {
    if (msg.ref) {
      const el = refMap.get(msg.ref);
      if (el && document.contains(el)) {
        el.scrollIntoView({ block: "center", behavior: "auto" });
        return { ok: true, scrolled_to_ref: msg.ref };
      }
    }
    const dir = msg.direction || "down";
    if (dir === "top") window.scrollTo({ top: 0 });
    else if (dir === "bottom") window.scrollTo({ top: document.body.scrollHeight });
    else if (dir === "up") window.scrollBy({ top: -Math.round(window.innerHeight * 0.8) });
    else window.scrollBy({ top: Math.round(window.innerHeight * 0.8) });
    return { ok: true, direction: dir, scrollY: Math.round(window.scrollY) };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function setNativeValue(el, value) {
    const proto = el.tagName.toLowerCase() === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(el, value);
    else el.value = value;
  }

  function isVisible(el) {
    if (el.disabled) return true; // still worth listing so the model knows it's there
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    // Off-screen far above/below is fine (scrollable), but zero-area hidden isn't.
    return true;
  }

  function shortUrl(href) {
    try {
      const u = new URL(href);
      return (u.pathname + u.search).slice(0, 80) || u.origin;
    } catch {
      return href.slice(0, 80);
    }
  }
})();
