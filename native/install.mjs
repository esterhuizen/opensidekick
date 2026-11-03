// Registers the bridge as Chrome's native messaging host for this user.
//   node native/install.mjs <extension-id>   (the id is on chrome://extensions)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const NAME = "com.opensidekick.bridge";
const id = process.argv[2];
if (!/^[a-p]{32}$/.test(id || "")) {
  console.error("usage: node native/install.mjs <extension-id>   (copy it from chrome://extensions)");
  process.exit(1);
}
const dir = path.dirname(fileURLToPath(import.meta.url));
const bridge = path.join(dir, "opensidekick-bridge.mjs");

// Chrome starts the host without the user's shell PATH, so the wrapper names
// this node binary by its full path.
const win = process.platform === "win32";
const exe = path.join(dir, win ? "opensidekick-bridge.bat" : "opensidekick-bridge.sh");
fs.writeFileSync(
  exe,
  win
    ? `@echo off\r\n"${process.execPath}" "${bridge}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${bridge}" "$@"\n`,
  { mode: 0o755 },
);

const manifest = JSON.stringify(
  {
    name: NAME,
    description: "OpenSidekick bridge for external agents",
    path: exe,
    type: "stdio",
    allowed_origins: [`chrome-extension://${id}/`],
  },
  null,
  2,
);

let where;
if (win) {
  where = path.join(dir, NAME + ".json");
  fs.writeFileSync(where, manifest);
  execFileSync("reg", ["add", `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NAME}`, "/ve", "/t", "REG_SZ", "/d", where, "/f"]);
} else {
  // ponytail: Google Chrome only; Chromium, Brave and Edge read their own folders.
  const base =
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library/Application Support/Google/Chrome/NativeMessagingHosts")
      : path.join(os.homedir(), ".config/google-chrome/NativeMessagingHosts");
  fs.mkdirSync(base, { recursive: true });
  where = path.join(base, NAME + ".json");
  fs.writeFileSync(where, manifest);
}

console.log(`Installed ${NAME} (${where}).

Next:
  1. OpenSidekick Settings: turn on "Let local agents use this browser". Keep the side panel open to approve actions.
  2. Add the MCP server to your agent, e.g.
     claude mcp add opensidekick -- node "${bridge}" --mcp`);
