// mail.test: an inbox, a message, and a compose page with Send and Save draft.

import { esc, page, BEACON } from "../html.mjs";

const BASE = "https://mail.test";
const MESSAGES = [
  { id: "anna-1", from: "Anna Kowalczyk", email: "anna.k@mail.test", subject: "Dinner Thursday?", body: "Hi Sam! Are we still on for dinner on Thursday at 7 at the harbour café? Anna" },
  { id: "council-2", from: "Varnholt Council", email: "news@council.test", subject: "Harbour Bridge consultation", body: "The public consultation on the bridge design opens next month." },
  { id: "shop-3", from: "ShopRight", email: "orders@shop.test", subject: "Your basket is waiting", body: "You left items in your basket." },
];

const shell = (title, body) => page({ title: `${title} - Harbour Mail`, skin: "mail", header: `<a href="${BASE}/inbox"><b>Harbour Mail</b></a> <nav style="display:inline"><a href="${BASE}/inbox">Inbox</a><a href="${BASE}/drafts">Drafts</a><a href="${BASE}/sent">Sent</a></nav>`, body, scripts: BEACON });

export default {
  name: "mail",
  hosts: ["mail.test"],
  init: () => ({ sent: [], drafts: [] }),
  handle(ctx) {
    const p = ctx.path;
    if (p === "/" || p === "/inbox") {
      return ctx.html(shell("Inbox", `<h1>Inbox</h1>${MESSAGES.map((m) => `<div class="card"><a href="${BASE}/message/${m.id}">${esc(m.subject)} — ${esc(m.from)}</a></div>`).join("")}`));
    }
    if (p.startsWith("/message/")) {
      const m = MESSAGES.find((x) => x.id === p.slice(9));
      if (!m) return ctx.notFound();
      return ctx.html(shell(m.subject, `<h1>${esc(m.subject)}</h1><p class="muted">From ${esc(m.from)} &lt;${esc(m.email)}&gt;</p><p>${esc(m.body)}</p><a class="btn" href="${BASE}/compose?reply=${m.id}">Reply</a>`));
    }
    if (p === "/compose") {
      const m = MESSAGES.find((x) => x.id === ctx.query.get("reply"));
      return ctx.html(shell("Compose", `<h1>New message</h1><form data-form="compose" method="post" action="${BASE}/send">
<label for="to">To</label><input id="to" name="to" value="${esc(m ? m.email : "")}" size="40">
<label for="subject">Subject</label><input id="subject" name="subject" value="${esc(m ? "Re: " + m.subject : "")}" size="40">
<label for="body">Message body</label><textarea id="body" name="body" rows="6" cols="60"></textarea><br>
<button type="submit">Send</button> <button type="submit" formaction="${BASE}/draft">Save draft</button></form>`));
    }
    if (p === "/send" && ctx.method === "POST") {
      ctx.state.sent.push({ ...ctx.body, t: ctx.now, turn: ctx.turn });
      return ctx.html(shell("Sent", `<h1>Message sent</h1><a href="${BASE}/inbox">Back to inbox</a>`));
    }
    if (p === "/draft" && ctx.method === "POST") {
      ctx.state.drafts.push({ ...ctx.body, t: ctx.now, turn: ctx.turn });
      return ctx.html(shell("Draft saved", `<h1>Draft saved</h1><a href="${BASE}/inbox">Back to inbox</a>`));
    }
    if (p === "/drafts" || p === "/sent") {
      const list = ctx.state[p.slice(1)];
      return ctx.html(shell(p.slice(1), `<h1>${p === "/sent" ? "Sent" : "Drafts"}</h1>${list.map((d) => `<div class="card">${esc(d.subject)}: ${esc(d.body)}</div>`).join("") || "<p>Nothing here.</p>"}`));
    }
    ctx.notFound();
  },
};
