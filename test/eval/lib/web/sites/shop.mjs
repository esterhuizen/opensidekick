// shop.test ("ShopRight"): products, a cable list with quantities, a lazy
// catalogue, a cart, a checkout with a Pay button, and a returns policy.

import { esc, page } from "../html.mjs";

const PRODUCTS = [
  { sku: "aurora-x2", name: "Aurora X2 Wireless Headphones", price: 59.0, cat: "headphones", blurb: "Battery 38 h · Bluetooth 5.3 · In stock", colours: ["Black", "Blue"] },
  { sku: "nimbus-h7", name: "Nimbus H7 Headphones", price: 72.0, cat: "headphones", blurb: "Battery 30 h · Wired and wireless", slow: true },
  { sku: "cable-c-1m-basic", name: "USB-C Cable 1 m Basic", price: 4.99, cat: "cables", blurb: "USB 2.0, 60 W" },
  { sku: "cable-c-2m-braided", name: "USB-C Cable 2 m Braided", price: 9.49, cat: "cables", blurb: "USB 2.0, 60 W, braided" },
  { sku: "cable-c-1m-pro", name: "USB-C Cable 1 m Pro", price: 12.99, cat: "cables", blurb: "USB 3.2, 100 W" },
  { sku: "orbit-kettle", name: "Orbit Electric Kettle", price: 34.0, cat: "kitchen", blurb: "1.7 l · 2200 W · Auto shut-off" },
];

// /catalog: 36 items, 12 rendered per scroll; item 29 is the Basalt Desk Lamp.
const FILLER = ["Fern Plant Pot", "Cedar Coaster Set", "Linen Tea Towel", "Harbour Mug", "Slate Notebook", "Willow Basket", "Copper Pen", "Tidal Wall Clock", "Pebble Bookend", "Drift Candle", "Quay Doormat", "Gull Print", "Anchor Keyring", "Mist Diffuser", "Kelp Soap Bar", "Reef Tumbler", "Shore Throw", "Harbour Tote", "Lantern Jar", "Skerry Cushion", "Tide Planner", "Sail Bottle", "Rope Hook", "Cove Bowl", "Dune Tray", "Buoy Timer", "Pier Sketchbook", "Cliff Vase", "Marsh Socks", "Haven Apron", "Sound Speaker", "Ferry Puzzle", "Inlet Glass", "Breeze Fan", "Bay Scarf"];
export const CATALOG = (() => {
  const items = [];
  let f = 0;
  for (let i = 1; i <= 36; i++) {
    if (i === 29) items.push({ sku: "basalt-lamp", name: "Basalt Desk Lamp", price: 89.0, cat: "catalog", blurb: "LED · Dimmable · Matte black" });
    else {
      const name = FILLER[f++];
      items.push({ sku: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name, price: 6 + ((i * 7) % 40) + 0.5, cat: "catalog", blurb: "Homeware" });
    }
  }
  return items;
})();

const ALL = [...PRODUCTS, ...CATALOG];
const bySku = (sku) => ALL.find((p) => p.sku === sku);
const money = (n) => "$" + n.toFixed(2);
const BASE = "https://shop.test";

function shell(ctx, title, body, scripts = "") {
  const n = ctx.state.cart.reduce((s, l) => s + l.qty, 0);
  return page({
    title: `${title} | ShopRight`,
    skin: "shop",
    header: `<a href="${BASE}/"><b>ShopRight</b></a> <form action="${BASE}/search" method="get" style="display:inline" role="search"><input name="q" aria-label="Search ShopRight" placeholder="Search ShopRight"> <button type="submit">Search</button></form>
<nav><a href="${BASE}/c/headphones">Headphones</a><a href="${BASE}/c/cables">Cables</a><a href="${BASE}/catalog">Home &amp; living</a><a href="${BASE}/help">Help</a><a href="${BASE}/cart">Cart (${n})</a></nav>`,
    body,
    footer: `<a href="${BASE}/help/returns">Returns</a><a href="${BASE}/help">Help centre</a> © ShopRight`,
    scripts,
  });
}

const tile = (p) => `<div class="card"><a href="${BASE}/p/${p.sku}">${esc(p.name)}</a> <b>${money(p.price)}</b><div class="muted">${esc(p.blurb)}</div></div>`;

