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
          sendResponse(readPage(msg.query));
          return true;
        case "cs_get_text":
          sendResponse({ ok: true, url: location.href, title: document.title, text: pageText() });
          return true;
        case "cs_act":
          sendResponse(act(msg));
          return true;
        case "cs_overlay":
          sendResponse(overlay(msg));
          return true;
        case "cs_record":
          setRecording(!!msg.on);
          sendResponse({ ok: true });
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

  // With a query, only the best-matching elements come back (word overlap on
  // name/placeholder/href), so big pages don't flood a small model's context.
  // ponytail: plain keyword match, no synonyms; add a model rerank if it misses.
  // Labels of a form's buttons, computed once per form per read.
  let formLabelCache = new WeakMap();
  function formButtonLabels(form) {
    if (formLabelCache.has(form)) return formLabelCache.get(form);
    const names = [];
    for (const c of Array.from(form.elements || [])) {
      const t = c.tagName ? c.tagName.toLowerCase() : "";
      if (t === "button" || (t === "input" && /^(submit|image|button)$/i.test(c.type))) {
        const n = accessibleName(c);
        if (n && !names.includes(n)) names.push(n.slice(0, 60));
        if (names.length >= 4) break;
      }
    }
    const out = names.join(" / ");
    formLabelCache.set(form, out);
    return out;
  }

  function readPage(query) {
    formLabelCache = new WeakMap();
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
      "[role=combobox]",
      "[contenteditable=true]",
      "[contenteditable='']",
      "summary",
      "label[for]",
    ].join(",");

    const nodes = document.querySelectorAll(selector);
    if (query) return findResult(query, nodes);
    for (const el of nodes) {
      if (elements.length >= MAX_ELEMENTS) break;
      // Never expose OpenSidekick's own on-page overlay to the model.
      if (el.closest("#opensidekick-overlay")) continue;
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

  // Only the returned elements get refs: a ref the model never saw must not be
  // clickable, or its label (and the Buy/Pay/Delete check) would be unknown.
  const QUERY_SCAN_MAX = 3000;
  const QUERY_RESULTS = 20;
  function findResult(query, nodes) {
    const words = [...new Set(String(query).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1))];
    const scored = [];
    let scanned = 0;
    for (const el of nodes) {
      if (scanned >= QUERY_SCAN_MAX) break;
      if (el.closest("#opensidekick-overlay")) continue;
      if (!isVisible(el)) continue;
      scanned++;
      const e = describe(0, el);
      const hay = [e.name, e.placeholder, e.href, e.role, e.tag, e.type].join(" ").toLowerCase();
      const score = words.filter((w) => hay.includes(w)).length;
      if (score > 0) scored.push({ el, score, order: scanned });
    }
    scored.sort((x, y) => y.score - x.score || x.order - y.order);
    const elements = scored.slice(0, QUERY_RESULTS).map(({ el }) => {
      const ref = ++refCounter;
      refMap.set(ref, el);
      return describe(ref, el);
    });
    return {
      ok: true,
      url: location.href,
      title: document.title,
      summary: pageSummary(),
      elements,
      note: elements.length ? undefined : "No element matched; call read_page without a query.",
    };
  }

  function describe(ref, el) {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role") || undefined;
    const type = el.getAttribute("type") || undefined;
    const out = { ref, tag };
    if (role) out.role = role;
    if (type) out.type = type;
    const customCombobox = role === "combobox" && tag !== "input" && tag !== "select" && tag !== "textarea";
    const name = accessibleName(el, customCombobox ? comboboxText : undefined);
    if (name) out.name = name.slice(0, 160);
    if (tag === "input" || tag === "textarea") {
      // A password or card number never leaves the page, only whether it's filled.
      const secretField = isSecretField(el);
      if (secretField) out.secret = true;
      out.value = secretField ? (el.value ? "(filled)" : "") : (el.value || "").slice(0, 120);
      if (el.placeholder) out.placeholder = el.placeholder.slice(0, 80);
    }
    if (tag === "select") {
      out.options = Array.from(el.options)
        .slice(0, 30)
        .map((o) => o.textContent.trim().slice(0, 60));
      out.value = el.value;
    }
    if (customCombobox) {
      const shown = comboboxText(el);
      if (shown && shown !== out.name) out.value = shown.slice(0, 120);
    }
    if (tag === "a" && el.href) out.href = shortUrl(el.href);
    if (el.getAttribute("aria-checked")) out.checked = el.getAttribute("aria-checked");
    if (el.disabled) out.disabled = true;
    // Pressing Enter or submitting from this field sends its form: name the
    // form's buttons (submit, plain and form= ones outside it), so a form with
    // a "Place order" button asks whichever button the page wires up.
    // The same form type() would submit: its own, else the one around it.
    const formOf = el.form || el.closest("form");
    if (formOf && (tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable) && !/^(submit|image|button|reset)$/i.test(el.type || "")) {
      const fs = formButtonLabels(formOf);
      if (fs) out.formSubmit = fs;
    }
    // Clicking it submits a form, whatever its label says.
    if (el.form && ((tag === "button" && el.type === "submit") || (tag === "input" && (el.type === "submit" || el.type === "image")))) out.submits = true;
    return out;
  }

  // A custom combobox usually keeps its popup list inside itself. The options
  // are listed as elements of their own, so leave them out of the box's text:
  // otherwise its name or value reads "English EnglishDeutschFrançais…".
  function comboboxText(el) {
    let text = "";
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const popup = node.parentElement.closest("[role=listbox],[role=option]");
      if (popup && popup !== el && el.contains(popup)) continue;
      text += node.data;
    }
    return text.trim().replace(/\s+/g, " ");
  }

  function accessibleName(el, textOf = (node) => node.textContent) {
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
    const text = (textOf(el) || "").trim().replace(/\s+/g, " ");
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
    // The caller approved an action on the element it saw: refuse if this ref
    // now names something else (another reader re-numbered the page, or it changed).
    const now = msg.expect != null || msg.expectSubmits != null ? describe(0, el) : null;
    if ((msg.expect != null && (now.name || "") !== msg.expect) || (msg.expectSubmits != null && !!now.submits !== msg.expectSubmits)) {
      return { ok: false, error: `Element ${msg.ref} has changed since you read the page. Call read_page again.` };
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
        if (isSecretField(el) && msg.secretOk !== true) {
          return { ok: false, error: "This is a password, card or one-time-code field. You may only type a value the user gave you in this chat. Ask the user to fill it in themselves. Don't try to fill this field any other way." };
        }
        if (isSecretField(el) && msg.secretConfirmed !== true) {
          return { ok: false, error: "This is a password, card or one-time-code field and the user must approve the fill. Call read_page again, then retry." };
        }
        return type(el, msg.text, msg.submit);
      case "select":
        return select(el, msg.value);
      case "hover":
        return hover(el);
      case "dblclick":
        return dblclick(el);
      case "contextmenu":
        return contextmenu(el);
      case "drag":
        return drag(el, refMap.get(msg.toRef));
      case "keys":
        return pressKeys(el, msg.keys);
      case "upload":
        return upload(el, msg.name, msg.content, msg.mime);
      default:
        return { ok: false, error: `Unknown action ${msg.action}` };
    }
  }

  function hover(el) {
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new PointerEvent("pointerover", opts));
    el.dispatchEvent(new MouseEvent("mouseover", opts));
    el.dispatchEvent(new MouseEvent("mouseenter", { ...opts, bubbles: false }));
    el.dispatchEvent(new MouseEvent("mousemove", opts));
    return { ok: true, hovered: accessibleName(el).slice(0, 80) || el.tagName.toLowerCase() };
  }

  function dblclick(el) {
    click(el);
    click(el);
    el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, view: window }));
    return { ok: true, doubleClicked: accessibleName(el).slice(0, 80) || el.tagName.toLowerCase() };
  }

  function contextmenu(el) {
    const opts = { bubbles: true, cancelable: true, view: window, button: 2 };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...opts, button: 2 }));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new MouseEvent("contextmenu", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    return { ok: true, rightClicked: accessibleName(el).slice(0, 80) || el.tagName.toLowerCase() };
  }

  function drag(source, target) {
    if (!target || !document.contains(target)) {
      return { ok: false, error: "Drop target ref not found. Re-read the page." };
    }
    const rect = (n) => n.getBoundingClientRect();
    const center = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    const a = center(rect(source));
    const b = center(rect(target));
    const pt = (x, y) => ({ bubbles: true, cancelable: true, view: window, clientX: x, clientY: y });
    source.dispatchEvent(new PointerEvent("pointerdown", pt(a.x, a.y)));
    source.dispatchEvent(new MouseEvent("mousedown", pt(a.x, a.y)));
    // Pointer-based drag (works for most modern DnD libraries).
    target.dispatchEvent(new PointerEvent("pointermove", pt(b.x, b.y)));
    target.dispatchEvent(new MouseEvent("mousemove", pt(b.x, b.y)));
    target.dispatchEvent(new PointerEvent("pointerup", pt(b.x, b.y)));
    target.dispatchEvent(new MouseEvent("mouseup", pt(b.x, b.y)));
    // Best-effort native HTML5 drag events.
    try {
      const dt = new DataTransfer();
      source.dispatchEvent(new DragEvent("dragstart", { ...pt(a.x, a.y), dataTransfer: dt }));
      target.dispatchEvent(new DragEvent("dragover", { ...pt(b.x, b.y), dataTransfer: dt }));
      target.dispatchEvent(new DragEvent("drop", { ...pt(b.x, b.y), dataTransfer: dt }));
      source.dispatchEvent(new DragEvent("dragend", { ...pt(b.x, b.y), dataTransfer: dt }));
    } catch {
      /* DataTransfer/DragEvent may be unavailable; pointer path already fired */
    }
    return { ok: true, dragged: true };
  }

  // Content comes from the model, never from the user's disk, so a page that
  // talks the agent into "uploading" can't reach local files this way.
  function upload(el, name, content, mime) {
    // A styled upload button is often a <label for> over a hidden file input.
    if (el instanceof HTMLLabelElement && el.control) el = el.control;
    if (!(el instanceof HTMLInputElement) || el.type !== "file") {
      return { ok: false, error: "That element is not a file input." };
    }
    const dt = new DataTransfer();
    dt.items.add(new File([content || ""], name || "file.txt", { type: mime || "text/plain" }));
    el.files = dt.files;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, uploaded: el.files[0].name };
  }

  function pressKeys(el, keys) {
    if (!Array.isArray(keys) || !keys.length) return { ok: false, error: "No keys provided." };
    const target = el && document.contains(el) ? el : document.activeElement || document.body;
    const mods = keys.slice(0, -1).map((k) => k.toLowerCase());
    const key = keys[keys.length - 1];
    const init = {
      bubbles: true,
      cancelable: true,
      key,
      code: key.length === 1 ? "Key" + key.toUpperCase() : key,
      ctrlKey: mods.includes("control") || mods.includes("ctrl"),
      shiftKey: mods.includes("shift"),
      altKey: mods.includes("alt"),
      metaKey: mods.includes("meta") || mods.includes("cmd") || mods.includes("command"),
    };
    try {
      target.focus({ preventScroll: true });
    } catch {
      /* ignore */
    }
    target.dispatchEvent(new KeyboardEvent("keydown", init));
    target.dispatchEvent(new KeyboardEvent("keyup", init));
    return { ok: true, pressed: keys.join("+") };
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
    // Exactly one click. el.click() fires the click event and runs the element's
    // default action (toggle a checkbox, follow a link, submit a form); sending a
    // click event as well made toggles flip twice and _blank links open twice.
    // Elements without .click() (e.g. SVG) get a plain click event.
    if (typeof el.click === "function") {
      try {
        el.click();
      } catch {
        /* ignore */
      }
    } else {
      el.dispatchEvent(new MouseEvent("click", opts));
    }
    return { ok: true, clicked: accessibleName(el).slice(0, 80) || el.tagName.toLowerCase() };
  }

  // Password, card and one-time-code fields: their value never leaves the
  // page, and the agent may only type into them what the user gave it. A field
  // stays secret once seen, so a "show password" toggle (type=password → text)
  // doesn't turn it into a plain field.
  const everSecret = new WeakSet();
  // Names and short labels that mark a password, card or code field. Strong
  // words (password, PIN, CVV, card number) always count; weak ones (codes,
  // expiry) don't when the label is about a coupon, a reset or a search. A
  // label that warns ("never share your password") only counts when it starts
  // with the hint ("Verification code (don't share it)").
  const STRONG_HINT_RE = /pass(word|wort|code)|passwd|\bpwd\b|kennwort|mot de passe|contrase(n|ñ)a|\bpin\b(?!\s*(code|name))|\bcvv2?\b|\bcvc2?\b|\bcsc\b|card.?number|card.?no\b|cc.?num|credit.?card|security answer/i;
  const WEAK_HINT_RE = /\botp\b|\botc\b|\b2fa\b|two.?factor|authenticator|(recovery|backup) code|one.?time.?(pass)?(code|word)|verification code|security code|\b(enter|user|device|sms|auth|authentication|login|confirmation|totp)\s+code\b|\btotp\b|\d.?digit code|expir(y|ation)/i;
  const CONTEXT_RE = /\b(forgot(ten)?|reset|search|drop|coupon|promo|voucher|discount|gift|referral)\b/i;
  const NEGATION_RE = /\b(never|don'?t|do not)\b/i;
  const hintIn = (t) => STRONG_HINT_RE.test(t) || (WEAK_HINT_RE.test(t) && !CONTEXT_RE.test(t));
  // A label's own words, without links or buttons inside it ("Forgot password?").
  function labelWords(label) {
    if (!label) return "";
    try {
      const c = label.cloneNode(true);
      for (const x of c.querySelectorAll("input,select,textarea")) x.remove();
      for (const x of c.querySelectorAll("a,button")) if (CONTEXT_RE.test(x.textContent || "")) x.remove();
      return c.textContent || "";
    } catch {
      return label.textContent || "";
    }
  }
  function isSecretField(el) {
    const tag = el && el.tagName ? el.tagName.toLowerCase() : "";
    if (tag !== "input" && tag !== "textarea") return false;
    if (everSecret.has(el)) return true;
    const auto = (el.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/);
    let masked = false;
    try {
      const ts = getComputedStyle(el).getPropertyValue("-webkit-text-security");
      masked = !!ts && ts !== "none";
    } catch {
      /* ignore */
    }
    // name/id on every field, raw and split into words (PassWord, user_pwd).
    const ids = [el.name, el.id].map((t) => String(t || ""));
    const split = ids.map((t) => t.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_\-$.[\]]+/g, " "));
    let named = [...ids, ...split].some((t) => t && (STRONG_HINT_RE.test(t) || WEAK_HINT_RE.test(t)));
    // Free-text labels on single-line inputs that aren't search, email or url.
    if (!named && tag === "input" && !/^(search|email|url)$/i.test(el.type)) {
      const free = [el.placeholder, el.getAttribute("aria-label"), el.labels && el.labels[0] ? labelWords(el.labels[0]) : ""]
        .map((t) => String(t || "").replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " ").trim())
        .filter((t) => t && t.length <= 60);
      named = free.some((t) => {
        if (!hintIn(t)) return false;
        if (!NEGATION_RE.test(t)) return true;
        const lead = t.split(/[(:,–—]|\s-\s/)[0];
        return hintIn(lead);
      });
    }
    const secret = (tag === "input" && el.type === "password") || masked || named || auto.some((t) => /^(cc-(number|csc|exp|exp-month|exp-year)|one-time-code|current-password|new-password)$/.test(t));
    if (secret) everSecret.add(el);
    return secret;
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
      const handled = !el.dispatchEvent(new KeyboardEvent("keydown", key));
      el.dispatchEvent(new KeyboardEvent("keyup", key));
      const form = el.form || el.closest("form");
      // A page that handled Enter itself has submitted already; otherwise
      // submit like Enter does, through the form's default button.
      if (form && !handled) {
        const dflt = Array.from(form.elements || []).find((c) => c.type === "submit" || c.type === "image") || null;
        try {
          if (typeof form.requestSubmit === "function") form.requestSubmit(dflt && dflt.form === form ? dflt : undefined);
          else form.submit();
        } catch {
          /* ignore */
        }
      }
    }
    return { ok: true, typed: isSecretField(el) ? "(hidden)" : text.slice(0, 80), submitted: !!submit };
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
  // Workflow recording — capture user actions as human-readable steps
  // -------------------------------------------------------------------------
  let recording = false;

  function setRecording(on) {
    if (on === recording) return;
    recording = on;
    const m = on ? "addEventListener" : "removeEventListener";
    document[m]("click", onRecClick, true);
    document[m]("change", onRecChange, true);
    document[m]("keydown", onRecKey, true);
  }

  function sendStep(step) {
    try {
      chrome.runtime.sendMessage({ type: "cs_step", step });
    } catch {
      /* ignore */
    }
  }

  function onRecClick(e) {
    const el = findInteractive(e.target);
    if (!el || el.closest("#opensidekick-overlay")) return;
    const tag = el.tagName.toLowerCase();
    // Clicking a text field just focuses it — the typing step already covers it.
    if (tag === "textarea" || (tag === "input" && /^(text|search|email|password|url|tel|number|)$/i.test(el.getAttribute("type") || ""))) return;
    const name = accessibleName(el).slice(0, 60);
    const kind = tag === "a" ? "link" : tag === "button" || el.getAttribute("role") === "button" ? "button" : "element";
    sendStep({ action: "click", description: `Click the ${name ? `"${name}" ` : ""}${kind}` });
  }

  function onRecChange(e) {
    const el = e.target;
    const tag = el.tagName && el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") {
      if (isSecretField(el)) {
        sendStep({ action: "type", description: `Fill in the ${fieldName(el)} field yourself (a secret value is not recorded)` });
        return;
      }
      const val = (el.value || "").slice(0, 80);
      if (val) sendStep({ action: "type", description: `Type "${val}" into the ${fieldName(el)} field` });
    } else if (tag === "select") {
      const opt = el.options[el.selectedIndex];
      const label = opt ? opt.textContent.trim().slice(0, 40) : el.value;
      sendStep({ action: "select", description: `Choose "${label}" in the ${fieldName(el)} dropdown` });
    }
  }

  function onRecKey(e) {
    if (e.key !== "Enter") return;
    const tag = e.target.tagName && e.target.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") sendStep({ action: "key", description: "Press Enter to submit" });
  }

  function findInteractive(node) {
    let el = node;
    while (el && el !== document.documentElement) {
      const tag = el.tagName && el.tagName.toLowerCase();
      const role = el.getAttribute && el.getAttribute("role");
      if (["a", "button", "input", "select", "textarea", "summary"].includes(tag) || role === "button" || role === "link" || (el.hasAttribute && el.hasAttribute("onclick"))) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  function fieldName(el) {
    const n = accessibleName(el);
    if (n) return `"${n.slice(0, 40)}"`;
    return el.getAttribute("name") || el.getAttribute("type") || "input";
  }

  // -------------------------------------------------------------------------
  // Activity overlay (so the user always sees when the agent is acting)
  // -------------------------------------------------------------------------

  // One place for every value the overlay paints, because this sits on the
  // user's own page and shows up in every demo GIF — it is the most publicly
  // visible surface the extension owns. It mirrors ../common/ui.css (which a
  // content script can't link): accent #4f46e5 for the ring, the dark surface
  // #1c1c1a and ink #ededec for the pill in both themes, the dark accent
  // #8b7dff for its dot. Inline styles only — the host page's CSP may reject
  // an injected <style>, and the pulse runs through the Web Animations API for
  // the same reason.
  const OVERLAY_CSS = {
    // A 2px ring reads as "active", not as the error state a 3px red-adjacent
    // glow used to.
    ring:
      "position:fixed;inset:0;pointer-events:none;z-index:2147483647;" +
      "box-shadow:inset 0 0 0 2px rgba(79,70,229,.85), inset 0 0 28px 8px rgba(79,70,229,.2);",
    pill:
      "position:fixed;top:10px;left:50%;transform:translateX(-50%);pointer-events:auto;" +
      "display:flex;align-items:center;gap:8px;max-width:min(560px,86vw);" +
      "background:#1c1c1a;color:#ededec;border:1px solid rgba(255,255,255,.12);" +
      "padding:4px 4px 4px 12px;border-radius:999px;" +
      "box-shadow:0 10px 30px -12px rgba(0,0,0,.65);",
    dot: "width:6px;height:6px;border-radius:50%;background:#8b7dff;flex:0 0 auto;",
    label:
      'font:600 12px/16px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;' +
      "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
    // Ghost, not solid red: Stop is the way out of a normal run, not an alarm.
    stop:
      "pointer-events:auto;background:transparent;color:#ededec;cursor:pointer;" +
      "min-height:28px;border:1px solid rgba(255,255,255,.32);border-radius:999px;padding:0 12px;" +
      'font:600 12px/16px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;',
  };

  function overlay(msg) {
    const ID = "opensidekick-overlay";
    let el = document.getElementById(ID);
    if (msg.state === "hide") {
      if (el) el.remove();
      return { ok: true };
    }
    // Persistent marker (survives hide) so tools can confirm the overlay fired.
    document.documentElement.setAttribute("data-opensidekick-shown", "1");
    if (!el) {
      el = document.createElement("div");
      el.id = ID;
      // Glow border; never intercepts page interaction.
      el.style.cssText = OVERLAY_CSS.ring;
      const pill = document.createElement("div");
      pill.style.cssText = OVERLAY_CSS.pill;
      const dot = document.createElement("span");
      dot.style.cssText = OVERLAY_CSS.dot;
      pulse(dot);
      const label = document.createElement("span");
      label.id = ID + "-label";
      label.style.cssText = OVERLAY_CSS.label;
      const stop = document.createElement("button");
      stop.textContent = "Stop";
      stop.style.cssText = OVERLAY_CSS.stop;
      stop.addEventListener("click", () => {
        try {
          chrome.runtime.sendMessage({ type: "stop_task" });
        } catch (e) {
          /* ignore */
        }
      });
      pill.append(dot, label, stop);
      el.appendChild(pill);
      document.documentElement.appendChild(el);
    }
    const label = document.getElementById(ID + "-label");
    if (label) label.textContent = msg.label || "OpenSidekick is working…";
    return { ok: true };
  }

  function pulse(node) {
    try {
      if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      node.animate([{ opacity: 1 }, { opacity: 0.3 }, { opacity: 1 }], {
        duration: 1400,
        iterations: Infinity,
      });
    } catch (e) {
      /* no Web Animations — a static dot is fine */
    }
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
