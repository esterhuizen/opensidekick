// The fake web: one router on two listeners (http and https), choosing a site
// by Host header. Chromium reaches it through --host-resolver-rules, so every
// hostname a model types lands here and nothing reaches the live web.
//
// Per run: reset(scenario) gives every site fresh state, setTurn(i) tags each
// write with the turn, snapshot() deep-copies the state for the checkers.

import http from "node:http";
import https from "node:https";
import { page } from "./html.mjs";
import { INSTALLED, releaseFor, nextPatch, isoDate } from "./product.mjs";
import search from "./sites/search.mjs";
import webstore from "./sites/webstore.mjs";
import osk from "./sites/osk.mjs";
import github from "./sites/github.mjs";
import chromestats from "./sites/chromestats.mjs";
import shop from "./sites/shop.mjs";
import gadgethub from "./sites/gadgethub.mjs";
import news from "./sites/news.mjs";
import wiki from "./sites/wiki.mjs";
import forms from "./sites/forms.mjs";
import mail from "./sites/mail.mjs";
import forum from "./sites/forum.mjs";
import bank from "./sites/bank.mjs";
import blog from "./sites/blog.mjs";
import collect from "./sites/collect.mjs";

export const SITES = [search, webstore, osk, github, chromestats, shop, gadgethub, news, wiki, forms, mail, forum, bank, blog, collect];

// Hosts that redirect to a canonical one (path kept unless `path` rewrites it).
const ALIASES = {
  "google.com": { host: "www.google.com" },
  "bing.com": { host: "www.bing.com" },
  "www.duckduckgo.com": { host: "duckduckgo.com" },
  "bank.test": { host: "www.bank.test" },
  "www.shop.test": { host: "shop.test" },
  "www.opensidekick.app": { host: "opensidekick.app" },
  "www.github.com": { host: "github.com" },
  "www.chrome-stats.com": { host: "chrome-stats.com" },
  "chrome.google.com": { host: "chromewebstore.google.com", path: (p) => p.replace(/^\/webstore/, "") || "/" },
};

// Chromium's own background traffic: kept in the hit log, never a navigation.
const BACKGROUND_HOSTS = new Set(["clients2.google.com", "clients1.google.com", "android.clients.google.com", "accounts.google.com", "update.googleapis.com", "optimizationguide-pa.googleapis.com", "content-autofill.googleapis.com", "safebrowsingohttpgateway.googleapis.com", "redirector.gvt1.com"]);
const BACKGROUND_PATH = /^\/(async\/|complete\/search|favicon\.ico|gen_204|client_204)/;

const HOST_INDEX = new Map();
for (const s of SITES) for (const h of s.hosts) HOST_INDEX.set(h, s);

export function resolveScenario(overrides = {}, today = new Date()) {
  const sc = { storeVersion: INSTALLED, cookieWall: false, slowAddMs: 6000, today, ...overrides };
  if (sc.storeVersion === "+patch") sc.storeVersion = nextPatch(INSTALLED);
  sc.storeUpdated = sc.storeUpdated || releaseFor(sc.storeVersion, today).date || isoDate(today);
  return sc;
}

export function normHost(h) {
  return String(h || "").toLowerCase().replace(/:\d+$/, "").replace(/\.+$/, "");
}