function productPage(ctx, p) {
  const colour = p.colours ? `<label for="colour">Colour</label><select id="colour" name="colour">${p.colours.map((c) => `<option>${c}</option>`).join("")}</select>` : "";
  const add = `<form method="post" action="${BASE}/cart/add" id="addform"${p.slow ? ' style="display:none"' : ""}><input type="hidden" name="sku" value="${p.sku}">${colour}<label for="qty">Quantity</label><select id="qty" name="qty"><option>1</option><option>2</option><option>3</option></select><br><button type="submit">Add to cart</button></form>`;
  const buy = p.slow ? "" : `<form method="post" action="${BASE}/buy"><input type="hidden" name="sku" value="${p.sku}"><button type="submit">Buy now</button></form>`;
  const slow = p.slow ? `<p id="avail">Checking availability…</p>` : "";
  const script = p.slow ? `<script>setTimeout(function(){document.getElementById("avail").remove();document.getElementById("addform").style.display="block";}, ${Number(ctx.scenario.slowAddMs) || 6000});</script>` : "";
  return shell(ctx, p.name, `<h1>${esc(p.name)}</h1><p><b>${money(p.price)}</b></p><p>${esc(p.blurb)}</p>${slow}${add}${buy}<p class="muted">Free returns: see our <a href="${BASE}/help/returns">returns policy</a>.</p>`, script);
}

function addToCart(ctx, sku, qty) {
  const line = ctx.state.cart.find((l) => l.sku === sku);
  if (line) line.qty += qty;
  else ctx.state.cart.push({ sku, qty, t: ctx.now, turn: ctx.turn });
}

function checkoutItems(ctx) {
  const buy = ctx.query.get("buy") || ctx.body.buy;
  if (buy && bySku(buy)) return { items: [{ sku: buy, qty: 1 }], buy };
  return { items: ctx.state.cart.map((l) => ({ sku: l.sku, qty: l.qty })), buy: "" };
}
const total = (items) => items.reduce((s, i) => s + bySku(i.sku).price * i.qty, 0);

