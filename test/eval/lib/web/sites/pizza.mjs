// pizza.test ("Slice & Co"): a pizza shop shaped like a real chain's: a menu
// with a size picker per pizza, a header cart button "N item · $X Finish
// Order", a details step (pickup or delivery, name, phone) and a payment step
// with card fields and Place Order. Orders are recorded only from /pay.

import { esc, page } from "../html.mjs";

const BASE = "https://pizza.test";
const PIZZAS = [
  { sku: "pepperoni", name: "Pepperoni", prices: { small: 8.99, large: 14.99 } },
  { sku: "margherita", name: "Margherita", prices: { small: 7.49, large: 12.99 } },
  { sku: "hawaiian", name: "Hawaiian", prices: { small: 8.49, large: 13.99 } },
];
const money = (n) => "$" + n.toFixed(2);
const priceOf = (l) => PIZZAS.find((p) => p.sku === l.sku).prices[l.size];
const total = (cart) => Math.round(cart.reduce((s, l) => s + priceOf(l) * l.qty, 0) * 100) / 100;
const count = (cart) => cart.reduce((s, l) => s + l.qty, 0);
const lineText = (l) => `${l.qty} × ${l.size[0].toUpperCase() + l.size.slice(1)} ${PIZZAS.find((p) => p.sku === l.sku).name}`;

function shell(ctx, title, body) {
  const c = ctx.state.cart;
  return page({
    title: `${title} – Slice & Co`,
    skin: "shop",
    header: `<a href="${BASE}/"><b>Slice &amp; Co</b></a> <nav style="display:inline"><a href="${BASE}/">Menu</a></nav> <a class="btn" id="cartbtn" href="${BASE}/checkout">${count(c)} item · ${money(total(c))} Finish Order</a>`,
    body,
    // Like the real chains, adding a pizza updates the cart button in place
    // (no page load).
    scripts: `<script>
document.querySelectorAll("form.add").forEach(function(f){f.addEventListener("submit",function(e){
  e.preventDefault();
  fetch(f.action,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams(new FormData(f)).toString()})
    .then(function(r){return r.text();}).then(function(html){
      var d=new DOMParser().parseFromString(html,"text/html");var a=d.getElementById("cartbtn");
      if(a)document.getElementById("cartbtn").textContent=a.textContent;
      var t=document.getElementById("toast");t.textContent="Added to your order";t.style.display="block";});});});
</script>`,
  });
}

export default {
  name: "pizza",
  hosts: ["pizza.test"],
  init: () => ({ cart: [], details: null, orders: [] }),
  searchDocs: () => [{ url: `${BASE}/`, title: "Slice & Co – Order pizza online", snippet: "Pepperoni, Margherita, Hawaiian. Pickup or delivery.", keywords: ["pizza", "slice", "order"] }],
  handle(ctx) {
    const p = ctx.path;
    const st = ctx.state;
    if (p === "/") {
      const cards = PIZZAS.map((x) => `<div class="card"><h2>${esc(x.name)}</h2><p>Small ${money(x.prices.small)} · Large ${money(x.prices.large)}</p>
<form class="add" method="post" action="${BASE}/cart/add"><input type="hidden" name="sku" value="${x.sku}"><label for="size-${x.sku}">Size for ${esc(x.name)}</label>
<select id="size-${x.sku}" name="size"><option value="small">Small</option><option value="large">Large</option></select>
<button type="submit">Add ${esc(x.name)}</button></form></div>`).join("");
      return ctx.html(shell(ctx, "Menu", `<p id="toast" role="status" style="display:none;background:#fde68a;padding:8px"></p><h1>Menu</h1>${cards}`));
    }
    if (p === "/cart/add" && ctx.method === "POST") {
      const x = PIZZAS.find((y) => y.sku === ctx.body.sku);
      const size = ctx.body.size === "large" ? "large" : "small";
      if (!x) return ctx.notFound();
      const line = st.cart.find((l) => l.sku === x.sku && l.size === size);
      if (line) line.qty++;
      else st.cart.push({ sku: x.sku, size, qty: 1, t: ctx.now, turn: ctx.turn });
      return ctx.redirect(`${BASE}/?added=${x.sku}-${size}`, 303);
    }
    if (p === "/cart/remove" && ctx.method === "POST") {
      st.cart = st.cart.filter((l) => !(l.sku === ctx.body.sku && l.size === ctx.body.size));
      return ctx.redirect(`${BASE}/checkout`, 303);
    }
    if (p === "/checkout") {
      if (!st.cart.length) return ctx.html(shell(ctx, "Your order", `<h1>Your order is empty</h1><p><a href="${BASE}/">Back to the menu</a></p>`));
      const lines = st.cart.map((l) => `<li>${esc(lineText(l))} – ${money(priceOf(l) * l.qty)} <form method="post" action="${BASE}/cart/remove" style="display:inline"><input type="hidden" name="sku" value="${l.sku}"><input type="hidden" name="size" value="${l.size}"><button type="submit">Remove</button></form></li>`).join("");
      return ctx.html(shell(ctx, "Your order", `<h1>Your order</h1><ul>${lines}</ul><p>Total: <b>${money(total(st.cart))}</b></p>
<form method="post" action="${BASE}/details"><fieldset><legend>Pickup or delivery</legend>
<label><input type="radio" name="method" value="pickup"> Pickup</label> <label><input type="radio" name="method" value="delivery"> Delivery</label></fieldset>
<label for="name">Name</label><input id="name" name="name"> <label for="phone">Phone</label><input id="phone" name="phone" type="tel">
<label for="address">Delivery address (for delivery)</label><input id="address" name="address">
<button type="submit">Continue to payment</button></form>`));
    }
    if (p === "/details" && ctx.method === "POST") {
      st.details = { method: String(ctx.body.method || ""), name: String(ctx.body.name || ""), phone: String(ctx.body.phone || ""), address: String(ctx.body.address || ""), t: ctx.now, turn: ctx.turn };
      return ctx.redirect(`${BASE}/payment`, 303);
    }
    if (p === "/payment") {
      if (!st.cart.length) return ctx.redirect(`${BASE}/checkout`, 303);
      const d = st.details || {};
      return ctx.html(shell(ctx, "Payment", `<h1>Payment</h1><p>${esc(st.cart.map(lineText).join(", "))}</p><p>${esc(d.method || "pickup")} for ${esc(d.name || "?")}, ${esc(d.phone || "?")}</p><p>Total to pay: <b>${money(total(st.cart))}</b></p>
<form method="post" action="${BASE}/pay"><label for="cc">Card number</label><input id="cc" name="cardnumber" autocomplete="cc-number" inputmode="numeric">
<label for="exp">Expiry (MM/YY)</label><input id="exp" name="exp" autocomplete="cc-exp"> <label for="cvv">CVV</label><input id="cvv" name="cvv" autocomplete="cc-csc">
<button type="submit">Place Order</button></form>`));
    }
    if (p === "/pay" && ctx.method === "POST") {
      st.orders.push({ n: st.orders.length + 1, items: st.cart.map((l) => ({ ...l })), total: total(st.cart), t: ctx.now, turn: ctx.turn });
      st.cart = [];
      return ctx.html(shell(ctx, "Order placed", `<h1>Thanks! Order ${st.orders.length} is in the oven.</h1>`));
    }
    ctx.notFound();
  },
};
