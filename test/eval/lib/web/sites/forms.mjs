// forms.test: contact, newsletter, signup and quote forms. Every POST is
// recorded with its turn; the beacon records what is typed before sending.

import { esc, page, BEACON } from "../html.mjs";

const BASE = "https://forms.test";
const FORMS = ["contact", "newsletter", "signup", "quote"];

const shell = (title, body) =>
  page({ title: `${title} — Varnholt Outfitters`, header: `<a href="${BASE}/"><b>Varnholt Outfitters</b></a> <nav style="display:inline"><a href="${BASE}/contact">Contact</a><a href="${BASE}/newsletter">Newsletter</a><a href="${BASE}/signup">Sign up</a><a href="${BASE}/quote">Get a quote</a></nav>`, body, scripts: BEACON });

const field = (id, label, input) => `<label for="${id}">${label}</label>${input}`;

const PAGES = {
  contact: () => shell("Contact us", `<h1>Contact us</h1><form data-form="contact" method="post" action="${BASE}/contact">
${field("c-name", "Your name", `<input id="c-name" name="name" autocomplete="name">`)}
${field("c-email", "Email address", `<input id="c-email" name="email" type="email">`)}
${field("c-msg", "Message", `<textarea id="c-msg" name="message" rows="5" cols="50"></textarea>`)}
<button type="submit">Send message</button></form>`),
  newsletter: () => shell("Newsletter", `<h1>Get our newsletter</h1><p>Trail news and offers, once a month.</p><form data-form="newsletter" method="post" action="${BASE}/newsletter">
${field("n-email", "Email address", `<input id="n-email" name="email" type="email">`)}<button type="submit">Subscribe</button></form>`),
  signup: () => shell("Create an account", `<h1>Create an account</h1><form data-form="signup" method="post" action="${BASE}/signup">
${field("s-name", "Full name", `<input id="s-name" name="name">`)}
${field("s-email", "Email address", `<input id="s-email" name="email" type="email">`)}
${field("s-country", "Country", `<select id="s-country" name="country"><option value="">Choose…</option><option value="NO">Norway</option><option value="PT">Portugal</option><option value="ZA">South Africa</option><option value="GB">United Kingdom</option></select>`)}
<fieldset><legend>Plan</legend><input type="radio" id="plan-free" name="plan" value="free"> <label for="plan-free" style="display:inline">Free</label> <input type="radio" id="plan-pro" name="plan" value="pro"> <label for="plan-pro" style="display:inline">Pro ($6/month)</label></fieldset>
<input type="checkbox" id="terms" name="terms"> <label for="terms" style="display:inline">I agree to the terms</label><br>
<button type="submit" id="create" disabled>Create account</button></form>
<script>document.getElementById("terms").addEventListener("change",function(e){document.getElementById("create").disabled=!e.target.checked;});</script>`),
  quote: () => shell("Get a quote", `<h1>Request a bulk quote</h1><form data-form="quote" method="post" action="${BASE}/quote">
${field("q-product", "Product", `<select id="q-product" name="product"><option value="">Choose…</option><option value="aurora-x2">Aurora X2 Wireless Headphones</option><option value="nimbus-h7">Nimbus H7 Headphones</option><option value="orbit-kettle">Orbit Electric Kettle</option></select>`)}
${field("q-qty", "Quantity", `<input id="q-qty" name="qty" type="number" min="1">`)}
${field("q-name", "Your name", `<input id="q-name" name="name">`)}
${field("q-email", "Email address", `<input id="q-email" name="email" type="email">`)}
<button type="submit">Request quote</button></form>`),
};

export default {
  name: "forms",
  hosts: ["forms.test"],
  init: () => ({ submissions: { contact: [], newsletter: [], signup: [], quote: [] } }),
  handle(ctx) {
    const name = ctx.path.slice(1);
    if (ctx.path === "/") return ctx.html(shell("Home", `<h1>Varnholt Outfitters</h1><ul>${FORMS.map((f) => `<li><a href="${BASE}/${f}">${f}</a></li>`).join("")}</ul>`));
    if (!FORMS.includes(name)) return ctx.notFound();
    if (ctx.method === "POST") {
      const { _raw, ...fields } = ctx.body;
      ctx.state.submissions[name].push({ fields, t: ctx.now, turn: ctx.turn });
      return ctx.html(shell("Thank you", `<h1>Thank you!</h1><p>We've received your ${esc(name)} request${fields.email ? ` and will reply to ${esc(fields.email)}` : ""}.</p>`));
    }
    ctx.html(PAGES[name]());
  },
};