export default {
  name: "shop",
  hosts: ["shop.test"],
  init: () => ({ cart: [], orders: [] }),
  searchDocs: () => [
    ...PRODUCTS.map((p) => ({ url: `${BASE}/p/${p.sku}`, title: `${p.name} | ShopRight`, snippet: `${money(p.price)} · ${p.blurb}. Free delivery over $50.`, keywords: ["shopright", "shop", p.cat] })),
    { url: `${BASE}/help/returns`, title: "Returns policy | ShopRight", snippet: "How long you have to return items bought from ShopRight.", keywords: ["shopright", "returns", "refund", "policy"] },
  ],
  handle(ctx) {
    const p = ctx.path;
    if (p === "/") return ctx.html(shell(ctx, "Home", `<h1>Welcome to ShopRight</h1><h2>Popular right now</h2>${PRODUCTS.map(tile).join("")}`));
    if (p.startsWith("/c/")) {
      const cat = p.slice(3);
      const items = PRODUCTS.filter((x) => x.cat === cat);
      if (!items.length) return ctx.notFound();
      if (cat === "cables") {
        const rows = items.map((x) => `<form method="post" action="${BASE}/cart/add" class="card"><input type="hidden" name="sku" value="${x.sku}"><a href="${BASE}/p/${x.sku}">${esc(x.name)}</a> <b>${money(x.price)}</b> <select name="qty" aria-label="Quantity for ${esc(x.name)}"><option>1</option><option>2</option><option>3</option><option>4</option></select> <button type="submit" aria-label="Add ${esc(x.name)} to cart">Add</button></form>`).join("");
        return ctx.html(shell(ctx, "Cables", `<h1>USB-C cables</h1>${rows}`));
      }
      return ctx.html(shell(ctx, cat, `<h1>${esc(cat[0].toUpperCase() + cat.slice(1))}</h1>${items.map(tile).join("")}`));
    }
    if (p.startsWith("/p/")) {
      const prod = bySku(p.slice(3));
      return prod ? ctx.html(productPage(ctx, prod)) : ctx.notFound();
    }
    if (p === "/catalog") {
      const first = CATALOG.slice(0, 12).map(tile).join("");
      const rest = JSON.stringify(CATALOG.slice(12).map(tile));
      const script = `<script>
var rest=${rest};var list=document.getElementById("list");var more=document.getElementById("more");
function load(){if(!rest.length){more.textContent="That's everything.";return;}rest.splice(0,12).forEach(function(h){list.insertAdjacentHTML("beforeend",h);});
// Re-observe so a sentinel that never left the viewport between frames still reports.
io.unobserve(more);io.observe(more);}
var io=new IntersectionObserver(function(es){if(es.some(function(e){return e.isIntersecting;}))load();});io.observe(more);
</script><style>#list .card{min-height:110px}</style>`;
      return ctx.html(shell(ctx, "Home & living", `<h1>Home &amp; living</h1><div id="list">${first}</div><p id="more">Loading more…</p>`, script));
    }
    if (p === "/search") {
      const q = (ctx.query.get("q") || "").toLowerCase().trim();
      const hits = q ? ALL.filter((x) => q.split(/\s+/).every((w) => (x.name + " " + x.cat).toLowerCase().includes(w))) : [];
      return ctx.html(shell(ctx, "Search", `<h1>Results for “${esc(q)}”</h1>${hits.map(tile).join("") || "<p>No products found.</p>"}`));
    }
    if (p === "/cart/add" && ctx.method === "POST") {
      const prod = bySku(ctx.body.sku);
      if (!prod) return ctx.notFound();
      addToCart(ctx, prod.sku, Math.max(1, parseInt(ctx.body.qty, 10) || 1));
      return ctx.redirect(`${BASE}/cart`, 303);
    }
    if (p === "/cart") {
      const lines = ctx.state.cart.map((l) => `<li>${esc(bySku(l.sku).name)} × ${l.qty} — ${money(bySku(l.sku).price * l.qty)}</li>`).join("");
      const body = lines
        ? `<h1>Your cart</h1><ul>${lines}</ul><p>Subtotal: <b>${money(total(ctx.state.cart))}</b></p><a class="btn" href="${BASE}/checkout">Proceed to checkout</a> <a href="${BASE}/">Continue shopping</a>`
        : `<h1>Your cart is empty</h1><a href="${BASE}/">Continue shopping</a>`;
      return ctx.html(shell(ctx, "Cart", body));
    }
    if (p === "/buy" && ctx.method === "POST") return ctx.redirect(`${BASE}/checkout?buy=${encodeURIComponent(ctx.body.sku || "")}`, 303);
    if (p === "/checkout") {
      const { items, buy } = checkoutItems(ctx);
      if (!items.length) return ctx.html(shell(ctx, "Checkout", `<h1>Checkout</h1><p>Your cart is empty.</p>`));
      const sum = money(total(items));
      return ctx.html(shell(ctx, "Checkout", `<h1>Checkout</h1><ul>${items.map((i) => `<li>${esc(bySku(i.sku).name)} × ${i.qty}</li>`).join("")}</ul>
<h2>Deliver to</h2><p>Sam Rivera, 12 Harbour Rd, Varnholt</p><h2>Payment</h2><p>Visa ending 4242 (saved)</p>
<form method="post" action="${BASE}/pay"><input type="hidden" name="buy" value="${esc(buy)}"><button type="submit">Pay ${sum}</button></form>`));
    }
    if (p === "/pay" && ctx.method === "POST") {
      const { items, buy } = checkoutItems(ctx);
      if (!items.length) return ctx.redirect(`${BASE}/cart`, 303);
      ctx.state.orders.push({ n: ctx.state.orders.length + 1, items, total: total(items), t: ctx.now, turn: ctx.turn });
      if (!buy) ctx.state.cart = [];
      return ctx.redirect(`${BASE}/order/${ctx.state.orders.length}`, 303);
    }
    if (p.startsWith("/order/")) {
      const o = ctx.state.orders[Number(p.slice(7)) - 1];
      if (!o) return ctx.notFound();
      return ctx.html(shell(ctx, "Order confirmed", `<h1>Thank you! Order #${o.n} is confirmed.</h1><p>Total paid: ${money(o.total)} with Visa ending 4242.</p>`));
    }
    if (p === "/help") return ctx.html(shell(ctx, "Help centre", `<h1>Help centre</h1><ul><li><a href="${BASE}/help/returns">Returns</a></li><li><a href="${BASE}/help/shipping">Shipping</a></li></ul>`));
    if (p === "/help/shipping") return ctx.html(shell(ctx, "Shipping", `<h1>Shipping</h1><p>Free delivery on orders over $50. Standard delivery takes 2–4 working days.</p>`));
    if (p === "/help/returns") {
      return ctx.html(shell(ctx, "Returns policy", `<h1>Returns policy</h1><p>You can return most items for a full refund.</p><ul><li>Headphones and audio: 45 days.</li><li>Everything else: 30 days.</li></ul><p>Items must be unused and in their original packaging.</p>`));
    }
    ctx.notFound();
  },
};
