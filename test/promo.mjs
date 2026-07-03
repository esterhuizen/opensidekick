// Generates Chrome Web Store promotional tiles, branded to match the
// screenshots (same indigo gradient + logo mark). Output is 24-bit PNG with no
// alpha channel, which is what the store requires.
//
//   Small promo tile : 440x280   (assets/promo/small-tile.png)
//   Marquee tile     : 1400x560  (assets/promo/marquee.png)
//
// Run (headless server): xvfb-run -a node test/promo.mjs

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const EXT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(EXT_DIR, "assets", "promo");
fs.mkdirSync(OUT_DIR, { recursive: true });

// Shared brand bits. The mark echoes the extension icon: a white rounded square
// with an indigo ring.
const BRAND_CSS = `
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{margin:0}
  .tile{
    position:relative;overflow:hidden;color:#fff;
    background:linear-gradient(135deg,#4338ca 0%,#6d5ef0 55%,#8b7dff 100%);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    display:flex;flex-direction:column;justify-content:center;
  }
  /* soft light bloom, top-right */
  .tile::after{content:"";position:absolute;top:-40%;right:-15%;width:70%;height:140%;
    background:radial-gradient(closest-side,rgba(255,255,255,.22),rgba(255,255,255,0));pointer-events:none}
  .brand{display:flex;align-items:center;gap:14px;font-weight:800;letter-spacing:-.02em}
  .mark{background:#fff;position:relative;flex:0 0 auto;border-radius:22%}
  .mark::after{content:"";position:absolute;inset:26%;border-radius:50%;border-style:solid;border-color:#4f46e5}
  .tag{font-weight:800;letter-spacing:-.02em;line-height:1.05}
  .sub{opacity:.9;font-weight:500}
`;

function smallHTML() {
  return `<div class="tile" style="width:440px;height:280px;padding:0 38px">
    <div class="brand" style="font-size:27px">
      <span class="mark" style="width:44px;height:44px"><i style="border-width:5px"></i></span>
      OpenSidekick
    </div>
    <div class="tag" style="font-size:33px;margin-top:20px">Your browser,<br/>any model.</div>
    <div class="sub" style="font-size:14px;margin-top:14px">Open-source AI that reads &amp; acts on any page.</div>
  </div>`;
}

function marqueeHTML() {
  const chip = (t) =>
    `<span style="display:inline-block;border:1px solid rgba(255,255,255,.35);border-radius:99px;padding:8px 18px;font-size:18px;font-weight:600;opacity:.96">${t}</span>`;
  return `<div class="tile" style="width:1400px;height:560px;padding:0 96px">
    <div class="brand" style="font-size:40px">
      <span class="mark" style="width:64px;height:64px"><i style="border-width:7px"></i></span>
      OpenSidekick
    </div>
    <div class="tag" style="font-size:64px;margin-top:28px">Your browser, any model.</div>
    <div class="sub" style="font-size:24px;margin-top:18px;max-width:60ch">
      An open-source AI agent in your side panel — it reads and acts on the page using whichever LLM you choose.
    </div>
    <div style="display:flex;gap:14px;margin-top:34px">
      ${chip("Bring your own LLM")}${chip("Reads &amp; acts on pages")}${chip("Keys stay local · MIT")}
    </div>
  </div>`;
}

// The <i> inside .mark carries the ring border-width; place it as the ::after
// equivalent by making the pseudo inherit. Simpler: style the ring via .mark i.
const FIX_CSS = `.mark{display:inline-block}.mark i{position:absolute;inset:26%;border-radius:50%;border-style:solid;border-color:#4f46e5}`;

async function render(page, html, w, h, outName) {
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<style>${BRAND_CSS}${FIX_CSS}</style>${html}`, { waitUntil: "load" });
  await new Promise((r) => setTimeout(r, 150));
  const out = path.join(OUT_DIR, outName);
  await page.screenshot({ path: out, clip: { x: 0, y: 0, width: w, height: h } });
  console.log("wrote assets/promo/" + outName);
}

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "opensidekick-promo-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check"],
  });
  try {
    const page = await context.newPage();
    await render(page, smallHTML(), 440, 280, "small-tile.png");
    await render(page, marqueeHTML(), 1400, 560, "marquee.png");
    await page.close();
  } finally {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
  console.log("\nDone. Promo tiles in assets/promo/");
}

main().catch((e) => {
  console.error("Promo harness error:", e);
  process.exit(1);
});
