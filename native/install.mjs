// Registers the bridge as Chrome's native messaging host for this user.
//   node native/install.mjs <extension-id>   (the id is on chrome://extensions)
//   node native/install.mjs --uninstall
// The bridge is copied into a private per-user folder, so a later `git pull`
// in this checkout doesn't change the code Chrome launches; run this again to update.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { STATE_DIR, ensureStateDir } from "./opensidekick-bridge.mjs";

const NAME = "com.opensidekick.bridge";
const win = process.platform === "win32";
const REG_KEY = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NAME}`;
const manifestDir = win
  ? STATE_DIR
  : process.platform === "darwin"
    ? path.join(os.homedir(), "Library/Application Support/Google/Chrome/NativeMessagingHosts")
    : path.join(os.homedir(), ".config/google-chrome/NativeMessagingHosts");
const manifestPath = path.join(manifestDir, NAME + ".json");
const bridge = path.join(STATE_DIR, "opensidekick-bridge.mjs");
const exe = path.join(STATE_DIR, win ? "opensidekick-bridge.bat" : "opensidekick-bridge.sh");

if (process.argv[2] === "--uninstall") {
  if (win) {
    try {
      execFileSync("reg", ["delete", REG_KEY, "/f"], { stdio: "ignore" });
    } catch {
      /* not registered */
    }
  }
  for (const f of [manifestPath, exe, bridge, path.join(STATE_DIR, "bridge.json")]) fs.rmSync(f, { force: true });
  console.log(`Removed ${NAME}.`);
  process.exit(0);
}

const id = process.argv[2];
if (!/^[a-p]{32}$/.test(id || "")) {
  console.error("usage: node native/install.mjs <extension-id>   (copy it from chrome://extensions)\n       node native/install.mjs --uninstall");
  process.exit(1);
}

// The wrapper quotes these paths for sh / cmd; refuse what quoting can't carry.
for (const p of [process.execPath, STATE_DIR]) {
  if (/["$`%!\r\n]/.test(p) || (!win && p.includes("\\"))) {
    console.error(`Can't install: the path ${JSON.stringify(p)} has characters the launcher can't quote.`);
    process.exit(1);
  }
}

ensureStateDir();
fs.copyFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "opensidekick-bridge.mjs"), bridge);
fs.chmodSync(bridge, 0o600);
// Chrome starts the host without the user's shell PATH, so the wrapper names
// this node binary by its full path.
fs.writeFileSync(
  exe,
  win ? `@echo off\r\n"${process.execPath}" "${bridge}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${bridge}" "$@"\n`,
  { mode: 0o700 },
);
fs.chmodSync(exe, 0o700);

const manifest = JSON.stringify(
  {
    name: NAME,
    description: "OpenSidekick bridge for local agents",
    path: exe,
    type: "stdio",
    allowed_origins: [`chrome-extension://${id}/`],
  },
  null,
  2,
);
fs.mkdirSync(manifestDir, { recursive: true });
fs.writeFileSync(manifestPath, manifest);
if (win) execFileSync("reg", ["add", REG_KEY, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"]);

console.log(`Installed ${NAME} (${manifestPath}).

Next:
  1. OpenSidekick Settings: turn on "Let local agents use this browser". Keep the side panel open to approve.
  2. Add the MCP server to your agent, e.g.
     claude mcp add opensidekick -- node "${bridge}" --mcp
  Google Chrome only for now. Remove with: node native/install.mjs --uninstall`);
