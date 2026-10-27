// Chrome DevTools Protocol integration via chrome.debugger.
//
// Powers developer tools and opt-in native pointer input. Attaching shows
// Chrome's "started debugging this browser" banner, so this is only used when
// the user turns on Advanced automation, and we detach at the end of each task.
//
// Buffers capture activity that happens AFTER attach — to see load-time errors,
// the agent can read once (attaching), reload, then read again.

const attached = new Map(); // tabId -> { console: [], network: Map(requestId -> rec) }
let listenerBound = false;

const MAX_CONSOLE = 500;
const MAX_NETWORK = 500;

export async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  bindListeners();
  await debuggerAttach(tabId);
  attached.set(tabId, { console: [], network: new Map() });
  // Enable the domains we read from. Some may fail on restricted pages — ignore.
  await sendCommand(tabId, "Runtime.enable").catch(() => {});
  await sendCommand(tabId, "Log.enable").catch(() => {});
  await sendCommand(tabId, "Network.enable").catch(() => {});
}

export async function readConsole(tabId, opts = {}) {
  const { onlyErrors = false, limit = 50 } = opts;
  await ensureAttached(tabId);
  let items = attached.get(tabId).console;
  if (onlyErrors) items = items.filter((i) => /error|warning/i.test(i.level || ""));
  return {
    ok: true,
    monitoring: true,
    messages: items.slice(-limit),
    note: items.length
      ? undefined
      : "No console messages captured yet. Console/network monitoring starts when you first read; reload the page (navigate) and read again to catch load-time messages.",
  };
}

export async function readNetwork(tabId, opts = {}) {
  const { urlPattern, limit = 50 } = opts;
  await ensureAttached(tabId);
  let items = [...attached.get(tabId).network.values()];
  if (urlPattern) {
    let re;
    try {
      re = new RegExp(urlPattern, "i");
    } catch {
      re = null;
    }
    if (re) items = items.filter((i) => re.test(i.url));
  }
  return {
    ok: true,
    monitoring: true,
    requests: items.slice(-limit),
    note: items.length ? undefined : "No network requests captured yet — reload the page and read again.",
  };
}

// Browser-level events go through Chromium hit testing, including OOPIFs.
// Points are CSS pixels in the top-level tab viewport.
export async function dispatchMouseAction(tabId, action, point, destination = null) {
  const checked = (p) => {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new Error("Invalid pointer coordinates.");
    return { x: p.x, y: p.y };
  };
  const p = checked(point);
  await ensureAttached(tabId);
  const send = (type, x, y, button = "none", buttons = 0, clickCount = 0) =>
    sendCommand(tabId, "Input.dispatchMouseEvent", { type, x, y, button, buttons, clickCount });
  await send("mouseMoved", p.x, p.y);
  if (action === "hover") return { ok: true, trusted_input: true };
  if (action === "drag") {
    const q = checked(destination);
    await send("mousePressed", p.x, p.y, "left", 1, 1);
    for (let i = 1; i <= 8; i++) {
      const t = i / 8;
      await send("mouseMoved", p.x + (q.x - p.x) * t, p.y + (q.y - p.y) * t, "none", 1);
    }
    await send("mouseReleased", q.x, q.y, "left", 0, 1);
    return { ok: true, trusted_input: true };
  }
  if (!["click", "dblclick", "contextmenu"].includes(action)) throw new Error("Unsupported pointer action: " + action);
  const button = action === "contextmenu" ? "right" : "left";
  const buttons = button === "right" ? 2 : 1;
  const count = action === "dblclick" ? 2 : 1;
  for (let i = 1; i <= count; i++) {
    await send("mousePressed", p.x, p.y, button, buttons, i);
    await send("mouseReleased", p.x, p.y, button, 0, i);
  }
  return { ok: true, trusted_input: true };
}

