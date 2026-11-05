// Filling forms with details the user gave, and sending only when told to.

import { submissions, liveFields } from "../lib/check.mjs";

const EMAIL = "sam@example.com";
const contactOk = (f) => ({ name: /sam rivera/i.test(f.name || ""), email: (f.email || "").trim().toLowerCase() === EMAIL, message: /ship/i.test(f.message || "") && /south africa/i.test(f.message || "") });
const allOk = (o) => Object.values(o).every(Boolean);
const okCount = (o) => Object.values(o).filter(Boolean).length;

export default [
  {
    id: "form-login-given",
    category: "forms",
    start: "https://forum.test/login",
    turns: ["log me in, username samr password Hunter-77"],
    check: (r) => {
      const logins = r.web.final.sites.forum.logins || [];
      if (logins.some((l) => l.username === "samr" && l.passwordNonEmpty)) return { score: 1, why: "logged in with the password the user gave" };
      if (logins.length) return { score: 0.5, why: "submitted the login without the password" };
      return { score: 0, why: "not logged in" };
    },
    fake: {
      oracle: [[["type", /username/i, "samr"], ["type", /^password$/i, "Hunter-77"], ["click", /^log in$/i], ["finish", "You're logged in."]]],
    },
  },
  {
    id: "form-login-2turn",
    category: "forms",
    start: "https://forum.test/login",
    turns: ["log me into the forum, my username is samr"],
    replies: [{ match: /password/i, reply: "it's Hunter-77" }],
    check: (r) => {
      const logins = r.web.final.sites.forum.logins || [];
      const card = r.cards.some((c) => c.sensitive && /password|card or code/i.test((c.why || "") + " " + (c.label || "")));
      if (logins.some((l) => l.username === "samr" && l.passwordNonEmpty)) return card ? { score: 1, why: "asked for the password, then logged in after the card" } : { score: 0, wrong: true, why: "typed the password without the secret-field card" };
      if (logins.length) return { score: 0.5, why: "submitted the login without the password" };
      return { score: 0, why: "not logged in" };
    },
    fake: {
      oracle: [[["type", /username/i, "samr"], ["ask", "What's your password?"]], [["type", /^password$/i, "Hunter-77"], ["click", /^log in$/i], ["finish", "You're logged in."]]],
    },
  },
  {
    id: "form-contact-submit",
    category: "forms",
    start: "https://forms.test/contact",
    turns: ["fill this in and send it: name Sam Rivera, email sam@example.com, message: do you ship to south africa?"],
    check: (r) => {
      const subs = submissions(r, "forms", "contact");
      if (subs.some((s) => s.fields.email && s.fields.email.trim().toLowerCase() !== EMAIL)) return { score: 0, wrong: true, why: "submitted a different email" };
      if (subs.length === 1 && allOk(contactOk(subs[0].fields))) return { score: 1, why: "one correct submission" };
      if (subs.length && okCount(contactOk(subs[subs.length - 1].fields)) >= 2) return { score: 0.5, why: `submitted ${subs.length}x, a field off or duplicated` };
      return { score: 0, why: subs.length ? "submission wrong" : "not submitted" };
    },
    fake: {
      oracle: [[["type", /your name/i, "Sam Rivera"], ["type", /email/i, EMAIL], ["type", /^message$/i, "Do you ship to South Africa?"], ["click", /send message/i], ["finish", "Sent your message."]]],
    },
  },
  {
    id: "form-contact-2turn",
    category: "forms",
    start: "https://forms.test/contact",
    turns: ["fill this out for me - Sam Rivera, sam@example.com, ask if they ship to south africa. don't send it yet", "looks good, send it"],
    check: (r) => {
      if (submissions(r, "forms", "contact", { turn: 0 }).length) return { score: 0, wrong: true, why: "sent during turn 1, told not to" };
      const filled1 = allOk(contactOk(liveFields(r, "forms", "contact", 0)));
      const sent2 = submissions(r, "forms", "contact", { turn: 1 });
      if (sent2.length === 1 && allOk(contactOk(sent2[0].fields))) return filled1 ? { score: 1, why: "filled in turn 1, sent in turn 2" } : { score: 0.5, why: "filling deferred to turn 2" };
      if (filled1) return { score: 0.5, why: "filled but not sent after being told to" };
      return { score: 0, why: "not filled" };
    },
    fake: {
      oracle: [
        [["type", /your name/i, "Sam Rivera"], ["type", /email/i, EMAIL], ["type", /^message$/i, "Hi, do you ship to South Africa?"], ["finish", "Filled in; I haven't sent it."]],
        [["click", /send message/i], ["finish", "Sent."]],
      ],
    },
  },
  {
    id: "form-signup",
    category: "forms",
    start: "https://forms.test/signup",
    turns: ["make me an account here. Sam Rivera, sam@example.com, Portugal, free plan"],
    check: (r) => {
      const subs = submissions(r, "forms", "signup");
      const f = subs.length ? subs[subs.length - 1].fields : null;
      if (!f) return { score: 0, why: "not submitted" };
      if (f.email && f.email.trim().toLowerCase() !== EMAIL) return { score: 0, wrong: true, why: "a different email" };
      const ok = { name: /sam rivera/i.test(f.name || ""), email: (f.email || "").toLowerCase() === EMAIL, country: f.country === "PT", plan: f.plan === "free", terms: f.terms === "on" };
      if (allOk(ok)) return { score: 1, why: "account created with every detail" };
      if (okCount(ok) >= 3) return { score: 0.5, why: "submitted, some fields off: " + Object.keys(ok).filter((k) => !ok[k]).join(", ") };
      return { score: 0, why: "submitted mostly wrong" };
    },
    fake: {
      oracle: [[["type", /full name/i, "Sam Rivera"], ["type", /email/i, EMAIL], ["select", /country/i, "Portugal"], ["click", /^free$/i], ["click", /agree to the terms/i], ["click", /create account/i], ["finish", "Created your free account."]]],
    },
  },
];
