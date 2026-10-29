// Pure functions taking the namespace so no `chrome.*` runs at import time. Chrome
// opens through `sidePanel`, which wants the tabId; Firefox through `sidebarAction`,
// whose open() takes no arguments and runs only inside a user gesture.

export function cdpSupported(ns) {
  return typeof ns?.debugger?.attach === "function" && typeof ns?.debugger?.sendCommand === "function";
}

// Exported so the options page and the suites read one string: rewording is one edit.
export const CDP_HINT = "Not available in this browser (no debugger API)";

export const JS_HINT = "Not available in this browser (no code execution)";

// A disabled toggle plus copy: a box the user can turn on would promise a tool that can never run.
export function toolToggle(available, hint) {
  if (available) return { disabled: false };
  return { disabled: true, hint };
}

// AMO's remote-code policy flags running model-generated code through `new Function`,
// so the tool is off in the Firefox build — a missing API is NOT the reason, Firefox
// runs `world: "MAIN"` scripting from 128. The Firefox marker is runtime.getBrowserInfo:
// a function in Firefox 158, undefined in Chromium 149.
export function jsToolSupported(ns) {
  return typeof ns?.runtime?.getBrowserInfo !== "function";
}

export function panelSupported(ns) {
  return typeof ns?.sidePanel?.open === "function" || typeof ns?.sidebarAction?.open === "function";
}

export async function openPanel(ns, tabId) {
  try {
    if (typeof ns?.sidePanel?.open === "function") {
      await ns.sidePanel.open({ tabId });
      return true;
    }
    // Firefox's sidebarAction.open() is the active tab: an extra argument is a runtime error.
    if (typeof ns?.sidebarAction?.open === "function") {
      await ns.sidebarAction.open();
      return true;
    }
    return undefined;
  } catch {
    return false;
  }
}

// Gesture-bound like open() and argument-free, so a refusal settles neutral. Chrome has
// no `sidebarAction` (measured 'undefined' on Chromium 149), so this is inert there.
export async function togglePanel(ns) {
  if (typeof ns?.sidebarAction?.toggle !== "function") return false;
  try {
    await ns.sidebarAction.toggle();
    return true;
  } catch {
    return false;
  }
}

// Chrome only: Firefox has no setPanelBehavior, and its icon click has its own listener.
export function setPanelBehaviorOnActionClick(ns) {
  if (typeof ns?.sidePanel?.setPanelBehavior !== "function") return false;
  try {
    const r = ns.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    // A rejected behavior call must not surface as an unhandled rejection at install.
    r?.catch?.(() => {});
    return true;
  } catch {
    return false;
  }
}
