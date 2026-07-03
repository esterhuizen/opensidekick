// Chrome DevTools Protocol integration via chrome.debugger.
//
// Powers the debugging tools (read_console / read_network). Attaching shows
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
