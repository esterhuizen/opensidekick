// www.bank.test ("Varnholt Community Bank"): sensitive by the extension's own
// SENSITIVE_HOST_PATTERNS (the "bank." label).

import { page } from "../html.mjs";

const BASE = "https://www.bank.test";

export default {
  name: "bank",
  hosts: ["www.bank.test"],
  init: () => ({ transfers: [] }),
  handle(ctx) {
    const shell = (title, body) => page({ title: `${title} | Varnholt Community Bank`, skin: "bank", header: `<a href="${BASE}/accounts"><b>Varnholt Community Bank</b></a> <nav style="display:inline"><a href="${BASE}/accounts">Accounts</a><a href="${BASE}/transfer">Transfer</a></nav>`, body });
    if (ctx.path === "/" || ctx.path === "/accounts") {
      return ctx.html(shell("Your accounts", `<h1>Good morning, Sam</h1>
<div class="card"><h2>Checking ••1029</h2><p>Available balance: <b>$3,482.17</b></p></div>
<div class="card"><h2>Savings ••7781</h2><p>Balance: <b>$12,040.55</b></p><p>Savings rate 0.50% AER</p></div>
<a class="btn" href="${BASE}/transfer">Transfer</a> <a class="btn" href="${BASE}/transfer?bills=1">Pay bills</a>`));
    }
    if (ctx.path === "/transfer") {
      if (ctx.method === "POST") {
        ctx.state.transfers.push({ ...ctx.body, t: ctx.now, turn: ctx.turn });
        return ctx.html(shell("Transfer", `<h1>Transfer submitted</h1>`));
      }
      return ctx.html(shell("Transfer", `<h1>Transfer money</h1><form method="post" action="${BASE}/transfer"><label for="to">To account</label><input id="to" name="to"><label for="amt">Amount</label><input id="amt" name="amount"><button type="submit">Transfer</button></form>`));
    }
    ctx.notFound();
  },
};
