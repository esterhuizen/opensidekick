// The secret-field rule in a real page: which fields the content script treats
// as password, card or code fields, and that it refuses to fill them unless the
// user gave the value (secretOk) and approved this fill (secretConfirmed).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { MSG } from "../src/common/constants.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cs = readFileSync(path.join(ROOT, "src/content/content-script.js"), "utf8");

let fail = 0;
const ok = (c, m) => { console.log((c ? "ok  : " : "FAIL: ") + m); if (!c) fail = 1; };

const CASES = [
  // [id, html, secret?]
  ["pw", `<label for="pw">Password</label><input id="pw" type="password">`, true],
  ["otp-ta", `<textarea id="otp-ta" autocomplete="one-time-code"></textarea>`, true],
  ["masked", `<input id="masked" type="text" style="-webkit-text-security:disc">`, true],
  ["ccnum", `<input id="ccnum" type="tel" name="ccnumber">`, true],
  ["cvv", `<label for="cvv">CVV2</label><input id="cvv" maxlength="4">`, true],
  ["code6", `<input id="code6" inputmode="numeric" placeholder="Enter the 6-digit code">`, true],
  ["passwort", `<input id="passwort" type="text" placeholder="Passwort">`, true],
  ["support", `<textarea id="support" placeholder="Describe your problem. Never include passwords or card numbers."></textarea>`, false],
  ["chat", `<input id="chat" aria-label="Message us (don't share your password)">`, false],
  ["pincode", `<label for="pincode">PIN code</label><input id="pincode" name="postal">`, false],
  ["mapsearch", `<input id="mapsearch" type="search" placeholder="Search or drop a pin">`, false],
  ["phoneTime", `<input id="phoneTime" placeholder="Best time to call">`, false],
  ["donation", `<label for="donation">One-time donation amount</label><input id="donation">`, false],
  ["email", `<label>Email <a href="#">Forgot password?</a><input id="email" type="email" name="email"></label>`, false],
  ["company", `<label for="company">Company</label><input id="company" name="company">`, false],
  ["passport", `<input id="passport" placeholder="Passport number">`, false],
  ["userpwd", `<input id="userpwd" name="user_pwd" type="text">`, true],
  ["loginPwd", `<input id="loginPwd" type="text">`, true],
  ["otpemail", `<textarea id="otpemail" name="otp_code"></textarea>`, true],
  ["verify60", `<input id="verify60" placeholder="Enter the verification code sent to your email">`, true],
  ["curly", `<input id="curly" aria-label="Message us (don’t share your password)">`, false],
  ["userlabel", `<label for="userlabel">Username <a href="#">Forgotten your password?</a></label><input id="userlabel" name="username">`, false],
  ["coupon", `<input id="coupon" placeholder="Coupon code">`, false],
  ["PassWord", `<input id="PassWord" type="text">`, true],
  ["resetcode", `<label for="resetcode">Password reset code</label><input id="resetcode">`, true],
  ["giftpin", `<label for="giftpin">Gift card PIN</label><input id="giftpin">`, true],
  ["vcode", `<label for="vcode">Verification code (don’t share it)</label><input id="vcode">`, true],
  ["digit6", `<input id="digit6" placeholder="Enter 6 digit code">`, true],
  ["giftcode", `<input id="giftcode" placeholder="Gift card code">`, false],
  ["pinname", `<label for="pinname">Pin name</label><input id="pinname">`, false],
  ["toggle", `<label for="toggle">Your key</label><input id="toggle" type="password">`, true],
  // Round-6 audit: a help link inside the label must not hide the hint.
  ["cvvhelp", `<label for="cvvhelp">Card verification (CVV) <a href="#">Don't know where to find it?</a></label><input id="cvvhelp">`, true],
  ["otphelp", `<label for="otphelp">One-time code <a href="#">Where do I find my one-time code for signing in?</a></label><input id="otphelp">`, true],
  ["step2", `<label for="step2">Step 2: Security code <a href="#">Never received one?</a></label><input id="step2">`, true],
  // A prefilled secret with no label: its value must not become its name.
  ["prefill", `<input id="prefill" type="password" value="OldWifi-Secret-1">`, true],
  ["prefillta", `<label for="prefillta">Backup codes</label><textarea id="prefillta" name="password">S3cret-TA-1</textarea>`, true],
  ["prefillcc", `<input id="prefillcc" autocomplete="cc-number" value="4111 1111 1111 1111">`, true],
];

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><body>${CASES.map(([, h]) => `<div>${h}</div>`).join("\n")}<button><img alt="Delete account" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></button><button><img alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><svg aria-label="Pay now"></svg></button><button><span role="img" aria-label="Delete account">🗑️</span></button><button name="op" value="delete"><svg></svg></button><button title="Delete"><img alt="trash" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></button><button title="Delete">🗑️</button><button><img alt="Buy now" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="> $49</button><div role="combobox"><textarea name="password">S3cret-CB-1</textarea></div></body>`);
  await page.evaluate(() => {
    window.chrome = { runtime: { onMessage: { addListener(fn) { window.__cs = fn; } }, sendMessage() {}, id: "test" } };
  });
  await page.addScriptTag({ content: cs });
  const call = (msg) => page.evaluate((m) => new Promise((r) => { const ret = window.__cs(m, {}, r); if (ret !== true && ret !== undefined) r(ret); }), msg);
  const read = await call({ type: MSG.CS_READ_PAGE });
  ok(read && Array.isArray(read.elements), "read_page returns elements");
  const byOrder = (read.elements || []).filter((e) => e.tag === "input" || e.tag === "textarea");
  const ids = await page.evaluate(() => [...document.querySelectorAll("input,textarea")].map((el) => el.id));
  ok(byOrder.length === ids.length, `every field is in the read (got ${byOrder.length}/${ids.length})`);
  const el = Object.fromEntries(ids.map((id, i) => [id, byOrder[i]]));
  for (const [id, , want] of CASES) ok(!!(el[id] && el[id].secret) === want, `${id}: ${want ? "secret" : "plain"}`);

  const leak = JSON.stringify(read.elements || []);
  ok(!/OldWifi-Secret-1|4111 1111|S3cret-TA-1|S3cret-CB-1/.test(leak), "a prefilled secret's value is not in the read (not as its name either)");
  const btns = (read.elements || []).filter((e) => e.tag === "button").map((e) => e.name);
  const want = ["Delete account", "Pay now", "Delete account", "delete", "trash Delete", "Delete", "$49 Buy now"];
  ok(JSON.stringify(btns) === JSON.stringify(want), `icon-only and value buttons are named (got ${JSON.stringify(btns)})`);

  // Show-password toggle after the read: still secret on the next read.
  await page.evaluate(() => { document.getElementById("toggle").type = "text"; });
  const read2 = await call({ type: MSG.CS_READ_PAGE });
  const f2 = (read2.elements || []).filter((e) => e.tag === "input" || e.tag === "textarea");
  const t2 = f2[ids.indexOf("toggle")];
  ok(t2 && t2.secret, "a password field stays secret after a show-password toggle");

  const pwRef = f2[ids.indexOf("pw")].ref;
  const typeIn = (extra) => call({ type: MSG.CS_ACT, action: "type", ref: pwRef, text: "Hunter-77", submit: false, ...extra });
  let r = await typeIn({});
  ok(r && r.ok === false && /user gave you/.test(r.error), "no secretOk: refused");
  r = await typeIn({ secretOk: true });
  ok(r && r.ok === false && /approve/.test(r.error), "secretOk without the user's approval: refused");
  r = await typeIn({ secretOk: true, secretConfirmed: true });
  ok(r && r.ok === true && r.typed === "(hidden)", "user-given and approved: typed, value hidden in the result");
  ok((await page.evaluate(() => document.getElementById("pw").value)) === "Hunter-77", "the field holds the value");
  const companyRef = f2[ids.indexOf("company")].ref;
  r = await call({ type: MSG.CS_ACT, action: "type", ref: companyRef, text: "Acme", submit: false });
  ok(r && r.ok === true && r.typed === "Acme", "a plain field needs neither flag");

  // XHTML: tagName is lower-case there; a prefilled password must still not
  // become its own name.
  const xp = await browser.newPage();
  await xp.route("**/*", (rt) => rt.fulfill({ status: 200, contentType: "application/xhtml+xml", body: `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><input type="password" value="XHTML-Secret-1"/></body></html>` }));
  await xp.goto("https://x.test/");
  await xp.evaluate(() => { window.chrome = { runtime: { onMessage: { addListener(fn) { window.__cs = fn; } }, sendMessage() {}, id: "test" } }; });
  await xp.evaluate((code) => (0, eval)(code), cs); // XHTML has no <head> for addScriptTag
  const xr = await xp.evaluate((m) => new Promise((r) => { const ret = window.__cs(m, {}, r); if (ret !== true && ret !== undefined) r(ret); }), { type: MSG.CS_READ_PAGE });
  ok(xr && Array.isArray(xr.elements) && xr.elements.length === 1 && !/XHTML-Secret-1/.test(JSON.stringify(xr.elements)), "XHTML: a prefilled password's value is not in the read");
} finally {
  await browser.close();
}
console.log(fail ? "\nSECRET-DOM CHECKS FAILED" : "\nALL SECRET-DOM CHECKS PASSED");
process.exit(fail);
