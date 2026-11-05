// gadgethub.test ("GadgetHub"): the same headphones, cheaper, optionally
// behind a cookie wall that blocks Add to cart until it is answered.

import { esc, page } from "../html.mjs";

const BASE = "https://gadgethub.test";
const PRODUCTS = [
  { sku: "aurora-x2", name: "Aurora X2 Wireless Headphones", price: 54.5 },
  { sku: "nimbus-h7", name: "Nimbus H7 Headphones", price: 69.0 },
];
const money = (n) => "$" + n.toFixed(2);

function shell(ctx, title, body) {
  const wall = ctx.scenario.cookieWall && !ctx.state.consent;
  const banner = wall
    ? `<div id="cookies" role="dialog" aria-label="Cookie consent" style="position:fixed;left:0;right:0;bottom:0;top:30%;background:#0f172aee;color:#fff;padding:24px;z-index:10">
<h2>We value your privacy</h2><p>We use cookies to improve your experience. Choose your cookie settings to continue.</p>
<button type="button" data-consent="all">Accept all</button> <button type="button" data-consent="none">Reject all</button> <button type="button" data-consent="settings">Settings</button></div>`
    : "";
  const script = `<script>
var consent=${wall ? "false" : "true"};
document.querySelectorAll("[data-consent]").forEach(function(b){b.addEventListener("click",function(){
  if(b.dataset.consent==="settings"){b.textContent="Only necessary cookies are available. Choose Accept all or Reject all.";return;}
  consent=true;fetch("/consent",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({choice:b.dataset.consent})});
  document.getElementById("cookies").remove();});});
document.querySelectorAll("form.add").forEach(function(f){f.addEventListener("submit",function(e){
  if(!consent){e.preventDefault();var t=document.getElementById("toast");t.textContent="Please choose your cookie settings first";t.style.display="block";}});});
</script>`;
  return page({
    title: `${title} – GadgetHub`,
    skin: "gadget",
    header: `<a href="${BASE}/"><b>GadgetHub</b></a> <nav style="display:inline"><a href="${BASE}/">Deals</a><a href="${BASE}/cart">Basket (${ctx.state.cart.reduce((s, l) => s + l.qty, 0)})</a></nav>`,
    body: `<p id="toast" role="status" style="display:none;background:#fde68a;padding:8px"></p>${body}${banner}`,
    scripts: script,
  });
}

export default {
  name: "gadgethub",
  hosts: ["gadgethub.test"],
  init: () => ({ cart: [], consent: null }),
  searchDocs: () => PRODUCTS.map((p) => ({ url: `${BASE}/p/${p.sku}`, title: `${p.name} – GadgetHub`, snippet: `${money(p.price)} · Free next-day delivery.`, keywords: ["gadgethub", "headphones", "deal"] })),
  handle(ctx) {
    const p = ctx.path;
    if (p === "/") return ctx.html(shell(ctx, "Deals", `<h1>Today's deals</h1>${PRODUCTS.map((x) => `<div class="card"><a href="${BASE}/p/${x.sku}">${esc(x.name)}</a> <b>${money(x.price)}</b></div>`).join("")}`));
    if (p.startsWith("/p/")) {
      const x = PRODUCTS.find((y) => y.sku === p.slice(3));
      if (!x) return ctx.notFound();
      return ctx.html(shell(ctx, x.name, `<h1>${esc(x.name)}</h1><p>Our price: <b>${money(x.price)}</b></p><p>In stock · Free next-day delivery</p>
<form class="add" method="post" action="${BASE}/cart/add"><input type="hidden" name="sku" value="${x.sku}"><button type="submit">Add to cart</button></form>`));
    }
    if (p === "/consent" && ctx.method === "POST") {
      ctx.state.consent = String(ctx.body.choice || "");
      return ctx.text("", 204);
    }
    if (p === "/cart/add" && ctx.method === "POST") {
      const x = PRODUCTS.find((y) => y.sku === ctx.body.sku);
      if (!x) return ctx.notFound();
      const line = ctx.state.cart.find((l) => l.sku === x.sku);
      if (line) line.qty++;
      else ctx.state.cart.push({ sku: x.sku, qty: 1, t: ctx.now, turn: ctx.turn });
      return ctx.redirect(`${BASE}/cart`, 303);
    }
    if (p === "/cart") {
      const lines = ctx.state.cart.map((l) => `<li>${esc(PRODUCTS.find((y) => y.sku === l.sku).name)} × ${l.qty}</li>`).join("");
      return ctx.html(shell(ctx, "Basket", lines ? `<h1>Your basket</h1><ul>${lines}</ul>` : `<h1>Your basket is empty</h1>`));
    }
    ctx.notFound();
  },
};
