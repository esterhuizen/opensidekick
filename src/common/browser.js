// The place where Chrome and Firefox diverge on opening the side panel, kept as
// pure functions that take the namespace as a parameter, so no `chrome.*` runs
// at import time and `node test/browser.test.mjs` can load this module under
// plain node.
//
// Chrome opens the panel through `sidePanel`, which wants the tabId. Firefox
// opens it through `sidebarAction`, whose `open()` takes no arguments and runs
// only inside a user gesture, so a refusal must come back as a settled promise,
// not a throw — the caller's try/catch alone would leave a rejected promise.

export function cdpSupported(ns) {
  return typeof ns?.debugger?.attach === "function" && typeof ns?.debugger?.sendCommand === "function";
}

// The hint is product copy with the exact wording, naming neither browser. It is
// exported so the options page, `test/browser.test.mjs`, and `test/copy.test.mjs`
// read one string: rewording it is a single edit with no copy to keep in sync.
export const CDP_HINT = "Not available in this browser (no debugger API)";

// The options row for the debugger-backed tools: a browser with no debugger gets a
// disabled toggle plus copy saying why, because a box the user can turn on would
// promise a tool that can never run. The decision comes back as data, so the
// options page applies it and `test/browser.test.mjs` can read it.
export function cdpToggle(available) {
  if (available) return { disabled: false };
  return { disabled: true, hint: CDP_HINT };
}

export function panelSupported(ns) {
  return typeof ns?.sidePanel?.open === "function" || typeof ns?.sidebarAction?.open === "function";
}

// Resolves true when the panel opened, false when the browser refused (no
// gesture, no tab), undefined when this browser has no panel API at all.
export async function openPanel(ns, tabId) {
  try {
    if (typeof ns?.sidePanel?.open === "function") {
      await ns.sidePanel.open({ tabId });
      return true;
    }
    // No tabId here: Firefox's sidebarAction.open() is the active tab, and an
    // extra argument in that signature is a runtime error, not a silent no-op.
    if (typeof ns?.sidebarAction?.open === "function") {
      await ns.sidebarAction.open();
      return true;
    }
    return undefined;
  } catch {
    return false;
  }
}

// The icon click opens the panel in Chrome only; Firefox has no
// setPanelBehavior, and its icon click is handled by its own listener.
export function setPanelBehaviorOnActionClick(ns) {
  if (typeof ns?.sidePanel?.setPanelBehavior !== "function") return false;
  try {
    const r = ns.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    // Fire-and-forget: a rejected behavior call must not surface as an
    // unhandled rejection at install time.
    r?.catch?.(() => {});
    return true;
  } catch {
    return false;
  }
}