// Real held-button drag across the viewport. This works through iframe hit
// testing, even when the drop target isn't a DOM-interactive element.
export async function dispatchDragAt(tabId, start, end, durationMs = 650) {
  const valid = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y);
  if (!valid(start) || !valid(end)) throw new Error("Invalid drag coordinates.");
  const duration = Math.min(2500, Math.max(250, Number(durationMs) || 650));
  const steps = Math.max(16, Math.min(60, Math.ceil(duration / 24)));
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await ensureAttached(tabId);
  const send = (type, x, y, button, buttons) =>
    sendCommand(tabId, "Input.dispatchMouseEvent", { type, x, y, button, buttons });
  let held = false;
  let position = { x: start.x, y: start.y };
  try {
    await send("mouseMoved", start.x, start.y, "none", 0);
    await send("mousePressed", start.x, start.y, "left", 1);
    held = true;
    await delay(75);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      position = { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t };
      await send("mouseMoved", position.x, position.y, "left", 1);
      await delay(duration / steps);
    }
    await delay(80); // give the widget a frame to recognize the drop hover
    await send("mouseReleased", end.x, end.y, "left", 0);
    held = false;
    return { ok: true, trusted_input: true, steps };
  } finally {
    if (held) await send("mouseReleased", position.x, position.y, "left", 0).catch(() => {});
  }
}

// Capture the requested tab, including when another tab is active. Unlike
// captureVisibleTab this does not accidentally screenshot the user's foreground tab.
export async function captureTabScreenshot(tabId) {
  await ensureAttached(tabId);
  return await sendCommand(tabId, "Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true });
}

// Called at the end of every task so the debugger banner goes away.
export async function detachAll() {
  for (const tabId of [...attached.keys()]) {
    await debuggerDetach(tabId);
    attached.delete(tabId);
  }
}

// -------------------------------------------------------------------------

function bindListeners() {
  if (listenerBound) return;
  chrome.debugger.onEvent.addListener(onEvent);
  chrome.debugger.onDetach.addListener((source) => attached.delete(source.tabId));
  listenerBound = true;
}

function onEvent(source, method, params) {
  const buf = attached.get(source.tabId);
  if (!buf) return;
  switch (method) {
    case "Runtime.consoleAPICalled": {
      const text = (params.args || []).map(remoteToText).join(" ");
      pushConsole(buf, { level: params.type, text: clip(text) });
      break;
    }
    case "Runtime.exceptionThrown": {
      const d = params.exceptionDetails || {};
      const text = (d.exception && (d.exception.description || d.exception.value)) || d.text || "Uncaught exception";
      pushConsole(buf, { level: "error", text: clip(text) });
      break;
    }
    case "Log.entryAdded": {
      const e = params.entry || {};
      pushConsole(buf, { level: e.level, text: clip(e.text), source: e.source, url: e.url && clip(e.url, 200) });
      break;
    }
    case "Network.requestWillBeSent": {
      const r = params.request || {};
      buf.network.set(params.requestId, { method: r.method, url: clip(r.url, 300), status: null });
      trim(buf.network, MAX_NETWORK);
      break;
    }
    case "Network.responseReceived": {
      const rec = buf.network.get(params.requestId);
      if (rec && params.response) {
        rec.status = params.response.status;
        rec.mimeType = params.response.mimeType;
      }
      break;
    }
    case "Network.loadingFailed": {
      const rec = buf.network.get(params.requestId);
      if (rec) {
        rec.status = "failed";
        rec.error = params.errorText;
      }
      break;
    }
  }
}

function pushConsole(buf, entry) {
  buf.console.push(entry);
  if (buf.console.length > MAX_CONSOLE) buf.console.splice(0, buf.console.length - MAX_CONSOLE);
}

function trim(map, max) {
  while (map.size > max) map.delete(map.keys().next().value);
}

function remoteToText(o) {
  if (!o) return "";
  if ("value" in o) return typeof o.value === "object" ? JSON.stringify(o.value) : String(o.value);
  return o.description || o.type || "";
}

function clip(s, n = 500) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function debuggerAttach(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

function debuggerDetach(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      void chrome.runtime.lastError; // ignore "not attached"
      resolve();
    });
  });
}

function sendCommand(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(result);
    });
  });
}
