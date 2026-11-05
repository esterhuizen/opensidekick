// The maintainer's own reported failures. Add one by copying the shape below:
// only id, start, turns and check are required; the rest defaults to
// kind "help", category "reported", needsBrowsing true and fake "skip" (the
// dry run then only checks that the checker runs).
//
//   {
//     id: "rep-2026-11-05-example",
//     start: "https://news.test/2026/11/bridge-vote",   // URL | "newtab" | "chrome://..."
//     turns: ["the user's words, exactly as typed"],
//     check: (r) => (/expected fact/i.test(r.answer) ? { score: 1, why: "..." } : { score: 0, why: "..." }),
//   },
//
// The 2026-11-05 version report is ver-store-compare / ver-extensions-2turn.

export default [];
