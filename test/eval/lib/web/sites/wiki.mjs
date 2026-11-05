// wiki.test ("Varnipedia"): a page whose content is one table.

import { esc, page } from "../html.mjs";

export const FERRY_ROUTES = [
  ["Harbour – Skerry Point", "07:15", "40 min", "€6.50"],
  ["Harbour – Gullholm", "07:40", "25 min", "€4.20"],
  ["Harbour – Ostersand", "08:05", "55 min", "€8.90"],
  ["Skerry Point – Lindoy", "09:30", "15 min", "€3.10"],
  ["Gullholm – Ravnskar", "10:10", "35 min", "€5.75"],
  ["Harbour – Ravnskar", "11:00", "1 h 05 min", "€9.40"],
  ["Ostersand – Lindoy", "13:20", "45 min", "€7.30"],
  ["Harbour – Mossvik", "16:45", "30 min", "€4.95"],
];

export default {
  name: "wiki",
  hosts: ["wiki.test"],
  searchDocs: () => [{ url: "https://wiki.test/wiki/Varnholt_ferry_routes", title: "Varnholt ferry routes - Varnipedia", snippet: "Timetable and fares of the eight Varnholt harbour ferry routes.", keywords: ["varnholt", "ferry", "routes", "fares", "timetable"] }],
  handle(ctx) {
    if (ctx.path !== "/wiki/Varnholt_ferry_routes") return ctx.notFound();
    const rows = FERRY_ROUTES.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("");
    ctx.html(page({
      title: "Varnholt ferry routes - Varnipedia",
      skin: "wiki",
      header: `<a href="https://wiki.test/">Varnipedia</a>`,
      body: `<h1>Varnholt ferry routes</h1><p>The Varnholt harbour ferry runs eight routes between the town and the outer islands. Fares are for a single adult ticket.</p>
<table><thead><tr><th>Route</th><th>First departure</th><th>Duration</th><th>Fare</th></tr></thead><tbody>${rows}</tbody></table>
<p class="muted">The service is due to end when the Harbour Bridge opens.</p>`,
    }));
  },
};
