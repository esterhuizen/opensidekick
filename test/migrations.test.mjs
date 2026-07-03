import { applyMigrations } from "../src/background/migrations.js";

let fail = 0;
const ok = (c, m) => { console.log((c ? "ok  : " : "FAIL: ") + m); if (!c) fail = 1; };

// Pre-existing config with vision explicitly off → flipped on + marked.
let r = applyMigrations({ settings: { enableVision: false, autonomy: "ask" } });
ok(r.changed === true, "flips a pre-existing vision-off config");
ok(r.config.settings.enableVision === true, "enableVision becomes true");
ok(r.config.settings.autonomy === "ask", "leaves other settings untouched");
ok(r.config.migrations.visionDefault === true, "sets the migration marker");

// Config that already had vision on → only the marker is added.
r = applyMigrations({ settings: { enableVision: true } });
ok(r.config.settings.enableVision === true, "leaves vision-on config on");
ok(r.config.migrations.visionDefault === true, "marks it migrated");

// Already migrated → no changes, and a later user opt-out is respected.
r = applyMigrations({ settings: { enableVision: false }, migrations: { visionDefault: true } });
ok(r.changed === false, "does not re-run once migrated");
ok(r.config.settings.enableVision === false, "respects a user's later vision-off choice");

// Fresh / empty inputs are safe.
ok(applyMigrations(null).changed === false, "null config is safe");
ok(applyMigrations({}).config.migrations.visionDefault === true, "empty config gets marked (no settings to flip)");

console.log(fail ? "\nSOME MIGRATION TESTS FAILED" : "\nALL MIGRATION TESTS PASSED");
process.exit(fail);