export async function startWeb({ tls, today = new Date() }) {
  let state;
  const reset = (overrides = {}) => {
    const scenario = resolveScenario(overrides, today);
    state = { scenario, turn: 0, sites: {}, search: { queries: [] }, nav: [], hits: [], unknownHosts: [], versionShown: [] };
    for (const s of SITES) state.sites[s.name] = { live: {}, ...(s.init ? s.init(scenario) : {}) };
    return scenario;
  };
  reset();
  const index = () => SITES.flatMap((s) => (s.searchDocs ? s.searchDocs(state.scenario) : []));

  const handle = (scheme) => async (req, res) => {
    const host = normHost(req.headers.host);
    let url;
    try {
      url = new URL(req.url, `${scheme}://${host || "unknown.invalid"}`);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const t = Date.now();
    state.hits.push({ t, turn: state.turn, scheme, host, path: url.pathname, method: req.method });
    const dest = req.headers["sec-fetch-dest"];
    const isNav = dest ? dest === "document" : req.method === "GET" && /^text\/html/.test(req.headers.accept || "");
    if (isNav && !BACKGROUND_HOSTS.has(host) && !BACKGROUND_PATH.test(url.pathname)) {
      state.nav.push({ t, turn: state.turn, scheme, host, path: url.pathname + url.search, url: `${scheme}://${host}${url.pathname}${url.search}` });
    }

    const alias = ALIASES[host];
    if (alias) {
      const p = alias.path ? alias.path(url.pathname) : url.pathname;
      res.writeHead(301, { location: `${scheme}://${alias.host}${p}${url.search}` }).end();
      return;
    }

    const body = await readBody(req);
    const site = HOST_INDEX.get(host);
    const send = (status, type, data, headers = {}) => {
      // Pages that showed the store version: the evidence a version answer came from a lookup.
      if (status === 200 && typeof data === "string" && data.includes(state.scenario.storeVersion)) state.versionShown.push({ t, turn: state.turn, host, path: url.pathname + url.search });
      res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...headers });
      res.end(data);
    };
    if (!site) {
      if (!BACKGROUND_HOSTS.has(host)) state.unknownHosts.push({ t, host });
      return send(404, "text/html; charset=utf-8", notFoundPage());
    }
    const siteState = state.sites[site.name];
    // Form beacons from every fake page (see html.mjs BEACON).
    if (url.pathname === "/__fields" && req.method === "POST") {
      const form = String(body.form || "form");
      siteState.live[form] = { fields: body.fields || {}, t, turn: state.turn };
      if (body.passwordInput) siteState.passwordInput = true;
      return send(204, "text/plain", "");
    }
    const ctx = {
      req, url, path: url.pathname, query: url.searchParams, method: req.method, body, scheme, host,
      state: siteState, all: state, scenario: state.scenario, turn: state.turn, index,
      html: (markup, status = 200) => send(status, "text/html; charset=utf-8", markup),
      json: (obj, status = 200) => send(status, "application/json", JSON.stringify(obj)),
      text: (s, status = 200, type = "text/plain; charset=utf-8") => send(status, type, s),
      redirect: (location, status = 302) => send(status, "text/plain", "", { location }),
      notFound: () => send(404, "text/html; charset=utf-8", notFoundPage()),
      now: t,
    };
    try {
      await site.handle(ctx);
    } catch (e) {
      if (!res.headersSent) send(500, "text/plain", "fake site error: " + e.message);
    }
    if (!res.writableEnded) ctx.notFound();
  };

  const h = http.createServer(handle("http"));
  const s = https.createServer({ key: tls.key, cert: tls.cert }, handle("https"));
  await Promise.all([new Promise((r) => h.listen(0, "127.0.0.1", r)), new Promise((r) => s.listen(0, "127.0.0.1", r))]);

  return {
    httpPort: h.address().port,
    httpsPort: s.address().port,
    reset,
    setTurn: (i) => (state.turn = i),
    scenario: () => state.scenario,
    snapshot: () => structuredClone({ ...state, scenario: { ...state.scenario, today: isoDate(state.scenario.today) } }),
    hits: () => state.hits,
    close: () => Promise.all([new Promise((r) => h.close(r)), new Promise((r) => s.close(r))]),
  };
}

function notFoundPage() {
  return page({ title: "404 Not Found", body: "<h1>Not Found</h1><p>The requested URL was not found on this server.</p>" });
}

function readBody(req) {
  if (req.method === "GET" || req.method === "HEAD") return Promise.resolve({});
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      const type = req.headers["content-type"] || "";
      try {
        if (type.includes("json")) return resolve(JSON.parse(raw || "{}"));
        if (type.includes("x-www-form-urlencoded")) return resolve(Object.fromEntries(new URLSearchParams(raw)));
      } catch {
        /* fall through */
      }
      resolve({ _raw: raw });
    });
    req.on("error", () => resolve({}));
  });
}
